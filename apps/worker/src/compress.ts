import { Hono } from "hono";
import { z } from "zod";
import { COMPRESS_BATCH_MAX, COMPRESS_MIN_BYTES } from "@nana/shared";
import { guardStub } from "./guard";
import { createJobs, type RunningJob } from "./jobs";
import { page, offsetOf, VISIBLE } from "./library";
import type { GetProcessor } from "./process";
import { processorStub } from "./processor";
import { ITEM_COLUMNS } from "./timeline";

/**
 * 原图压缩（整理 › 原图压缩）：很大的 JPEG 原图按 COMPRESS_JPEG_QUALITY 重新编码，像素尺寸不变、元数据段原样保留，
 * 压缩后的文件替换原图（apps/processor/lib.mjs 的 compressTask）。
 *
 * 流程：用户在候选列表里选中照片 → POST /api/compress 给每张建一个 compress 任务 → 消费者（或设备端）运行 compressAsset：
 *  1. 容器读原图、重新编码、校验（完整解码、尺寸、关键元数据、缩小后逐像素比对），压缩后的写到一个新 key，原图不动；
 *  2. 一条 UPDATE 把原件那一行换成新文件（r2_key / size / sha256 / crc32），同时记下压缩前的 sha256 和大小；
 *     条件是这一行还是任务开始时读到的那个文件，期间被换过就丢弃结果；
 *  3. 删掉旧的 R2 对象。
 * 不值得压缩（省不到 COMPRESS_MIN_SAVING）、带附图（HDR 增益图、景深图、动态照片的视频）、不是普通 JPEG 的，
 * 原图不动，记成 compress_state = 2，以后不再列出。每张最多压缩一次（compress_state = 1 之后不再是候选）。
 *
 * 缩略图、预览、指纹、人脸都不变（像素基本一样），不重新处理。
 * 压缩前的 sha256 留在 source_sha256 上：重新上传同一个原始文件仍然算重复（uploads.ts）。
 *
 * 成本：每张 1 次容器调用（一般 3–20 秒，硬超时 COMPRESS_TIMEOUT_MS），只由用户点击触发，每次最多 COMPRESS_BATCH_MAX 张；
 * 照常经过 UsageGuard（月度费用上限、同一条目的循环熔断）和 MAX_JOB_ATTEMPTS。设备端接管时由设备处理，不花容器费用。
 */

type Bindings = { Bindings: Env };
export const compress = new Hono<Bindings>();

/** 压缩后的文件的 key：每次尝试一个新 key（设备端在认领时就拿到它，所以要能从任务本身算出来）。 */
export const compressedKey = (job: Pick<RunningJob, "id" | "asset_id" | "attempts">) => `o/${job.asset_id}/c-${job.id}-${job.attempts}`;

/** 不值得压缩或不能压缩（compressTask 的 skipped）。 */
const SKIPPED = 2;
const COMPRESSED = 1;

/** 能压缩的原件：可见的照片 / Live Photo 的 JPEG 原图，没处理过。参数：无。 */
const ELIGIBLE = `${VISIBLE} AND a.kind != 'video' AND f.role = 'original' AND f.mime = 'image/jpeg' AND f.compress_state IS NULL`;

class CompressError extends Error {
	constructor(
		message: string,
		readonly containerSeconds: number,
		readonly permanent = false,
	) {
		super(message);
	}
}

interface OriginalRow {
	file_id: string;
	r2_key: string;
	size: number;
	sha256: string | null;
}

/** 这个条目现在能不能压缩；能的话返回原件那一行。设备端的计划（device.ts）也用它。 */
export async function compressible(env: Env, assetId: string): Promise<OriginalRow | null> {
	return env.DB.prepare(
		`SELECT f.id AS file_id, f.r2_key, f.size, f.sha256 FROM assets a JOIN asset_files f ON f.asset_id = a.id
		 WHERE a.id = ? AND ${ELIGIBLE}`,
	)
		.bind(assetId)
		.first<OriginalRow>();
}

