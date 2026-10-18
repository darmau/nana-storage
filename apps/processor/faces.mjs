/**
 * 人脸检测和识别（人物），纯 JS + onnxruntime，输入是 8 位 RGB 交错像素。
 *
 *  - 检测：SCRFD（InsightFace buffalo_l 的 det_10g），640×640 输入，输出人脸框、置信度和 5 个关键点（双眼、鼻尖、两个嘴角）。
 *  - 识别：ArcFace（buffalo_l 的 w600k_r50），按关键点把脸对齐到 112×112，输出 512 维向量。
 *    同一个人的两张脸余弦相似度通常在 0.5 以上，不同的人在 0.3 以下。
 *  - 头像：每张脸裁一个正方形，横向拼成一张图（第 i 张脸在第 i 格），整张照片只存一个文件。
 *
 * 坐标都是相对于传进来的图像（EXIF 方向已校正、用户旋转之前），输出时归一化到 0–1。
 * FACE_MODEL_VER 和 shared 的 FACE_MODEL_VER 一致；换模型时一起改。
 */

export const FACE_MODEL_VER = "buffalo_l";
const DET_SIZE = 640;
const DET_STRIDES = [8, 16, 32];
const DET_ANCHORS = 2;
const DET_THRESHOLD = 0.5;
const NMS_IOU = 0.4;
/** 一张照片最多识别这么多张脸（按大小取最大的），合影里再多的脸通常太小、认不出来。 */
export const MAX_FACES = 24;
/** 小于这么多像素（在分析用的图像里）的脸不要：太小，识别向量不可靠。 */
const MIN_FACE_PX = 20;
const REC_SIZE = 112;
/** ArcFace 训练时的标准关键点位置（112×112）。 */
const ARCFACE_DST = [
	[38.2946, 51.6963],
	[73.5318, 51.5014],
	[56.0252, 71.7366],
	[41.5493, 92.3655],
	[70.7299, 92.2041],
];
export const AVATAR_SIZE = 160;
/** 头像的边长是人脸框长边的这么多倍，留出头发和下巴。 */
const AVATAR_SCALE = 1.6;

