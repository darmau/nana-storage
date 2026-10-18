import type { TimelineItem } from "./types";

/**
 * Justified 布局：同一天的照片排成若干行，每行等高、宽度刚好撑满容器。
 * 最后一行不拉伸。纵横比限制在 [0.5, 3]，避免超长全景图把一行挤成细条。
 */

export interface LayoutConfig {
	width: number;
	rowHeight: number;
	gap: number;
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

export function layoutMonth(items: TimelineItem[], cfg: LayoutConfig): MonthLayout {
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

/** 还没加载的月份：按张数估算高度（假设平均纵横比约 1、每 8 张一天、每天平均多出半行）。 */
export function estimateMonthHeight(count: number, cfg: LayoutConfig): number {
	const perRow = Math.max(1, cfg.width / cfg.rowHeight);
	const days = Math.min(31, Math.max(1, Math.ceil(count / 8)));
	const rows = Math.ceil(count / perRow + days / 2);
	return Math.ceil(cfg.monthHeaderHeight + days * cfg.dayHeaderHeight + rows * (cfg.rowHeight + cfg.gap));
}

/**
 * 小屏幕的行高按宽度算：手机上常见的是竖拍（3:4）为主、夹着横拍，
 * 宽度的 0.46 时大多数行正好三张（固定 130px 时大多是四张以上，显得太小）。
 * 不超过大屏幕的 200，横屏或较宽的小窗口不会变得过大。
 */
export function layoutConfig(width: number): LayoutConfig {
	const small = width < 640;
	const rowHeight = small ? Math.min(200, Math.round(width * 0.46)) : 200;
	return { width, rowHeight, gap: small ? 2 : 4, monthHeaderHeight: 48, dayHeaderHeight: 32 };
}
