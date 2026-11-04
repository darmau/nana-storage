import { Hono } from "hono";
import { z } from "zod";
import {
	INSTAGRAM_FETCH_TIMEOUT_MS,
	INSTAGRAM_FOLDER,
	INSTAGRAM_MAX_BYTES,
	INSTAGRAM_MAX_ITEMS,
	INSTAGRAM_MAX_PAGE_BYTES,
} from "@nana/shared";
import { ensureFolderPath } from "./folders";
import { guardStub } from "./guard";
import { enqueueJob, jobInsert } from "./jobs";
import { sniff } from "./sniff";
import { ulid } from "./ulid";
import { existingAsset } from "./uploads";

/**
 * 从 Instagram 导入一个公开帖子里的全部图片（视频跳过），存进根目录下的 Instagram 文件夹，
 * 文件名是“账户名-日期-编号”（jennie-20261103-01.jpg）。
 *
 *   POST /api/imports/instagram/resolve  { url, tzOffsetMin }  读帖子的嵌入页，返回文件夹、拍摄时间和每张图的文件名 + 地址
 *                                                             （导入过的带 existing，前端不再请求）
 *   POST /api/imports/instagram/item     { url, name, ... }    下载一张、写 R2、建 process 任务（和上传完成一样）
 *
 * 去重按每张图的 Instagram 媒体 ID（instagram_imports，迁移 0034）：CDN 每次给的字节不一定相同（重新编码），
 * sha256 对不上。sha256 去重照样做（同一张图先上传过的）。
 *
 * 分成每张一个请求：前端能显示进度，单个请求不会太久，失败的那张可以单独再导入。
 * 不登录：读的是嵌入页（/p/{code}/embed/captioned/），帖子的常规页面和接口不登录会被重定向到登录页。
 * 嵌入页里没有发布时间，用帖子 ID 换算（Instagram 的 ID 高位是毫秒时间戳）。
 *
 * 安全：Worker 只会请求 www.instagram.com 的嵌入页和 Instagram 的 CDN（*.cdninstagram.com / *.fbcdn.net，https），
 * 不跟随重定向，响应有大小上限。下载的字节和上传的一样按文件头判断类型，只收图片。日志只记条目 id。
 * 成本：见 shared 的 INSTAGRAM_* 常量，只由用户点击触发、不重试。
 */

type Bindings = { Bindings: Env };
export const instagram = new Hono<Bindings>();

const UA =
	"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

/** 帖子地址：instagram.com/p/{code}、/reel/{code}、/tv/{code}，以及带账户名的 /{user}/p/{code}。返回 shortcode。 */
export function parsePostUrl(raw: string): string | null {
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		return null;
	}
	if (url.protocol !== "https:" || !/^(?:www\.|m\.)?instagram\.com$/i.test(url.hostname)) return null;
	const m = /^\/(?:[\w.]{1,30}\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]{5,64})\/?$/.exec(url.pathname);
	return m ? m[1]! : null;
}

/** 只允许从 Instagram 的 CDN 下载。 */
export function isCdnUrl(raw: string): boolean {
	try {
		const url = new URL(raw);
		return (
			url.protocol === "https:" &&
			!url.port &&
			!url.username &&
			/^(?:[a-z0-9-]+\.)+(?:cdninstagram\.com|fbcdn\.net)$/i.test(url.hostname)
		);
	} catch {
		return false;
	}
}