/** compress 任务（见文件头）。getProcessor 可以替换：测试用假的，设备端用设备算好的结果。 */
export async function compressAsset(
	job: RunningJob,
	env: Env,
	getProcessor: GetProcessor = processorStub,
): Promise<{ containerSeconds: number }> {
	const file = await compressible(env, job.asset_id);
	if (!file) return { containerSeconds: 0 };
	const outputKey = compressedKey(job);
	const r = await getProcessor(env, job.slot).compress(file.r2_key, outputKey);
	const seconds = r.containerSeconds;
	// 新 key 只有这个任务会写；没换上去就删掉（不存在也不报错）
	const fail = async (message: string, permanent = false): Promise<never> => {
		await env.PHOTOS.delete(outputKey).catch(() => {});
		throw new CompressError(message, seconds, permanent);
	};
	if (!r.ok || !r.value) return fail(`compress: ${r.error}`);
	const c = r.value;
	if (c.sha256 !== file.sha256 || c.size !== file.size) return fail("integrity check failed (sha256/size mismatch)", true);

	if (!c.out) {
		await env.DB.prepare("UPDATE asset_files SET compress_state = ? WHERE id = ? AND r2_key = ? AND compress_state IS NULL")
			.bind(SKIPPED, file.file_id, file.r2_key)
			.run();
		await env.PHOTOS.delete(outputKey).catch(() => {});
		console.log(JSON.stringify({ event: "compress_skipped", assetId: job.asset_id, reason: c.skipped }));
		return { containerSeconds: seconds };
	}

	// SQLite 的 UPDATE 里右边的列都是修改之前的值：source_sha256 / source_size 记的是原图的
	let updated: { id: string } | null;
	try {
		updated = await env.DB.prepare(
			`UPDATE asset_files SET r2_key = ?, size = ?, sha256 = ?, crc32 = ?, source_sha256 = sha256, source_size = size, compress_state = ?
			 WHERE id = ? AND r2_key = ? AND sha256 = ? AND compress_state IS NULL RETURNING id`,
		)
			.bind(outputKey, c.out.size, c.out.sha256, c.out.crc32, COMPRESSED, file.file_id, file.r2_key, file.sha256)
			.first<{ id: string }>();
	} catch (e) {
		// 压缩后的字节恰好和另一张原图完全一样（去重的唯一索引）：不换
		return fail(`compress: ${String(e).slice(0, 300)}`, true);
	}
	if (!updated) {
		// 期间原件被换过（另一个压缩任务、删除）：这次的结果作废
		await env.PHOTOS.delete(outputKey).catch(() => {});
		return { containerSeconds: seconds };
	}
	try {
		await env.PHOTOS.delete(file.r2_key);
	} catch (e) {
		// 已经没有记录引用旧文件了，只是多占一点空间；日志里留下 key，必要时手动清理
		console.warn(JSON.stringify({ event: "compress_orphan", assetId: job.asset_id, key: file.r2_key, error: String(e).slice(0, 300) }));
	}
	console.log(JSON.stringify({ event: "compress_done", assetId: job.asset_id, before: file.size, after: c.out.size }));
	return { containerSeconds: seconds };
}

// ---------------------------------------------------------------- 接口

const ID = z.string().regex(/^[0-9A-Z]{26}$/);

/** 下限：至少 COMPRESS_MIN_BYTES，不给或不合法时也用它。 */
const minOf = (v: string | undefined) => {
	const n = Number(v);
	return Number.isFinite(n) && n > COMPRESS_MIN_BYTES ? Math.floor(n) : COMPRESS_MIN_BYTES;
};

/** 排队中 / 正在压缩的不算候选（列表和计数一致）。 */
const NOT_QUEUED = "NOT EXISTS (SELECT 1 FROM jobs j WHERE j.asset_id = a.id AND j.kind = 'compress' AND j.status IN ('pending', 'running'))";

/**
 * 候选：没处理过的 JPEG 原图，按原图大小倒序（asset_files_compress，读到下限就停），排队中 / 正在压缩的不列。
 * 返回列表视图的格式（{ items, details, next }），details 里的大小是原图本身的（不含 RAW、Live Photo 的视频）。
 * 结果取决于 jobs 表，不进 ETag 名单。
 */
