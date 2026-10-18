import { Hono } from "hono";
import { z } from "zod";
import {
	CONSUMER_BUDGET_MS,
	DEVICE_CLAIM_MAX,
	DEVICE_OUTPUT_MAX_BYTES,
	DEVICE_POLL_MS,
	DEVICE_VERIFY_MAX_BYTES,
	JOB_STALE_MS,
	MAX_JOB_ATTEMPTS,
	MAX_TRANSCODE_BYTES,
	MAX_TRANSCODE_DURATION_MS,
	PREVIEW_LONG_EDGE,
	UPLOAD_PART_BYTES,
	type CropBox,
	type JobKind,
} from "@nana/shared";
import { DERIVED_FILES, derivedKey } from "./derived";
import { guardStub } from "./guard";
import { CLAIMABLE_SQL, requeueAfterDevice, settleJob, type JobRow } from "./jobs";
import { deriveTargets, previewEdgeOf, processorHandlers, type ProcessorLike } from "./process";
import type { DeriveInput } from "./processor";

/**
 * 设备端处理（apps/device）：主人的电脑代替容器处理任务。
 *
 * 安全：设备用主人自己的 Access 登录（cloudflared access token），和浏览器走同一个 authenticate()，没有第二种身份。
 * 这里的接口只能读“被认领、还在运行的任务”的输入文件，只能写这个任务当前计划里的派生文件 key。
 *
 * 流程：
 *  1. claim：认领一批任务（和消费者一样的原子认领 + UsageGuard.reserveJob），同时续设备租约。
 *     租约有效时队列消费者直接 ack，任务留在 D1 等设备拉取（见 jobs.ts）。每个任务返回一份计划（planJob）。
 *  2. 设备下载输入，在本地运行和容器同一份处理代码（apps/processor/lib.mjs），把缩略图、预览、H.264 预览上传到计划里的 key。
 *  3. complete：用设备的结果构造一个 ProcessorLike（precomputedProcessor），运行和容器路径完全相同的 handler（process.ts）。
 *     handler 实际要的参数和计划不一致（比如期间被旋转过）就当作失败，任务退回 pending 再处理一次，不会写错数据。
 *  4. 设备交还云端（detach）或者消失（租约 DEVICE_LEASE_MS 后失效）后，新消息回到容器；租约期间被 ack 掉的任务
 *     在交还时补发一批，其余由每小时 Cron 补发（requeueAfterDevice）。
 *
 * 设备界面的浏览和上传（apps/device）直接用和浏览器相同的接口（/api/folders、/api/a、/api/uploads），这里不需要专门的接口。
 *
 * 认领凭证是 jobs.started_at：任务过了 JOB_STALE_MS 被别人重新认领后，started_at 变了，设备的后续请求一律 409。
 * 设备的处理时长不算容器费用（recordContainer 不调用）。
 */

type AppEnv = { Bindings: Env };

/** 单次 PUT 的上限（Cloudflare 请求体上限 100 MB），更大的走分块上传。 */
const SINGLE_PUT_MAX = 4 * UPLOAD_PART_BYTES;

type OutputName = keyof typeof DERIVED_FILES;
type DeriveMode = "full" | "skip";

export interface DeviceInputFile {
	fileId: string;
	role: string;
	size: number;
	/** 上传时的文件名和 sha256：设备在本机找原件用。只有能在服务端校验的（不超过 DEVICE_VERIFY_MAX_BYTES）才给 sha256。 */
	name: string | null;
	sha256: string | null;
}

/** 设备界面显示用：文件名和条目类型（日志里不记文件名）。 */
export interface DeviceJobInfo {
	name: string | null;
	assetKind: "photo" | "video" | "live" | null;
}

