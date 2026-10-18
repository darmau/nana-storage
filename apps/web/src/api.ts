import { t } from "./i18n";

/**
 * 服务端的错误码（响应里的 error，英文，日志和测试都靠它）→ 显示给用户的话（文案在 i18n 的 api.codes）。
 * 没有列出的按状态码给一句通用的说明，不把英文错误码原样弹给用户。
 */
function describe(status: number, code: string | null): string {
	const codes: Record<string, string> = t.api.codes;
	if (code && Object.hasOwn(codes, code)) return codes[code]!;
	if (code?.startsWith("part ")) return t.api.partFailed;
	if (status === 400) return t.api.badRequest;
	if (status === 401 || status === 403) return t.api.sessionExpired;
	if (status === 404) return t.api.notFound;
	if (status === 409) return t.api.conflict;
	if (status === 413) return t.api.tooLarge;
	if (status === 415) return t.api.unsupported;
	if (status === 429) return t.api.rateLimited;
	if (status >= 500) return t.api.serverError;
	return t.api.httpFailed(status);
}

/** 所有 API 请求都走这里：带 CSRF 头，失败抛 ApiError。message 是给用户看的话，code 是服务端的原始错误码。 */
export class ApiError extends Error {
	readonly code: string | null;
	constructor(
		readonly status: number,
		readonly body: unknown,
	) {
		const code = typeof body === "object" && body && "error" in body ? String((body as { error: unknown }).error) : null;
		super(describe(status, code));
		this.name = "ApiError";
		this.code = code;
	}
}

/** 把任意错误变成一句给用户看的话（ApiError 已经翻译好；网络错误等其他异常给通用说明）。 */
export function errorText(e: unknown): string {
	if (e instanceof ApiError) return e.message;
	if (e instanceof TypeError) return t.api.network;
	return e instanceof Error ? e.message : String(e);
}

/**
 * D1 会话书签（见 apps/worker/src/dbcache.ts）：响应带回书签，后面的请求带上，
 * 读副本时就不会读到比上次看到的更旧的数据（包括自己刚做的修改）。
 * 书签的格式没有公开，不能比较新旧，所以按请求顺序取舍：
 *  - 写请求带回的书签总是晚于它完成之前看到过的任何状态，直接采用（几个写请求并发时，只采用后发出的）。
 *  - 读请求只有在上一次采用之后才发出的才采用。在一次写入完成之前发出、之后才返回的读请求，
 *    不会用较旧的书签覆盖这次写入的书签。
 * 只存在这个页面的内存里；别的标签页最多落后几秒（副本的复制延迟）。
 */
let bookmark: string | null = null;
let issued = 0;
let adoptedAfter = 0;
let lastWrite = -1;

function adoptBookmark(startedAt: number, write: boolean, next: string | null) {
	if (!next) return;
	if (write ? startedAt < lastWrite : startedAt < adoptedAfter) return;
	if (write) lastWrite = startedAt;
	bookmark = next;
	adoptedAfter = issued;
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
	const { json, ...rest } = init;
	const headers = new Headers(rest.headers);
	headers.set("X-Requested-With", "nana");
	if (bookmark) headers.set("X-D1-Bookmark", bookmark);
	const startedAt = issued++;
	if (json !== undefined) headers.set("Content-Type", "application/json");
	let res: Response;
	try {
		res = await fetch(`/api${path}`, {
			...rest,
			headers,
			body: json !== undefined ? JSON.stringify(json) : rest.body,
			credentials: "same-origin",
		});
	} catch (err) {
		// 登录过期时 Access 会把请求重定向到它的登录页（跨域），fetch 直接失败
		if (!(err instanceof DOMException && err.name === "AbortError")) setConnection(navigator.onLine ? "lost" : "offline");
		throw err;
	}
	setConnection(res.status === 403 ? "lost" : "ok");
	adoptBookmark(startedAt, (rest.method ?? "GET").toUpperCase() !== "GET", res.headers.get("x-d1-bookmark"));
	const text = await res.text();
	let body: unknown = text;
	try {
		body = text ? JSON.parse(text) : null;
	} catch {}
	if (!res.ok) throw new ApiError(res.status, body);
	return body as T;
}

/**
 * 连接状态，给 ConnectionBanner 用。从主屏幕打开时没有浏览器的刷新按钮，
 * 登录过期或断网后要由页面自己提示并提供“重新加载”。
 */
export type Connection = "ok" | "offline" | "lost";
let connection: Connection = "ok";
const listeners = new Set<() => void>();

function setConnection(next: Connection) {
	if (next === connection) return;
	connection = next;
	for (const l of listeners) l();
}

export const connectionStore = {
	get: () => connection,
	subscribe(listener: () => void) {
		listeners.add(listener);
		return () => listeners.delete(listener);
	},
};

if (typeof window !== "undefined") {
	// 网络恢复后 react-query 会自动重新请求（refetchOnReconnect），这里只收起提示
	window.addEventListener("online", () => connection === "offline" && setConnection("ok"));
	window.addEventListener("offline", () => setConnection("offline"));
}
