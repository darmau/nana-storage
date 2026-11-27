import type { TimelineItem } from "./types";
import type { GridStyle } from "../ui/gridStyle";

/**
 * 两种网格布局，由 LayoutConfig.cols 区分：
 *  - cols = 0：justified 布局——同一天的照片排成若干行，每行等高、宽度刚好撑满容器，最后一行不拉伸。
 *    纵横比限制在 [0.5, 3]，避免超长全景图把一行挤成细条。
 *  - cols > 0：方形网格——一行固定 cols 张、正方形格子（居中裁切），最后一行不满时左对齐、不拉伸。
 */

export interface LayoutConfig {
	width: number;
	rowHeight: number;
	gap: number;
	/** 方形网格的列数；0 表示 justified（自适应比例）布局。 */
	cols: number;
	monthHeaderHeight: number;
	dayHeaderHeight: number;
}

export interface Tile {
	/** 在月份数据里的下标 */
	index: number;
	left: number;
	width: number;
}
export interface Row {
	top: number;
	height: number;
	tiles: Tile[];
}
export interface DayHeader {
	day: string | null;
	top: number;
	/** 这一天的照片在数据里的下标范围 [start, end) */
	start: number;
	end: number;
}
export interface MonthLayout {
	height: number;
	rows: Row[];
	days: DayHeader[];
}

const aspect = (it: TimelineItem) => Math.min(3, Math.max(0.5, it[1] / Math.max(1, it[2])));

function layoutJustified(items: TimelineItem[], cfg: LayoutConfig): MonthLayout {
	const { width, rowHeight, gap } = cfg;
	const rows: Row[] = [];
	const days: DayHeader[] = [];
	let y = cfg.monthHeaderHeight;

	let i = 0;
	while (i < items.length) {
		const day = items[i]![4];
		const header: DayHeader = { day, top: y, start: i, end: i };
		days.push(header);
		y += cfg.dayHeaderHeight;

		let row: { index: number; a: number }[] = [];
		let sumA = 0;
		const flush = (stretch: boolean) => {
			if (!row.length) return;
			const gaps = gap * (row.length - 1);
			const h = stretch ? (width - gaps) / sumA : Math.min(rowHeight, (width - gaps) / sumA);
			let x = 0;
			const tiles = row.map(({ index, a }, k) => {
				// 最后一张吃掉舍入误差，保证右边对齐
				const w = stretch && k === row.length - 1 ? width - x : a * h;
				const t = { index, left: x, width: w };
				x += w + gap;
				return t;
			});
			rows.push({ top: y, height: h, tiles });
			y += h + gap;
			row = [];
			sumA = 0;
		};

		while (i < items.length && items[i]![4] === day) {
			const a = aspect(items[i]!);
			row.push({ index: i, a });
			sumA += a;
			if (sumA * rowHeight + gap * (row.length - 1) >= width) flush(true);
			i++;
		}
		flush(false);
		header.end = i;
	}
	return { height: Math.ceil(y), rows, days };
}

function layoutSquare(items: TimelineItem[], cfg: LayoutConfig): MonthLayout {
	const { width, gap, cols } = cfg;
	const cell = (width - gap * (cols - 1)) / cols;
	const rows: Row[] = [];
	const days: DayHeader[] = [];
	let y = cfg.monthHeaderHeight;

	let i = 0;
	while (i < items.length) {
		const day = items[i]![4];
		const header: DayHeader = { day, top: y, start: i, end: i };
		days.push(header);
		y += cfg.dayHeaderHeight;

		let tiles: Tile[] = [];
		let rowTop = y;
		const flush = () => {
			rows.push({ top: rowTop, height: cell, tiles });
			y += cell + gap;
			rowTop = y;
			tiles = [];
		};

		while (i < items.length && items[i]![4] === day) {
			tiles.push({ index: i, left: tiles.length * (cell + gap), width: cell });
			i++;
			if (tiles.length === cols) flush();
		}
		if (tiles.length) flush();
		header.end = i;
	}
	return { height: Math.ceil(y), rows, days };
}

export function layoutMonth(items: TimelineItem[], cfg: LayoutConfig): MonthLayout {
	return cfg.cols > 0 ? layoutSquare(items, cfg) : layoutJustified(items, cfg);
}

/** 还没加载的月份：按张数估算高度（假设每 8 张一天、每天平均多出半行；方形网格每行张数固定为 cols）。 */
export function estimateMonthHeight(count: number, cfg: LayoutConfig): number {
	const perRow = cfg.cols > 0 ? cfg.cols : Math.max(1, cfg.width / cfg.rowHeight);
	const rowH = cfg.cols > 0 ? (cfg.width - cfg.gap * (cfg.cols - 1)) / cfg.cols : cfg.rowHeight;
	const days = Math.min(31, Math.max(1, Math.ceil(count / 8)));
	const rows = Math.ceil(count / perRow + days / 2);
	return Math.ceil(cfg.monthHeaderHeight + days * cfg.dayHeaderHeight + rows * (rowH + cfg.gap));
}

/**
 * 手机（width < 640）上的网格样式：
 *  - "square"（默认）：方形 3 列，和 iOS 相册一样，格子大小 = (width - 2*gap) / 3。
 *  - "justified"：原来的自适应比例，行高按宽度算（0.46 时大多数行正好三张）。
 * 平板和桌面（width ≥ 640）始终是 justified、行高 200。
 */
export function layoutConfig(width: number, style: GridStyle): LayoutConfig {
	const small = width < 640;
	if (small && style === "square") {
		const gap = 2;
		const cols = 3;
		return { width, rowHeight: (width - gap * (cols - 1)) / cols, gap, cols, monthHeaderHeight: 48, dayHeaderHeight: 32 };
	}
	const rowHeight = small ? Math.min(200, Math.round(width * 0.46)) : 200;
	return { width, rowHeight, gap: small ? 2 : 4, cols: 0, monthHeaderHeight: 48, dayHeaderHeight: 32 };
}
