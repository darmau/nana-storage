import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
	DEFAULT_MONTHLY_BUDGET_USD,
	DEFAULT_PROCESSORS,
	MAX_MONTHLY_BUDGET_USD,
	MIN_MONTHLY_BUDGET_USD,
	PRICING,
	PROCESSOR_POOL_SIZE,
	type GuardStatus,
} from "@nana/shared";
import { api, errorText } from "../../api";
import { useGuard } from "../../guard";
import { locale, t } from "../../i18n";
import { confirmDialog } from "../../ui/confirm";
import { AssetJobs } from "./AssetJobs";
import { duration, GUARD_LABELS, GUARD_METRICS, Meter, SettingsHeader, shortDateTime } from "./shared";

/**
 * 成本防护：只防失控。本月容器的估算费用到了月度上限（可以修改）、同一张照片反复处理时熔断；
 * 每天的用量只显示，不限制。另外可以在批量导入时临时调高同时运行的容器数（最长 7 天，可以提前结束）。
 */
export function GuardPage() {
	const qc = useQueryClient();
	const guard = useGuard();
	const refresh = () => {
		void qc.invalidateQueries({ queryKey: ["guard"] });
		void qc.invalidateQueries({ queryKey: ["jobs"] });
	};
	const g = guard.data;
	return (
		<div className="space-y-8">
			<SettingsHeader title={t.settings.pages.guard}>
				<button className="btn" disabled={guard.isFetching} onClick={refresh}>
					{t.common.refresh}
				</button>
			</SettingsHeader>
			<p className="text-sm leading-relaxed text-muted">
				{t.guard.intro}
			</p>
			{guard.error && <p className="text-sm text-danger">{t.common.loadFailed(errorText(guard.error))}</p>}
			{g && (
				<>
					<TripState g={g} onDone={refresh} />
					<Budget g={g} onDone={refresh} />
					<section className="space-y-3">
						<h2 className="text-lg font-semibold">{t.guard.today}</h2>
						<div className="grid overflow-hidden rounded-2xl border border-border bg-card sm:grid-cols-2 [&>*]:border-border max-sm:[&>*:not(:last-child)]:border-b sm:[&>*:nth-child(-n+2)]:border-b sm:[&>*:nth-child(odd)]:border-r">
							{GUARD_METRICS.map((k) => (
								<Figure key={k} label={GUARD_LABELS[k].name} value={GUARD_LABELS[k].fmt(g.usage[k])} />
							))}
							<Meter label={t.settings.status.containers} value={g.busySlots} limit={g.processors} fmt={t.guard.count} />
						</div>
						<p className="text-xs text-muted">{t.guard.dayNote(g.day)}</p>
					</section>
					<Processors g={g} onDone={refresh} />
				</>
			)}
		</div>
	);
}

function Figure({ label, value }: { label: string; value: string }) {
	return (
		<div className="p-4 text-sm">
			<div className="text-muted">{label}</div>
			<div className="mt-1 font-medium tabular-nums">{value}</div>
		</div>
	);
}

const usd = (n: number) => `$${n.toFixed(2)}`;

/** 一个容器满载一小时的费用（超出免费额度之后）。 */
const C = PRICING.containers;
const CONTAINER_HOURLY_USD = 3600 * (C.vcpu * C.perVcpuSecond + C.memoryGib * C.perGibSecond + C.diskGb * C.perGbSecond);

