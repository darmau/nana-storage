import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, errorText } from "../api";
import { useGuard } from "../guard";
import { invalidateLibrary } from "../library/actions";
import { fmtNumber, t } from "../i18n";
import { formatBytes } from "../timeline/format";
import { thumbUrl } from "../timeline/types";
import { IconFile, IconPlay, IconRotate, IconStitch } from "../ui/icons";
import { duration } from "./settings/shared";

export interface ActiveJob {
	id: string;
	asset_id: string;
	kind: string;
	status: "pending" | "running";
	attempts: number;
	started_at: number | null;
	last_error: string | null;
	asset_kind: "photo" | "video" | "live";
	asset_status: string;
	derived_rev: number;
	size: number;
	names: string[];
}

interface Overview {
	now: number;
	counts: { pending: number; running: number; stuck: number; retrying: number };
	batch: { since: number; done: number; failed: number } | null;
	perMinute: number;
	staleAfterMs: number;
	/** 设备端处理接管中（apps/device）：排队的任务由这台设备拉取，不启动容器 */
	device: { name: string; until: number } | null;
	running: ActiveJob[];
	pending: ActiveJob[];
}

/** 有任务时每 5 秒刷新一次，最多 120 次（10 分钟）；之后要手动点“刷新”继续。 */
const REFRESH_MS = 5000;
const MAX_AUTO_REFRESH = 120;

export const KIND_LABEL: Record<string, string> = t.processing.kinds;

