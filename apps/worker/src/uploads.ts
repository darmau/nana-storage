import { Hono } from "hono";
import { z } from "zod";
import { UPLOAD_PART_BYTES } from "@nana/shared";
import { ensureFolderPath } from "./folders";
import { guardStub } from "./guard";
import { enqueueJob, jobInsert } from "./jobs";
import { deleteAssetsPermanently } from "./purge";
import { sniff, type Category } from "./sniff";
import { ulid } from "./ulid";

/**
 * 分块上传：
 *   POST   /api/uploads/check           批量查询哪些 sha256 已经存在（去重）
 *   POST   /api/uploads                 创建条目和每个文件的 R2 multipart upload
 *   PUT    /api/uploads/:id/parts/:n    上传一块（第 1 块会校验文件头）
 *   POST   /api/uploads/:id/complete    完成；条目的所有文件都完成后入队处理
 *   DELETE /api/uploads/:id             取消
 * 所有字节都经过 Worker 写入 R2，不发预签名 URL。
 */

type Bindings = { Bindings: Env };
export const uploads = new Hono<Bindings>();

const MAX_FILE_BYTES = 50 * 1024 ** 3;
const SHA = z.string().regex(/^[0-9a-f]{64}$/);

const FileSpec = z.object({
	role: z.enum(["original", "raw", "live_video"]),
	name: z.string().min(1).max(255),
	size: z.number().int().positive().max(MAX_FILE_BYTES),
	sha256: SHA,
});

const CreateBody = z
	.object({
		kind: z.enum(["photo", "video", "live"]),
		folderId: z.string().max(64).nullable().optional(),
		folderPath: z.string().max(4096).optional(),
		clientMtime: z.number().int().nonnegative().nullable().optional(),
		clientTzOffsetMin: z.number().int().min(-14 * 60).max(14 * 60).nullable().optional(),
		files: z.array(FileSpec).min(1).max(3),
	})
	.superRefine((b, ctx) => {
		const roles = b.files.map((f) => f.role).sort().join(",");
		const allowed: Record<string, string[]> = {
			photo: ["original", "raw", "original,raw"],
			video: ["original"],
			live: ["live_video,original", "live_video,original,raw"],
		};
		if (!allowed[b.kind]!.includes(roles)) ctx.addIssue({ code: "custom", message: `bad roles for ${b.kind}: ${roles}` });
		if (new Set(b.files.map((f) => f.sha256)).size !== b.files.length)
			ctx.addIssue({ code: "custom", message: "duplicate file in one asset" });
	});

/** 每个角色允许的文件类别。 */
const ROLE_CATEGORY: Record<string, Record<string, Category[]>> = {
	photo: { original: ["image"], raw: ["raw"] },
	video: { original: ["video"] },
	live: { original: ["image"], raw: ["raw"], live_video: ["video"] },
};

interface UploadRow {
	id: string;
	asset_id: string;
	file_id: string;
	role: string;
	r2_key: string;
	r2_upload_id: string;
	mime: string;
	size: number;
	sha256: string;
	original_name: string | null;
}

const partCount = (size: number) => Math.ceil(size / UPLOAD_PART_BYTES);
const expectedPartSize = (size: number, n: number) =>
	n < partCount(size) ? UPLOAD_PART_BYTES : size - (partCount(size) - 1) * UPLOAD_PART_BYTES;

/** 开始上传超过这个时间还没传完，认为上传中断了（文件夹页面据此提示，重新上传时据此替换）。 */
export const UPLOAD_ABANDONED_MS = 3600_000;

/**
 * 已经存在的文件：sha256 → 条目 id。压缩过的原图按压缩前的 sha256（source_sha256）也算存在，
 * 重新上传同一个原始文件不会多出一份。
 * 上传中断的条目（比如 Live Photo 的图片传完了、视频没传完）单独列出：它们不算重复，
 * 否则重新上传同一组文件时会被当成重复跳过，中断的条目永远补不上。
 */
