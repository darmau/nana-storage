import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { ASSET_TYPES, type AssetType, SMART_SET_CV_MIN, SMART_SET_SENSITIVITY, type SmartSetLevel } from "@nana/shared";
import { useState } from "react";
import { api, errorText } from "../api";
import { fmtNumber, t } from "../i18n";
import { invalidateLibrary, refreshSmartSet } from "../library/actions";
import { LibraryList } from "../library/LibraryList";
import { AlbumPicker } from "../library/Pickers";
import { type ListSource, type SmartSetDetail, type SmartSetSummary, albumsQuery, smartSetsQuery } from "../library/queries";
import { TypeFilter, useTypeFilter } from "../library/TypeFilter";
import { alertDialog, confirmDialog, promptDialog } from "../ui/confirm";
import { openContextMenu } from "../ui/ContextMenu";
import { IconAlert, IconChart, IconChevronRight, IconClose, IconEdit, IconSimilar, IconTrash } from "../ui/icons";
import { useDocumentTitle } from "../ui/title";
import { Cover, PageActions } from "./LibraryPages";
import { SmartSetReview } from "./SmartSetReview";

/**
 * 主题：用户标的样本（正例 / 反例）训练出一个分类器，它只负责建议。
 * 页面分三个标签：样本（维护训练数据）、判断（逐张或成批回答建议对不对）、结果（按灵敏度筛出来的照片，多选后加入相册）。
 * 标记只记录，不会马上重新训练；页头提示“更新”，点了马上重新学习并扫描全库（几秒钟），
 * 不点的话每小时的 Cron 会在标记停止变化后自动更新。
 */

export function SmartSetsPage() {
	useDocumentTitle(t.topics.title);
	const { data } = useQuery(smartSetsQuery);
	return (
		<div className="space-y-6">
			{/* 主题在“探索”下面：标题带上返回探索页的面包屑 */}
			<div className="flex items-center gap-1 pt-1 text-xl font-bold tracking-tight sm:text-2xl">
				<Link to="/search" className="shrink-0 text-muted hover:text-fg">
					{t.nav.explore}
				</Link>
				<IconChevronRight size={20} className="shrink-0 text-muted" />
				<h1>{t.topics.title}</h1>
			</div>
			<p className="flex items-start gap-2.5 rounded-2xl bg-notice px-4 py-3 text-sm">
				<IconSimilar size={18} className="mt-0.5 shrink-0 text-muted" />
				<span>{t.topics.intro}</span>
			</p>
			{data?.length === 0 && <p className="py-10 text-center text-sm text-muted">{t.topics.none}</p>}
			<SmartSetGrid sets={data} />
		</div>
	);
}

/** 卡片下面的一行：结果张数（“标准”灵敏度）和样本数。 */
export const smartSetLine = (s: SmartSetSummary) => t.topics.cardLine(s.positives + s.matches, s.positives + s.negatives);

export function SmartSetGrid({ sets }: { sets: SmartSetSummary[] | undefined }) {
	const qc = useQueryClient();
	const navigate = useNavigate();
	const act = async (fn: () => Promise<unknown>) => {
		try {
			await fn();
			invalidateLibrary(qc);
		} catch (e) {
			void alertDialog(t.common.actionFailed, errorText(e));
		}
	};
	const menu = (e: React.MouseEvent, s: SmartSetSummary) =>
		openContextMenu(e, [
			{ label: t.library.open, icon: <IconSimilar size={18} />, onSelect: () => void navigate({ to: "/smart-sets/$setId", params: { setId: s.id } }) },
			{ label: t.common.renameMenu, icon: <IconEdit size={18} />, onSelect: () => void renameSet(s, act) },
			"sep",
			{ label: t.topics.deleteTopic, icon: <IconTrash size={18} />, danger: true, onSelect: () => void removeSet(s, act) },
		]);
	return (
		<ul className="grid grid-cols-2 gap-x-3 gap-y-5 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
			{sets?.map((s) => (
				<li key={s.id}>
					<Link to="/smart-sets/$setId" params={{ setId: s.id }} className="block space-y-1.5" onContextMenu={(e) => menu(e, s)}>
						<Cover cover={s.cover} label="album" />
						<div className="flex items-center gap-1.5">
							<div className="truncate text-sm font-semibold">{s.name}</div>
							{s.dirty && <span className="h-2 w-2 shrink-0 rounded-full bg-accent" title={t.topics.dirtyDot} />}
						</div>
						<div className="text-xs text-muted">{smartSetLine(s)}</div>
					</Link>
				</li>
			))}
		</ul>
	);
}