/** Instagram 的媒体 ID：高位（右移 23 位）是从 2011-08-24 起的毫秒数。换算不出合理时间时返回 null。 */
export function postTime(mediaId: string): number | null {
	if (!/^\d{1,25}$/.test(mediaId)) return null;
	const ms = Number((BigInt(mediaId) >> 23n) + 1314220021721n);
	// 2011-08 之前的帖子是旧格式的顺序 ID，换算不出时间
	return ms > Date.UTC(2011, 7, 25) && ms < Date.now() + 86400_000 ? ms : null;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** “账户名-日期-编号”，日期按浏览器的时区（YYYYMMDD），编号从 01 开始。扩展名由下载后的文件头决定。 */
export function baseName(username: string, takenAt: number, tzOffsetMin: number, index: number): string {
	const d = new Date(takenAt + tzOffsetMin * 60_000);
	const day = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
	return `${username}-${day}-${pad(index)}`;
}

export interface PostImages {
	username: string;
	mediaId: string;
	/** 图片的媒体 ID 和原图地址（每张取最大的 display_url），按帖子里的顺序；视频不在里面。 */
	images: { id: string; src: string }[];
	videos: number;
}

/**
 * 从嵌入页里取出帖子数据：页面脚本里有一段 "contextJSON":"<转义过的 JSON 字符串>"，
 * 里面的 gql_data.shortcode_media 是帖子本身（多图帖是 GraphSidecar，图片在 edge_sidecar_to_children 里）。
 * 找不到（页面改版、帖子不公开、被删）就返回 null。
 */
export function parseEmbed(html: string, shortcode: string): PostImages | null {
	const key = html.indexOf('"contextJSON"');
	if (key < 0) return null;
	const start = html.indexOf('"', html.indexOf(":", key) + 1);
	if (start < 0) return null;
	// JSON 字符串字面量：找到第一个没有被转义的引号
	let end = start + 1;
	while (end < html.length && html[end] !== '"') end += html[end] === "\\" ? 2 : 1;
	if (end >= html.length) return null;
	let media: any;
	try {
		const ctx = JSON.parse(JSON.parse(html.slice(start, end + 1)) as string);
		media = ctx?.gql_data?.shortcode_media;
	} catch {
		return null;
	}
	if (!media || media.shortcode !== shortcode || typeof media.id !== "string") return null;
	const username = String(media.owner?.username ?? "");
	if (!/^[A-Za-z0-9._]{1,30}$/.test(username)) return null;

	const nodes: any[] = media.edge_sidecar_to_children?.edges?.map((e: any) => e?.node) ?? [media];
	const images: { id: string; src: string }[] = [];
	let videos = 0;
	for (const node of nodes) {
		if (!node) continue;
		if (node.is_video) {
			videos++;
			continue;
		}
		const resources: { src?: unknown; config_width?: unknown }[] = Array.isArray(node.display_resources) ? node.display_resources : [];
		const largest = resources
			.filter((r) => typeof r.src === "string")
			.sort((a, b) => Number(b.config_width ?? 0) - Number(a.config_width ?? 0))[0]?.src as string | undefined;
		const src = typeof node.display_url === "string" ? node.display_url : largest;
		const id = String(node.id ?? "");
		if (src && isCdnUrl(src) && /^\d{1,25}$/.test(id) && !images.some((i) => i.id === id)) images.push({ id, src });
	}
	return { username, mediaId: media.id, images: images.slice(0, INSTAGRAM_MAX_ITEMS), videos };
}

/** 读响应体，超过 max 字节就放弃（不信任 Content-Length）。 */
async function readCapped(res: Response, max: number): Promise<Uint8Array | null> {
	const declared = Number(res.headers.get("content-length"));
	if (declared > max) {
		await res.body?.cancel();
		return null;
	}
	if (!res.body) return new Uint8Array();
	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > max) {
			await reader.cancel();
			return null;
		}
		chunks.push(value);
	}
	const out = new Uint8Array(total);
	let at = 0;
	for (const c of chunks) {
		out.set(c, at);
		at += c.byteLength;
	}
	return out;
}

const outbound = (url: string, accept: string) =>
	fetch(url, {
		headers: { "User-Agent": UA, Accept: accept, "Accept-Language": "en-US,en;q=0.9" },
		// 不跟随重定向：要求登录时 Instagram 会重定向到登录页；CDN 地址也不应该被引到别处
		redirect: "manual",
		signal: AbortSignal.timeout(INSTAGRAM_FETCH_TIMEOUT_MS),
	});

const ResolveBody = z.object({
	url: z.string().max(2048),
	tzOffsetMin: z.number().int().min(-14 * 60).max(14 * 60),
});

instagram.post("/resolve", async (c) => {
	const { url, tzOffsetMin } = ResolveBody.parse(await c.req.json());
	const shortcode = parsePostUrl(url);
	if (!shortcode) return c.json({ error: "bad instagram url" }, 400);

	let html: string;
	try {
		const res = await outbound(`https://www.instagram.com/p/${shortcode}/embed/captioned/`, "text/html");
		if (res.status !== 200) {
			await res.body?.cancel();
			return c.json({ error: "instagram unavailable" }, 502);
		}
		const bytes = await readCapped(res, INSTAGRAM_MAX_PAGE_BYTES);
		if (!bytes) return c.json({ error: "instagram unavailable" }, 502);
		html = new TextDecoder().decode(bytes);
	} catch {
		return c.json({ error: "instagram unavailable" }, 502);
	}

	const post = parseEmbed(html, shortcode);
	// 不公开、已删除，或者嵌入页改版了
	if (!post) return c.json({ error: "instagram post not public" }, 422);
	if (!post.images.length) return c.json({ error: "instagram no images", videos: post.videos }, 422);

	const takenAt = postTime(post.mediaId) ?? Date.now();
	const folderId = await ensureFolderPath(c.env, null, INSTAGRAM_FOLDER);
	const ids = post.images.map((i) => i.id);
	const { results } = await c.env.DB.prepare(
		`SELECT media_id, asset_id FROM instagram_imports WHERE media_id IN (${ids.map(() => "?").join(",")})`,
	)
		.bind(...ids)
		.all<{ media_id: string; asset_id: string }>();
	const existing = new Map(results.map((r) => [r.media_id, r.asset_id]));
	return c.json({
		folderId,
		takenAt,
		videos: post.videos,
		items: post.images.map((img, i) => ({
			mediaId: img.id,
			url: img.src,
			name: baseName(post.username, takenAt, tzOffsetMin, i + 1),
			existing: existing.get(img.id) ?? null,
		})),
	});
});

