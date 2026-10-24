import {
	ASSET_TYPES,
	type AssetType,
	type CropBox,
	PREVIEW_LONG_EDGE,
	TRAIT,
	cropOf,
	decodeMask,
	encodeMask,
	fullPreviewEdge,
	normalizeCrop,
	rotateBox,
} from "@nana/shared";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { cleanFolderName } from "./folders";
import { guardStub } from "./guard";
import { createJob } from "./jobs";
import { applyMaskToFaces } from "./people";
import { deleteAssetsPermanently } from "./purge";
import { searchSource, updateSearchDescription } from "./search";
import { ITEM_COLUMNS, type TimelineItem, toItem } from "./timeline";
import { UPLOAD_ABANDONED_MS } from "./uploads";
import { ulid } from "./ulid";

/**
 * 资料库：文件夹、相册、收藏、归档、回收站，以及批量操作。
 * 列表接口都返回 { items: TimelineItem[], next: number | null }，按拍摄时间倒序，偏移量分页。
 */

type Bindings = { Bindings: Env };
export const library = new Hono<Bindings>();

const PAGE = 500;
const ID = z.string().regex(/^[0-9A-Z]{26}$/);
const IDS = z.array(ID).min(1).max(1000);
const TZ = z.number().int().min(-14 * 60).max(14 * 60);
/** 拍摄地的本地时间 + 时区偏移 */
const TakenAt = z.object({ local: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/), tzOffsetMin: TZ });
const LatLon = z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) });
/** 拍摄时间的合理范围 */
const MIN_TAKEN_AT = Date.UTC(1900, 0, 1);
const maxTakenAt = () => Date.now() + 2 * 24 * 3600_000;
export const VISIBLE = "a.deleted_at IS NULL AND a.status = 'ready'";
/** 文件夹封面是九宫格：最近拍的最多 9 张 */
const FOLDER_COVERS = 9;

export const offsetOf = (v: string | undefined) => {
	const n = Number(v ?? 0);
	return Number.isInteger(n) && n >= 0 ? n : 0;
};

/**
 * 分页读取列表。withMonths：列表按拍摄时间倒序时，第一页（而且不止一页）顺带返回整个列表的每月张数，
 * 前端的拖动条据此知道总长度和月份位置。只有一页时前端从条目里自己算，不多查。
 */
export async function page(
	env: Env,
	sql: string,
	binds: unknown[],
	offset: number,
	{ withMonths = false, details = false, monthsAsc = false } = {},
) {
	type Row = Parameters<typeof toItem>[0] & Partial<DetailRow>;
	const list = env.DB.prepare(`${sql} LIMIT ? OFFSET ?`).bind(...binds, PAGE + 1, offset);
	// 第一页的每月张数和这一页放在同一个 batch 里（少一次往返）；只有一页时用不上，丢掉（最多多读 500 行）。
	const [pageRes, monthsRes] =
		withMonths && offset === 0
			? await env.DB.batch<Row | { month: string; count: number }>([
					list,
					env.DB.prepare(
						`SELECT COALESCE(substr(local_day, 1, 7), 'unknown') AS month, COUNT(*) AS count FROM (${sql})
						 GROUP BY 1 ORDER BY month = 'unknown', month ${monthsAsc ? "ASC" : "DESC"}`,
					).bind(...binds),
				])
			: [await list.all<Row>(), null];
	const results = pageRes!.results as Row[];
	const rows = results.slice(0, PAGE);
	const items: TimelineItem[] = rows.map(toItem);
	const next = results.length > PAGE ? offset + PAGE : null;
	const extra = details ? { details: rows.map(toDetail) } : {};
	if (!monthsRes || next === null) return { items, next, ...extra };
	return { items, next, months: monthsRes.results as { month: string; count: number }[], ...extra };
}

/**
 * 列表视图（文件夹的 ?view=list）每行多显示的信息，和 items 一一对应：
 * [原始文件名, 原件（original + raw + live_video）总字节数, 拍摄时间（UTC 毫秒）, 时区偏移, 上传时间]。
 * 都是 assets 自己的列（file_name / file_size 由迁移 0014 的触发器维护），不多读任何一行。
 */
export type ItemDetail = [string | null, number, number | null, number | null, number];
interface DetailRow {
	file_name: string | null;
	file_size: number;
	taken_at: number | null;
	tz_offset_min: number | null;
	created_at: number;
}
export const DETAIL_COLUMNS = "a.file_name, a.file_size, a.taken_at, a.tz_offset_min, a.created_at";
export const toDetail = (r: Partial<DetailRow>): ItemDetail => [r.file_name ?? null, r.file_size ?? 0, r.taken_at ?? null, r.tz_offset_min ?? null, r.created_at ?? 0];

/** 类型筛选的 SQL 条件（文件夹 / 相册的 ?type=，搜索的 type 参数）。没有筛选时为空。 */
export const TypeParam = z.enum(ASSET_TYPES).optional().catch(undefined);
export function typeCondition(type: AssetType | undefined): { sql: string; binds: unknown[] } | null {
	if (!type) return null;
	if (type === "photo" || type === "video" || type === "live") return { sql: "a.kind = ?", binds: [type] };
	if (type === "burst") return { sql: "a.burst_id IS NOT NULL", binds: [] };
	const bit = { panorama: TRAIT.panorama, "long-exposure": TRAIT.longExposure, portrait: TRAIT.portrait, raw: TRAIT.raw }[type];
	return { sql: "a.traits & ? != 0", binds: [bit] };
}
export const andType = (t: ReturnType<typeof typeCondition>) => (t ? ` AND ${t.sql}` : "");

/**
 * 归档的照片默认不出现在文件夹和相册里，地址带 ?archived=1（页面上勾选“显示归档照片”）时才列出。
 * 文件夹 / 相册卡片的张数、体积和封面也不算归档的。
 */
const NOT_ARCHIVED = "a.archived = 0";
const andArchived = (c: Context<Bindings>) => (c.req.query("archived") === "1" ? "" : ` AND ${NOT_ARCHIVED}`);

const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(",");

// ---------------------------------------------------------------- 文件夹