const renameSet = async (s: { id: string; name: string }, act: (fn: () => Promise<unknown>) => Promise<void>) => {
	const name = await promptDialog({ title: t.topics.renameTopic, defaultValue: s.name, confirmLabel: t.common.rename });
	if (name && name !== s.name) return act(() => api(`/smart-sets/${s.id}`, { method: "PATCH", json: { name } }));
};
const removeSet = async (s: { id: string; name: string }, act: (fn: () => Promise<unknown>) => Promise<void>, after?: () => void) => {
	const ok = await confirmDialog({ title: t.topics.deleteTitle(s.name), message: t.topics.deleteMessage, confirmLabel: t.topics.deleteTopic, danger: true });
	if (ok)
		await act(async () => {
			await api(`/smart-sets/${s.id}`, { method: "DELETE" });
			after?.();
		});
};

const LEVELS: { key: SmartSetLevel; label: string }[] = [
	{ key: "strict", label: t.topics.strict },
	{ key: "normal", label: t.topics.normal },
	{ key: "loose", label: t.topics.loose },
];
type SampleFilter = "positive" | "negative" | "conflict";
interface SmartSetSearch {
	a?: string;
	/** 不写是“样本” */
	tab?: "review" | "results";
	/** 样本的筛选 */
	filter?: SampleFilter;
	/** 判断的顺序：不写是最拿不准的在前 */
	order?: "score";
	/** 结果的灵敏度：不写是“标准” */
	level?: "strict" | "loose";
	/** 结果里去掉已经在这个相册里的 */
	album?: string;
	type?: AssetType;
}
const isId = (v: unknown): v is string => typeof v === "string" && /^[0-9A-Z]{26}$/.test(v);

export const validateSmartSetSearch = (s: Record<string, unknown>): SmartSetSearch => ({
	a: isId(s.a) ? s.a : undefined,
	tab: s.tab === "review" || s.tab === "results" ? s.tab : undefined,
	filter: s.filter === "positive" || s.filter === "negative" || s.filter === "conflict" ? s.filter : undefined,
	order: s.order === "score" ? "score" : undefined,
	level: s.level === "strict" || s.level === "loose" ? s.level : undefined,
	album: isId(s.album) ? s.album : undefined,
	type: ASSET_TYPES.includes(s.type as AssetType) ? (s.type as AssetType) : undefined,
});

const pill = (on: boolean) =>
	`inline-flex h-9 items-center rounded-full px-4 text-sm font-medium transition ${on ? "bg-accent-soft text-accent-ink" : "text-fg/80 hover:bg-surface"}`;
const chip = (on: boolean) =>
	`inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-sm transition ${on ? "border-accent bg-accent-soft text-accent-ink" : "border-border text-fg/80 hover:bg-surface"}`;
const count = (n: number | undefined) => (n === undefined ? "" : ` ${fmtNumber(n)}`);

