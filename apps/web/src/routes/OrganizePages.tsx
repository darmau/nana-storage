import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { COMPRESS_MIN_BYTES, COMPRESS_TARGET_PIXELS } from "@nana/shared";
import { useState } from "react";
import { api, errorText } from "../api";
import { fmtNumber, t } from "../i18n";
import { LibraryList } from "../library/LibraryList";
import { formatBytes } from "../timeline/format";
import { IconAlert, IconChevronRight, IconCompress, IconDuplicate, IconInfo, IconLookalike } from "../ui/icons";
import { useDocumentTitle } from "../ui/title";

/**
 * 整理：重复照片、相似照片、原图压缩。桌面端是侧边栏里的一项（/organize，这一页列出三个入口）；
 * 移动端没有单独的标签，三个入口平铺在资料库首页（LibraryHome 用同一份 ORGANIZE_ITEMS）。
 */

export const ORGANIZE_ITEMS = [
	{ to: "/duplicates", icon: IconDuplicate, title: () => t.duplicates.title, sub: () => t.organize.duplicatesSub },
	{ to: "/similar-groups", icon: IconLookalike, title: () => t.lookalike.title, sub: () => t.organize.lookalikeSub },
	{ to: "/compress", icon: IconCompress, title: () => t.compress.title, sub: () => t.organize.compressSub },
] as const;

/** 一个入口：图标 + 标题 + 一句说明，整行可点。 */
export function OrganizeLink({ item }: { item: (typeof ORGANIZE_ITEMS)[number] }) {
	const Icon = item.icon;
	return (
		<Link to={item.to} className="flex items-center gap-3 rounded-2xl border border-border bg-card p-4 transition hover:bg-surface">
			<span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent-ink">
				<Icon />
			</span>
			<div className="min-w-0 flex-1">
				<div className="text-sm font-semibold">{item.title()}</div>
				<div className="truncate text-xs text-muted">{item.sub()}</div>
			</div>
			<IconChevronRight className="shrink-0 text-muted" />
		</Link>
	);
}

export function OrganizePage() {
	useDocumentTitle(t.organize.title);
	return (
		<div className="space-y-5">
			<h1 className="page-title pt-1">{t.organize.title}</h1>
			<p className="text-sm text-muted">{t.organize.intro}</p>
			<div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
				{ORGANIZE_ITEMS.map((item) => (
					<OrganizeLink key={item.to} item={item} />
				))}
			</div>
		</div>
	);
}

/** 整理下面的页面的标题：带上返回整理页的面包屑。 */
export function OrganizeTitle({ title, className = "" }: { title: string; className?: string }) {
	return (
		<div className={`page-title flex min-w-0 items-center gap-1 pt-1 ${className}`}>
			<Link to="/organize" className="shrink-0 text-muted hover:text-fg">
				{t.organize.title}
			</Link>
			<IconChevronRight size={20} className="shrink-0 text-muted" />
			<h1 className="truncate">{title}</h1>
		</div>
	);
}

// ------------------------------------------------------------------ 原图压缩

interface CompressSummary {
	candidates: { count: number; bytes: number };
	compressed: { count: number; before: number; after: number };
	skipped: number;
	/** “不压缩”列表按原因的张数（unknown 是没记原因的旧数据），和列表同样的条件 */
	reasons: Record<string, number>;
	queued: number;
	failed: number;
}

/** 下限的选项（MB）。最小的就是 COMPRESS_MIN_BYTES：比它小的压了也省不了多少，服务端不列。 */
const MIN_OPTIONS = [COMPRESS_MIN_BYTES / 1024 ** 2, 5, 10, 20, 50];
/** 分辨率的选项：0 保持原尺寸，其余是像素上限（文案按“万像素”传） */
const RESIZE_OPTIONS = [0, ...COMPRESS_TARGET_PIXELS];
/** 原因的显示顺序：能靠缩小分辨率处理的在前 */
const REASON_ORDER = ["not-smaller", "unknown", "extra-data", "not-jpeg", "colourspace", "too-large"];

type CompressView = "candidates" | "compressed" | "skipped";

const pill = (on: boolean) =>
	`inline-flex h-9 items-center rounded-full px-4 text-sm font-medium transition ${on ? "bg-accent-soft text-accent-ink" : "text-fg/80 hover:bg-surface"}`;
const chip = (on: boolean) =>
	`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-sm transition ${on ? "border-accent bg-accent-soft text-accent-ink" : "border-border text-fg/80 hover:bg-surface"}`;

/**
 * 原图压缩：三个视图——待压缩（没处理过的 JPEG 原图按大小倒序，可以只看某个大小以上的）、已压缩、不压缩（按原因筛选，
 * 说明为什么不压缩）。选中后“压缩原图”（多选栏 / 右键菜单，见 SelectionBar 的 compress），可以顺便缩小分辨率：
 * 选了分辨率时，已压缩的、不值得压缩的照片超过所选像素数也能再处理。排上队的从列表里消失；进度在“后台处理”里看，
 * 这里只在打开、切换、操作之后和点“刷新”时更新，不轮询。
 */