interface FolderRow {
	id: string;
	parent_id: string | null;
	name: string;
}

/** 从根到 id 的路径（包括它自己）。一条递归查询；移动时禁止形成环，深度上限只是保险。 */
async function breadcrumb(env: Env, id: string | null): Promise<FolderRow[]> {
	if (!id) return [];
	const { results } = await env.DB.prepare(
		`WITH RECURSIVE up(id, parent_id, name, depth) AS (
			SELECT id, parent_id, name, 0 FROM folders WHERE id = ?
			UNION ALL
			SELECT f.id, f.parent_id, f.name, up.depth + 1 FROM folders f JOIN up ON f.id = up.parent_id WHERE up.depth < 39
		) SELECT id, parent_id, name FROM up ORDER BY depth DESC`,
	)
		.bind(id)
		.all<FolderRow>();
	return results;
}

/**
 * GET /api/folders/:id  （id = "root" 表示根目录）→ 面包屑 + 子文件夹（张数、体积、最近修改时间和封面包括所有子文件夹里的，封面最多 9 张）。
 * 只取决于 folders 和可见的条目，带 ETag（src/dbcache.ts）：打开根目录要按整棵树统计全部照片，没变时只读一行版本号。
 * 还没处理完的条目和时间有关（“上传中断”），而且会在上传、处理中不断变化，单独由 /folders/:id/unfinished 返回。
 */
library.get("/folders/:id", async (c) => {
	const id = c.req.param("id") === "root" ? null : c.req.param("id");
	// 面包屑和子文件夹同时查（不再先单独查一次文件夹是否存在）；文件夹不存在时面包屑是空的。
	// 张数和封面都按整棵子树算（包括所有子文件夹里的）。
	// tree(root, id)：root 是当前目录下的子文件夹，id 是它自己和它的所有后代；用 UNION 去重，即使数据里有环也会停下。
	const childrenStmt = c.env.DB.prepare(
		`WITH RECURSIVE tree(root, id) AS (
			SELECT id, id FROM folders WHERE COALESCE(parent_id, '') = ?
			UNION
			SELECT t.root, f.id FROM folders f JOIN tree t ON f.parent_id = t.id
		),
		totals AS (
			SELECT t.root, COUNT(*) AS count, SUM(a.file_size) AS size, MAX(a.updated_at) AS modified
			-- CROSS JOIN 固定从子树出发，INDEXED BY 固定按 assets_folder_visible 读每个文件夹的照片：规划器自己选时会顺着
			-- assets_timeline（deleted_at = NULL）每个文件夹扫一遍整个资料库（314 个文件夹 × 15 万张 = 4800 万行、26 秒）
			FROM tree t CROSS JOIN assets a INDEXED BY assets_folder_visible ON a.folder_id = t.id AND ${VISIBLE} AND ${NOT_ARCHIVED} GROUP BY t.root
		),
		-- 封面：每个文件夹先按 assets_folder_visible 索引取最近的 ${FOLDER_COVERS} 张，再在整棵子树里合并取前 ${FOLDER_COVERS}。
		-- 不能写成 SELECT 列表里对 tree 的相关子查询：那样每个子文件夹都会重算一遍递归 CTE 并排序整棵子树，
		-- 400 个文件夹、3 万张照片时要 25 秒。
		cand AS (
			SELECT t.root, j.value AS v FROM tree t, json_each((
				SELECT json_group_array(json_array(a.taken_at, a.id || ':' || a.derived_rev)) FROM (
					SELECT a.taken_at, a.id, a.derived_rev FROM assets a INDEXED BY assets_folder_visible WHERE a.folder_id = t.id AND ${VISIBLE} AND ${NOT_ARCHIVED}
					ORDER BY a.taken_at DESC LIMIT ${FOLDER_COVERS}) a)) j
		),
		ranked AS (
			SELECT root, v ->> 1 AS c, ROW_NUMBER() OVER (PARTITION BY root ORDER BY v ->> 0 DESC, v ->> 1 DESC) AS n FROM cand
		),
		covers AS (
			SELECT root, json_group_array(c) AS covers
			FROM (SELECT root, c FROM ranked WHERE n <= ${FOLDER_COVERS} ORDER BY root, n) GROUP BY root
		)
		SELECT f.id, f.name,
			COALESCE(x.count, 0) AS count,
			COALESCE(x.size, 0) AS size,
			-- 最近修改：整棵子树里可见条目最近一次变化（加入、编辑、处理），没有照片时是文件夹的创建时间
			MAX(COALESCE(x.modified, 0), f.created_at) AS modified,
			(SELECT COUNT(*) FROM folders s WHERE s.parent_id = f.id) AS subfolders,
			COALESCE(cv.covers, '[]') AS covers
		 FROM folders f LEFT JOIN totals x ON x.root = f.id LEFT JOIN covers cv ON cv.root = f.id
		 WHERE COALESCE(f.parent_id, '') = ? ORDER BY f.name COLLATE NOCASE`,
	)
		.bind(id ?? "", id ?? "");
	const [path, children] = await Promise.all([
		breadcrumb(c.env, id),
		childrenStmt.all<Record<string, unknown> & { covers: string }>().then((r) => r.results),
	]);
	if (id && !path.length) return c.json({ error: "not found" }, 404);
	return c.json({
		path,
		children: children.map((f) => ({ ...f, covers: JSON.parse(f.covers) as string[] })),
	});
});

/**
 * GET /api/folders/:id/unfinished → 本文件夹里还没处理完的条目（列表只显示 ready 的，但删除文件夹时它们也算，所以要告诉用户），
 * 以及每个子文件夹（整棵子树）里未完成的条目数。不带 ETag（“上传中断”取决于当前时间）。
 * 只读未完成的行（assets_unfinished 索引）再沿 folders 往上找，不扫已经处理好的照片：平时几乎是 0 行，
 * 大批上传期间等于还没处理完的条目数。
 */