export interface DevicePlan {
	jobId: string;
	kind: JobKind;
	/** 认领凭证（jobs.started_at），后续请求都要带上 */
	token: number;
	attempts: number;
	/** 要下载的输入文件 */
	inputs: DeviceInputFile[];
	/** null：没有要做的（比如条目已经删除），直接 complete，handler 会提前返回 */
	derive: {
		fileId: string;
		kind: DeriveInput["kind"];
		rotation: number;
		previewEdge: number;
		mode: DeriveMode;
		/** 裁切框（相对于旋转之后的整张图），null 不裁切 */
		crop: CropBox | null;
		/** 打码的笔画（shared 的 encodeMask），null 不打码。有裁切或打码时还要上传底图 outputs.base */
		mask: string | null;
	} | null;
	/** 只读元数据和校验和的附件 */
	meta: string[];
	/** 普通视频：设备按自己读到的时长决定是否转码（不超过 maxDurationMs） */
	transcode: { fileId: string; maxDurationMs: number } | null;
	/** 要上传的派生文件：名字 → R2 key */
	outputs: Partial<Record<OutputName, string>>;
	info: DeviceJobInfo;
}

interface AssetRow {
	id: string;
	kind: "photo" | "video" | "live";
	status: string;
	rotation: number;
	derived_rev: number;
	deleted_at: number | null;
	preview_target: number | null;
	crop_x: number | null;
	crop_y: number | null;
	crop_w: number | null;
	crop_h: number | null;
	mask: string | null;
}
interface FileRow {
	id: string;
	role: string;
	r2_key: string;
	size: number;
	sha256: string | null;
	original_name: string | null;
}

/**
 * 按 D1 的当前状态算出一个任务需要的容器调用，和 process.ts 里两个 handler 的逻辑对应。
 * 两边不同步时，precomputedProcessor 的参数校验会发现，任务退回 pending，不会写错数据。
 */
export async function planJob(env: Env, job: Pick<JobRow, "id" | "asset_id" | "kind" | "attempts" | "started_at">): Promise<DevicePlan> {
	const plan: DevicePlan = {
		jobId: job.id,
		kind: job.kind,
		token: job.started_at ?? 0,
		attempts: job.attempts,
		inputs: [],
		derive: null,
		meta: [],
		transcode: null,
		outputs: {},
		info: { name: null, assetKind: null },
	};
	const asset = await env.DB.prepare(
		"SELECT id, kind, status, rotation, derived_rev, deleted_at, preview_target, crop_x, crop_y, crop_w, crop_h, mask FROM assets WHERE id = ?",
	)
		.bind(job.asset_id)
		.first<AssetRow>();
	if (!asset || asset.deleted_at) return plan;
	const { results: files } = await env.DB.prepare(
		"SELECT id, role, r2_key, size, sha256, original_name FROM asset_files WHERE asset_id = ? AND role IN ('original', 'raw', 'live_video')",
	)
		.bind(asset.id)
		.all<FileRow>();
	const primary = files.find((f) => f.role === "original") ?? files.find((f) => f.role === "raw");
	if (!primary) return plan;
	plan.info = { name: primary.original_name, assetKind: asset.kind };
	const imageKind = primary.role === "raw" ? "raw" : "image";
	const anyKind = asset.kind === "video" ? "video" : imageKind;
	const rev = asset.derived_rev;
	const derive = (kind: DeriveInput["kind"], mode: DeriveMode) => {
		const t = deriveTargets(asset);
		plan.derive = { fileId: primary.id, kind, rotation: asset.rotation, previewEdge: previewEdgeOf(asset), mode, crop: t.crop, mask: t.mask };
		plan.outputs.thumb = t.thumbKey;
		plan.outputs.preview = t.previewKey;
		if (t.baseKey) plan.outputs.base = t.baseKey;
	};

	if (job.kind === "process") {
		derive(anyKind, "full");
		plan.meta = files.filter((f) => f.id !== primary.id).map((f) => f.id);
		if (asset.kind === "video" && primary.size <= MAX_TRANSCODE_BYTES) {
			plan.transcode = { fileId: primary.id, maxDurationMs: MAX_TRANSCODE_DURATION_MS };
			plan.outputs.video_preview = derivedKey(asset.id, "video_preview", rev, DERIVED_FILES.video_preview.ext);
		}
	} else if (job.kind === "rotate") {
		if (asset.kind !== "video") derive(imageKind, "skip");
	}

	const used = new Set([plan.derive?.fileId, ...plan.meta, plan.transcode?.fileId].filter(Boolean));
	plan.inputs = files
		.filter((f) => used.has(f.id))
		.map((f) => ({
			fileId: f.id,
			role: f.role,
			size: f.size,
			name: f.original_name,
			sha256: f.size <= DEVICE_VERIFY_MAX_BYTES ? f.sha256 : null,
		}));
	return plan;
}

