import {
	MAX_TRANSCODE_BYTES,
	MAX_TRANSCODE_DURATION_MS,
	PREVIEW_LONG_EDGE,
	TRAIT,
	cropOf,
	transcodeTimeoutMs,
	type JobKind,
} from "@nana/shared";
import { compressAsset } from "./compress";
import { derivedKey } from "./derived";
import { parseMeta, type Meta } from "./exif";
import { handlers, type RunningJob } from "./jobs";
import { type DeriveOutput, processorStub } from "./processor";
import { saveFaces } from "./people";
import { deleteSearchRows, replaceSearchRow } from "./search";
import { saveFingerprint } from "./similar";
import { ulid } from "./ulid";

/**
 * process 任务：读元数据、生成缩略图/预览、（普通视频）转码、Live Photo 配对。
 *
 * 成本相关：
 *  - 每个任务最多调用容器：1 次 derive + 每个附件 1 次 meta + 最多 1 次 transcode（只有普通视频）。
 *    指纹（相同 / 相似照片）和人脸（人物）在 derive 里一起算出来，不额外调用容器。
 *  - 转码失败不会让任务失败（不触发重试），只是没有 H.264 预览，播放时退回原件。
 *  - 本任务不创建任何新任务。
 */

interface AssetRow {
	id: string;
	kind: "photo" | "video" | "live";
	rotation: number;
	derived_rev: number;
	client_mtime: number | null;
	tz_offset_min: number | null;
	deleted_at: number | null;
	/** “加载原图”要的预览长边，NULL 表示默认 */
	preview_target: number | null;
	/** 查看器“编辑”的裁切框，都为 NULL 表示没有裁切（见 shared 的 cropOf） */
	crop_x: number | null;
	crop_y: number | null;
	crop_w: number | null;
	crop_h: number | null;
	/** 打码的笔画（shared 的 encodeMask），NULL 表示没有打码 */
	mask: string | null;
}
interface FileRow {
	id: string;
	role: string;
	r2_key: string;
	mime: string;
	size: number;
	sha256: string | null;
	original_name: string | null;
}

class JobError extends Error {
	constructor(
		message: string,
		readonly containerSeconds: number,
		readonly permanent = false,
	) {
		super(message);
	}
}

/**
 * 显示尺寸：EXIF 尺寸是用户旋转之前的（旋转 90°/270° 时要对调）；
 * 没有 EXIF 尺寸时用预览图的尺寸，它已经是旋转后的。
 */
export function displaySize(w: number | null, h: number | null, previewW: number, previewH: number, rotation: number) {
	if (!w || !h) return [previewW, previewH] as const;
	return rotation % 180 ? ([h, w] as const) : ([w, h] as const);
}

const DERIVED_ROLES = ["thumb", "preview", "video_preview"];

const ASSET_COLUMNS = "id, kind, rotation, derived_rev, client_mtime, tz_offset_min, deleted_at, preview_target, crop_x, crop_y, crop_w, crop_h, mask";

/** 这一版的缩略图、预览（有裁切或打码时还有未裁切、未打码的底图）的 key，和生成它们用的裁切框、打码。 */
export function deriveTargets(asset: Pick<AssetRow, "id" | "derived_rev" | "crop_x" | "crop_y" | "crop_w" | "crop_h" | "mask">) {
	const rev = asset.derived_rev;
	const crop = cropOf(asset);
	const mask = asset.mask || null;
	return {
		crop,
		mask,
		thumbKey: derivedKey(asset.id, "thumb", rev, "webp"),
		previewKey: derivedKey(asset.id, "preview", rev, "webp"),
		baseKey: crop || mask ? derivedKey(asset.id, "base", rev, "webp") : undefined,
	};
}

/** 用这次 derive 的结果替换 asset_files 里的缩略图 / 预览。 */
function replaceDerivedFiles(env: Env, assetId: string, t: ReturnType<typeof deriveTargets>, d: DeriveOutput, ts: number) {
	return [
		env.DB.prepare("DELETE FROM asset_files WHERE asset_id = ? AND role IN ('thumb','preview')").bind(assetId),
		env.DB.prepare(
			`INSERT INTO asset_files (id, asset_id, role, r2_key, mime, size, created_at) VALUES
			 (?, ?, 'thumb', ?, 'image/webp', ?, ?), (?, ?, 'preview', ?, 'image/webp', ?, ?)`,
		).bind(ulid(), assetId, t.thumbKey, d.thumbSize, ts, ulid(), assetId, t.previewKey, d.previewSize, ts),
	];
}

