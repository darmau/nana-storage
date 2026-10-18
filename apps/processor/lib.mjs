import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { crc32 } from "node:zlib";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import ort from "onnxruntime-node";
import { analyzeFaces, avatarSprite, FACE_MODEL_VER } from "./faces.mjs";
import { frost, frostSize, netpbm, parseMask, rasterizeMask } from "./mask.mjs";

/**
 * 处理代码本体：容器的 HTTP 外壳（server.mjs）和设备端处理（apps/device）共用这一份，结果完全一致。
 * 输入都是已经落盘的文件（saveInput 写盘时顺便算好 sha256 / 大小 / CRC32），输出是 JSON 字段和输出文件路径。
 *
 * 容器的任务（都是 POST，请求体是原始文件）：
 *   /tasks/meta       → JSON { meta, sha256, size, crc32 }
 *   /tasks/derive     → JSON { meta, sha256, size, crc32, width, height, thumb, preview, fp }（图片为 base64 webp）
 *                       x-preview-edge：预览长边（默认 3840，“加载原图”时是原图尺寸，最大 16383）。
 *                       x-preview-transport: stream 时预览不放进 JSON（全尺寸预览有十几 MB，base64 进 JSON 太占 Worker 内存）：
 *                       响应体是 JSON 加紧跟着的预览字节，x-json-length 是 JSON 的字节数。
 *                       x-fingerprint: skip 时指纹和人脸都不算（旋转只重做缩略图）。算失败时 fp / faces 为 null，不影响其他结果。
 *                       x-mask：打码的笔画（mask.mjs），缩略图和预览上盖住的地方变成毛玻璃；指纹和人脸照样按没打码的图算。
 *                       响应里的 mask 原样带回实际用过的笔画，Worker 据此确认（旧版容器不认这个头，不能悄悄生成没打码的预览）。
 *                       faces：{ model, faces: [{ x, y, w, h, px, score, sharpness, embedding }], sprite }，见 faces.mjs。视频不算。
 *   /tasks/transcode  → video/mp4（带 Content-Length）
 *
 * 每个外部进程都有硬超时（SIGKILL）。临时文件由调用方在任务结束时删除。
 */

const THUMB_BOX = "1440x480>"; // 时间线缩略图：高度 480（2x 屏上约 240px 行高）
const PREVIEW_EDGE = 3840; // 查看器用，覆盖 4K / iPad 全屏。和 shared 的 PREVIEW_LONG_EDGE 一致
const WEBP_MAX_EDGE = 16383;
const WEBP_Q = 80;
// effort=2：编码时间比默认的 4 少一半左右（3840 的预览每张少约 0.7 秒），文件大 4–6%，画质几乎一样（SSIM 0.980 → 0.978）。
// effort 3 和 4 一样慢，2 是分界线。
// keep=icc：只保留色彩配置，EXIF / XMP（包括 GPS）照样去掉。vipsthumbnail 不做色彩转换，
// 像素值还是原图色彩空间（iPhone 是 Display P3）的，去掉配置后浏览器会当成 sRGB，颜色发淡。
// 保留配置每张多几百字节；指纹读的像素值不变（vips thumbnail 同样不转换）。
const WEBP_OPTS = `Q=${WEBP_Q},keep=icc,effort=2`;

/**
 * 指纹（相同 / 相似照片）：
 *  - phash：32×32 灰度图做 DCT，取左上 8×8 与中位数比较，64 位，16 个十六进制字符。
 *  - embedding：CLIP ViT-B/32 图像向量，512 维，L2 归一化后按最大绝对值缩放成 int8（base64）。只用余弦相似度，缩放不影响结果。
 * 都按 EXIF 方向校正、但用户旋转之前的图像计算，旋转照片不会改变指纹。
 * MODEL_VER 和 Worker 的 FP_MODEL_VER 一致；换模型时一起改。
 */
const MODEL_VER = "clip-b32-q8";
const CLIP_SIZE = 224;
const CLIP_MEAN = [0.48145466, 0.4578275, 0.40821073];
const CLIP_STD = [0.26862954, 0.26130258, 0.27577711];
let clipSession;

/**
 * 人脸（人物）：在长边 FACE_EDGE 的图上检测，见 faces.mjs。头像拼成一张 WebP（sprite，base64），没有脸时为 null。
 * 和指纹一样按用户旋转之前的图像计算。
 */
