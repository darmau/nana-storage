import { type DehydratedState, dehydrate, hydrate, type Query, type QueryClient } from "@tanstack/react-query";

/**
 * 把首页（时间线）、相册、文件夹等列表的查询结果存进 IndexedDB，下次打开应用时先显示上次的数据，
 * 同时照常在后台重新请求（恢复出来的数据都已过期，挂载时重新请求；列表接口带 ETag，没变就回 304）。
 *
 * 安全：只存 JSON（id、版本号、尺寸、文件夹 / 相册名……），不存任何照片字节。
 * 这些响应本来就以 private, no-cache 存在浏览器的 HTTP 缓存里，所以不多暴露什么；
 * 应用外壳（index.html）每次都要经过 Access 鉴权，登录过期后页面打不开，也就读不到这份缓存。
 *
 * 上限：只存白名单里的查询；分页列表只存第一页、最近的 MAX_LISTS 个；时间线只存最新的 MAX_MONTHS 个月；
 * 保存在缓存变化后最多每 SAVE_THROTTLE_MS 一次（纯本地写入，没有请求）。换了部署版本或超过 MAX_AGE_MS 就丢弃。
 */

const DB_NAME = "nana-cache";
const STORE = "kv";
const KEY = "queries";
const MAX_AGE_MS = 7 * 24 * 3600_000;
const SAVE_THROTTLE_MS = 2000;
/** 读 IndexedDB 超过这个时间就不等了，直接渲染（不能让坏掉的存储挡住启动） */
const RESTORE_TIMEOUT_MS = 500;
const MAX_LISTS = 30;
const MAX_FOLDERS = 50;
const MAX_MONTHS = 6;

interface Snapshot {
	buster: string;
	savedAt: number;
	state: DehydratedState;
}

const buster = __APP_BUILD__.commit;

function openDb(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, 1);
		req.onupgradeneeded = () => req.result.createObjectStore(STORE);
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

let dbPromise: Promise<IDBDatabase> | null = null;
const db = () => (dbPromise ??= openDb());

async function idb<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest): Promise<T> {
	const store = (await db()).transaction(STORE, mode).objectStore(STORE);
	return new Promise((resolve, reject) => {
		const req = fn(store);
		req.onsuccess = () => resolve(req.result as T);
		req.onerror = () => reject(req.error);
	});
}

/** 要存的查询：key 的第一段 → 能存的条件 */
function kind(q: Query): "list" | "folder" | "month" | "other" | null {
	if (q.state.status !== "success" || q.state.data === undefined) return null;
	const [head, a, b] = q.queryKey as unknown[];
	if (head === "list") return "list";
	if (head === "folders") return q.queryKey.length === 2 ? "folder" : null; // 不存 unfinished（和时间有关）
	if (head === "timeline") return a === "buckets" ? "other" : a === "month" && typeof b === "string" ? "month" : null;
	if (head === "albums" || head === "storage-summary") return "other";
	return null;
}

function pick(qc: QueryClient): Set<string> {
	const keep = new Set<string>();
	const lists: Query[] = [];
	const folders: Query[] = [];
	const months: Query[] = [];
	for (const q of qc.getQueryCache().getAll()) {
		const k = kind(q);
		if (k === "list") lists.push(q);
		else if (k === "folder") folders.push(q);
		else if (k === "month") months.push(q);
		else if (k === "other") keep.add(q.queryHash);
	}
	const recent = (a: Query, b: Query) => b.state.dataUpdatedAt - a.state.dataUpdatedAt;
	for (const q of lists.sort(recent).slice(0, MAX_LISTS)) keep.add(q.queryHash);
	for (const q of folders.sort(recent).slice(0, MAX_FOLDERS)) keep.add(q.queryHash);
	// 打开应用时停在时间线顶部，最新的几个月最有用
	months.sort((a, b) => String(b.queryKey[2]).localeCompare(String(a.queryKey[2])));
	for (const q of months.slice(0, MAX_MONTHS)) keep.add(q.queryHash);
	return keep;
}

/** 分页列表只留第一页：恢复后挂载时只重新请求这一页，往下滚再照常加载。 */
function firstPageOnly(state: DehydratedState): DehydratedState {
	return {
		...state,
		queries: state.queries.map((q) => {
			if (q.queryKey[0] !== "list") return q;
			const data = q.state.data as { pages: unknown[]; pageParams: unknown[] } | undefined;
			if (!data || data.pages.length <= 1) return q;
			return { ...q, state: { ...q.state, data: { pages: data.pages.slice(0, 1), pageParams: data.pageParams.slice(0, 1) } } };
		}),
	};
}

async function save(qc: QueryClient) {
	const keep = pick(qc);
	const state = firstPageOnly(
		dehydrate(qc, { shouldDehydrateQuery: (q) => keep.has(q.queryHash), shouldDehydrateMutation: () => false }),
	);
	const snap: Snapshot = { buster, savedAt: Date.now(), state };
	await idb("readwrite", (s) => s.put(snap, KEY));
}

/** 启动时调用一次（渲染之前）：恢复上次的数据，然后在缓存变化时保存。任何存储错误都忽略。 */
export async function restoreQueryCache(qc: QueryClient): Promise<void> {
	if (typeof indexedDB === "undefined") return;
	try {
		const snap = await Promise.race([
			idb<Snapshot | undefined>("readonly", (s) => s.get(KEY)),
			new Promise<undefined>((r) => setTimeout(r, RESTORE_TIMEOUT_MS)),
		]);
		if (snap && snap.buster === buster && Date.now() - snap.savedAt < MAX_AGE_MS) {
			hydrate(qc, snap.state);
			// 恢复出来的一律算过期（哪怕刚存不到 staleTime），挂载时在后台重新请求
			const hashes = new Set(snap.state.queries.map((q) => q.queryHash));
			void qc.invalidateQueries({ predicate: (q) => hashes.has(q.queryHash), refetchType: "none" });
		}
	} catch {
		// 隐私模式、存储被禁用……照常从网络加载
	}
	subscribe(qc);
}

function subscribe(qc: QueryClient) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const flush = () => {
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
		save(qc).catch(() => {});
	};
	qc.getQueryCache().subscribe((e) => {
		if (e.type !== "updated" || e.action.type !== "success") return;
		if (timer === undefined) timer = setTimeout(flush, SAVE_THROTTLE_MS);
	});
	// 切到后台 / 关闭前把还没写的写掉（iOS 上独立窗口被杀掉之前只有这个机会）
	document.addEventListener("visibilitychange", () => {
		if (document.hidden && timer !== undefined) flush();
	});
}