const CANDIDATES = `SELECT ${ITEM_COLUMNS}, a.file_name, f.size AS file_size, a.taken_at, a.tz_offset_min, a.created_at
	FROM asset_files f INDEXED BY asset_files_compress CROSS JOIN assets a ON a.id = f.asset_id
	WHERE ${ELIGIBLE} AND f.size >= ? AND ${NOT_QUEUED}
	ORDER BY f.size DESC, f.id`;

compress.get("/candidates", async (c) =>
	c.json(await page(c.env, CANDIDATES, [minOf(c.req.query("min"))], offsetOf(c.req.query("offset")), { details: true })),
);

/**
 * 页头的数字：下限以上的候选张数和总大小（和列表一样不含排队中的）、已压缩的张数和省下的空间、不压缩的张数、排队 / 失败的任务数。
 * 只在打开页面、改下限和操作之后请求。候选按索引读到下限为止，已压缩的只扫处理过的行。
 */
compress.get("/summary", async (c) => {
	const env = c.env;
	const [candidates, done, jobs] = await env.DB.batch<Record<string, number | null>>([
		env.DB.prepare(
			`SELECT COUNT(*) AS n, COALESCE(SUM(f.size), 0) AS bytes
			 FROM asset_files f INDEXED BY asset_files_compress CROSS JOIN assets a ON a.id = f.asset_id
			 WHERE ${ELIGIBLE} AND f.size >= ? AND ${NOT_QUEUED}`,
		).bind(minOf(c.req.query("min"))),
		env.DB.prepare(
			`SELECT COALESCE(SUM(compress_state = 1), 0) AS compressed, COALESCE(SUM(compress_state = 2), 0) AS skipped,
				COALESCE(SUM(CASE WHEN compress_state = 1 THEN source_size END), 0) AS before,
				COALESCE(SUM(CASE WHEN compress_state = 1 THEN size END), 0) AS after
			 FROM asset_files INDEXED BY asset_files_compressed WHERE compress_state IS NOT NULL`,
		),
		env.DB.prepare(
			`SELECT COALESCE(SUM(status IN ('pending', 'running')), 0) AS queued, COALESCE(SUM(status = 'failed'), 0) AS failed
			 FROM jobs WHERE kind = 'compress' AND status IN ('pending', 'running', 'failed')`,
		),
	]);
	const [cand, d, j] = [candidates!.results[0]!, done!.results[0]!, jobs!.results[0]!];
	return c.json({
		candidates: { count: cand.n ?? 0, bytes: cand.bytes ?? 0 },
		compressed: { count: d.compressed ?? 0, before: d.before ?? 0, after: d.after ?? 0 },
		skipped: d.skipped ?? 0,
		queued: j.queued ?? 0,
		failed: j.failed ?? 0,
	});
});

/**
 * 压缩选中的照片：只给现在能压缩、没有排队 / 运行中任务的条目建任务（其余算 skipped）。熔断时拒绝。
 * 只由用户点击触发，每次最多 COMPRESS_BATCH_MAX 张。
 */
compress.post("/", async (c) => {
	const env = c.env;
	const { ids } = z.object({ ids: z.array(ID).min(1).max(COMPRESS_BATCH_MAX) }).parse(await c.req.json());
	const unique = [...new Set(ids)];
	if (await guardStub(env).isTripped()) return c.json({ error: "guard tripped" }, 503);
	const eligible: string[] = [];
	for (let i = 0; i < unique.length; i += 80) {
		const chunk = unique.slice(i, i + 80);
		const { results } = await env.DB.prepare(
			`SELECT a.id FROM assets a JOIN asset_files f ON f.asset_id = a.id
			 WHERE a.id IN (${chunk.map(() => "?").join(",")}) AND ${ELIGIBLE}
			   AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.asset_id = a.id AND j.status IN ('pending', 'running'))`,
		)
			.bind(...chunk)
			.all<{ id: string }>();
		eligible.push(...results.map((r) => r.id));
	}
	const queued = eligible.length ? await createJobs(env, eligible, "compress") : 0;
	return c.json({ queued, skipped: unique.length - queued });
});
