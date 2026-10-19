import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef } from "react";
import { errorText } from "../api";
import { useScrubbing } from "../library/scrub";
import { type Anchor, sliceBetween, useSelection } from "../library/selection";
import { estimateMonthHeight, layoutConfig } from "./layout";
import { MonthSection } from "./MonthSection";
import { bucketsQuery, monthQuery } from "./queries";
import { Scrubber } from "./Scrubber";
import { type Bucket, idsOf } from "./types";
import { useWidth } from "./useWidth";
import { t } from "../i18n";
import { TimelineSkeleton } from "../ui/Skeleton";

/**
 * Shift 范围选择可能跨月（连拍封面代表整组，结果里展开成整组的 id）：从起点所在的月份一路取到终点所在的月份。
 * 中间没加载过的月份会去请求，但凑够 limit 个就停，所以请求数有上限。
 */
async function timelineRange(qc: QueryClient, months: Bucket[], from: Anchor, to: Anchor, limit: number) {
	const order = months.map((m) => m.month);
	const i = from.scope ? order.indexOf(from.scope) : -1;
	const j = to.scope ? order.indexOf(to.scope) : -1;
	if (i < 0 || j < 0) return null;
	const items = (k: number) => qc.ensureQueryData(monthQuery(order[k]!));
	const expand = async (k: number, covers: string[]) => {
		const groups = new Map((await items(k)).map((it) => [it[0], idsOf(it)]));
		return covers.flatMap((id) => groups.get(id) ?? [id]);
	};
	const ids = async (k: number) => (await items(k)).map((it) => it[0]);
	if (i === j) {
		const covers = sliceBetween(await ids(i), from.id, to.id, limit);
		return covers && (await expand(i, covers)).slice(0, limit);
	}

	const step = i < j ? 1 : -1;
	const out: string[] = [];
	for (let k = i; ; k += step) {
		let list = await ids(k);
		if (step < 0) list = list.reverse();
		if (k === i) {
			const a = list.indexOf(from.id);
			if (a < 0) return null;
			list = list.slice(a);
		}
		if (k === j) {
			const b = list.indexOf(to.id);
			if (b < 0) return null;
			list = list.slice(0, b + 1);
		}
		out.push(...(await expand(k, list)));
		if (out.length >= limit || k === j) return out.slice(0, limit);
	}
}

/**
 * 时间线：外层按“月”虚拟化（只挂载视口附近的几个月），
 * 每个月内部再只渲染视口附近的行，所以 DOM 里同时只有几百个节点，与照片总数无关。
 * 先用每月张数估算高度撑出完整的滚动条，月份加载后换成真实高度。
 * 拖动拖动条或快速滚动期间（useScrubbing）一个月份都不挂载，容器本身的背景图案就是占位，
 * 每一帧只剩浏览器自己的滚动；停下后再挂载停下位置的几个月（已经量过的月份高度留在虚拟列表的缓存里）。
 */
export function Timeline({ onOpen }: { onOpen: (id: string, month: string) => void }) {
	const { data: months = [], isLoading, error } = useQuery(bucketsQuery);
	const listRef = useRef<HTMLDivElement>(null);
	const width = useWidth(listRef);
	const cfg = useMemo(() => layoutConfig(width), [width]);

	const qc = useQueryClient();
	const { setRange } = useSelection();
	useEffect(() => {
		setRange((from, to, limit) => timelineRange(qc, months, from, to, limit));
		return () => setRange(null);
	}, [qc, months, setRange]);

	const virtualizer = useWindowVirtualizer({
		count: months.length,
		estimateSize: (i) => estimateMonthHeight(months[i]!.count, cfg),
		getItemKey: (i) => months[i]!.month,
		overscan: 1,
		scrollMargin: listRef.current?.offsetTop ?? 0,
	});

	// 宽度变化后所有月份的高度都会变
	useEffect(() => {
		virtualizer.measure();
	}, [cfg, virtualizer]);

	const scrollOffset = virtualizer.scrollOffset ?? 0;
	const margin = virtualizer.options.scrollMargin;
	const viewHeight = typeof window === "undefined" ? 800 : window.innerHeight;
	const scrubbing = useScrubbing();
	const items = scrubbing ? [] : virtualizer.getVirtualItems();
	const starts = virtualizer.measurementsCache.map((m) => m.start - margin);

	if (error) return <p className="text-danger">{t.common.loadFailed(errorText(error))}</p>;
	if (!isLoading && months.length === 0) {
		return <p className="py-20 text-center text-muted">{t.library.timelineEmpty}</p>;
	}

	return (
		<>
			{isLoading && <TimelineSkeleton />}
			<div
				id="timeline"
				ref={listRef}
				className={`relative ${scrubbing ? "scrub-placeholder" : ""}`}
				style={{ height: virtualizer.getTotalSize() }}
			>
				{width > 0 &&
					items.map((v) => {
						const m = months[v.index]!;
						return (
							<div
								key={v.key}
								data-index={v.index}
								ref={virtualizer.measureElement}
								className="absolute left-0 top-0 w-full"
								style={{ transform: `translateY(${v.start - margin}px)` }}
							>
								<MonthSection
									month={m.month}
									count={m.count}
									cfg={cfg}
									viewTop={scrollOffset - v.start}
									viewHeight={viewHeight}
									onOpen={onOpen}
								/>
							</div>
						);
					})}
			</div>
			<Scrubber
				months={months}
				starts={starts}
				totalSize={virtualizer.getTotalSize()}
				scrollOffset={Math.max(0, scrollOffset - margin)}
				viewHeight={viewHeight}
				onSeek={(offset) => window.scrollTo({ top: offset + margin })}
			/>
		</>
	);
}
