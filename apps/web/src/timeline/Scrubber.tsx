import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { setScrubbing } from "../library/scrub";
import { IconChevronDown, IconChevronUp } from "../ui/icons";
import { formatMonth } from "./format";
import type { Bucket } from "./types";

/** 半圆手柄的高度（宽度是一半，贴在右边缘正好是半圆） */
const HANDLE_H = 48;
/** 滚动停下后手柄再显示这么久（触屏没有悬停，靠它露出手柄） */
const SHOW_AFTER_SCROLL_MS = 1500;

/**
 * 右侧的年月拖动条（时间线，以及文件夹 / 相册等列表，见 library/ListScrubber.tsx）。位置按每个月在列表里的实际（或估算）偏移量计算，可以一下跳到任意年份。
 * 悬停、拖动或刚滚动过时，在当前位置露出一个半圆手柄（参考 Google 相册）；按住手柄拖动不会跳动，
 * 点轨道的其他位置则让手柄中心对准指针。
 * 拖动期间网格只画占位、不请求（setScrubbing），松手后才加载停下来的那几个月；鼠标拖动时页面跟着滚，触屏松手时才跳过去（见 drag）。
 * 拖动和悬停时不经过 React：直接改手柄、细线、标签的 transform 和文字，只在按下 / 松开时各渲染一次。
 * 位置都用 transform（不改 top，不触发布局），手柄只对滑入滑出做过渡，不对位置做过渡，所以紧跟指针。
 */
