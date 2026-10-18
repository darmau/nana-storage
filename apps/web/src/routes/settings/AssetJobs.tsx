import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, errorText } from "../../api";
import { t } from "../../i18n";
import { formatBytes } from "../../timeline/format";
import { confirmDialog } from "../../ui/confirm";
import { JobThumb, KIND_LABEL } from "../ProcessingStatus";
import { ago, type FailedJob } from "./shared";

interface AssetJob extends Omit<FailedJob, "status"> {
	status: "pending" | "running" | "done" | "failed";
}

/** 和服务端 jobs.ts 的 CANCELLED_ERROR 一致：手动停止的任务。 */
const CANCELLED = "cancelled";

/**
 * 一个条目的全部任务（最新的在前），可以停止排队中的、重试失败的。
 * 成本防护因为“同一张照片反复处理”熔断时显示在熔断提示里：先看清做了什么，停掉不想要的，再恢复。
 * 只在打开页面和点“刷新”时请求，不自动刷新。重试在熔断时不允许（服务端同样拒绝），停止允许。
 */
export function AssetJobs({ assetId, tripped }: { assetId: string; tripped: boolean }) {
	const qc = useQueryClient();
	const query = useQuery({
		queryKey: ["jobs", "asset", assetId],
		queryFn: () => api<{ staleAfterMs: number; items: AssetJob[] }>(`/jobs/asset/${encodeURIComponent(assetId)}`),
	});
	const onSuccess = () => void qc.invalidateQueries({ queryKey: ["jobs"] });
	const cancel = useMutation({
		mutationFn: (ids: string[]) => api<{ cancelled: number }>("/jobs/cancel", { method: "POST", json: { ids } }),
		onSuccess,
	});
	const retry = useMutation({
		mutationFn: (ids: string[]) => api<{ retried: number }>("/jobs/retry", { method: "POST", json: { ids } }),
		onSuccess,
	});
	const busy = cancel.isPending || retry.isPending;

	const items = query.data?.items ?? [];
	const staleBefore = Date.now() - (query.data?.staleAfterMs ?? Infinity);
	const stuck = (j: AssetJob) => j.status === "running" && (j.started_at ?? 0) < staleBefore;
	const cancellable = items.filter((j) => j.status === "pending" || stuck(j));
	const names = items.find((j) => j.names.length)?.names;

	const cancelAll = async () => {
		const ok = await confirmDialog({
			title: t.processing.stopTitle(cancellable.length),
			message: t.processing.stopMessage,
			confirmLabel: t.processing.stop,
		});
		if (ok) cancel.mutate(cancellable.map((j) => j.id));
	};

	return (
		<div className="space-y-2">
			<div className="flex items-center justify-between gap-3">
				<div className="min-w-0">
					<div className="font-medium">{t.processing.assetHeading}</div>
					<div className="truncate text-xs text-muted">{names ? names.join(" · ") : <span className="font-mono">{assetId}</span>}</div>
				</div>
				{cancellable.length > 1 && (
					<button className="btn h-8 shrink-0 px-3 text-xs" disabled={busy} onClick={() => void cancelAll()}>
						{t.processing.stopAll}
					</button>
				)}
			</div>
			{query.error && <p className="text-danger">{t.common.loadFailed(errorText(query.error))}</p>}
			{query.data && items.length === 0 && <p className="text-muted">{t.processing.assetNotFound}</p>}
			{items.length > 0 && (
				<ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
					{items.map((j) => {
						const canCancel = j.status === "pending" || stuck(j);
						const cancelled = j.status === "failed" && j.last_error === CANCELLED;
						return (
							<li key={j.id} className="flex items-start gap-3 p-3">
								<JobThumb job={j} />
								<div className="min-w-0 flex-1">
									<div className="truncate">
										{KIND_LABEL[j.kind] ?? j.kind} · <JobState job={j} stuck={stuck(j)} />
									</div>
									<div className="truncate text-xs text-muted">
										{`${t.processing.attempts(j.attempts)} · ${formatBytes(j.size)} · ${ago(j.updated_at)}`}
									</div>
									{j.last_error && !cancelled && <div className="mt-1 line-clamp-2 break-words text-xs text-danger">{j.last_error}</div>}
								</div>
								{canCancel && (
									<button className="btn h-8 shrink-0 px-3 text-xs" disabled={busy} onClick={() => cancel.mutate([j.id])}>
										{t.processing.stop}
									</button>
								)}
								{j.status === "failed" && (
									<button className="btn h-8 shrink-0 px-3 text-xs" disabled={busy || tripped} onClick={() => retry.mutate([j.id])}>
										{t.processing.retry}
									</button>
								)}
							</li>
						);
					})}
				</ul>
			)}
			{cancel.data && <p className="text-muted">{t.processing.stopped(cancel.data.cancelled)}</p>}
			{retry.data && <p className="text-muted">{t.processing.requeued(retry.data.retried)}</p>}
			{(cancel.error || retry.error) && <p className="text-danger">{errorText(cancel.error ?? retry.error)}</p>}
			{tripped && items.some((j) => j.status === "failed") && <p className="text-xs text-muted">{t.processing.retryAfterResume}</p>}
		</div>
	);
}

function JobState({ job, stuck }: { job: AssetJob; stuck: boolean }) {
	if (stuck) return <span className="text-warn">{t.processing.states.stuck}</span>;
	if (job.status === "running") return <span className="text-accent">{t.processing.states.running}</span>;
	if (job.status === "pending") return <span>{job.attempts > 0 ? t.processing.states.waitingRetry : t.processing.states.queued}</span>;
	if (job.status === "done") return <span className="text-ok">{t.processing.states.done}</span>;
	return <span className="text-danger">{job.last_error === CANCELLED ? t.processing.states.stopped : t.processing.states.failed}</span>;
}
