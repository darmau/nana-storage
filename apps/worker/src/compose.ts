import { Hono } from "hono";
import { z } from "zod";
import {
	COMPOSE_MAX_EDGE,
	COMPOSE_MAX_INPUT_BYTES,
	COMPOSE_MAX_PIXELS,
	COMPOSE_MIN_PIECE_PX,
	COMPOSE_SPLIT_MAX,
	COMPOSE_STITCH_MAX,
	cropOf,
	croppedSize,
	type ComposeDirection,
} from "@nana/shared";
import { guardStub } from "./guard";
import { enqueueJob, jobInsert, type RunningJob } from "./jobs";
import { LOCK_LOCATION, LOCK_TIME } from "./library";
import { processAsset, type GetProcessor } from "./process";
import { type ComposeInput, type ComposeOp, processorStub } from "./processor";
import { ulid } from "./ulid";

/**
 * 拼接与切割：几张照片拼成一张新照片，或者一张照片切成几张新照片。新照片的原件是重新生成的 JPEG
 * （apps/processor/lib.mjs 的 composeTask），按照片现在看起来的样子（方向、用户旋转、裁切）处理；
 * 全部新照片处理好之后，原照片移进回收站（30 天内可以恢复）。
 *
 * 流程：
 *  1. POST /api/compose/stitch | split：新建条目（pending，还看不到）+ compose_specs 记下生成方法 + 每个新条目一个 compose 任务，
 *     放在同一个 batch 里，然后入队（入队失败只记日志，任务留在 D1，“重新排队”可以补发）。
 *     拍摄时间、位置、描述、所在文件夹、归档沿用（第一张）原照片的，时间和位置记成手动编辑过（meta_locked），
 *     处理时不会被新文件的 EXIF 覆盖；收藏是任意一张收藏过就收藏。
 *  2. compose 任务（composeAsset）：容器读原照片的原件生成新 JPEG，写到一个新 key，校验原件的 sha256 后记成新条目的原件；
 *     接着在同一个任务里跑和上传的照片一样的 process（processAsset：缩略图、预览、指纹、人脸）。
 *     上一次尝试已经写好原件、只是后面失败了的，重试时直接从 process 开始。
 *  3. 同一次操作的新条目全部处理好（ready）时，最后完成的那个任务把原照片移进回收站、把新条目加进原照片所在的相册（finishGroup，只做一次）。
 *     有一张失败时原照片不动，在“后台处理”里重试。
 *
 * 打码过的照片不能拼接 / 切割（原件没有打码，生成的新照片会把打码的地方露出来），先去掉打码。视频不能。
 *
 * 设备端不做这种任务（设备接管时消费者照常用容器处理，见 jobs.ts），设备也不会认领它（device.ts）。
 *
 * 成本：每个新条目 1 个任务：1 次 compose（几秒到几十秒，硬超时 COMPOSE_TIMEOUT_MS）+ 1 次 derive，
 * 只由用户点击触发，每次最多 COMPOSE_STITCH_MAX 张拼成 1 张、或者 1 张切成最多 COMPOSE_SPLIT_MAX 张；
 * 照常经过 UsageGuard（月度费用上限、同一条目的循环熔断）和 MAX_JOB_ATTEMPTS。
 */

type Bindings = { Bindings: Env };
export const compose = new Hono<Bindings>();

export type ComposeSpec =
	| { mode: "stitch"; direction: ComposeDirection; sources: string[] }
	| { mode: "split"; direction: ComposeDirection; sources: [string]; from: number; to: number; index: number };

/** 生成的原件的 key：每次尝试一个新 key，没用上的直接删掉。 */
export const composedKey = (job: Pick<RunningJob, "id" | "asset_id" | "attempts">) => `o/${job.asset_id}/m-${job.id}-${job.attempts}`;

class ComposeError extends Error {
	constructor(
		message: string,
		readonly containerSeconds: number,
		readonly permanent = false,
	) {
		super(message);
	}
}

interface SourceRow {
	id: string;
	kind: "photo" | "video" | "live";
	status: string;
	deleted_at: number | null;
	rotation: number;
	width: number | null;
	height: number | null;
	crop_x: number | null;
	crop_y: number | null;
	crop_w: number | null;
	crop_h: number | null;
	mask: string | null;
	/** 原件（没有原件时是 RAW） */
	file_role: string | null;
	r2_key: string | null;
	size: number | null;
	sha256: string | null;
	original_name: string | null;
}

