import { Hono } from "hono";
import { z } from "zod";
import { MAX_LIVE_DURATION_MS } from "@nana/shared";
import { guardStub } from "./guard";
import { enqueueJob, jobInsert } from "./jobs";

/**
 * 短视频转 Live Photo（POST /api/live-photo）：把时长不超过 MAX_LIVE_DURATION_MS 的视频条目变成 Live Photo，
 * 用户选的一帧（atMs）作为封面（原件），视频原件成为动态部分（live_video）。转换在 livephoto 任务里完成（见 process.ts）。
 *
 * 成本：每个视频 1 个 livephoto 任务（1 次抽帧 + 1 次 derive），只由用户点击触发；照常经过 UsageGuard
 * （月度费用上限、同一条目的循环熔断）和 MAX_JOB_ATTEMPTS。设备端不认领这种任务（容器处理）。
 */

type Bindings = { Bindings: Env };
export const livephoto = new Hono<Bindings>();

const ID = z.string().regex(/^[0-9A-Z]{26}$/);

livephoto.post("/", async (c) => {
	const env = c.env;
	const { id, atMs } = z
		.object({ id: ID, atMs: z.number().int().min(0).max(MAX_LIVE_DURATION_MS) })
		.parse(await c.req.json());

	const row = await env.DB.prepare("SELECT kind, status, deleted_at, duration_ms FROM assets WHERE id = ?")
		.bind(id)
		.first<{ kind: string; status: string; deleted_at: number | null; duration_ms: number | null }>();
	if (!row) return c.json({ error: "not found" }, 404);
	if (row.deleted_at || row.status !== "ready" || row.kind !== "video") return c.json({ error: "not a ready video" }, 400);
	const duration = row.duration_ms ?? 0;
	if (duration <= 0 || duration > MAX_LIVE_DURATION_MS) return c.json({ error: "video too long" }, 400);
	if (atMs >= duration) return c.json({ error: "bad at-ms" }, 400);
	if (await guardStub(env).isTripped()) return c.json({ error: "guard tripped" }, 503);

	// 已经有一个正在排队 / 运行的转换：不要再建（重复消息会幂等跳过，这里直接拒绝更清楚）
	const pending = await env.DB.prepare(
		"SELECT 1 FROM jobs WHERE asset_id = ? AND kind = 'livephoto' AND status IN ('pending','running') LIMIT 1",
	)
		.bind(id)
		.first();
	if (pending) return c.json({ error: "already converting" }, 409);

	const now = Date.now();
	const { id: jobId, stmt } = jobInsert(env.DB, id, "livephoto");
	// 转换参数和任务同一个 batch 落地：不会留下没有任务的参数、或者没有参数的任务。
	// 上一次转换失败后用户重新选一帧时，覆盖旧的参数（失败的任务在“处理失败”里重试会读到新参数）。
	await env.DB.batch([
		env.DB.prepare(
			`INSERT INTO livephoto_specs (asset_id, at_ms, created_at) VALUES (?, ?, ?)
			 ON CONFLICT(asset_id) DO UPDATE SET at_ms = excluded.at_ms, created_at = excluded.created_at`,
		).bind(id, atMs, now),
		stmt,
	]);
	try {
		await enqueueJob(env, jobId);
	} catch (e) {
		// 任务留在 D1，“重新排队”可以补发
		console.warn(JSON.stringify({ event: "livephoto_enqueue_failed", jobId, error: String(e).slice(0, 300) }));
	}
	return c.json({ ok: true }, 201);
});