function TripState({ g, onDone }: { g: GuardStatus; onDone: () => void }) {
	const resume = useMutation({
		mutationFn: () => api<{ requeued: number }>("/guard/resume", { method: "POST" }),
		onSuccess: onDone,
	});
	const overBudget = g.monthCostUsd >= g.budgetUsd;
	if (!g.tripped) {
		return (
			<div className="flex items-center gap-3 rounded-2xl border border-border bg-card p-4 text-sm">
				<span className="h-2.5 w-2.5 shrink-0 rounded-full bg-ok" aria-hidden="true" />
				<span className="font-medium">{t.guard.ok}</span>
				{resume.data && <span className="text-muted">{t.guard.requeued(resume.data.requeued)}</span>}
			</div>
		);
	}
	return (
		<div className="space-y-3 rounded-2xl border border-danger/40 bg-danger/10 p-4 text-sm">
			<p className="text-base font-semibold text-danger">{t.guard.trippedTitle}</p>
			<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
				<dt className="text-muted">{t.guard.reason}</dt>
				<dd className="break-words">{g.trippedReason}</dd>
				<dt className="text-muted">{t.guard.time}</dt>
				<dd>{g.trippedAt && new Date(g.trippedAt).toLocaleString(locale)}</dd>
			</dl>
			<p className="text-muted">
				{overBudget
					? t.guard.overBudgetHint
					: g.trippedAssetId
						? t.guard.assetHint
						: t.guard.genericHint}
			</p>
			{g.trippedAssetId && <AssetJobs assetId={g.trippedAssetId} tripped />}
			<button
				className="btn-solid-danger"
				disabled={resume.isPending || overBudget}
				onClick={() =>
					void confirmDialog({ title: t.guard.resumeTitle, message: t.guard.resumeMessage, confirmLabel: t.guard.resume }).then((ok) => (ok ? resume.mutate() : undefined))
				}
			>
				{t.guard.resumeButton}
			</button>
			{resume.error && <p className="text-danger">{errorText(resume.error)}</p>}
		</div>
	);
}

function Budget({ g, onDone }: { g: GuardStatus; onDone: () => void }) {
	const [value, setValue] = useState(g.budgetUsd);
	const save = useMutation({
		mutationFn: () => api<GuardStatus>("/guard/budget", { method: "PUT", json: { usd: value } }),
		onSuccess: onDone,
	});
	const m = g.month;
	return (
		<section className="space-y-3">
			<h2 className="text-lg font-semibold">{t.guard.month}</h2>
			<div className="grid overflow-hidden rounded-2xl border border-border bg-card sm:grid-cols-2 [&>*]:border-border max-sm:[&>*:not(:last-child)]:border-b sm:[&>*:nth-child(-n+2)]:border-b sm:[&>*:nth-child(odd)]:border-r">
				<Meter label={t.guard.costMeter} value={g.monthCostUsd} limit={g.budgetUsd} fmt={usd} />
				<Figure label={GUARD_LABELS.containerSeconds.name} value={GUARD_LABELS.containerSeconds.fmt(m.containerSeconds)} />
				<Figure label={GUARD_LABELS.jobs.name} value={GUARD_LABELS.jobs.fmt(m.jobs)} />
				<Figure label={GUARD_LABELS.uploadBytes.name} value={GUARD_LABELS.uploadBytes.fmt(m.uploadBytes)} />
			</div>
			<p className="text-xs leading-relaxed text-muted">
				{t.guard.monthNote}
			</p>
			<div className="space-y-3 rounded-2xl border border-border bg-card p-4 text-sm">
				<div>
					<h3 className="font-semibold">{t.guard.budgetTitle}</h3>
					<p className="mt-1 leading-relaxed text-muted">
						{t.guard.budgetHint(
							usd(DEFAULT_MONTHLY_BUDGET_USD),
							usd(CONTAINER_HOURLY_USD),
							C.vcpu,
							C.memoryGib,
							usd(g.budgetUsd),
							Math.round(g.budgetUsd / CONTAINER_HOURLY_USD),
						)}
					</p>
				</div>
				<div className="flex flex-wrap items-end gap-3">
					<label className="space-y-1">
						<span className="text-muted">
							{t.guard.limit}
							<span className="text-xs">{t.guard.limitRange(MIN_MONTHLY_BUDGET_USD, MAX_MONTHLY_BUDGET_USD)}</span>
						</span>
						<input
							type="number"
							inputMode="decimal"
							min={MIN_MONTHLY_BUDGET_USD}
							max={MAX_MONTHLY_BUDGET_USD}
							className="field block w-40 min-w-0 tabular-nums"
							value={value}
							onChange={(e) => setValue(Number(e.target.value))}
						/>
					</label>
					<button
						className="btn-primary"
						disabled={save.isPending || value === g.budgetUsd || !(value >= MIN_MONTHLY_BUDGET_USD && value <= MAX_MONTHLY_BUDGET_USD)}
						onClick={() => save.mutate()}
					>
						{t.common.save}
					</button>
					{save.error && <span className="text-danger">{errorText(save.error)}</span>}
				</div>
			</div>
		</section>
	);
}