/** 照片和它要用的那个文件（原件，只有 RAW 时用 RAW）。参数：条目 id 的 JSON 数组。 */
const SOURCES_SQL = `SELECT a.id, a.kind, a.status, a.deleted_at, a.rotation, a.width, a.height, a.crop_x, a.crop_y, a.crop_w, a.crop_h, a.mask,
		f.role AS file_role, f.r2_key, f.size, f.sha256, f.original_name
	FROM json_each(?) j CROSS JOIN assets a ON a.id = j.value
	LEFT JOIN asset_files f ON f.id = (
		SELECT id FROM asset_files WHERE asset_id = a.id AND role IN ('original', 'raw') ORDER BY role = 'original' DESC LIMIT 1
	)`;

/** 按 ids 的顺序读出原照片，找不到的不返回。 */
async function loadSources(env: Env, ids: string[]): Promise<SourceRow[]> {
	const { results } = await env.DB.prepare(SOURCES_SQL).bind(JSON.stringify(ids)).all<SourceRow>();
	const byId = new Map(results.map((r) => [r.id, r]));
	return ids.flatMap((id) => byId.get(id) ?? []);
}

/** 文件名去掉扩展名，生成新照片的文件名用。 */
const stem = (name: string | null) => (name ?? "IMG").replace(/\.[^.]*$/, "") || "IMG";

/** compose 任务（见文件头）。getProcessor 可以替换：测试用假的。 */
export async function composeAsset(
	job: RunningJob,
	env: Env,
	getProcessor: GetProcessor = processorStub,
): Promise<{ containerSeconds: number }> {
	const row = await env.DB.prepare(
		`SELECT s.group_id, s.spec, a.deleted_at,
			EXISTS (SELECT 1 FROM asset_files WHERE asset_id = a.id AND role = 'original') AS has_original
		 FROM compose_specs s JOIN assets a ON a.id = s.asset_id WHERE s.asset_id = ?`,
	)
		.bind(job.asset_id)
		.first<{ group_id: string; spec: string; deleted_at: number | null; has_original: number }>();
	if (!row || row.deleted_at) return { containerSeconds: 0 };
	const spec = JSON.parse(row.spec) as ComposeSpec;

	let seconds = 0;
	if (!row.has_original) seconds += await buildOriginal(job, env, spec, getProcessor);
	try {
		seconds += (await processAsset(job, env, getProcessor)).containerSeconds;
	} catch (e) {
		const err = e as { message?: string; containerSeconds?: number; permanent?: boolean };
		throw new ComposeError(String(err.message ?? e), seconds + (err.containerSeconds ?? 0), err.permanent ?? false);
	}
	await finishGroup(env, row.group_id);
	return { containerSeconds: seconds };
}

/** 用容器生成新条目的原件，记进 asset_files。返回容器秒数。 */
async function buildOriginal(job: RunningJob, env: Env, spec: ComposeSpec, getProcessor: GetProcessor): Promise<number> {
	const sources = await loadSources(env, spec.sources);
	if (sources.length !== spec.sources.length || sources.some((s) => !s.r2_key)) throw new ComposeError("source photo is gone", 0, true);
	// 期间打了码：原件没有打码，生成的新照片会把它露出来
	if (sources.some((s) => s.mask)) throw new ComposeError("source photo has a mask", 0, true);

	const inputs: ComposeInput[] = sources.map((s) => ({ key: s.r2_key!, kind: s.file_role === "raw" ? "raw" : "image", rotation: s.rotation, crop: cropOf(s) }));
	const op: ComposeOp =
		spec.mode === "stitch" ? { mode: "stitch", direction: spec.direction } : { mode: "split", direction: spec.direction, from: spec.from, to: spec.to };
	const outputKey = composedKey(job);
	const r = await getProcessor(env, job.slot).compose(inputs, op, outputKey);
	const seconds = r.containerSeconds;
	// 新 key 只有这次尝试会写；没记进去就删掉（不存在也不报错）
	const fail = async (message: string, permanent = false): Promise<never> => {
		await env.PHOTOS.delete(outputKey).catch(() => {});
		throw new ComposeError(message, seconds, permanent);
	};
	if (!r.ok || !r.value) return fail(`compose: ${r.error}`);
	const c = r.value;
	if (c.inputs.length !== sources.length || c.inputs.some((x, i) => x.sha256 !== sources[i]!.sha256 || x.size !== sources[i]!.size)) {
		return fail("integrity check failed (sha256/size mismatch)", true);
	}

	const name = spec.mode === "stitch" ? `${stem(sources[0]!.original_name)}_stitched.jpg` : `${stem(sources[0]!.original_name)}_${spec.index + 1}.jpg`;
	let inserted: { id: string } | null;
	try {
		inserted = await env.DB.prepare(
			`INSERT INTO asset_files (id, asset_id, role, r2_key, mime, size, sha256, crc32, original_name, created_at)
			 SELECT ?, ?, 'original', ?, 'image/jpeg', ?, ?, ?, ?, ?
			 WHERE NOT EXISTS (SELECT 1 FROM asset_files WHERE asset_id = ? AND role = 'original') RETURNING id`,
		)
			.bind(ulid(), job.asset_id, outputKey, c.out.size, c.out.sha256, c.out.crc32, name, Date.now(), job.asset_id)
			.first<{ id: string }>();
	} catch (e) {
		// 生成的字节恰好和另一张原图完全一样（去重的唯一索引）
		return fail(`compose: ${String(e).slice(0, 300)}`, true);
	}
	// 另一次尝试已经先写好了原件（并发的重复消息）：用它的
	if (!inserted) await env.PHOTOS.delete(outputKey).catch(() => {});
	console.log(JSON.stringify({ event: "compose_built", assetId: job.asset_id, mode: spec.mode, width: c.out.width, height: c.out.height }));
	return seconds;
}

