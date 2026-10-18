import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { invalidateLibrary } from "../library/actions";
import { armLibrarySync, useLibrarySync } from "../library/sync";
import { type Snapshot, uploader } from "./uploader";

/** 上传队列是模块级单例，不随页面卸载；所有页面都从这里读进度。 */
export const useUploads = () => useSyncExternalStore(uploader.subscribe, uploader.getSnapshot);

export const activeCount = (s: Snapshot) => s.counts.queued + s.counts.hashing + s.counts.uploading;

/**
 * 挂在外壳上，和当前是哪个页面无关：
 *  - 上传中关闭或刷新标签页要确认（站内切换页面不影响上传）。
 *  - 一批上传结束后马上刷新时间线和资料库。
 *  - 资料库同步（library/sync.ts）也挂在这里：每传完一项就重新触发，上传和后台处理期间列表自己更新，不用刷新页面。
 */
export function UploadWatcher() {
	const snap = useUploads();
	const active = activeCount(snap);
	const qc = useQueryClient();
	const lastDone = useRef(0);
	useLibrarySync();

	useEffect(() => {
		if (snap.counts.done > 0) armLibrarySync();
	}, [snap.counts.done]);

	useEffect(() => {
		// 列表被清空后计数从 0 重新开始
		if (snap.counts.done < lastDone.current) lastDone.current = snap.counts.done;
		if (active === 0 && snap.counts.done > lastDone.current) {
			lastDone.current = snap.counts.done;
			invalidateLibrary(qc);
		}
	}, [active, snap.counts.done, qc]);

	useEffect(() => {
		if (!active) return;
		const onLeave = (e: BeforeUnloadEvent) => e.preventDefault();
		window.addEventListener("beforeunload", onLeave);
		return () => window.removeEventListener("beforeunload", onLeave);
	}, [active]);

	return null;
}

/** 顶栏上传按钮里的进度：上传中显示百分比，否则为空。 */
export function useUploadProgress(): number | null {
	const snap = useUploads();
	if (!activeCount(snap)) return null;
	return snap.totalBytes ? Math.floor((snap.sentBytes / snap.totalBytes) * 100) : 0;
}

/** 围着图标的一圈进度环。 */
export function ProgressRing({ pct, size = 40 }: { pct: number; size?: number }) {
	const r = size / 2 - 2;
	const c = 2 * Math.PI * r;
	return (
		<svg width={size} height={size} className="pointer-events-none absolute inset-0 m-auto -rotate-90" aria-hidden>
			<circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={2.5} className="stroke-border" />
			<circle
				cx={size / 2}
				cy={size / 2}
				r={r}
				fill="none"
				strokeWidth={2.5}
				strokeLinecap="round"
				strokeDasharray={c}
				strokeDashoffset={c * (1 - pct / 100)}
				className="stroke-accent transition-[stroke-dashoffset]"
			/>
		</svg>
	);
}
