import { Hono } from "hono";

/**
 * 时间线只有两个接口：
 *   GET /api/timeline/buckets    每个月的张数（前端据此撑出完整的滚动高度）
 *   GET /api/timeline/month/:ym  某个月的全部条目（紧凑数组，按拍摄时间倒序）
 * 拍摄时间未知的条目放在 "unknown" 这个桶里，排在最后。
 * 连拍只显示一张封面（收藏的优先，否则最早的一张），封面带上整组的 id，张数也按组计算。
 */

type Bindings = { Bindings: Env };
export const timeline = new Hono<Bindings>();

export const UNKNOWN_MONTH = "unknown";
const MONTH_RE = /^\d{4}-\d{2}$/;

timeline.get("/buckets", async (c) => {
	const { results } = await c.env.DB.prepare(
		`SELECT COALESCE(local_month, '${UNKNOWN_MONTH}') AS month, COUNT(DISTINCT COALESCE(burst_id, id)) AS count
		 FROM assets WHERE deleted_at IS NULL AND status = 'ready'
		 GROUP BY local_month ORDER BY local_month IS NULL, local_month DESC`,
	).all<{ month: string; count: number }>();
	return c.json(results);
});

/**
 * 每个条目是一个数组，省流量：
 * [id, width, height, kind(0 photo/1 video/2 live), localDay, durationMs, favorite, derivedRev, burst?]
 * burst 只在时间线里、并且这一组有多张时出现：整组的 id，按拍摄时间正序（包括封面自己）。
 */
export type TimelineItem = [string, number, number, 0 | 1 | 2, string | null, number | null, 0 | 1, number, string[]?];
const KIND = { photo: 0, video: 1, live: 2 } as const;

export interface ItemRow {
	id: string;
	width: number | null;
	height: number | null;
	kind: keyof typeof KIND;
	local_day: string | null;
	duration_ms: number | null;
	favorite: number;
	derived_rev: number;
	/** 裁切框的宽高比例（没有裁切时为 null）：列表返回裁切后的尺寸，网格按它排版 */
	crop_w?: number | null;
	crop_h?: number | null;
}

/** 列表接口（toItem）要的列。查询里 assets 的别名必须是 a。 */
export const ITEM_COLUMNS = "a.id, a.width, a.height, a.kind, a.local_day, a.duration_ms, a.favorite, a.derived_rev, a.crop_w, a.crop_h";

const cropped = (n: number | null, f: number | null | undefined) => (n && f ? Math.max(1, Math.round(n * f)) : (n ?? 1));

export const toItem = (r: ItemRow): TimelineItem => [
	r.id,
	cropped(r.width, r.crop_w),
	cropped(r.height, r.crop_h),
	KIND[r.kind],
	r.local_day,
	r.duration_ms,
	r.favorite ? 1 : 0,
	r.derived_rev,
];

timeline.get("/month/:ym", async (c) => {
	const ym = c.req.param("ym");
	if (ym !== UNKNOWN_MONTH && !MONTH_RE.test(ym)) return c.json({ error: "bad month" }, 400);
	const where = ym === UNKNOWN_MONTH ? "local_month IS NULL" : "local_month = ?";
	const stmt = c.env.DB.prepare(
		`SELECT id, width, height, kind, local_day, duration_ms, favorite, derived_rev, crop_w, crop_h, burst FROM (
			SELECT id, width, height, kind, local_day, duration_ms, favorite, derived_rev, crop_w, crop_h, taken_at,
				ROW_NUMBER() OVER (PARTITION BY COALESCE(burst_id, id) ORDER BY favorite DESC, taken_at, id) AS rk,
				CASE WHEN burst_id IS NULL THEN NULL ELSE json_group_array(id) OVER (
					PARTITION BY COALESCE(burst_id, id) ORDER BY taken_at, id
					ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) END AS burst
			-- 写明索引：“未知日期”（local_month IS NULL）时规划器会顺着 assets_timeline 扫完整个资料库
			FROM assets INDEXED BY assets_month WHERE ${where} AND deleted_at IS NULL AND status = 'ready'
		 ) WHERE rk = 1
		 ORDER BY taken_at DESC, id DESC`,
	);
	const { results } = await (ym === UNKNOWN_MONTH ? stmt : stmt.bind(ym)).all<ItemRow & { burst: string | null }>();
	return c.json(
		results.map((r) => {
			const item = toItem(r);
			const burst = r.burst ? (JSON.parse(r.burst) as string[]) : null;
			if (burst && burst.length > 1) item.push(burst);
			return item;
		}),
	);
});
