import { Hono } from "hono";
import { z } from "zod";
import { JOB_STALE_MS, MAX_MONTHLY_BUDGET_USD, MIN_MONTHLY_BUDGET_USD, PROCESSOR_POOL_SIZE, type JobMessage } from "@nana/shared";
import { authenticate } from "./auth";
import { compose } from "./compose";
import { compress } from "./compress";
import { device } from "./device";
import { conditionalGroups, dataEtag, etagMatches, noValidator, openSession } from "./dbcache";
import { downloads } from "./downloads";
import { files } from "./files";
import { guardStub } from "./guard";
import { cancelJobs, handleJobMessage, requeueAfterDevice, requeuePending, retryFailed, RETRY_FAILED_MAX } from "./jobs";
import "./process"; // 注册 process / rotate / compress 任务
import { assetJobs, failedJobs, jobsOverview } from "./progress";
import { purgeTrash } from "./purge";
import { forbidden, isSafeMutation, withSecurityHeaders } from "./security";
import { library } from "./library";
import { computeLibraryStats } from "./library-stats";
import { map } from "./map";
import { people, recognizePendingFaces } from "./people";
import { refreshStaleSmartSets, similar } from "./similar";
import { stats } from "./stats";
import { timeline } from "./timeline";
import { cleanupStaleUploads, uploads } from "./uploads";

export { Processor } from "./processor";
export { UsageGuard } from "./guard";

type AppEnv = { Bindings: Env; Variables: { email: string } };

const api = new Hono<AppEnv>().basePath("/api");

// 能走到这里的请求都已通过 authenticate()，身份只可能是 OWNER_EMAIL。
api.use(async (c, next) => {
	c.set("email", c.env.OWNER_EMAIL);
	await next();
});

// 列表接口的条件请求：数据没变就回 304，不重跑查询（见 src/dbcache.ts）
api.use(async (c, next) => {
	const groups = conditionalGroups(c.req.method, c.req.path);
	if (!groups) return next();
	const etag = await dataEtag(c.env, groups);
	if (etagMatches(c.req.header("if-none-match") ?? null, etag)) {
		return c.body(null, 304, { ETag: etag, "Cache-Control": "private, no-cache" });
	}
	await next();
	if (c.res.status === 200 && !noValidator(c.res)) c.res.headers.set("ETag", etag);
});

api.get("/me", (c) => c.json({ email: c.get("email") }));

/**
 * 前端的资料库同步（apps/web/src/library/sync.ts）：数据版本 + 是否还有排队 / 运行中的任务。
 * 这里用 data_version（迁移 0011，条目的任何变化都加一，包括上传和处理的中间状态，文件夹页的“未完成”要靠它刷新），
 * 不是列表 ETag 用的 cache_versions。
 * 只读 2 行（jobs 走 jobs_status 索引）。前端只在上传和处理期间有上限地调用，见 sync.ts。
 */
api.get("/sync", async (c) => {
	const row = await c.env.DB.prepare(
		`SELECT (SELECT v FROM data_version WHERE id = 1) AS v,
		        EXISTS (SELECT 1 FROM jobs WHERE status IN ('pending','running')) AS busy`,
	).first<{ v: number | null; busy: number }>();
	return c.json({ v: row?.v ?? 0, busy: Boolean(row?.busy) });
});

api.route("/uploads", uploads);
api.route("/a", files);
api.route("/timeline", timeline);
api.route("/downloads", downloads);
api.route("/map", map);
api.route("/stats", stats);
api.route("/device", device);
api.route("/compress", compress);
api.route("/compose", compose);
api.route("/", library);
api.route("/", similar);
api.route("/", people);