const FACE_EDGE = 1920;
/** ONNX 推理线程数：容器只有 1 vCPU，用 1；设备端可以用 ORT_THREADS 调整。 */
const ORT_THREADS = Math.max(1, Number(process.env.ORT_THREADS) || 1);
const ORT_OPTS = { intraOpNumThreads: ORT_THREADS, interOpNumThreads: 1, graphOptimizationLevel: "all", logSeverityLevel: 3 };
let faceSessions;

export function run(cmd, args, { timeoutMs = 60_000, capture = true } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, { stdio: ["ignore", capture ? "pipe" : "ignore", "pipe"] });
		const out = [];
		let err = "";
		child.stdout?.on("data", (d) => out.push(d));
		child.stderr.on("data", (d) => {
			if (err.length < 8000) err += d;
		});
		const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
		child.on("error", (e) => {
			clearTimeout(timer);
			reject(e);
		});
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			if (code === 0) resolve(Buffer.concat(out));
			else reject(new Error(`${cmd} failed (${signal ?? code}): ${err.slice(-2000)}`));
		});
	});
}

/** 把输入流写到 path，同时算 sha256、大小和 CRC32（打包 zip 下载时要用）。 */
export async function saveInput(source, path) {
	const hash = createHash("sha256");
	let size = 0;
	let crc = 0;
	await pipeline(
		source,
		async function* (chunks) {
			for await (const chunk of chunks) {
				hash.update(chunk);
				crc = crc32(chunk, crc);
				size += chunk.length;
				yield chunk;
			}
		},
		createWriteStream(path),
	);
	return { path, sha256: hash.digest("hex"), size, crc32: crc >>> 0 };
}

async function exif(path) {
	const out = await run("exiftool", ["-json", "-n", "-api", "largefilesupport=1", "-ee3", path], { timeoutMs: 30_000 });
	const [meta] = JSON.parse(out.toString("utf8"));
	delete meta.SourceFile;
	delete meta.Directory;
	delete meta.FileName;
	// 不返回二进制/超长字段
	for (const [k, v] of Object.entries(meta)) {
		if (typeof v === "string" && (v.startsWith("(Binary data") || v.length > 2000)) delete meta[k];
	}
	return meta;
}

/** RAW：优先用内嵌的最大 JPEG 预览，没有再用 LibRaw 解码。 */
async function rawToImage(input, dir, meta) {
	for (const tag of ["JpgFromRaw", "PreviewImage", "OtherImage"]) {
		const out = join(dir, `embedded-${tag}.jpg`);
		try {
			const buf = await run("exiftool", ["-b", `-${tag}`, input], { timeoutMs: 30_000 });
			if (buf.length > 50_000) {
				await writeBuffer(out, buf);
				// 内嵌预览通常没有方向信息，从 RAW 复制过来
				if (meta.Orientation) {
					await run("exiftool", ["-overwrite_original", "-n", `-Orientation=${meta.Orientation}`, out], {
						timeoutMs: 15_000,
					});
				}
				return out;
			}
		} catch {}
	}
	await run("dcraw_emu", ["-T", "-w", "-Z", join(dir, "raw.tiff"), input], { timeoutMs: 120_000, capture: false });
	return join(dir, "raw.tiff");
}

async function writeBuffer(path, buf) {
	await pipeline(async function* () {
		yield buf;
	}, createWriteStream(path));
}

async function videoFrame(input, dir, meta) {
	const duration = Number(meta.Duration) || 0;
	const at = duration > 2 ? 1 : Math.max(0, duration / 2);
	const out = join(dir, "frame.jpg");
	await run("ffmpeg", ["-v", "error", "-ss", String(at), "-i", input, "-frames:v", "1", "-q:v", "2", "-y", out], {
		timeoutMs: 60_000,
		capture: false,
	});
	return out;
}

/** 裁切或打码过的照片另存一张未裁切、未打码的底图（编辑界面用），长边最多这么多。 */
const BASE_EDGE = 2048;

const header = async (path, field) => Number((await run("vipsheader", ["-f", field, path])).toString().trim());

/**
 * crop：0–1 的裁切框（相对于旋转之后的整张图），null 不裁切。裁切时缩略图和预览都是裁切后的。
 * mask：打码的笔画（parseMask 的结果，相对于旋转之前的整张图），null 不打码。
 * 裁切或打码时另外输出底图（旋转之后的整张图，不打码）。返回的 unrotated 是没有打码的，指纹和人脸用它。
 */