export function SmartSetPage() {
	const { setId } = useParams({ strict: false }) as { setId: string };
	const search = useSearch({ strict: false }) as SmartSetSearch;
	const view = search.tab ?? "samples";
	const qc = useQueryClient();
	const navigate = useNavigate();
	const info = useQuery({ queryKey: ["smart-sets", setId], queryFn: () => api<SmartSetDetail>(`/smart-sets/${setId}`) });
	useDocumentTitle(info.data?.name);
	const refresh = useMutation({ mutationFn: () => refreshSmartSet(qc, setId) });
	const [reviewing, setReviewing] = useState(false);
	const act = async (fn: () => Promise<unknown>) => {
		try {
			await fn();
			invalidateLibrary(qc);
		} catch (e) {
			void alertDialog(t.common.actionFailed, errorText(e));
		}
	};

	if (info.error) return <p className="text-danger">{errorText(info.error)}</p>;
	const d = info.data;
	const busy = refresh.isPending || !!d?.refreshing;
	const tabs: { key: typeof view; label: string; n?: number; search: SmartSetSearch }[] = [
		{ key: "samples", label: t.topics.samples, n: d && d.positives + d.negatives, search: {} },
		{ key: "review", label: t.topics.review, n: d?.suggestions.loose, search: { tab: "review" } },
		{ key: "results", label: t.topics.results, n: d && d.positives + d.suggestions.normal, search: { tab: "results" } },
	];
	return (
		<div className="space-y-5">
			<div className="flex items-center gap-2 pt-1">
				<div className="flex min-w-0 flex-1 items-center gap-1 text-xl font-bold tracking-tight sm:text-2xl">
					<Link to="/smart-sets" className="shrink-0 text-muted hover:text-fg">
						{t.topics.title}
					</Link>
					<IconChevronRight size={20} className="shrink-0 text-muted" />
					<h1 className="truncate" title={d?.name}>
						{d?.name}
					</h1>
				</div>
				{d && (
					<PageActions
						menu={[
							{ label: t.topics.renameTopic, icon: <IconEdit size={18} />, onSelect: () => void renameSet(d, act) },
							{
								label: t.topics.deleteTopic,
								icon: <IconTrash size={18} />,
								danger: true,
								onSelect: () => void removeSet(d, act, () => void navigate({ to: "/smart-sets" })),
							},
						]}
					/>
				)}
			</div>
			{d?.dirty && (
				<div className="flex flex-wrap items-center gap-3 rounded-2xl bg-notice px-4 py-3 text-sm">
					<IconSimilar size={18} className="shrink-0 text-muted" />
					<span className="min-w-0 flex-1">
						{d.trained_at === null ? t.topics.dirtyUntrained : t.topics.dirtyChanged(d.changed)}
						{t.topics.dirtyHint}
					</span>
					<button className="btn-primary" disabled={busy} onClick={() => refresh.mutate()}>
						{busy ? t.topics.refreshing : t.topics.refresh}
					</button>
				</div>
			)}
			{refresh.error && <p className="text-sm text-danger">{errorText(refresh.error)}</p>}
			{refresh.data && !refresh.isPending && <p className="text-sm text-muted">{t.topics.refreshed(refresh.data.suggestions)}</p>}
			<div className="flex flex-wrap items-center gap-1" role="tablist">
				{tabs.map((tab) => (
					<Link
						key={tab.key}
						to="/smart-sets/$setId"
						params={{ setId }}
						search={tab.search}
						role="tab"
						aria-selected={view === tab.key}
						className={pill(view === tab.key)}
					>
						{tab.label}
						{count(tab.n)}
					</Link>
				))}
			</div>
			{view === "samples" ? (
				<SamplesTab setId={setId} d={d} filter={search.filter} />
			) : view === "review" ? (
				<ReviewTab setId={setId} d={d} order={search.order} onReview={() => setReviewing(true)} />
			) : (
				<ResultsTab setId={setId} d={d} search={search} />
			)}
			{reviewing && d && (
				<SmartSetReview
					set={d}
					order={search.order === "score" ? "score" : "uncertain"}
					onClose={() => setReviewing(false)}
					onRefresh={() => refresh.mutate()}
				/>
			)}
		</div>
	);
}

// ------------------------------------------------------------------ 样本