// ---- 设备上报的结果（和容器的响应相同，只是缩略图 / 预览已经单独上传）

const Sha = z.string().regex(/^[0-9a-f]{64}$/);
/** exiftool -json -n 的输出：大多是标量，也有列表（比如 CompatibleBrands），和容器路径一样原样交给 parseMeta。 */
const Meta = z.record(z.string().max(256), z.unknown());
const Fp = z.object({ model: z.string().max(64), phash: z.string().regex(/^[0-9a-f]{16}$/), embedding: z.string().max(4096) });
const Faces = z.object({
	model: z.string().max(64),
	faces: z
		.array(
			z.object({
				x: z.number(),
				y: z.number(),
				w: z.number(),
				h: z.number(),
				px: z.number(),
				score: z.number(),
				sharpness: z.number(),
				embedding: z.string().max(4096),
			}),
		)
		.max(200),
	sprite: z.string().max(20_000_000).nullable(),
});
const DeriveResult = z.object({
	meta: Meta.default({}),
	sha256: Sha,
	size: z.number().int().nonnegative(),
	crc32: z.number().int().nonnegative().default(0),
	width: z.number().int().nonnegative().default(0),
	height: z.number().int().nonnegative().default(0),
	fp: Fp.nullable().default(null),
	faces: Faces.nullable().default(null),
	/** 实际用过的打码笔画（lib.mjs 原样带回）。旧版设备端没有这个字段 */
	mask: z.string().max(16_000).nullable().default(null),
});
const MetaResult = z.object({ meta: Meta, sha256: Sha, size: z.number().int().nonnegative(), crc32: z.number().int().nonnegative() });
export const DeviceResults = z.object({
	derive: DeriveResult.nullable().default(null),
	meta: z.record(z.string().max(64), MetaResult).default({}),
	/** 设备转码了：输出已经上传到 outputs.video_preview */
	transcoded: z.boolean().default(false),
});
export type DeviceResults = z.infer<typeof DeviceResults>;

/**
 * 用设备的结果实现 ProcessorLike：handler 调用时先核对参数和计划一致、输出文件确实已经上传，再返回结果。
 * 不一致就返回 ok: false（handler 会抛错，任务退回 pending）。containerSeconds 一律为 0。
 */
