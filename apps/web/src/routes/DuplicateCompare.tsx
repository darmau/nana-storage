import { useQueries } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { locale, t } from "../i18n";
import { api } from "../api";
import { formatBytes } from "../timeline/format";
import { previewUrl, thumbUrl, type TimelineItem } from "../timeline/types";
import { IconChevronLeft, IconChevronRight, IconClose } from "../ui/icons";
import { useThemeColor } from "../ui/themeColor";
import type { AssetDetail } from "../viewer/types";

/** 对比界面底部的操作按钮 */
export const comparePill =
	"inline-flex h-9 items-center gap-1.5 rounded-full bg-white/10 px-3.5 text-sm font-medium text-white hover:bg-white/20 disabled:opacity-40";

/**
 * 重复 / 相似照片对比：一组里的几张叠在同一个位置，←/→（或数字键、左右滑动）瞬间切换，差别一眼就能看出来。
 * 点一下放大到点击的位置（鼠标移动时跟着平移），切换照片时保持放大位置，方便比较细节。
 * 当前照片前后各 PRELOAD 张的预览一直挂着，切换时不用重新加载。底部的操作按钮由页面传进来（actions）。
 */
const PRELOAD = 2;
/** 信息最多取这么多张（每张一次 /api/assets/:id，和查看器共用缓存） */
const DETAIL_MAX = 24;
const ZOOM = 3;

export type DuplicateGroup = { keep: string; items: TimelineItem[] };

const formatSeconds = (takenAt: number | null, tz: number | null) => {
	if (!takenAt) return null;
	const d = new Date(tz === null ? takenAt : takenAt + tz * 60_000);
	const opts: Intl.DateTimeFormatOptions = {
		dateStyle: "medium",
		timeStyle: "medium",
		...(tz === null ? {} : { timeZone: "UTC" }),
	};
	const ms = takenAt % 1000;
	return d.toLocaleString(locale, opts) + (ms ? `.${String(ms).padStart(3, "0")}` : "");
};

