import { describe, expect, it } from "vitest";
import { hdPlan, rotateFaceBox } from "./media";
import type { AssetDetail } from "./types";

const asset = (o: Partial<AssetDetail> & { mime?: string; size?: number }): AssetDetail =>
	({
		id: "A",
		kind: "photo",
		width: 4032,
		height: 3024,
		preview_edge: 3840,
		files: [{ role: "original", mime: o.mime ?? "image/jpeg", size: o.size ?? 3_000_000, original_name: null }],
		...o,
	}) as AssetDetail;

describe("hdPlan", () => {
	it("says the preview is already the best when it covers the original", () => {
		expect(hdPlan(asset({ width: 3000, height: 2000 }))).toEqual({ kind: "best" });
		expect(hdPlan(asset({ preview_edge: 4032 }))).toEqual({ kind: "best" });
		// 超过像素上限的照片，全尺寸预览按上限生成，生成过就是最高清
		expect(hdPlan(asset({ width: 12000, height: 8000, preview_edge: 9486 }))).toEqual({ kind: "best" });
	});

	it("loads browser-decodable originals directly", () => {
		expect(hdPlan(asset({}))).toEqual({ kind: "direct", url: "/api/a/A/original", heic: false });
	});

	it("asks the server for undecodable, oversized or huge originals", () => {
		expect(hdPlan(asset({ mime: "image/heic" }))).toEqual({ kind: "upgrade" }); // 测试环境不是 Safari
		expect(hdPlan(asset({ mime: "image/x-sony-arw" }))).toEqual({ kind: "upgrade" });
		expect(hdPlan(asset({ size: 50 * 1024 ** 2 }))).toEqual({ kind: "upgrade" });
		expect(hdPlan(asset({ width: 12000, height: 8000 }))).toEqual({ kind: "upgrade" });
	});

	it("has nothing for videos or unknown sizes", () => {
		expect(hdPlan(asset({ kind: "video" }))).toBeNull();
		expect(hdPlan(asset({ width: null }))).toBeNull();
	});
});

describe("rotateFaceBox", () => {
	const b = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 };
	const close = (a: object, e: object) => Object.entries(e).forEach(([k, v]) => expect((a as Record<string, number>)[k]).toBeCloseTo(v));
	it("0° 不变", () => expect(rotateFaceBox(b, 0)).toEqual(b));
	it("顺时针 90°：左上角到右上角", () => close(rotateFaceBox(b, 90), { x: 0.4, y: 0.1, w: 0.4, h: 0.3 }));
	it("180°", () => close(rotateFaceBox(b, 180), { x: 0.6, y: 0.4, w: 0.3, h: 0.4 }));
	it("270°", () => close(rotateFaceBox(b, 270), { x: 0.2, y: 0.6, w: 0.4, h: 0.3 }));
	it("转四次回到原处", () => close([90, 90, 90, 90].reduce((r, d) => rotateFaceBox(r, d), b), b));
});
