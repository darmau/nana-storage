import { useNavigate } from "@tanstack/react-router";
import { createContext, memo, useContext, useEffect, useRef, useState } from "react";
import { formatDuration } from "../timeline/format";
import { KIND_LIVE, KIND_VIDEO, type TimelineItem, thumbUrl } from "../timeline/types";
import { openContextMenu } from "../ui/ContextMenu";
import { IconAlert, IconBurst, IconCheck, IconClose, IconHeart, IconLive, IconPlay } from "../ui/icons";
import { useAssetMenu } from "./SelectionBar";
import { useSelection } from "./selection";
import { t } from "../i18n";

/**
 * 这次会话里已经加载过的缩略图地址。重新挂载（滑动返回、滚回来）时直接显示，不再淡入：
 * Safari 从内存缓存取图也是异步的，挂载时 `complete` 还是 false，只靠它判断会让整页先空一下再淡入。
 * 按插入顺序只留最近的 SEEN_MAX 个，超过的那些即使还在缓存里也只是多一次淡入。
 */
const SEEN_MAX = 3000;
const seen = new Set<string>();
const markLoaded = (e: React.SyntheticEvent<HTMLImageElement>) => {
	const img = e.currentTarget;
	img.dataset.loaded = "";
	const src = img.getAttribute("src");
	if (!src || seen.has(src)) return;
	seen.add(src);
	if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value as string);
};
const markIfLoaded = (img: HTMLImageElement | null) => {
	if (img?.complete && img.naturalWidth) img.dataset.loaded = "";
};

/** 主题样本的标记：正例 / 反例，以及标签是否和分类器矛盾。 */
export interface TileMark {
	label: 1 | -1;
	conflict: boolean;
}
/** 列表里每个格子的标记（只有主题的样本列表有），没有时为 null。 */
export const TileMarks = createContext<ReadonlyMap<string, TileMark> | null>(null);

interface Props {
	item: TimelineItem;
	top: number;
	left: number;
	width: number;
	height: number;
	/** 所在的分组（时间线里是月份），Shift 范围选择时用 */
	scope?: string;
	onOpen: (id: string) => void;
}

/**
 * 照片格子：点击打开；勾选框或长按（触屏）进入多选；多选时点击就是选择；Shift 点击选上一段。
 * 连拍封面（时间线里）代表整组：点击进入连拍页，选择、右键菜单都作用于整组。
 */
