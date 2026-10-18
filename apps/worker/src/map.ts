import { Hono } from "hono";
import { z } from "zod";
import { ITEM_COLUMNS, type ItemRow, toItem } from "./timeline";

/**
 * 地图上的照片（底图由前端直接从 OpenFreeMap 加载，不经过这里）：
 *   GET /api/map/points?w&s&e&n&cell    照片按网格聚合后的点
 *   GET /api/map/assets?w&s&e&n         某个范围里的照片（分页）
 */

type Bindings = { Bindings: Env };
export const map = new Hono<Bindings>();

const VISIBLE = "a.deleted_at IS NULL AND a.status = 'ready'";
// 两个查询都写明 INDEXED BY assets_geo：没有统计信息时 SQLite 会选 assets_timeline（省掉排序），扫完整个资料库再按经纬度过滤。

const BBox = z.object({
	w: z.coerce.number().min(-180).max(180),
	s: z.coerce.number().min(-90).max(90),
	e: z.coerce.number().min(-180).max(180),
	n: z.coerce.number().min(-90).max(90),
});

/**
 * 照片按网格聚合：格子大小由前端按视口宽度计算（约 80 像素一格），所以屏幕上的点数大致固定。
 * 每个格子返回张数、平均位置，以及最新一张作为封面（SQLite 中 MAX() 搭配的裸列取自同一行）。
 */
map.get("/points", async (c) => {
	const q = BBox.extend({ cell: z.coerce.number().min(0.0001).max(45) }).parse(c.req.query());
	const { results } = await c.env.DB.prepare(
		`SELECT CAST((a.lon + 180) / ?1 AS INTEGER) AS gx, CAST((a.lat + 90) / ?1 AS INTEGER) AS gy,
			COUNT(*) AS count, AVG(a.lat) AS lat, AVG(a.lon) AS lon,
			MAX(a.taken_at) AS latest, a.id AS id, a.derived_rev AS rev
		 FROM assets a INDEXED BY assets_geo
		 WHERE ${VISIBLE} AND a.lat BETWEEN ?2 AND ?3 AND a.lon BETWEEN ?4 AND ?5
		 GROUP BY gy, gx ORDER BY count DESC LIMIT 1000`,
	)
		.bind(q.cell, q.s, q.n, q.w, q.e)
		.all<{ gx: number; gy: number; count: number; lat: number; lon: number; id: string; rev: number }>();
	return c.json(
		results.map((r) => ({
			count: r.count,
			lat: r.lat,
			lon: r.lon,
			cover: `${r.id}:${r.rev}`,
			// 这个格子的范围，点开后用来列出里面的照片
			bbox: [r.gx * q.cell - 180, r.gy * q.cell - 90, (r.gx + 1) * q.cell - 180, (r.gy + 1) * q.cell - 90],
		})),
	);
});

const PAGE = 500;
map.get("/assets", async (c) => {
	const q = BBox.extend({ offset: z.coerce.number().int().min(0).default(0) }).parse(c.req.query());
	const { results } = await c.env.DB.prepare(
		`SELECT ${ITEM_COLUMNS}
		 FROM assets a INDEXED BY assets_geo WHERE ${VISIBLE} AND a.lat BETWEEN ? AND ? AND a.lon BETWEEN ? AND ?
		 ORDER BY a.taken_at DESC, a.id DESC LIMIT ? OFFSET ?`,
	)
		.bind(q.s, q.n, q.w, q.e, PAGE + 1, q.offset)
		.all<ItemRow>();
	return c.json({ items: results.slice(0, PAGE).map(toItem), next: results.length > PAGE ? q.offset + PAGE : null });
});
