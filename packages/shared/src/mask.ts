/**
 * 查看器“编辑”里的打码（毛玻璃）。只影响缩略图和预览，原件不动；被盖住的脸不参与人物识别。
 *
 * 涂抹的笔画存在 assets.mask（encodeMask 的字符串，也原样作为容器的 x-mask 头和设备端计划的 mask）。
 * 坐标是 0–1 的比例，相对于用户旋转之前的整张图（EXIF 方向已校正，和人脸框同一个方向），所以旋转、裁切都不用换算笔画；
 * 半径是长边的比例。容器按同样的格式解码（apps/processor/mask.mjs），改格式时两边一起改。
 */
export interface MaskStroke {
	/** 笔刷半径，长边的比例 */
	r: number;
	/** 点 [x0, y0, x1, y1, …]，只有一个点时是一个圆点 */
	p: number[];
}

/** 整个打码最多这么多个点：编码后约 8 KB，作为请求头发给容器还算小。前端涂抹结束时先简化笔画。 */
export const MASK_MAX_POINTS = 2000;
export const MASK_MAX_STROKES = 200;
/** 人脸框被盖住这么大的比例就算打码了，不参与人物识别。 */
export const MASK_FACE_COVER = 0.5;

const VERSION = 1;
const Q = 65535;
const R_MIN = 0.002;
const R_MAX = 0.25;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

function toBase64Url(bytes: Uint8Array): string {
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): Uint8Array | null {
	if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
	try {
		const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
		const out = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
		return out;
	} catch {
		return null;
	}
}

/**
 * 编码成 base64url：uint16 小端 [版本, 笔画数, 每笔：半径, 点数, x0, y0, …]，坐标量化到 1/65535。
 * 没有笔画时返回 null（没有打码）。超出上限时抛错。
 */
export function encodeMask(strokes: MaskStroke[]): string | null {
	const list = strokes.filter((s) => s.p.length >= 2 && s.p.length % 2 === 0 && s.p.every(Number.isFinite) && Number.isFinite(s.r));
	if (!list.length) return null;
	const points = list.reduce((n, s) => n + s.p.length / 2, 0);
	if (list.length > MASK_MAX_STROKES || points > MASK_MAX_POINTS) throw new Error("mask too large");
	const words = new Uint16Array(2 + list.length * 2 + points * 2);
	let o = 0;
	words[o++] = VERSION;
	words[o++] = list.length;
	for (const s of list) {
		words[o++] = Math.round(Math.min(R_MAX, Math.max(R_MIN, s.r)) * Q);
		words[o++] = s.p.length / 2;
		for (const v of s.p) words[o++] = Math.round(clamp01(v) * Q);
	}
	const bytes = new Uint8Array(words.length * 2);
	for (let i = 0; i < words.length; i++) {
		bytes[i * 2] = words[i]! & 0xff;
		bytes[i * 2 + 1] = words[i]! >> 8;
	}
	return toBase64Url(bytes);
}

/** 解码；不合法（格式不对、超出上限）时返回 null。 */
export function decodeMask(s: string | null | undefined): MaskStroke[] | null {
	if (!s) return null;
	const bytes = fromBase64Url(s);
	if (!bytes || bytes.length % 2 || bytes.length < 4) return null;
	const words = new Uint16Array(bytes.length / 2);
	for (let i = 0; i < words.length; i++) words[i] = bytes[i * 2]! | (bytes[i * 2 + 1]! << 8);
	if (words[0] !== VERSION) return null;
	const count = words[1]!;
	if (!count || count > MASK_MAX_STROKES) return null;
	const out: MaskStroke[] = [];
	let o = 2;
	let points = 0;
	for (let i = 0; i < count; i++) {
		if (o + 2 > words.length) return null;
		const r = words[o++]! / Q;
		const n = words[o++]!;
		points += n;
		if (!n || r <= 0 || points > MASK_MAX_POINTS || o + n * 2 > words.length) return null;
		out.push({ r, p: Array.from(words.subarray(o, o + n * 2), (v) => v / Q) });
		o += n * 2;
	}
	return o === words.length ? out : null;
}

/** 把同一张图上的点换算到顺时针转过 rotation 度之后的图上（和 rotateBox 一致）。 */
export function rotatePoint(x: number, y: number, rotation: number): [number, number] {
	switch (((rotation % 360) + 360) % 360) {
		case 90:
			return [1 - y, x];
		case 180:
			return [1 - x, 1 - y];
		case 270:
			return [y, 1 - x];
		default:
			return [x, y];
	}
}

/** 点 (px, py) 到线段 (ax, ay)–(bx, by) 的距离的平方。 */
function segDist2(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
	const dx = bx - ax;
	const dy = by - ay;
	const len2 = dx * dx + dy * dy;
	const t = len2 ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
	const ex = px - ax - t * dx;
	const ey = py - ay - t * dy;
	return ex * ex + ey * ey;
}

/** 点（0–1 的比例）是否被笔画盖住。aspect = 宽 / 高（用户旋转之前的方向）。 */
function covered(strokes: MaskStroke[], x: number, y: number, sx: number, sy: number) {
	for (const s of strokes) {
		const r2 = s.r * s.r;
		const p = s.p;
		if (p.length === 2) {
			if (segDist2(x * sx, y * sy, p[0]! * sx, p[1]! * sy, p[0]! * sx, p[1]! * sy) <= r2) return true;
			continue;
		}
		for (let i = 2; i < p.length; i += 2) {
			if (segDist2(x * sx, y * sy, p[i - 2]! * sx, p[i - 1]! * sy, p[i]! * sx, p[i + 1]! * sy) <= r2) return true;
		}
	}
	return false;
}

/**
 * 框（0–1 的比例，和笔画同一个方向）被盖住的比例，按 12×12 个采样点估算。
 * aspect = 宽 / 高（用户旋转之前的方向）：半径是长边的比例，要换算到同一个尺度上比较距离。
 */
export function maskCoverage(strokes: MaskStroke[], box: { x: number; y: number; w: number; h: number }, aspect: number): number {
	const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
	const sx = a >= 1 ? 1 : a;
	const sy = a >= 1 ? 1 / a : 1;
	const N = 12;
	let hit = 0;
	for (let j = 0; j < N; j++) {
		for (let i = 0; i < N; i++) {
			if (covered(strokes, box.x + ((i + 0.5) / N) * box.w, box.y + ((j + 0.5) / N) * box.h, sx, sy)) hit++;
		}
	}
	return hit / (N * N);
}
