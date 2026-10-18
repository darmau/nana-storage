import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { BUDGET_WARN_RATIO, DEFAULT_PROCESSORS } from "@nana/shared";
import { api } from "../../api";
import { useGuard } from "../../guard";
import { fmtNumber, getLocalePref, locale, LOCALE_NAMES, LOCALES, type LocalePref, setLocalePref, t } from "../../i18n";
import { IconChevronRight, IconLogout, IconMonitor, IconMoon, IconSun } from "../../ui/icons";
import { getThemePref, setThemePref, type ThemePref } from "../../ui/theme";
import { GUARD_LABELS, Group, SETTINGS_PAGES, SettingsHeader, shortDateTime, useFailedJobs } from "./shared";

interface Overview {
	counts: { pending: number; running: number; stuck: number; retrying: number };
	perMinute: number;
}

/** 设置首页：先给一眼能看懂的运行状态，再是外观、账户、关于。窄屏时中间还有各分页的入口。 */
export function SettingsOverview() {
	const qc = useQueryClient();
	const refresh = () => {
		void qc.invalidateQueries({ queryKey: ["guard"] });
		void qc.invalidateQueries({ queryKey: ["jobs"] });
	};
	return (
		<div className="space-y-8">
			<SettingsHeader
				back={false}
				title={
					<>
						<span className="lg:hidden">{t.settings.title}</span>
						<span className="hidden lg:inline">{t.settings.overview}</span>
					</>
				}
			>
				<button className="btn" onClick={refresh}>
					{t.common.refresh}
				</button>
			</SettingsHeader>
			<StatusPanel />
			<PageList />
			<Appearance />
			<Language />
			<Account />
			<About />
		</div>
	);
}