async function deriveImages(source, dir, rotation, edge = PREVIEW_EDGE, onThumb, crop = null, mask = null) {
	const preview = join(dir, "preview.webp");
	// 全尺寸预览要解码、编码几千万像素，给更多时间（Worker 那边的总超时也相应放宽）
	const big = edge > PREVIEW_EDGE;
	// ">" 只缩小不放大
	await run("vipsthumbnail", [source, "-s", `${edge}x${edge}>`, "-o", `${preview}[${WEBP_OPTS}]`], {
		timeoutMs: big ? 120_000 : 60_000,
	});
	let previewSrc = preview;
	if (mask) {
		previewSrc = join(dir, "preview-mask.webp");
		await applyMask(preview, previewSrc, dir, mask, big);
	}
	if (rotation) {
		const rotated = join(dir, "preview-rot.webp");
		await run("vips", ["rot", previewSrc, `${rotated}[${WEBP_OPTS}]`, `d${rotation}`], { timeoutMs: big ? 90_000 : 30_000 });
		previewSrc = rotated;
	}
	// 旋转之后、裁切之前的尺寸：Worker 在没有 EXIF 尺寸时拿它当照片尺寸
	const width = await header(previewSrc, "width");
	const height = await header(previewSrc, "height");
	let basePath = null;
	if (crop || mask) {
		// 从没打码的预览缩小再转过去（小图转起来快）
		basePath = join(dir, "base.webp");
		const small = rotation ? join(dir, "base-unrotated.webp") : basePath;
		await run("vipsthumbnail", [preview, "-s", `${BASE_EDGE}x${BASE_EDGE}>`, "-o", `${small}[${WEBP_OPTS}]`], { timeoutMs: 30_000 });
		if (rotation) await run("vips", ["rot", small, `${basePath}[${WEBP_OPTS}]`, `d${rotation}`], { timeoutMs: 30_000 });
	}
	if (crop) {
		const [left, top, w, h] = cropPixels(crop, width, height);
		const cropped = join(dir, "preview-crop.webp");
		await run("vips", ["crop", previewSrc, `${cropped}[${WEBP_OPTS}]`, String(left), String(top), String(w), String(h)], {
			timeoutMs: big ? 90_000 : 30_000,
		});
		previewSrc = cropped;
	}
	const thumb = join(dir, "thumb.webp");
	await run("vipsthumbnail", [previewSrc, "-s", THUMB_BOX, "-o", `${thumb}[${WEBP_OPTS}]`], { timeoutMs: 30_000 });
	onThumb?.(thumb);
	return { unrotated: preview, previewPath: previewSrc, basePath, width, height, thumbPath: thumb };
}

/**
 * 打码：src（未旋转的预览）上被笔画盖住的地方换成毛玻璃，写到 out。
 * 毛玻璃和蒙版都在长边 FROST_EDGE 的小图上算，再放大回原尺寸混合（见 mask.mjs）。
 * 混合以原图为第一个输入，色彩配置（ICC）跟着它保留，和不打码的预览一样。
 */
async function applyMask(src, out, dir, strokes, big) {
	const W = await header(src, "width");
	const H = await header(src, "height");
	let input = src;
	// 灰度或带透明通道的（PNG 之类）先转成 3 通道，才能和毛玻璃逐像素混合
	if ((await header(src, "bands")) !== 3) {
		const srgb = join(dir, "mask-srgb.v");
		input = join(dir, "mask-rgb.v");
		await run("vips", ["colourspace", src, srgb, "srgb"], { timeoutMs: 30_000 });
		await run("vips", ["extract_band", srgb, input, "0", "--n", "3"], { timeoutMs: 30_000 });
	}
	const [w, h] = frostSize(W, H);
	const { px } = await rgbImage(input, dir, w, ["--size", "force"], "frost-src", h);
	const frostSmall = join(dir, "frost.ppm");
	const keepSmall = join(dir, "frost-keep.pgm");
	await writeBuffer(frostSmall, netpbm(frost(px, w, h), w, h, 3));
	// 蒙版取反：1 保留原图，0 用毛玻璃（ifthenelse 以原图为第一个输入）
	await writeBuffer(keepSmall, netpbm(rasterizeMask(strokes, w, h).map((v) => 255 - v), w, h, 1));
	const frostBig = join(dir, "frost-big.v");
	const keepBig = join(dir, "frost-keep-big.v");
	const up = (from, to) => run("vips", ["thumbnail", from, to, String(W), "--height", String(H), "--size", "force"], { timeoutMs: big ? 90_000 : 30_000 });
	await up(frostSmall, frostBig);
	await up(keepSmall, keepBig);
	await run("vips", ["ifthenelse", keepBig, input, frostBig, `${out}[${WEBP_OPTS}]`, "--blend"], { timeoutMs: big ? 120_000 : 30_000 });
}

