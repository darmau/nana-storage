import { describe, expect, it } from "vitest";
import { estimateMonthHeight, layoutConfig, layoutMonth } from "./layout";
import type { TimelineItem } from "./types";

const item = (id: string, w: number, h: number, day: string): TimelineItem => [id, w, h, 0, day, null, 0, 0];
const cfg = { ...layoutConfig(1000, "justified"), rowHeight: 200, gap: 4 };
const square = layoutConfig(375, "square");
const squareCell = (375 - 2 * 2) / 3;

describe("layoutMonth (justified)", () => {
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

describe("layoutMonth (square)", () => {
	it("fills full rows with equal square cells exactly to the container width", () => {
		const items = Array.from({ length: 6 }, (_, i) => item(`p${i}`, 1500, 1000, "2024-05-01"));
		const { rows } = layoutMonth(items, square);
		expect(rows).toHaveLength(2);
		for (const r of rows) {
			expect(r.tiles).toHaveLength(3);
			expect(r.height).toBeCloseTo(squareCell, 5);
			const last = r.tiles.at(-1)!;
			expect(last.left + last.width).toBeCloseTo(375, 5);
			for (const t of r.tiles) expect(t.width).toBeCloseTo(squareCell, 5);
		}
	});

	it("renders every photo as an equal square regardless of aspect", () => {
		const items = [item("pano", 20000, 1000, "d"), item("portrait", 1000, 3000, "d"), item("square", 1000, 1000, "d")];
		const { rows } = layoutMonth(items, square);
		const widths = rows[0]!.tiles.map((t) => t.width);
		expect(widths.every((w) => Math.abs(w - squareCell) < 1e-6)).toBe(true);
	});

	it("leaves the last row left-aligned without stretching", () => {
		const { rows } = layoutMonth([item("a", 1000, 1000, "d")], square);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.tiles).toHaveLength(1);
		expect(rows[0]!.tiles[0]!.left).toBe(0);
		expect(rows[0]!.tiles[0]!.width).toBeCloseTo(squareCell, 5);
	});

	it("starts a new row for each day", () => {
		const items = [item("a", 1, 1, "2024-05-03"), item("b", 1, 1, "2024-05-03"), item("c", 1, 1, "2024-05-01")];
		const { rows, days } = layoutMonth(items, square);
		expect(days.map((d) => d.day)).toEqual(["2024-05-03", "2024-05-01"]);
		expect(rows.map((r) => r.tiles.map((t) => t.index))).toEqual([[0, 1], [2]]);
	});
});

describe("estimateMonthHeight", () => {
	it("is in the same ballpark as the real justified layout", () => {
		const items = Array.from({ length: 300 }, (_, i) =>
			item(`p${i}`, i % 2 ? 4032 : 3024, i % 2 ? 3024 : 4032, `2024-05-${String(Math.floor(i / 10) + 1).padStart(2, "0")}`),
		);
		const real = layoutMonth(items, cfg).height;
		const est = estimateMonthHeight(300, cfg);
		expect(est / real).toBeGreaterThan(0.6);
		expect(est / real).toBeLessThan(1.6);
	});

	it("is in the same ballpark as the real square layout", () => {
		const items = Array.from({ length: 30 }, (_, i) => item(`p${i}`, 4032, 3024, `2024-05-${String(Math.floor(i / 10) + 1).padStart(2, "0")}`));
		const real = layoutMonth(items, square).height;
		const est = estimateMonthHeight(30, square);
		expect(est / real).toBeGreaterThan(0.5);
		expect(est / real).toBeLessThan(1.6);
	});
});

describe("layoutConfig", () => {
	it("keeps justified on wide screens regardless of style", () => {
		expect(layoutConfig(1000, "square").cols).toBe(0);
		expect(layoutConfig(1000, "justified").cols).toBe(0);
		expect(layoutConfig(600, "justified").cols).toBe(0);
		expect(layoutConfig(1200, "justified").rowHeight).toBe(200);
	});

	it("uses three square columns on small screens by default", () => {
		for (const width of [320, 375, 393, 430]) {
			const c = layoutConfig(width, "square");
			expect(c.cols).toBe(3);
			expect(c.gap).toBe(2);
			expect(c.rowHeight).toBeCloseTo((width - 4) / 3, 5);
		}
	});

	it("keeps the old justified sizing when requested on small screens", () => {
		for (const width of [320, 375, 393, 430]) {
			const c = layoutConfig(width, "justified");
			expect(c.cols).toBe(0);
			expect(3 * 0.75 * c.rowHeight + 2 * c.gap).toBeGreaterThanOrEqual(width);
			expect(2 * 0.75 * c.rowHeight + c.gap).toBeLessThan(width);
		}
		expect(layoutConfig(600, "justified").rowHeight).toBe(200);
	});
});
