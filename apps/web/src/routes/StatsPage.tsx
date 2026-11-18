import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import type { FolderStats } from "@nana/shared";
import { fmtNumber, t } from "../i18n";
import { folderStatsQuery } from "../library/queries";
import { formatBytes } from "../timeline/format";
import { useDocumentTitle } from "../ui/title";

/**
 * 统计：按文件夹（路径）看照片 / 视频的张数和原图体积。上半部分是占比（每个顶层文件夹 = 通常是一个人），
 * 下半部分是明细表（每个文件夹自己、不含子文件夹的张数，正好加出总数）。
 */

interface Node extends FolderStats {
	children: Node[];
	/** 从根到自己的名字（不含根目录）。 */
	path: string[];
	/** 整棵子树的合计（含自己）。 */
	totalPhotos: number;
	totalVideos: number;
	totalSize: number;
}

function buildTree(folders: FolderStats[]): Node[] {
	const byId = new Map<string, Node>();
	for (const f of folders) {
		byId.set(f.id, { ...f, children: [], path: [], totalPhotos: f.photos, totalVideos: f.videos, totalSize: f.size });
	}
	const roots: Node[] = [];
	for (const f of folders) {
		const node = byId.get(f.id)!;
		if (f.parent_id && byId.has(f.parent_id)) byId.get(f.parent_id)!.children.push(node);
		else roots.push(node);
	}
	const dfs = (node: Node, path: string[]): void => {
		node.path = path;
		for (const child of node.children) {
			dfs(child, [...path, child.name]);
			node.totalPhotos += child.totalPhotos;
			node.totalVideos += child.totalVideos;
			node.totalSize += child.totalSize;
		}
	};
	for (const r of roots) dfs(r, [r.name]);
	return roots;
}

type Metric = "count" | "size";
type SortKey = "path" | "photos" | "videos" | "size";

const seg = (on: boolean) =>
	`inline-flex h-8 items-center rounded-full px-3 text-sm font-medium transition ${on ? "bg-card text-fg shadow-sm" : "text-muted hover:text-fg"}`;

