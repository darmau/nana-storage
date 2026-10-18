import { memo } from "react";
import type { MonthLayout } from "../timeline/layout";
import type { TimelineItem } from "../timeline/types";
import { DayHeader } from "./DayHeader";
import { useScrubbing } from "./scrub";
import { Tile } from "./Tile";

/** 视口上下各多渲染这么多像素，快速滚动时不容易看到空白。 */
const OVERSCAN_PX = 1200;
/** 渲染范围按这个步长取整：滚动不到一个步长时范围不变，格子不用重新渲染。 */
const STEP_PX = 400;

/** 视口（相对于网格顶部）→ 要渲染的范围 [lo, hi]，一定包含视口上下各 OVERSCAN_PX。 */
export function renderWindow(viewTop: number, viewHeight: number) {
	return {
		lo: Math.floor((viewTop - OVERSCAN_PX) / STEP_PX) * STEP_PX,
		hi: Math.ceil((viewTop + viewHeight + OVERSCAN_PX) / STEP_PX) * STEP_PX,
	};
}

/** 第一个满足 pred 的下标（pred 对有序数组单调） */
function lowerBound<T>(arr: T[], pred: (x: T) => boolean) {
	let a = 0;
	let b = arr.length;
	while (a < b) {
		const m = (a + b) >> 1;
		if (pred(arr[m]!)) b = m;
		else a = m + 1;
	}
	return a;
}

interface Props {
	layout: MonthLayout;
	items: TimelineItem[];
	lo: number;
	hi: number;
	showDays: boolean;
	/** Shift 范围选择用的分组（时间线里是月份） */
	scope?: string;
	onOpen: (id: string) => void;
}

/**
 * 时间线的每个月和文件夹 / 相册等列表共用：只渲染 [lo, hi] 范围内的日期标题和行，离开范围的格子直接卸载，
 * 所以 DOM 节点数只和视口大小有关。行按 top 递增，用二分查找定位，几万张的列表滚动时也不用遍历全部行。
 * 拖动拖动条或快速滚动期间什么都不画（父元素的 .scrub-placeholder 背景就是占位）。
 */
export const GridWindow = memo(function GridWindow({ layout, items, lo, hi, showDays, scope, onOpen }: Props) {
	const scrubbing = useScrubbing();
	if (scrubbing) return null;

	const { rows, days } = layout;
	const r0 = lowerBound(rows, (r) => r.top + r.height >= lo);
	const r1 = lowerBound(rows, (r) => r.top > hi);
	const d0 = showDays ? lowerBound(days, (d) => d.top >= lo) : 0;
	const d1 = showDays ? lowerBound(days, (d) => d.top > hi) : 0;

	return (
		<>
			{days.slice(d0, d1).map((d) => (
				<DayHeader key={d.top} day={d.day} top={d.top} items={items.slice(d.start, d.end)} />
			))}
			{rows.slice(r0, r1).flatMap((r) =>
				r.tiles.map((t) => {
					const it = items[t.index]!;
					return <Tile key={it[0]} item={it} top={r.top} left={t.left} width={t.width} height={r.height} scope={scope} onOpen={onOpen} />;
				}),
			)}
		</>
	);
});
