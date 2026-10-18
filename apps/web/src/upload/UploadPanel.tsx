import { useEffect, useMemo, useRef, useState } from "react";
import { useGuard } from "../guard";
import { duration } from "../routes/settings/shared";
import { formatBytes } from "../timeline/format";
import { IconCheck, IconChevronLeft, IconClose, IconFile, IconFolder, IconLive, IconPlay } from "../ui/icons";
import { type Item, uploader } from "./uploader";
import { estimateUpload } from "./estimate";
import { activeCount, useUploads } from "./UploadStatus";
import { t } from "../i18n";

/**
 * 右下角的上传面板（类似 Google Photos）：挂在外壳上，换页面也不消失。
 *  - 列表里有条目时出现；上传中只能收起，全部结束后才能关闭（关闭即清空列表）。
 *  - 列表按固定行高虚拟化，几万个条目时也只渲染可见的十几行。
 *  - 不显示本地文件的缩略图：<img> 读文件不受 read.ts 的限流和卡住检测管，NAS 断开时每一行都会再卡住一个浏览器线程。
 */

const ROW_H = 56;
/** iPhone / iPad（iPadOS 的 Safari 自称 Mac，靠触点数区分）：网页选照片时系统只给静态图 */
const IOS = /iPhone|iPad/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const OVERSCAN = 4;

/** 进行中的排最前，然后是失败、排队、已完成。 */
const RANK: Record<Item["status"], number> = { uploading: 0, hashing: 0, failed: 1, queued: 2, done: 3, duplicate: 3 };

export function UploadPanel() {
	const snap = useUploads();
	const active = activeCount(snap);
	const [open, setOpen] = useState(true);
	const count = snap.items.length;

	// 加入新文件时自动展开
	const lastCount = useRef(count);
	useEffect(() => {
		if (count > lastCount.current) setOpen(true);
		lastCount.current = count;
	}, [count]);

	const rows = useMemo(() => {
		const buckets: Item[][] = [[], [], [], []];
		for (const it of snap.items) buckets[RANK[it.status]]!.push(it);
		return buckets.flat();
	}, [snap]);

	if (!count) return null;

	const { counts } = snap;
	const finished = counts.done + counts.duplicate;
	const pct = snap.totalBytes ? Math.floor((snap.sentBytes / snap.totalBytes) * 100) : 0;
	const title = snap.stoppedReason
		? t.upload.paused
		: active
			? t.upload.uploading(active)
			: counts.failed
				? t.upload.failedCount(counts.failed)
				: t.upload.uploadedCount(finished);

	return (
		<section
			aria-label={t.upload.panel}
			className="pop-in fixed inset-x-2 bottom-[calc(var(--tabbar-h)+0.5rem)] z-40 overflow-hidden rounded-2xl border border-border bg-card shadow-[0_8px_32px_rgb(0_0_0/0.18)] sm:left-auto sm:right-4 sm:w-[380px] md:bottom-4"
		>
			<header className="flex items-center gap-1 py-1.5 pl-4 pr-1.5">
				<div className="min-w-0 flex-1">
					<h2 className="truncate text-sm font-semibold">{title}</h2>
					<p className="truncate text-xs tabular-nums text-muted">
						{finished} / {count} · {formatBytes(snap.sentBytes)} / {formatBytes(snap.totalBytes)}
						{active > 0 && ` · ${pct}%`}
					</p>
				</div>
				<button className="icon-btn h-9 w-9" aria-label={open ? t.upload.collapse : t.upload.expand} aria-expanded={open} onClick={() => setOpen(!open)}>
					<IconChevronLeft size={18} className={`transition-transform ${open ? "-rotate-90" : "rotate-90"}`} />
				</button>
				{active === 0 && (
					<button className="icon-btn h-9 w-9" aria-label={t.upload.clear} onClick={() => uploader.clear()}>
						<IconClose size={18} />
					</button>
				)}
			</header>
			{active > 0 && (
				<div className="h-0.5 bg-surface">
					<div className="h-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
				</div>
			)}

			{open && (
				<>
					<VirtualList rows={rows} />
					<footer className="space-y-2 border-t border-border px-4 py-2.5 text-xs text-muted">
						{snap.stoppedReason && <p className="text-danger">{snap.stoppedReason}</p>}
						<p>
							{[
								counts.duplicate > 0 && t.upload.skippedDuplicates(counts.duplicate),
								snap.skipped.length > 0 && t.upload.ignoredUnsupported(snap.skipped.length),
								active > 0 && t.upload.closingInterrupts,
							]
								.filter(Boolean)
								.join(" · ") || t.upload.appearsInTimeline}
						</p>
						{active > 0 && <CostEstimate items={snap.items} />}
						{IOS && <p>{t.upload.iosHint}</p>}
						{(active > 0 || counts.failed > 0) && (
							<div className="flex justify-end gap-2">
								{active > 0 && (
									<button className="btn h-8 px-3 text-xs" onClick={() => uploader.cancel()}>
										{t.upload.stopRest}
									</button>
								)}
								{snap.stoppedReason ? (
									<button className="btn h-8 px-3 text-xs" onClick={() => uploader.retryFailed()}>
										{t.upload.resume}
									</button>
								) : (
									counts.failed > 0 &&
									active === 0 && (
									<button className="btn h-8 px-3 text-xs" onClick={() => uploader.retryFailed()}>
										{t.upload.retryFailed}
										</button>
									)
								)}
							</div>
						)}
					</footer>
				</>
			)}
		</section>
	);
}