const EXT: Record<string, string> = {
	"image/jpeg": "jpg",
	"image/png": "png",
	"image/webp": "webp",
	"image/heic": "heic",
	"image/heif": "heif",
	"image/avif": "avif",
	"image/gif": "gif",
};

const ItemBody = z.object({
	mediaId: z.string().regex(/^\d{1,25}$/),
	url: z.string().max(4096).refine(isCdnUrl),
	name: z.string().regex(/^[A-Za-z0-9._]{1,30}-\d{8}-\d{2}$/),
	folderId: z.string().max(64),
	takenAt: z.number().int().nonnegative(),
	tzOffsetMin: z.number().int().min(-14 * 60).max(14 * 60),
});

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

instagram.post("/item", async (c) => {
	const body = ItemBody.parse(await c.req.json());
	const env = c.env;
	if (!(await env.DB.prepare("SELECT 1 FROM folders WHERE id = ?").bind(body.folderId).first()))
		return c.json({ error: "folder not found" }, 404);

	const imported = await env.DB.prepare("SELECT asset_id FROM instagram_imports WHERE media_id = ?")
		.bind(body.mediaId)
		.first<{ asset_id: string }>();
	if (imported) return c.json({ status: "duplicate", assetId: imported.asset_id });

	let data: Uint8Array | null;
	try {
		const res = await outbound(body.url, "image/*");
		if (res.status !== 200) {
			await res.body?.cancel();
			return c.json({ error: "instagram unavailable" }, 502);
		}
		data = await readCapped(res, INSTAGRAM_MAX_BYTES);
	} catch {
		return c.json({ error: "instagram unavailable" }, 502);
	}
	if (!data) return c.json({ error: "file too large" }, 413);
	const type = sniff(data.subarray(0, 64));
	if (!type || type.category !== "image") return c.json({ error: "unsupported or mismatched file type" }, 415);

	const sha256 = hex(await crypto.subtle.digest("SHA-256", data));
	const { found } = await existingAsset(env, [sha256]);
	const dup = found.get(sha256);
	if (dup) {
		// 同一张图已经在资料库里（上传过，或者之前导入时还没有这张表）：记下媒体 ID，下次不用再下载
		await env.DB.prepare("INSERT OR IGNORE INTO instagram_imports (media_id, asset_id, created_at) VALUES (?, ?, ?)")
			.bind(body.mediaId, dup, Date.now())
			.run();
		return c.json({ status: "duplicate", assetId: dup });
	}

	if (!(await guardStub(env).reserveUpload(data.byteLength))) return c.json({ error: "guard tripped" }, 503);

	const now = Date.now();
	const assetId = ulid(now);
	const fileId = ulid();
	const key = `o/${assetId}/${fileId}`;
	const name = `${body.name}.${EXT[type.mime] ?? "jpg"}`;
	// R2 按 sha256 校验写入的字节；之后的 process 任务照常再核对一次。
	await env.PHOTOS.put(key, data, { sha256, httpMetadata: { contentType: "application/octet-stream" } });

	// 条目、文件、任务在同一个 batch 里落地（和上传完成一样）。帖子的发布时间作为“文件修改时间”：
	// Instagram 去掉了 EXIF，没有拍摄时间时 process 任务用它，照片按发布日期出现在时间线里。
	const job = jobInsert(env.DB, assetId, "process");
	try {
		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO assets (id, kind, status, folder_id, client_mtime, tz_offset_min, created_at, updated_at)
				 VALUES (?, 'photo', 'pending', ?, ?, ?, ?, ?)`,
			).bind(assetId, body.folderId, body.takenAt, body.tzOffsetMin, now, now),
			env.DB.prepare(
				`INSERT INTO asset_files (id, asset_id, role, r2_key, mime, size, sha256, original_name, created_at)
				 VALUES (?, ?, 'original', ?, ?, ?, ?, ?, ?)`,
			).bind(fileId, assetId, key, type.mime, data.byteLength, sha256, name, now),
			env.DB.prepare("INSERT INTO instagram_imports (media_id, asset_id, created_at) VALUES (?, ?, ?)").bind(body.mediaId, assetId, now),
			job.stmt,
		]);
	} catch (e) {
		await env.PHOTOS.delete(key);
		// 唯一索引冲突：同一张图正在被并发导入 / 上传（sha256 或媒体 ID）
		if (String(e).includes("UNIQUE")) return c.json({ status: "duplicate", assetId: null });
		throw e;
	}
	try {
		await enqueueJob(env, job.id);
	} catch (e) {
		// 和上传完成一样：任务已经在 D1 里，“重新排队”可以补发
		console.error(JSON.stringify({ event: "enqueue_failed", jobId: job.id, error: String(e).slice(0, 500) }));
	}
	console.log(JSON.stringify({ event: "instagram_imported", assetId }));
	return c.json({ status: "imported", assetId });
});
