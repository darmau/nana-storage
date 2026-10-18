import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MAX_JOB_ATTEMPTS } from "@nana/shared";
import { api, errorText } from "../../api";
import { useGuard } from "../../guard";
import { fmtNumber, t } from "../../i18n";
import { formatBytes } from "../../timeline/format";
import { confirmDialog } from "../../ui/confirm";
import { JobThumb, KIND_LABEL, ProcessingStatus } from "../ProcessingStatus";
import { ago, SettingsHeader, useFailedJobs } from "./shared";

export function ProcessingPage() {
	return (
		<div className="space-y-8">
			<SettingsHeader title={t.settings.pages.processing} />
			<ProcessingStatus />
			<FailedJobs />
		</div>
	);
}

/**
 * 处理失败的任务（已经用完 MAX_JOB_ATTEMPTS 次尝试）。列出最近的 200 个，可以单个或全部重试；
 * 重试只是清零次数重新排队，照样受容器数和每日上限约束，熔断时不允许。
 */
function FailedJobs() {
	const qc = useQueryClient();
	const guard = useGuard();
	const failed = useFailedJobs();
	const retry = useMutation({
		mutationFn: (ids: string[]) => api<{ retried: number }>("/jobs/retry", { method: "POST", json: { ids } }),
		onSuccess: () => {
			void qc.invalidateQueries({ queryKey: ["jobs"] });
			void qc.invalidateQueries({ queryKey: ["guard"] });
		},
	});
	const tripped = !!guard.data?.tripped;
	const items = failed.data?.items ?? [];
	const total = failed.data?.total ?? 0;

	const retryAll = async () => {
		const ok = await confirmDialog({
			title: t.processing.retryAllTitle(items.length),
			message: t.processing.retryAllMessage,
			confirmLabel: t.processing.retryAll,
		});
		if (ok) retry.mutate(items.map((j) => j.id));
	};

	return (
		<section className="space-y-3">
			<div className="flex items-center justify-between gap-3">
				<h2 className="text-lg font-semibold">
					{t.processing.failedTitle}
					{total > 0 && <span className="ml-1.5 text-base font-normal text-muted tabular-nums">{fmtNumber(total)}</span>}
				</h2>
				{items.length > 1 && (
					<button className="btn" disabled={retry.isPending || tripped} onClick={() => void retryAll()}>
						{t.processing.retryAll}
					</button>
				)}
			</div>
			{failed.error && <p className="text-sm text-danger">{t.common.loadFailed(errorText(failed.error))}</p>}
			{failed.data && total === 0 && <p className="rounded-2xl border border-border bg-card p-4 text-sm text-muted">{t.processing.noFailed}</p>}
			{tripped && total > 0 && <p className="text-sm text-danger">{t.processing.trippedRetry}</p>}
			{retry.data && <p className="text-sm text-muted">{t.processing.retried(retry.data.retried)}</p>}
			{retry.error && <p className="text-sm text-danger">{errorText(retry.error)}</p>}
			{items.length > 0 && (
				<ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card text-sm">
					{items.map((j) => (
						<li key={j.id} className="flex items-start gap-3 p-3">
							<JobThumb job={j} />
							<div className="min-w-0 flex-1">
								<div className="truncate">{j.names.length ? j.names.join(" · ") : <span className="font-mono text-xs">{j.asset_id}</span>}</div>
								<div className="truncate text-xs text-muted">
									{KIND_LABEL[j.kind] ?? j.kind} · {formatBytes(j.size)} · {ago(j.updated_at)}
								</div>
								{j.last_error && <div className="mt-1 line-clamp-2 break-words text-xs text-danger">{j.last_error}</div>}
							</div>
							<button className="btn h-8 px-3 text-xs" disabled={retry.isPending || tripped} onClick={() => retry.mutate([j.id])}>
								{t.processing.retry}
							</button>
						</li>
					))}
				</ul>
			)}
			<p className="text-xs text-muted">
				{t.processing.attemptsNote(MAX_JOB_ATTEMPTS)}
				{total > items.length && t.processing.listedNote(items.length)}
			</p>
		</section>
	);
}