/**
 * 这一批的容器费用估算（upload/estimate.ts），只是提醒。用成本防护的状态（GET /api/guard，打开面板时读一次，不轮询）。
 * 设备端接管时不用容器，只说明一下。
 */
function CostEstimate({ items }: { items: Item[] }) {
	const guard = useGuard();
	const g = guard.data;
	const batch = useMemo(
		() => items.filter((it) => it.status !== "duplicate" && it.status !== "failed").map((it) => ({ kind: it.group.kind, bytes: it.bytes })),
		[items],
	);
	if (!g) return null;
	if (g.device) return <p>{t.upload.estimateOnDevice(g.device.name)}</p>;
	const e = estimateUpload({ items: batch, month: g.month, monthCostUsd: g.monthCostUsd, budgetUsd: g.budgetUsd });
	const usd = (n: number) => (n > 0 && n < 0.01 ? "< $0.01" : `$${n.toFixed(2)}`);
	return (
		<>
			<p>
				{t.upload.estimate(
					duration(e.seconds * 1000),
					usd(e.costUsd),
					e.perJobSeconds === null ? null : t.upload.estimateBasis(e.perJobSeconds.toFixed(1)),
				)}
			</p>
			{e.overBudget && <p className="text-danger">{t.upload.estimateOverBudget(usd(g.budgetUsd))}</p>}
			{e.suggestDevice && <p>{t.upload.estimateDevice}</p>}
		</>
	);
}

function VirtualList({ rows }: { rows: Item[] }) {
	const [scrollTop, setScrollTop] = useState(0);
	const viewH = Math.min(rows.length, 6) * ROW_H;
	const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
	const end = Math.min(rows.length, Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN);

	return (
		<div className="max-h-[min(336px,40dvh)] overflow-y-auto overscroll-contain" style={{ height: viewH }} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
			<ul className="relative" style={{ height: rows.length * ROW_H }}>
				{rows.slice(start, end).map((it, i) => (
					<Row key={it.id} item={it} top={(start + i) * ROW_H} />
				))}
			</ul>
		</div>
	);
}

function Row({ item, top }: { item: Item; top: number }) {
	const rowPct = item.bytes ? Math.floor((item.sent / item.bytes) * 100) : 0;
	const status =
		item.status === "queued"
			? t.upload.queued
			: item.status === "hashing"
				? t.upload.hashing
				: item.status === "uploading"
					? `${formatBytes(item.sent)} / ${formatBytes(item.bytes)}`
					: item.status === "duplicate"
						? t.upload.exists
						: item.status === "failed"
							? (item.error ?? t.upload.failed)
							: formatBytes(item.bytes);

	return (
		<li className="absolute inset-x-0 flex items-center gap-3 px-4" style={{ top, height: ROW_H }}>
			<Thumb item={item} />
			<div className="min-w-0 flex-1">
				<p className="flex items-center gap-1.5 text-sm">
					<span className="truncate">{item.label}</span>
					{item.group.kind === "live" && <IconLive size={14} className="shrink-0 text-muted" />}
					{item.group.files.length > 1 && item.group.kind !== "live" && <span className="shrink-0 text-xs text-muted">+RAW</span>}
				</p>
				<p className={`flex items-center gap-1 truncate text-xs ${item.status === "failed" ? "text-danger" : "text-muted"}`}>
					<IconFolder size={12} className="shrink-0" />
					<span className="max-w-[45%] truncate">{item.folder || t.upload.noFolder}</span>
					<span aria-hidden>·</span>
					<span className="truncate tabular-nums">{status}</span>
				</p>
			</div>
			<StatusMark status={item.status} pct={rowPct} />
		</li>
	);
}

function StatusMark({ status, pct }: { status: Item["status"]; pct: number }) {
	if (status === "done") return <IconCheck size={20} className="shrink-0 text-ok" />;
	if (status === "duplicate") return <IconCheck size={20} className="shrink-0 text-muted" />;
	if (status === "failed") return <IconClose size={20} className="shrink-0 text-danger" />;
	if (status === "queued") return <span className="w-5 shrink-0" />;
	// 计算校验和时没有字节进度，画一段转动的弧
	const size = 22;
	const r = size / 2 - 2;
	const c = 2 * Math.PI * r;
	const spinning = status === "hashing";
	return (
		<svg width={size} height={size} className={`shrink-0 -rotate-90 ${spinning ? "animate-spin" : ""}`} aria-label={spinning ? t.upload.hashing : `${pct}%`}>
			<circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={2.5} className="stroke-border" />
			<circle
				cx={size / 2}
				cy={size / 2}
				r={r}
				fill="none"
				strokeWidth={2.5}
				strokeLinecap="round"
				strokeDasharray={c}
				strokeDashoffset={c * (1 - (spinning ? 25 : pct) / 100)}
				className="stroke-accent transition-[stroke-dashoffset]"
			/>
		</svg>
	);
}

function Thumb({ item }: { item: Item }) {
	return (
		<div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-surface text-muted">
			{item.group.kind === "video" ? <IconPlay size={16} /> : <IconFile size={18} />}
		</div>
	);
}