/** 运行状态：一句话结论 + 四个可以点进去的数字。 */
function StatusPanel() {
	const guard = useGuard();
	const active = useQuery({ queryKey: ["jobs", "active"], queryFn: () => api<Overview>("/jobs/active") });
	const failed = useFailedJobs();
	const g = guard.data;
	const c = active.data?.counts;
	const remaining = c ? c.pending + c.running + c.stuck : 0;
	const failedN = failed.data?.total ?? 0;

	// 今天最接近上限的那一项
	const budgetPct = g ? (g.monthCostUsd / g.budgetUsd) * 100 : null;

	const state: "loading" | "tripped" | "attention" | "ok" = !g ? "loading" : g.tripped ? "tripped" : failedN > 0 || (c?.stuck ?? 0) > 0 ? "attention" : "ok";
	const headline = {
		loading: t.settings.status.loading,
		tripped: t.settings.status.tripped,
		attention: c?.stuck ? t.settings.status.stuck : t.settings.status.failed(failedN),
		ok: remaining > 0 ? t.settings.status.processing : t.settings.status.ok,
	}[state];
	const dot = { loading: "bg-muted", tripped: "bg-danger", attention: "bg-warn", ok: "bg-ok" }[state];
	const tone = state === "tripped" ? "border-danger/40 bg-danger/10" : "border-border bg-card";
	const headTone = state === "tripped" ? "text-danger" : state === "attention" ? "text-warn" : "";

	return (
		<section className={`overflow-hidden rounded-2xl border ${tone}`}>
			<Link to={state === "tripped" ? "/settings/guard" : "/settings/processing"} className="flex items-start gap-3 p-4 transition hover:bg-surface/60">
				<span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${dot}`} aria-hidden="true" />
				<div className="min-w-0 flex-1">
					<div className={`text-lg font-semibold ${headTone}`}>{headline}</div>
					<div className="mt-0.5 text-sm text-muted">
						{state === "tripped" && g?.trippedReason}
						{state !== "tripped" &&
							(g ? t.settings.status.today(GUARD_LABELS.containerSeconds.fmt(g.usage.containerSeconds), g.usage.jobs) : " ")}
					</div>
				</div>
				<IconChevronRight className="mt-1 shrink-0 text-muted" />
			</Link>
			<div className="grid grid-cols-2 border-t border-border sm:grid-cols-4 [&>*]:border-border max-sm:[&>*:nth-child(-n+2)]:border-b max-sm:[&>*:nth-child(odd)]:border-r sm:[&>*:not(:last-child)]:border-r">
				<Stat
					to="/settings/processing"
					label={t.settings.pages.processing}
					value={c ? (remaining ? fmtNumber(remaining) : t.settings.status.idle) : "—"}
					sub={remaining ? t.settings.status.running(c!.running) : active.data?.perMinute ? t.settings.status.recent(Math.round(active.data.perMinute * 10)) : t.settings.status.noQueue}
				/>
				<Stat
					to="/settings/processing"
					label={t.settings.status.failedLabel}
					value={failed.data ? fmtNumber(failedN) : "—"}
					sub={failedN ? t.settings.status.failedSub : t.settings.status.none}
					warn={failedN > 0}
				/>
				<Stat
					to="/settings/guard"
					label={t.settings.status.monthCost}
					value={g ? `$${g.monthCostUsd.toFixed(2)}` : "—"}
					sub={g ? t.settings.status.budget(g.budgetUsd, Math.round(budgetPct!)) : " "}
					warn={budgetPct !== null && budgetPct > BUDGET_WARN_RATIO * 100}
				/>
				<Stat
					to="/settings/guard"
					label={t.settings.status.containers}
					value={g ? `${g.busySlots} / ${g.processors}` : "—"}
					sub={g?.overrideExpiresAt ? t.settings.status.overrideUntil(shortDateTime(g.overrideExpiresAt)) : t.settings.status.defaultContainers(DEFAULT_PROCESSORS)}
				/>
			</div>
		</section>
	);
}

function Stat({ to, label, value, sub, warn }: { to: "/settings/processing" | "/settings/guard"; label: string; value: string; sub: string; warn?: boolean }) {
	return (
		<Link to={to} className="min-w-0 p-4 transition hover:bg-surface/60">
			<div className="truncate text-xs text-muted">{label}</div>
			<div className={`mt-1 text-2xl font-semibold tabular-nums ${warn ? "text-warn" : ""}`}>{value}</div>
			<div className="mt-0.5 truncate text-xs text-muted">{sub}</div>
		</Link>
	);
}

const PAGE_HINTS: Record<string, string> = {
	"/settings/processing": t.settings.pageHints.processing,
	"/settings/guard": t.settings.pageHints.guard,
};

/** 窄屏：各分页的入口（宽屏时在左侧导航里）。 */
function PageList() {
	return (
		<div className="lg:hidden">
			<Group title={t.settings.manage}>
				{SETTINGS_PAGES.slice(1).map(({ to, label, icon: Icon }) => (
					<Link key={to} to={to} className="flex min-h-14 items-center gap-3 px-4 py-2.5 transition hover:bg-surface">
						<span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent-ink">
							<Icon size={18} />
						</span>
						<div className="min-w-0 flex-1">
							<div className="text-sm font-medium">{label}</div>
							<div className="truncate text-xs text-muted">{PAGE_HINTS[to]}</div>
						</div>
						<IconChevronRight className="shrink-0 text-muted" />
					</Link>
				))}
			</Group>
		</div>
	);
}

const THEMES: { value: ThemePref; label: string; icon: typeof IconSun }[] = [
	{ value: "system", label: t.settings.appearance.system, icon: IconMonitor },
	{ value: "light", label: t.settings.appearance.light, icon: IconSun },
	{ value: "dark", label: t.settings.appearance.dark, icon: IconMoon },
];

function Appearance() {
	const [theme, setTheme] = useState(getThemePref);
	const pick = (pref: ThemePref) => {
		setThemePref(pref);
		setTheme(pref);
	};
	return (
		<Group title={t.settings.appearance.title} footer={t.settings.appearance.footer}>
			<div role="radiogroup" aria-label={t.settings.appearance.title} className="grid grid-cols-3 gap-1.5 p-1.5">
				{THEMES.map(({ value, label, icon: Icon }) => (
					<button
						key={value}
						role="radio"
						aria-checked={theme === value}
						onClick={() => pick(value)}
						className={`flex min-h-16 flex-col items-center justify-center gap-1.5 rounded-xl text-sm transition ${
							theme === value ? "bg-accent-soft font-semibold text-accent-ink" : "text-fg/80 hover:bg-surface"
						}`}
					>
						<Icon />
						{label}
					</button>
				))}
			</div>
		</Group>
	);
}

const LANGUAGES: { value: LocalePref; label: string }[] = [
	{ value: "system", label: t.settings.language.system },
	...LOCALES.map((value) => ({ value, label: LOCALE_NAMES[value] })),
];

/** 下拉框：以后语言会越来越多，按钮排不下 */
function Language() {
	const current = getLocalePref();
	return (
		<Group title={t.settings.language.title} footer={t.settings.language.footer}>
			<label className="flex min-h-12 items-center gap-3 px-4 py-2 text-sm">
				<span className="flex-1">{t.settings.language.title}</span>
				<select
					className="h-9 max-w-[60%] rounded-full border border-border bg-card px-3 text-sm font-medium text-fg"
					value={current}
					onChange={(e) => {
						const value = e.target.value as LocalePref;
						if (value !== current) setLocalePref(value);
					}}
				>
					{LANGUAGES.map(({ value, label }) => (
						<option key={value} value={value}>
							{label}
						</option>
					))}
				</select>
			</label>
		</Group>
	);
}

function Account() {
	const me = useQuery({ queryKey: ["me"], queryFn: () => api<{ email: string }>("/me"), staleTime: Infinity });
	const email = me.data?.email;
	return (
		<Group title={t.settings.account.title} footer={t.settings.account.footer}>
			<div className="flex items-center gap-3 p-4">
				<span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent text-base font-semibold uppercase text-accent-fg" aria-hidden="true">
					{email?.[0] ?? ""}
				</span>
				<div className="min-w-0 flex-1">
					<div className="truncate text-sm font-medium">{email ?? "…"}</div>
					<div className="text-xs text-muted">{t.settings.account.owner}</div>
				</div>
			</div>
			{/* Access 的退出地址，清掉这个域名上的登录状态 */}
			<a href="/cdn-cgi/access/logout" className="flex min-h-12 items-center gap-3 px-4 text-sm font-medium text-danger transition hover:bg-surface">
				<IconLogout size={18} />
				{t.settings.account.logout}
			</a>
		</Group>
	);
}

function About() {
	const built = new Date(__APP_BUILD__.builtAt);
	return (
		<Group title={t.settings.about.title}>
			<div className="flex items-baseline justify-between gap-3 px-4 py-3 text-sm">
				<span>{t.settings.about.version}</span>
				<span className="font-mono text-xs text-muted">{__APP_BUILD__.commit}</span>
			</div>
			<div className="flex items-baseline justify-between gap-3 px-4 py-3 text-sm">
				<span>{t.settings.about.built}</span>
				<span className="text-muted tabular-nums">{Number.isNaN(built.getTime()) ? "—" : built.toLocaleString(locale)}</span>
			</div>
			<div className="px-4 py-3 text-xs leading-relaxed text-muted">
				{t.settings.about.description(t.app.name)}
			</div>
		</Group>
	);
}
