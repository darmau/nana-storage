import { spawn } from "node:child_process";
import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";

/**
 * 和 Worker 通信。身份是主人自己的 Access 登录：cloudflared access login 在浏览器里登录一次，
 * 之后用 cloudflared access token 取令牌，放在 cf-access-token 头里（Access 在边缘校验，Worker 的 authenticate() 不变）。
 * 本地开发（http://localhost、host.docker.internal）没有 Access，不带令牌（wrangler dev 自己模拟身份）。
 *
 * 写请求和浏览器一样带 X-Requested-With: nana 和 Origin。D1 书签只放在内存里。
 */

export class AuthError extends Error {}
export class ApiError extends Error {
	constructor(status, code) {
		super(`${status} ${code}`);
		this.status = status;
		this.code = code;
	}
}

const DEV_HOSTS = new Set(["localhost", "127.0.0.1", "host.docker.internal"]);

/** 规范化站点地址：只接受 https（本地开发的几个主机名可以用 http），返回 origin。 */
export function normalizeSite(value) {
	let url;
	try {
		url = new URL(String(value).trim());
	} catch {
		return null;
	}
	if (url.protocol === "https:" || (url.protocol === "http:" && DEV_HOSTS.has(url.hostname))) return url.origin;
	return null;
}

const isDev = (site) => new URL(site).protocol === "http:";

function cloudflared(args, { timeoutMs = 20_000, onOutput } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn("cloudflared", args, { stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		const take = (d) => {
			out += d;
			if (out.length > 20_000) out = out.slice(-20_000);
			onOutput?.(out);
		};
		child.stdout.on("data", take);
		child.stderr.on("data", take);
		const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
		child.on("error", (e) => {
			clearTimeout(timer);
			reject(e);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, out });
		});
	});
}

/** JWT 的过期时间（毫秒），解析不了返回 0。 */
function jwtExp(token) {
	try {
		const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
		return Number(payload.exp) * 1000 || 0;
	} catch {
		return 0;
	}
}

export class Auth {
	constructor(site) {
		this.site = site;
		this.token = null;
		this.login = null; // { url, promise }
	}

	/** 当前有效的令牌；没有登录或已过期返回 null。开发站点返回 ""（不需要令牌）。 */
	async getToken() {
		if (isDev(this.site)) return "";
		if (this.token && jwtExp(this.token) - 60_000 > Date.now()) return this.token;
		this.token = null;
		const { code, out } = await cloudflared(["access", "token", `-app=${this.site}`]).catch(() => ({ code: 1, out: "" }));
		const token = out.trim().split(/\s+/).find((s) => /^[\w-]+\.[\w-]+\.[\w-]+$/.test(s));
		if (code === 0 && token && jwtExp(token) > Date.now()) this.token = token;
		return this.token;
	}

	/**
	 * 开始登录：cloudflared 打印登录链接（容器里打不开浏览器），由界面显示给用户点开。
	 * 返回链接；登录完成后 cloudflared 自己保存令牌（~/.cloudflared，compose 里是一个 volume）。最多等 5 分钟。
	 */
	async startLogin() {
		if (isDev(this.site)) return null;
		if (this.login) return this.login.url;
		let resolveUrl;
		const urlReady = new Promise((r) => (resolveUrl = r));
		const promise = cloudflared(["access", "login", "--quiet", this.site], {
			timeoutMs: 5 * 60_000,
			onOutput: (out) => {
				// “Please open the following URL …”：链接在站点自己的 /cdn-cgi/access/cli 下
				const url = out.match(/https:\/\/\S+\/cdn-cgi\/access\/cli\S*/)?.[0];
				if (url) resolveUrl(url);
			},
		})
			.catch(() => null)
			.finally(() => {
				this.login = null;
				this.token = null;
				resolveUrl(null);
			});
		this.login = { url: null, promise };
		const url = await Promise.race([urlReady, new Promise((r) => setTimeout(() => r(null), 15_000))]);
		if (this.login) this.login.url = url;
		return url;
	}