library.get("/folders/:id/unfinished", async (c) => {
	const id = c.req.param("id") === "root" ? null : c.req.param("id");
	if (id && !(await c.env.DB.prepare("SELECT 1 FROM folders WHERE id = ?").bind(id).first())) {
		return c.json({ error: "not found" }, 404);
	}
	// up(id, n)：每个文件夹自己的未完成数，再逐级加到所有上级（深度上限防止数据里有环时停不下来）
	const { results: counts } = await c.env.DB.prepare(
		`WITH RECURSIVE up(id, n, depth) AS (
			SELECT folder_id, COUNT(*), 0 FROM assets
			WHERE deleted_at IS NULL AND status != 'ready' AND folder_id IS NOT NULL GROUP BY folder_id
			UNION ALL
			SELECT f.parent_id, up.n, up.depth + 1 FROM up JOIN folders f ON f.id = up.id
			WHERE f.parent_id IS NOT NULL AND up.depth < 40
		)
		SELECT f.id, SUM(up.n) AS n FROM up JOIN folders f ON f.id = up.id
		WHERE COALESCE(f.parent_id, '') = ? GROUP BY f.id`,
	)
		.bind(id ?? "")
		.all<{ id: string; n: number }>();
	// uploading（最近还在传）/ pending / processing → 处理中；failed → 失败；uploading 很久没动 → 上传中断
	// names：条目里的所有原始文件名（已经传完的和还在传的），方便找到原文件重新上传
	const { results: unfinished } = await c.env.DB.prepare(
		`SELECT id, CASE
			WHEN status = 'failed' THEN 'failed'
			WHEN status = 'uploading' AND (updated_at < ? OR NOT EXISTS (SELECT 1 FROM uploads u WHERE u.asset_id = assets.id))
				THEN 'abandoned'
			ELSE 'processing' END AS state,
			(SELECT json_group_array(name) FROM (
				SELECT original_name AS name FROM asset_files WHERE asset_id = assets.id
					AND role IN ('original','raw','live_video') AND original_name IS NOT NULL
				UNION SELECT original_name FROM uploads WHERE asset_id = assets.id AND original_name IS NOT NULL
				ORDER BY name)) AS names
		 FROM assets WHERE ${id ? "folder_id = ?" : "folder_id IS NULL"} AND deleted_at IS NULL AND status != 'ready'
		 ORDER BY id LIMIT 1000`,
	)
		.bind(Date.now() - UPLOAD_ABANDONED_MS, ...(id ? [id] : []))
		.all<{ id: string; state: "failed" | "abandoned" | "processing"; names: string }>();
	return c.json({
		items: unfinished.map((u) => ({ ...u, names: JSON.parse(u.names) as string[] })),
		children: Object.fromEntries(counts.map((r) => [r.id, r.n])),
	});
});

/**
 * 文件夹的排序（?sort=&order=）：拍摄时间（默认，倒序）、文件名、上传时间、尺寸（原件大小）、格式（扩展名）。
 * 只有默认的“拍摄时间倒序”和 assets_folder_visible 的顺序一致；其余都按这个索引读出整个文件夹再临时排序
 * （每页读一遍本文件夹的行，量和文件夹大小相同，不加索引：每多一个索引每次写 assets 都要多维护一份）。
 * 最后都按 id 排，偏移量分页的顺序是确定的。
 */
const FolderSort = z.enum(["taken", "name", "uploaded", "size", "format"]).catch("taken");
type FolderSort = z.infer<typeof FolderSort>;
/** 扩展名：去掉最后一个点之前的部分（rtrim 去掉末尾所有不是点的字符，得到“到最后一个点为止”的前缀）；没有点时为空 */
const EXT = "CASE WHEN instr(a.file_name, '.') THEN substr(a.file_name, length(rtrim(a.file_name, replace(a.file_name, '.', ''))) + 1) ELSE '' END";
function folderOrder(sort: FolderSort, asc: boolean) {
	const d = asc ? "ASC" : "DESC";
	switch (sort) {
		case "taken":
			// 没有拍摄时间的始终在最后（倒序时本来就在最后，和索引的顺序一致）
			return asc ? "a.taken_at ASC NULLS LAST, a.id ASC" : "a.taken_at DESC, a.id DESC";
		case "name":
			return `a.file_name IS NULL, a.file_name COLLATE NOCASE ${d}, a.id ${d}`;
		case "uploaded":
			return `a.created_at ${d}, a.id ${d}`;
		case "size":
			return `a.file_size ${d}, a.id ${d}`;
		case "format":
			// 同一格式里按拍摄时间倒序
			return `${EXT} COLLATE NOCASE ${d}, a.taken_at DESC, a.id DESC`;
	}
}

/**
 * 文件夹里的照片（只看本文件夹）。personId：只要有这个人物的脸的（文件夹页的人物筛选，
 * GET /folders/:id/people/:personId/assets；路径单独一条，ETag 同时带上 people 版本，见 src/dbcache.ts）。
 */
async function folderAssets(c: Context<Bindings>, personId: string | null) {
	const id = c.req.param("id") === "root" ? null : c.req.param("id");
	const type = typeCondition(TypeParam.parse(c.req.query("type")));
	const details = c.req.query("view") === "list";
	const sort = FolderSort.parse(c.req.query("sort") ?? "taken");
	const asc = c.req.query("order") === "asc";
	return c.json(
		await page(
			c.env,
			// 按人物筛选时从这个人物的脸出发（CROSS JOIN 固定连接顺序），只读这个人物的照片；否则写明走 assets_folder_visible
			// （没有统计信息时 SQLite 会选 assets_timeline，根目录的 folder_id IS NULL 尤其如此，读完整个资料库）。
			`SELECT ${ITEM_COLUMNS}${details ? `, ${DETAIL_COLUMNS}` : ""}
			 FROM ${personId ? "(SELECT DISTINCT asset_id FROM faces WHERE person_id = ?) p CROSS JOIN assets a ON a.id = p.asset_id" : "assets a INDEXED BY assets_folder_visible"}
			 WHERE ${id ? "a.folder_id = ?" : "a.folder_id IS NULL"} AND ${VISIBLE}${andArchived(c)}${andType(type)}
			 ORDER BY ${folderOrder(sort, asc)}`,
			[...(personId ? [personId] : []), ...(id ? [id] : []), ...(type?.binds ?? [])],
			offsetOf(c.req.query("offset")),
			// 每月张数（拖动条的年份 / 月份）只在按拍摄时间排序时有意义
			{ withMonths: sort === "taken", details, monthsAsc: asc },
		),
	);
}

