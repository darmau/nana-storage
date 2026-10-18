import { useNavigate } from "@tanstack/react-router";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { t } from "../i18n";
import { formatBytes, formatDateTime, formatDuration, formatTakenShort } from "../timeline/format";
import { KIND_LIVE, KIND_VIDEO, type Bucket, type TimelineItem, thumbUrl } from "../timeline/types";
import { openContextMenu } from "../ui/ContextMenu";
import { IconCheck, IconHeart, IconLive, IconPlay } from "../ui/icons";
import { monthsOf } from "./AssetGrid";
import { renderWindow } from "./GridWindow";
import { ListScrubber } from "./ListScrubber";
import type { ItemDetail } from "./queries";
import { useScrollRoot } from "./scrollRoot";
import { useScrubbing } from "./scrub";
import { useAssetMenu } from "./SelectionBar";
import { sliceBetween, useSelection } from "./selection";

/** 每行固定高度：不用布局，位置就是下标 × 行高，没加载的部分也能算准总高度。 */
const ROW_H = 56;
const SCRUBBER_MIN_ITEMS = 100;
/**
 * 缩略图 | 名称 | 规格（像素）| 格式 | 拍摄时间 | 上传时间 | 尺寸（文件大小）。
 * 屏幕越窄隐藏的列越多（隐藏的格子不占位，每个断点的列数和显示的格子数一致）；最窄时只有名称，拍摄时间和大小写在名称下面。
 */
const COLS =
	"grid grid-cols-[40px_minmax(0,1fr)] items-center gap-3 sm:grid-cols-[40px_minmax(0,1fr)_10rem_5rem] md:grid-cols-[40px_minmax(0,1fr)_4rem_10rem_5rem] lg:grid-cols-[40px_minmax(0,1fr)_7rem_4rem_10rem_5rem] xl:grid-cols-[40px_minmax(0,1fr)_7rem_4rem_10rem_10rem_5rem]";
const CELL = "truncate text-sm tabular-nums text-muted";

/** 格式取文件名的扩展名（HEIC、JPG、MOV …） */
const formatOf = (name: string | null) => name?.match(/\.([0-9a-z]{1,5})$/i)?.[1]?.toUpperCase() ?? "";

/**
 * 文件夹的列表视图：一行一个条目（缩略图、文件名、规格、格式、拍摄时间、上传时间、大小）。
 * 和 AssetGrid 一样只渲染视口附近的行（renderWindow），快滚到底时加载下一页；拖动 / 快速滚动期间不渲染、不加载。
 * 选择、右键菜单、打开查看器的行为和网格的格子相同。
 */
export function AssetRows({
	items,
	details,
	months,
	hasMore,
	loadingMore,
	onLoadMore,
	onOpen,
	scrubber,
}: {
	items: TimelineItem[];
	details: (ItemDetail | undefined)[];
	months?: Bucket[];
	hasMore: boolean;
	loadingMore: boolean;
	onLoadMore: () => void;
	onOpen: (id: string) => void;
	scrubber: "dated" | "plain" | false;
}) {
	const ref = useRef<HTMLDivElement>(null);

	const { setRange } = useSelection();
	useEffect(() => {
		setRange((from, to, limit) =>
			sliceBetween(
				items.map((it) => it[0]),
				from.id,
				to.id,
				limit,
			),
		);
		return () => setRange(null);
	}, [items, setRange]);

	const root = useScrollRoot();
	const [view, setView] = useState({ lo: 0, hi: 0, height: 800 });
	useEffect(() => {
		let raf = 0;
		const update = () => {
			raf = 0;
			const el = ref.current;
			if (!el) return;
			const rootTop = root ? root.getBoundingClientRect().top : 0;
			const height = root ? root.clientHeight : window.innerHeight;
			const { lo, hi } = renderWindow(rootTop - el.getBoundingClientRect().top, height);
			setView((v) => (v.lo === lo && v.hi === hi && v.height === height ? v : { lo, hi, height }));
		};
		const onScroll = () => (raf ||= requestAnimationFrame(update));
		update();
		const target: HTMLElement | Window = root ?? window;
		target.addEventListener("scroll", onScroll, { passive: true });
		window.addEventListener("resize", onScroll);
		return () => {
			target.removeEventListener("scroll", onScroll);
			window.removeEventListener("resize", onScroll);
			cancelAnimationFrame(raf);
		};
	}, [root]);

	const loadedHeight = items.length * ROW_H;
	const scrubbing = useScrubbing();
	useEffect(() => {
		if (hasMore && !loadingMore && !scrubbing && view.hi + view.height > loadedHeight) onLoadMore();
	}, [hasMore, loadingMore, scrubbing, view, loadedHeight, onLoadMore]);

	const dated = scrubber === "dated";
	const index = useMemo(() => (dated ? (months ?? (hasMore ? null : monthsOf(items))) : []), [dated, months, hasMore, items]);
	const total = useMemo(() => (months ? months.reduce((n, m) => n + m.count, 0) : items.length), [months, items.length]);
	const showScrubber = !!scrubber && !root && index !== null && total >= SCRUBBER_MIN_ITEMS;
	const height = (hasMore && showScrubber ? Math.max(total, items.length) : items.length) * ROW_H;
	const starts = useMemo(() => {
		if (!showScrubber || !dated || !index) return [];
		let at = 0;
		return index.map((m) => {
			const y = at * ROW_H;
			at += m.count;
			return y;
		});
	}, [showScrubber, dated, index]);

	const i0 = Math.max(0, Math.floor(view.lo / ROW_H));
	const i1 = Math.min(items.length, Math.ceil(view.hi / ROW_H));

	return (
		<>
			<div className={`${COLS} hidden border-b border-border pb-2 text-xs font-medium text-muted sm:grid`} aria-hidden>
				<span />
				<span>{t.folders.colName}</span>
				<span className="hidden lg:block">{t.folders.colDims}</span>
				<span className="hidden md:block">{t.folders.colFormat}</span>
				<span>{t.folders.colTaken}</span>
				<span className="hidden xl:block">{t.folders.colUploaded}</span>
				<span className="pr-3 text-right">{t.folders.colSize}</span>
			</div>
			<div id="asset-grid" ref={ref} className={`relative ${scrubbing ? "scrub-placeholder-rows" : ""}`} style={{ height }}>
				{!scrubbing &&
					items.slice(i0, i1).map((it, k) => <Row key={it[0]} item={it} detail={details[i0 + k]} top={(i0 + k) * ROW_H} onOpen={onOpen} />)}
			</div>
			{showScrubber && index && <ListScrubber gridRef={ref} months={index} starts={starts} totalSize={height} dated={dated} />}
		</>
	);
}

