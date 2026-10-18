/**
 * 查看器“编辑”里的裁切。只影响缩略图和预览，原件不动。
 * 框是 0–1 的比例，相对于用户旋转之后、裁切之前的整张图（也就是编辑界面里看到的方向）。
 */
export interface CropBox {
	x: number;
	y: number;
	w: number;
	h: number;
}

/** 裁切框的最小边长（比例），太小的框没有意义，也避免生成几个像素的预览。 */
export const CROP_MIN = 0.02;

/** 和整张图差这么多以内当作没有裁切。 */
const CROP_EPS = 0.001;

/**
 * 把同一张图上的框换算到顺时针转过 rotation 度之后的图上（和 vips rot / CSS rotate 的方向一致）。
 * 人脸框（用户旋转之前的照片 → 预览）和裁切框（旋转时跟着转）都用它。
 */
export function rotateBox(b: CropBox, rotation: number): CropBox {
	switch (((rotation % 360) + 360) % 360) {
		case 90:
			return { x: 1 - b.y - b.h, y: b.x, w: b.h, h: b.w };
		case 180:
			return { x: 1 - b.x - b.w, y: 1 - b.y - b.h, w: b.w, h: b.h };
		case 270:
			return { x: b.y, y: 1 - b.x - b.w, w: b.h, h: b.w };
		default:
			return b;
	}
}

/** 收进 0–1 之内、不小于 CROP_MIN；覆盖整张图时返回 null（没有裁切）。不合法（NaN 等）也返回 null。 */
export function normalizeCrop(c: CropBox | null | undefined): CropBox | null {
	if (!c || ![c.x, c.y, c.w, c.h].every(Number.isFinite)) return null;
	const w = Math.min(1, Math.max(CROP_MIN, c.w));
	const h = Math.min(1, Math.max(CROP_MIN, c.h));
	const x = Math.min(1 - w, Math.max(0, c.x));
	const y = Math.min(1 - h, Math.max(0, c.y));
	if (x < CROP_EPS && y < CROP_EPS && w > 1 - CROP_EPS && h > 1 - CROP_EPS) return null;
	const r = (n: number) => Math.round(n * 1e6) / 1e6;
	return { x: r(x), y: r(y), w: r(w), h: r(h) };
}

/** assets 表里的四列（都为 null 表示没有裁切）。 */
export function cropOf(a: { crop_x?: number | null; crop_y?: number | null; crop_w?: number | null; crop_h?: number | null }): CropBox | null {
	if (a.crop_x == null || a.crop_y == null || a.crop_w == null || a.crop_h == null) return null;
	return { x: a.crop_x, y: a.crop_y, w: a.crop_w, h: a.crop_h };
}

/** 裁切后的尺寸（width / height 是旋转之后、裁切之前的尺寸）。 */
export function croppedSize(width: number, height: number, crop: CropBox | null): [number, number] {
	if (!crop) return [width, height];
	return [Math.max(1, Math.round(width * crop.w)), Math.max(1, Math.round(height * crop.h))];
}