/** 裁切框换算成像素（left, top, width, height），至少 1 像素、不超出图片。 */
export function cropPixels(crop, width, height) {
	const left = Math.min(width - 1, Math.max(0, Math.round(crop.x * width)));
	const top = Math.min(height - 1, Math.max(0, Math.round(crop.y * height)));
	const w = Math.max(1, Math.min(width - left, Math.round(crop.w * width)));
	const h = Math.max(1, Math.min(height - top, Math.round(crop.h * height)));
	return [left, top, w, h];
}

/** 解析 x-crop 头（"x,y,w,h"，0–1 的比例）。没有时返回 null，不合法时抛错。 */
export function parseCrop(value) {
	if (value === undefined || value === null || value === "") return null;
	const n = String(value).split(",").map(Number);
	const [x, y, w, h] = n;
	if (n.length !== 4 || !n.every(Number.isFinite) || x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > 1.000001 || y + h > 1.000001) {
		throw new Error("bad crop");
	}
	return { x, y, w, h };
}

/**
 * 缩放成 size×size 的 8 位 sRGB 像素（RGB 交错）。crop 为 true 时按短边缩放后居中裁剪，否则直接拉伸。
 * 常见情况（8/16 位的 sRGB 或灰度）只启动一次 vips，直接解析 .v 文件；其他色彩空间（CMYK 等）再交给 vips 转换。
 */
async function rgbPixels(source, dir, size, crop, name) {
	const fit = crop ? ["--crop", "centre"] : ["--size", "force"];
	const img = await rgbImage(source, dir, size, fit, name);
	if (img.width !== size || img.height !== size) throw new Error("unexpected pixel size");
	return img.px;
}

/** 缩放（参数同 vips thumbnail，height 默认和 size 相同）成 8 位 sRGB 像素，返回 { px, width, height }。 */
async function rgbImage(source, dir, size, fit, name, height = size) {
	const v = join(dir, `${name}.v`);
	await run("vips", ["thumbnail", source, v, String(size), "--height", String(height), ...fit], { timeoutMs: 30_000 });
	const img = readVipsFile(await readFile(v));
	if (img) return img;
	const b = join(dir, `${name}-srgb.v`);
	const c = join(dir, `${name}-rgb.v`);
	await run("vips", ["colourspace", v, b, "srgb"], { timeoutMs: 15_000 });
	await run("vips", ["extract_band", b, c, "0", "--n", "3"], { timeoutMs: 15_000 });
	const converted = readVipsFile(await readFile(c));
	if (!converted) throw new Error("unsupported pixel format");
	return converted;
}

/** 解析 libvips 的 .v 文件，要求是 size×size。不认识的格式返回 null。 */
export function fromVipsFile(buf, size) {
	const img = readVipsFile(buf);
	return img && img.width === size && img.height === size ? img.px : null;
}

/** 解析 libvips 的 .v 文件（64 字节头 + 未压缩像素），返回 { px, width, height }。不认识的格式返回 null。 */
export function readVipsFile(buf) {
	if (buf.length < 64) return null;
	// 魔数的字节序和数据相反：Intel（小端）文件以 b6 a6 f2 08 开头，SPARC（大端）以 08 f2 a6 b6 开头
	const magic = buf.readUInt32BE(0);
	const le = magic === 0xb6a6f208;
	if (!le && magic !== 0x08f2a6b6) return null;
	const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
	const [width, height, bands, format, coding, type] = [4, 8, 12, 20, 24, 28].map(u32);
	if (!width || !height || coding !== 0) return null;
	const grey = type === 1 || type === 26; // B_W / GREY16
	const rgb = type === 22 || type === 25; // sRGB / RGB16
	if (!((grey && bands <= 2) || (rgb && bands >= 3 && bands <= 4))) return null;
	const bytes = format === 0 ? 1 : format === 2 ? 2 : 0; // UCHAR / USHORT
	if (!bytes || buf.length < 64 + width * height * bands * bytes) return null;
	const sample = bytes === 1 ? (o) => buf[64 + o] : (o) => (le ? buf.readUInt16LE(64 + o * 2) : buf.readUInt16BE(64 + o * 2)) >> 8;
	const out = Buffer.alloc(width * height * 3);
	for (let i = 0; i < width * height; i++)
		for (let c = 0; c < 3; c++) out[i * 3 + c] = sample(i * bands + (grey ? 0 : c));
	return { px: out, width, height };
}

