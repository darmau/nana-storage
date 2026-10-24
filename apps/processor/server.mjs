import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { compressTask, deriveTask, metaTask, parseCrop, saveInput, transcodeTask } from "./lib.mjs";

/**
 * 容器的 HTTP 外壳。处理代码在 lib.mjs（设备端处理共用），任务（都是 POST，请求体是原始文件）：
 *   /tasks/meta       → JSON { meta, sha256, size, crc32 }
 *   /tasks/derive     → JSON { meta, sha256, size, crc32, width, height, thumb, preview, base, fp, faces }（图片为 base64 webp）
 *                       x-kind：image | raw | video；x-rotation：0 / 90 / 180 / 270。
 *                       x-crop："x,y,w,h"（0–1，相对于旋转之后的整张图）：缩略图和预览裁切，另外返回未裁切的底图 base；
 *                       不裁切时 base 为 null。
 *                       x-preview-edge：预览长边（默认 3840，“加载原图”时是原图尺寸，最大 16383）。
 *                       x-preview-transport: stream 时预览不放进 JSON（全尺寸预览有十几 MB，base64 进 JSON 太占 Worker 内存）：
 *                       响应体是 JSON 加紧跟着的预览字节，x-json-length 是 JSON 的字节数。
 *                       x-fingerprint: skip 时指纹和人脸都不算（旋转只重做缩略图）。算失败时 fp / faces 为 null，不影响其他结果。
 *                       x-mask：打码的笔画（mask.mjs，最多约 11 KB）：缩略图和预览上盖住的地方变成毛玻璃，同样返回底图 base；
 *                       响应的 mask 原样带回。
 *   /tasks/transcode  → video/mp4（带 Content-Length）
 *   /tasks/compress   → JSON { sha256, size, crc32, skipped, out } + 紧跟着的压缩后的 JPEG（x-json-length 是 JSON 的字节数；
 *                       不压缩时只有 JSON）。x-quality、x-min-saving、x-max-bytes、x-max-diff、x-max-pixels（0 不缩小）见 shared 的 COMPRESS_*。
 *
 * 临时文件在请求结束时删除。同一时间只处理一个任务，避免多个 ffmpeg 抢内存（容器只有 1 vCPU）。
 */

const PREVIEW_EDGE = 3840;

async function receive(req, dir) {
	const path = join(dir, "input");
	return { path, ...(await saveInput(req, path)) };
}

const tasks = {
	async meta(req, res, dir) {
		json(res, await metaTask(await receive(req, dir)));
	},

	async derive(req, res, dir) {
		const kind = req.headers["x-kind"];
		const rotation = Number(req.headers["x-rotation"] || 0);
		const mode = req.headers["x-fingerprint"] === "skip" ? "skip" : "full";
		const previewEdge = req.headers["x-preview-edge"] ? Number(req.headers["x-preview-edge"]) : PREVIEW_EDGE;
		const crop = parseCrop(req.headers["x-crop"]);
		const mask = req.headers["x-mask"] || null;
		const { body, thumbPath, previewPath, basePath } = await deriveTask(await receive(req, dir), dir, {
			kind,
			rotation,
			mode,
			previewEdge,
			crop,
			mask,
		});
		const thumb = (await readFile(thumbPath)).toString("base64");
		// 底图长边最多 2048，放进 JSON 也不大
		const base = basePath ? (await readFile(basePath)).toString("base64") : null;
		if (req.headers["x-preview-transport"] !== "stream") {
			json(res, { ...body, thumb, base, preview: (await readFile(previewPath)).toString("base64") });
			return;
		}
		const head = Buffer.from(JSON.stringify({ ...body, thumb, base }));
		const { size } = await stat(previewPath);
		res.writeHead(200, {
			"content-type": "application/octet-stream",
			"content-length": String(head.length + size),
			"x-json-length": String(head.length),
		});
		res.write(head);
		await pipeline(createReadStream(previewPath), res);
	},

	async transcode(req, res, dir) {
		const timeoutMs = Math.min(Number(req.headers["x-timeout-ms"]) || 600_000, 14 * 60_000);
		const out = await transcodeTask(await receive(req, dir), dir, { timeoutMs });
		const { size } = await stat(out);
		res.writeHead(200, { "content-type": "video/mp4", "content-length": String(size) });
		await pipeline(createReadStream(out), res);
	},

	async compress(req, res, dir) {
		const num = (name) => Number(req.headers[name]);
		const { body, outPath } = await compressTask(await receive(req, dir), dir, {
			quality: num("x-quality"),
			minSaving: num("x-min-saving"),
			maxBytes: num("x-max-bytes"),
			maxDiff: num("x-max-diff"),
			maxPixels: num("x-max-pixels") || 0,
		});
		const head = Buffer.from(JSON.stringify(body));
		const size = outPath ? (await stat(outPath)).size : 0;
		res.writeHead(200, {
			"content-type": "application/octet-stream",
			"content-length": String(head.length + size),
			"x-json-length": String(head.length),
		});
		res.write(head);
		if (outPath) await pipeline(createReadStream(outPath), res);
		else res.end();
	},
};

function json(res, body) {
	const data = Buffer.from(JSON.stringify(body));
	res.writeHead(200, { "content-type": "application/json", "content-length": String(data.length) });
	res.end(data);
}

let busy = Promise.resolve();

// x-mask 最多约 11 KB，Node 默认的请求头上限（16 KB）太紧
const server = createServer({ maxHeaderSize: 64 * 1024 }, (req, res) => {
	if (req.method === "GET" && req.url === "/health") {
		res.writeHead(200, { "content-type": "text/plain" }).end("ok");
		return;
	}
	const m = req.method === "POST" && req.url?.match(/^\/tasks\/([a-z0-9-]+)$/);
	const handler = m && Object.hasOwn(tasks, m[1]) && tasks[m[1]];
	if (!handler) {
		res.writeHead(404).end("unknown task");
		return;
	}
	// 串行执行
	busy = busy.then(async () => {
		const dir = await mkdtemp(join(tmpdir(), "task-"));
		try {
			await handler(req, res, dir);
		} catch (e) {
			if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
			res.end(String(e?.message ?? e).slice(0, 2000));
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

server.requestTimeout = 15 * 60_000;
server.listen(8080);
process.on("SIGTERM", () => server.close(() => process.exit(0)));
