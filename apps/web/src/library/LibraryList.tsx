import { useInfiniteQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { errorText } from "../api";
import { useCallback, useMemo, useRef } from "react";
import type { TimelineItem } from "../timeline/types";
import { listNav } from "../viewer/sequence";
import { Viewer } from "../viewer/Viewer";
import { AssetGrid } from "./AssetGrid";
import { AssetRows } from "./AssetRows";
import { type ListSource, listQuery, sampleConflict } from "./queries";
import { AssetActionsProvider, type BarContext, SelectionBar } from "./SelectionBar";
import { SelectionProvider } from "./selection";
import { type TileMark, TileMarks } from "./Tile";
import { t } from "../i18n";
import { GridSkeleton } from "../ui/Skeleton";

/** 文件夹/相册/收藏/回收站共用：网格 + 多选操作栏 + 查看器（?a=）。 */
export function LibraryList({
	source,
	context,
	groupByDay = true,
	datedScrubber = false,
	view = "grid",
	empty,
}: {
	source: ListSource;
	context: BarContext;
	groupByDay?: boolean;
	/** 拖动条带年份 / 月份：只有相册、文件夹（按拍摄时间排序）这样用，其余列表只显示手柄 */
	datedScrubber?: boolean;
	/** list：一行一个条目（文件夹的列表视图），source 的接口要带 ?view=list 才有文件名和大小 */
	view?: "grid" | "list";
	empty: React.ReactNode;
}) {
	const query = useInfiniteQuery(listQuery(source));
	const items = useMemo<TimelineItem[]>(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data]);
	const details = useMemo(
		() => (view === "list" ? (query.data?.pages.flatMap((p) => p.details ?? p.items.map(() => undefined)) ?? []) : []),
		[query.data, view],
	);
	// 主题的样本列表：每个格子标出正例 / 反例 / 矛盾
	const marks = useMemo(() => {
		const pages = query.data?.pages;
		if (!pages?.some((p) => p.marks)) return null;
		const map = new Map<string, TileMark>();
		for (const p of pages)
			p.marks?.forEach(([label, score], i) => {
				const item = p.items[i];
				if (item) map.set(item[0], { label, conflict: sampleConflict(label, score) });
			});
		return map;
	}, [query.data]);
	const search = useSearch({ strict: false }) as { a?: string };
	const navigate = useNavigate();
	const openedHere = useRef(false);

	const setA = useCallback(
		(a: string | undefined, replace: boolean) =>
			void navigate({ to: ".", search: (prev: Record<string, unknown>) => ({ ...prev, a }), replace, resetScroll: false }),
		[navigate],
	);
	const open = useCallback(
		(id: string) => {
			openedHere.current = true;
			setA(id, false);
		},
		[setA],
	);
	const close = useCallback(() => {
		if (openedHere.current) {
			openedHere.current = false;
			window.history.back();
		} else setA(undefined, true);
	}, [setA]);

	const loadMore = useCallback(() => {
		if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
	}, [query]);
	const loadMoreForViewer = query.hasNextPage
		? async () => (await query.fetchNextPage()).data?.pages.flatMap((p) => p.items) ?? items
		: null;

	if (query.error) return <p className="text-danger">{t.common.loadFailed(errorText(query.error))}</p>;
	return (
		<SelectionProvider>
			<AssetActionsProvider context={context}>
				{query.isPending ? (
					<GridSkeleton view={view} />
				) : query.isSuccess && items.length === 0 ? (
					empty != null && <div className="py-16 text-center text-sm text-muted">{empty}</div>
				) : view === "list" ? (
					<AssetRows
						items={items}
						details={details}
						months={query.data?.pages[0]?.months}
						scrubber={context.kind === "trash" ? false : datedScrubber ? "dated" : "plain"}
						hasMore={!!query.hasNextPage}
						loadingMore={query.isFetchingNextPage}
						onLoadMore={loadMore}
						onOpen={open}
					/>
				) : (
					<TileMarks.Provider value={marks}>
						<AssetGrid
							items={items}
							months={query.data?.pages[0]?.months}
							scrubber={context.kind === "trash" ? false : datedScrubber ? "dated" : "plain"}
							groupByDay={groupByDay}
							hasMore={!!query.hasNextPage}
							loadingMore={query.isFetchingNextPage}
							onLoadMore={loadMore}
							onOpen={open}
						/>
					</TileMarks.Provider>
				)}
				<SelectionBar />
				{search.a && (
					<Viewer
						id={search.a}
						nav={listNav(search.a, items, loadMoreForViewer)}
						onNavigate={(n) => setA(n.id, true)}
						onClose={close}
						context={context.kind === "trash" ? "trash" : "library"}
						personId={context.kind === "person" ? context.personId : undefined}
					/>
				)}
			</AssetActionsProvider>
		</SelectionProvider>
	);
}