/**
 * 删掉其他版本的底图（编辑界面用的未裁切、未打码底图）。底图不记在 asset_files 里（role 有 CHECK 约束，改它要重建整张表），
 * 只按 key 读：查看器只在没有任务在跑时带当前版本号请求它。这里按前缀列一次 R2（每个照片最多几个对象）。
 * 永久删除时按当前版本号的 key 删（purge.ts 遍历 DERIVED_FILES）。
 */
async function pruneBases(env: Env, assetId: string, keep: string | undefined) {
	const listed = await env.PHOTOS.list({ prefix: `d/${assetId}/base-`, limit: 100 });
	const stale = listed.objects.map((o) => o.key).filter((k) => k !== keep);
	if (stale.length) await env.PHOTOS.delete(stale);
}

/** 生成预览用的长边：“加载原图”换过全尺寸预览的照片保持原图尺寸。 */
export const previewEdgeOf = (a: Pick<AssetRow, "preview_target">) => Math.max(PREVIEW_LONG_EDGE, a.preview_target ?? 0);

/** 剩下的时间不够这么多就不转码了。 */
const MIN_TRANSCODE_TIMEOUT_MS = 30_000;

export type ProcessorLike = Pick<ReturnType<typeof processorStub>, "derive" | "meta" | "transcode" | "compress">;
export type GetProcessor = (env: Env, slot: number) => ProcessorLike;