function SamplesTab({ setId, d, filter }: { setId: string; d: SmartSetDetail | undefined; filter: SampleFilter | undefined }) {
	const filters: { key: SampleFilter | undefined; label: string; n?: number }[] = [
		{ key: undefined, label: t.topics.filterAll, n: d && d.positives + d.negatives },
		{ key: "positive", label: t.topics.filterPositive, n: d?.positives },
		{ key: "negative", label: t.topics.filterNegative, n: d?.negatives },
	];
	// 有矛盾的样本时才显示这个筛选
	if (filter === "conflict" || d?.conflicts) filters.push({ key: "conflict", label: t.topics.filterConflict, n: d?.conflicts });
	const source: ListSource = {
		key: ["smart-set", setId, "samples", filter ?? "all"],
		path: `/smart-sets/${setId}/examples${filter ? `?filter=${filter}` : ""}`,
	};
	return (
		<>
			{d && <QualityCard d={d} />}
			<div className="space-y-3">
				<div className="flex flex-wrap items-center gap-2" role="group" aria-label={t.topics.filter}>
					{filters.map((f) => (
						<Link
							key={f.label}
							to="/smart-sets/$setId"
							params={{ setId }}
							search={{ filter: f.key }}
							replace
							aria-pressed={filter === f.key}
							className={chip(filter === f.key)}
						>
							{f.key === "conflict" && <IconAlert size={14} className="text-warn" />}
							{f.label}
							{count(f.n)}
						</Link>
					))}
				</div>
				<p className="text-sm text-muted">{filter === "conflict" ? t.topics.conflictHint : t.topics.samplesHint}</p>
			</div>
			<LibraryList
				key={`${setId}:samples:${filter ?? ""}`}
				source={source}
				context={{ kind: "smartSet", setId, view: "samples" }}
				groupByDay={false}
				empty={filter === "conflict" ? t.topics.emptyConflicts : t.topics.emptySamples}
			/>
		</>
	);
}

/**
 * 分类器质量：交叉验证（每张样本由没见过它的模型打分）算出每档灵敏度下能认出多少正例、排除多少反例；
 * 实测准确率是“判断”时回答过的建议里，分数达到这一档、被标成正例的比例。
 */