export function precomputedProcessor(env: Env, plan: DevicePlan, results: DeviceResults, keys: Map<string, string>) {
	const state = { transcodeUsed: false };
	const fail = (error: string) => ({ ok: false, error: `device: ${error}`, containerSeconds: 0 });
	const done = <T>(value: T) => ({ ok: true, value, containerSeconds: 0 });
	const d = plan.derive;
	const deriveFor = (inputKey: string, kind: string, modes: DeriveMode[]) => {
		if (!d || !modes.includes(d.mode)) return "unexpected call";
		if (keys.get(d.fileId) !== inputKey || d.kind !== kind) return "input mismatch";
		if (!results.derive) return "missing result";
		return null;
	};

	const processor = {
		async derive(input: DeriveInput) {
			const mode: DeriveMode = input.skipFingerprint ? "skip" : "full";
			const bad = deriveFor(input.inputKey, input.kind, [mode]);
			if (bad) return fail(`derive ${bad}`);
			if (
				input.rotation !== d!.rotation ||
				(input.previewEdge ?? PREVIEW_LONG_EDGE) !== d!.previewEdge ||
				input.thumbKey !== plan.outputs.thumb ||
				input.previewKey !== plan.outputs.preview ||
				input.baseKey !== plan.outputs.base ||
				JSON.stringify(input.crop ?? null) !== JSON.stringify(d!.crop ?? null) ||
				(input.mask ?? null) !== d!.mask
			) {
				return fail("derive plan is out of date");
			}
			// 旧版设备端不认打码，上传的是没打码的缩略图和预览：带版本号的地址会直接读到它们（files.ts），必须删掉
			if (results.derive!.mask !== d!.mask) {
				await env.PHOTOS.delete([input.thumbKey, input.previewKey, ...(input.baseKey ? [input.baseKey] : [])]);
				return fail("derive ignored the mask (update the device)");
			}
			const [thumb, preview, base] = await Promise.all([
				env.PHOTOS.head(input.thumbKey),
				env.PHOTOS.head(input.previewKey),
				input.baseKey ? env.PHOTOS.head(input.baseKey) : null,
			]);
			if (!thumb || !preview || (input.baseKey && !base)) return fail("derived files were not uploaded");
			const r = results.derive!;
			return done({ ...r, thumbSize: thumb.size, previewSize: preview.size });
		},
		async meta(inputKey: string) {
			const fileId = plan.meta.find((id) => keys.get(id) === inputKey);
			const r = fileId ? results.meta[fileId] : undefined;
			return r ? done(r) : fail("meta unexpected call or missing result");
		},
		async transcode(inputKey: string, outputKey: string) {
			const t = plan.transcode;
			if (!t || keys.get(t.fileId) !== inputKey || plan.outputs.video_preview !== outputKey) return fail("transcode unexpected call");
			if (!results.transcoded) return fail("not transcoded on device");
			const head = await env.PHOTOS.head(outputKey);
			if (!head) return fail("transcode output was not uploaded");
			state.transcodeUsed = true;
			return done({ size: head.size });
		},
	};
	return { processor: processor as unknown as ProcessorLike, state };
}

// ---- 接口

const Name = z.string().trim().min(1).max(64);
const Token = z.coerce.number().int().positive();

/** 设备的后续请求：任务必须还在运行，并且 started_at 就是认领时的值。 */
async function loadClaim(env: Env, jobId: string, token: number): Promise<JobRow | null> {
	const job = await env.DB.prepare("SELECT id, asset_id, kind, status, attempts, started_at FROM jobs WHERE id = ?")
		.bind(jobId)
		.first<JobRow>();
	return job && job.status === "running" && job.started_at === token ? job : null;
}

const claimLost = { error: "claim lost" } as const;

/** 计划里这个名字的输出 key（必须和设备拿到的一致：期间被旋转过，版本号变了，旧结果不能写到新 key 上）。 */
async function outputKey(env: Env, job: JobRow, name: string, expected: string | undefined): Promise<string | null> {
	if (!Object.hasOwn(DERIVED_FILES, name)) return null;
	const key = (await planJob(env, job)).outputs[name as OutputName];
	return key && key === expected ? key : null;
}

