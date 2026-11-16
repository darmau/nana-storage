import { Hono } from "hono";
import { DETAIL_COLUMNS, offsetOf, toDetail, VISIBLE } from "./library";
import { ITEM_COLUMNS, toItem } from "./timeline";

/**
 * 整理 › 细节不足（GET /api/quality）：按预览 WebP 的体积从小到大列出可见的照片 / Live Photo。
 * 预览长边统一 3840（PREVIEW_LONG_EDGE），所以“预览越小”≈“每像素细节越少”：被强行放大、虚焦、过曝的照片
 * 在同一个尺寸下压出来的 WebP 明显更小。预览大小就存在 asset_files（role = 'preview'），纯 SQL、不读 R2、不跑容器。
 * 结果只取决于 assets / asset_files 的当前状态，不进 ETag 名单（和原图压缩的候选一样），每次打开都查。
 */

type Bindings = { Bindings: Env };
export const quality = new Hono<Bindings>();

const PAGE = 100;

const LIST = `SELECT ${ITEM_COLUMNS}, ${DETAIL_COLUMNS}, f.size AS preview_size, a.folder_id
	FROM asset_files f INDEXED BY asset_files_preview_small CROSS JOIN assets a ON a.id = f.asset_id
	WHERE f.role = 'preview' AND a.kind != 'video' AND ${VISIBLE}
	ORDER BY f.size ASC, f.id`;

quality.get("/", async (c) => {
	const offset = offsetOf(c.req.query("offset"));
	type Row = Parameters<typeof toItem>[0] & Parameters<typeof toDetail>[0] & { preview_size: number; folder_id: string | null };
	const { results } = await c.env.DB.prepare(`${LIST} LIMIT ? OFFSET ?`)
		.bind(PAGE + 1, offset)
		.all<Row>();
	const rows = results.slice(0, PAGE);
	// 文件夹路径：文件夹表很小，整表读一次（几百行），在内存里从叶子向上拼，不写相关子查询
	const folderRes = await c.env.DB.prepare("SELECT id, parent_id, name FROM folders").all<{ id: string; parent_id: string | null; name: string }>();
	const parent = new Map(folderRes.results.map((f) => [f.id, f]));
	const pathOf = (folderId: string | null) => {
		if (!folderId) return "";
		const names: string[] = [];
		let cur = parent.get(folderId);
		for (let depth = 0; cur && depth < 64; depth++) {
			names.unshift(cur.name);
			cur = cur.parent_id ? parent.get(cur.parent_id) : undefined;
		}
		return names.join(" / ");
	};
	return c.json({
		items: rows.map(toItem),
		next: results.length > PAGE ? offset + PAGE : null,
		details: rows.map(toDetail),
		previews: rows.map((r) => r.preview_size),
		paths: rows.map((r) => pathOf(r.folder_id)),
	});
});
