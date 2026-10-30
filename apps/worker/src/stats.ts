import { Hono } from "hono";
import type { StorageSummary } from "@nana/shared";

type AppEnv = { Bindings: Env };

/**
 * GET /api/stats/summary：侧边栏底部的存储空间统计。只读 storage_totals 一行（迁移 0013 的触发器维护），
 * 不扫表，所以可以随资料库数据变化刷新（前端每 30 秒最多一次）。
 */
async function storageSummary(env: Env): Promise<StorageSummary> {
	const row = await env.DB.prepare("SELECT bytes, photos, videos FROM storage_totals WHERE id = 1").first<StorageSummary>();
	return { bytes: row?.bytes ?? 0, photos: row?.photos ?? 0, videos: row?.videos ?? 0 };
}

export const stats = new Hono<AppEnv>().get("/summary", async (c) => c.json(await storageSummary(c.env)));