async function existingAsset(env: Env, hashes: string[]): Promise<{ found: Map<string, string>; abandoned: Set<string> }> {
	const found = new Map<string, string>();
	const abandoned = new Set<string>();
	for (let i = 0; i < hashes.length; i += 90) {
		const chunk = hashes.slice(i, i + 90);
		const marks = chunk.map(() => "?").join(",");
		const cutoff = Date.now() - UPLOAD_ABANDONED_MS;
		type Row = { sha256: string; asset_id: string; abandoned: number };
		const [current, source] = await env.DB.batch<Row>([
			env.DB.prepare(
				`SELECT f.sha256, f.asset_id, (a.status = 'uploading' AND a.updated_at < ?) AS abandoned
				 FROM asset_files f JOIN assets a ON a.id = f.asset_id
				 WHERE f.role IN ('original','raw','live_video') AND f.sha256 IN (${marks})`,
			).bind(cutoff, ...chunk),
			// 压缩过的条目一定是处理完的，不会是中断的上传
			env.DB.prepare(`SELECT source_sha256 AS sha256, asset_id, 0 AS abandoned FROM asset_files WHERE source_sha256 IN (${marks})`).bind(...chunk),
		]);
		for (const r of [...current!.results, ...source!.results]) {
			if (r.abandoned) abandoned.add(r.asset_id);
			else found.set(r.sha256, r.asset_id);
		}
	}
	return { found, abandoned };
}

/** 删除上传中断的条目：取消还没完成的分块上传，再删掉已经传完的文件和条目本身。 */
async function removeAbandoned(env: Env, assetId: string) {
	const { results } = await env.DB.prepare("SELECT * FROM uploads WHERE asset_id = ?").bind(assetId).all<UploadRow>();
	for (const up of results) await env.PHOTOS.resumeMultipartUpload(up.r2_key, up.r2_upload_id).abort().catch(() => {});
	await deleteAssetsPermanently(env, [assetId]);
}

uploads.post("/check", async (c) => {
	const { hashes } = z.object({ hashes: z.array(SHA).max(1000) }).parse(await c.req.json());
	const { found } = await existingAsset(c.env, hashes);
	return c.json({ existing: Object.fromEntries(found) });
});

