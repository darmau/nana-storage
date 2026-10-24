import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { SIMILAR_SCAN_CALLS } from "@nana/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorText } from "../api";
import { t } from "../i18n";
import { batch, snoozeSimilar } from "../library/actions";
import type { SimilarGroups } from "../library/queries";
import { thumbUrl } from "../timeline/types";
import { IconArchive, IconLookalike, IconTrash } from "../ui/icons";
import { DuplicateGroupsSkeleton } from "../ui/Skeleton";
import { useDocumentTitle } from "../ui/title";
import { DuplicateCompare, comparePill } from "./DuplicateCompare";

/** 撤销条显示多久 */
const UNDO_MS = 8000;
/** 补查近邻时，每查这么多批刷新一次分组（每次刷新要重新读全部照片对） */
const REFRESH_EVERY = 10;

type Group = SimilarGroups["groups"][number];
type Done = { ids: string[]; kind: "trash" | "archive" };

/**
 * 相似照片：看起来差不多的照片（同一张图的各种版本、同一次拍摄里略有不同的几张），只按画面内容判断。
 * 每组推荐保留一张，其余移到回收站或归档；“暂不处理”把这一组排到队列末尾，以后还会轮到。点开一组进入对比界面逐张看。
 * 打开页面时，还没比较过的照片由页面分批请求服务端比较（每次 SIMILAR_SCAN_BATCH 张，最多 SIMILAR_SCAN_CALLS 次，
 * 页面关掉、切到后台或出错就停），其余时候没有轮询。
 */