/**
 * 同一次操作的新条目都处理好了：原照片移进回收站，新条目加进原照片所在的相册。
 * finished_at 保证只做一次（几块同时完成时只有一个任务抢到）。
 */
async function finishGroup(env: Env, groupId: string) {
	const now = Date.now();
	const { results } = await env.DB.prepare(
		`UPDATE compose_specs SET finished_at = ? WHERE group_id = ? AND finished_at IS NULL
		   AND NOT EXISTS (SELECT 1 FROM compose_specs s JOIN assets a ON a.id = s.asset_id WHERE s.group_id = ? AND a.status != 'ready')
		 RETURNING asset_id, spec`,
	)
		.bind(now, groupId, groupId)
		.all<{ asset_id: string; spec: string }>();
	if (!results.length) return;
	const sources = [...new Set(results.flatMap((r) => (JSON.parse(r.spec) as ComposeSpec).sources))];
	const created = results.map((r) => r.asset_id);
	await env.DB.batch([
		env.DB.prepare(
			`INSERT OR IGNORE INTO album_assets (album_id, asset_id, added_at)
			 SELECT DISTINCT aa.album_id, n.value, ? FROM album_assets aa CROSS JOIN json_each(?) n
			 WHERE aa.asset_id IN (SELECT value FROM json_each(?))`,
		).bind(now, JSON.stringify(created), JSON.stringify(sources)),
		env.DB.prepare(
			"UPDATE assets SET deleted_at = ?, updated_at = ? WHERE id IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL",
		).bind(now, now, JSON.stringify(sources)),
	]);
	console.log(JSON.stringify({ event: "compose_finished", groupId, created: created.length, trashed: sources.length }));
}

// ---------------------------------------------------------------- 接口

const ID = z.string().regex(/^[0-9A-Z]{26}$/);
const Direction = z.enum(["vertical", "horizontal"]);

type Fail = { error: string; status: 400 | 404 };

/** 能不能拼接 / 切割；能的话返回显示尺寸（旋转、裁切之后）。 */
function check(s: SourceRow): Fail | { width: number; height: number } {
	if (s.deleted_at || s.status !== "ready" || s.kind === "video" || !s.r2_key || !s.width || !s.height) return { error: "not composable", status: 400 };
	if (s.mask) return { error: "has mask", status: 400 };
	const [width, height] = croppedSize(s.width, s.height, cropOf(s));
	return { width, height };
}

/**
 * 新建条目、生成方法和任务（同一个 batch），然后入队。first 是沿用元数据的那张原照片。
 * 返回新条目的 id。熔断时只写 D1 不入队，恢复时补发（enqueueJob）。
 */
async function createComposed(env: Env, first: string, sources: string[], specs: ComposeSpec[]): Promise<string[]> {
	const now = Date.now();
	const groupId = ulid(now);
	const ids = specs.map(() => ulid(now));
	const jobs = ids.map((id) => jobInsert(env.DB, id, "compose"));
	await env.DB.batch([
		...ids.flatMap((id, i) => [
			env.DB.prepare(
				`INSERT INTO assets (id, kind, status, folder_id, taken_at, tz_offset_min, local_day, local_month, lat, lon, description,
					favorite, archived, meta_locked, created_at, updated_at)
				 SELECT ?1, 'photo', 'pending', folder_id, taken_at, tz_offset_min, local_day, local_month, lat, lon, description,
					(SELECT MAX(favorite) FROM assets WHERE id IN (SELECT value FROM json_each(?4))), archived, meta_locked | ${LOCK_TIME | LOCK_LOCATION}, ?2, ?2
				 FROM assets WHERE id = ?3`,
			).bind(id, now, first, JSON.stringify(sources)),
			env.DB.prepare("INSERT INTO compose_specs (asset_id, group_id, spec, created_at) VALUES (?, ?, ?, ?)").bind(
				id,
				groupId,
				JSON.stringify(specs[i]),
				now,
			),
		]),
		...jobs.map((j) => j.stmt),
	]);
	for (const j of jobs) {
		try {
			await enqueueJob(env, j.id);
		} catch (e) {
			// 任务留在 D1，“重新排队”可以补发
			console.warn(JSON.stringify({ event: "compose_enqueue_failed", jobId: j.id, error: String(e).slice(0, 300) }));
		}
	}
	return ids;
}