uploads.post("/", async (c) => {
	const body = CreateBody.parse(await c.req.json());
	const env = c.env;

	const dup = await existingAsset(env, body.files.map((f) => f.sha256));
	if (dup.found.size) return c.json({ error: "duplicate", existingAssetId: [...dup.found.values()][0] }, 409);

	const total = body.files.reduce((a, f) => a + f.size, 0);
	if (!(await guardStub(env).reserveUpload(total))) {
		return c.json({ error: "guard tripped" }, 503);
	}

	// 重新上传了中断的条目里的文件：用新的条目替换它（每组文件最多 3 个，所以最多删 3 个条目）
	for (const assetId of dup.abandoned) {
		await removeAbandoned(env, assetId);
		console.log(JSON.stringify({ event: "abandoned_upload_replaced", assetId }));
	}

	let folderId = body.folderId ?? null;
	if (folderId) {
		const ok = await env.DB.prepare("SELECT 1 FROM folders WHERE id = ?").bind(folderId).first();
		if (!ok) return c.json({ error: "folder not found" }, 404);
	}
	if (body.folderPath) folderId = await ensureFolderPath(env, folderId, body.folderPath);

	const now = Date.now();
	const assetId = ulid(now);
	// 先建好所有 multipart upload，再在一个 batch 里写条目和上传记录：中途出错（前端会重试）不会留下没有文件的空条目。
	const rows: { f: z.infer<typeof FileSpec>; fileId: string; key: string; mpu: R2MultipartUpload; uploadId: string }[] = [];
	try {
		for (const f of body.files) {
			const fileId = ulid();
			const key = `o/${assetId}/${fileId}`;
			const mpu = await env.PHOTOS.createMultipartUpload(key, {
				httpMetadata: { contentType: "application/octet-stream" },
			});
			rows.push({ f, fileId, key, mpu, uploadId: ulid() });
		}
		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO assets (id, kind, status, folder_id, client_mtime, tz_offset_min, created_at, updated_at)
				 VALUES (?, ?, 'uploading', ?, ?, ?, ?, ?)`,
			).bind(assetId, body.kind, folderId, body.clientMtime ?? null, body.clientTzOffsetMin ?? null, now, now),
			...rows.map(({ f, fileId, key, mpu, uploadId }) =>
				env.DB.prepare(
					`INSERT INTO uploads (id, asset_id, file_id, role, r2_key, r2_upload_id, mime, size, sha256, original_name, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, 'application/octet-stream', ?, ?, ?, ?)`,
				).bind(uploadId, assetId, fileId, f.role, key, mpu.uploadId, f.size, f.sha256, f.name.normalize("NFC"), now),
			),
		]);
	} catch (e) {
		await Promise.all(rows.map((r) => r.mpu.abort().catch(() => {})));
		throw e;
	}
	const created = rows.map(({ f, uploadId }) => ({ uploadId, role: f.role, parts: partCount(f.size) }));
	return c.json({ assetId, partSize: UPLOAD_PART_BYTES, uploads: created }, 201);
});

async function loadUpload(env: Env, id: string) {
	return env.DB.prepare("SELECT * FROM uploads WHERE id = ?").bind(id).first<UploadRow>();
}

uploads.put("/:id/parts/:n", async (c) => {
	const env = c.env;
	const up = await loadUpload(env, c.req.param("id"));
	if (!up) return c.json({ error: "upload not found" }, 404);
	const n = Number(c.req.param("n"));
	if (!Number.isInteger(n) || n < 1 || n > partCount(up.size)) return c.json({ error: "bad part number" }, 400);

	const expected = expectedPartSize(up.size, n);
	const declared = Number(c.req.header("content-length"));
	if (declared !== expected) return c.json({ error: `part ${n} must be ${expected} bytes` }, 400);
	const data = new Uint8Array(await c.req.arrayBuffer());
	if (data.byteLength !== expected) return c.json({ error: "size mismatch" }, 400);

	if (n === 1) {
		const kind = (await env.DB.prepare("SELECT kind FROM assets WHERE id = ?").bind(up.asset_id).first<{ kind: string }>())
			?.kind;
		const detected = sniff(data.subarray(0, 64), up.original_name ?? "");
		const allowed = kind ? ROLE_CATEGORY[kind]?.[up.role] : undefined;
		if (!detected || !allowed?.includes(detected.category)) {
			await abortUpload(env, up);
			return c.json({ error: "unsupported or mismatched file type" }, 415);
		}
		await env.DB.prepare("UPDATE uploads SET mime = ? WHERE id = ?").bind(detected.mime, up.id).run();
	}

	const mpu = env.PHOTOS.resumeMultipartUpload(up.r2_key, up.r2_upload_id);
	const part = await mpu.uploadPart(n, data);
	return c.json({ partNumber: part.partNumber, etag: part.etag });
});

uploads.post("/:id/complete", async (c) => {
	const env = c.env;
	const up = await loadUpload(env, c.req.param("id"));
	if (!up) return c.json({ error: "upload not found" }, 404);
	if (up.mime === "application/octet-stream") return c.json({ error: "first part missing" }, 400);
	const { parts } = z
		.object({ parts: z.array(z.object({ partNumber: z.number().int().positive(), etag: z.string().max(256) })).max(10_000) })
		.parse(await c.req.json());
	if (parts.length !== partCount(up.size)) return c.json({ error: "missing parts" }, 400);

	const mpu = env.PHOTOS.resumeMultipartUpload(up.r2_key, up.r2_upload_id);
	const object = await mpu.complete(parts.sort((a, b) => a.partNumber - b.partNumber)).catch(async (e) => {
		// 上一次 complete 已经合并好了对象、但后面写 D1 出错：前端重试时直接沿用已经存在的对象。
		const head = await env.PHOTOS.head(up.r2_key);
		if (head) return head;
		throw e;
	});
	if (object.size !== up.size) {
		await env.PHOTOS.delete(up.r2_key);
		await abortUpload(env, up);
		return c.json({ error: "size mismatch" }, 400);
	}

	// 一个事务里完成：记下文件、删掉上传记录；这是条目的最后一个文件时，条目改成 pending 并建好 process 任务。
	// 分几步写的话，中途出错会把条目永远留在 uploading（或者 pending 却没有任务），前端重试也只能拿到 404。
	// 同一条目的几个文件并发完成时，事务是串行的，只有最后一个会看到“没有剩下的上传”。
	const now = Date.now();
	const job = jobInsert(env.DB, up.asset_id, "process", {
		sql: `EXISTS (SELECT 1 FROM assets WHERE id = ? AND status = 'pending')
			AND NOT EXISTS (SELECT 1 FROM jobs WHERE asset_id = ? AND kind = 'process' AND status IN ('pending','running'))`,
		params: [up.asset_id, up.asset_id],
	});
	let results: D1Result[];
	try {
		results = await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO asset_files (id, asset_id, role, r2_key, mime, size, sha256, original_name, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).bind(up.file_id, up.asset_id, up.role, up.r2_key, up.mime, up.size, up.sha256, up.original_name, now),
			env.DB.prepare("DELETE FROM uploads WHERE id = ?").bind(up.id),
			env.DB.prepare(
				`UPDATE assets SET status = 'pending', updated_at = ? WHERE id = ? AND status = 'uploading'
				 AND NOT EXISTS (SELECT 1 FROM uploads WHERE asset_id = ?) RETURNING id`,
			).bind(now, up.asset_id, up.asset_id),
			job.stmt,
		]);
	} catch (e) {
		// 唯一索引冲突：并发上传了同一个文件。
		if (String(e).includes("UNIQUE")) {
			await env.PHOTOS.delete(up.r2_key);
			await abortUpload(env, up);
			return c.json({ error: "duplicate" }, 409);
		}
		throw e;
	}

	if (!results[2]!.results.length) return c.json({ assetId: up.asset_id, status: "uploading" });
	if (!results[3]!.results.length) return c.json({ assetId: up.asset_id, status: "pending" });
	try {
		await enqueueJob(env, job.id);
	} catch (e) {
		// 文件已经安全落地，任务也在 D1 里（处理页能看到，“重新排队”可以补发），不让前端把这个文件当成失败。
		console.error(JSON.stringify({ event: "enqueue_failed", jobId: job.id, error: String(e).slice(0, 500) }));
	}
	return c.json({ assetId: up.asset_id, status: "pending" });
});

uploads.delete("/:id", async (c) => {
	const up = await loadUpload(c.env, c.req.param("id"));
	if (!up) return c.json({ ok: true });
	await abortUpload(c.env, up);
	return c.json({ ok: true });
});

/** 取消一个文件的上传；如果条目已经没有任何文件和上传，连条目一起删掉。 */
export async function abortUpload(env: Env, up: UploadRow) {
	await env.PHOTOS.resumeMultipartUpload(up.r2_key, up.r2_upload_id).abort().catch(() => {});
	await env.DB.prepare("DELETE FROM uploads WHERE id = ?").bind(up.id).run();
	await env.DB.prepare(
		`DELETE FROM assets WHERE id = ? AND status = 'uploading'
		 AND NOT EXISTS (SELECT 1 FROM uploads WHERE asset_id = ?)
		 AND NOT EXISTS (SELECT 1 FROM asset_files WHERE asset_id = ?)`,
	)
		.bind(up.asset_id, up.asset_id, up.asset_id)
		.run();
}

/** Cron：清理超过 24 小时没完成的上传（每次最多 200 个）。 */
export async function cleanupStaleUploads(env: Env) {
	const { results } = await env.DB.prepare("SELECT * FROM uploads WHERE created_at < ? LIMIT 200")
		.bind(Date.now() - 24 * 3600_000)
		.all<UploadRow>();
	for (const up of results) await abortUpload(env, up);
	// 只剩部分文件、永远不会完成的条目：把已上传的文件也删掉
	const { results: orphans } = await env.DB.prepare(
		`SELECT id FROM assets WHERE status = 'uploading' AND updated_at < ?
		 AND NOT EXISTS (SELECT 1 FROM uploads WHERE asset_id = assets.id) LIMIT 200`,
	)
		.bind(Date.now() - 24 * 3600_000)
		.all<{ id: string }>();
	for (const { id } of orphans) {
		const { results: files } = await env.DB.prepare("SELECT r2_key FROM asset_files WHERE asset_id = ?")
			.bind(id)
			.all<{ r2_key: string }>();
		if (files.length) await env.PHOTOS.delete(files.map((f) => f.r2_key));
		await env.DB.prepare("DELETE FROM assets WHERE id = ?").bind(id).run();
	}
}