function Processors({ g, onDone }: { g: GuardStatus; onDone: () => void }) {
	const override = g.overrideExpiresAt;
	// 调高中：表单从当前生效的值开始改
	const [form, setForm] = useState({ processors: override ? g.processors : 16, durationHours: 72 });
	const raise = useMutation({
		mutationFn: () => api<GuardStatus>("/guard/limits", { method: "POST", json: form }),
		onSuccess: onDone,
	});
	const reset = useMutation({
		mutationFn: () => api<GuardStatus>("/guard/limits", { method: "DELETE" }),
		onSuccess: onDone,
	});
	const endEarly = async () => {
		const ok = await confirmDialog({
			title: t.guard.endEarlyTitle,
			message: t.guard.endEarlyMessage(DEFAULT_PROCESSORS),
			confirmLabel: t.guard.endEarlyConfirm,
		});
		if (ok) reset.mutate();
	};
	const fields = [
		["processors", t.settings.status.containers, t.guard.processorsUnit(PROCESSOR_POOL_SIZE), 1, PROCESSOR_POOL_SIZE],
		["durationHours", t.guard.duration, t.guard.durationUnit, 1, 168],
	] as const;

	return (
		<section className="space-y-3">
			<h2 className="text-lg font-semibold">{t.settings.status.containers}</h2>
			{override && (
				<div className="flex flex-wrap items-center gap-3 rounded-2xl bg-notice p-4 text-sm">
					<div className="min-w-0 flex-1">
						<div className="font-medium">{t.guard.raisedTo(g.processors)}</div>
						<div className="text-muted">
							{t.guard.revertsAt(shortDateTime(override), DEFAULT_PROCESSORS, duration(override - Date.now()))}
						</div>
					</div>
					<button className="btn" disabled={reset.isPending} onClick={() => void endEarly()}>
						{t.guard.endEarly}
					</button>
				</div>
			)}
			{reset.error && <p className="text-sm text-danger">{errorText(reset.error)}</p>}
			<div className="space-y-4 rounded-2xl border border-border bg-card p-4 text-sm">
				<div>
					<h3 className="font-semibold">{override ? t.guard.editOverride : t.guard.raiseTitle}</h3>
					<p className="mt-1 leading-relaxed text-muted">
						{t.guard.raiseHint(DEFAULT_PROCESSORS)}
					</p>
				</div>
				<div className="grid gap-3 sm:grid-cols-2">
					{fields.map(([k, label, unit, min, max]) => (
						<label key={k} className="space-y-1">
							<span className="text-muted">
								{label}
								<span className="text-xs">{t.guard.unit(unit)}</span>
							</span>
							<input
								type="number"
								inputMode="numeric"
								min={min}
								max={max}
								className="field block w-full min-w-0 tabular-nums"
								value={form[k]}
								onChange={(e) => setForm({ ...form, [k]: Number(e.target.value) })}
							/>
						</label>
					))}
				</div>
				<div className="flex flex-wrap items-center gap-3">
					<button className="btn-primary" disabled={raise.isPending} onClick={() => raise.mutate()}>
						{override ? t.guard.update : t.guard.apply}
					</button>
					{raise.data?.overrideExpiresAt && !raise.isPending && <span className="text-muted">{t.guard.applied(shortDateTime(raise.data.overrideExpiresAt))}</span>}
					{raise.error && <span className="text-danger">{errorText(raise.error)}</span>}
				</div>
			</div>
		</section>
	);
}