interface Props {
	months: Bucket[];
	starts: number[];
	totalSize: number;
	scrollOffset: number;
	viewHeight: number;
	onSeek: (offset: number) => void;
	/** 被滚动的列表元素的 id（aria-controls） */
	controls?: string;
	/**
	 * 显示年份刻度和月份标签（默认）。列表不按拍摄时间排序（主题、人物、相似照片…）时为 false：
	 * 按顺序切出来的月份会来回跳，年份大量重复，只留手柄；拖动时的占位和不走 React 的逻辑不变。
	 */
	dated?: boolean;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
/** 比例 → 与手柄中心对齐的 CSS 位置（年份标签，只在月份变化时重新渲染） */
const centerTop = (frac: number) => `calc(${HANDLE_H / 2}px + ${frac} * (100% - ${HANDLE_H}px))`;

export function Scrubber({ months, starts, totalSize, scrollOffset, viewHeight, onSeek, controls = "timeline", dated = true }: Props) {
	const ref = useRef<HTMLDivElement>(null);
	const handleRef = useRef<HTMLSpanElement>(null);
	const lineRef = useRef<HTMLSpanElement>(null);
	const labelRef = useRef<HTMLSpanElement>(null);
	const scrollable = Math.max(1, totalSize - viewHeight);
	/** 轨道高度（像素），transform 需要具体的像素值 */
	const [trackH, setTrackH] = useState(0);
	/** 悬停（没按下）中：只用来露出手柄，指针位置不进 state */
	const [hovering, setHovering] = useState(false);
	/**
	 * 拖动中：按下时指针离手柄顶部的距离、当前比例，以及页面是否跟着滚（live）。拖动时直接改 DOM，渲染时也从这里取，两边一致。
	 * 触屏不跟着滚、松手时才跳过去：iOS 上手指按着时用 scrollTo 滚页面，之后触摸事件的 clientY / screenY
	 * 会差出刚滚过的距离（滚动位置在两个进程之间不同步），手柄在顶部和底部之间来回跳，页面一直是空白占位，
	 * 松手的事件也可能收不到。反正拖动期间网格只画占位，页面跟不跟着滚看起来没有区别。
	 */
	const drag = useRef<{ grab: number; frac: number; live: boolean } | null>(null);
	const [dragging, setDragging] = useState(false);
	const [recent, setRecent] = useState(false);

	// 刚滚动过时露出手柄；挂载时的第一次不算
	const lastOffset = useRef(scrollOffset);
	useEffect(() => {
		if (lastOffset.current === scrollOffset) return;
		lastOffset.current = scrollOffset;
		setRecent(true);
		const t = setTimeout(() => setRecent(false), SHOW_AFTER_SCROLL_MS);
		return () => clearTimeout(t);
	}, [scrollOffset]);

	// 拖动中途离开页面（切换路由）时也要恢复加载
	useEffect(() => () => setScrubbing(false), []);

	// 有了拖动条就不需要浏览器自己的滚动条，两条并排既多余又挤占宽度；内容区也给拖动条让出位置（styles.css）
	// 不带日期时由调用方决定要不要显示（条目够多才渲染），这里不再按月份数判断
	const active = !dated || months.length >= 2;
	useEffect(() => {
		if (!active) return;
		const root = document.documentElement;
		root.classList.add("has-scrubber");
		return () => root.classList.remove("has-scrubber");
	}, [active]);

	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		const measure = () => setTrackH(el.clientHeight);
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	}, [active]);

	const years = useMemo(() => {
		const out: { year: string; frac: number }[] = [];
		if (!dated) return out;
		let last = "";
		months.forEach((m, i) => {
			const y = m.month === "unknown" ? "?" : m.month.slice(0, 4);
			if (y !== last) {
				out.push({ year: y, frac: Math.min(1, (starts[i] ?? 0) / scrollable) });
				last = y;
			}
		});
		// 太密时只保留间隔足够的年份标签
		return out.filter((y, i) => i === 0 || y.frac - out[i - 1]!.frac > 0.03);
	}, [months, starts, scrollable, dated]);

	/** 比例 → 月份名（starts 递增，二分查找最后一个不晚于该位置的月份） */
	const labelAt = (frac: number) => {
		const offset = frac * scrollable;
		let a = 0;
		let b = starts.length - 1;
		while (a < b) {
			const m = (a + b + 1) >> 1;
			if (starts[m]! <= offset) a = m;
			else b = m - 1;
		}
		const m = months[a]?.month ?? "";
		return m ? formatMonth(m) : "";
	};

	const fracAt = (clientY: number, grab: number) => {
		const rect = ref.current!.getBoundingClientRect();
		return clamp01((clientY - rect.top - grab) / Math.max(1, rect.height - HANDLE_H));
	};

	const span = Math.max(0, trackH - HANDLE_H);
	const handleY = (frac: number) => `translateY(${frac * span}px)`;
	const centerY = (frac: number) => `translateY(${HANDLE_H / 2 + frac * span}px)`;

	/** 拖动中：手柄和细线跟着指针（不等页面滚动之后再渲染） */
	const placeThumb = (frac: number) => {
		if (handleRef.current) handleRef.current.style.transform = handleY(frac);
		if (lineRef.current) lineRef.current.style.transform = centerY(frac);
	};
	/** 月份标签只由这里改，React 不管它的内容和位置 */
	const showLabel = (frac: number | null) => {
		const el = labelRef.current;
		if (!el) return;
		if (frac === null || !dated) {
			el.hidden = true;
			return;
		}
		const text = labelAt(frac);
		if (el.textContent !== text) el.textContent = text;
		el.style.transform = centerY(frac);
		el.hidden = false;
	};

	const endDrag = () => {
		const d = drag.current;
		if (d && !d.live) onSeek(d.frac * scrollable);
		drag.current = null;
		setDragging(false);
		setScrubbing(false);
		showLabel(null);
	};

	if (!active) return null;
	const thumbFrac = dragging && drag.current ? drag.current.frac : clamp01(scrollOffset / scrollable);
	const visible = dragging || hovering || recent;

	return (
		<div
			ref={ref}
			className="fixed bottom-[calc(var(--tabbar-h)+0.5rem)] right-[var(--safe-right)] top-[calc(var(--header-h)+0.75rem)] z-10 w-10 cursor-ns-resize touch-none select-none sm:w-14 md:bottom-3"
			onPointerDown={(e) => {
				if (e.button !== 0) return;
				e.currentTarget.setPointerCapture(e.pointerId);
				// 按在可见的手柄上：保持指针和手柄的相对位置；否则手柄中心跳到指针处
				const h = handleRef.current;
				const onHandle = visible && h?.contains(e.target as Node);
				const grab = onHandle ? e.clientY - h!.getBoundingClientRect().top : HANDLE_H / 2;
				const frac = fracAt(e.clientY, grab);
				const live = e.pointerType === "mouse";
				drag.current = { grab, frac, live };
				setScrubbing(true);
				setDragging(true);
				setHovering(false);
				placeThumb(frac);
				showLabel(frac);
				if (live) onSeek(frac * scrollable);
			}}
			onPointerMove={(e) => {
				const d = drag.current;
				if (d) {
					d.frac = fracAt(e.clientY, d.grab);
					placeThumb(d.frac);
					showLabel(d.frac);
					if (d.live) onSeek(d.frac * scrollable);
				} else if (e.pointerType === "mouse") {
					setHovering(true);
					showLabel(fracAt(e.clientY, HANDLE_H / 2));
				}
			}}
			onPointerUp={(e) => {
				if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
				endDrag();
			}}
			// 系统打断（来电、手势被浏览器接管）时也要结束拖动
			onPointerCancel={endDrag}
			onLostPointerCapture={() => drag.current && endDrag()}
			onPointerLeave={() => {
				setHovering(false);
				if (!drag.current) showLabel(null);
			}}
			role="scrollbar"
			aria-orientation="vertical"
			aria-valuenow={Math.round(thumbFrac * 100)}
			aria-controls={controls}
		>
			{years.map((y) => (
				<span
					key={y.year}
					className="pointer-events-none absolute right-2 -translate-y-1/2 text-[11px] font-medium tabular-nums text-muted"
					style={{ top: centerTop(y.frac) }}
				>
					{y.year}
				</span>
			))}
			{/* 平时只显示一条细线标出当前位置 */}
			<span
				ref={lineRef}
				className={`pointer-events-none absolute right-0 top-0 h-1 w-7 -translate-y-1/2 rounded-l-full bg-accent transition-opacity ${visible ? "opacity-0" : "opacity-100"}`}
				style={{ transform: centerY(thumbFrac) }}
			/>
			<span
				ref={handleRef}
				aria-hidden="true"
				className={`absolute right-0 top-0 flex w-6 cursor-grab flex-col items-center justify-center rounded-l-full shadow-md ring-1 ring-border transition-[translate,opacity,background-color] duration-150 ${
					dragging ? "cursor-grabbing bg-accent text-accent-fg" : "bg-card text-fg"
				} ${visible ? "translate-x-0 opacity-100" : "pointer-events-none translate-x-full opacity-0"}`}
				style={{ transform: handleY(thumbFrac), height: HANDLE_H }}
			>
				<IconChevronUp size={12} className="-mb-0.5 ml-1" />
				<IconChevronDown size={12} className="-mt-0.5 ml-1" />
			</span>
			<span
				ref={labelRef}
				hidden
				className="pointer-events-none absolute right-11 top-0 -translate-y-1/2 whitespace-nowrap rounded-full bg-fg px-3 py-1 text-xs font-semibold text-bg shadow-lg sm:right-14"
			/>
		</div>
	);
}