const mimeLabel = (mime: string) =>
	mime
		.replace(/^(image|video)\//, "")
		.replace("quicktime", "mov")
		.toUpperCase();

export function DuplicateCompare({
	group,
	current,
	groupIndex,
	groupCount,
	label,
	onSelect,
	onGroup,
	onClose,
	actions,
}: {
	group: DuplicateGroup;
	current: string;
	groupIndex: number;
	groupCount: number;
	label: string;
	onSelect: (id: string) => void;
	onGroup: (delta: 1 | -1) => void;
	onClose: () => void;
	/** 当前这张照片的操作按钮（用 comparePill） */
	actions: (id: string) => React.ReactNode;
}) {
	useThemeColor("#000000");
	const items = group.items;
	const n = items.length;
	const index = Math.max(
		0,
		items.findIndex((it) => it[0] === current),
	);
	const it = items[index]!;
	const step = (d: number) => onSelect(items[(index + d + n) % n]![0]);

	const details = useQueries({
		queries: items.slice(0, DETAIL_MAX).map((x) => ({
			queryKey: ["asset", x[0]],
			queryFn: () => api<AssetDetail>(`/assets/${x[0]}`),
			staleTime: 60_000,
		})),
	});
	const detailOf = (id: string) => details[items.findIndex((x) => x[0] === id)]?.data;
	const info = (a: AssetDetail | undefined) => {
		const original = a?.files.find((f) => f.role === "original");
		return {
			size: original ? formatBytes(original.size) : null,
			type: original ? mimeLabel(original.mime) : null,
			raw: !!a?.files.some((f) => f.role === "raw"),
			name: original?.original_name ?? null,
		};
	};
	const cur = detailOf(it[0]);
	const curInfo = info(cur);

	// ---------------------------------------------------------------- 放大
	const [zoom, setZoom] = useState<{ x: number; y: number } | null>(null);
	const stage = useRef<HTMLDivElement>(null);
	const pointAt = (e: { clientX: number; clientY: number }) => {
		const r = stage.current!.getBoundingClientRect();
		return {
			x: ((e.clientX - r.left) / r.width) * 100,
			y: ((e.clientY - r.top) / r.height) * 100,
		};
	};
	useEffect(() => setZoom(null), [group.keep]);

	// 轻点：放大 / 还原；左右滑：切换（只在没放大时）
	const down = useRef<{ x: number; y: number; t: number } | null>(null);
	const onPointerDown = (e: React.PointerEvent) => {
		down.current = { x: e.clientX, y: e.clientY, t: e.timeStamp };
	};
	const onPointerUp = (e: React.PointerEvent) => {
		const d = down.current;
		down.current = null;
		if (!d) return;
		const dx = e.clientX - d.x;
		const dy = e.clientY - d.y;
		if (!zoom && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) step(dx < 0 ? 1 : -1);
		else if (Math.abs(dx) < 8 && Math.abs(dy) < 8) setZoom(zoom ? null : pointAt(e));
	};

	// ---------------------------------------------------------------- 键盘、滚动
	const root = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		const prev = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		return () => {
			document.body.style.overflow = prev;
		};
	}, []);
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			// 上面还有确认框时不响应
			const dialogs = document.querySelectorAll('[aria-modal="true"]');
			if (dialogs[dialogs.length - 1] !== root.current) return;
			if (e.metaKey || e.ctrlKey || e.altKey) return;
			if (e.key === "Escape") {
				if (zoom) setZoom(null);
				else onClose();
			} else if (e.key === "ArrowLeft") step(-1);
			else if (e.key === "ArrowRight") step(1);
			else if (e.key === "ArrowUp" && groupIndex > 0) onGroup(-1);
			else if (e.key === "ArrowDown" && groupIndex < groupCount - 1) onGroup(1);
			else if (/^[1-9]$/.test(e.key) && Number(e.key) <= n) onSelect(items[Number(e.key) - 1]![0]);
			else return;
			e.preventDefault();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	});

	// 当前缩略图滚到可见范围内
	const strip = useRef<HTMLDivElement>(null);
	useEffect(() => {
		strip.current?.querySelector("[data-current]")?.scrollIntoView({ block: "nearest", inline: "nearest" });
	}, [index]);

	// 预览还没下载完的那张先垫放大的缩略图（列表里已经加载过，直接命中缓存），不露出黑屏
	const [loaded, setLoaded] = useState<ReadonlySet<string>>(() => new Set());
	const markLoaded = (id: string) => setLoaded((s) => (s.has(id) ? s : new Set(s).add(id)));

	const near = (i: number) => {
		const d = Math.abs(i - index);
		return Math.min(d, n - d) <= PRELOAD;
	};

	return (
		<div
			ref={root}
			className="theme-dark fixed inset-0 z-50 flex select-none flex-col bg-black text-fg"
			role="dialog"
			aria-modal="true"
			aria-label={label}
		>
			<div className="flex items-center gap-1 pl-[max(0.5rem,var(--safe-left))] pr-[max(0.5rem,var(--safe-right))] pt-[max(0.5rem,var(--safe-top))]">
				<button type="button" className="icon-btn hover:!bg-white/15" aria-label={t.common.close} title={t.compare.closeTitle} onClick={onClose}>
					<IconClose size={24} />
				</button>
				<span className="ml-1 text-sm tabular-nums text-muted">
					{t.compare.position(index + 1, n, groupIndex + 1, groupCount)}
				</span>
				<div className="ml-auto flex items-center">
					<button
						type="button"
						className="icon-btn hover:!bg-white/15 disabled:opacity-30"
						aria-label={t.compare.prevGroup}
						title={t.compare.prevGroupTitle}
						disabled={groupIndex <= 0}
						onClick={() => onGroup(-1)}
					>
						<IconChevronLeft size={22} />
					</button>
					<span className="text-xs text-muted">{t.compare.group}</span>
					<button
						type="button"
						className="icon-btn hover:!bg-white/15 disabled:opacity-30"
						aria-label={t.compare.nextGroup}
						title={t.compare.nextGroupTitle}
						disabled={groupIndex >= groupCount - 1}
						onClick={() => onGroup(1)}
					>
						<IconChevronRight size={22} />
					</button>
				</div>
			</div>

			<div
				ref={stage}
				className={`relative min-h-0 flex-1 touch-none overflow-hidden ${zoom ? "cursor-zoom-out" : "cursor-zoom-in"}`}
				onPointerDown={onPointerDown}
				onPointerUp={onPointerUp}
				onPointerMove={(e) => zoom && e.pointerType === "mouse" && setZoom(pointAt(e))}
			>
				{!loaded.has(it[0]) && (
					<img
						key={`thumb-${it[0]}`}
						src={thumbUrl(it[0], it[7])}
						alt=""
						draggable={false}
						className="absolute inset-0 h-full w-full object-contain blur-sm"
						style={{
							transform: zoom ? `scale(${ZOOM})` : undefined,
							transformOrigin: zoom ? `${zoom.x}% ${zoom.y}%` : undefined,
						}}
					/>
				)}
				{items.map((x, i) =>
					near(i) ? (
						<img
							key={x[0]}
							src={previewUrl(x[0], x[7])}
							alt=""
							draggable={false}
							onLoad={() => markLoaded(x[0])}
							className="absolute inset-0 h-full w-full object-contain"
							style={{
								visibility: i === index ? "visible" : "hidden",
								transform: zoom ? `scale(${ZOOM})` : undefined,
								transformOrigin: zoom ? `${zoom.x}% ${zoom.y}%` : undefined,
							}}
						/>
					) : null,
				)}
				<button
					type="button"
					className="absolute left-2 top-1/2 hidden h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full bg-black/40 text-white hover:bg-black/60 sm:flex"
					aria-label={t.viewer.prev}
					title={t.slideshow.prevTitle}
					onPointerDown={(e) => e.stopPropagation()}
					onPointerUp={(e) => e.stopPropagation()}
					onClick={() => step(-1)}
				>
					<IconChevronLeft size={26} />
				</button>
				<button
					type="button"
					className="absolute right-2 top-1/2 hidden h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full bg-black/40 text-white hover:bg-black/60 sm:flex"
					aria-label={t.viewer.next}
					title={t.slideshow.nextTitle}
					onPointerDown={(e) => e.stopPropagation()}
					onPointerUp={(e) => e.stopPropagation()}
					onClick={() => step(1)}
				>
					<IconChevronRight size={26} />
				</button>
			</div>

			<div className="space-y-3 px-[max(0.75rem,var(--safe-left))] pb-[max(0.75rem,var(--safe-bottom))] pt-3">
				<div className="text-center text-sm">
					<div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
						{it[0] === group.keep && (
							<span className="rounded-full bg-accent px-2 py-0.5 text-xs font-medium text-accent-fg">{t.compare.recommended}</span>
						)}
						<span className="tabular-nums">
							{it[1]} × {it[2]}
						</span>
						{curInfo.size && <span className="tabular-nums">{curInfo.size}</span>}
						{curInfo.type && (
							<span>
								{curInfo.type}
								{curInfo.raw ? " + RAW" : ""}
							</span>
						)}
						{cur?.favorite ? <span>{t.compare.favorited}</span> : null}
					</div>
					<div className="mt-1 truncate text-xs text-muted">
						{[formatSeconds(cur?.taken_at ?? null, cur?.tz_offset_min ?? null) ?? (cur ? t.date.unknown : null), cur?.camera, curInfo.name]
							.filter(Boolean)
							.join(" · ") || " "}
					</div>
				</div>

				<div ref={strip} className="overflow-x-auto pb-1">
					<div className="mx-auto flex w-max gap-2 px-1 pt-1">
						{items.map((x, i) => {
							const xi = info(detailOf(x[0]));
							return (
								<button
									key={x[0]}
									type="button"
									onClick={() => onSelect(x[0])}
									aria-label={t.compare.thumb(i + 1, x[0] === group.keep)}
									aria-current={i === index}
									data-current={i === index || undefined}
									className={`relative shrink-0 overflow-hidden rounded-lg ring-2 transition ${i === index ? "ring-white" : "opacity-60 ring-transparent hover:opacity-100"}`}
								>
									<img src={thumbUrl(x[0], x[7])} alt="" className="h-14 w-14 object-cover sm:h-16 sm:w-16" />
									<span className="absolute left-1 top-1 rounded bg-black/60 px-1 text-[10px] font-semibold tabular-nums text-white">
										{i + 1}
										{x[0] === group.keep ? ` ${t.duplicates.keep}` : ""}
									</span>
									{xi.size && (
										<span className="absolute inset-x-0 bottom-0 bg-black/60 text-[10px] tabular-nums text-white">{xi.size}</span>
									)}
								</button>
							);
						})}
					</div>
				</div>

				<div className="flex flex-wrap justify-center gap-2">{actions(it[0])}</div>
				<p className="hidden text-center text-xs text-muted sm:block">{t.compare.shortcuts}</p>
			</div>
		</div>
	);
}
