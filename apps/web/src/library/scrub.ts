import { useSyncExternalStore } from "react";

/**
 * 拖动拖动条或快速滚动期间为 true：网格只画占位（styles.css 的 .scrub-placeholder），不挂载缩略图，
 * 也不请求还没加载的月份 / 页。一路滚过去会经过几十个月，每个月都去请求、布局、加载几百张缩略图毫无意义，
 * 还会让滚动掉帧；停下来之后只加载停下的位置（参考 Google 相册）。
 */
let dragging = false;
let fast = false;
let scrubbing = false;
const listeners = new Set<() => void>();

function update() {
	const next = dragging || fast;
	if (next === scrubbing) return;
	scrubbing = next;
	for (const l of listeners) l();
}

/** 拖动条按下 / 松开时调用。 */
export function setScrubbing(next: boolean) {
	dragging = next;
	update();
}

/** 速度超过每秒这么多个视口高度算快速滚动（触控板 / 触屏甩动）；普通滚轮远低于这个速度。 */
const FAST_VIEWPORTS_PER_S = 8;
/** 连续这么多次滚动事件都超速才算，避免一次性的跳转（scrollTo、恢复滚动位置）闪一下占位。 */
const FAST_EVENTS = 2;
/** 降到阈值以下这么久后恢复正常渲染。 */
const SETTLE_MS = 180;

let lastY = 0;
let lastT = 0;
let streak = 0;
let settle: ReturnType<typeof setTimeout> | undefined;

function onScroll() {
	const t = performance.now();
	const y = window.scrollY;
	const dt = t - lastT;
	const v = dt > 0 ? (Math.abs(y - lastY) / dt) * 1000 : 0;
	lastY = y;
	lastT = t;
	// 两次事件间隔太久（新的一次滚动），速度没有意义
	streak = dt < 100 && v > FAST_VIEWPORTS_PER_S * window.innerHeight ? streak + 1 : 0;
	if (streak >= FAST_EVENTS) {
		fast = true;
		update();
		clearTimeout(settle);
		settle = setTimeout(() => {
			fast = false;
			streak = 0;
			update();
		}, SETTLE_MS);
	}
}

/** 有人订阅时才监听窗口滚动（时间线、列表网格都挂着时也只有一个监听器）。 */
const subscribe = (l: () => void) => {
	if (!listeners.size) {
		lastY = window.scrollY;
		lastT = performance.now();
		window.addEventListener("scroll", onScroll, { passive: true });
	}
	listeners.add(l);
	return () => {
		listeners.delete(l);
		if (listeners.size) return;
		window.removeEventListener("scroll", onScroll);
		clearTimeout(settle);
		fast = false;
		streak = 0;
		scrubbing = dragging;
	};
};

export const useScrubbing = () => useSyncExternalStore(subscribe, () => scrubbing);
