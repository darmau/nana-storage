import { access, constants, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { availableParallelism, tmpdir } from "node:os";
import { extname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setExiftoolProcs, setSessionFactory } from "../processor/lib.mjs";
import { Api, ApiError, Auth, AuthError, normalizeSite, sleep } from "./client.mjs";
import { InferencePool, poolSize } from "./inference.mjs";
import { runJob } from "./runner.mjs";
import { Uploads } from "./upload.mjs";

/**
 * 设备端处理（nana-device）：在自己的电脑上代替 Cloudflare 容器处理照片。
 * 在 Docker 里运行（apps/device/compose.yaml），界面在 http://localhost:7878（只绑定本机）。
 *
 * 开着就一直接管（设置里可以关掉“启动时自动接管”）：
 *  - 每次认领都续租（服务端 DEVICE_LEASE_MS = 2 分钟），租约有效时服务端不启动容器，排队的任务都由这里拉取。
 *  - 有空闲的并行位就认领，最多 DEVICE_CLAIM_MAX 个；没有任务时每 pollMs（10 秒）认领一次，同时续租。
 *    一直开着每天约 8640 次请求，可以忽略。
 *  - 关掉（docker compose stop）时把手上的任务退回、交还云端；突然断电 / 断网时租约 2 分钟后失效，服务端回到容器。
 *  - 连续失败 MAX_CONSECUTIVE_FAILURES 次自动交还云端（多半是本机环境出了问题），交给容器处理。
 *  - 网络错误按 10 秒到 60 秒退避，不会重试风暴。
 */

const PORT = 7878;
const DATA_DIR = process.env.NANA_DATA_DIR ?? "/data";
const CONFIG_PATH = join(DATA_DIR, "config.json");
const PUBLIC = new URL("./public/", import.meta.url).pathname;
const MAX_CONSECUTIVE_FAILURES = 5;
const DEFAULT_POLL_MS = 10_000;
const HISTORY = 60;
/** 最近完成的任务里保留缩略图的个数（都在内存里，每张几十 KB） */
const HISTORY_THUMBS = 30;
/** 速度按最近这么久完成的任务算 */
const RATE_WINDOW_MS = 10 * 60_000;
const CLAIM_MAX = 16;

const cpus = availableParallelism();

// 推理放进 worker 线程池（主线程上的推理会让所有并发任务排队挤在一个核上），exiftool 常驻多开几个。见 inference.mjs。
const inference = poolSize(cpus);
const pool = new InferencePool(inference);
setSessionFactory(pool.open);
setExiftoolProcs(inference.workers);
const defaults = {
	site: process.env.NANA_SITE ?? "",
	name: process.env.NANA_DEVICE_NAME ?? "nana-device",
	concurrency: Math.max(1, Math.floor(cpus * 0.75)),
	autoAttach: true,
};

let config = { ...defaults };
try {
	config = { ...defaults, ...JSON.parse(await readFile(CONFIG_PATH, "utf8")) };
} catch {}

/** 界面看到的全部状态 */
const state = {
	/** 需要做什么：null 正常；login 需要登录；site 需要填站点地址；server 服务器上没有设备端接口；tripped 成本防护已触发 */
	/** lastError：{ code, ...参数 }，界面（public/i18n.js 的 errorText）翻译 */
	need: null,
	attached: false,
	leaseUntil: null,
	lastError: null,
	/** 正在处理的任务：jobId → { jobId, kind, stage, startedAt } */
	active: new Map(),
	history: [],
	/** 最近 RATE_WINDOW_MS 内完成的时间点，算速度用 */
	finishedAt: [],
	done: 0,
	failed: 0,
	since: Date.now(),
};

/** 输入全部来自本机暂存文件的任务数、省下的下载量 */
const localStats = { jobs: 0, bytes: 0 };

/** 在本地界面里上传（upload.mjs）：上传用的那份留在暂存目录，本机处理时直接用，不下载 */
const uploads = new Uploads({
	dir: join(tmpdir(), "nana-staging"),
	getApi: () => api,
	isAttached: () => state.attached && state.leaseUntil > Date.now(),
	onUploaded: () => wake(),
});
await uploads.init();
/** runner 找输入文件的地方：刚上传的暂存文件 */
const sources = {
	candidates: (name, size) => uploads.candidates(name, size),
	used: (path) => uploads.used(path),
};

let site = normalizeSite(config.site);
let auth = site ? new Auth(site) : null;
let api = site ? new Api(site, auth) : null;
if (!site) state.need = "site";

// ---- 认领循环

let loop = null;
/** 启动自检（selfCheck）通过之后才会接管 */
let healthy = false;
let wake = () => {};
let consecutiveFailures = 0;
let stopping = false;

function startLoop() {
	if (loop || !api || stopping || !healthy) return;
	loop = runLoop().finally(() => {
		loop = null;
	});
}

async function runLoop() {
	let backoff = 0;
	let pollMs = DEFAULT_POLL_MS;
	state.attached = true;
	state.need = null;
	while (state.attached && !stopping) {
		const free = Math.max(0, config.concurrency - state.active.size);
		let jobs = [];
		try {
			const r = await api.request("/device/claim", { method: "POST", json: { name: config.name, max: Math.min(free, CLAIM_MAX) } });
			state.leaseUntil = r.until;
			jobs = r.jobs;
			backoff = 0;
			state.lastError = null;
		} catch (e) {
			if (!handleError(e)) break;
			backoff = Math.min(60_000, Math.max(10_000, backoff * 2));
			await waitFor(backoff);
			continue;
		}
		for (const plan of jobs) start(plan);
		// 认领到了、还有空位：马上再认领；否则等有任务结束，或者到下一次续租
		if (jobs.length && jobs.length >= Math.min(free, CLAIM_MAX) && state.active.size < config.concurrency) continue;
		await waitFor(pollMs);
	}
	state.attached = false;
	state.leaseUntil = null;
}

function waitFor(ms) {
	return new Promise((resolve) => {
		const timer = setTimeout(done, ms);
		function done() {
			clearTimeout(timer);
			wake = () => {};
			resolve();
		}
		wake = done;
	});
}

/** 返回 false 表示循环要停（需要用户处理）。 */
function handleError(e) {
	if (e instanceof AuthError) {
		state.need = "login";
		state.attached = false;
		return false;
	}
	// 服务器上还没有 /api/device（这次的改动还没部署）
	if (e instanceof ApiError && e.status === 404) {
		state.need = "server";
		state.attached = false;
		return false;
	}
	if (e instanceof ApiError && e.status === 409 && e.code === "guard tripped") {
		state.need = "tripped";
		state.attached = false;
		return false;
	}
	state.lastError = { code: "error", detail: String(e?.message ?? e).slice(0, 300) };
	return true;
}

function start(plan) {
	const entry = {
		jobId: plan.jobId,
		kind: plan.kind,
		name: plan.info?.name ?? null,
		assetKind: plan.info?.assetKind ?? null,
		stage: "queued",
		step: null,
		bytes: 0,
		total: 0,
		thumb: null,
		startedAt: Date.now(),
		token: plan.token,
		source: null,
	};
	state.active.set(plan.jobId, entry);
	runJob(api, plan, entry, sources)
		.then((status) => finish(entry, status === "done" ? "done" : status === "lost" ? "lost" : "retry", null))
		.catch((e) => finish(entry, "failed", e));
}

function finish(entry, status, error) {
	state.active.delete(entry.jobId);
	if (status === "done") {
		state.done++;
		consecutiveFailures = 0;
		if (entry.source === "local") {
			localStats.jobs++;
			localStats.bytes += entry.total;
		}
	} else if (status !== "lost") {
		state.failed++;
		consecutiveFailures++;
		console.warn(JSON.stringify({ event: "job_failed", jobId: entry.jobId, status, error: String(error?.message ?? error ?? "").slice(0, 300) }));
	}
	const now = Date.now();
	if (status === "done") state.finishedAt.push(now);
	state.history.unshift({
		jobId: entry.jobId,
		kind: entry.kind,
		name: entry.name,
		assetKind: entry.assetKind,
		status,
		ms: now - entry.startedAt,
		finishedAt: now,
		error: error ? String(error.message ?? error).slice(0, 300) : null,
		source: entry.source,
		thumb: entry.thumb,
	});
	state.history.length = Math.min(state.history.length, HISTORY);
	for (const h of state.history.slice(HISTORY_THUMBS)) h.thumb = null;
	if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES && state.attached) {
		state.lastError = { code: "consecutive-failures", n: consecutiveFailures };
		consecutiveFailures = 0;
		void detach();
	}
	wake();
}

