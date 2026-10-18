import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import {
	FP_DIMS,
	LARGEST_MAX,
	PRICING,
	estimateCost,
	type CostLine,
	type FileRole,
	type LibraryStats,
	type UsageDay,
	type UsageStats,
} from "@nana/shared";
import { api, errorText } from "../api";
import { fmtNumber, locale, t } from "../i18n";
import { LibraryList } from "../library/LibraryList";
import { formatBytes, formatMonth } from "../timeline/format";
import { type Bar, BarChart } from "../ui/BarChart";
import { useDocumentTitle } from "../ui/title";

/**
 * 统计数据（探索下的 /stats）：
 *  - 资料库规模、存储容量（按原图算）、本月用量和费用估算：GET /api/stats，只在打开页面和点“刷新”时请求
 *    （每次几条 D1 聚合查询 + 1 次 UsageGuard 请求），不自动刷新。
 *  - 拍摄时间分布、拍摄设备：GET /api/stats/library，每天 Cron 统计一次的快照，只读一行。
 *  - 最大的照片 / 视频：GET /api/stats/largest/:kind，切到对应的标签才请求，带 ETag。
 */

const ROLE_LABELS: [FileRole, string][] = (["original", "raw", "live_video", "thumb", "preview", "poster", "video_preview"] as const).map((r) => [
	r,
	t.usage.roles[r],
]);
const ORIGINAL_ROLES: FileRole[] = ["original", "raw", "live_video"];

const num = (n: number) => fmtNumber(Math.round(n));

function money(n: number | null) {
	if (n === null) return "—";
	if (n === 0) return "$0";
	if (n < 0.01) return "< $0.01";
	return `$${n.toFixed(2)}`;
}

function amount(unit: CostLine["unit"], n: number) {
	switch (unit) {
		case "bytes":
			return formatBytes(n);
		case "seconds":
			return n < 3600 ? t.settings.time.minutes((n / 60).toFixed(1)) : t.settings.time.hours((n / 3600).toFixed(1));
		case "gibSeconds":
			return t.usage.gibHours(num(n / 3600));
		case "gbSeconds":
			return t.usage.gbHours(num(n / 3600));
		case "count":
			return t.usage.bigCount(n) ?? num(n);
	}
}

const hours = (s: number) => t.settings.time.hours((s / 3600).toFixed(2));

export function StatsPage() {
	useDocumentTitle(t.stats.title);
	const query = useQuery({
		queryKey: ["stats"],
		queryFn: () => api<UsageStats>("/stats"),
		staleTime: 5 * 60_000,
		refetchOnWindowFocus: false,
	});
	// 快照每天才变一次
	const lib = useQuery({
		queryKey: ["stats-library"],
		queryFn: () => api<LibraryStats>("/stats/library"),
		staleTime: 60 * 60_000,
		refetchOnWindowFocus: false,
	});
	const s = query.data;

	return (
		<div className="mx-auto max-w-3xl space-y-8">
			<div className="flex items-center gap-3 pt-1">
				<h1 className="page-title flex-1">{t.stats.title}</h1>
				<button className="btn" disabled={query.isFetching} onClick={() => void query.refetch()}>
					{query.isFetching ? t.usage.loading : t.common.refresh}
				</button>
			</div>
			{query.error && <p className="text-sm text-danger">{errorText(query.error)}</p>}
			{s && <Overview s={s} />}
			{lib.error && <p className="text-sm text-danger">{errorText(lib.error)}</p>}
			{lib.data && (
				<>
					<Shooting s={lib.data} />
					<Cameras s={lib.data} />
				</>
			)}
			<Largest />
			{s && (
				<>
					<Storage s={s} />
					<Cost s={s} />
					<ContainerDays days={s.days} now={s.now} />
					<Growth growth={s.growth} />
				</>
			)}
			<ul className="space-y-1 text-xs text-muted">
				{s && <li>{t.usage.dataTime(new Date(s.now).toLocaleString(locale))}</li>}
				{lib.data && <li>{t.stats.snapshot(new Date(lib.data.computedAt).toLocaleString(locale))}</li>}
			</ul>
		</div>
	);
}