api.get("/assets/:id", async (c) => {
	const id = c.req.param("id");
	// 查看器每打开一张都要读它（Live 视频的地址、信息面板），4 条查询放在一个 batch 里，一次往返。
	// 所在文件夹的路径（从根到直接所在的文件夹），信息面板显示。移动时禁止形成环，深度上限只是保险。
	const [assetRes, filesRes, activeRes, pathRes] = await c.env.DB.batch<Record<string, unknown>>([
		c.env.DB.prepare("SELECT * FROM assets WHERE id = ?").bind(id),
		c.env.DB.prepare("SELECT role, mime, size, original_name FROM asset_files WHERE asset_id = ? ORDER BY role").bind(id),
		c.env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE asset_id = ? AND status IN ('pending','running')").bind(id),
		c.env.DB.prepare(
			`WITH RECURSIVE up(id, parent_id, name, depth) AS (
				SELECT f.id, f.parent_id, f.name, 0 FROM folders f JOIN assets a ON a.folder_id = f.id WHERE a.id = ?
				UNION ALL
				SELECT f.id, f.parent_id, f.name, up.depth + 1 FROM folders f JOIN up ON f.id = up.parent_id WHERE up.depth < 64
			) SELECT id, name FROM up ORDER BY depth DESC`,
		).bind(id),
	]);
	const asset = assetRes!.results[0];
	if (!asset) return c.json({ error: "not found" }, 404);
	return c.json({
		...asset,
		files: filesRes!.results,
		jobs_active: (activeRes!.results[0]?.n as number | undefined) ?? 0,
		folder_path: pathRes!.results,
	});
});

// ---- 成本防护
api.get("/guard", async (c) => c.json(await guardStub(c.env).status()));

api.post("/guard/resume", async (c) => {
	const guard = guardStub(c.env);
	// 已经到了月度上限时恢复也没用：下一个任务会马上再次熔断。先调高上限。
	if (await guard.overBudget()) return c.json({ error: "over budget" }, 409);
	await guard.reset();
	const requeued = await requeuePending(c.env);
	return c.json({ requeued });
});

const BudgetBody = z.object({ usd: z.number().min(MIN_MONTHLY_BUDGET_USD).max(MAX_MONTHLY_BUDGET_USD) });
api.put("/guard/budget", async (c) => {
	const { usd } = BudgetBody.parse(await c.req.json());
	await guardStub(c.env).setBudget(usd);
	return c.json(await guardStub(c.env).status());
});

const ProcessorsBody = z.object({
	processors: z.number().int().min(1).max(PROCESSOR_POOL_SIZE),
	durationHours: z.number().positive().max(24 * 7),
});
api.post("/guard/limits", async (c) => {
	const { processors, durationHours } = ProcessorsBody.parse(await c.req.json());
	await guardStub(c.env).setProcessorsOverride(processors, durationHours * 3600_000);
	return c.json(await guardStub(c.env).status());
});
/** 提前结束临时容器数（只会让容器数变少）。 */
api.delete("/guard/limits", async (c) => {
	await guardStub(c.env).clearProcessorsOverride();
	return c.json(await guardStub(c.env).status());
});

// ---- 任务
api.get("/jobs/failed", async (c) => c.json(await failedJobs(c.env)));
api.get("/jobs/active", async (c) => c.json(await jobsOverview(c.env)));
api.get("/jobs/asset/:id", async (c) => c.json(await assetJobs(c.env, z.string().max(64).parse(c.req.param("id")))));
/** 手动补发：卡住的（running 超过 JOB_STALE_MS）优先，然后是消息丢了的 pending 任务，每次最多 RESUME_BATCH 个，连点会轮到下一批。只由用户点击触发。 */
api.post("/jobs/requeue", async (c) => {
	if (await guardStub(c.env).isTripped()) return c.json({ error: "guard tripped" }, 409);
	return c.json({ requeued: await requeuePending(c.env) });
});
const RetryBody = z.object({ ids: z.array(z.string().max(64)).min(1).max(RETRY_FAILED_MAX) });
api.post("/jobs/retry", async (c) => {
	const { ids } = RetryBody.parse(await c.req.json());
	if (await guardStub(c.env).isTripped()) return c.json({ error: "guard tripped" }, 409);
	return c.json({ retried: await retryFailed(c.env, ids) });
});
/** 手动停止排队中的任务（记成 failed，可以再重试）。熔断时也允许：先停掉反复处理的条目，再恢复。 */
api.post("/jobs/cancel", async (c) => {
	const { ids } = RetryBody.parse(await c.req.json());
	return c.json({ cancelled: await cancelJobs(c.env, ids) });
});

api.onError((err, c) => {
	if (err instanceof z.ZodError) return c.json({ error: "bad request", issues: err.issues }, 400);
	console.error(JSON.stringify({ event: "api_error", path: new URL(c.req.url).pathname, error: String(err) }));
	return c.json({ error: "internal error" }, 500);
});
api.notFound((c) => c.json({ error: "not found" }, 404));

/**
 * Vite 打包出来的 /assets/*-<hash>.* 内容不会变，允许浏览器长期缓存（仍然是 private，不进 CDN）。
 * 否则每次打开应用都要为每个 JS / CSS 文件发一次重新验证请求（每次都过 Worker 和鉴权）。
 * 不存在的路径会被 SPA 回退成 index.html，所以只认真正的脚本 / 样式类型，index.html 自己仍然每次验证。
 */