	get loginUrl() {
		return this.login?.url ?? null;
	}
}

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRIES = 5;

export class Api {
	constructor(site, auth) {
		this.site = site;
		this.auth = auth;
		this.bookmark = null; // D1 会话书签：读到自己刚写的数据
	}

	/**
	 * 请求 /api{path}。body 只能是 JSON 或 Buffer（可以重试）。
	 * 429 和 5xx、网络错误按 1/2/4/8/16 秒退避重试，最多 RETRIES 次。stream: true 时返回 Response（调用方读 body）。
	 */
	async request(path, { method = "GET", json, body, headers = {}, stream = false } = {}) {
		for (let attempt = 0; ; attempt++) {
			const token = await this.auth.getToken();
			if (token === null) throw new AuthError("login required");
			const h = { ...headers };
			if (token) h["cf-access-token"] = token;
			if (this.bookmark) h["x-d1-bookmark"] = this.bookmark;
			if (method !== "GET") {
				h["x-requested-with"] = "nana";
				h.origin = this.site;
			}
			let payload = body;
			if (json !== undefined) {
				h["content-type"] = "application/json";
				payload = JSON.stringify(json);
			}
			let res;
			try {
				const url = `${this.site}/api${path}`;
				res = stream && method === "GET" ? await streamGet(url, h) : await fetch(url, { method, headers: h, body: payload, redirect: "manual" });
			} catch (e) {
				if (attempt < RETRIES) {
					await sleep(1000 * 2 ** attempt);
					continue;
				}
				throw e;
			}
			const bookmark = res.headers.get("x-d1-bookmark");
			if (bookmark) this.bookmark = bookmark;
			// Access 拦下来时是跳转到登录页（或 401 / 403）
			if (res.status >= 300 && res.status < 400) {
				await res.body?.cancel();
				throw new AuthError("login required");
			}
			if (res.status === 401 || res.status === 403) {
				await res.body?.cancel();
				this.auth.token = null;
				throw new AuthError("forbidden");
			}
			if (RETRY_STATUS.has(res.status) && attempt < RETRIES) {
				await res.body?.cancel();
				await sleep(1000 * 2 ** attempt);
				continue;
			}
			if (!res.ok) {
				const text = await res.text().catch(() => "");
				let code = text.slice(0, 200);
				try {
					code = JSON.parse(text).error ?? code;
				} catch {}
				throw new ApiError(res.status, code);
			}
			if (stream) return res;
			const type = res.headers.get("content-type") ?? "";
			return type.includes("json") ? res.json() : res.text();
		}
	}
}

/** 下载连续这么久收不到数据就放弃（交给重试 / fail），不会一直挂着。 */
const STREAM_IDLE_MS = 60_000;

/**
 * 流式下载不用 fetch：Node 自带的 undici 在读得比收得慢（body 暂停）时遇到服务器关连接，
 * 会在 socket 的 end 事件里断言失败（assert(!this.paused)），整个进程直接退出，catch 不到。
 * 这里用 node:http(s)，包成和 fetch 一样的 Response（不跟随跳转，和 redirect: "manual" 一致）。
 */
function streamGet(url, headers) {
	const lib = url.startsWith("https:") ? https : http;
	return new Promise((resolve, reject) => {
		const req = lib.get(url, { headers }, (msg) => {
			const h = new Headers();
			for (const [k, v] of Object.entries(msg.headers)) if (v !== undefined) h.set(k, Array.isArray(v) ? v.join(", ") : v);
			const empty = msg.statusCode === 204 || msg.statusCode === 304;
			if (empty) msg.resume();
			resolve(new Response(empty ? null : Readable.toWeb(msg), { status: msg.statusCode, statusText: msg.statusMessage, headers: h }));
		});
		// 连接、等响应头和读 body 期间都算：空闲超时就销毁，读 body 的一方收到错误
		req.setTimeout(STREAM_IDLE_MS, () => req.destroy(new Error("download stalled")));
		req.on("error", reject);
	});
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
