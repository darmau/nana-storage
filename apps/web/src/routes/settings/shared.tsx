import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { BUDGET_WARN_RATIO, type GuardMetric } from "@nana/shared";
import { api } from "../../api";
import { fmtNumber, locale, t } from "../../i18n";
import { IconActivity, IconChevronLeft, IconSettings, IconShield } from "../../ui/icons";
import type { ActiveJob } from "../ProcessingStatus";

/** 设置的各个分页：宽屏时是左侧的分页导航，窄屏时是概览页里的列表。 */
export const SETTINGS_PAGES = [
	{ to: "/settings", label: t.settings.overview, icon: IconSettings },
	{ to: "/settings/processing", label: t.settings.pages.processing, icon: IconActivity },
	{ to: "/settings/guard", label: t.settings.pages.guard, icon: IconShield },
] as const;

export const GUARD_LABELS: Record<GuardMetric, { name: string; fmt: (n: number) => string }> = {
	containerSeconds: { name: t.settings.metrics.containerSeconds, fmt: (n) => t.settings.time.hours((n / 3600).toFixed(2)) },
	jobs: { name: t.settings.metrics.jobs, fmt: fmtNumber },
	uploadBytes: { name: t.settings.metrics.uploadBytes, fmt: (n) => `${(n / 1024 ** 3).toFixed(2)} GB` },
};
export const GUARD_METRICS = Object.keys(GUARD_LABELS) as GuardMetric[];

export interface FailedJob extends Omit<ActiveJob, "status"> {
	updated_at: number;
}

export const useFailedJobs = () =>
	useQuery({ queryKey: ["jobs", "failed"], queryFn: () => api<{ total: number; items: FailedJob[] }>("/jobs/failed") });

export function duration(ms: number) {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return t.settings.time.seconds(s);
	const m = Math.round(s / 60);
	if (m < 60) return t.settings.time.minutes(m);
	const h = Math.floor(m / 60);
	if (h < 48) return t.settings.time.hoursMinutes(h, m % 60);
	return t.settings.time.days(Math.round(h / 24));
}

export function ago(ts: number) {
	const ms = Date.now() - ts;
	if (ms < 60_000) return t.settings.time.justNow;
	if (ms < 24 * 3600_000) {
		// 和 duration() 一样先取整到秒；一小时以上只说到小时
		const m = Math.round(Math.round(ms / 1000) / 60);
		return t.settings.time.ago(m < 60 ? t.settings.time.minutes(m) : t.settings.time.hours(Math.floor(m / 60)));
	}
	return new Date(ts).toLocaleString(locale, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export const shortDateTime = (ts: number) =>
	new Date(ts).toLocaleString(locale, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** 分页标题。窄屏时左边有返回概览的按钮；宽屏时左侧有分页导航，不需要它。 */
export function SettingsHeader({ title, back = true, children }: { title: React.ReactNode; back?: boolean; children?: React.ReactNode }) {
	return (
		<div className="flex min-h-11 items-center gap-2 pt-1">
			{back && (
				<Link to="/settings" className="icon-btn -ml-2 lg:hidden" aria-label={t.settings.back}>
					<IconChevronLeft />
				</Link>
			)}
			<h1 className="page-title min-w-0 flex-1 truncate">{title}</h1>
			{children}
		</div>
	);
}

/** 一组设置：小标题 + 圆角卡片，卡片里的行用分隔线隔开。 */
export function Group({ title, action, footer, children }: { title?: string; action?: React.ReactNode; footer?: React.ReactNode; children: React.ReactNode }) {
	return (
		<section className="space-y-2">
			{(title || action) && (
				<div className="flex items-baseline justify-between gap-3 px-1">
					{title && <h2 className="text-sm font-semibold text-muted">{title}</h2>}
					{action}
				</div>
			)}
			<div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">{children}</div>
			{footer && <div className="px-1 text-xs leading-relaxed text-muted">{footer}</div>}
		</section>
	);
}

/** 用量条：超过 BUDGET_WARN_RATIO 变成警示色。 */
export function Meter({ label, value, limit, fmt }: { label: string; value: number; limit: number; fmt: (n: number) => string }) {
	const pct = Math.min(100, (value / Math.max(limit, 1)) * 100);
	return (
		<div className="p-4 text-sm">
			<div className="flex items-baseline justify-between gap-2">
				<span className="text-muted">{label}</span>
				<span className="tabular-nums text-muted">{Math.round(pct)}%</span>
			</div>
			<div className="mt-1 font-medium tabular-nums">
				{fmt(value)} <span className="font-normal text-muted">/ {fmt(limit)}</span>
			</div>
			<div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface">
				<div className={`h-full rounded-full ${pct > BUDGET_WARN_RATIO * 100 ? "bg-danger" : "bg-accent"}`} style={{ width: `${pct}%` }} />
			</div>
		</div>
	);
}