library.get("/folders/:id/assets", (c) => folderAssets(c, null));
library.get("/folders/:id/people/:personId/assets", (c) => folderAssets(c, ID.parse(c.req.param("personId"))));

const FolderBody = z.object({ name: z.string().min(1).max(255), parentId: ID.nullable().optional() });

library.post("/folders", async (c) => {
	const body = FolderBody.parse(await c.req.json());
	const name = cleanFolderName(body.name);
	if (!name) return c.json({ error: "bad name" }, 400);
	const parentId = body.parentId ?? null;
	if (parentId && !(await c.env.DB.prepare("SELECT 1 FROM folders WHERE id = ?").bind(parentId).first())) {
		return c.json({ error: "parent not found" }, 404);
	}
	const id = ulid();
	const res = await c.env.DB.prepare("INSERT OR IGNORE INTO folders (id, parent_id, name, created_at) VALUES (?, ?, ?, ?)")
		.bind(id, parentId, name, Date.now())
		.run();
	if (!res.meta.changes) return c.json({ error: "a folder with this name already exists" }, 409);
	return c.json({ id, name, parentId }, 201);
});

library.patch("/folders/:id", async (c) => {
	const id = ID.parse(c.req.param("id"));
	const body = z.object({ name: z.string().min(1).max(255).optional(), parentId: ID.nullable().optional() }).parse(await c.req.json());
	const folder = await c.env.DB.prepare("SELECT id, parent_id, name FROM folders WHERE id = ?").bind(id).first<FolderRow>();
	if (!folder) return c.json({ error: "not found" }, 404);

	const name = body.name !== undefined ? cleanFolderName(body.name) : folder.name;
	if (!name) return c.json({ error: "bad name" }, 400);
	const parentId = body.parentId !== undefined ? body.parentId : folder.parent_id;
	if (parentId) {
		// 不能移到自己或自己的子文件夹里
		const chain = await breadcrumb(c.env, parentId);
		if (!chain.length) return c.json({ error: "parent not found" }, 404);
		if (chain.some((f) => f.id === id)) return c.json({ error: "cannot move a folder into itself" }, 400);
	}
	try {
		await c.env.DB.prepare("UPDATE folders SET name = ?, parent_id = ? WHERE id = ?").bind(name, parentId, id).run();
	} catch (e) {
		if (String(e).includes("UNIQUE")) return c.json({ error: "a folder with this name already exists" }, 409);
		throw e;
	}
	return c.json({ id, name, parentId });
});

/** 只能删除空文件夹（没有子文件夹，也没有未删除的照片）。回收站里的照片会变成“不在任何文件夹”。 */
library.delete("/folders/:id", async (c) => {
	const id = ID.parse(c.req.param("id"));
	const busy = await c.env.DB.prepare(
		`SELECT (SELECT COUNT(*) FROM folders WHERE parent_id = ?) + (SELECT COUNT(*) FROM assets WHERE folder_id = ? AND deleted_at IS NULL) AS n`,
	)
		.bind(id, id)
		.first<{ n: number }>();
	if (busy!.n > 0) return c.json({ error: "folder is not empty" }, 409);
	await c.env.DB.prepare("DELETE FROM folders WHERE id = ?").bind(id).run();
	return c.json({ ok: true });
});

// ---------------------------------------------------------------- 连拍

/** GET /api/bursts/:id/assets：这张照片所在的连拍组，按拍摄时间正序。不是连拍时只有它自己。 */
library.get("/bursts/:id/assets", async (c) => {
	const id = ID.parse(c.req.param("id"));
	return c.json(
		await page(
			c.env,
			// 先找出这一组的 id 再按主键读（CROSS JOIN 固定连接顺序）：写成 a.id = ? OR a.burst_id = ... 时，
			// 没有统计信息的 SQLite 会顺着 assets_timeline 扫完整个资料库
			`SELECT ${ITEM_COLUMNS}
			 FROM (SELECT ? AS id UNION SELECT id FROM assets WHERE burst_id = (SELECT burst_id FROM assets WHERE id = ?)) g
			 CROSS JOIN assets a ON a.id = g.id
			 WHERE ${VISIBLE}
			 ORDER BY a.taken_at, a.id`,
			[id, id],
			offsetOf(c.req.query("offset")),
		),
	);
});

// ---------------------------------------------------------------- 相册

/** 相册卡片除了封面还拼几张小图 */
const ALBUM_SAMPLES = 9;

/**
 * GET /api/albums → 每个相册的张数（照片 / 视频分开）、封面，以及 ${ALBUM_SAMPLES}+1 张“随机”小图。
 * 随机按 ULID 后 16 位（随机部分）排序：结果是确定的，ETag / 304 照常生效，相册内容变了才会换一批。
 * 多取一张，前端去掉和封面重复的那张。
 */
library.get("/albums", async (c) => {
	const { results } = await c.env.DB.prepare(
		`WITH stats AS (
			SELECT x.album_id, COUNT(*) AS count, SUM(a.kind = 'video') AS videos
			-- CROSS JOIN 从相册里的照片出发按主键读；否则规划器会扫完整个资料库再逐张查它在哪些相册里
			FROM album_assets x CROSS JOIN assets a ON a.id = x.asset_id WHERE ${VISIBLE} AND ${NOT_ARCHIVED} GROUP BY x.album_id
		)
		SELECT al.id, al.name, al.updated_at,
			COALESCE(s.count, 0) AS count,
			COALESCE(s.videos, 0) AS videos,
			COALESCE(
				(SELECT a.id || ':' || a.derived_rev FROM assets a WHERE a.id = al.cover_asset_id AND ${VISIBLE} AND ${NOT_ARCHIVED}),
				(SELECT a.id || ':' || a.derived_rev FROM album_assets x JOIN assets a ON a.id = x.asset_id
				 WHERE x.album_id = al.id AND ${VISIBLE} AND ${NOT_ARCHIVED} ORDER BY x.added_at DESC LIMIT 1)
			) AS cover,
			(SELECT json_group_array(c) FROM (
				SELECT a.id || ':' || a.derived_rev AS c FROM album_assets x JOIN assets a ON a.id = x.asset_id
				WHERE x.album_id = al.id AND ${VISIBLE} AND ${NOT_ARCHIVED} ORDER BY substr(a.id, 11) LIMIT ${ALBUM_SAMPLES + 1})) AS samples
		 FROM albums al LEFT JOIN stats s ON s.album_id = al.id ORDER BY al.updated_at DESC`,
	).all<Record<string, unknown> & { count: number; videos: number; samples: string }>();
	return c.json(
		results.map((a) => ({ ...a, photos: a.count - a.videos, samples: JSON.parse(a.samples) as string[] })),
	);
});

