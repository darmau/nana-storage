import { describe, expect, it } from "vitest";
import { estimateMonthHeight, layoutConfig, layoutMonth } from "./layout";
import type { TimelineItem } from "./types";

const item = (id: string, w: number, h: number, day: string): TimelineItem => [id, w, h, 0, day, null, 0, 0];
const cfg = { ...layoutConfig(1000), rowHeight: 200, gap: 4 };

describe("layoutMonth", () => {
	it("fills full rows exactly to the container width", () => {
		const items = Array.from({ length: 10 }, (_, i) => item(`p${i}`, 1500, 1000, "2024-05-01"));
		const { rows } = layoutMonth(items, cfg);
		const full = rows.slice(0, -1);
		expect(full.length).toBeGreaterThan(0);
		for (const r of full) {
			const last = r.tiles.at(-1)!;
			expect(last.left + last.width).toBeCloseTo(1000, 5);
			expect(r.height).toBeLessThanOrEqual(200);
		}
	});

	it("does not stretch the last row", () => {
		const { rows } = layoutMonth([item("a", 1000, 1000, "d")], cfg);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.height).toBe(200);
		expect(rows[0]!.tiles[0]!.width).toBe(200);
	});

	it("starts a new day header and new row for each day, in order", () => {
		const items = [item("a", 1, 1, "2024-05-03"), item("b", 1, 1, "2024-05-03"), item("c", 1, 1, "2024-05-01")];
		const { rows, days, height } = layoutMonth(items, cfg);
		expect(days.map((d) => d.day)).toEqual(["2024-05-03", "2024-05-01"]);
		expect(rows.map((r) => r.tiles.map((t) => t.index))).toEqual([[0, 1], [2]]);
		expect(days[1]!.top).toBeGreaterThan(rows[0]!.top);
		expect(days.map((d) => [d.start, d.end])).toEqual([[0, 2], [2, 3]]);
		expect(height).toBeGreaterThan(rows[1]!.top + rows[1]!.height);
	});

	it("clamps extreme panoramas", () => {
		const { rows } = layoutMonth([item("pano", 20000, 1000, "d")], cfg);
		expect(rows[0]!.tiles[0]!.width).toBeLessThanOrEqual(3 * 200);
	});

	it("handles tens of thousands of items quickly", () => {
		const items = Array.from({ length: 30000 }, (_, i) => item(`p${i}`, i % 3 ? 4032 : 3024, i % 3 ? 3024 : 4032, `2024-05-${String((i % 28) + 1).padStart(2, "0")}`));
		items.sort((a, b) => (a[4]! < b[4]! ? 1 : -1));
		const t = performance.now();
		const { rows } = layoutMonth(items, cfg);
		expect(performance.now() - t).toBeLessThan(200);
		expect(rows.reduce((n, r) => n + r.tiles.length, 0)).toBe(30000);
	});
});

describe("estimateMonthHeight", () => {
	it("is in the same ballpark as the real layout", () => {
		const items = Array.from({ length: 300 }, (_, i) =>
			item(`p${i}`, i % 2 ? 4032 : 3024, i % 2 ? 3024 : 4032, `2024-05-${String(Math.floor(i / 10) + 1).padStart(2, "0")}`),
		);
		const real = layoutMonth(items, cfg).height;
		const est = estimateMonthHeight(300, cfg);
		expect(est / real).toBeGreaterThan(0.6);
		expect(est / real).toBeLessThan(1.6);
	});
});

describe("layoutConfig", () => {
	it("fits about three typical phone photos per row on small screens", () => {
		for (const width of [320, 375, 393, 430]) {
			const c = layoutConfig(width);
			// 三张 3:4 竖拍刚好放不下第四张
			expect(3 * 0.75 * c.rowHeight + 2 * c.gap).toBeGreaterThanOrEqual(width);
			expect(2 * 0.75 * c.rowHeight + c.gap).toBeLessThan(width);
		}
		expect(layoutConfig(600).rowHeight).toBe(200);
		expect(layoutConfig(1200).rowHeight).toBe(200);
	});
});