async function detach() {
	state.attached = false;
	// 不再由本机处理：等处理的暂存文件删掉（云端从 R2 读）
	uploads.dropReady();
	wake();
	if (!api) return;
	await api.request("/device/detach", { method: "POST", json: {} }).catch((e) => handleError(e));
}

/** 退出：手上的任务退回 pending（不算尝试次数），交还云端。正在跑的子进程随容器一起结束。 */
async function shutdown() {
	if (stopping) return;
	stopping = true;
	state.attached = false;
	wake();
	if (api) {
		await Promise.allSettled(
			[...state.active.values()].map((j) =>
				api.request(`/device/jobs/${encodeURIComponent(j.jobId)}/release`, { method: "POST", json: { t: j.token } }),
			),
		);
		await api.request("/device/detach", { method: "POST", json: {} }).catch(() => {});
	}
	process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

async function saveConfig() {
	await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2)).catch((e) => console.warn("config not saved:", e.message));
}

// ---- 本地界面（只绑定本机：compose 把端口映射到 127.0.0.1；这里再校验 Host，防 DNS rebinding）

/** 界面浏览相册时代理的只读接口：文件夹（面包屑 + 子文件夹 + 封面）、文件夹里的照片（分页）、缩略图。 */
const FOLDER_ID = /^(root|[0-9A-Z]{26})$/;
const LIB_ROUTES = [
	(u) => {
		const m = /^\/api\/lib\/folders\/([^/]+)$/.exec(u.pathname);
		return m && FOLDER_ID.test(m[1]) && { path: `/folders/${m[1]}` };
	},
	(u) => {
		const m = /^\/api\/lib\/folders\/([^/]+)\/assets$/.exec(u.pathname);
		const offset = Number(u.searchParams.get("offset") ?? 0);
		return m && FOLDER_ID.test(m[1]) && Number.isInteger(offset) && offset >= 0 && offset < 1e7 && { path: `/folders/${m[1]}/assets?offset=${offset}` };
	},
	(u) => {
		const m = /^\/api\/lib\/thumb\/([0-9A-Z]{26})$/.exec(u.pathname);
		const v = Number(u.searchParams.get("v"));
		return m && Number.isInteger(v) && v >= 0 && { path: `/a/${m[1]}/thumb?v=${v}`, stream: true };
	},
];