const DCT_N = 32;
const DCT_COS = Array.from({ length: 8 }, (_, u) =>
	Float64Array.from({ length: DCT_N }, (_, x) => Math.cos(((2 * x + 1) * u * Math.PI) / (2 * DCT_N))),
);

export function phashFromRgb(px) {
	const gray = new Float64Array(DCT_N * DCT_N);
	for (let i = 0; i < gray.length; i++) gray[i] = 0.299 * px[i * 3] + 0.587 * px[i * 3 + 1] + 0.114 * px[i * 3 + 2];
	// 只需要左上 8×8 的系数：先对行做 8 个频率，再对列
	const rows = new Float64Array(DCT_N * 8);
	for (let y = 0; y < DCT_N; y++)
		for (let u = 0; u < 8; u++) {
			let sum = 0;
			for (let x = 0; x < DCT_N; x++) sum += gray[y * DCT_N + x] * DCT_COS[u][x];
			rows[y * 8 + u] = sum;
		}
	const coef = new Float64Array(64);
	for (let v = 0; v < 8; v++)
		for (let u = 0; u < 8; u++) {
			let sum = 0;
			for (let y = 0; y < DCT_N; y++) sum += rows[y * 8 + u] * DCT_COS[v][y];
			coef[v * 8 + u] = sum;
		}
	const median = [...coef.slice(1)].sort((a, b) => a - b)[31]; // 不含直流分量
	let hex = "";
	for (let i = 0; i < 64; i += 4) {
		let nibble = 0;
		for (let j = 0; j < 4; j++) nibble = (nibble << 1) | (coef[i + j] > median ? 1 : 0);
		hex += nibble.toString(16);
	}
	return hex;
}

async function embed(px) {
	// 设备端会并发调用：会话只创建一次（存 Promise），run 本身可以并发
	clipSession ??= ort.InferenceSession.create("/app/model/clip-vision.onnx", {
		intraOpNumThreads: ORT_THREADS,
		interOpNumThreads: 1,
		graphOptimizationLevel: "all",
	}).catch((e) => {
		clipSession = undefined; // 下次再试
		throw e;
	});
	const session = await clipSession;
	const plane = CLIP_SIZE * CLIP_SIZE;
	const input = new Float32Array(3 * plane);
	for (let i = 0; i < plane; i++)
		for (let c = 0; c < 3; c++) input[c * plane + i] = (px[i * 3 + c] / 255 - CLIP_MEAN[c]) / CLIP_STD[c];
	const out = await session.run({ pixel_values: new ort.Tensor("float32", input, [1, 3, CLIP_SIZE, CLIP_SIZE]) });
	const v = out.image_embeds.data;
	let max = 0;
	for (const x of v) max = Math.max(max, Math.abs(x));
	if (!(max > 0)) throw new Error("empty embedding");
	const q = new Int8Array(v.length);
	for (let i = 0; i < v.length; i++) q[i] = Math.round((v[i] / max) * 127);
	return Buffer.from(q.buffer).toString("base64");
}

/** source：EXIF 方向已校正、用户旋转之前的图像。 */
async function fingerprint(source, dir) {
	try {
		const small = await rgbPixels(source, dir, DCT_N, false, "fp-hash");
		const clip = await rgbPixels(source, dir, CLIP_SIZE, true, "fp-clip");
		return { model: MODEL_VER, phash: phashFromRgb(small), embedding: await embed(clip) };
	} catch (e) {
		console.error("fingerprint failed:", String(e?.message ?? e).slice(0, 500));
		return null;
	}
}

/** 构建参数 NANA_FACES=off 时镜像里没有人脸模型，不做人脸识别（见 Dockerfile）。 */
export const FACES_ENABLED = process.env.NANA_FACES !== "off";