/** getProcessor 可以替换，方便测试时不启动容器。 */
export async function processAsset(
	job: RunningJob,
	env: Env,
	getProcessor: GetProcessor = processorStub,
): Promise<{ containerSeconds: number }> {
	let seconds = 0;

	const [assetRes, filesRes] = await env.DB.batch<AssetRow | FileRow>([
		env.DB.prepare(`SELECT ${ASSET_COLUMNS} FROM assets WHERE id = ?`).bind(job.asset_id),
		env.DB.prepare("SELECT id, role, r2_key, mime, size, sha256, original_name FROM asset_files WHERE asset_id = ?").bind(job.asset_id),
	]);
	const asset = assetRes!.results[0] as AssetRow | undefined;
	if (!asset || asset.deleted_at) return { containerSeconds: 0 };
	const files = filesRes!.results as FileRow[];
	const byRole = (r: string) => files.find((f) => f.role === r);
	const primary = byRole("original") ?? byRole("raw");
	if (!primary) throw new JobError("asset has no source file", 0, true);
	// 条目不再改成 processing：界面上它和 pending 完全一样（任务的 running 已经说明在处理），省掉每张一次 assets 写入和触发器的写入。

	const proc = getProcessor(env, job.slot);
	const rev = asset.derived_rev;
	const kind = asset.kind === "video" ? "video" : primary.role === "raw" ? "raw" : "image";
	const targets = deriveTargets(asset);

	const previewEdge = previewEdgeOf(asset);
	const dr = await proc.derive({ inputKey: primary.r2_key, kind, rotation: asset.rotation, ...targets, previewEdge });
	seconds += dr.containerSeconds;
	if (!dr.ok || !dr.value) throw new JobError(`derive: ${dr.error}`, seconds);
	const d = dr.value;
	if (d.sha256 !== primary.sha256 || d.size !== primary.size) {
		throw new JobError("integrity check failed (sha256/size mismatch)", seconds, true);
	}

	// 按 sha256 定位：处理期间原图被压缩过（compress 任务换了文件），这里的 CRC32 是旧文件的，不能写到新文件上
	const crcUpdates = [env.DB.prepare("UPDATE asset_files SET crc32 = ? WHERE id = ? AND sha256 = ?").bind(d.crc32, primary.id, d.sha256)];

	// 附件：只校验完整性和读元数据
	let videoMeta: Meta | null = null;
	for (const f of files) {
		if (f.id === primary.id || !["original", "raw", "live_video"].includes(f.role)) continue;
		const mr = await proc.meta(f.r2_key);
		seconds += mr.containerSeconds;
		if (!mr.ok || !mr.value) throw new JobError(`meta ${f.role}: ${mr.error}`, seconds);
		const m = mr.value;
		if (m.sha256 !== f.sha256 || m.size !== f.size) {
			throw new JobError(`integrity check failed for ${f.role}`, seconds, true);
		}
		if (f.role === "live_video") videoMeta = m.meta;
		crcUpdates.push(env.DB.prepare("UPDATE asset_files SET crc32 = ? WHERE id = ? AND sha256 = ?").bind(m.crc32, f.id, m.sha256));
	}

	const parsed = parseMeta(d.meta, { clientMtime: asset.client_mtime, clientTzOffsetMin: asset.tz_offset_min });
	const videoParsed = videoMeta
		? parseMeta(videoMeta, { clientMtime: asset.client_mtime, clientTzOffsetMin: asset.tz_offset_min })
		: null;
	const now = Date.now();
	const names = files.map((f) => f.original_name).filter(Boolean).join(" ");
	const traits = parsed.traits | (files.some((f) => f.role === "raw") ? TRAIT.raw : 0);

	await env.DB.batch([
		...crcUpdates,
		...replaceDerivedFiles(env, asset.id, targets, d, now),
		env.DB.prepare(
			// 手动编辑过的时间（meta_locked & 1）和位置（& 2）保持不变
			`UPDATE assets SET
				status = 'ready',
				taken_at = CASE WHEN meta_locked & 1 THEN taken_at ELSE ?1 END,
				tz_offset_min = CASE WHEN meta_locked & 1 THEN tz_offset_min ELSE ?2 END,
				local_day = CASE WHEN meta_locked & 1 THEN local_day ELSE ?3 END,
				local_month = CASE WHEN meta_locked & 1 THEN local_month ELSE ?4 END,
				width = ?5, height = ?6, duration_ms = ?7,
				lat = CASE WHEN meta_locked & 2 THEN lat ELSE ?8 END,
				lon = CASE WHEN meta_locked & 2 THEN lon ELSE ?9 END,
				camera = ?10, lens = ?11, content_identifier = ?12, updated_at = ?13, preview_edge = ?15,
				burst_id = COALESCE(?16, burst_id), traits = ?17
			 WHERE id = ?14`,
		).bind(
			parsed.takenAt,
			parsed.tzOffsetMin,
			parsed.localDay,
			parsed.localMonth,
			...displaySize(parsed.width, parsed.height, d.width, d.height, asset.rotation),
			parsed.durationMs ?? videoParsed?.durationMs ?? null,
			parsed.lat ?? videoParsed?.lat ?? null,
			parsed.lon ?? videoParsed?.lon ?? null,
			parsed.camera,
			parsed.lens,
			parsed.contentIdentifier ?? videoParsed?.contentIdentifier ?? null,
			now,
			asset.id,
			previewEdge,
			parsed.burstUuid,
			traits,
		),
		...replaceSearchRow(env, asset.id, names),
	]);

	if (!parsed.burstUuid && asset.kind === "photo") await groupBurst(env, asset.id);
	await saveFingerprint(env, asset.id, d.fp);
	if (asset.kind !== "video") await saveFaces(env, asset.id, d.faces, rev);

	const cid = parsed.contentIdentifier ?? videoParsed?.contentIdentifier ?? null;
	const merged = cid && asset.kind !== "live" ? await mergeLivePhoto(env, asset, cid) : false;

	// 只给普通视频转码。Live Photo 的动态部分只有几秒，不转：浏览器不能解码 HEVC 时只显示静态照片。
	// 已经并入 Live Photo 的视频条目也不转。
	if (asset.kind === "video" && !merged) {
		const duration = parsed.durationMs ?? (await durationOf(env, asset.id));
		seconds += await transcodeIfAllowed(env, proc, asset.id, rev, primary, duration, job.deadline);
	}
	return { containerSeconds: seconds };
}

async function durationOf(env: Env, assetId: string) {
	const row = await env.DB.prepare("SELECT duration_ms FROM assets WHERE id = ?").bind(assetId).first<{ duration_ms: number | null }>();
	return row?.duration_ms ?? null;
}

async function transcodeIfAllowed(
	env: Env,
	proc: ProcessorLike,
	assetId: string,
	rev: number,
	video: FileRow,
	durationMs: number | null,
	deadline: number,
): Promise<number> {
	if (durationMs === null || durationMs > MAX_TRANSCODE_DURATION_MS || video.size > MAX_TRANSCODE_BYTES) {
		console.log(JSON.stringify({ event: "transcode_skipped", assetId, durationMs, size: video.size }));
		return 0;
	}
	// 不能超过消费者的墙钟上限（排队等槽位用掉了一部分），被平台中途杀掉比超时更糟。
	const timeoutMs = Math.min(transcodeTimeoutMs(durationMs), deadline - Date.now());
	if (timeoutMs < MIN_TRANSCODE_TIMEOUT_MS) {
		console.warn(JSON.stringify({ event: "transcode_skipped_deadline", assetId, durationMs, timeoutMs }));
		return 0;
	}
	const key = derivedKey(assetId, "video_preview", rev, "mp4");
	const t = await proc.transcode(video.r2_key, key, timeoutMs);
	if (!t.ok || !t.value) {
		console.warn(JSON.stringify({ event: "transcode_failed", assetId, error: t.error }));
		return t.containerSeconds;
	}
	await env.DB.batch([
		env.DB.prepare("DELETE FROM asset_files WHERE asset_id = ? AND role = 'video_preview' AND r2_key != ?").bind(
			assetId,
			key,
		),
		env.DB.prepare(
			`INSERT OR REPLACE INTO asset_files (id, asset_id, role, r2_key, mime, size, created_at)
			 VALUES (?, ?, 'video_preview', ?, 'video/mp4', ?, ?)`,
		).bind(ulid(), assetId, key, t.value.size, Date.now()),
	]);
	return t.containerSeconds;
}