export const Tile = memo(function Tile({ item, top, left, width, height, scope, onOpen: openOne }: Props) {
	const [id, , , kind, , duration, favorite, rev, burst] = item;
	const navigate = useNavigate();
	const onOpen = burst ? (assetId: string) => void navigate({ to: "/bursts/$assetId", params: { assetId } }) : openOne;
	const { selected, active, toggle, extend } = useSelection();
	const isSelected = selected.has(id);
	const menu = useAssetMenu();
	const mark = useContext(TileMarks)?.get(id);

	// 加载失败（比如快速滚动触发了限速）时，5 秒后重试一次，只重试一次。
	const [attempt, setAttempt] = useState(0);
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		if (!failed || attempt > 0) return;
		const t = setTimeout(() => {
			setAttempt(1);
			setFailed(false);
		}, 5000);
		return () => clearTimeout(t);
	}, [failed, attempt]);

	const src = attempt ? `${thumbUrl(id, rev)}&retry=1` : thumbUrl(id, rev);

	const press = useRef<{ timer: ReturnType<typeof setTimeout>; fired: boolean } | null>(null);
	const lastPointer = useRef("mouse");
	const onPointerDown = (e: React.PointerEvent) => {
		lastPointer.current = e.pointerType;
		if (e.pointerType !== "touch") return;
		const p = { fired: false, timer: setTimeout(() => ((p.fired = true), toggle(id, scope, burst), navigator.vibrate?.(10)), 450) };
		press.current = p;
	};
	const cancelPress = () => press.current && clearTimeout(press.current.timer);

	return (
		<div
			// iOS 长按图片会弹出系统菜单（存储图像等）并选中文字，这里长按是多选，要关掉
			className={`group absolute select-none overflow-hidden [-webkit-touch-callout:none] ${isSelected ? "bg-accent-soft" : "bg-surface"}`}
			style={{ top, left, width, height }}
			// Shift 点击时不要顺带选中页面上的文字
			onMouseDown={(e) => e.shiftKey && e.preventDefault()}
			onContextMenu={(e) => {
				// 触屏长按是多选，不弹菜单
				if (lastPointer.current === "touch") return e.preventDefault();
				openContextMenu(e, menu(id, favorite === 1, onOpen, burst));
			}}
		>
			<button
				type="button"
				className="block h-full w-full focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
				aria-label={active ? (isSelected ? t.library.deselect : t.library.select) : t.library.open}
				onPointerDown={onPointerDown}
				onPointerUp={cancelPress}
				onPointerLeave={cancelPress}
				onClick={(e) => {
					if (press.current?.fired) {
						press.current = null;
						return;
					}
					if (e.shiftKey) extend(id, scope, burst);
					else if (active || e.metaKey || e.ctrlKey) toggle(id, scope, burst);
					else onOpen(id);
				}}
			>
				<img
					src={src}
					alt=""
					loading="lazy"
					decoding="async"
					draggable={false}
					// 加载过的直接显示，第一次从网络加载的淡入（styles.css 的 .thumb）
					data-loaded={seen.has(src) ? "" : undefined}
					ref={markIfLoaded}
					onLoad={markLoaded}
					onError={() => setFailed(true)}
					className={`thumb h-full w-full object-cover transition duration-150 ${isSelected ? "scale-[0.86] rounded-md" : "group-hover:brightness-[0.92]"} ${failed ? "invisible" : ""}`}
				/>
			</button>
			{/* 反例：整张压暗，一眼就能和正例分开 */}
			{mark?.label === -1 && <span aria-hidden="true" className="pointer-events-none absolute inset-0 bg-black/55" />}
			{/* 悬停时顶部加一点暗色，让白色勾选框在浅色照片上也看得清 */}
			<span
				aria-hidden="true"
				className={`pointer-events-none absolute inset-x-0 top-0 h-12 bg-gradient-to-b from-black/30 to-transparent transition-opacity ${active && !isSelected ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
			/>
			<button
				type="button"
				aria-label={isSelected ? t.library.deselect : t.library.select}
				onClick={(e) => (e.shiftKey ? extend(id, scope, burst) : toggle(id, scope, burst))}
				className={`absolute left-1 top-1 flex h-8 w-8 items-center justify-center rounded-full transition ${
					isSelected || active ? "opacity-100" : "opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
				}`}
			>
				<span
					className={`flex h-[22px] w-[22px] items-center justify-center rounded-full ${
						isSelected ? "bg-accent text-accent-fg shadow-[0_0_0_2px_white]" : "border-2 border-white/95 bg-black/15 text-transparent"
					}`}
				>
					<IconCheck size={14} />
				</span>
			</button>
			{kind === KIND_VIDEO && (
				<span className="pointer-events-none absolute right-1.5 top-1.5 flex items-center gap-1 rounded-full bg-black/55 py-0.5 pl-1.5 pr-2 text-[11px] font-semibold tabular-nums text-white">
					<IconPlay size={10} />
					{formatDuration(duration)}
				</span>
			)}
			{burst && (
				<span className="pointer-events-none absolute right-1.5 top-1.5 flex items-center gap-1 rounded-full bg-black/55 py-0.5 pl-1.5 pr-2 text-[11px] font-semibold tabular-nums text-white">
					<IconBurst size={12} />
					{burst.length}
				</span>
			)}
			{!burst && kind === KIND_LIVE && (
				<span
					className="pointer-events-none absolute right-1.5 top-1.5 text-white drop-shadow-[0_1px_2px_rgb(0_0_0/0.5)]"
					aria-label="Live Photo"
				>
					<IconLive size={18} />
				</span>
			)}
			{mark && (
				<span className="pointer-events-none absolute bottom-1.5 right-1.5 flex items-center gap-1">
					{mark.conflict && (
						<span role="img" aria-label={t.topics.markConflict} className="flex h-6 w-6 items-center justify-center rounded-full bg-warn text-bg shadow">
							<IconAlert size={14} />
						</span>
					)}
					<span
						role="img"
						aria-label={mark.label === 1 ? t.topics.markPositive : t.topics.markNegative}
						className={`flex h-6 w-6 items-center justify-center rounded-full shadow ${mark.label === 1 ? "bg-accent text-accent-fg" : "bg-black/70 text-white ring-1 ring-white/70"}`}
					>
						{mark.label === 1 ? <IconCheck size={14} /> : <IconClose size={14} />}
					</span>
				</span>
			)}
			{favorite === 1 && (
				<span className="pointer-events-none absolute bottom-1.5 left-1.5 text-white drop-shadow-[0_1px_2px_rgb(0_0_0/0.5)]">
					<IconHeart size={16} filled />
				</span>
			)}
		</div>
	);
});