/** source：EXIF 方向已校正、用户旋转之前的图像。 */
async function faces(source, dir) {
	try {
		const { px, width, height } = await rgbImage(source, dir, FACE_EDGE, ["--size", "down"], "faces");
		faceSessions ??= Promise.all([
			ort.InferenceSession.create("/app/model/face-det.onnx", ORT_OPTS),
			ort.InferenceSession.create("/app/model/face-rec.onnx", ORT_OPTS),
		])
			.then(([det, rec]) => ({ det, rec }))
			.catch((e) => {
				faceSessions = undefined; // 下次再试
				throw e;
			});
		const found = await analyzeFaces(ort, await faceSessions, px, width, height);
		let sprite = null;
		if (found.boxes.length) {
			const ppm = join(dir, "faces.ppm");
			const webp = join(dir, "faces.webp");
			await writeBuffer(ppm, avatarSprite(px, width, height, found.boxes));
			await run("vips", ["copy", ppm, `${webp}[Q=${WEBP_Q},effort=2]`], { timeoutMs: 15_000 });
			sprite = (await readFile(webp)).toString("base64");
		}
		return { model: FACE_MODEL_VER, faces: found.faces, sprite };
	} catch (e) {
		console.error("faces failed:", String(e?.message ?? e).slice(0, 500));
		return null;
	}
}

/** input：saveInput 的结果加上 path。 */
export async function metaTask(input) {
	return { meta: await exif(input.path), sha256: input.sha256, size: input.size, crc32: input.crc32 };
}

/**
 * kind：image | raw | video。mode：
 *   full  元数据 + 缩略图 + 预览 + 指纹 + 人脸（视频不认人脸）
 *   skip  不算指纹和人脸（旋转只重做缩略图）
 * previewEdge：预览长边（默认 3840，“加载原图”时是原图尺寸，最大 16383）。
 * crop：裁切框（parseCrop 的结果），null 不裁切。
 * mask：打码的笔画（x-mask 的原始字符串，见 mask.mjs），null 不打码；body.mask 原样带回，表示确实打过码。
 * 裁切或打码时多一张未裁切、未打码的底图 basePath，否则为 null。
 * 返回 { body, thumbPath, previewPath, basePath }：body 是 JSON 字段。
 * onStep(step, thumbPath?)：可选的进度回调（设备端界面用）。step 依次是 decode、images、thumb（缩略图已经生成，带路径）、
 * fingerprint、faces；只调用实际会做的步骤。
 */
export async function deriveTask(
	input,
	dir,
	{ kind, rotation = 0, mode = "full", previewEdge = PREVIEW_EDGE, crop = null, mask = null, onStep = () => {} },
) {
	if (![0, 90, 180, 270].includes(rotation)) throw new Error("bad rotation");
	const strokes = parseMask(mask);
	if (!["full", "skip"].includes(mode)) throw new Error("bad mode");
	if (!Number.isInteger(previewEdge) || previewEdge < 1 || previewEdge > WEBP_MAX_EDGE) throw new Error("bad preview edge");
	onStep("decode");
	const meta = await exif(input.path);
	let source = input.path;
	if (kind === "raw") source = await rawToImage(input.path, dir, meta);
	else if (kind === "video") source = await videoFrame(input.path, dir, meta);
	else if (kind !== "image") throw new Error("bad kind");
	const base = { meta, sha256: input.sha256, size: input.size, crc32: input.crc32 };
	onStep("images");
	const { unrotated, previewPath, thumbPath, basePath, width, height } = await deriveImages(
		source,
		dir,
		rotation,
		previewEdge,
		(path) => onStep("thumb", path),
		crop,
		strokes,
	);
	// 预览图（未旋转）比原件小得多，从它算指纹更快
	if (mode !== "skip") onStep("fingerprint");
	const fp = mode === "skip" ? null : await fingerprint(unrotated, dir);
	// 视频不认人脸（只有一帧，意义不大）；关掉人脸识别时 faces 为 null，Worker 不写任何人脸数据
	const doFaces = FACES_ENABLED && mode !== "skip" && kind !== "video";
	if (doFaces) onStep("faces");
	const found = doFaces ? await faces(unrotated, dir) : null;
	return { body: { ...base, width, height, fp, faces: found, mask: strokes ? mask : null }, thumbPath, previewPath, basePath };
}

/** 转码成 H.264 预览（长边最多 1920，保持方向；H.264 + AAC，faststart 便于边下边播），返回输出文件路径。 */
export async function transcodeTask(input, dir, { timeoutMs }) {
	const out = join(dir, "out.mp4");
	const scale = "scale='if(gte(iw,ih),min(1920,iw),-2)':'if(gte(iw,ih),-2,min(1920,ih))'";
	await run(
		"ffmpeg",
		[
			"-v", "error", "-i", input.path,
			"-map", "0:v:0", "-map", "0:a:0?",
			"-vf", `${scale},format=yuv420p`,
			"-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
			"-c:a", "aac", "-b:a", "128k",
			"-movflags", "+faststart", "-y", out,
		],
		{ timeoutMs, capture: false },
	);
	return out;
}
