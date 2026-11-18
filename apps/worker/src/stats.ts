import { Hono } from "hono";
import type { FolderStats, FolderStatsResponse, StorageSummary } from "@nana/shared";

type AppEnv = { Bindings: Env };

/**
 * GET /api/stats/summary：侧边栏底部的存储空间统计。只读 storage_totals 一行（迁移 0013 的触发器维护），
 * 不扫表，所以可以随资料库数据变化刷新（前端每 30 秒最多一次）。
 */
async function storageSummary(env: Env): Promise<StorageSummary> {
	const row = await env.DB.prepare("SELECT bytes, photos, videos FROM storage_totals WHERE id = 1").first<StorageSummary>();
	return { bytes: row?.bytes ?? 0, photos: row?.photos ?? 0, videos: row?.videos ?? 0 };
}

/**
 * GET /api/stats/folders：每个文件夹自己（不含子文件夹）的照片 / 视频数和原图体积，加上根目录没放进文件夹的照片。
 * 一整条查询顺着 assets_folder_visible（folder_id 前缀）读一遍，GROUP BY folder_id：和打开根目录文件夹页同一次扫描，
 * 不扫第二遍、不递归；只依赖 folders 和可见条目，带 ETag（library 组）。
 */
async function folderStats(env: Env): Promise<FolderStatsResponse> {
	const [foldersRes, unfiledRes] = await env.DB.batch([
		env.DB.prepare(
			`WITH counts AS (
				SELECT a.folder_id AS id,
				       SUM(a.kind != 'video') AS photos,
				       SUM(a.kind = 'video') AS videos,
				       SUM(a.file_size) AS size
				FROM assets a INDEXED BY assets_folder_visible
				WHERE a.deleted_at IS NULL AND a.status = 'ready' AND a.archived = 0
				GROUP BY a.folder_id
			)
			SELECT f.id, f.parent_id, f.name,
			       COALESCE(c.photos, 0) AS photos, COALESCE(c.videos, 0) AS videos, COALESCE(c.size, 0) AS size
			FROM folders f LEFT JOIN counts c ON c.id = f.id`,
		),
		env.DB.prepare(
			`SELECT SUM(a.kind != 'video') AS photos, SUM(a.kind = 'video') AS videos, SUM(a.file_size) AS size
			 FROM assets a INDEXED BY assets_folder_visible
			 WHERE a.folder_id IS NULL AND a.deleted_at IS NULL AND a.status = 'ready' AND a.archived = 0`,
		),
	]);
	const u = (unfiledRes!.results[0] ?? {}) as { photos?: number | null; videos?: number | null; size?: number | null };
	return {
		folders: foldersRes!.results as FolderStats[],
		unfiled: { photos: u.photos ?? 0, videos: u.videos ?? 0, size: u.size ?? 0 },
	};
}

export const stats = new Hono<AppEnv>()
	.get("/summary", async (c) => c.json(await storageSummary(c.env)))
	.get("/folders", async (c) => c.json(await folderStats(c.env)));
