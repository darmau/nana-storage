import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { DUPLICATE_IGNORE_MAX } from "@nana/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorText } from "../api";
import { t } from "../i18n";
import { batch, ignoreDuplicates } from "../library/actions";
import { LibraryList } from "../library/LibraryList";
import { type DuplicateGroups, type ListSource, type SimilarResult, listQuery } from "../library/queries";
import { thumbUrl } from "../timeline/types";
import { confirmDialog } from "../ui/confirm";
import { DuplicateGroupsSkeleton } from "../ui/Skeleton";
import { IconDuplicate, IconInfo, IconTrash } from "../ui/icons";
import type { AssetDetail } from "../viewer/types";
import { DuplicateCompare, comparePill } from "./DuplicateCompare";
import { OrganizeTitle } from "./OrganizePages";
import { useDocumentTitle } from "../ui/title";


/** 还没有指纹时的说明（处理时指纹没算出来）。 */
function FingerprintHint() {
	return (
		<p className="flex items-start gap-2.5 rounded-2xl bg-notice px-4 py-3 text-sm">
			<IconInfo size={18} className="mt-0.5 shrink-0 text-muted" />
			<span>{t.similar.hint}</span>
		</p>
	);
}

// ------------------------------------------------------------------ 相似照片（查看器信息面板的“全部”）

export function SimilarPage() {
	useDocumentTitle(t.similar.title);
	const { assetId } = useParams({ strict: false }) as { assetId: string };
	const source: ListSource = { key: ["similar-list", assetId], path: `/assets/${assetId}/similar` };
	// 和网格共用同一个查询，只为了读出 fingerprinted / unavailable
	const query = useInfiniteQuery(listQuery(source));
	const first = query.data?.pages[0] as SimilarResult | undefined;
	// 和查看器共用缓存
	const detail = useQuery({ queryKey: ["asset", assetId], queryFn: () => api<AssetDetail>(`/assets/${assetId}`) });
	return (
		<div className="space-y-6">
			<div className="flex items-center gap-3 pt-1">
				{detail.data && (
					<img src={thumbUrl(assetId, detail.data.derived_rev)} alt="" className="h-12 w-12 shrink-0 rounded-xl bg-surface object-cover" />
				)}
				<h1 className="page-title">{t.similar.title}</h1>
			</div>
			{first && !first.fingerprinted && <FingerprintHint />}
			<LibraryList
				key={assetId}
				source={source}
				context={{ kind: "library" }}
				groupByDay={false}
				empty={first?.unavailable ? t.similar.unavailable : t.similar.none}
			/>
		</div>
	);
}

// ------------------------------------------------------------------ 重复照片

/** 撤销条显示多久 */
const UNDO_MS = 8000;

/**
 * 看起来完全一样的照片（缩放、重新压缩、换了格式的副本）。每组推荐保留一张，其余可以一键移到回收站。
 * 点开一张进入对比界面（DuplicateCompare），在组里快速切换；不是重复的可以标记掉，以后不再列出。
 * 每次打开页面时在服务端重新分组（只由打开页面和操作之后的刷新触发，没有轮询）。
 */
