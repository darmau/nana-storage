import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, open, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { compressTask, deriveTask, metaTask, saveInput, transcodeTask } from "../processor/lib.mjs";
import { ApiError } from "./client.mjs";

/**
 * progress：界面用的进度（main.mjs 的任务条目），这里只往上写字段：
 *   stage   local / download / derive / meta / transcode / compress / upload / complete
 *   source  输入从哪里来：local 本机暂存的上传文件 / download 从服务器下载（有一个是下载的就算 download）
 *   step    derive 里的细分步骤（decode / images / thumb / fingerprint / faces，见 lib.mjs）；compress 里是 decode / encode / verify
 *   bytes / total  下载进度
 *   thumb   缩略图生成好之后的字节（只在内存里，界面显示用）
 */

/**
 * 处理一个认领到的任务（计划见 apps/worker/src/device.ts 的 planJob）：
 * 下载输入 → 和容器同一份处理代码（lib.mjs）→ 上传派生文件 → complete。
 * 出错时 fail（服务端按 MAX_JOB_ATTEMPTS 计次数）；认领已经失效（409 claim lost）就什么都不做。
 * 临时文件放在系统临时目录，结束就删；日志只记 ID。
 */

/** 单次 PUT 的上限，和服务端 SINGLE_PUT_MAX 一致；更大的走分块上传。 */
const SINGLE_PUT_MAX = 80 * 1024 ** 2;
/** 设备端比容器快得多，给转码留足时间（5 分钟以内的视频）。 */
const TRANSCODE_TIMEOUT_MS = 30 * 60_000;

export class ClaimLost extends Error {}