/** 把服务器的图片原样流给界面（沿用服务器的 Cache-Control：带版本号的缩略图浏览器会缓存）。 */
async function proxyFile(res, upstream) {
	res.writeHead(200, {
		"content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
		"cache-control": upstream.headers.get("cache-control") ?? "private, no-cache",
		"x-content-type-options": "nosniff",
		"content-security-policy": "default-src 'none'",
	});
	await pipeline(Readable.fromWeb(upstream.body), res);
}

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function send(res, status, body, type = "application/json", cache = "no-store") {
	const data = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
	res.writeHead(status, {
		"content-type": type,
		"content-length": data.length,
		"cache-control": cache,
		"x-content-type-options": "nosniff",
		"x-frame-options": "DENY",
		"content-security-policy": "default-src 'self'; frame-ancestors 'none'",
	});
	res.end(data);
}

async function body(req, limit = 64 * 1024) {
	const chunks = [];
	let size = 0;
	for await (const c of req) {
		size += c.length;
		if (size > limit) throw new Error("body too large");
		chunks.push(c);
	}
	return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

/** 界面要的缩略图：本机刚生成的（deriveTask 的 onStep）。只在界面打开时被请求。 */
function thumbOf(jobId) {
	const entry = state.active.get(jobId);
	if (!entry) return state.history.find((h) => h.jobId === jobId)?.thumb ?? null;
	return entry.thumb ?? null;
}

const slim = ({ token: _t, thumb, ...j }) => ({ ...j, hasThumb: Boolean(thumb) });

function publicState() {
	const now = Date.now();
	while (state.finishedAt.length && state.finishedAt[0] < now - RATE_WINDOW_MS) state.finishedAt.shift();
	return {
		config,
		need: state.need,
		attached: state.attached,
		leaseUntil: state.leaseUntil,
		loginUrl: auth?.loginUrl ?? null,
		lastError: state.lastError,
		active: [...state.active.values()].map(slim),
		history: state.history.map(({ thumb, ...h }) => ({ ...h, hasThumb: Boolean(thumb) })),
		/** 最近 10 分钟每分钟完成几个 */
		perMinute: state.finishedAt.length / Math.min(RATE_WINDOW_MS / 60_000, Math.max(1, (now - state.since) / 60_000)),
		done: state.done,
		failed: state.failed,
		since: state.since,
		cpus,
		local: localStats,
		uploads: uploads.summary(),
		now: Date.now(),
	};
}

const actions = {
	async config(input) {
		const next = { ...config };
		if (input.site !== undefined) {
			const s = normalizeSite(input.site);
			if (!s) throw new Error("invalid site");
			next.site = s;
		}
		if (input.name !== undefined) next.name = String(input.name).trim().slice(0, 64) || defaults.name;
		if (input.concurrency !== undefined) next.concurrency = Math.min(64, Math.max(1, Math.floor(Number(input.concurrency)) || 1));
		if (input.autoAttach !== undefined) next.autoAttach = Boolean(input.autoAttach);
		const siteChanged = next.site !== config.site;
		config = next;
		await saveConfig();
		if (siteChanged) {
			await detach();
			site = normalizeSite(config.site);
			auth = new Auth(site);
			api = new Api(site, auth);
			state.need = null;
		}
		wake();
	},
	async login() {
		if (!auth) throw new Error("site required");
		const url = await auth.startLogin();
		state.need = null;
		// 登录完成后（cloudflared 退出）自动接管
		auth.login?.promise.then(() => {
			if (config.autoAttach) startLoop();
		});
		return { url };
	},
	async attach() {
		if (!api) throw new Error("site required");
		if (!healthy) throw new Error("self-check failed");
		const r = await api.request("/device/attach", { method: "POST", json: { name: config.name } }).catch((e) => {
			handleError(e);
			throw e;
		});
		state.leaseUntil = r.until;
		startLoop();
	},
	async detach() {
		await detach();
	},
	// ---- 上传（upload.mjs）。文件内容走 PUT /api/upload/file/:index，见下面的路由
	async "upload/start"(input) {
		if (!api) throw new Error("site required");
		return uploads.start(input);
	},
	async "upload/next"(input) {
		return uploads.next(String(input.session ?? ""));
	},
	async "upload/cancel"() {
		await uploads.cancel();
	},
	async "upload/resume"() {
		uploads.resume();
	},
	async "upload/clear"() {
		uploads.clear();
	},
};
/** 文件清单可能很大（几万个文件名和路径），其余动作的请求体都很小 */
const BODY_LIMITS = { "upload/start": 32 * 1024 ** 2 };

const server = createServer(async (req, res) => {
	const host = (req.headers.host ?? "").replace(/:\d+$/, "");
	if (!LOCAL_HOSTS.has(host)) return send(res, 403, "forbidden", "text/plain");
	const url = new URL(req.url ?? "/", "http://localhost");
	try {
		if (req.method === "GET" && url.pathname === "/api/state") return send(res, 200, publicState());
		const thumb = req.method === "GET" && /^\/api\/thumb\/([0-9A-Z]{10,40})$/.exec(url.pathname);
		if (thumb) {
			const data = await thumbOf(thumb[1]);
			// 同一个任务的缩略图不会变，让浏览器缓存，界面每 2 秒刷新时不重复请求
			return data ? send(res, 200, data, "image/webp", "private, max-age=3600") : send(res, 404, "not found", "text/plain");
		}
		// 浏览相册（界面的“相册”）：只代理这几个只读接口，id 和参数都校验过，不是通用转发
		const lib = req.method === "GET" && LIB_ROUTES.map((r) => r(url)).find(Boolean);
		if (lib) {
			if (!api) return send(res, 409, { error: "site required" });
			if (!lib.stream) return send(res, 200, await api.request(lib.path));
			return await proxyFile(res, await api.request(lib.path, { stream: true }));
		}
		const file = req.method === "PUT" && /^\/api\/upload\/file\/(\d{1,7})$/.exec(url.pathname);
		if (file) {
			// 网页推过来的文件内容（同样要带自定义头，别的网站不能跨站发）
			if (req.headers["x-nana-device"] !== "1") return send(res, 403, { error: "forbidden" });
			await uploads.receive(Number(file[1]), req);
			return send(res, 200, { ok: true });
		}
		if (req.method === "GET" && url.pathname === "/api/server") {
			// 服务器上的队列（排队 / 处理中），界面有上限地刷新
			if (!api) return send(res, 200, null);
			return send(res, 200, await api.request("/device/queue"));
		}
		if (req.method === "POST" && url.pathname.startsWith("/api/")) {
			// 写操作要带自定义头：别的网站不能跨站发这种请求
			if (req.headers["x-nana-device"] !== "1") return send(res, 403, { error: "forbidden" });
			const name = url.pathname.slice(5);
			const action = actions[name];
			if (!action || !Object.hasOwn(actions, name)) return send(res, 404, { error: "not found" });
			return send(res, 200, (await action(await body(req, BODY_LIMITS[name]))) ?? { ok: true });
		}
		if (req.method === "GET") {
			const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
			if (!/^[\w-]+\.(html|js|css|svg)$/.test(name)) return send(res, 404, "not found", "text/plain");
			return send(res, 200, await readFile(join(PUBLIC, name)), TYPES[extname(name)]);
		}
		send(res, 405, "method not allowed", "text/plain");
	} catch (e) {
		if (e instanceof AuthError) state.need = "login";
		// 流式代理中途出错：响应头已经发出去了，只能断开
		if (res.headersSent) return res.destroy();
		send(res, e?.code === "ENOENT" ? 404 : 400, { error: e instanceof ApiError ? e.code : String(e?.message ?? e) });
	}
});
server.listen(PORT, "0.0.0.0", () => {
	console.log(
		`nana-device: http://localhost:${PORT}  (${cpus} CPUs, concurrency ${config.concurrency}, inference ${inference.workers}×${inference.threads} threads)`,
	);
});

/**
 * 自检：模型和处理工具都可用才接管。否则处理结果会悄悄缺少指纹 / 人脸（lib.mjs 里算失败只记日志），
 * 不如留给云端容器。
 */
async function selfCheck() {
	const { run, FACES_ENABLED } = await import("../processor/lib.mjs");
	const files = FACES_ENABLED ? ["clip-vision.onnx", "face-det.onnx", "face-rec.onnx"] : ["clip-vision.onnx"];
	for (const f of files) await access(`/app/model/${f}`, constants.R_OK);
	for (const [cmd, args] of [["vips", ["--version"]], ["exiftool", ["-ver"]], ["ffmpeg", ["-version"]]]) await run(cmd, args, { timeoutMs: 10_000 });
	// 推理线程池能打开模型（顺便把 CLIP 预先加载进第一个 worker）
	// 选项和 lib.mjs 的 embed() 一样，预先加载的就是之后处理用的那个会话
	await pool.open("/app/model/clip-vision.onnx", { interOpNumThreads: 1, graphOptimizationLevel: "all" });
}
healthy = await selfCheck().then(
	() => true,
	(e) => {
		state.lastError = { code: "self-check", detail: String(e?.message ?? e).slice(0, 200) };
		console.error(JSON.stringify({ event: "self_check_failed", ...state.lastError }));
		return false;
	},
);

// 启动时自动接管；没登录时循环会停下来，界面提示
if (config.autoAttach && api) {
	await sleep(500);
	startLoop();
}