export function CompressPage() {
	useDocumentTitle(t.compress.title);
	const [view, setView] = useState<CompressView>("candidates");
	const [minMb, setMinMb] = useState(MIN_OPTIONS[0]!);
	const [maxPixels, setMaxPixels] = useState<number>(0);
	const [reason, setReason] = useState<string | undefined>();
	const min = minMb * 1024 ** 2;
	const summary = useQuery({
		queryKey: ["compress", "summary", min],
		queryFn: () => api<CompressSummary>(`/compress/summary?min=${min}`),
	});
	const s = summary.data;
	const refresh = () => void summary.refetch();
	const reasons = s ? REASON_ORDER.filter((r) => (s.reasons[r] ?? 0) > 0) : [];
	const skippedCount = s ? Object.values(s.reasons).reduce((a, b) => a + b, 0) : undefined;
	const counts: Record<CompressView, number | undefined> = { candidates: s?.candidates.count, compressed: s?.compressed.count, skipped: skippedCount };
	// 选中的原因已经没有照片了（都处理掉了）就回到全部
	const activeReason = reason && reasons.includes(reason) ? reason : undefined;

	const source =
		view === "candidates"
			? { key: ["compress", "candidates", min], path: `/compress/candidates?min=${min}` }
			: view === "compressed"
				? { key: ["compress", "compressed"], path: "/compress/done?state=compressed" }
				: {
						key: ["compress", "skipped", activeReason ?? "all"],
						path: `/compress/done?state=skipped${activeReason ? `&reason=${activeReason}` : ""}`,
					};
	const empty = view === "candidates" ? t.compress.none : view === "compressed" ? t.compress.noneCompressed : t.compress.noneSkipped;

	return (
		<div className="space-y-5">
			<div className="flex flex-wrap items-center gap-2">
				<OrganizeTitle title={t.compress.title} className="flex-1" />
				<button type="button" className="btn" onClick={refresh} disabled={summary.isFetching}>
					{t.compress.refresh}
				</button>
			</div>
			<p className="flex items-start gap-2.5 rounded-2xl bg-notice px-4 py-3 text-sm">
				<IconCompress size={18} className="mt-0.5 shrink-0 text-muted" />
				<span>{t.compress.intro}</span>
			</p>
			{summary.error && <p className="text-sm text-danger">{errorText(summary.error)}</p>}
			<div className="space-y-1.5 text-sm">
				<label className="flex flex-wrap items-center gap-2">
					<span className="text-muted">{t.compress.resizeLabel}</span>
					<select className="field py-1.5" value={maxPixels} onChange={(e) => setMaxPixels(Number(e.target.value))}>
						{RESIZE_OPTIONS.map((px) => (
							<option key={px} value={px}>
								{t.compress.resizeOption(px / 10_000)}
							</option>
						))}
					</select>
				</label>
				{maxPixels > 0 && <p className="text-xs text-muted">{t.compress.resizeHint}</p>}
			</div>
			{s && (s.queued > 0 || s.failed > 0) && (
				<ul className="space-y-1 text-sm text-muted">
					{s.queued > 0 && (
						<li>
							{t.compress.queued(s.queued)}{" "}
							<Link to="/settings/processing" className="font-medium text-accent-ink hover:underline">
								{t.compress.viewJobs}
							</Link>
						</li>
					)}
					{s.failed > 0 && (
						<li className="flex items-center gap-1.5 text-danger">
							<IconAlert size={16} />
							{t.compress.failed(s.failed)}{" "}
							<Link to="/settings/processing" className="font-medium hover:underline">
								{t.compress.viewJobs}
							</Link>
						</li>
					)}
				</ul>
			)}
			<div className="flex flex-wrap items-center gap-1" role="tablist">
				{(["candidates", "compressed", "skipped"] as const).map((v) => (
					<button key={v} type="button" role="tab" aria-selected={view === v} className={pill(view === v)} onClick={() => setView(v)}>
						{t.compress.views[v]}
						{counts[v] === undefined ? "" : ` ${fmtNumber(counts[v])}`}
					</button>
				))}
			</div>
			{view === "candidates" && (
				<div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
					<label className="flex items-center gap-2">
						<span className="text-muted">{t.compress.minLabel}</span>
						<select className="field py-1.5" value={minMb} onChange={(e) => setMinMb(Number(e.target.value))}>
							{MIN_OPTIONS.map((mb) => (
								<option key={mb} value={mb}>
									{t.compress.minOption(mb)}
								</option>
							))}
						</select>
					</label>
					{s && <span className="font-semibold tabular-nums">{t.compress.candidates(s.candidates.count, formatBytes(s.candidates.bytes))}</span>}
				</div>
			)}
			{view === "compressed" && s && s.compressed.count > 0 && (
				<p className="text-sm text-muted">{t.compress.compressed(s.compressed.count, formatBytes(s.compressed.before), formatBytes(s.compressed.after))}</p>
			)}
			{view === "skipped" && reasons.length > 0 && (
				<div className="space-y-3">
					<div role="group" className="flex gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
						<button type="button" aria-pressed={!activeReason} className={chip(!activeReason)} onClick={() => setReason(undefined)}>
							{t.compress.allReasons}
						</button>
						{reasons.map((r) => (
							<button
								key={r}
								type="button"
								aria-pressed={activeReason === r}
								className={chip(activeReason === r)}
								onClick={() => setReason(activeReason === r ? undefined : r)}
							>
								{t.compress.reasons[r]} <span className="tabular-nums text-muted">{fmtNumber(s!.reasons[r]!)}</span>
							</button>
						))}
					</div>
					<dl className="space-y-1.5 text-sm">
						{(activeReason ? [activeReason] : reasons).map((r) => (
							<div key={r}>
								<dt className="inline font-medium">{t.compress.reasons[r]}</dt>
								<dd className="ml-2 inline text-muted">{t.compress.reasonDetails[r]}</dd>
							</div>
						))}
					</dl>
				</div>
			)}
			{view === "candidates" && s && s.candidates.count > 0 && (
				<p className="flex items-center gap-2 text-xs text-muted">
					<IconInfo size={14} className="shrink-0" />
					{t.compress.selectHint}
				</p>
			)}
			<LibraryList
				key={source.key.join("/")}
				source={source}
				context={{ kind: "compress", maxPixels }}
				groupByDay={false}
				view="list"
				empty={empty}
			/>
		</div>
	);
}
