import { Hono } from "hono";
import { z } from "zod";
import { type ZipEntry, uniqueNames, zipLayout } from "./zip";

/**
 * 批量下载：
 *   POST /api/downloads { ids }   → 把文件清单存进 KV（10 分钟），返回 { url, files, bytes, skipped }
 *   GET  /api/downloads/:token     → 流式 zip（Content-Length 已知，浏览器能显示进度）
 * 浏览器直接打开 GET 链接，由它自己的下载管理器接收，几 GB 的数据也不会进页面内存。
 * 只打包原始文件（原件、RAW、Live 视频）；还没处理完、没有 CRC32 的文件会被跳过。
 */

type Bindings = { Bindings: Env };
export const downloads = new Hono<Bindings>();

const TTL_SECONDS = 600;
const MAX_FILES = 3000;
const KEY = (token: string) => `dl:${token}`;

interface Manifest {
	name: string;
	files: (ZipEntry & { key: string })[];
}

downloads.post("/", async (c) => {
	const { ids } = z
		.object({ ids: z.array(z.string().regex(/^[0-9A-Z]{26}$/)).min(1).max(1000) })
		.parse(await c.req.json());

	const rows: {
		r2_key: string;
		original_name: string | null;
		size: number;
		crc32: number | null;
		role: string;
		taken_at: number | null;
		tz_offset_min: number | null;
		asset_id: string;
	}[] = [];
	for (let i = 0; i < ids.length; i += 90) {
		const chunk = ids.slice(i, i + 90);
		const { results } = await c.env.DB.prepare(
			`SELECT f.r2_key, f.original_name, f.size, f.crc32, f.role, a.taken_at, a.tz_offset_min, a.id AS asset_id
			 FROM asset_files f JOIN assets a ON a.id = f.asset_id
			 WHERE a.id IN (${chunk.map(() => "?").join(",")}) AND f.role IN ('original','raw','live_video')`,
		)
			.bind(...chunk)
			.all<(typeof rows)[number]>();
		rows.push(...results);
	}
	rows.sort((a, b) => (b.taken_at ?? 0) - (a.taken_at ?? 0) || a.asset_id.localeCompare(b.asset_id) || a.role.localeCompare(b.role));

	const ready = rows.filter((r) => r.crc32 !== null).slice(0, MAX_FILES);
	const names = uniqueNames(ready.map((r) => r.original_name ?? `${r.asset_id}-${r.role}`));
	const files = ready.map((r, i) => ({
		key: r.r2_key,
		name: names[i]!,
		size: r.size,
		crc32: r.crc32!,
		mtime: r.taken_at !== null ? r.taken_at + (r.tz_offset_min ?? 0) * 60_000 : Date.now(),
	}));
	if (!files.length) return c.json({ error: "nothing to download yet" }, 409);

	const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
	const token = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
	const manifest: Manifest = { name: `photos-${stamp}.zip`, files };
	await c.env.KV.put(KEY(token), JSON.stringify(manifest), { expirationTtl: TTL_SECONDS });

	return c.json({
		url: `/api/downloads/${token}`,
		files: files.length,
		bytes: files.reduce((n, f) => n + f.size, 0),
		skipped: rows.length - files.length,
	});
});

downloads.get("/:token", async (c) => {
	const token = c.req.param("token");
	if (!/^[0-9a-f]{48}$/.test(token)) return c.json({ error: "not found" }, 404);
	const manifest = await c.env.KV.get<Manifest>(KEY(token), "json");
	if (!manifest) return c.json({ error: "download link expired" }, 410);

	const { parts, totalSize } = zipLayout(manifest.files);
	const { readable, writable } = new FixedLengthStream(totalSize);

	const produce = async () => {
		try {
			for (const part of parts) {
				if (part.kind === "bytes") {
					const w = writable.getWriter();
					await w.write(part.data);
					w.releaseLock();
					continue;
				}
				const file = manifest.files[part.index]!;
				const object = await c.env.PHOTOS.get(file.key);
				if (!object || object.size !== file.size) throw new Error(`object missing or changed: ${part.index}`);
				await object.body.pipeTo(writable, { preventClose: true });
			}
			await writable.close();
		} catch (e) {
			console.error(JSON.stringify({ event: "download_failed", error: String(e) }));
			await writable.abort(e).catch(() => {});
		}
	};
	c.executionCtx.waitUntil(produce());

	return new Response(readable, {
		headers: {
			"Content-Type": "application/zip",
			"Content-Length": String(totalSize),
			"Content-Disposition": `attachment; filename="${manifest.name}"`,
			"Cache-Control": "private, no-store",
		},
	});
});