library.get("/albums/:id", async (c) => {
	const album = await c.env.DB.prepare("SELECT id, name, cover_asset_id, created_at, updated_at FROM albums WHERE id = ?")
		.bind(c.req.param("id"))
		.first();
	return album ? c.json(album) : c.json({ error: "not found" }, 404);
});

library.get("/albums/:id/assets", async (c) => {
	const type = typeCondition(TypeParam.parse(c.req.query("type")));
	return c.json(
		await page(
			c.env,
			`SELECT ${ITEM_COLUMNS} FROM album_assets x JOIN assets a ON a.id = x.asset_id
			 WHERE x.album_id = ? AND ${VISIBLE}${andArchived(c)}${andType(type)} ORDER BY a.taken_at DESC, a.id DESC`,
			[c.req.param("id"), ...(type?.binds ?? [])],
			offsetOf(c.req.query("offset")),
			{ withMonths: true },
		),
	);
});

const AlbumName = z.string().trim().min(1).max(200);

library.post("/albums", async (c) => {
	const { name, assetIds } = z.object({ name: AlbumName, assetIds: IDS.optional() }).parse(await c.req.json());
	const id = ulid();
	const now = Date.now();
	await c.env.DB.prepare("INSERT INTO albums (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)").bind(id, name, now, now).run();
	if (assetIds) await addToAlbum(c.env, id, assetIds);
	return c.json({ id, name }, 201);
});

library.patch("/albums/:id", async (c) => {
	const body = z.object({ name: AlbumName.optional(), coverAssetId: ID.nullable().optional() }).parse(await c.req.json());
	const id = c.req.param("id");
	const album = await c.env.DB.prepare("SELECT name, cover_asset_id FROM albums WHERE id = ?").bind(id).first<{
		name: string;
		cover_asset_id: string | null;
	}>();
	if (!album) return c.json({ error: "not found" }, 404);
	await c.env.DB.prepare("UPDATE albums SET name = ?, cover_asset_id = ?, updated_at = ? WHERE id = ?")
		.bind(body.name ?? album.name, body.coverAssetId !== undefined ? body.coverAssetId : album.cover_asset_id, Date.now(), id)
		.run();
	return c.json({ ok: true });
});

/** 删除相册不会删除里面的照片。 */
library.delete("/albums/:id", async (c) => {
	await c.env.DB.prepare("DELETE FROM albums WHERE id = ?").bind(c.req.param("id")).run();
	return c.json({ ok: true });
});

async function addToAlbum(env: Env, albumId: string, ids: string[]) {
	const now = Date.now();
	let added = 0;
	for (let i = 0; i < ids.length; i += 90) {
		const chunk = ids.slice(i, i + 90);
		const res = await env.DB.prepare(
			`INSERT OR IGNORE INTO album_assets (album_id, asset_id, added_at)
			 SELECT ?, id, ? FROM assets WHERE id IN (${placeholders(chunk.length)}) RETURNING asset_id`,
		)
			.bind(albumId, now, ...chunk)
			.all();
		// 计数用 RETURNING：D1 的 meta.changes 会把触发器（data_version）写的行也算进去
		added += res.results.length;
	}
	await env.DB.prepare("UPDATE albums SET updated_at = ? WHERE id = ?").bind(now, albumId).run();
	return added;
}

library.post("/albums/:id/assets", async (c) => {
	const { assetIds } = z.object({ assetIds: IDS }).parse(await c.req.json());
	const id = c.req.param("id");
	if (!(await c.env.DB.prepare("SELECT 1 FROM albums WHERE id = ?").bind(id).first())) return c.json({ error: "not found" }, 404);
	return c.json({ added: await addToAlbum(c.env, id, assetIds) });
});

library.post("/albums/:id/remove", async (c) => {
	const { assetIds } = z.object({ assetIds: IDS }).parse(await c.req.json());
	const id = c.req.param("id");
	let removed = 0;
	for (let i = 0; i < assetIds.length; i += 90) {
		const chunk = assetIds.slice(i, i + 90);
		const res = await c.env.DB.prepare(
			`DELETE FROM album_assets WHERE album_id = ? AND asset_id IN (${placeholders(chunk.length)}) RETURNING asset_id`,
		)
			.bind(id, ...chunk)
			.all();
		removed += res.results.length;
	}
	return c.json({ removed });
});

// ---------------------------------------------------------------- 收藏 / 归档 / 回收站

library.get("/favorites/assets", async (c) =>
	c.json(
		await page(
			c.env,
			`SELECT ${ITEM_COLUMNS} FROM assets a WHERE a.favorite = 1 AND ${VISIBLE} ORDER BY a.taken_at DESC, a.id DESC`,
			[],
			offsetOf(c.req.query("offset")),
			{ withMonths: true },
		),
	),
);

library.get("/archive/assets", async (c) => {
	const type = typeCondition(TypeParam.parse(c.req.query("type")));
	return c.json(
		await page(
			c.env,
			`SELECT ${ITEM_COLUMNS} FROM assets a WHERE a.archived = 1 AND ${VISIBLE}${andType(type)} ORDER BY a.taken_at DESC, a.id DESC`,
			type?.binds ?? [],
			offsetOf(c.req.query("offset")),
			{ withMonths: true },
		),
	);
});

