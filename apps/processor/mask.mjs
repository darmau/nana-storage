/**
 * 打码（毛玻璃），纯 JS。笔画格式和 packages/shared/src/mask.ts 的 encodeMask 一致（这里只解码），改格式时两边一起改：
 * base64url 的 uint16 小端 [版本, 笔画数, 每笔：半径, 点数, x0, y0, …]，坐标和半径量化到 1/65535。
 * 坐标是 0–1 的比例，相对于用户旋转之前的整张图；半径是长边的比例。
 *
 * 毛玻璃在长边 FROST_EDGE 的小图上算（盒式模糊 3 遍 + 随机错位），再放大回预览尺寸，按同样大小的蒙版混合：
 * 放大让颗粒变柔和、蒙版边缘自然羽化，几千万像素的全尺寸预览也只在小图上跑 JS。
 * 随机数固定种子，容器和设备端的结果完全一致。前端编辑界面用同样的算法预览（apps/web/src/viewer/frost.ts）。
 */

const VERSION = 1;
const Q = 65535;
const MAX_POINTS = 2000;
const MAX_STROKES = 200;

/** 毛玻璃在这么大的小图上算（长边）。 */
export const FROST_EDGE = 1024;
/** 模糊半径、错位幅度：长边的比例。足够让被盖住的脸认不出来。 */
const FROST_BLUR = 0.02;
const FROST_SCATTER = 0.012;

/** 解码 x-mask；不合法时抛错（和 parseCrop 一样，坏参数直接让任务失败，不会悄悄生成没打码的预览）。 */
export function parseMask(value) {
	if (value === undefined || value === null || value === "") return null;
	const s = String(value);
	if (!/^[A-Za-z0-9_-]+$/.test(s)) throw new Error("bad mask");
	const bytes = Buffer.from(s, "base64url");
	if (bytes.length % 2 || bytes.length < 4) throw new Error("bad mask");
	const word = (i) => bytes.readUInt16LE(i * 2);
	const total = bytes.length / 2;
	if (word(0) !== VERSION) throw new Error("bad mask version");
	const count = word(1);
	if (!count || count > MAX_STROKES) throw new Error("bad mask");
	const strokes = [];
	let o = 2;
	let points = 0;
	for (let i = 0; i < count; i++) {
		if (o + 2 > total) throw new Error("bad mask");
		const r = word(o++) / Q;
		const n = word(o++);
		points += n;
		if (!n || r <= 0 || points > MAX_POINTS || o + n * 2 > total) throw new Error("bad mask");
		const p = [];
		for (let k = 0; k < n * 2; k++) p.push(word(o + k) / Q);
		strokes.push({ r, p });
		o += n * 2;
	}
	if (o !== total) throw new Error("bad mask");
	return strokes;
}

/** 画成 w×h 的蒙版（每像素 1 字节，盖住的是 255），按像素中心判断是否在笔画（圆头粗线）里。 */
export function rasterizeMask(strokes, w, h) {
	const out = new Uint8Array(w * h);
	const L = Math.max(w, h);
	const capsule = (ax, ay, bx, by, R) => {
		const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - R));
		const x1 = Math.min(w - 1, Math.ceil(Math.max(ax, bx) + R));
		const y0 = Math.max(0, Math.floor(Math.min(ay, by) - R));
		const y1 = Math.min(h - 1, Math.ceil(Math.max(ay, by) + R));
		const dx = bx - ax;
		const dy = by - ay;
		const len2 = dx * dx + dy * dy;
		const R2 = R * R;
		for (let y = y0; y <= y1; y++) {
			const py = y + 0.5;
			for (let x = x0; x <= x1; x++) {
				const px = x + 0.5;
				const t = len2 ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
				const ex = px - ax - t * dx;
				const ey = py - ay - t * dy;
				if (ex * ex + ey * ey <= R2) out[y * w + x] = 255;
			}
		}
	};
	for (const s of strokes) {
		const R = Math.max(0.5, s.r * L);
		const p = s.p;
		if (p.length === 2) capsule(p[0] * w, p[1] * h, p[0] * w, p[1] * h, R);
		for (let i = 2; i < p.length; i += 2) capsule(p[i - 2] * w, p[i - 1] * h, p[i] * w, p[i + 1] * h, R);
	}
	return out;
}

/** mulberry32：固定种子的伪随机数，结果在各平台上一致。 */
function rng(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** 一遍盒式模糊（水平或垂直），边缘取最近的像素。ch 是每像素的通道数。 */
function boxPass(src, dst, w, h, ch, r, horizontal) {
	const n = horizontal ? w : h;
	const lines = horizontal ? h : w;
	const stride = horizontal ? ch : w * ch;
	const lineStride = horizontal ? w * ch : ch;
	const div = 2 * r + 1;
	for (let line = 0; line < lines; line++) {
		const base = line * lineStride;
		for (let c = 0; c < ch; c++) {
			const at = (i) => src[base + Math.min(n - 1, Math.max(0, i)) * stride + c];
			let sum = 0;
			for (let i = -r; i <= r; i++) sum += at(i);
			for (let i = 0; i < n; i++) {
				dst[base + i * stride + c] = Math.round(sum / div);
				sum += at(i + r + 1) - at(i - r);
			}
		}
	}
}

/**
 * 毛玻璃：盒式模糊 3 遍（接近高斯模糊）+ 每个像素从附近随机位置取色。px 是 ch 通道交错的 8 位像素，返回新的数组。
 * 和 apps/web/src/viewer/frost.ts 是同一个算法。
 */
export function frost(px, w, h, ch = 3) {
	const L = Math.max(w, h);
	const rb = Math.max(1, Math.round(L * FROST_BLUR));
	const rd = Math.max(1, Math.round(L * FROST_SCATTER));
	const a = Uint8Array.from(px);
	const b = new Uint8Array(a.length);
	for (let pass = 0; pass < 3; pass++) {
		boxPass(a, b, w, h, ch, rb, true);
		boxPass(b, a, w, h, ch, rb, false);
	}
	const out = new Uint8Array(a.length);
	const rand = rng(0x6e616e61);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const sx = Math.min(w - 1, Math.max(0, x + Math.round((rand() * 2 - 1) * rd)));
			const sy = Math.min(h - 1, Math.max(0, y + Math.round((rand() * 2 - 1) * rd)));
			const o = (y * w + x) * ch;
			const s = (sy * w + sx) * ch;
			for (let c = 0; c < ch; c++) out[o + c] = a[s + c];
		}
	}
	return out;
}

/** 小图的尺寸：长边 FROST_EDGE（原图更小时不放大）。 */
export function frostSize(w, h) {
	const s = Math.min(1, FROST_EDGE / Math.max(w, h));
	return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))];
}

/** PPM（P6，RGB）或 PGM（P5，灰度）文件，vips 可以直接读。 */
export function netpbm(px, w, h, ch) {
	const head = Buffer.from(`${ch === 3 ? "P6" : "P5"}\n${w} ${h}\n255\n`);
	return Buffer.concat([head, Buffer.from(px.buffer, px.byteOffset, px.byteLength)]);
}
