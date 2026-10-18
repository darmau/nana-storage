import { useEffect, useMemo, useRef, useState } from "react";
import { layoutConfig, layoutMonth, type MonthLayout } from "../timeline/layout";
import type { Bucket, TimelineItem } from "../timeline/types";
import { useWidth } from "../timeline/useWidth";
import { GridWindow, renderWindow } from "./GridWindow";
import { ListScrubber } from "./ListScrubber";
import { useScrollRoot } from "./scrollRoot";
import { useScrubbing } from "./scrub";
import { sliceBetween, useSelection } from "./selection";

/**
 * 列表网格（文件夹/相册/收藏/回收站/搜索）：已加载的条目一起做 justified 布局，
 * 和时间线一样用 GridWindow 只渲染视口附近的行，离开的格子卸载。
 * 滚到离底部不到两屏时加载下一页；同一时间只有一个请求在跑。
 *
 * 拖动条（在窗口里滚动、条目够多时才有）：
 *  - "dated"（相册、文件夹这类按拍摄时间排序的列表）：带年份刻度和月份标签。总长度和月份位置来自第一页的每月张数，
 *    没加载的部分按已加载部分每张的平均高度估算，网格先撑到估算的总高度；
 *  - "plain"（主题、人物等，顺序不是拍摄时间）：只有手柄，没有日期；有每月张数时同样用它估算总长度，否则只覆盖已加载的部分。
 * 两种都一样：拖动 / 快速滚动期间不加载；停在没加载的位置时，按上面的规则一页一页往下加载，直到覆盖视口，请求数不超过总页数。
 */
/** 条目少于这个数不显示拖动条（大约两三屏，直接滚就够了） */
const SCRUBBER_MIN_ITEMS = 100;

/** 列表按顺序切成月份（只有一页、服务端没给每月张数时用） */
export function monthsOf(items: TimelineItem[]): Bucket[] {
	const out: Bucket[] = [];
	for (const it of items) {
		const month = it[4]?.slice(0, 7) ?? "unknown";
		const last = out[out.length - 1];
		if (last?.month === month) last.count++;
		else out.push({ month, count: 1 });
	}
	return out;
}

/** 第 i 个条目在网格里的位置（它是某一天的第一张时取日期标题的位置） */
function itemTops(layout: MonthLayout, count: number): Float64Array {
	const tops = new Float64Array(count);
	for (const r of layout.rows) for (const t of r.tiles) tops[t.index] = r.top;
	for (const d of layout.days) if (d.start < count) tops[d.start] = d.top;
	return tops;
}

export function AssetGrid({
	items,
	groupByDay,
	hasMore,
	loadingMore,
	onLoadMore,
	onOpen,
	months,
	scrubber = "plain",
}: {
	items: TimelineItem[];
	/** 整个列表的每月张数（第一页带回来的，只有一页时为空） */
	months?: Bucket[];
	/** 拖动条：带日期 / 不带日期 / 没有（回收站按删除时间排序，也不需要） */
	scrubber?: "dated" | "plain" | false;
	groupByDay: boolean;
	hasMore: boolean;
	loadingMore: boolean;
	onLoadMore: () => void;
	onOpen: (id: string) => void;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const width = useWidth(ref);
	const cfg = useMemo(() => ({ ...layoutConfig(width), monthHeaderHeight: 0, dayHeaderHeight: groupByDay ? 32 : 0 }), [width, groupByDay]);
	const layout = useMemo(() => {
		if (!width) return null;
		// 不按天分组时，把所有条目当作同一天
		const list = groupByDay ? items : items.map((it) => [...it.slice(0, 4), "", ...it.slice(5)] as unknown as TimelineItem);
		return layoutMonth(list, cfg);
	}, [items, cfg, groupByDay, width]);

	// Shift 范围选择：在已加载的条目里按显示顺序取
	const { setRange } = useSelection();
	useEffect(() => {
		setRange((from, to, limit) =>
			sliceBetween(
				items.map((it) => it[0]),
				from.id,
				to.id,
				limit,
			),
		);
		return () => setRange(null);
	}, [items, setRange]);

	const root = useScrollRoot();
	// 只保存取整后的渲染范围：滚动没跨过步长时状态不变，不触发重新渲染
	const [view, setView] = useState({ lo: 0, hi: 0, height: 800 });
	useEffect(() => {
		let raf = 0;
		const update = () => {
			raf = 0;
			const el = ref.current;
			if (!el) return;
			const rootTop = root ? root.getBoundingClientRect().top : 0;
			const height = root ? root.clientHeight : window.innerHeight;
			const { lo, hi } = renderWindow(rootTop - el.getBoundingClientRect().top, height);
			setView((v) => (v.lo === lo && v.hi === hi && v.height === height ? v : { lo, hi, height }));
		};
		const onScroll = () => (raf ||= requestAnimationFrame(update));
		update();
		const target: HTMLElement | Window = root ?? window;
		target.addEventListener("scroll", onScroll, { passive: true });
		window.addEventListener("resize", onScroll);
		return () => {
			target.removeEventListener("scroll", onScroll);
			window.removeEventListener("resize", onScroll);
			cancelAnimationFrame(raf);
		};
	}, [root]);

	const loadedHeight = layout?.height ?? 0;
	const scrubbing = useScrubbing();
	useEffect(() => {
		// hi 已经包含视口下方的 overscan，再多看一屏。拖动拖动条 / 快速滚动期间不加载，停下后再从这里接着加载。
		if (hasMore && !loadingMore && !scrubbing && layout && view.hi + view.height > loadedHeight) onLoadMore();
	}, [hasMore, loadingMore, scrubbing, layout, view, loadedHeight, onLoadMore]);

	const dated = scrubber === "dated";
	// 带日期时需要整个列表的每月张数：服务端给的，或者只有一页时自己切；不止一页又没给就不显示拖动条
	const index = useMemo(() => (dated ? (months ?? (hasMore ? null : monthsOf(items))) : []), [dated, months, hasMore, items]);
	const total = useMemo(() => (months ? months.reduce((n, m) => n + m.count, 0) : items.length), [months, items.length]);
	const showScrubber = !!scrubber && !root && index !== null && total >= SCRUBBER_MIN_ITEMS;
	const perItem = items.length ? loadedHeight / items.length : 0;
	const height = hasMore && showScrubber ? loadedHeight + Math.max(0, total - items.length) * perItem : loadedHeight;
	const starts = useMemo(() => {
		if (!showScrubber || !dated || !layout || !index) return [];
		const tops = itemTops(layout, items.length);
		let at = 0;
		return index.map((m) => {
			const y = at < items.length ? tops[at]! : layout.height + (at - items.length) * perItem;
			at += m.count;
			return y;
		});
	}, [showScrubber, dated, layout, index, items.length, perItem]);

	return (
		<>
			<div id="asset-grid" ref={ref} className={`relative ${scrubbing ? "scrub-placeholder" : ""}`} style={{ height }}>
				{layout && <GridWindow layout={layout} items={items} lo={view.lo} hi={view.hi} showDays={groupByDay} onOpen={onOpen} />}
			</div>
			{showScrubber && index && <ListScrubber gridRef={ref} months={index} starts={starts} totalSize={height} dated={dated} />}
		</>
	);
}