library.get("/trash/assets", async (c) =>
	c.json(
		await page(
			c.env,
			`SELECT ${ITEM_COLUMNS} FROM assets a WHERE a.deleted_at IS NOT NULL ORDER BY a.deleted_at DESC, a.id DESC`,
			[],
			offsetOf(c.req.query("offset")),
		),
	),
);

/** 清空回收站：每次最多 1000 个，前端循环调用直到 remaining 为 0。 */
library.post("/trash/empty", async (c) => {
	const { results } = await c.env.DB.prepare("SELECT id FROM assets WHERE deleted_at IS NOT NULL LIMIT 1000").all<{ id: string }>();
	const deleted = await deleteAssetsPermanently(c.env, results.map((r) => r.id));
	const rest = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM assets WHERE deleted_at IS NOT NULL").first<{ n: number }>();
	return c.json({ deleted, remaining: rest!.n });
});

// ---------------------------------------------------------------- 批量操作

const BatchBody = z.discriminatedUnion("action", [
	z.object({ action: z.literal("favorite"), ids: IDS, value: z.boolean() }),
	z.object({ action: z.literal("archive"), ids: IDS, value: z.boolean() }),
	z.object({ action: z.literal("trash"), ids: IDS }),
	z.object({ action: z.literal("restore"), ids: IDS }),
	z.object({ action: z.literal("delete-forever"), ids: IDS }),
	z.object({ action: z.literal("move"), ids: IDS, folderId: ID.nullable() }),
	// 批量改元数据：和 PATCH /assets/:id 一样会写 meta_locked，重新处理时不会被覆盖
	z.object({ action: z.literal("set-time"), ids: IDS, takenAt: TakenAt }),
	z.object({
		action: z.literal("shift-time"),
		ids: IDS,
		/** 整体平移的分钟数（相机时钟不准时用），最多 ±100 年 */
		deltaMin: z.number().int().min(-100 * 366 * 1440).max(100 * 366 * 1440),
		/** 时区未知的照片按这个时区算本地日期（并记下来） */
		fallbackTzOffsetMin: TZ,
	}),
	z.object({ action: z.literal("set-location"), ids: IDS, location: LatLon.nullable() }),
]);

library.post("/assets/batch", async (c) => {
	const body = BatchBody.parse(await c.req.json());
	const env = c.env;
	const now = Date.now();

	if (body.action === "delete-forever") {
		// 只允许永久删除已经在回收站里的条目，防止误操作
		const ids: string[] = [];
		for (let i = 0; i < body.ids.length; i += 90) {
			const chunk = body.ids.slice(i, i + 90);
			const { results } = await env.DB.prepare(
				`SELECT id FROM assets WHERE deleted_at IS NOT NULL AND id IN (${placeholders(chunk.length)})`,
			)
				.bind(...chunk)
				.all<{ id: string }>();
			ids.push(...results.map((r) => r.id));
		}
		return c.json({ changed: await deleteAssetsPermanently(env, ids) });
	}

	if (body.action === "move" && body.folderId) {
		if (!(await env.DB.prepare("SELECT 1 FROM folders WHERE id = ?").bind(body.folderId).first())) {
			return c.json({ error: "folder not found" }, 404);
		}
	}

	// [SET 子句, SET 的参数, 额外的 WHERE 条件, WHERE 的参数]
	// 收藏 / 归档 / 回收站 / 恢复 / 移动跳过已经是目标值的行：不然每行都白写一次（还带上触发器的写入）。changed 只算真正改了的。
	let update: [string, unknown[], string, unknown[]];
	switch (body.action) {
		case "favorite":
			update = ["favorite = ?", [body.value ? 1 : 0], "AND favorite != ?", [body.value ? 1 : 0]];
			break;
		case "archive":
			update = ["archived = ?", [body.value ? 1 : 0], "AND archived != ?", [body.value ? 1 : 0]];
			break;
		case "trash":
			update = ["deleted_at = ?", [now], "AND deleted_at IS NULL", []];
			break;
		case "restore":
			update = ["deleted_at = NULL", [], "AND deleted_at IS NOT NULL", []];
			break;
		case "move":
			update = ["folder_id = ?", [body.folderId], "AND folder_id IS NOT ?", [body.folderId]];
			break;
		case "set-time": {
			const r = resolveTakenAt(body.takenAt);
			if ("error" in r) return c.json({ error: r.error }, 400);
			update = [
				`taken_at = ?, tz_offset_min = ?, local_day = ?, local_month = ?, meta_locked = meta_locked | ${LOCK_TIME}`,
				[r.takenAt, body.takenAt.tzOffsetMin, r.day, r.day.slice(0, 7)],
				"",
				[],
			];
			break;
		}
		case "shift-time": {
			// 本地日期按“平移后的时间 + 拍摄地时区”重新算；时区未知的用 fallback 并记下来。
			// 没有拍摄时间的、平移后超出合理范围的不改（UPDATE 的右边读到的都是旧值）。
			const delta = body.deltaMin * 60_000;
			const wall = "(taken_at + ?) / 1000.0 + COALESCE(tz_offset_min, ?) * 60";
			const tz = body.fallbackTzOffsetMin;
			update = [
				`taken_at = taken_at + ?, tz_offset_min = COALESCE(tz_offset_min, ?),
				 local_day = strftime('%Y-%m-%d', ${wall}, 'unixepoch'),
				 local_month = strftime('%Y-%m', ${wall}, 'unixepoch'),
				 meta_locked = meta_locked | ${LOCK_TIME}`,
				[delta, tz, delta, tz, delta, tz],
				"AND taken_at IS NOT NULL AND taken_at + ? BETWEEN ? AND ?",
				[delta, MIN_TAKEN_AT, maxTakenAt()],
			];
			break;
		}
		case "set-location":
			update = [
				`lat = ?, lon = ?, meta_locked = meta_locked | ${LOCK_LOCATION}`,
				[body.location?.lat ?? null, body.location?.lon ?? null],
				"",
				[],
			];
			break;
	}
	const [set, extra, where, whereBinds] = update;

	// D1 每条语句最多 100 个参数：80 个 id + 最多 10 个其他参数
	let changed = 0;
	for (let i = 0; i < body.ids.length; i += 80) {
		const chunk = body.ids.slice(i, i + 80);
		const res = await env.DB.prepare(
			`UPDATE assets SET ${set}, updated_at = ? WHERE id IN (${placeholders(chunk.length)}) ${where} RETURNING id`,
		)
			.bind(...extra, now, ...chunk, ...whereBinds)
			.all();
		// 计数用 RETURNING：D1 的 meta.changes 会把触发器（data_version）写的行也算进去
		changed += res.results.length;
	}
	return c.json({ changed });
});

