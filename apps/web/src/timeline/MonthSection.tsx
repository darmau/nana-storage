import { useQuery } from "@tanstack/react-query";
import { memo, useCallback, useMemo } from "react";
import { GridWindow, renderWindow } from "../library/GridWindow";
import { formatMonth } from "./format";
import { type LayoutConfig, estimateMonthHeight, layoutMonth } from "./layout";
import { monthQuery } from "./queries";

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
	const layout = useMemo(() => (data && cfg.width > 0 ? layoutMonth(data, cfg) : null), [data, cfg]);
	const height = layout?.height ?? estimateMonthHeight(count, cfg);
	const { lo, hi } = renderWindow(viewTop, viewHeight);
	const open = useCallback((id: string) => onOpen(id, month), [onOpen, month]);

	return (
		<section style={{ height, position: "relative" }} aria-label={formatMonth(month)}>
			<h2 className="absolute left-0 top-0 flex h-12 items-center pl-1 text-xl font-bold tracking-tight">{formatMonth(month)}</h2>
			{layout ? (
				<GridWindow layout={layout} items={data!} lo={lo} hi={hi} showDays scope={month} onOpen={open} />
			) : (
				<div className="absolute inset-x-0 bottom-0 top-12 rounded-xl bg-surface/70" />
			)}
		</section>
	);
});
