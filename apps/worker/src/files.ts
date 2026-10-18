import { Hono } from "hono";
import { DERIVED_FILES, derivedKey } from "./derived";

/**
 * GET /api/a/:id/:role[?v=rev][&download=1]
 * 从 R2 流式读出文件，支持 Range（视频拖动）。
 *  - 只用 private 缓存（浏览器本地），从不进入 CDN / Cache API。
 *  - 派生文件只有在 URL 带了当前版本号 v 时才标记为 immutable，旋转后不会拿到旧图。
 *  - 原件默认作为附件下载；类型来自上传时的文件头检测，永远不会是 HTML/SVG。
 *  - 带版本号的派生文件（时间线缩略图、查看器预览，绝大多数请求）先按 derivedKey 直接读 R2，不查 D1：
 *    这个 key 只会由处理这个版本的任务写入，所以读到的一定是这个版本的图，可以 immutable。
 *    读不到（新版本还没生成、旧数据）再走下面查 D1 的路径。key 只由校验过的 id、固定的 role 和整数版本号拼成，
 *    只可能落在 d/ 下面，读不到原件。
 *  - 编辑底图（role = base，裁切或打码过的照片才有）不记在 asset_files 里，只能按版本号读到（走上面的直接读 R2）。
 *  - 人脸头像拼图（role = faces，src/people.ts）只能带版本号读：key 是 d/{id}/faces-{v}.webp，生成之后不会再变。
 */

type Bindings = { Bindings: Env };
export const files = new Hono<Bindings>();

const ROLES = new Set(["thumb", "preview", "video_preview", "base", "original", "raw", "live_video"]);
const DERIVED = new Set(["thumb", "preview", "video_preview", "base"]);
const INLINE_SAFE = /^(image\/(jpeg|png|webp|gif|avif|heic|heif)|video\/(mp4|quicktime))$/;
const ID_RE = /^[0-9A-Za-z]{1,64}$/;
const REV_RE = /^\d{1,9}$/;
const IMMUTABLE = "private, max-age=31536000, immutable";

files.get("/:id/:role", async (c) => {
	const { id, role } = c.req.param();
	if (role === "faces") {
		const v = c.req.query("v");
		if (!v || !REV_RE.test(v) || !ID_RE.test(id)) return c.json({ error: "not found" }, 404);
		const object = await c.env.PHOTOS.get(derivedKey(id, "faces", Number(v), "webp"), { onlyIf: c.req.raw.headers });
		if (!object) return c.json({ error: "not found" }, 404);
		return respond(c.req.raw, object, "image/webp", IMMUTABLE, null);
	}
	if (!ROLES.has(role)) return c.json({ error: "not found" }, 404);

	const v = c.req.query("v");
	const type = DERIVED_FILES[role as keyof typeof DERIVED_FILES];
	if (type && v && REV_RE.test(v) && ID_RE.test(id) && c.req.query("download") !== "1") {
		const key = derivedKey(id, role, Number(v), type.ext);
		const object = await c.env.PHOTOS.get(key, { range: c.req.raw.headers, onlyIf: c.req.raw.headers });
		if (object) return respond(c.req.raw, object, type.mime, IMMUTABLE, null);
	}

	const row = await c.env.DB.prepare(
		`SELECT f.r2_key, f.mime, f.original_name, a.derived_rev
		 FROM asset_files f JOIN assets a ON a.id = f.asset_id
		 WHERE f.asset_id = ? AND f.role = ? ORDER BY f.created_at DESC LIMIT 1`,
	)
		.bind(id, role)
		.first<{ r2_key: string; mime: string; original_name: string | null; derived_rev: number }>();
	if (!row) return c.json({ error: "not found" }, 404);

	const object = await c.env.PHOTOS.get(row.r2_key, { range: c.req.raw.headers, onlyIf: c.req.raw.headers });
	if (!object) return c.json({ error: "not found" }, 404);

	// 只有返回的文件确实属于这个版本时才能永久缓存：旋转后新图生成之前，带新版本号的 URL 拿到的还是旧图
	const versioned = DERIVED.has(role) && v === String(row.derived_rev) && row.r2_key.includes(`-${row.derived_rev}.`);
	const download = c.req.query("download") === "1" || !INLINE_SAFE.test(row.mime);
	let disposition: string | null = null;
	if (!DERIVED.has(role) || download) {
		const name = (row.original_name ?? `${id}-${role}`).replace(/[\r\n"]/g, "_");
		disposition = `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(name)}`;
	}
	return respond(c.req.raw, object, row.mime, versioned ? IMMUTABLE : "private, max-age=0, must-revalidate", disposition);
});

function respond(
	request: Request,
	object: R2Object | R2ObjectBody,
	mime: string,
	cacheControl: string,
	disposition: string | null,
): Response {
	const headers = new Headers();
	object.writeHttpMetadata(headers);
	headers.set("Content-Type", mime);
	headers.set("ETag", object.httpEtag);
	headers.set("Accept-Ranges", "bytes");
	headers.set("X-Content-Type-Options", "nosniff");
	headers.set("Cache-Control", cacheControl);
	if (disposition) headers.set("Content-Disposition", disposition);

	if (!("body" in object)) return new Response(null, { status: 304, headers });

	const range = object.range as { offset?: number; length?: number } | undefined;
	if (range && request.headers.get("range")) {
		const offset = range.offset ?? 0;
		const length = range.length ?? object.size - offset;
		headers.set("Content-Range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
		headers.set("Content-Length", String(length));
		return new Response(object.body, { status: 206, headers });
	}
	headers.set("Content-Length", String(object.size));
	return new Response(object.body, { status: 200, headers });
}
