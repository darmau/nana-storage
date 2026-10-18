import { type MaskStroke, rotatePoint } from "@nana/shared";

/**
 * 编辑界面的打码预览：和容器同一个毛玻璃算法（apps/processor/mask.mjs 的 frost，常数也一样），
 * 在长边 FROST_EDGE 的小图上算一次，再按笔画画出的蒙版露出来，CSS 放大到底图大小，和生成出来的预览看起来一致。
 * 改算法时两边一起改。
 */

const FROST_EDGE = 1024;
const FROST_BLUR = 0.02;
const FROST_SCATTER = 0.012;

function rng(seed: number) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function boxPass(src: Uint8ClampedArray, dst: Uint8ClampedArray, w: number, h: number, ch: number, r: number, horizontal: boolean) {
	const n = horizontal ? w : h;
	const lines = horizontal ? h : w;
	const stride = horizontal ? ch : w * ch;
	const lineStride = horizontal ? w * ch : ch;
	const div = 2 * r + 1;
	for (let line = 0; line < lines; line++) {
		const base = line * lineStride;
		for (let c = 0; c < ch; c++) {
			const at = (i: number) => src[base + Math.min(n - 1, Math.max(0, i)) * stride + c]!;
			let sum = 0;
			for (let i = -r; i <= r; i++) sum += at(i);
			for (let i = 0; i < n; i++) {
				dst[base + i * stride + c] = Math.round(sum / div);
				sum += at(i + r + 1) - at(i - r);
			}
		}
	}
}

/** 毛玻璃（RGBA，透明度通道同样处理，不透明的图保持不透明）。 */
function frost(px: Uint8ClampedArray, w: number, h: number): Uint8ClampedArray<ArrayBuffer> {
	const ch = 4;
	const L = Math.max(w, h);
	const rb = Math.max(1, Math.round(L * FROST_BLUR));
	const rd = Math.max(1, Math.round(L * FROST_SCATTER));
	const a = Uint8ClampedArray.from(px);
	const b = new Uint8ClampedArray(a.length);
	for (let pass = 0; pass < 3; pass++) {
		boxPass(a, b, w, h, ch, rb, true);
		boxPass(b, a, w, h, ch, rb, false);
	}
	const out = new Uint8ClampedArray(a.length);
	const rand = rng(0x6e616e61);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const sx = Math.min(w - 1, Math.max(0, x + Math.round((rand() * 2 - 1) * rd)));
			const sy = Math.min(h - 1, Math.max(0, y + Math.round((rand() * 2 - 1) * rd)));
			const o = (y * w + x) * ch;
			const s = (sy * w + sx) * ch;
			for (let c = 0; c < ch; c++) out[o + c] = a[s + c]!;
		}
	}
	return out;
}

function canvas(w: number, h: number) {
	const c = document.createElement("canvas");
	c.width = w;
	c.height = h;
	return c;
}

/** 底图（已经加载好的 img）的毛玻璃版本，长边 FROST_EDGE。 */
export function frostImage(img: HTMLImageElement): HTMLCanvasElement {
	const s = Math.min(1, FROST_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
	const w = Math.max(1, Math.round(img.naturalWidth * s));
	const h = Math.max(1, Math.round(img.naturalHeight * s));
	const c = canvas(w, h);
	const ctx = c.getContext("2d", { willReadFrequently: true })!;
	ctx.drawImage(img, 0, 0, w, h);
	const data = ctx.getImageData(0, 0, w, h);
	ctx.putImageData(new ImageData(frost(data.data, w, h), w, h), 0, 0);
	return c;
}

/**
 * 在 out（和毛玻璃同样大小）上画出打码后的覆盖层：笔画盖住的地方是毛玻璃，其余透明。
 * 笔画是相对于旋转之前的整张图，底图转过了 rotation 度，先换算过去。
 */
export function drawMaskOverlay(out: HTMLCanvasElement, frosted: HTMLCanvasElement, strokes: MaskStroke[], rotation: number) {
	const { width: w, height: h } = frosted;
	if (out.width !== w || out.height !== h) {
		out.width = w;
		out.height = h;
	}
	const ctx = out.getContext("2d")!;
	ctx.clearRect(0, 0, w, h);
	if (!strokes.length) return;
	const L = Math.max(w, h);
	ctx.fillStyle = "#000";
	ctx.strokeStyle = "#000";
	ctx.lineCap = "round";
	ctx.lineJoin = "round";
	for (const s of strokes) {
		const pts: [number, number][] = [];
		for (let i = 0; i < s.p.length; i += 2) {
			const [x, y] = rotatePoint(s.p[i]!, s.p[i + 1]!, rotation);
			pts.push([x * w, y * h]);
		}
		if (pts.length === 1) {
			ctx.beginPath();
			ctx.arc(pts[0]![0], pts[0]![1], s.r * L, 0, Math.PI * 2);
			ctx.fill();
			continue;
		}
		ctx.lineWidth = s.r * L * 2;
		ctx.beginPath();
		ctx.moveTo(pts[0]![0], pts[0]![1]);
		for (const [x, y] of pts.slice(1)) ctx.lineTo(x, y);
		ctx.stroke();
	}
	// 只在笔画盖住的地方留下毛玻璃
	ctx.globalCompositeOperation = "source-in";
	ctx.drawImage(frosted, 0, 0);
	ctx.globalCompositeOperation = "source-over";
}

/** Ramer–Douglas–Peucker：去掉偏离折线不到 eps 的点（[x, y] 的列表，单位任意）。 */
export function simplify(pts: [number, number][], eps: number): [number, number][] {
	if (pts.length <= 2) return pts;
	const [ax, ay] = pts[0]!;
	const [bx, by] = pts[pts.length - 1]!;
	const dx = bx - ax;
	const dy = by - ay;
	const len = Math.hypot(dx, dy);
	let best = -1;
	let far = 0;
	for (let i = 1; i < pts.length - 1; i++) {
		const [px, py] = pts[i]!;
		const d = len ? Math.abs(dy * px - dx * py + bx * ay - by * ax) / len : Math.hypot(px - ax, py - ay);
		if (d > far) {
			far = d;
			best = i;
		}
	}
	if (far <= eps) return [pts[0]!, pts[pts.length - 1]!];
	return [...simplify(pts.slice(0, best + 1), eps).slice(0, -1), ...simplify(pts.slice(best), eps)];
}
