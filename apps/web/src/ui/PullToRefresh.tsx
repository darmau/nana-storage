import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { connectionStore } from "../api";
import { IconRotate } from "./icons";

/** 从主屏幕打开（独立窗口）时没有浏览器的刷新按钮，系统的下拉刷新也被 overscroll-behavior: none 关掉了。 */
const standalone = () =>
	window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;

const THRESHOLD = 64; // 指示器下移多少算“松手刷新”
const MAX_PULL = 96;
const HOLD = 48; // 刷新期间指示器停留的位置
const MIN_SPIN_MS = 500; // 304 很快，转一下让人看到刷新过

/** 纵向能滚动且没滚到顶的祖先、固定定位的东西（查看器、弹窗、地图、拖动条、操作栏）、touch-action: none 的区域里不触发。 */
function pullable(target: EventTarget | null) {
	let el = target instanceof Element ? target : null;
	while (el && el !== document.body) {
		const cs = getComputedStyle(el);
		if (cs.position === "fixed" || cs.touchAction === "none") return false;
		if (el.scrollTop > 0 && /auto|scroll/.test(cs.overflowY)) return false;
		el = el.parentElement;
	}
	return true;
}

/**
 * 下拉刷新（只在独立窗口里启用）：页面在顶部时往下拉，过了阈值松手就重新请求当前页面的数据
 * （invalidateQueries：正在显示的重新请求，其余标记过期；列表接口带 ETag，没变的回 304）。
 * 连接已中断（可能是登录过期）时整页重新加载，让 Access 走一遍登录。
 * 成本：每次手势最多一轮请求，刷新期间不接受新的下拉，没有任何自动重复。
 * 拖动时不走 React，直接改指示器的 transform。
 */
export function PullToRefresh() {
	const qc = useQueryClient();
	const ref = useRef<HTMLDivElement>(null);
	const icon = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!standalone()) return;
		const box = ref.current!;
		const spinner = icon.current!;
		let startX = 0;
		let startY = 0;
		let state: "idle" | "pending" | "pulling" | "refreshing" = "idle";
		let pull = 0;

		const place = (y: number, animate: boolean) => {
			box.style.transition = animate ? "transform 200ms ease, opacity 200ms ease" : "none";
			box.style.transform = `translate(-50%, ${y - HOLD}px)`;
			box.style.opacity = y > 0 ? String(Math.min(1, y / THRESHOLD)) : "0";
		};
		const reset = () => {
			state = "idle";
			pull = 0;
			place(0, true);
			spinner.classList.remove("animate-spin");
			box.dataset.ready = "";
		};

		const onStart = (e: TouchEvent) => {
			if (state === "refreshing") return;
			state = "idle";
			const t = e.touches[0];
			if (!t || e.touches.length !== 1 || window.scrollY > 0 || !pullable(e.target)) return;
			startX = t.clientX;
			startY = t.clientY;
			state = "pending";
		};
		const onMove = (e: TouchEvent) => {
			if (state !== "pending" && state !== "pulling") return;
			const t = e.touches[0];
			if (!t || e.touches.length !== 1) return reset();
			const dx = t.clientX - startX;
			const dy = t.clientY - startY;
			if (state === "pending") {
				if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
				// 横向滑动（主题卡片、查看器）或往上滑：这次手势不算
				if (dy <= 0 || Math.abs(dx) > dy || window.scrollY > 0) {
					state = "idle";
					return;
				}
				state = "pulling";
			}
			// 越拉越难拉
			pull = Math.min(MAX_PULL, Math.max(0, dy) * 0.5);
			place(pull, false);
			spinner.style.transform = `rotate(${(pull / THRESHOLD) * 270}deg)`;
			box.dataset.ready = pull >= THRESHOLD ? "1" : "";
		};
		const onEnd = async () => {
			if (state !== "pulling") {
				if (state === "pending") state = "idle";
				return;
			}
			if (pull < THRESHOLD) return reset();
			state = "refreshing";
			place(HOLD, true);
			spinner.style.transform = "";
			spinner.classList.add("animate-spin");
			if (connectionStore.get() === "lost") {
				location.reload();
				return;
			}
			const started = Date.now();
			try {
				await qc.invalidateQueries();
			} finally {
				const left = MIN_SPIN_MS - (Date.now() - started);
				if (left > 0) await new Promise((r) => setTimeout(r, left));
				reset();
			}
		};
		const onCancel = () => state !== "refreshing" && reset();

		window.addEventListener("touchstart", onStart, { passive: true });
		window.addEventListener("touchmove", onMove, { passive: true });
		window.addEventListener("touchend", onEnd);
		window.addEventListener("touchcancel", onCancel);
		return () => {
			window.removeEventListener("touchstart", onStart);
			window.removeEventListener("touchmove", onMove);
			window.removeEventListener("touchend", onEnd);
			window.removeEventListener("touchcancel", onCancel);
		};
	}, [qc]);

	return (
		<div
			ref={ref}
			aria-hidden="true"
			className="pointer-events-none fixed left-1/2 top-[calc(var(--header-h)+0.5rem)] z-40 flex size-10 items-center justify-center rounded-full bg-card text-muted opacity-0 shadow-md ring-1 ring-border data-[ready=1]:text-accent-ink"
			style={{ transform: `translate(-50%, ${-HOLD}px)` }}
		>
			<div ref={icon}>
				<IconRotate size={20} />
			</div>
		</div>
	);
}
