import { useQueries, useQuery } from "@tanstack/react-query";
import { memo, useCallback, useMemo } from "react";
import { GridWindow, renderWindow } from "../library/GridWindow";
import { formatMonth } from "./format";
import { isExpanded, useExpandVersion } from "./expand";
import { type LayoutConfig, estimateMonthHeight, layoutMonth } from "./layout";
import { monthQuery, stackQuery } from "./queries";
import type { TimelineItem } from "./types";

interface Props {
	month: string;
	count: number;
	cfg: LayoutConfig;
	/** 视口相对于本月顶部的位置 */
	viewTop: number;
	viewHeight: number;
	onOpen: (id: string, month: string) => void;
}

export const MonthSection = memo(function MonthSection({ month, count, cfg, viewTop, viewHeight, onOpen }: Props) {
	// 拖动拖动条 / 快速滚动期间 Timeline 不挂载任何月份，所以经过的月份不会请求
	const { data } = useQuery(monthQuery(month));
	// 展开状态变化时重算有效列表和布局；展开的组按需取成员，取到之前先保持折叠
	const expandVersion = useExpandVersion();
	const expandedHere = useMemo(() => (data ?? []).filter((it) => it[9] && isExpanded(it[9])), [data, expandVersion]);
	const memberQueries = useQueries({ queries: expandedHere.map((it) => stackQuery(it[9]!, it[4])) });
	// 用 dataUpdatedAt 当依赖：滚动引起的重渲染不重算布局
	const stamps = memberQueries.map((q) => q.dataUpdatedAt).join("|");
	const effective = useMemo(() => {
		if (!data) return null;
		const members = new Map<string, TimelineItem[]>();
		expandedHere.forEach((it, i) => {
			const r = memberQueries[i]?.data;
			if (r?.items.length) members.set(it[9]!, [...r.items].reverse());
		});
		if (!members.size) return data;
		return data.flatMap((it) => (it[9] && members.get(it[9])) || [it]);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [data, expandedHere, stamps]);
	const layout = useMemo(() => (effective && cfg.width > 0 ? layoutMonth(effective, cfg) : null), [effective, cfg]);
	const height = layout?.height ?? estimateMonthHeight(count, cfg);
	const { lo, hi } = renderWindow(viewTop, viewHeight);
	const open = useCallback((id: string) => onOpen(id, month), [onOpen, month]);

	return (
		<section style={{ height, position: "relative" }} aria-label={formatMonth(month)}>
			<h2 className="absolute left-0 top-0 flex h-12 items-center pl-1 text-xl font-bold tracking-tight">{formatMonth(month)}</h2>
			{layout ? (
				<GridWindow layout={layout} items={effective!} lo={lo} hi={hi} showDays scope={month} onOpen={open} />
			) : (
				<div className="absolute inset-x-0 bottom-0 top-12 rounded-xl bg-surface/70" />
			)}
		</section>
	);
});
