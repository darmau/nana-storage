import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { COMPRESS_MIN_BYTES } from "@nana/shared";
import { useState } from "react";
import { api, errorText } from "../api";
import { t } from "../i18n";
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
	queued: number;
	failed: number;
}

/** 下限的选项（MB）。最小的就是 COMPRESS_MIN_BYTES：比它小的压了也省不了多少，服务端不列。 */
const MIN_OPTIONS = [COMPRESS_MIN_BYTES / 1024 ** 2, 5, 10, 20, 50];

/**
 * 原图压缩：没处理过的 JPEG 原图按大小倒序列出（可以只看某个大小以上的），选中后“压缩原图”（多选栏 / 右键菜单，
 * 见 SelectionBar 的 compress）。排上队的从列表里消失；压缩的进度在“后台处理”里看，这里只在打开、切换下限、操作之后
 * 和点“刷新”时更新，不轮询。
 */
export function CompressPage() {
	useDocumentTitle(t.compress.title);
	const [minMb, setMinMb] = useState(MIN_OPTIONS[0]!);
	const min = minMb * 1024 ** 2;
	const summary = useQuery({
		queryKey: ["compress", "summary", min],
		queryFn: () => api<CompressSummary>(`/compress/summary?min=${min}`),
	});
	const s = summary.data;
	const refresh = () => void summary.refetch();
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
			{s && (s.compressed.count > 0 || s.skipped > 0 || s.queued > 0 || s.failed > 0) && (
				<ul className="space-y-1 text-sm text-muted">
					{s.compressed.count > 0 && <li>{t.compress.compressed(s.compressed.count, formatBytes(s.compressed.before), formatBytes(s.compressed.after))}</li>}
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
					{s.skipped > 0 && <li>{t.compress.skipped(s.skipped)}</li>}
				</ul>
			)}
			{s && s.candidates.count > 0 && (
				<p className="flex items-center gap-2 text-xs text-muted">
					<IconInfo size={14} className="shrink-0" />
					{t.compress.selectHint}
				</p>
			)}
			<LibraryList
				key={min}
				source={{ key: ["compress", "candidates", min], path: `/compress/candidates?min=${min}` }}
				context={{ kind: "compress" }}
				groupByDay={false}
				view="list"
				empty={t.compress.none}
			/>
		</div>
	);
}
