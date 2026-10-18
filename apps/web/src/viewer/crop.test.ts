import { normalizeCrop, rotateBox } from "@nana/shared";
import { describe, expect, it } from "vitest";
import { dragCrop } from "./Editor";
import { cropFaceBox, displayDims } from "./media";
import type { AssetDetail } from "./types";

const close = (a: { x: number; y: number; w: number; h: number }, b: typeof a) => {
	for (const k of ["x", "y", "w", "h"] as const) expect(a[k]).toBeCloseTo(b[k], 6);
};

describe("normalizeCrop", () => {
	it("treats the whole picture as no crop", () => {
		expect(normalizeCrop({ x: 0, y: 0, w: 1, h: 1 })).toBeNull();
		expect(normalizeCrop({ x: 0.0002, y: 0, w: 0.9995, h: 1 })).toBeNull();
		expect(normalizeCrop(null)).toBeNull();
		expect(normalizeCrop({ x: Number.NaN, y: 0, w: 1, h: 1 })).toBeNull();
	});
	it("keeps the box inside the picture", () => {
		expect(normalizeCrop({ x: 0.8, y: -0.1, w: 0.5, h: 0.5 })).toEqual({ x: 0.5, y: 0, w: 0.5, h: 0.5 });
		expect(normalizeCrop({ x: 0.2, y: 0.2, w: 0, h: 2 })).toEqual({ x: 0.2, y: 0, w: 0.02, h: 1 });
	});
});

describe("rotating a crop", () => {
	it("four quarter turns come back to the same box", () => {
		const b = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 };
		let r = b;
		for (let i = 0; i < 4; i++) r = rotateBox(r, 90);
		close(r, b);
		close(rotateBox(rotateBox(b, 90), 180), rotateBox(b, 270));
	});
});

describe("dragCrop", () => {
	const c = { x: 0.2, y: 0.2, w: 0.5, h: 0.5 };
	it("moves the box without leaving the picture", () => {
		close(dragCrop(c, "move", 0.1, -0.1), { x: 0.3, y: 0.1, w: 0.5, h: 0.5 });
		close(dragCrop(c, "move", 1, 1), { x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
	});
	it("drags edges and corners, stopping at the picture and a minimum size", () => {
		close(dragCrop(c, "se", 0.1, 0.1), { x: 0.2, y: 0.2, w: 0.6, h: 0.6 });
		close(dragCrop(c, "nw", -1, -1), { x: 0, y: 0, w: 0.7, h: 0.7 });
		close(dragCrop(c, "e", -1, 0), { x: 0.2, y: 0.2, w: 0.05, h: 0.5 });
		close(dragCrop(c, "n", 0, 1), { x: 0.2, y: 0.65, w: 0.5, h: 0.05 });
	});
});

describe("faces on a cropped preview", () => {
	it("maps boxes into the crop and hides faces outside it", () => {
		const crop = { x: 0.5, y: 0, w: 0.5, h: 0.5 };
		close(cropFaceBox({ x: 0.6, y: 0.1, w: 0.1, h: 0.1 }, crop)!, { x: 0.2, y: 0.2, w: 0.2, h: 0.2 });
		expect(cropFaceBox({ x: 0.1, y: 0.1, w: 0.1, h: 0.1 }, crop)).toBeNull();
		expect(cropFaceBox({ x: 0.1, y: 0.1, w: 0.1, h: 0.1 }, null)).toEqual({ x: 0.1, y: 0.1, w: 0.1, h: 0.1 });
	});
});

describe("displayDims", () => {
	it("returns the cropped size", () => {
		const a = { width: 4000, height: 3000, crop_x: 0.1, crop_y: 0, crop_w: 0.5, crop_h: 0.25 } as AssetDetail;
		expect(displayDims(a)).toEqual([2000, 750]);
		expect(displayDims({ ...a, crop_x: null, crop_y: null, crop_w: null, crop_h: null })).toEqual([4000, 3000]);
	});
});