/** 两三个选项的切换（时间范围、照片 / 视频），样式和类型筛选条一致。 */
function Segmented<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
	return (
		<div role="group" className="flex gap-2">
			{options.map(([v, label]) => (
				<button
					key={v}
					type="button"
					aria-pressed={value === v}
					className={`h-8 shrink-0 rounded-full border px-3 text-sm font-medium transition ${
						value === v ? "border-transparent bg-fg text-bg" : "border-border bg-card text-fg hover:bg-surface"
					}`}
					onClick={() => onChange(v)}
				>
					{label}
				</button>
			))}
		</div>
	);
}

function SectionTitle({ title, children }: { title: string; children?: React.ReactNode }) {
	return (
		<div className="flex flex-wrap items-center justify-between gap-3">
			<h2 className="text-lg font-semibold">{title}</h2>
			{children}
		</div>
	);
}

function originalBytes(s: UsageStats) {
	return ORIGINAL_ROLES.reduce((acc, r) => acc + (s.storage.roles[r]?.bytes ?? 0), 0);
}

function r2Bytes(s: UsageStats) {
	const files = Object.values(s.storage.roles).reduce((acc, r) => acc + (r?.bytes ?? 0), 0);
	return files + s.storage.trash.bytes + s.storage.uploads.bytes;
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
	return (
		<div className="rounded-lg border border-border p-3">
			<div className="text-sm text-muted">{label}</div>
			<div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
			{sub && <div className="mt-0.5 text-xs text-muted">{sub}</div>}
		</div>
	);
}

function Overview({ s }: { s: UsageStats }) {
	const { library: l } = s;
	const total = l.photo + l.video + l.live;
	const extra = [
		l.processing > 0 && t.usage.processingN(num(l.processing)),
		l.failed > 0 && t.usage.failedN(num(l.failed)),
		l.trash > 0 && t.usage.trashN(num(l.trash)),
	].filter((p): p is string => !!p);
	return (
		<section className="space-y-3">
			<div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
				<Tile label={t.library.types.photo} value={num(l.photo)} />
				<Tile label={t.library.types.live} value={num(l.live)} />
				<Tile label={t.library.types.video} value={num(l.video)} />
				<Tile label={t.usage.originalSize} value={formatBytes(originalBytes(s))} sub={t.usage.totalItems(num(total))} />
			</div>
			{extra.length > 0 && <p className="text-sm text-muted">{t.usage.extra(extra)}</p>}
		</section>
	);
}

function Storage({ s }: { s: UsageStats }) {
	const st = s.storage;
	const rows: [string, { files: number; bytes: number }][] = [
		...ROLE_LABELS.filter(([r]) => st.roles[r]).map(([r, label]) => [label, st.roles[r]!] as [string, { files: number; bytes: number }]),
		[t.usage.trashRow, st.trash],
	];
	if (st.uploads.files > 0) rows.push([t.usage.uploadsRow, st.uploads]);
	const total = r2Bytes(s);
	return (
		<section className="space-y-3">
			<h2 className="text-lg font-semibold">{t.usage.storage}</h2>
			<div className="overflow-x-auto rounded-lg border border-border">
				<table className="w-full text-sm">
					<thead className="text-left text-muted">
						<tr className="border-b border-border">
							<th className="px-3 py-2 font-normal">R2</th>
							<th className="px-3 py-2 text-right font-normal">{t.usage.files}</th>
							<th className="px-3 py-2 text-right font-normal">{t.usage.size}</th>
						</tr>
					</thead>
					<tbody className="tabular-nums">
						{rows.map(([label, r]) => (
							<tr key={label} className="border-b border-border last:border-0">
								<td className="px-3 py-2">{label}</td>
								<td className="px-3 py-2 text-right">{num(r.files)}</td>
								<td className="px-3 py-2 text-right">{formatBytes(r.bytes)}</td>
							</tr>
						))}
						<tr className="bg-surface font-medium">
							<td className="px-3 py-2">{t.usage.total}</td>
							<td className="px-3 py-2 text-right">{num(rows.reduce((a, [, r]) => a + r.files, 0))}</td>
							<td className="px-3 py-2 text-right">{formatBytes(total)}</td>
						</tr>
					</tbody>
				</table>
			</div>
			<ul className="space-y-1 text-sm text-muted">
				<li>{t.usage.d1(st.d1Bytes === null ? t.usage.unknown : formatBytes(st.d1Bytes))}</li>
				<li>
					{t.usage.vectors(num(st.vectors), amount("count", st.vectors * FP_DIMS))}
				</li>
			</ul>
		</section>
	);
}