/** 推断出来的连拍组 ID 的前缀（Apple 的 BurstUUID 不带前缀）。 */
const INFERRED_BURST = "t:";
/** 同一台相机、同样尺寸、拍摄间隔不超过这么多毫秒的照片算一组连拍。 */
export const BURST_GAP_MS = 500;

/**
 * 没有 BurstUUID 的连拍（大多数安卓手机）：按拍摄间隔推断。
 * 间隔必须大于 0：没有亚秒精度的时间只能精确到秒，同一秒里的两张（比如同一张图的 HEIC 和 JPEG）不算连拍，
 * 所以实际上只有带 SubSecTimeOriginal 的照片才会被分组。
 * 照片的处理顺序是任意的，后处理的那张会把两边已有的组合并成一个。
 */
async function groupBurst(env: Env, id: string) {
	const self = await env.DB.prepare(
		"SELECT taken_at, camera, width, height, burst_id, meta_locked FROM assets WHERE id = ?",
	)
		.bind(id)
		.first<{ taken_at: number | null; camera: string | null; width: number | null; height: number | null; burst_id: string | null; meta_locked: number }>();
	if (!self || self.taken_at === null || !self.camera || self.meta_locked & 1) return;
	if (self.burst_id && !self.burst_id.startsWith(INFERRED_BURST)) return;

	const { results: near } = await env.DB.prepare(
		`SELECT id, burst_id FROM assets
		 WHERE deleted_at IS NULL AND status = 'ready' AND taken_at BETWEEN ?1 - ?2 AND ?1 + ?2 AND taken_at != ?1
		   AND id != ?3 AND kind = 'photo' AND camera = ?4 AND width IS ?5 AND height IS ?6 AND (meta_locked & 1) = 0
		   AND (burst_id IS NULL OR burst_id LIKE 't:%')
		 LIMIT 20`,
	)
		.bind(self.taken_at, BURST_GAP_MS, id, self.camera, self.width, self.height)
		.all<{ id: string; burst_id: string | null }>();
	if (!near.length) return;

	const group = self.burst_id ?? near.find((r) => r.burst_id)?.burst_id ?? `${INFERRED_BURST}${ulid()}`;
	const ids = [id, ...near.map((r) => r.id)];
	const list = ids.map(() => "?").join(",");
	await env.DB.prepare(
		`UPDATE assets SET burst_id = ? WHERE id IN (${list})
		 OR burst_id IN (SELECT burst_id FROM assets WHERE id IN (${list}) AND burst_id LIKE 't:%')`,
	)
		.bind(group, ...ids, ...ids)
		.run();
}

/**
 * Live Photo 兜底配对：HEIC 和 MOV 分成两个条目上传时，按 ContentIdentifier 合并成一个。
 * 照片条目保留，视频条目的原件变成照片条目的 live_video，然后删除视频条目。
 * 返回是否合并了。
 */