const Row = memo(function Row({
	item,
	detail,
	top,
	onOpen,
}: {
	item: TimelineItem;
	detail: ItemDetail | undefined;
	top: number;
	onOpen: (id: string) => void;
}) {
	const [id, w, h, kind, , duration, favorite, rev] = item;
	const [name, size, takenAt, tz, uploadedAt] = detail ?? [null, 0, null, null, 0];
	const { selected, active, toggle, extend } = useSelection();
	const isSelected = selected.has(id);
	const menu = useAssetMenu();
	const [failed, setFailed] = useState(false);
	const taken = formatTakenShort(takenAt, tz);
	const bytes = size ? formatBytes(size) : "";

	// 触屏长按进入多选，和格子一样
	const press = useRef<{ timer: ReturnType<typeof setTimeout>; fired: boolean } | null>(null);
	const lastPointer = useRef("mouse");
	const onPointerDown = (e: React.PointerEvent) => {
		lastPointer.current = e.pointerType;
		if (e.pointerType !== "touch") return;
		const p = { fired: false, timer: setTimeout(() => ((p.fired = true), toggle(id), navigator.vibrate?.(10)), 450) };
		press.current = p;
	};
	const cancelPress = () => press.current && clearTimeout(press.current.timer);

	return (
		<div
			className={`group absolute inset-x-0 select-none rounded-lg [-webkit-touch-callout:none] ${isSelected ? "bg-accent-soft" : "hover:bg-surface"}`}
			style={{ top, height: ROW_H }}
			onMouseDown={(e) => e.shiftKey && e.preventDefault()}
			onContextMenu={(e) => {
				if (lastPointer.current === "touch") return e.preventDefault();
				openContextMenu(e, menu(id, favorite === 1, onOpen));
			}}
		>
			<button
				type="button"
				className={`${COLS} h-full w-full rounded-lg px-0 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent`}
				aria-label={active ? (isSelected ? t.library.deselect : t.library.select) : t.library.open}
				onPointerDown={onPointerDown}
				onPointerUp={cancelPress}
				onPointerLeave={cancelPress}
				onClick={(e) => {
					if (press.current?.fired) {
						press.current = null;
						return;
					}
					if (e.shiftKey) extend(id);
					else if (active || e.metaKey || e.ctrlKey) toggle(id);
					else onOpen(id);
				}}
			>
				<span className="relative h-10 w-10 overflow-hidden rounded-md bg-surface">
					<img
						src={thumbUrl(id, rev)}
						alt=""
						loading="lazy"
						decoding="async"
						draggable={false}
						onError={() => setFailed(true)}
						className={`h-full w-full object-cover ${failed ? "invisible" : ""}`}
					/>
				</span>
				<span className="min-w-0">
					<span className="flex min-w-0 items-center gap-1.5 text-sm">
						<span className={`truncate ${name ? "" : "text-muted"}`}>{name ?? t.folders.noName}</span>
						{kind === KIND_LIVE && <IconLive size={14} className="shrink-0 text-muted" />}
						{kind === KIND_VIDEO && (
							<span className="flex shrink-0 items-center gap-0.5 text-xs tabular-nums text-muted">
								<IconPlay size={9} />
								{formatDuration(duration)}
							</span>
						)}
						{favorite === 1 && <IconHeart size={14} filled className="shrink-0 text-danger" />}
					</span>
					<span className="block truncate text-xs text-muted sm:hidden">{bytes ? `${taken} · ${bytes}` : taken}</span>
				</span>
				<span className={`${CELL} hidden lg:block`}>{w > 1 && h > 1 ? `${w} × ${h}` : "–"}</span>
				<span className={`${CELL} hidden md:block`}>{formatOf(name) || "–"}</span>
				<span className={`${CELL} hidden sm:block`}>{taken}</span>
				<span className={`${CELL} hidden xl:block`}>{formatDateTime(uploadedAt)}</span>
				<span className={`${CELL} hidden pr-3 text-right sm:block`}>{bytes || "–"}</span>
			</button>
			{/* 勾选框盖在缩略图上，悬停或多选时出现 */}
			<button
				type="button"
				aria-label={isSelected ? t.library.deselect : t.library.select}
				onClick={(e) => (e.shiftKey ? extend(id) : toggle(id))}
				className={`absolute left-0 top-2 flex h-10 w-10 items-center justify-center rounded-md transition ${
					isSelected || active ? "opacity-100" : "opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
				} ${isSelected ? "" : "bg-black/25"}`}
			>
				<span
					className={`flex h-[22px] w-[22px] items-center justify-center rounded-full ${
						isSelected ? "bg-accent text-accent-fg shadow-[0_0_0_2px_white]" : "border-2 border-white/95 bg-black/15 text-transparent"
					}`}
				>
					<IconCheck size={14} />
				</span>
			</button>
		</div>
	);
});