const HASHED_ASSET = /^\/assets\/[\w.-]+-[\w-]{8}\.(?:js|mjs|css)$/;
function cacheHashedAsset(pathname: string, res: Response): { res: Response; hashed: boolean } {
	const type = res.headers.get("Content-Type") ?? "";
	if (res.status !== 200 || !HASHED_ASSET.test(pathname) || !/javascript|css/.test(type)) return { res, hashed: false };
	const out = new Response(res.body, res);
	out.headers.set("Cache-Control", "private, max-age=31536000, immutable");
	return { res: out, hashed: true };
}


export default {
	async fetch(request, env, ctx): Promise<Response> {
		const email = await authenticate(request, env, ctx);
		if (!email) return forbidden();

		const url = new URL(request.url);
		if (url.pathname.startsWith("/api/")) {
			if (!isSafeMutation(request, env.APP_ORIGIN)) return forbidden();
			const isFile = url.pathname.startsWith("/api/a/");
			const limiter = request.method === "GET" && isFile ? env.FILE_LIMITER : env.API_LIMITER;
			const { success } = await limiter.limit({ key: "owner" });
			if (!success) return withSecurityHeaders(new Response("Too Many Requests", { status: 429 }));
			// 这个请求里的 D1 读写都走同一个会话（可以读就近的副本，见 src/dbcache.ts）。
			// 会话只实现了 prepare / batch，API 代码里也只用这两个。
			const session = openSession(env.DB, request);
			const scoped: Env = { ...env, DB: session as unknown as D1Database };
			// 照片字节（/api/a/*）不加 Vary: Cookie：见 withSecurityHeaders
			const res = withSecurityHeaders(await api.fetch(request, scoped, ctx), { varyCookie: !isFile });
			const bookmark = session.getBookmark();
			if (bookmark) res.headers.set("X-D1-Bookmark", bookmark);
			return res;
		}

		// SPA 静态资源（已鉴权）。
		const asset = cacheHashedAsset(url.pathname, await env.ASSETS.fetch(request));
		return withSecurityHeaders(asset.res, { varyCookie: !asset.hashed });
	},

	async queue(batch, env): Promise<void> {
		const startedAt = Date.now();
		for (const msg of batch.messages) {
			const outcome = await handleJobMessage(msg.body, env, { startedAt });
			if (outcome === "retry") msg.retry({ delaySeconds: 300 });
			// 等不到容器槽位：过一会儿再来，不算任务的尝试次数（但算队列的 max_retries）。
			else if (outcome === "busy") msg.retry({ delaySeconds: 60 });
			// 任务正在运行：过 JOB_STALE_MS 再看，卡住了就重新认领（上一个消费者可能被中途杀掉了）
			else if (outcome === "recheck") msg.retry({ delaySeconds: JOB_STALE_MS / 1000 + 60 });
			else msg.ack();
		}
	},

	async scheduled(controller, env, ctx): Promise<void> {
		// 每小时：自动更新标记有变化的主题（每次最多 SMART_SET_CRON_BATCH 个）、识别推迟的人脸（每次最多 FACE_CRON_BATCH 张）、
		// 设备端消失后补发它接管期间被 ack 掉的任务（每次最多 RESUME_BATCH 个），熔断时都跳过
		if (controller.cron === "7 * * * *")
			ctx.waitUntil(
				Promise.allSettled([
					refreshStaleSmartSets(env),
					recognizePendingFaces(env),
					requeueAfterDevice(env),
				]).then((rs) => {
					for (const r of rs) if (r.status === "rejected") console.error(JSON.stringify({ event: "cron_failed", error: String(r.reason).slice(0, 300) }));
				}),
			);
		else if (controller.cron === "17 3 * * *") {
			// 每天：清理回收站、中断的上传，再重新统计资料库（统计数据页的快照，固定 3 条聚合查询，见 library-stats.ts）
			ctx.waitUntil(
				purgeTrash(env)
					.then(() => cleanupStaleUploads(env))
					.finally(() =>
						computeLibraryStats(env).catch((e) => console.error(JSON.stringify({ event: "cron_failed", error: String(e).slice(0, 300) }))),
					),
			);
		}
	},
} satisfies ExportedHandler<Env, JobMessage>;