async function mergeLivePhoto(env: Env, asset: AssetRow, cid: string): Promise<boolean> {
	const otherKind = asset.kind === "video" ? "photo" : "video";
	const other = await env.DB.prepare(
		`SELECT id FROM assets WHERE content_identifier = ? AND kind = ? AND id != ? AND deleted_at IS NULL
		 AND status = 'ready' LIMIT 1`,
	)
		.bind(cid, otherKind, asset.id)
		.first<{ id: string }>();
	if (!other) return false;

	const photoId = asset.kind === "photo" ? asset.id : other.id;
	const videoId = asset.kind === "video" ? asset.id : other.id;
	const videoFile = await env.DB.prepare(
		"SELECT id, role, r2_key, mime, size, sha256, original_name FROM asset_files WHERE asset_id = ? AND role = 'original'",
	)
		.bind(videoId)
		.first<FileRow>();
	if (!videoFile) return false;

	const { results: derived } = await env.DB.prepare(
		`SELECT r2_key FROM asset_files WHERE asset_id = ? AND role IN (${DERIVED_ROLES.map(() => "?").join(",")})`,
	)
		.bind(videoId, ...DERIVED_ROLES)
		.all<{ r2_key: string }>();
	const duration = await durationOf(env, videoId);

	await env.DB.batch([
		env.DB.prepare("UPDATE asset_files SET asset_id = ?, role = 'live_video' WHERE id = ?").bind(photoId, videoFile.id),
		env.DB.prepare(
			"UPDATE assets SET kind = 'live', duration_ms = COALESCE(duration_ms, ?), updated_at = ? WHERE id = ?",
		).bind(duration, Date.now(), photoId),
		...deleteSearchRows(env, [videoId]),
		env.DB.prepare("DELETE FROM assets WHERE id = ?").bind(videoId),
	]);
	if (derived.length) await env.PHOTOS.delete(derived.map((r) => r.r2_key));
	console.log(JSON.stringify({ event: "live_photo_merged", photoId, videoId }));
	return true;
}

/**
 * rotate 任务：只按新的角度 / 裁切 / 打码 / 尺寸重新生成缩略图和预览（1 次 derive），不重读元数据、不转码。
 * 查看器的“加载原图”也用它（角度不变，按 preview_target 生成原图尺寸的预览，替换原来的预览）。
 * 角度、尺寸和版本号在运行时读取，所以连续旋转多次只需要最后一次的结果。
 */
export async function rotateAsset(
	job: RunningJob,
	env: Env,
	getProcessor: GetProcessor = processorStub,
): Promise<{ containerSeconds: number }> {
	const asset = await env.DB.prepare(`SELECT ${ASSET_COLUMNS} FROM assets WHERE id = ?`)
		.bind(job.asset_id)
		.first<AssetRow>();
	if (!asset || asset.deleted_at || asset.kind === "video") return { containerSeconds: 0 };
	const { results: files } = await env.DB.prepare(
		"SELECT id, role, r2_key, mime, size, sha256, original_name FROM asset_files WHERE asset_id = ?",
	)
		.bind(asset.id)
		.all<FileRow>();
	const primary = files.find((f) => f.role === "original") ?? files.find((f) => f.role === "raw");
	if (!primary) throw new JobError("asset has no source file", 0, true);

	const rev = asset.derived_rev;
	const targets = deriveTargets(asset);
	const written = [targets.thumbKey, targets.previewKey, ...(targets.baseKey ? [targets.baseKey] : [])];
	const previewEdge = previewEdgeOf(asset);
	const dr = await getProcessor(env, job.slot).derive({
		inputKey: primary.r2_key,
		kind: primary.role === "raw" ? "raw" : "image",
		rotation: asset.rotation,
		...targets,
		skipFingerprint: true, // 指纹按旋转之前的图像计算，不变
		previewEdge,
	});
	if (!dr.ok || !dr.value) throw new JobError(`derive: ${dr.error}`, dr.containerSeconds);
	const d = dr.value;

	// 运行期间又被旋转过：这次的结果已经过时，删掉，交给后面那个任务
	const now = await env.DB.prepare("SELECT derived_rev FROM assets WHERE id = ?").bind(asset.id).first<{ derived_rev: number }>();
	if (!now || now.derived_rev !== rev) {
		await env.PHOTOS.delete(written);
		return { containerSeconds: dr.containerSeconds };
	}

	const old = files.filter((f) => (f.role === "thumb" || f.role === "preview") && !written.includes(f.r2_key));
	const ts = Date.now();
	await env.DB.batch([
		...replaceDerivedFiles(env, asset.id, targets, d, ts),
		env.DB.prepare("UPDATE assets SET preview_edge = ? WHERE id = ?").bind(previewEdge, asset.id),
	]);
	if (old.length) await env.PHOTOS.delete(old.map((f) => f.r2_key));
	await pruneBases(env, asset.id, targets.baseKey);
	return { containerSeconds: dr.containerSeconds };
}

/** 各类任务用指定的 Processor 运行。设备端处理用它：Processor 换成设备预先算好的结果（见 device.ts）。 */
export const processorHandlers: Record<
	JobKind,
	(job: RunningJob, env: Env, getProcessor: GetProcessor) => Promise<{ containerSeconds: number }>
> = {
	process: processAsset,
	rotate: rotateAsset,
	compress: compressAsset,
};

handlers.process = (job, env) => processAsset(job, env);
handlers.rotate = (job, env) => rotateAsset(job, env);
handlers.compress = (job, env) => compressAsset(job, env);