/**
 * 拼接：ids 按顺序拼成一张（vertical 从上到下，horizontal 从左到右），每张按比例缩到最窄 / 最矮那张的宽 / 高。
 * 结果太大（COMPOSE_MAX_PIXELS / COMPOSE_MAX_EDGE）、原件加起来太大时拒绝。熔断时拒绝。
 */
compose.post("/stitch", async (c) => {
	const env = c.env;
	const { ids, direction } = z
		.object({
			ids: z
				.array(ID)
				.min(2)
				.max(COMPOSE_STITCH_MAX)
				.refine((a) => new Set(a).size === a.length),
			direction: Direction,
		})
		.parse(await c.req.json());
	const sources = await loadSources(env, ids);
	if (sources.length !== ids.length) return c.json({ error: "not found" }, 404);
	const dims: { width: number; height: number }[] = [];
	for (const s of sources) {
		const r = check(s);
		if ("error" in r) return c.json({ error: r.error }, r.status);
		dims.push(r);
	}
	const vertical = direction === "vertical";
	const edge = Math.min(...dims.map((d) => (vertical ? d.width : d.height)));
	const length = dims.reduce((n, d) => n + Math.max(1, Math.round(vertical ? (d.height * edge) / d.width : (d.width * edge) / d.height)), 0);
	const bytes = sources.reduce((n, s) => n + (s.size ?? 0), 0);
	if (length > COMPOSE_MAX_EDGE || edge * length > COMPOSE_MAX_PIXELS || bytes > COMPOSE_MAX_INPUT_BYTES) return c.json({ error: "too large" }, 400);
	if (await guardStub(env).isTripped()) return c.json({ error: "guard tripped" }, 503);

	const [assetId] = await createComposed(env, ids[0]!, ids, [{ mode: "stitch", direction, sources: ids }]);
	return c.json({ assetIds: [assetId] }, 201);
});

/**
 * 切割：一张照片按切线切成几张（vertical 横着切、从上到下，horizontal 竖着切、从左到右）。
 * cuts 是切线的位置（0–1 的比例，相对于旋转、裁切之后的照片），从小到大，每块至少 COMPOSE_MIN_PIECE_PX 像素。熔断时拒绝。
 */
compose.post("/split", async (c) => {
	const env = c.env;
	const { id, direction, cuts } = z
		.object({
			id: ID,
			direction: Direction,
			cuts: z
				.array(z.number().gt(0).lt(1))
				.min(1)
				.max(COMPOSE_SPLIT_MAX - 1)
				.refine((a) => a.every((x, i) => i === 0 || x > a[i - 1]!)),
		})
		.parse(await c.req.json());
	const [source] = await loadSources(env, [id]);
	if (!source) return c.json({ error: "not found" }, 404);
	const r = check(source);
	if ("error" in r) return c.json({ error: r.error }, r.status);
	const length = direction === "vertical" ? r.height : r.width;
	const bounds = [0, ...cuts, 1];
	// 和容器同样的取整（composeTask），每块至少 COMPOSE_MIN_PIECE_PX
	const px = bounds.map((b) => Math.round(b * length));
	if (px.some((p, i) => i > 0 && p - px[i - 1]! < COMPOSE_MIN_PIECE_PX)) return c.json({ error: "piece too small" }, 400);
	if ((source.size ?? 0) > COMPOSE_MAX_INPUT_BYTES || r.width * r.height > COMPOSE_MAX_PIXELS) return c.json({ error: "too large" }, 400);
	if (await guardStub(env).isTripped()) return c.json({ error: "guard tripped" }, 503);

	const specs: ComposeSpec[] = cuts.concat(1).map((to, i) => ({ mode: "split", direction, sources: [id], from: bounds[i]!, to, index: i }));
	const assetIds = await createComposed(env, id, [id], specs);
	return c.json({ assetIds }, 201);
});