export function DuplicatesPage() {
	useDocumentTitle(t.duplicates.title);
	const qc = useQueryClient();
	const [offset, setOffset] = useState(0);
	const query = useQuery({
		queryKey: ["duplicates", offset],
		queryFn: () => api<DuplicateGroups>(`/duplicates?offset=${offset}`),
		staleTime: 30_000,
	});
	const data = query.data;
	const groups = data?.groups ?? [];
	const extras = (g: DuplicateGroups["groups"][number]) => g.items.map((i) => i[0]).filter((id) => id !== g.keep);
	const trash = useMutation({
		mutationFn: async (ids: string[]) => {
			for (let i = 0; i < ids.length; i += 1000) await batch(qc, ids.slice(i, i + 1000), { action: "trash" });
			return ids.length;
		},
	});
	const trashGroups = async (groups: DuplicateGroups["groups"]) => {
		const ids = groups.flatMap(extras);
		if (!ids.length) return;
		const ok = await confirmDialog({
			title: t.duplicates.trashTitle(ids.length),
			message: t.duplicates.trashMessage(groups.length),
			confirmLabel: t.actions.moveToTrash,
			danger: true,
		});
		if (ok) trash.mutate(ids);
	};

	// “不是重复”：记下最近一次，几秒内可以撤销
	const [undo, setUndo] = useState<{ ids: string[]; pivot?: string } | null>(null);
	const undoTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
	useEffect(() => () => clearTimeout(undoTimer.current), []);
	const ignore = useMutation({
		mutationFn: async ({ ids, pivot, revert }: { ids: string[]; pivot?: string; revert?: boolean }) => {
			await ignoreDuplicates(qc, ids, pivot, revert);
			clearTimeout(undoTimer.current);
			if (revert) setUndo(null);
			else {
				setUndo({ ids, pivot });
				undoTimer.current = setTimeout(() => setUndo(null), UNDO_MS);
			}
		},
	});
	/** 服务端一次最多 DUPLICATE_IGNORE_MAX 张；pivot 放在最前面保证包含在内。 */
	const ignoreIds = (g: DuplicateGroups["groups"][number], pivot?: string) =>
		(pivot ? [pivot, ...g.items.map((i) => i[0]).filter((id) => id !== pivot)] : g.items.map((i) => i[0])).slice(0, DUPLICATE_IGNORE_MAX);

	// 对比界面：?a= 是当前照片，所在的组由它找出来
	const search = useSearch({ strict: false }) as { a?: string };
	const navigate = useNavigate();
	const openedHere = useRef(false);
	const setA = useCallback(
		(a: string | undefined, replace: boolean) =>
			void navigate({ to: ".", search: (prev: Record<string, unknown>) => ({ ...prev, a }), replace, resetScroll: false }),
		[navigate],
	);
	const close = useCallback(() => {
		if (openedHere.current) {
			openedHere.current = false;
			window.history.back();
		} else setA(undefined, true);
	}, [setA]);
	const gi = search.a ? groups.findIndex((g) => g.items.some((i) => i[0] === search.a)) : -1;
	// 照片已经不在任何一组里（被删掉、标记过、或者链接过期）：关掉对比界面
	useEffect(() => {
		if (search.a && data && !query.isFetching && gi < 0) close();
	}, [search.a, data, query.isFetching, gi, close]);

	/** 当前组处理完之后去哪：下一组，没有就上一组，都没有就关闭。 */
	const afterGroup = (i: number) => {
		const g = groups[i + 1] ?? groups[i - 1];
		if (g) setA(g.items[0]![0], true);
		else close();
	};
	/** 当前这张从组里拿掉之后：组里还剩至少 2 张就看下一张，否则换组。 */
	const afterPhoto = (i: number, id: string) => {
		const rest = groups[i]!.items.filter((x) => x[0] !== id);
		if (rest.length >= 2) {
			const at = groups[i]!.items.findIndex((x) => x[0] === id);
			setA(rest[Math.min(at, rest.length - 1)]![0], true);
		} else afterGroup(i);
	};
	const busy = trash.isPending || ignore.isPending;

	// 对比界面和撤销条放在 space-y 容器外面，否则会被加上外边距
	return (
		<>
			<div className="space-y-5">
				<div className="flex flex-wrap items-center gap-2 pt-1">
					<OrganizeTitle title={t.duplicates.title} className="flex-1" />
					{data && data.groups.length > 0 && (
						<button className="btn btn-danger" disabled={busy} onClick={() => void trashGroups(data.groups)}>
							<IconTrash size={18} />
							{t.duplicates.keepRecommendedAll(data.next !== null)}
						</button>
					)}
				</div>
				<p className="flex items-start gap-2.5 rounded-2xl bg-notice px-4 py-3 text-sm">
					<IconDuplicate size={18} className="mt-0.5 shrink-0 text-muted" />
					<span>
						{t.duplicates.intro}
					</span>
				</p>
				{query.error && <p className="text-danger">{errorText(query.error)}</p>}
				{!data && !query.error && <DuplicateGroupsSkeleton />}
				{trash.error && <p className="text-sm text-danger">{errorText(trash.error)}</p>}
				{ignore.error && <p className="text-sm text-danger">{errorText(ignore.error)}</p>}
				{trash.data !== undefined && <p className="text-sm text-muted">{t.duplicates.trashed(trash.data)}</p>}
				{data && (
					<p className="text-sm text-muted">
						{t.duplicates.scanned(data.total, data.scanned, data.truncated)}
					</p>
				)}
				{data?.total === 0 && <p className="py-10 text-center text-sm text-muted">{t.duplicates.none}</p>}
				<ul className="space-y-3">
					{groups.map((g) => (
						<li key={g.keep} className="rounded-2xl border border-border bg-card p-3">
							<div className="flex gap-2 overflow-x-auto pb-1">
								{g.items.map((it) => (
									<button
										key={it[0]}
										className="relative shrink-0 overflow-hidden rounded-xl bg-surface"
										onClick={() => {
											openedHere.current = true;
											setA(it[0], false);
										}}
										aria-label={it[0] === g.keep ? t.duplicates.compareKeep : t.duplicates.compare}
									>
										<img
											src={thumbUrl(it[0], it[7])}
											alt=""
											loading="lazy"
											className="h-28 object-cover sm:h-36"
											style={{ aspectRatio: `${it[1]} / ${it[2]}`, maxWidth: "16rem" }}
										/>
										<span className="absolute bottom-1.5 left-1.5 whitespace-nowrap rounded-full bg-black/60 px-2 py-0.5 text-xs text-white">
											{it[0] === g.keep ? t.duplicates.keep : ""}
											{it[0] === g.keep ? " · " : ""}
											{it[1]}×{it[2]}
										</span>
									</button>
								))}
							</div>
							<div className="mt-2 flex justify-end gap-2">
								<button className="btn" disabled={busy} onClick={() => ignore.mutate({ ids: ignoreIds(g) })}>
									{t.duplicates.notDuplicate}
								</button>
								<button className="btn" disabled={busy} onClick={() => void trashGroups([g])}>
									{t.duplicates.keepRecommended}
								</button>
							</div>
						</li>
					))}
				</ul>
				{data && (offset > 0 || data.next !== null) && (
					<div className="flex justify-center gap-2">
						<button className="btn" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 200))}>
							{t.common.prevPage}
						</button>
						<button className="btn" disabled={data.next === null} onClick={() => data.next !== null && setOffset(data.next)}>
							{t.common.nextPage}
						</button>
					</div>
				)}
			</div>
			{search.a && gi >= 0 && (
				<DuplicateCompare
					group={groups[gi]!}
					current={search.a}
					groupIndex={gi}
					groupCount={groups.length}
					label={t.compare.dialog}
					onSelect={(id) => setA(id, true)}
					onGroup={(d) => {
						const g = groups[gi + d];
						if (g) setA(g.items[0]![0], true);
					}}
					onClose={close}
					actions={(id) => {
						const g = groups[gi]!;
						const n = g.items.length;
						const onIgnore = (pivot?: string) =>
							ignore.mutate({ ids: ignoreIds(g, pivot), pivot }, { onSuccess: () => (pivot ? afterPhoto(gi, pivot) : afterGroup(gi)) });
						return (
							<>
								<button
									type="button"
									className={comparePill}
									disabled={busy}
									onClick={() => trash.mutate(g.items.map((i) => i[0]).filter((x) => x !== id), { onSuccess: () => afterGroup(gi) })}
								>
									{t.compare.keepThis}
								</button>
								<button type="button" className={comparePill} disabled={busy} onClick={() => trash.mutate([id], { onSuccess: () => afterPhoto(gi, id) })}>
									<IconTrash size={16} />
									{t.compare.deleteThis}
								</button>
								{n > 2 && (
									<button type="button" className={comparePill} disabled={busy} onClick={() => onIgnore(id)} title={t.compare.notThisTitle}>
										{t.compare.notThis}
									</button>
								)}
								<button type="button" className={comparePill} disabled={busy} onClick={() => onIgnore()} title={t.compare.ignoreTitle}>
									{n > 2 ? t.compare.noneDuplicate : t.duplicates.notDuplicate}
								</button>
							</>
						);
					}}
				/>
			)}
			{undo && (
				<div
					className={`fixed inset-x-0 z-[60] flex justify-center px-4 ${search.a ? "top-[calc(var(--safe-top)+3.5rem)]" : "bottom-[calc(var(--tabbar-h)+1rem)] md:bottom-[max(1rem,var(--safe-bottom))]"}`}
					role="status"
				>
					<div className="flex items-center gap-3 rounded-full bg-fg px-4 py-2 text-sm text-bg shadow-lg">
						{t.duplicates.ignored}
						<button className="font-semibold underline disabled:opacity-50" disabled={ignore.isPending} onClick={() => ignore.mutate({ ...undo, revert: true })}>
							{t.common.undo}
						</button>
					</div>
				</div>
			)}
		</>
	);
}
