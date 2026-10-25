import { Hono } from "hono";
import type { FileRole, StorageSummary, UsageStats } from "@nana/shared";
import { guardStub } from "./guard";
import { largestAssets, libraryStats } from "./library-stats";

/**
 * GET /api/stats：使用统计页的数据。只由用户打开页面或点“刷新”触发，前端不轮询。
 *  - D1：4 条聚合查询（条目数、各类文件的数量和字节数、按上传月份的增长、未完成的上传）。
 *    都是全表扫描，5 万张照片约 25 万行读取 ≈ $0.00025 / 次。
 *  - UsageGuard：本月和最近 30 天每天的容器时长、任务数、上传量（1 次 DO 请求）。
 * 不返回文件名、GPS、描述。
 */

type AppEnv = { Bindings: Env };

const ORIGINAL_ROLES: FileRole[] = ["original", "raw", "live_video"];
/** 和 UsageStats.growth 的说明一致。 */
const GROWTH_MONTHS = 12;
const HISTORY_DAYS = 30;

const monthStartOf = (now: number) => {
	const d = new Date(now);
	return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
};

export async function usageStats(env: Env, now = Date.now()): Promise<UsageStats> {
	const monthStart = monthStartOf(now);
	const growthStart = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth() - (GROWTH_MONTHS - 1), 1);
	const historyStart = new Date(Math.min(monthStart, now - (HISTORY_DAYS - 1) * 86400_000)).toISOString().slice(0, 10);
	const originals = ORIGINAL_ROLES.map((r) => `'${r}'`).join(",");

	const [d1, days] = await Promise.all([
		env.DB.batch([
			env.DB.prepare(
				`SELECT kind, status, deleted_at IS NOT NULL AS trashed, COUNT(*) AS n FROM assets GROUP BY kind, status, trashed`,
			),
			env.DB.prepare(
				`SELECT f.role, a.deleted_at IS NOT NULL AS trashed, COUNT(*) AS files, COALESCE(SUM(f.size), 0) AS bytes
				 FROM asset_files f JOIN assets a ON a.id = f.asset_id GROUP BY f.role, trashed`,
			),
			env.DB.prepare(
				`SELECT strftime('%Y-%m', a.created_at / 1000, 'unixepoch') AS month, COUNT(DISTINCT a.id) AS assets, COALESCE(SUM(f.size), 0) AS bytes
				 FROM assets a JOIN asset_files f ON f.asset_id = a.id AND f.role IN (${originals})
				 WHERE a.created_at >= ? AND a.deleted_at IS NULL AND a.status != 'uploading'
				 GROUP BY month ORDER BY month`,
			).bind(growthStart),
			env.DB.prepare(
				`SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes, (SELECT COUNT(*) FROM faces WHERE indexed = 1) AS vectors FROM uploads`,
			),
			env.DB.prepare("SELECT bytes, photos, videos FROM storage_totals WHERE id = 1"),
		]),
		guardStub(env).history(historyStart),
	]);

	const [assetRows, fileRows, growthRows, uploadRows, totalRows] = d1 as [D1Result, D1Result, D1Result, D1Result, D1Result];

	const library = { photo: 0, video: 0, live: 0, processing: 0, failed: 0, trash: 0 };
	for (const r of assetRows.results as { kind: "photo" | "video" | "live"; status: string; trashed: number; n: number }[]) {
		if (r.trashed) library.trash += r.n;
		else if (r.status === "ready") library[r.kind] += r.n;
		else if (r.status === "failed") library.failed += r.n;
		else if (r.status !== "uploading") library.processing += r.n;
	}

	const roles: UsageStats["storage"]["roles"] = {};
	const trash = { files: 0, bytes: 0 };
	for (const r of fileRows.results as { role: FileRole; trashed: number; files: number; bytes: number }[]) {
		if (r.trashed) {
			trash.files += r.files;
			trash.bytes += r.bytes;
		} else roles[r.role] = { files: r.files, bytes: r.bytes };
	}

	// 侧边栏的计数（storage_totals，触发器维护）和这里的全量统计是同一个快照（batch 是一个事务），对不上就校正
	const exact: StorageSummary = {
		bytes: (fileRows.results as { bytes: number }[]).reduce((n, r) => n + r.bytes, 0),
		photos: library.photo + library.live,
		videos: library.video,
	};
	const counted = totalRows.results[0] as StorageSummary | undefined;
	if (!counted || counted.bytes !== exact.bytes || counted.photos !== exact.photos || counted.videos !== exact.videos) {
		console.warn(JSON.stringify({ event: "storage_totals_drift", counted: counted ?? null, exact }));
		await recountStorage(env);
	}

	const up = uploadRows.results[0] as { files: number; bytes: number; vectors: number };
	const sizeAfter = (assetRows.meta as { size_after?: number }).size_after;

	const month = { containerSeconds: 0, jobs: 0, uploadBytes: 0 };
	const monthDay = new Date(monthStart).toISOString().slice(0, 10);
	for (const d of days) {
		if (d.day < monthDay) continue;
		month.containerSeconds += d.containerSeconds;
		month.jobs += d.jobs;
		month.uploadBytes += d.uploadBytes;
	}

	return {
		now,
		monthStart,
		library,
		storage: {
			roles,
			trash,
			uploads: { files: up.files, bytes: up.bytes },
			d1Bytes: typeof sizeAfter === "number" && sizeAfter > 0 ? sizeAfter : null,
			vectors: up.vectors,
		},
		growth: growthRows.results as UsageStats["growth"],
		days,
		month,
	};
}

/**
 * GET /api/stats/summary：侧边栏底部的存储空间统计。只读 storage_totals 一行（迁移 0013 的触发器维护），
 * 不扫表，所以可以随资料库数据变化刷新（前端每 30 秒最多一次）。
 */
async function storageSummary(env: Env): Promise<StorageSummary> {
	const row = await env.DB.prepare("SELECT bytes, photos, videos FROM storage_totals WHERE id = 1").first<StorageSummary>();
	return { bytes: row?.bytes ?? 0, photos: row?.photos ?? 0, videos: row?.videos ?? 0 };
}

/** 一条语句重新统计（原子的，期间的写入不会算错）。只在 /api/stats 发现计数对不上时运行。 */
async function recountStorage(env: Env) {
	await env.DB.prepare(
		`INSERT INTO storage_totals (id, bytes, photos, videos)
		 SELECT 1, (SELECT COALESCE(SUM(size), 0) FROM asset_files), COALESCE(SUM(kind != 'video'), 0), COALESCE(SUM(kind = 'video'), 0)
		 FROM assets WHERE status = 'ready' AND deleted_at IS NULL
		 ON CONFLICT (id) DO UPDATE SET bytes = excluded.bytes, photos = excluded.photos, videos = excluded.videos`,
	).run();
}

export const stats = new Hono<AppEnv>()
	.get("/", async (c) => c.json(await usageStats(c.env)))
	.get("/summary", async (c) => c.json(await storageSummary(c.env)))
	// 统计数据页的资料库统计（每天 Cron 写的快照，只读一行）和最大的照片 / 视频（实时，走 assets_size）
	.get("/library", async (c) => c.json(await libraryStats(c.env)))
	.get("/largest/:kind{photo|video}", async (c) => c.json(await largestAssets(c.env, c.req.param("kind") as "photo" | "video")));
