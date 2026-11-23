import { MAX_LIVE_DURATION_MS } from "@nana/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { api, errorText } from "../api";
import { t } from "../i18n";
import { convertToLivePhoto } from "../library/actions";
import { formatDuration } from "../timeline/format";
import { IconChevronLeft } from "../ui/icons";
import type { AssetDetail } from "../viewer/types";

/**
 * 短视频转 Live Photo 的编辑页（/live/$assetId）：中间是视频（拖到哪一帧就显示哪一帧），
 * 底部是预览时间轴（一排缩略图 + 可拖动的进度条），拖动选择一个视频帧作为封面。
 * 确定后提交 POST /api/live-photo，后台把它变成 Live Photo（封面 + 动态视频），然后回到时间线。
 * 缩略图在本机用 <video> + canvas 抽帧生成，不经过服务端、没有容器费用；只有提交才建任务。
 */

/** 时间轴上一排生成几帧缩略图（按视频时长，4–12 帧，约每秒一帧）。 */
const filmstripFrames = (durationMs: number) => Math.min(12, Math.max(4, Math.round(durationMs / 1000)));

export function LivePhotoPage() {
	const { assetId } = useParams({ from: "/live/$assetId" });
	const navigate = useNavigate();
	const qc = useQueryClient();
	const detail = useQuery({ queryKey: ["asset", assetId], queryFn: () => api<AssetDetail>(`/assets/${assetId}`) });
	const a = detail.data;

	const durationMs = a?.duration_ms ?? 0;
	const [atMs, setAtMs] = useState(0);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const videoRef = useRef<HTMLVideoElement>(null);
	const thumbRef = useRef<HTMLVideoElement>(null);
	const [thumbs, setThumbs] = useState<{ t: number; url: string }[]>([]);

	// 优先用 H.264 预览（所有浏览器都能解码、抽帧）；没有就用原件。
	const src = a
		? a.files.find((f) => f.role === "video_preview")
			? `/api/a/${a.id}/video_preview?v=${a.derived_rev}`
			: `/api/a/${a.id}/original`
		: undefined;

	// 用屏幕外的第二个 <video> 抽一帧生成时间轴缩略图
	useEffect(() => {
		const v = thumbRef.current;
		if (!v || !src) return;
		let cancelled = false;
		const gen = async () => {
			const dur = v.duration;
			if (!Number.isFinite(dur) || dur <= 0) return;
			const n = filmstripFrames(dur * 1000);
			const canvas = document.createElement("canvas");
			canvas.width = 112;
			canvas.height = 70;
			const ctx = canvas.getContext("2d");
			if (!ctx) return;
			const out: { t: number; url: string }[] = [];
			for (let i = 0; i < n; i++) {
				if (cancelled) return;
				const t = (dur * (i + 0.5)) / n;
				v.currentTime = t;
				await new Promise<void>((res) => {
					const done = () => res();
					v.addEventListener("seeked", done, { once: true });
					v.addEventListener("error", done, { once: true });
				});
				if (cancelled) return;
				try {
					ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
					out.push({ t: t * 1000, url: canvas.toDataURL("image/jpeg", 0.6) });
				} catch {
					// 这一帧解码失败就跳过，时间轴仍然能用（进度条）
				}
			}
			setThumbs(out);
		};
		if (v.readyState >= 1) void gen();
		else v.addEventListener("loadedmetadata", gen);
		return () => {
			cancelled = true;
			v.removeEventListener("loadedmetadata", gen);
		};
	}, [src]);

	const scrub = (ms: number) => {
		const clamped = Math.min(durationMs, Math.max(0, ms));
		setAtMs(clamped);
		const v = videoRef.current;
		if (v && Math.abs(v.currentTime - clamped / 1000) > 0.05) v.currentTime = clamped / 1000;
	};

	const confirm = async () => {
		if (!a || saving) return;
		setSaving(true);
		setError(null);
		try {
			// 帧的时间严格小于视频时长（最后一毫秒可能抽不到帧）
			const t = Math.min(Math.max(0, Math.round(atMs)), Math.max(0, durationMs - 1));
			await convertToLivePhoto(qc, a.id, t);
			navigate({ to: "/" });
		} catch (e) {
			setError(errorText(e));
			setSaving(false);
		}
	};

	const button = "flex h-10 items-center gap-1.5 rounded-full px-4 text-sm font-semibold transition hover:bg-white/15 disabled:opacity-50";
	const ineligible = a && (a.kind !== "video" || (a.duration_ms ?? 0) > MAX_LIVE_DURATION_MS);

	return (
		<div role="dialog" aria-modal="true" aria-label={t.livePhoto.title} className="theme-dark fixed inset-0 z-[60] flex flex-col bg-bg text-fg fade-in">
			<div className="flex shrink-0 items-center justify-between gap-2 pl-[max(0.5rem,var(--safe-left))] pr-[max(0.5rem,var(--safe-right))] pt-[max(0.5rem,var(--safe-top))] pb-2">
				<button type="button" className={button} onClick={() => navigate({ to: "/" })}>
					<IconChevronLeft size={20} />
					<span>{t.common.cancel}</span>
				</button>
				<h1 className="truncate text-[15px] font-semibold">{t.livePhoto.title}</h1>
				<button
					type="button"
					className={`${button} bg-accent text-accent-fg hover:bg-accent hover:opacity-90`}
					disabled={saving || !a || ineligible}
					onClick={confirm}
				>
					{t.livePhoto.confirm}
				</button>
			</div>

			<div className="relative min-h-0 flex-1">
				{!a ? (
					<p className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-muted">{t.viewer.videoUnsupported}</p>
				) : ineligible ? (
					<p className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-muted">
						{a.kind !== "video" ? t.livePhoto.notReady : t.livePhoto.tooLong(MAX_LIVE_DURATION_MS / 1000)}
					</p>
				) : (
					<video
						ref={videoRef}
						src={src}
						controls
						playsInline
						preload="auto"
						onTimeUpdate={(e) => setAtMs(e.currentTarget.currentTime * 1000)}
						onError={() => setError(t.livePhoto.loadFailed)}
						className="absolute inset-0 m-auto max-h-full max-w-full"
					/>
				)}
				{/* 屏幕外的抽帧源：只用来生成时间轴缩略图 */}
				<video ref={thumbRef} src={src} muted playsInline preload="auto" className="pointer-events-none absolute h-px w-px opacity-0" />
			</div>

			<div className="shrink-0 px-[max(1rem,var(--safe-left))] pb-[max(1rem,var(--safe-bottom))] pt-3">
				{thumbs.length > 0 && (
					<div className="mb-3 flex gap-1 overflow-x-auto pb-1">
						{thumbs.map((th) => (
							<button
								key={th.t}
								type="button"
								aria-label={formatDuration(th.t)}
								onClick={() => scrub(th.t)}
								className={`relative h-[70px] w-[112px] shrink-0 overflow-hidden rounded-md ring-2 transition ${
									Math.abs(atMs - th.t) <= durationMs / filmstripFrames(durationMs) / 2 ? "ring-accent" : "ring-transparent opacity-70 hover:opacity-100"
								}`}
							>
								<img src={th.url} alt="" className="h-full w-full object-cover" />
							</button>
						))}
					</div>
				)}
				<input
					type="range"
					min={0}
					max={Math.max(1, durationMs)}
					step={1}
					value={Math.min(atMs, durationMs)}
					onChange={(e) => scrub(Number(e.currentTarget.value))}
					disabled={!a || ineligible}
					aria-label={t.livePhoto.hint}
					className="w-full accent-[var(--accent)]"
				/>
				<div className="mt-2 flex items-center justify-between text-xs tabular-nums text-muted">
					<span>{formatDuration(atMs)}</span>
					<span className="truncate px-2">{t.livePhoto.hint}</span>
					<span>{formatDuration(durationMs)}</span>
				</div>
				{error && (
					<p role="status" className="mt-2 text-center text-xs text-danger">
						{error}
					</p>
				)}
			</div>
		</div>
	);
}