export function StatsPage() {
	useDocumentTitle(t.stats.title);
	const { data } = useQuery(folderStatsQuery);
	const [metric, setMetric] = useState<Metric>("count");
	const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "size", dir: -1 });

	const tree = useMemo(() => (data ? buildTree(data.folders) : null), [data]);

	const total = useMemo(() => {
		const sum = { photos: 0, videos: 0, size: 0 };
		for (const r of tree ?? []) {
			sum.photos += r.totalPhotos;
			sum.videos += r.totalVideos;
			sum.size += r.totalSize;
		}
		if (data) {
			sum.photos += data.unfiled.photos;
			sum.videos += data.unfiled.videos;
			sum.size += data.unfiled.size;
		}
		return sum;
	}, [tree, data]);

	const proportions = useMemo(() => {
		if (!data || !tree) return [];
		const entries = tree.map((r) => ({ key: r.id, name: r.name, count: r.totalPhotos + r.totalVideos, size: r.totalSize }));
		entries.push({
			key: "unfiled",
			name: t.stats.unfiled,
			count: data.unfiled.photos + data.unfiled.videos,
			size: data.unfiled.size,
		});
		const value = (e: (typeof entries)[number]) => (metric === "count" ? e.count : e.size);
		entries.sort((a, b) => value(b) - value(a));
		return entries;
	}, [data, tree, metric]);

	const rows = useMemo(() => {
		if (!data || !tree) return [];
		const flat: { key: string; path: string; photos: number; videos: number; size: number }[] = [];
		const walk = (n: Node) => {
			flat.push({ key: n.id, path: n.path.join(" / "), photos: n.photos, videos: n.videos, size: n.size });
			n.children.forEach(walk);
		};
		tree.forEach(walk);
		flat.push({ key: "unfiled", path: t.stats.unfiled, photos: data.unfiled.photos, videos: data.unfiled.videos, size: data.unfiled.size });
		const byKey: Record<SortKey, (r: (typeof flat)[number]) => string | number> = {
			path: (r) => r.path,
			photos: (r) => r.photos,
			videos: (r) => r.videos,
			size: (r) => r.size,
		};
		flat.sort((a, b) => {
			const av = byKey[sort.key](a);
			const bv = byKey[sort.key](b);
			const cmp = typeof av === "string" && typeof bv === "string" ? av.localeCompare(bv) : (av as number) - (bv as number);
			return cmp * sort.dir;
		});
		return flat;
	}, [data, tree, sort]);

	const grand = metric === "count" ? total.photos + total.videos : total.size;

	const toggleSort = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: key === "path" ? 1 : -1 }));

	const empty = !!data && data.folders.length === 0 && data.unfiled.photos + data.unfiled.videos === 0;

	return (
		<div className="space-y-6">
			<div className="flex items-center gap-2 pt-1">
				<h1 className="page-title flex-1">{t.stats.title}</h1>
			</div>

			{!data || !tree ? (
				<StatsSkeleton />
			) : empty ? (
				<p className="py-12 text-center text-sm text-muted">{t.stats.empty}</p>
			) : (
				<>
					<section className="space-y-3">
						<div className="flex items-center gap-3">
							<h2 className="text-lg font-bold">{t.stats.proportion}</h2>
							<div className="ml-auto inline-flex rounded-full bg-surface p-1" role="radiogroup" aria-label={t.stats.metric}>
								<button type="button" role="radio" aria-checked={metric === "count"} className={seg(metric === "count")} onClick={() => setMetric("count")}>
									{t.stats.byCount}
								</button>
								<button type="button" role="radio" aria-checked={metric === "size"} className={seg(metric === "size")} onClick={() => setMetric("size")}>
									{t.stats.bySize}
								</button>
							</div>
						</div>
						<ul className="space-y-3 rounded-2xl border border-border bg-card p-4">
							{proportions.map((p) => {
								const v = metric === "count" ? p.count : p.size;
								const pct = grand > 0 ? Math.round((v / grand) * 100) : 0;
								return (
									<li key={p.key}>
										<div className="flex items-baseline gap-2 text-sm">
											<span className="min-w-0 flex-1 truncate font-medium">{p.name}</span>
											<span className="shrink-0 tabular-nums text-xs text-muted">
												{pct}% · {metric === "count" ? t.stats.items(v) : formatBytes(v)}
											</span>
										</div>
										<div className="mt-1 h-2 overflow-hidden rounded-full bg-surface">
											<div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
										</div>
									</li>
								);
							})}
						</ul>
					</section>

					<section className="space-y-3">
						<h2 className="text-lg font-bold">{t.stats.details}</h2>
						<div className="overflow-x-auto rounded-2xl border border-border bg-card">
							<table className="w-full text-sm">
								<thead>
									<tr className="border-b border-border text-left text-xs text-muted">
										<SortHead label={t.stats.colPath} active={sort.key === "path"} dir={sort.dir} onClick={() => toggleSort("path")} />
										<SortHead label={t.stats.colPhotos} active={sort.key === "photos"} dir={sort.dir} onClick={() => toggleSort("photos")} numeric />
										<SortHead label={t.stats.colVideos} active={sort.key === "videos"} dir={sort.dir} onClick={() => toggleSort("videos")} numeric />
										<SortHead label={t.stats.colSize} active={sort.key === "size"} dir={sort.dir} onClick={() => toggleSort("size")} numeric />
									</tr>
								</thead>
								<tbody>
									{rows.map((r) => (
										<tr key={r.key} className="border-b border-border/60 last:border-0">
											<td className="max-w-0 truncate px-3 py-2">{r.path}</td>
											<td className="px-3 py-2 text-right tabular-nums">{fmtNumber(r.photos)}</td>
											<td className="px-3 py-2 text-right tabular-nums">{fmtNumber(r.videos)}</td>
											<td className="px-3 py-2 text-right tabular-nums">{formatBytes(r.size)}</td>
										</tr>
									))}
									<tr className="border-t border-border font-semibold">
										<td className="px-3 py-2">{t.stats.total}</td>
										<td className="px-3 py-2 text-right tabular-nums">{fmtNumber(total.photos)}</td>
										<td className="px-3 py-2 text-right tabular-nums">{fmtNumber(total.videos)}</td>
										<td className="px-3 py-2 text-right tabular-nums">{formatBytes(total.size)}</td>
									</tr>
								</tbody>
							</table>
						</div>
					</section>
				</>
			)}
		</div>
	);
}

function StatsSkeleton() {
	return (
		<div className="animate-pulse space-y-6">
			<div className="h-44 rounded-2xl bg-surface" />
			<div className="h-56 rounded-2xl bg-surface" />
		</div>
	);
}

function SortHead({ label, active, dir, onClick, numeric }: { label: string; active: boolean; dir: number; onClick: () => void; numeric?: boolean }) {
	return (
		<th className="px-3 py-2 font-medium">
			<button className={`inline-flex items-center gap-1 hover:text-fg ${numeric ? "w-full justify-end" : ""} ${active ? "text-fg" : ""}`} onClick={onClick}>
				{label}
				<span className="tabular-nums" aria-hidden>
					{active ? (dir > 0 ? "↑" : "↓") : ""}
				</span>
			</button>
		</th>
	);
}