export function SimilarGroupsPage() {
	useDocumentTitle(t.lookalike.title);
	const qc = useQueryClient();
	const [offset, setOffset] = useState(0);
	const query = useQuery({
		queryKey: ["similar-groups", offset],
		queryFn: () => api<SimilarGroups>(`/similar-groups?offset=${offset}`),
		staleTime: 30_000,
	});
	const data = query.data;

	// 处理过的组先在本地藏起来，不用等重新分组（读全部照片对要一两秒）
	const [gone, setGone] = useState<ReadonlySet<string>>(() => new Set());
	useEffect(() => setGone(new Set()), [query.dataUpdatedAt]);
	const groups = (data?.groups ?? []).filter((g) => !gone.has(g.keep));
	const hide = (g: Group) => setGone((s) => new Set(s).add(g.keep));
	const others = (g: Group, keep: string) => g.items.map((i) => i[0]).filter((id) => id !== keep);

	// ---------------------------------------------------------------- 补查近邻
	const [scan, setScan] = useState<{ running: boolean; pending: number } | null>(null);
	const needsScan = !!data && !data.unavailable && data.pending > 0;
	useEffect(() => {
		if (!needsScan) return;
		let stopped = false;
		void (async () => {
			setScan((s) => ({ running: true, pending: s?.pending ?? data!.pending }));
			try {
				for (let i = 0; i < SIMILAR_SCAN_CALLS && !stopped && !document.hidden; i++) {
					const r = await api<{ scanned: number; pending: number }>("/similar-groups/scan", { method: "POST" });
					if (stopped) return;
					setScan({ running: true, pending: r.pending });
					if (!r.scanned) break;
					if (i % REFRESH_EVERY === REFRESH_EVERY - 1) void qc.invalidateQueries({ queryKey: ["similar-groups"] });
				}
			} catch {
				// 出错就停，下次打开页面或每小时的 Cron 会接着比较
			}
			if (stopped) return;
			setScan((s) => s && { ...s, running: false });
			void qc.invalidateQueries({ queryKey: ["similar-groups"] });
		})();
		return () => {
			stopped = true;
		};
		// data 只用来取初始的剩余张数；重新分组后不重新开始
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [needsScan, qc]);
	const pending = scan?.pending ?? data?.pending ?? 0;

	// ---------------------------------------------------------------- 操作
	const [undo, setUndo] = useState<Done | null>(null);
	const undoTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
	useEffect(() => () => clearTimeout(undoTimer.current), []);
	const act = useMutation({
		mutationFn: async (d: Done) => {
			await batch(qc, d.ids, d.kind === "trash" ? { action: "trash" } : { action: "archive", value: true });
			return d;
		},
		onSuccess: (d) => {
			clearTimeout(undoTimer.current);
			setUndo(d);
			undoTimer.current = setTimeout(() => setUndo(null), UNDO_MS);
		},
	});
	const revert = useMutation({
		mutationFn: (d: Done) => batch(qc, d.ids, d.kind === "trash" ? { action: "restore" } : { action: "archive", value: false }),
		onSuccess: () => setUndo(null),
	});
	const snooze = useMutation({ mutationFn: (g: Group) => snoozeSimilar(qc, g.items.map((i) => i[0])) });
	const busy = act.isPending || snooze.isPending || revert.isPending;
	const keepOnly = (g: Group, keep: string, kind: Done["kind"], then?: () => void) =>
		act.mutate(
			{ ids: others(g, keep), kind },
			{
				onSuccess: () => {
					then?.();
					hide(g);
				},
			},
		);
	const later = (g: Group, then?: () => void) =>
		snooze.mutate(g, {
			onSuccess: () => {
				then?.();
				hide(g);
			},
		});

	// ---------------------------------------------------------------- 对比界面：?a= 是当前照片，所在的组由它找出来
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
	// 照片已经不在任何一组里（处理过、或者链接过期）：关掉对比界面
	useEffect(() => {
		if (search.a && data && !query.isFetching && gi < 0) close();
	}, [search.a, data, query.isFetching, gi, close]);
	/** 当前组处理完之后去哪：下一组，没有就上一组，都没有就关闭。 */
	const afterGroup = (i: number) => {
		const g = groups[i + 1] ?? groups[i - 1];
		if (g) setA(g.items[0]![0], true);
		else close();
	};

	// 对比界面和撤销条放在 space-y 容器外面，否则会被加上外边距
	return (
		<>
			<div className="space-y-5">
				<h1 className="page-title pt-1">{t.lookalike.title}</h1>
				<p className="flex items-start gap-2.5 rounded-2xl bg-notice px-4 py-3 text-sm">
					<IconLookalike size={18} className="mt-0.5 shrink-0 text-muted" />
					<span>{t.lookalike.intro}</span>
				</p>
				{query.error && <p className="text-danger">{errorText(query.error)}</p>}
				{act.error && <p className="text-sm text-danger">{errorText(act.error)}</p>}
				{snooze.error && <p className="text-sm text-danger">{errorText(snooze.error)}</p>}
				{!data && !query.error && <DuplicateGroupsSkeleton />}
				{data?.unavailable && <p className="text-sm text-muted">{t.lookalike.unavailable}</p>}
				{data && (
					<p className="text-sm text-muted" role="status">
						{t.lookalike.summary(data.total, data.fingerprints, data.truncated)}
						{pending > 0 && !data.unavailable && ` ${scan?.running ? t.lookalike.scanning(pending) : t.lookalike.waiting(pending)}`}
					</p>
				)}
				{data?.total === 0 && pending === 0 && <p className="py-10 text-center text-sm text-muted">{t.lookalike.none}</p>}
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
											{it[0] === g.keep ? `${t.duplicates.keep} · ` : ""}
											{it[1]}×{it[2]}
										</span>
									</button>
								))}
							</div>
							<div className="mt-2 flex flex-wrap items-center justify-end gap-2">
								{g.snoozed && <span className="mr-auto text-xs text-muted">{t.lookalike.snoozedBefore}</span>}
								<button className="btn" disabled={busy} onClick={() => later(g)}>
									{t.lookalike.snooze}
								</button>
								<button className="btn" disabled={busy} onClick={() => keepOnly(g, g.keep, "archive")}>
									<IconArchive size={18} />
									{t.lookalike.archiveOthers}
								</button>
								<button className="btn" disabled={busy} onClick={() => keepOnly(g, g.keep, "trash")}>
									<IconTrash size={18} />
									{t.lookalike.trashOthers}
								</button>
							</div>
						</li>
					))}
				</ul>
				{data && (offset > 0 || data.next !== null) && (
					<div className="flex justify-center gap-2">
						<button className="btn" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 100))}>
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
					label={t.lookalike.dialog}
					onSelect={(id) => setA(id, true)}
					onGroup={(d) => {
						const g = groups[gi + d];
						if (g) setA(g.items[0]![0], true);
					}}
					onClose={close}
					actions={(id) => {
						const g = groups[gi]!;
						const next = () => afterGroup(gi);
						return (
							<>
								<button type="button" className={comparePill} disabled={busy} onClick={() => keepOnly(g, id, "trash", next)}>
									<IconTrash size={16} />
									{t.lookalike.keepThisTrash}
								</button>
								<button type="button" className={comparePill} disabled={busy} onClick={() => keepOnly(g, id, "archive", next)}>
									<IconArchive size={16} />
									{t.lookalike.keepThisArchive}
								</button>
								<button type="button" className={comparePill} disabled={busy} onClick={() => later(g, next)}>
									{t.lookalike.snooze}
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
						{undo.kind === "trash" ? t.lookalike.trashed(undo.ids.length) : t.lookalike.archived(undo.ids.length)}
						<button className="font-semibold underline disabled:opacity-50" disabled={revert.isPending} onClick={() => revert.mutate(undo)}>
							{t.common.undo}
						</button>
					</div>
				</div>
			)}
		</>
	);
}