export function ProcessingStatus() {
	const qc = useQueryClient();
	const guard = useGuard();
	const query = useQuery({ queryKey: ["jobs", "active"], queryFn: () => api<Overview>("/jobs/active") });
	const data = query.data;
	const active = data ? data.counts.pending + data.counts.running + data.counts.stuck : 0;

	// 有上限的自动刷新（不用 refetchInterval）
	const [refreshes, setRefreshes] = useState(0);
	const autoStopped = refreshes >= MAX_AUTO_REFRESH;
	useEffect(() => {
		if (!active || autoStopped || query.isFetching || guard.data?.tripped) return;
		const timer = setTimeout(() => {
			setRefreshes((n) => n + 1);
			void query.refetch();
		}, REFRESH_MS);
		return () => clearTimeout(timer);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [active, autoStopped, query.isFetching, query.dataUpdatedAt, guard.data?.tripped]);
	const refresh = () => {
		setRefreshes(0);
		void query.refetch();
		void qc.invalidateQueries({ queryKey: ["guard"] });
	};

	// 处理完新的一批之后，让时间线和列表重新加载，新照片出现
	const lastDone = useRef<number | null>(null);
	useEffect(() => {
		const done = data?.batch?.done ?? null;
		if (lastDone.current !== null && (done === null || done > lastDone.current)) invalidateLibrary(qc);
		lastDone.current = done;
	}, [data?.batch?.done, qc]);

	// 运行时长每秒走一格（按服务端时间对齐）
	const [tick, setTick] = useState(() => Date.now());
	useEffect(() => {
		if (!data?.running.length) return;
		const timer = setInterval(() => setTick(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [data?.running.length]);
	const serverNow = data ? data.now + (tick - query.dataUpdatedAt) : 0;

	const requeue = useMutation({
		mutationFn: () => api<{ requeued: number }>("/jobs/requeue", { method: "POST" }),
		onSuccess: refresh,
	});
	// 停止排队中的或卡住的任务（记成 failed，可以在“处理失败”里重试）；熔断时也允许
	const cancel = useMutation({
		mutationFn: (ids: string[]) => api<{ cancelled: number }>("/jobs/cancel", { method: "POST", json: { ids } }),
		onSuccess: () => {
			refresh();
			void qc.invalidateQueries({ queryKey: ["jobs"] });
		},
	});
	const stopButton = (j: ActiveJob) => (
		<button className="btn h-8 shrink-0 px-3 text-xs" disabled={cancel.isPending} onClick={() => cancel.mutate([j.id])}>
			{t.processing.stop}
		</button>
	);

	const c = data?.counts;
	const remaining = c ? c.pending + c.running + c.stuck : 0;
	const total = data?.batch ? data.batch.done + data.batch.failed + remaining : 0;
	const pct = total ? ((data!.batch!.done + data!.batch!.failed) / total) * 100 : 0;
	const eta = data && data.perMinute > 0 ? (remaining / data.perMinute) * 60_000 : null;
	// 有任务等着却一个都没在跑、最近也没有完成的：多半是消息丢了，提示手动补发
	// 设备端接管时由设备拉取，不靠队列消息，不提示
	const stalled = !!c && (c.stuck > 0 || (c.pending > 0 && c.running === 0 && data!.perMinute === 0 && !data!.device));

	return (
		<section className="space-y-3">
			<div className="flex items-center justify-between">
				<h2 className="text-lg font-semibold">{t.processing.progress}</h2>
				<button className="btn" onClick={refresh} disabled={query.isFetching}>
					{t.common.refresh}
				</button>
			</div>
			{query.error && <p className="text-sm text-danger">{t.common.loadFailed(errorText(query.error))}</p>}
			{data?.device && (
				<p className="rounded-2xl border border-border bg-card p-4 text-sm">{t.processing.deviceActive(data.device.name)}</p>
			)}
			{data && !active && (
				<p className="rounded-2xl border border-border bg-card p-4 text-sm text-muted">
					{t.processing.idle}
					{data.perMinute > 0 && t.processing.idleRecent(Math.round(data.perMinute * 10))}
				</p>
			)}
			{data && active > 0 && (
				<div className="space-y-3 rounded-2xl border border-border bg-card p-4 text-sm">
					<div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
						<span className="font-medium">
							{data.batch ? `${fmtNumber(data.batch.done + data.batch.failed)} / ${fmtNumber(total)}` : t.processing.remaining(remaining)}
						</span>
						{!!data.batch?.failed && <span className="text-danger">{t.processing.failed(data.batch.failed)}</span>}
						<span className="text-muted">
							{guard.data?.tripped
								? t.processing.paused
								: eta !== null
									? t.processing.rate(data.perMinute < 10 ? data.perMinute.toFixed(1) : String(Math.round(data.perMinute)), duration(eta))
									: t.processing.estimating}
						</span>
					</div>
					<div className="h-1.5 overflow-hidden rounded-full bg-surface">
						<div className="h-full bg-accent transition-[width] duration-500" style={{ width: `${pct}%` }} />
					</div>
					<p className="text-xs text-muted">
						{t.processing.summary(c!.running, c!.pending)}
						{c!.retrying > 0 && t.processing.retryingTag(c!.retrying)}
						{c!.stuck > 0 && t.processing.stuckTag(c!.stuck)}
						{autoStopped && t.processing.autoStopped}
					</p>
					{(c!.pending > 0 || c!.stuck > 0) && !guard.data?.tripped && (
						<div className={`flex flex-wrap items-center gap-2 rounded-md px-3 py-2 ${stalled ? "bg-notice" : "bg-surface"}`}>
							<span className={`flex-1 ${stalled ? "" : "text-xs text-muted"}`}>
								{!stalled
									? t.processing.requeueHint
									: c!.stuck > 0
										? t.processing.stuckHint(c!.stuck, duration(data.staleAfterMs))
										: t.processing.lostHint}
							</span>
							<button className="btn" disabled={requeue.isPending} onClick={() => requeue.mutate()}>
								{t.processing.requeue}
							</button>
						</div>
					)}
					{requeue.data && <p className="text-xs text-muted">{t.processing.requeued(requeue.data.requeued)}</p>}
					{requeue.error && <p className="text-xs text-danger">{errorText(requeue.error)}</p>}
					{cancel.data && <p className="text-xs text-muted">{t.processing.stopped(cancel.data.cancelled)}</p>}
					{cancel.error && <p className="text-xs text-danger">{errorText(cancel.error)}</p>}

					<JobList
						title={t.processing.running}
						jobs={data.running}
						detail={(j) => {
							const elapsed = j.started_at ? serverNow - j.started_at : 0;
							const parts = [t.processing.elapsed(duration(elapsed))];
							if (j.attempts > 1) parts.push(t.processing.attempt(j.attempts));
							if (elapsed > data.staleAfterMs) parts.push(t.processing.maybeStuck);
							return parts.join(" · ");
						}}
						action={(j) => (j.started_at !== null && serverNow - j.started_at > data.staleAfterMs ? stopButton(j) : null)}
					/>
					<JobList
						title={t.processing.queued}
						jobs={data.pending}
						more={c!.pending - data.pending.length}
						detail={(j) => (j.attempts > 0 ? t.processing.waitingRetry(j.attempts, j.last_error) : t.processing.waiting)}
						action={stopButton}
					/>
				</div>
			)}
		</section>
	);
}

function JobList({
	title,
	jobs,
	more = 0,
	detail,
	action,
}: {
	title: string;
	jobs: ActiveJob[];
	more?: number;
	detail: (j: ActiveJob) => string;
	action?: (j: ActiveJob) => ReactNode;
}) {
	if (!jobs.length) return null;
	return (
		<div>
			<div className="mb-1 text-xs font-semibold text-muted">{title}</div>
			<ul className="divide-y divide-border">
				{jobs.map((j) => (
					<li key={j.id} className="flex items-center gap-3 py-2">
						<JobThumb job={j} />
						<div className="min-w-0 flex-1">
							<div className="truncate">{j.names.length ? j.names.join(" · ") : <span className="font-mono text-xs">{j.asset_id}</span>}</div>
							<div className="truncate text-xs text-muted">
								{KIND_LABEL[j.kind] ?? j.kind} · {formatBytes(j.size)} · {detail(j)}
							</div>
						</div>
						{action?.(j)}
					</li>
				))}
			</ul>
			{more > 0 && <p className="pt-1 text-xs text-muted">{t.processing.more(more)}</p>}
		</div>
	);
}

/** 已经处理过的（比如旋转）有缩略图；新上传的还没有，显示类型图标。 */
export function JobThumb({ job }: { job: Pick<ActiveJob, "asset_id" | "asset_status" | "asset_kind" | "derived_rev" | "kind"> }) {
	const [failed, setFailed] = useState(false);
	const hasThumb = job.asset_status === "ready" && !failed;
	return (
		<div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md bg-surface text-muted">
			{hasThumb ? (
				<img src={thumbUrl(job.asset_id, job.derived_rev)} alt="" className="h-full w-full object-cover" onError={() => setFailed(true)} />
			) : job.kind === "rotate" ? (
				<IconRotate size={18} />
			) : job.kind === "compose" ? (
				<IconStitch size={18} />
			) : job.asset_kind === "video" ? (
				<IconPlay size={16} />
			) : (
				<IconFile size={18} />
			)}
		</div>
	);
}