export async function runJob(api, plan, progress = {}, local = null) {
	const onStage = (stage) => {
		progress.stage = stage;
		progress.step = null;
	};
	const q = `t=${plan.token}`;
	const base = `/device/jobs/${encodeURIComponent(plan.jobId)}`;
	const call = async (path, opts) => {
		try {
			return await api.request(path, opts);
		} catch (e) {
			if (e instanceof ApiError && e.status === 409 && e.code === "claim lost") throw new ClaimLost();
			throw e;
		}
	};
	const dir = await mkdtemp(join(tmpdir(), "nana-job-"));
	try {
		const inputs = new Map();
		onStage("download");
		progress.total = plan.inputs.reduce((n, f) => n + f.size, 0);
		progress.bytes = 0;
		// 用生成器计数（不用 pipe：pipe 不传递错误，下载中断时会一直挂着）
		const counted = (source) =>
			(async function* () {
				for await (const chunk of source) {
					progress.bytes += chunk.length;
					yield chunk;
				}
			})();
		for (const f of plan.inputs) {
			const path = join(dir, `in-${inputs.size}`);
			const start = progress.bytes;
			let saved = null;
			if (local && f.sha256) {
				onStage("local");
				saved = await fromLocal(call, base, q, f, path, local, counted);
				if (!saved) progress.bytes = start;
			}
			if (!saved) {
				onStage("download");
				progress.source = "download";
				const res = await call(`${base}/input/${encodeURIComponent(f.fileId)}?${q}`, { stream: true });
				saved = await saveInput(counted(Readable.fromWeb(res.body)), path);
			}
			inputs.set(f.fileId, { path, ...saved });
		}
		progress.source ??= plan.inputs.length ? "local" : null;

		const results = { derive: null, meta: {}, transcoded: false, compress: null };
		const d = plan.derive;
		if (d) {
			onStage("derive");
			const work = join(dir, "derive");
			await mkdir(work);
			const r = await deriveTask(inputs.get(d.fileId), work, {
				kind: d.kind,
				rotation: d.rotation,
				mode: d.mode,
				previewEdge: d.previewEdge,
				crop: d.crop ?? null,
				mask: d.mask ?? null,
				onStep: (step, thumbPath) => {
					progress.step = step;
					if (thumbPath) readFile(thumbPath).then((b) => (progress.thumb = b), () => {});
				},
			});
			results.derive = r.body;
			if (r.thumbPath) {
				onStage("upload");
				await upload(call, base, q, "thumb", plan.outputs.thumb, r.thumbPath);
				await upload(call, base, q, "preview", plan.outputs.preview, r.previewPath);
				if (plan.outputs.base && r.basePath) await upload(call, base, q, "base", plan.outputs.base, r.basePath);
			}
		}
		for (const id of plan.meta) {
			onStage("meta");
			results.meta[id] = await metaTask(inputs.get(id));
		}
		if (plan.transcode) results.transcoded = await transcode(call, base, q, plan, inputs, results, dir, onStage);
		const c = plan.compress;
		if (c) {
			onStage("compress");
			const work = join(dir, "compress");
			await mkdir(work);
			const r = await compressTask(inputs.get(c.fileId), work, {
				quality: c.quality,
				minSaving: c.minSaving,
				maxBytes: c.maxBytes,
				maxDiff: c.maxDiff,
				onStep: (step) => (progress.step = step),
			});
			results.compress = r.body;
			if (r.outPath) {
				onStage("upload");
				await upload(call, base, q, "compressed", plan.outputs.compressed, r.outPath);
			}
		}

		onStage("complete");
		return (await call(`${base}/complete`, { method: "POST", json: { t: plan.token, results } })).status;
	} catch (e) {
		if (e instanceof ClaimLost) return "lost";
		const error = String(e?.message ?? e).slice(0, 900);
		await call(`${base}/fail`, { method: "POST", json: { t: plan.token, error } }).catch(() => {});
		throw e;
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/**
 * 在本机找输入文件（local 有 candidates(name, size) 和 used(path)：设备上传的暂存文件，见 upload.mjs）：
 * 大小一样的候选复制到临时目录（顺便算 sha256，复制出来的就是处理用的那一份，期间原文件变了也不影响），
 * 和上传时的 sha256 一致后，再让服务器对 R2 上的对象算一次 sha256（代替下载后的完整性校验），也一致才用。
 * 任何一步对不上或出错都返回 null，照旧下载。认领失效（ClaimLost）照常抛出。
 */
async function fromLocal(call, base, q, f, path, local, counted) {
	for (const candidate of local.candidates(f.name, f.size)) {
		let saved;
		try {
			saved = await saveInput(counted(createReadStream(candidate, { highWaterMark: 1024 * 1024 })), path);
		} catch {
			continue;
		}
		if (saved.sha256 !== f.sha256 || saved.size !== f.size) continue;
		let remote;
		try {
			remote = await call(`${base}/input/${encodeURIComponent(f.fileId)}/sha256?${q}`);
		} catch (e) {
			if (e instanceof ClaimLost) throw e;
			return null;
		}
		if (remote.sha256 === f.sha256 && remote.size === f.size) {
			// 已经复制到任务的临时目录：暂存的那份可以删了
			local.used?.(candidate);
			return saved;
		}
		// R2 上的和上传时的校验和不一致：下载下来交给完整性校验（任务失败）
		console.warn(JSON.stringify({ event: "remote_sha_mismatch", fileId: f.fileId }));
		return null;
	}
	return null;
}

/**
 * 普通视频转码。时长按读到的元数据判断（和服务端一样超过 maxDurationMs 不转），读不到时长也转（服务端用不上就删掉）。
 * 转码失败不让任务失败（和容器一样），只是没有 H.264 预览。
 */
async function transcode(call, base, q, plan, inputs, results, dir, onStage) {
	const seconds = Number(results.derive?.meta?.Duration);
	if (Number.isFinite(seconds) && seconds * 1000 > plan.transcode.maxDurationMs) return false;
	onStage("transcode");
	const work = join(dir, "transcode");
	await mkdir(work);
	let out;
	try {
		out = await transcodeTask(inputs.get(plan.transcode.fileId), work, { timeoutMs: TRANSCODE_TIMEOUT_MS });
	} catch (e) {
		console.warn(JSON.stringify({ event: "transcode_failed", jobId: plan.jobId, error: String(e?.message ?? e).slice(0, 300) }));
		return false;
	}
	onStage("upload");
	await upload(call, base, q, "video_preview", plan.outputs.video_preview, out);
	return true;
}

async function upload(call, base, q, name, key, path) {
	const out = `${base}/out/${name}`;
	const k = `${q}&key=${encodeURIComponent(key)}`;
	const { size } = await stat(path);
	if (size <= SINGLE_PUT_MAX) {
		await call(`${out}?${k}`, { method: "PUT", body: await readFile(path), headers: { "content-type": "application/octet-stream" } });
		return;
	}
	const { uploadId, partBytes } = await call(`${out}/mpu?${k}`, { method: "POST", json: { size } });
	const parts = [];
	const file = await open(path);
	try {
		for (let n = 1, offset = 0; offset < size; n++, offset += partBytes) {
			const buf = Buffer.alloc(Math.min(partBytes, size - offset));
			await file.read(buf, 0, buf.length, offset);
			parts.push(
				await call(`${out}/mpu/${encodeURIComponent(uploadId)}/${n}?${k}`, {
					method: "PUT",
					body: buf,
					headers: { "content-type": "application/octet-stream" },
				}),
			);
		}
	} finally {
		await file.close();
	}
	await call(`${out}/mpu/${encodeURIComponent(uploadId)}/complete?${k}`, { method: "POST", json: { parts } });
}