/** 双线性采样（越界为 0，和 OpenCV 的 BORDER_CONSTANT 一样）。 */
function sample(px, w, h, x, y, c) {
	const x0 = Math.floor(x);
	const y0 = Math.floor(y);
	const fx = x - x0;
	const fy = y - y0;
	const at = (xx, yy) => (xx < 0 || yy < 0 || xx >= w || yy >= h ? 0 : px[(yy * w + xx) * 3 + c]);
	return (
		(at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy
	);
}

/** 区域平均缩放（缩小时比双线性干净）：把 src 的 [sx, sy, sx+side, sy+side] 区域缩放成 size×size。 */
function resizeArea(px, w, h, sx, sy, side, size) {
	const out = Buffer.alloc(size * size * 3);
	const step = side / size;
	if (step <= 1) {
		for (let y = 0; y < size; y++)
			for (let x = 0; x < size; x++)
				for (let c = 0; c < 3; c++) out[(y * size + x) * 3 + c] = Math.round(sample(px, w, h, sx + (x + 0.5) * step - 0.5, sy + (y + 0.5) * step - 0.5, c));
		return out;
	}
	for (let y = 0; y < size; y++) {
		const y0 = Math.floor(sy + y * step);
		const y1 = Math.max(y0 + 1, Math.floor(sy + (y + 1) * step));
		for (let x = 0; x < size; x++) {
			const x0 = Math.floor(sx + x * step);
			const x1 = Math.max(x0 + 1, Math.floor(sx + (x + 1) * step));
			const sum = [0, 0, 0];
			let n = 0;
			for (let yy = y0; yy < y1; yy++)
				for (let xx = x0; xx < x1; xx++) {
					n++;
					if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
					const o = (yy * w + xx) * 3;
					sum[0] += px[o];
					sum[1] += px[o + 1];
					sum[2] += px[o + 2];
				}
			for (let c = 0; c < 3; c++) out[(y * size + x) * 3 + c] = Math.round(sum[c] / n);
		}
	}
	return out;
}

/** 等比缩放到 640×640 以内，贴在左上角，其余补 0（和 InsightFace 的做法一样）。返回 NCHW 输入和缩放比例。 */
export function detInput(px, w, h) {
	const scale = h / w > 1 ? DET_SIZE / h : DET_SIZE / w;
	const nw = Math.min(DET_SIZE, Math.round(w * scale));
	const nh = Math.min(DET_SIZE, Math.round(h * scale));
	const plane = DET_SIZE * DET_SIZE;
	const input = new Float32Array(3 * plane).fill(-127.5 / 128);
	// 区域平均缩小（照片一定比 640 大；小图放大时退化成最近邻，也够用）
	const sx = w / nw;
	const sy = h / nh;
	for (let y = 0; y < nh; y++) {
		const y0 = Math.floor(y * sy);
		const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
		for (let x = 0; x < nw; x++) {
			const x0 = Math.floor(x * sx);
			const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
			let r = 0;
			let g = 0;
			let b = 0;
			let n = 0;
			for (let yy = y0; yy < Math.min(y1, h); yy++)
				for (let xx = x0; xx < Math.min(x1, w); xx++) {
					const o = (yy * w + xx) * 3;
					r += px[o];
					g += px[o + 1];
					b += px[o + 2];
					n++;
				}
			const i = y * DET_SIZE + x;
			input[i] = (r / n - 127.5) / 128;
			input[plane + i] = (g / n - 127.5) / 128;
			input[2 * plane + i] = (b / n - 127.5) / 128;
		}
	}
	return { input, scale: nw / w };
}

function iou(a, b) {
	const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
	const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
	const inter = ix * iy;
	const area = (r) => (r[2] - r[0]) * (r[3] - r[1]);
	return inter / (area(a) + area(b) - inter);
}

/**
 * 解码 SCRFD 的 9 个输出（3 个步长 × 置信度 / 框 / 关键点），按 scale 换回原图坐标，做 NMS。
 * outs：按 [score8, score16, score32, box8, box16, box32, kps8, kps16, kps32] 排列的 Float32Array。
 */
export function decodeDetections(outs, scale, threshold = DET_THRESHOLD) {
	const found = [];
	DET_STRIDES.forEach((stride, idx) => {
		const scores = outs[idx];
		const boxes = outs[idx + 3];
		const kps = outs[idx + 6];
		const fw = DET_SIZE / stride;
		for (let i = 0; i < scores.length; i++) {
			const score = scores[i];
			if (!(score >= threshold)) continue;
			const cell = Math.floor(i / DET_ANCHORS);
			const cx = (cell % fw) * stride;
			const cy = Math.floor(cell / fw) * stride;
			const box = [
				(cx - boxes[i * 4] * stride) / scale,
				(cy - boxes[i * 4 + 1] * stride) / scale,
				(cx + boxes[i * 4 + 2] * stride) / scale,
				(cy + boxes[i * 4 + 3] * stride) / scale,
			];
			const points = [];
			for (let k = 0; k < 5; k++) points.push([(cx + kps[i * 10 + k * 2] * stride) / scale, (cy + kps[i * 10 + k * 2 + 1] * stride) / scale]);
			found.push({ box, score, kps: points });
		}
	});
	found.sort((a, b) => b.score - a.score);
	const kept = [];
	for (const f of found) if (kept.every((k) => iou(k.box, f.box) <= NMS_IOU)) kept.push(f);
	return kept;
}

/**
 * 最小二乘相似变换（旋转 + 等比缩放 + 平移，不含镜像）：找 a（复数）和 b 使 Σ|a·p + b − q|² 最小。
 * 返回把 from 映射到 to 的 2×3 矩阵 [m00, m01, m02, m10, m11, m12]。
 */
export function similarity(from, to) {
	const n = from.length;
	const mean = (pts, i) => pts.reduce((s, p) => s + p[i], 0) / n;
	const [px, py, qx, qy] = [mean(from, 0), mean(from, 1), mean(to, 0), mean(to, 1)];
	let re = 0;
	let im = 0;
	let norm = 0;
	for (let k = 0; k < n; k++) {
		const ax = from[k][0] - px;
		const ay = from[k][1] - py;
		const bx = to[k][0] - qx;
		const by = to[k][1] - qy;
		// conj(a) · b
		re += ax * bx + ay * by;
		im += ax * by - ay * bx;
		norm += ax * ax + ay * ay;
	}
	const ar = re / norm;
	const ai = im / norm;
	return [ar, -ai, qx - (ar * px - ai * py), ai, ar, qy - (ai * px + ar * py)];
}

/** 按关键点对齐成 112×112，返回 ArcFace 的 NCHW 输入（写进 out 的 offset 处）和用于评估清晰度的灰度图。 */
export function alignFace(px, w, h, kps, out, offset) {
	// 从输出坐标反推原图坐标：直接估计 dst → src 的变换
	const m = similarity(ARCFACE_DST, kps);
	const plane = REC_SIZE * REC_SIZE;
	const gray = new Float32Array(plane);
	for (let v = 0; v < REC_SIZE; v++)
		for (let u = 0; u < REC_SIZE; u++) {
			const x = m[0] * u + m[1] * v + m[2];
			const y = m[3] * u + m[4] * v + m[5];
			const i = v * REC_SIZE + u;
			const r = sample(px, w, h, x, y, 0);
			const g = sample(px, w, h, x, y, 1);
			const b = sample(px, w, h, x, y, 2);
			out[offset + i] = (r - 127.5) / 127.5;
			out[offset + plane + i] = (g - 127.5) / 127.5;
			out[offset + 2 * plane + i] = (b - 127.5) / 127.5;
			gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
		}
	return gray;
}

/** 清晰度：对齐后人脸的拉普拉斯方差。越模糊越小（失焦、运动模糊的脸通常低于 50）。 */
export function sharpness(gray, size = REC_SIZE) {
	let sum = 0;
	let sq = 0;
	let n = 0;
	for (let y = 1; y < size - 1; y++)
		for (let x = 1; x < size - 1; x++) {
			const i = y * size + x;
			const l = gray[i - 1] + gray[i + 1] + gray[i - size] + gray[i + size] - 4 * gray[i];
			sum += l;
			sq += l * l;
			n++;
		}
	const mean = sum / n;
	return sq / n - mean * mean;
}

/** L2 归一化后按最大绝对值缩放成 int8（base64）。只用余弦相似度，缩放不影响结果。 */
export function quantize(v) {
	let max = 0;
	for (const x of v) max = Math.max(max, Math.abs(x));
	if (!(max > 0)) return null;
	const q = new Int8Array(v.length);
	for (let i = 0; i < v.length; i++) q[i] = Math.round((v[i] / max) * 127);
	return Buffer.from(q.buffer).toString("base64");
}

/** 头像的正方形区域（原图坐标）。 */
export function avatarBox(box) {
	const side = Math.max(box[2] - box[0], box[3] - box[1]) * AVATAR_SCALE;
	return { x: (box[0] + box[2]) / 2 - side / 2, y: (box[1] + box[3]) / 2 - side / 2, side };
}

/** 所有头像横向拼成一张 RGB 图（PPM，交给 vips 编码成 WebP）。 */
export function avatarSprite(px, w, h, boxes) {
	const n = boxes.length;
	const sw = AVATAR_SIZE * n;
	const header = Buffer.from(`P6\n${sw} ${AVATAR_SIZE}\n255\n`);
	const body = Buffer.alloc(sw * AVATAR_SIZE * 3);
	boxes.forEach((b, i) => {
		const { x, y, side } = avatarBox(b);
		const tile = resizeArea(px, w, h, x, y, side, AVATAR_SIZE);
		for (let row = 0; row < AVATAR_SIZE; row++)
			tile.copy(body, (row * sw + i * AVATAR_SIZE) * 3, row * AVATAR_SIZE * 3, (row + 1) * AVATAR_SIZE * 3);
	});
	return Buffer.concat([header, body]);
}

/**
 * 检测 + 识别。sessions：{ det, rec } 两个 onnxruntime 会话，ort：onnxruntime 模块。
 * 返回 { faces: [{ x, y, w, h, px, score, sharpness, embedding }], boxes }，按人脸大小从大到小。
 * x / y / w / h 归一化到 0–1；px 是人脸框短边在这张图里的像素数（识别向量的可靠程度主要看它）。
 */
export async function analyzeFaces(ort, sessions, px, w, h) {
	const { input, scale } = detInput(px, w, h);
	const det = await sessions.det.run({ [sessions.det.inputNames[0]]: new ort.Tensor("float32", input, [1, 3, DET_SIZE, DET_SIZE]) });
	const outs = sessions.det.outputNames.map((n) => det[n].data);
	const found = decodeDetections(outs, scale)
		.filter((f) => Math.min(f.box[2] - f.box[0], f.box[3] - f.box[1]) >= MIN_FACE_PX)
		.sort((a, b) => (b.box[2] - b.box[0]) * (b.box[3] - b.box[1]) - (a.box[2] - a.box[0]) * (a.box[3] - a.box[1]))
		.slice(0, MAX_FACES);
	if (!found.length) return { faces: [], boxes: [] };

	const plane = 3 * REC_SIZE * REC_SIZE;
	const batch = new Float32Array(found.length * plane);
	const sharp = found.map((f, i) => sharpness(alignFace(px, w, h, f.kps, batch, i * plane)));
	const rec = await sessions.rec.run({
		[sessions.rec.inputNames[0]]: new ort.Tensor("float32", batch, [found.length, 3, REC_SIZE, REC_SIZE]),
	});
	const emb = rec[sessions.rec.outputNames[0]].data;
	const dims = emb.length / found.length;
	const clamp = (v) => Math.min(1, Math.max(0, v));
	const faces = [];
	const boxes = [];
	found.forEach((f, i) => {
		const embedding = quantize(emb.subarray(i * dims, (i + 1) * dims));
		if (!embedding) return;
		const [x1, y1, x2, y2] = [clamp(f.box[0] / w), clamp(f.box[1] / h), clamp(f.box[2] / w), clamp(f.box[3] / h)];
		faces.push({
			x: round4(x1),
			y: round4(y1),
			w: round4(x2 - x1),
			h: round4(y2 - y1),
			px: Math.round(Math.min(f.box[2] - f.box[0], f.box[3] - f.box[1])),
			score: round4(f.score),
			sharpness: Math.round(sharp[i]),
			embedding,
		});
		boxes.push(f.box);
	});
	return { faces, boxes };
}

const round4 = (v) => Math.round(v * 10000) / 10000;