function Cost({ s }: { s: UsageStats }) {
	const estimate = estimateCost({
		r2Bytes: r2Bytes(s),
		d1Bytes: s.storage.d1Bytes,
		containerSeconds: s.month.containerSeconds,
		jobs: s.month.jobs,
		vectorDims: s.storage.vectors * FP_DIMS,
	});
	const month = new Date(s.monthStart).toISOString().slice(0, 7);
	return (
		<section className="space-y-3">
			<div className="flex items-baseline justify-between gap-3">
				<h2 className="text-lg font-semibold">{t.usage.cost}</h2>
				<span className="text-sm text-muted">{t.usage.costPeriod(formatMonth(month))}</span>
			</div>
			<div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
				<Tile label={t.usage.estimate} value={money(estimate.total)} sub={estimate.missing ? t.usage.missing : t.usage.includesPlan} />
				<Tile label={t.usage.containerRun} value={hours(s.month.containerSeconds)} />
				<Tile label={t.usage.jobs} value={num(s.month.jobs)} />
				<Tile label={t.usage.uploads} value={formatBytes(s.month.uploadBytes)} />
			</div>
			<div className="overflow-x-auto rounded-lg border border-border">
				<table className="w-full min-w-[34rem] text-sm">
					<thead className="text-left text-muted">
						<tr className="border-b border-border">
							<th className="px-3 py-2 font-normal">{t.usage.item}</th>
							<th className="px-3 py-2 text-right font-normal">{t.usage.used}</th>
							<th className="px-3 py-2 text-right font-normal">{t.usage.included}</th>
							<th className="px-3 py-2 text-right font-normal">{t.usage.fee}</th>
						</tr>
					</thead>
					<tbody className="tabular-nums">
						{estimate.lines.map((l) => (
							<tr key={l.key} className="border-b border-border last:border-0">
								<td className="px-3 py-2">
									<span className="text-muted">{l.service}</span> {t.usage.costLines[l.key]}
								</td>
								<td className="px-3 py-2 text-right">{l.key === "plan" ? "—" : l.used === null ? t.usage.noData : amount(l.unit, l.used)}</td>
								<td className="px-3 py-2 text-right text-muted">{l.key === "plan" ? "—" : amount(l.unit, l.included)}</td>
								<td className={`px-3 py-2 text-right ${l.cost ? "font-medium" : "text-muted"}`}>{money(l.cost)}</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
			<ul className="list-disc space-y-1 pl-5 text-xs text-muted">
				<li>{t.usage.pricingNote}</li>
				<li>
					{t.usage.containerNote(
						PRICING.containers.vcpu,
						PRICING.containers.memoryGib,
						(3600 * (PRICING.containers.perVcpuSecond + PRICING.containers.memoryGib * PRICING.containers.perGibSecond + PRICING.containers.diskGb * PRICING.containers.perGbSecond)).toFixed(2),
					)}
				</li>
				<li>{t.usage.queuesNote}</li>
				<li>{t.usage.otherNote}</li>
			</ul>
		</section>
	);
}

/** 最近 30 天每天的容器时长（UsageGuard 记账，UTC 日期）。单序列柱状图，悬停显示当天数值，下面有表格视图。 */
function ContainerDays({ days, now }: { days: UsageDay[]; now: number }) {
	const [showTable, setShowTable] = useState(false);
	const byDay = new Map(days.map((d) => [d.day, d]));
	const series = Array.from({ length: 30 }, (_, i) => {
		const day = new Date(now - (29 - i) * 86400_000).toISOString().slice(0, 10);
		return byDay.get(day) ?? { day, containerSeconds: 0, jobs: 0, uploadBytes: 0 };
	});
	const max = Math.max(...series.map((d) => d.containerSeconds), 0);
	const short = (day: string) => `${Number(day.slice(5, 7))}/${Number(day.slice(8))}`;
	const bars = series.map((d) => ({ key: d.day, value: d.containerSeconds, edge: short(d.day) }));
	const byKey = new Map(series.map((d) => [d.day, d]));
	return (
		<section className="space-y-3">
			<SectionTitle title={t.usage.days}>
				<button className="text-sm text-accent" onClick={() => setShowTable(!showTable)}>
					{showTable ? t.usage.showChart : t.usage.showTable}
				</button>
			</SectionTitle>
			{showTable ? (
				<div className="max-h-80 overflow-y-auto rounded-lg border border-border">
					<table className="w-full text-sm tabular-nums">
						<thead className="sticky top-0 bg-bg text-left text-muted">
							<tr className="border-b border-border">
								<th className="px-3 py-2 font-normal">{t.usage.dateUtc}</th>
								<th className="px-3 py-2 text-right font-normal">{t.usage.containerTime}</th>
								<th className="px-3 py-2 text-right font-normal">{t.usage.jobsCol}</th>
								<th className="px-3 py-2 text-right font-normal">{t.usage.uploads}</th>
							</tr>
						</thead>
						<tbody>
							{[...series].reverse().map((d) => (
								<tr key={d.day} className="border-b border-border last:border-0">
									<td className="px-3 py-2">{d.day}</td>
									<td className="px-3 py-2 text-right">{hours(d.containerSeconds)}</td>
									<td className="px-3 py-2 text-right">{num(d.jobs)}</td>
									<td className="px-3 py-2 text-right">{formatBytes(d.uploadBytes)}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			) : (
				<BarChart
					bars={bars}
					idle={t.usage.peak(hours(max))}
					caption={(b: Bar) => {
						const d = byKey.get(b.key)!;
						return (
							<>
								<span className="font-medium">{b.edge}</span>
								<span className="text-muted"> {t.usage.dayDetail(hours(d.containerSeconds), num(d.jobs), formatBytes(d.uploadBytes))}</span>
							</>
						);
					}}
				/>
			)}
		</section>
	);
}

// ------------------------------------------------------------------ 拍摄时间

interface PeriodBar extends Bar {
	/** 悬停和表格里显示的时间段 */
	title: string;
}

const DAY_MS = 86400_000;
const dayMs = (day: string) => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
const ymd = (ms: number) => {
	const d = new Date(ms);
	return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
};
/** 跨度超过这么多个月时按年显示，柱子不至于细得点不中。 */
const MAX_MONTH_BARS = 120;

/** 一年内：截至统计那天的最近 52 周，每周一根柱子（周从统计那天往回数，不按星期几对齐）。 */
function weekBars(s: LibraryStats): PeriodBar[] {
	const byDay = new Map(s.days);
	const end = dayMs(new Date(s.computedAt).toISOString().slice(0, 10));
	return Array.from({ length: 52 }, (_, i) => {
		const last = end - (51 - i) * 7 * DAY_MS;
		const first = last - 6 * DAY_MS;
		let value = 0;
		for (let ms = first; ms <= last; ms += DAY_MS) value += byDay.get(new Date(ms).toISOString().slice(0, 10)) ?? 0;
		const a = ymd(first);
		const b = ymd(last);
		return { key: String(first), value, edge: `${a.y}/${a.m}/${a.d}`, title: `${a.y}/${a.m}/${a.d} – ${b.y === a.y ? "" : `${b.y}/`}${b.m}/${b.d}` };
	});
}

/** 所有时间：从最早到最晚每月一根柱子（没有照片的月份补 0），跨度太长时按年。 */
function allTimeBars(s: LibraryStats): { bars: PeriodBar[]; yearly: boolean } {
	if (!s.months.length) return { bars: [], yearly: false };
	const byMonth = new Map(s.months);
	const [fy, fm] = s.months[0]![0].split("-").map(Number) as [number, number];
	const [ly, lm] = s.months.at(-1)![0].split("-").map(Number) as [number, number];
	const span = (ly - fy) * 12 + (lm - fm) + 1;
	if (span > MAX_MONTH_BARS) {
		const byYear = new Map<number, number>();
		for (const [ym, n] of s.months) byYear.set(Number(ym.slice(0, 4)), (byYear.get(Number(ym.slice(0, 4))) ?? 0) + n);
		const bars = Array.from({ length: ly - fy + 1 }, (_, i) => {
			const y = String(fy + i);
			return { key: y, value: byYear.get(fy + i) ?? 0, edge: y, title: y };
		});
		return { bars, yearly: true };
	}
	const bars = Array.from({ length: span }, (_, i) => {
		const y = fy + Math.floor((fm - 1 + i) / 12);
		const m = ((fm - 1 + i) % 12) + 1;
		const ym = `${y}-${String(m).padStart(2, "0")}`;
		return { key: ym, value: byMonth.get(ym) ?? 0, edge: `${y}/${m}`, title: formatMonth(ym) };
	});
	return { bars, yearly: false };
}

function Shooting({ s }: { s: LibraryStats }) {
	const [range, setRange] = useState<"year" | "all">("year");
	const [showTable, setShowTable] = useState(false);
	const { bars, peak } = useMemo(() => {
		if (range === "year") {
			const bars = weekBars(s);
			return { bars, peak: t.stats.peakWeek };
		}
		const { bars, yearly } = allTimeBars(s);
		return { bars, peak: yearly ? t.stats.peakYear : t.stats.peakMonth };
	}, [s, range]);
	const max = Math.max(...bars.map((b) => b.value), 0);
	return (
		<section className="space-y-3">
			<SectionTitle title={t.stats.shooting}>
				<div className="flex items-center gap-3">
					<Segmented
						value={range}
						options={[
							["year", t.stats.lastYear],
							["all", t.stats.allTime],
						]}
						onChange={setRange}
					/>
					<button className="text-sm text-accent" onClick={() => setShowTable(!showTable)}>
						{showTable ? t.usage.showChart : t.usage.showTable}
					</button>
				</div>
			</SectionTitle>
			{max === 0 ? (
				<p className="rounded-lg border border-border p-3 text-sm text-muted">{t.stats.noShots}</p>
			) : showTable ? (
				<div className="max-h-80 overflow-y-auto rounded-lg border border-border">
					<table className="w-full text-sm tabular-nums">
						<thead className="sticky top-0 bg-bg text-left text-muted">
							<tr className="border-b border-border">
								<th className="px-3 py-2 font-normal">{t.stats.period}</th>
								<th className="px-3 py-2 text-right font-normal">{t.stats.photosCol}</th>
							</tr>
						</thead>
						<tbody>
							{[...bars].reverse().map((b) => (
								<tr key={b.key} className="border-b border-border last:border-0">
									<td className="px-3 py-2">{b.title}</td>
									<td className="px-3 py-2 text-right">{num(b.value)}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			) : (
				<BarChart
					key={range}
					bars={bars}
					idle={peak(num(max))}
					caption={(b) => (
						<>
							<span className="font-medium">{(b as PeriodBar).title}</span>
							<span className="text-muted"> {t.stats.count(num(b.value))}</span>
						</>
					)}
				/>
			)}
			{s.noDate > 0 && <p className="text-xs text-muted">{t.stats.noDate(num(s.noDate))}</p>}
		</section>
	);
}

// ------------------------------------------------------------------ 拍摄设备

const CAMERAS_COLLAPSED = 10;

function Cameras({ s }: { s: LibraryStats }) {
	const [all, setAll] = useState(false);
	const rows = all ? s.cameras : s.cameras.slice(0, CAMERAS_COLLAPSED);
	const unknown = s.unknownCamera.photos + s.unknownCamera.videos;
	const max = Math.max(...s.cameras.map((c) => c.photos + c.videos), unknown, 1);
	const row = (key: string, name: string, photos: number, videos: number, muted = false) => (
		<tr key={key} className="border-b border-border last:border-0">
			<td className="px-3 py-2">
				<div className={`truncate ${muted ? "text-muted" : ""}`}>{name}</div>
				<div className="mt-1 h-1 rounded-full bg-accent/70" style={{ width: `${((photos + videos) / max) * 100}%` }} />
			</td>
			<td className="px-3 py-2 text-right">{num(photos)}</td>
			<td className="px-3 py-2 text-right">{num(videos)}</td>
			<td className="px-3 py-2 text-right font-medium">{num(photos + videos)}</td>
		</tr>
	);
	return (
		<section className="space-y-3">
			<SectionTitle title={t.stats.cameras} />
			{s.cameras.length === 0 && unknown === 0 ? (
				<p className="rounded-lg border border-border p-3 text-sm text-muted">{t.stats.noCameras}</p>
			) : (
				<div className="overflow-x-auto rounded-lg border border-border">
					<table className="w-full table-fixed text-sm tabular-nums">
						<colgroup>
							<col />
							<col className="w-20" />
							<col className="w-20" />
							<col className="w-20" />
						</colgroup>
						<thead className="text-left text-muted">
							<tr className="border-b border-border">
								<th className="px-3 py-2 font-normal">{t.stats.camera}</th>
								<th className="px-3 py-2 text-right font-normal">{t.stats.photos}</th>
								<th className="px-3 py-2 text-right font-normal">{t.stats.videos}</th>
								<th className="px-3 py-2 text-right font-normal">{t.stats.total}</th>
							</tr>
						</thead>
						<tbody>
							{rows.map((c) => row(c.camera, c.camera, c.photos, c.videos))}
							{unknown > 0 && row("?", t.stats.unknownCamera, s.unknownCamera.photos, s.unknownCamera.videos, true)}
						</tbody>
					</table>
				</div>
			)}
			{s.cameras.length > CAMERAS_COLLAPSED && (
				<button className="text-sm text-accent" onClick={() => setAll(!all)}>
					{all ? t.stats.showLess : t.stats.showAll(num(s.cameras.length))}
				</button>
			)}
		</section>
	);
}

// ------------------------------------------------------------------ 最大的文件

/** 最大的照片 / 视频：复用文件夹的列表视图（文件名、原件大小、拍摄时间），自带查看器、多选和删除；顺序就是排名。 */
function Largest() {
	const [kind, setKind] = useState<"photo" | "video">("photo");
	return (
		<section className="space-y-3">
			<SectionTitle title={t.stats.largest}>
				<Segmented
					value={kind}
					options={[
						["photo", t.stats.largestPhotos],
						["video", t.stats.largestVideos],
					]}
					onChange={setKind}
				/>
			</SectionTitle>
			<p className="text-xs text-muted">{t.stats.largestHint(LARGEST_MAX)}</p>
			<LibraryList
				key={kind}
				source={{ key: ["stats-largest", kind], path: `/stats/largest/${kind}` }}
				context={{ kind: "library" }}
				groupByDay={false}
				view="list"
				empty={kind === "photo" ? t.stats.noPhotos : t.stats.noVideos}
			/>
		</section>
	);
}

function Growth({ growth }: { growth: UsageStats["growth"] }) {
	if (!growth.length) return null;
	return (
		<section className="space-y-3">
			<h2 className="text-lg font-semibold">{t.usage.growth}</h2>
			<div className="overflow-x-auto rounded-lg border border-border">
				<table className="w-full text-sm tabular-nums">
					<thead className="text-left text-muted">
						<tr className="border-b border-border">
							<th className="px-3 py-2 font-normal">{t.usage.month}</th>
							<th className="px-3 py-2 text-right font-normal">{t.usage.items}</th>
							<th className="px-3 py-2 text-right font-normal">{t.usage.originalSize}</th>
						</tr>
					</thead>
					<tbody>
						{[...growth].reverse().map((g) => (
							<tr key={g.month} className="border-b border-border last:border-0">
								<td className="px-3 py-2">{formatMonth(g.month)}</td>
								<td className="px-3 py-2 text-right">{num(g.assets)}</td>
								<td className="px-3 py-2 text-right">{formatBytes(g.bytes)}</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</section>
	);
}