// ---------------------------------------------------------------- 编辑元数据

export const LOCK_TIME = 1;
export const LOCK_LOCATION = 2;
export const LOCK_DESCRIPTION = 4;

const EditBody = z
	.object({
		takenAt: TakenAt.optional(),
		location: LatLon.nullable().optional(),
		description: z.string().max(2000).nullable().optional(),
		rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).optional(),
		/** 裁切框（相对于旋转之后的整张图，见 shared 的 CropBox），null 去掉裁切。和 rotation 一起提交时按新的角度理解。 */
		crop: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).nullable().optional(),
		/** 打码的笔画（shared 的 encodeMask，相对于旋转之前的整张图），null 去掉打码。 */
		mask: z.string().max(16_000).nullable().optional(),
	})
	.strict();

const pad2 = (n: number) => String(n).padStart(2, "0");

/** 本地时间 + 时区 → UTC 毫秒和本地日期。日期不存在或超出范围时返回错误信息。 */
function resolveTakenAt(t: z.infer<typeof TakenAt>): { takenAt: number; day: string } | { error: string } {
	const [date, time] = t.local.split("T") as [string, string];
	const [y, mo, d] = date.split("-").map(Number) as [number, number, number];
	const [h, mi, sec = 0] = time.split(":").map(Number) as [number, number, number?];
	const wall = Date.UTC(y, mo - 1, d, h, mi, sec);
	const check = new Date(wall);
	// 拒绝 2 月 30 日这类不存在的日期
	if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return { error: "invalid date" };
	const takenAt = wall - t.tzOffsetMin * 60_000;
	if (takenAt < MIN_TAKEN_AT || takenAt > maxTakenAt()) return { error: "date out of range" };
	return { takenAt, day: `${check.getUTCFullYear()}-${pad2(check.getUTCMonth() + 1)}-${pad2(check.getUTCDate())}` };
}

