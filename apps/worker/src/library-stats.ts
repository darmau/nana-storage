import { LARGEST_MAX, LIBRARY_STATS_CAMERAS, LIBRARY_STATS_DAYS, type LibraryStats } from "@nana/shared";
import { DETAIL_COLUMNS, VISIBLE, toDetail } from "./library";
import { ITEM_COLUMNS, toItem } from "./timeline";

/**
 * 统计数据页的资料库统计（拍摄时间分布、拍摄设备）。不需要实时：每天的 Cron（17 3 * * *，回收站清理之后）统计一次，
 * 结果存成 library_stats 的一行 JSON，页面只读这一行。全新部署还没跑过 Cron 时，第一次打开页面现算一次。
 *
 * 成本上限：每天 1 次，固定 3 条聚合查询（都是全表扫描），每次约 3 × 条目数的行读取 + 1 行写入。
 * 15 万张时约 45 万行 / 天 ≈ 1400 万行 / 月，远在 D1 的包含额度内（≈ $0）。失败只记日志，不重试、不自我触发。
 */

type Snapshot = Omit<LibraryStats, "computedAt">;

export async function computeLibraryStats(env: Env, now = Date.now()): Promise<LibraryStats> {
	const since = new Date(now - (LIBRARY_STATS_DAYS - 1) * 86400_000).toISOString().slice(0, 10);
	const [days, months, cameras] = await env.DB.batch([
		env.DB.prepare(
			`SELECT a.local_day AS k, COUNT(*) AS n FROM assets a WHERE ${VISIBLE} AND a.local_day >= ? GROUP BY a.local_day ORDER BY a.local_day`,
		).bind(since),
		// local_month 为 NULL 的一组就是没有拍摄时间的
		env.DB.prepare(`SELECT a.local_month AS k, COUNT(*) AS n FROM assets a WHERE ${VISIBLE} GROUP BY a.local_month ORDER BY a.local_month`),
		env.DB.prepare(
			`SELECT a.camera, SUM(a.kind != 'video') AS photos, SUM(a.kind = 'video') AS videos
			 FROM assets a WHERE ${VISIBLE} GROUP BY a.camera ORDER BY COUNT(*) DESC, a.camera`,
		),
	]);
	const pairs = (r: D1Result) => (r.results as { k: string | null; n: number }[]).filter((x) => x.k !== null).map((x) => [x.k!, x.n] as [string, number]);
	const cameraRows = cameras!.results as { camera: string | null; photos: number; videos: number }[];
	const unknown = cameraRows.find((r) => r.camera === null);
	const snapshot: Snapshot = {
		days: pairs(days!),
		months: pairs(months!),
		noDate: (months!.results as { k: string | null; n: number }[]).find((x) => x.k === null)?.n ?? 0,
		cameras: cameraRows
			.filter((r) => r.camera !== null)
			.slice(0, LIBRARY_STATS_CAMERAS)
			.map((r) => ({ camera: r.camera!, photos: r.photos, videos: r.videos })),
		unknownCamera: { photos: unknown?.photos ?? 0, videos: unknown?.videos ?? 0 },
	};
	await env.DB.prepare(
		`INSERT INTO library_stats (id, computed_at, data) VALUES (1, ?, ?)
		 ON CONFLICT (id) DO UPDATE SET computed_at = excluded.computed_at, data = excluded.data`,
	)
		.bind(now, JSON.stringify(snapshot))
		.run();
	return { computedAt: now, ...snapshot };
}

/** 读快照；还没有（全新部署、Cron 还没跑过）就现算一次。 */
export async function libraryStats(env: Env): Promise<LibraryStats> {
	const row = await env.DB.prepare("SELECT computed_at, data FROM library_stats WHERE id = 1").first<{ computed_at: number; data: string }>();
	if (!row) return computeLibraryStats(env);
	return { computedAt: row.computed_at, ...(JSON.parse(row.data) as Snapshot) };
}

/**
 * 最大的照片 / 视频（原件大小 assets.file_size：original + raw + live_video），各前 LARGEST_MAX 个，实时查询。
 * 走 assets_size（迁移 0020）：每种 kind 只读前 LARGEST_MAX 行。照片 = photo + live，两条各取前 N 再合并。
 * 返回和列表视图（?view=list）相同的 { items, details, next }，前端直接用 LibraryList。
 */
export async function largestAssets(env: Env, kind: "photo" | "video") {
	type Row = Parameters<typeof toItem>[0] & Parameters<typeof toDetail>[0] & { file_size: number };
	const query = (k: string) =>
		env.DB.prepare(
			`SELECT ${ITEM_COLUMNS}, ${DETAIL_COLUMNS} FROM assets a INDEXED BY assets_size
			 WHERE a.kind = ? AND ${VISIBLE} ORDER BY a.file_size DESC LIMIT ?`,
		).bind(k, LARGEST_MAX);
	const results = await env.DB.batch<Row>(kind === "video" ? [query("video")] : [query("photo"), query("live")]);
	const rows = results
		.flatMap((r) => r.results)
		.sort((a, b) => b.file_size - a.file_size)
		.slice(0, LARGEST_MAX);
	return { items: rows.map(toItem), details: rows.map(toDetail), next: null };
}