function QualityCard({ d }: { d: SmartSetDetail }) {
	const [open, setOpen] = useState(false);
	const m = d.metrics;
	const pct = (x: number) => `${fmtNumber(Math.round(x * 100))}%`;
	const reviewed = LEVELS.some((l) => d.reviewed[l.key].n > 0);
	const summary = !m
		? t.topics.qualityUntrained
		: m.cv
			? t.topics.qualitySummary(pct(m.cv.recall.normal), pct(m.cv.rejection.normal))
			: t.topics.qualityTooFew(m.positives, m.negatives, SMART_SET_CV_MIN);
	return (
		<section className="rounded-2xl border border-border bg-card px-4 py-3 text-sm">
			<div className="flex items-start gap-2.5">
				<IconChart size={18} className="mt-0.5 shrink-0 text-muted" />
				<p className="min-w-0 flex-1">
					<span className="font-semibold">{t.topics.quality}</span>
					<span className="text-muted"> · {summary}</span>
				</p>
				{(m?.cv || reviewed) && (
					<button className="shrink-0 font-medium text-accent-ink hover:underline" aria-expanded={open} onClick={() => setOpen(!open)}>
						{open ? t.topics.qualityHide : t.topics.qualityShow}
					</button>
				)}
			</div>
			{open && (
				<div className="mt-3 space-y-2 pl-7">
					<table className="w-full text-left tabular-nums">
						<thead className="text-xs text-muted">
							<tr>
								<th className="pb-1 font-medium">{t.topics.sensitivity}</th>
								<th className="pb-1 font-medium">{t.topics.colRecall}</th>
								<th className="pb-1 font-medium">{t.topics.colRejection}</th>
								<th className="pb-1 font-medium">{t.topics.colReviewed}</th>
							</tr>
						</thead>
						<tbody>
							{LEVELS.map((l) => {
								const r = d.reviewed[l.key];
								return (
									<tr key={l.key}>
										<th className="py-0.5 font-medium">{l.label}</th>
										<td>{m?.cv ? pct(m.cv.recall[l.key]) : "–"}</td>
										<td>{m?.cv ? pct(m.cv.rejection[l.key]) : "–"}</td>
										<td>
											{r.n ? pct(r.yes / r.n) : "–"}
											{r.n ? <span className="text-xs text-muted"> {t.topics.reviewedOf(r.n)}</span> : null}
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
					<p className="text-xs text-muted">{t.topics.qualityNote}</p>
				</div>
			)}
		</section>
	);
}

// ------------------------------------------------------------------ 判断

function ReviewTab({
	setId,
	d,
	order,
	onReview,
}: {
	setId: string;
	d: SmartSetDetail | undefined;
	order: "score" | undefined;
	onReview: () => void;
}) {
	const source: ListSource = {
		key: ["smart-set", setId, "review", order ?? "uncertain"],
		path: `/smart-sets/${setId}/suggestions?order=${order ?? "uncertain"}`,
	};
	const orders: { key: "score" | undefined; label: string }[] = [
		{ key: undefined, label: t.topics.orderUncertain },
		{ key: "score", label: t.topics.orderScore },
	];
	return (
		<>
			<div className="space-y-3">
				<div className="flex flex-wrap items-center gap-2">
					<div className="flex flex-wrap items-center gap-2" role="group" aria-label={t.topics.order}>
						{orders.map((o) => (
							<Link
								key={o.label}
								to="/smart-sets/$setId"
								params={{ setId }}
								search={{ tab: "review", order: o.key }}
								replace
								aria-pressed={order === o.key}
								className={chip(order === o.key)}
							>
								{o.label}
							</Link>
						))}
					</div>
					<button className="btn-primary ml-auto" disabled={!d?.suggestions.loose} onClick={onReview}>
						{t.topics.reviewOneByOne}
					</button>
				</div>
				<p className="text-sm text-muted">{order === "score" ? t.topics.reviewScoreHint : t.topics.reviewUncertainHint}</p>
			</div>
			<LibraryList
				key={`${setId}:review:${order ?? ""}`}
				source={source}
				context={{ kind: "smartSet", setId, view: "review" }}
				groupByDay={false}
				empty={d?.dirty ? t.topics.emptySuggestionsDirty : t.topics.emptySuggestions}
			/>
		</>
	);
}

// ------------------------------------------------------------------ 结果

function ResultsTab({ setId, d, search }: { setId: string; d: SmartSetDetail | undefined; search: SmartSetSearch }) {
	const navigate = useNavigate();
	const level: SmartSetLevel = search.level ?? "normal";
	const [type, setType] = useTypeFilter();
	const [picking, setPicking] = useState(false);
	const albums = useQuery({ ...albumsQuery, enabled: !!search.album });
	const albumName = albums.data?.find((a) => a.id === search.album)?.name;
	const setAlbum = (album: string | undefined) =>
		void navigate({ to: ".", search: (prev: Record<string, unknown>) => ({ ...prev, album, a: undefined }), replace: true });
	const params = new URLSearchParams({ min: String(SMART_SET_SENSITIVITY[level]) });
	if (search.album) params.set("notInAlbum", search.album);
	if (type) params.set("type", type);
	const source: ListSource = {
		key: ["smart-set", setId, "results", level, search.album ?? "", type ?? ""],
		path: `/smart-sets/${setId}/assets?${params}`,
	};
	return (
		<>
			<div className="space-y-3">
				<div className="flex flex-wrap items-center gap-2">
					<div className="flex flex-wrap items-center gap-2" role="group" aria-label={t.topics.sensitivity}>
						<span className="text-sm text-muted">{t.topics.sensitivity}</span>
						{LEVELS.map((l) => (
							<Link
								key={l.key}
								to="/smart-sets/$setId"
								params={{ setId }}
								search={(prev: SmartSetSearch) => ({ ...prev, a: undefined, level: l.key === "normal" ? undefined : l.key })}
								replace
								aria-pressed={level === l.key}
								className={chip(level === l.key)}
							>
								{l.label}
								{count(d && d.positives + d.suggestions[l.key])}
							</Link>
						))}
					</div>
					{search.album ? (
						<button className={chip(true)} onClick={() => setAlbum(undefined)} aria-label={t.topics.notInAlbumClear}>
							{t.topics.notInAlbumOn(albumName ?? "…")}
							<IconClose size={14} />
						</button>
					) : (
						<button className={chip(false)} onClick={() => setPicking(true)}>
							{t.topics.notInAlbum}
						</button>
					)}
				</div>
				<TypeFilter value={type} onChange={setType} />
				<p className="text-sm text-muted">{t.topics.resultsHint}</p>
			</div>
			<LibraryList
				key={`${setId}:results:${level}:${search.album ?? ""}:${type ?? ""}`}
				source={source}
				context={{ kind: "topicResults", setId }}
				datedScrubber
				empty={d?.dirty ? t.topics.emptySuggestionsDirty : t.topics.emptyResults}
			/>
			{picking && (
				<AlbumPicker
					onClose={() => setPicking(false)}
					onPick={(albumId) => {
						setPicking(false);
						setAlbum(albumId);
					}}
				/>
			)}
		</>
	);
}