library.patch("/assets/:id", async (c) => {
	const id = ID.parse(c.req.param("id"));
	const body = EditBody.parse(await c.req.json());
	const env = c.env;
	const asset = await env.DB.prepare(
		"SELECT id, kind, rotation, width, height, crop_x, crop_y, crop_w, crop_h, mask FROM assets WHERE id = ?",
	)
		.bind(id)
		.first<{
			id: string;
			kind: string;
			rotation: number;
			width: number | null;
			height: number | null;
			crop_x: number | null;
			crop_y: number | null;
			crop_w: number | null;
			crop_h: number | null;
			mask: string | null;
		}>();
	if (!asset) return c.json({ error: "not found" }, 404);

	const sets: string[] = [];
	const binds: unknown[] = [];
	let lock = 0;

	if (body.takenAt) {
		const r = resolveTakenAt(body.takenAt);
		if ("error" in r) return c.json({ error: r.error }, 400);
		const { takenAt, day } = r;
		sets.push("taken_at = ?", "tz_offset_min = ?", "local_day = ?", "local_month = ?");
		binds.push(takenAt, body.takenAt.tzOffsetMin, day, day.slice(0, 7));
		lock |= LOCK_TIME;
	}

	if (body.location !== undefined) {
		sets.push("lat = ?", "lon = ?");
		binds.push(body.location?.lat ?? null, body.location?.lon ?? null);
		lock |= LOCK_LOCATION;
	}

	const description = body.description === undefined ? undefined : body.description?.trim() || null;
	if (description !== undefined) {
		sets.push("description = ?");
		binds.push(description);
		lock |= LOCK_DESCRIPTION;
	}

	// 旋转、裁切和打码都只重新生成缩略图和预览（rotate 任务），版本号 +1
	let rotate = false;
	const oldCrop = cropOf(asset);
	const rotation = body.rotation ?? asset.rotation;
	// 只改角度时裁切框跟着转，框住的还是同一块
	const crop: CropBox | null =
		body.crop !== undefined ? normalizeCrop(body.crop) : oldCrop && rotateBox(oldCrop, rotation - asset.rotation);
	const cropChanged = JSON.stringify(crop) !== JSON.stringify(oldCrop);
	// 打码按解码再编码后的形式比较和保存（量化一致）
	let mask = asset.mask;
	if (body.mask !== undefined) {
		const strokes = body.mask === null ? [] : decodeMask(body.mask);
		if (!strokes) return c.json({ error: "invalid mask" }, 400);
		mask = encodeMask(strokes);
	}
	const maskChanged = mask !== asset.mask;
	if (rotation !== asset.rotation || cropChanged || maskChanged) {
		if (asset.kind === "video") return c.json({ error: "videos cannot be edited" }, 400);
		sets.push("derived_rev = derived_rev + 1");
		if (rotation !== asset.rotation) {
			sets.push("rotation = ?");
			binds.push(rotation);
			if ((rotation - asset.rotation + 360) % 180 !== 0) {
				sets.push("width = ?", "height = ?");
				binds.push(asset.height, asset.width);
			}
		}
		if (cropChanged) {
			sets.push("crop_x = ?", "crop_y = ?", "crop_w = ?", "crop_h = ?");
			binds.push(crop?.x ?? null, crop?.y ?? null, crop?.w ?? null, crop?.h ?? null);
		}
		if (maskChanged) {
			sets.push("mask = ?");
			binds.push(mask);
		}
		rotate = true;
	}

	if (!sets.length) return c.json({ ok: true });
	sets.push("meta_locked = meta_locked | ?", "updated_at = ?");
	binds.push(lock, Date.now());

	const stmts = [env.DB.prepare(`UPDATE assets SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, id)];
	if (description !== undefined) {
		stmts.push(updateSearchDescription(env, id, description ?? ""));
	}
	await env.DB.batch(stmts);
	// 打码盖住的脸马上移出人物（不等新图生成）
	if (maskChanged) await applyMaskToFaces(env, id);

	// 已经有排队中的旋转任务时不再新建：它运行时会读取最新的角度
	if (rotate) {
		const pending = await env.DB.prepare("SELECT 1 FROM jobs WHERE asset_id = ? AND kind = 'rotate' AND status = 'pending'")
			.bind(id)
			.first();
		if (!pending) await createJob(env, id, "rotate");
	}
	return c.json({ ok: true, rotating: rotate });
});

/**
 * POST /api/assets/:id/full-preview：查看器的“加载原图”（浏览器解不了原件，或者原件太大的照片）。
 * 按原图分辨率重新生成预览并替换原来的（rotate 任务，1 次 derive）。返回：
 *  - { state: "done" }：预览已经是原图分辨率（或上限），不用再做；
 *  - { state: "queued" }：已排队（或者已有任务在做），前端轮询条目直到 preview_edge ≥ edge。
 * 已经有排队 / 运行中的任务且目标尺寸够了就不再新建；熔断时拒绝。只由用户操作触发。
 */
library.post("/assets/:id/full-preview", async (c) => {
	const id = ID.parse(c.req.param("id"));
	const env = c.env;
	const asset = await env.DB.prepare(
		"SELECT kind, status, width, height, preview_edge, preview_target, deleted_at FROM assets WHERE id = ?",
	)
		.bind(id)
		.first<{
			kind: string;
			status: string;
			width: number | null;
			height: number | null;
			preview_edge: number | null;
			preview_target: number | null;
			deleted_at: number | null;
		}>();
	if (!asset || asset.deleted_at) return c.json({ error: "not found" }, 404);
	if (asset.kind === "video") return c.json({ error: "videos have no full preview" }, 400);
	if (asset.status !== "ready") return c.json({ error: "not ready" }, 409);
	const edge = fullPreviewEdge(asset.width, asset.height);
	if (!edge) return c.json({ error: "size unknown" }, 409);
	if ((asset.preview_edge ?? PREVIEW_LONG_EDGE) >= edge) return c.json({ state: "done", edge });

	const active = await env.DB.prepare(
		"SELECT 1 FROM jobs WHERE asset_id = ? AND kind = 'rotate' AND status IN ('pending','running')",
	)
		.bind(id)
		.first();
	if (active && (asset.preview_target ?? 0) >= edge) return c.json({ state: "queued", edge });
	if (await guardStub(env).isTripped()) return c.json({ error: "guard tripped" }, 503);

	// 版本号 +1：新预览写到新的 key，浏览器里按旧版本号永久缓存的预览不会冒充新图
	await env.DB.prepare(
		"UPDATE assets SET preview_target = ?, derived_rev = derived_rev + 1, updated_at = ? WHERE id = ?",
	)
		.bind(edge, Date.now(), id)
		.run();
	// 排队中的任务运行时会读到新的尺寸；正在运行的那个会发现版本号变了、丢掉结果
	const pending = await env.DB.prepare("SELECT 1 FROM jobs WHERE asset_id = ? AND kind = 'rotate' AND status = 'pending'")
		.bind(id)
		.first();
	if (!pending) await createJob(env, id, "rotate");
	return c.json({ state: "queued", edge });
});

// ---------------------------------------------------------------- 搜索

const SearchQuery = z.object({
	q: z.string().trim().max(200).optional(),
	from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
	to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
	kind: z.enum(["photo", "video", "live"]).optional(),
	favorite: z.literal("1").optional(),
	camera: z.string().trim().max(200).optional(),
	type: z.enum(ASSET_TYPES).optional(),
	offset: z.string().optional(),
});


/**
 * GET /api/search：文件名 + 描述全文搜索，可按日期、类型、收藏、相机、照片类型（连拍、全景、长曝光、人像、RAW）筛选。
 * trigram 分词：查询词 ≥3 个字符时走 FTS 索引；1–2 个字符（比如中文的“猫”）退回 LIKE。
 */
library.get("/search", async (c) => {
	const p = SearchQuery.parse(c.req.query());
	const where = [VISIBLE];
	const binds: unknown[] = [];
	// 有查询词时从全文索引的结果出发、按主键读（CROSS JOIN 固定连接顺序）；写成 a.id IN (...) 时规划器会扫完整个资料库再逐张比对
	let from = "assets a";
	if (p.q) {
		const source = searchSource(p.q);
		from = `${source.sql} CROSS JOIN assets a ON a.id = s.asset_id`;
		binds.push(...source.binds);
	}
	if (p.from) {
		where.push("a.local_day >= ?");
		binds.push(p.from);
	}
	if (p.to) {
		where.push("a.local_day <= ?");
		binds.push(p.to);
	}
	if (p.kind) {
		where.push("a.kind = ?");
		binds.push(p.kind);
	}
	if (p.favorite) where.push("a.favorite = 1");
	if (p.camera) {
		where.push("a.camera = ?");
		binds.push(p.camera);
	}
	const type = typeCondition(p.type);
	if (type) {
		where.push(type.sql);
		binds.push(...type.binds);
	}
	if (where.length === 1 && !p.q) return c.json({ items: [], next: null });
	return c.json(
		await page(
			c.env,
			`SELECT ${ITEM_COLUMNS} FROM ${from} WHERE ${where.join(" AND ")} ORDER BY a.taken_at DESC, a.id DESC`,
			binds,
			offsetOf(p.offset),
			{ withMonths: true },
		),
	);
});

library.get("/search/cameras", async (c) => {
	const { results } = await c.env.DB.prepare(
		`SELECT camera, COUNT(*) AS count FROM assets a WHERE camera IS NOT NULL AND ${VISIBLE} GROUP BY camera ORDER BY count DESC LIMIT 100`,
	).all();
	return c.json(results);
});