export const device = new Hono<AppEnv>()
	/** 设备界面显示的服务器队列：只有计数和设备租约，不返回文件名。 */
	.get("/queue", async (c) => {
		const now = Date.now();
		const counts = await c.env.DB.prepare(
			`SELECT COALESCE(SUM(status = 'pending'), 0) AS pending,
				COALESCE(SUM(status = 'running' AND started_at >= ?), 0) AS running,
				COALESCE(SUM(status = 'running' AND started_at < ?), 0) AS stuck
			 FROM jobs WHERE status IN ('pending','running')`,
		)
			.bind(now - JOB_STALE_MS, now - JOB_STALE_MS)
			.first<{ pending: number; running: number; stuck: number }>();
		return c.json({ counts, device: await guardStub(c.env).device() });
	})
	/** 开始接管（设备启动或点“转移到设备端执行”）。熔断时拒绝。 */
	.post("/attach", async (c) => {
		const { name } = z.object({ name: Name }).parse(await c.req.json());
		const lease = await guardStub(c.env).renewDevice(name);
		if (!lease.ok) return c.json({ error: "guard tripped" }, 409);
		return c.json({ until: lease.until, pollMs: DEVICE_POLL_MS });
	})
	/** 交还云端：租约立即失效，租约期间被消费者 ack 掉的任务马上补发一批，其余由 Cron 继续补发。 */
	.post("/detach", async (c) => {
		await guardStub(c.env).detachDevice();
		return c.json({ requeued: await requeueAfterDevice(c.env) });
	})
	/** 认领最多 max 个任务（同时续租）。没有任务时返回空列表，设备 DEVICE_POLL_MS 后再来。 */
	.post("/claim", async (c) => {
		const env = c.env;
		const { name, max } = z.object({ name: Name, max: z.number().int().min(0).max(DEVICE_CLAIM_MAX) }).parse(await c.req.json());
		const guard = guardStub(env);
		const lease = await guard.renewDevice(name);
		if (!lease.ok) return c.json({ error: "guard tripped" }, 409);
		if (max === 0) return c.json({ until: lease.until, jobs: [] });

		const now = Date.now();
		const { results: claimed } = await env.DB.prepare(
			`UPDATE jobs SET status = 'running', attempts = attempts + 1, started_at = ?, updated_at = ?
			 WHERE id IN (SELECT id FROM jobs WHERE ${CLAIMABLE_SQL} ORDER BY id LIMIT ?) AND ${CLAIMABLE_SQL}
			 RETURNING id, asset_id, kind, status, attempts, started_at`,
		)
			.bind(now, now, MAX_JOB_ATTEMPTS, now - JOB_STALE_MS, max, MAX_JOB_ATTEMPTS, now - JOB_STALE_MS)
			.all<JobRow>();

		const jobs: DevicePlan[] = [];
		let stopped = false;
		for (const job of claimed.sort((a, b) => a.id.localeCompare(b.id))) {
			const reservation = stopped ? { ok: false as const, reason: "tripped" } : await guard.reserveJob(job.asset_id, job.attempts > 1);
			if (!reservation.ok) {
				// 退回 pending，并把这次尝试还回去：不是任务本身的问题（和消费者一样）。
				stopped = true;
				await env.DB.prepare(
					"UPDATE jobs SET status = 'pending', attempts = attempts - 1, started_at = NULL, updated_at = ? WHERE id = ? AND started_at = ?",
				)
					.bind(Date.now(), job.id, now)
					.run();
				continue;
			}
			jobs.push(await planJob(env, job));
		}
		return c.json({ until: lease.until, jobs });
	})
	/** 下载认领的任务的输入文件。 */
	.get("/jobs/:id/input/:fileId", async (c) => {
		const env = c.env;
		const job = await loadClaim(env, c.req.param("id"), Token.parse(c.req.query("t")));
		if (!job) return c.json(claimLost, 409);
		const file = await env.DB.prepare(
			"SELECT r2_key FROM asset_files WHERE id = ? AND asset_id = ? AND role IN ('original', 'raw', 'live_video')",
		)
			.bind(c.req.param("fileId"), job.asset_id)
			.first<{ r2_key: string }>();
		const object = file ? await env.PHOTOS.get(file.r2_key) : null;
		if (!object) return c.json({ error: "not found" }, 404);
		return new Response(object.body, {
			headers: {
				"Content-Type": "application/octet-stream",
				"Content-Length": String(object.size),
				"Cache-Control": "private, no-store",
			},
		});
	})
	/**
	 * 设备在本机找到了原件时，用它代替下载：Worker 对 R2 上的对象算 sha256，设备比对一致才用本地文件
	 * （上传时读盘出错的话 R2 上是坏的，对不上就照旧下载，由完整性校验让任务失败）。上限见 DEVICE_VERIFY_MAX_BYTES。
	 */
	.get("/jobs/:id/input/:fileId/sha256", async (c) => {
		const env = c.env;
		const job = await loadClaim(env, c.req.param("id"), Token.parse(c.req.query("t")));
		if (!job) return c.json(claimLost, 409);
		const file = await env.DB.prepare(
			"SELECT r2_key, size FROM asset_files WHERE id = ? AND asset_id = ? AND role IN ('original', 'raw', 'live_video')",
		)
			.bind(c.req.param("fileId"), job.asset_id)
			.first<{ r2_key: string; size: number }>();
		if (file && file.size > DEVICE_VERIFY_MAX_BYTES) return c.json({ error: "too large" }, 413);
		const object = file ? await env.PHOTOS.get(file.r2_key) : null;
		if (!object) return c.json({ error: "not found" }, 404);
		const digest = new crypto.DigestStream("SHA-256");
		await object.body.pipeTo(digest);
		const sha256 = [...new Uint8Array(await digest.digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
		return c.json({ sha256, size: object.size });
	})
	/** 上传一个派生文件（不超过 SINGLE_PUT_MAX，更大的用下面的分块上传）。 */
	.put("/jobs/:id/out/:name", async (c) => {
		const env = c.env;
		const job = await loadClaim(env, c.req.param("id"), Token.parse(c.req.query("t")));
		if (!job) return c.json(claimLost, 409);
		const name = c.req.param("name");
		const key = await outputKey(env, job, name, c.req.query("key"));
		if (!key) return c.json({ error: "output not in plan" }, 409);
		const length = Number(c.req.header("content-length"));
		const body = c.req.raw.body;
		if (!body || !Number.isInteger(length) || length <= 0 || length > SINGLE_PUT_MAX) return c.json({ error: "bad length" }, 400);
		const fixed = new FixedLengthStream(length);
		const [, written] = await Promise.all([
			body.pipeTo(fixed.writable),
			env.PHOTOS.put(key, fixed.readable, { httpMetadata: { contentType: DERIVED_FILES[name as OutputName].mime } }),
		]);
		return c.json({ size: written.size });
	})
	.post("/jobs/:id/out/:name/mpu", async (c) => {
		const env = c.env;
		const job = await loadClaim(env, c.req.param("id"), Token.parse(c.req.query("t")));
		if (!job) return c.json(claimLost, 409);
		const name = c.req.param("name");
		const key = await outputKey(env, job, name, c.req.query("key"));
		if (!key) return c.json({ error: "output not in plan" }, 409);
		const { size } = z.object({ size: z.number().int().positive().max(DEVICE_OUTPUT_MAX_BYTES) }).parse(await c.req.json());
		const mpu = await env.PHOTOS.createMultipartUpload(key, { httpMetadata: { contentType: DERIVED_FILES[name as OutputName].mime } });
		return c.json({ uploadId: mpu.uploadId, partBytes: UPLOAD_PART_BYTES, parts: Math.ceil(size / UPLOAD_PART_BYTES) });
	})
	.put("/jobs/:id/out/:name/mpu/:uploadId/:n", async (c) => {
		const env = c.env;
		const job = await loadClaim(env, c.req.param("id"), Token.parse(c.req.query("t")));
		if (!job) return c.json(claimLost, 409);
		const key = await outputKey(env, job, c.req.param("name"), c.req.query("key"));
		if (!key) return c.json({ error: "output not in plan" }, 409);
		const n = z.coerce.number().int().min(1).max(Math.ceil(DEVICE_OUTPUT_MAX_BYTES / UPLOAD_PART_BYTES)).parse(c.req.param("n"));
		const data = new Uint8Array(await c.req.arrayBuffer());
		if (!data.byteLength || data.byteLength > UPLOAD_PART_BYTES) return c.json({ error: "bad length" }, 400);
		const part = await env.PHOTOS.resumeMultipartUpload(key, c.req.param("uploadId")).uploadPart(n, data);
		return c.json({ partNumber: part.partNumber, etag: part.etag });
	})
	.post("/jobs/:id/out/:name/mpu/:uploadId/complete", async (c) => {
		const env = c.env;
		const job = await loadClaim(env, c.req.param("id"), Token.parse(c.req.query("t")));
		if (!job) return c.json(claimLost, 409);
		const key = await outputKey(env, job, c.req.param("name"), c.req.query("key"));
		if (!key) return c.json({ error: "output not in plan" }, 409);
		const { parts } = z
			.object({ parts: z.array(z.object({ partNumber: z.number().int().positive(), etag: z.string().max(256) })).min(1).max(10_000) })
			.parse(await c.req.json());
		const object = await env.PHOTOS.resumeMultipartUpload(key, c.req.param("uploadId")).complete(
			parts.sort((a, b) => a.partNumber - b.partNumber),
		);
		if (object.size > DEVICE_OUTPUT_MAX_BYTES) {
			await env.PHOTOS.delete(key);
			return c.json({ error: "too large" }, 413);
		}
		return c.json({ size: object.size });
	})
	/** 设备处理完：用设备的结果运行和容器路径相同的 handler，再按同样的规则收尾。 */
	.post("/jobs/:id/complete", async (c) => {
		const env = c.env;
		const body = z.object({ t: Token, results: DeviceResults }).parse(await c.req.json());
		const job = await loadClaim(env, c.req.param("id"), body.t);
		if (!job) return c.json(claimLost, 409);
		const status = await completeDeviceJob(env, job, body.results);
		return c.json({ status });
	})
	/** 设备处理失败：和容器失败一样计次数（MAX_JOB_ATTEMPTS），没用完就退回 pending。 */
	.post("/jobs/:id/fail", async (c) => {
		const env = c.env;
		const body = z.object({ t: Token, error: z.string().max(1000) }).parse(await c.req.json());
		const job = await loadClaim(env, c.req.param("id"), body.t);
		if (!job) return c.json(claimLost, 409);
		return c.json({ status: await settleJob(env, job.id, job.attempts, new Error(`device: ${body.error}`)) });
	})
	/** 设备退出时还没开始 / 没做完的任务：退回 pending，把这次尝试还回去（不是任务本身的问题）。 */
	.post("/jobs/:id/release", async (c) => {
		const env = c.env;
		const body = z.object({ t: Token }).parse(await c.req.json());
		await env.DB.prepare(
			"UPDATE jobs SET status = 'pending', attempts = MAX(attempts - 1, 0), started_at = NULL, updated_at = ? WHERE id = ? AND status = 'running' AND started_at = ?",
		)
			.bind(Date.now(), c.req.param("id"), body.t)
			.run();
		return c.json({ ok: true });
	});

export async function completeDeviceJob(env: Env, job: JobRow, results: DeviceResults): Promise<"done" | "retry" | "failed"> {
	const plan = await planJob(env, job);
	const keys = new Map<string, string>();
	if (plan.inputs.length) {
		const { results: rows } = await env.DB.prepare(
			`SELECT id, r2_key FROM asset_files WHERE id IN (${plan.inputs.map(() => "?").join(",")})`,
		)
			.bind(...plan.inputs.map((f) => f.fileId))
			.all<{ id: string; r2_key: string }>();
		for (const r of rows) keys.set(r.id, r.r2_key);
	}
	const { processor, state } = precomputedProcessor(env, plan, results, keys);
	let error: unknown = null;
	try {
		await processorHandlers[job.kind](
			{ ...job, slot: -1, deadline: Date.now() + CONSUMER_BUDGET_MS },
			env,
			() => processor,
		);
	} catch (e) {
		error = e;
	}
	// 设备转码了但 handler 没用上（比如并进了 Live Photo，或者处理失败）：没有记录引用它就删掉
	const mp4 = plan.outputs.video_preview;
	if (mp4 && results.transcoded && !state.transcodeUsed) {
		const used = await env.DB.prepare("SELECT 1 FROM asset_files WHERE r2_key = ?").bind(mp4).first();
		if (!used) await env.PHOTOS.delete(mp4);
	}
	const status = await settleJob(env, job.id, job.attempts, error);
	console.log(JSON.stringify({ event: "device_job", jobId: job.id, kind: job.kind, status }));
	return status;
}
