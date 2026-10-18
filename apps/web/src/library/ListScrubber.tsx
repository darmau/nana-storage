import { type RefObject, useEffect, useState } from "react";
import { Scrubber } from "../timeline/Scrubber";
import type { Bucket } from "../timeline/types";

/**
 * 列表（文件夹 / 相册 / 收藏 / 搜索）的拖动条：把窗口滚动位置换算成相对网格顶部的位置交给 Scrubber。
 * 自己监听滚动，滚动时只重新渲染拖动条，不重新渲染网格。
 */
export function ListScrubber({
	gridRef,
	months,
	starts,
	totalSize,
	dated,
}: {
	gridRef: RefObject<HTMLElement | null>;
	months: Bucket[];
	starts: number[];
	totalSize: number;
	dated: boolean;
}) {
	const [view, setView] = useState({ offset: 0, height: 800, margin: 0 });
	useEffect(() => {
		let raf = 0;
		const update = () => {
			raf = 0;
			const el = gridRef.current;
			if (!el) return;
			// 网格上面的页头（标题、子文件夹）高度会变，每次都重新量
			const margin = el.getBoundingClientRect().top + window.scrollY;
			const next = { offset: Math.max(0, window.scrollY - margin), height: window.innerHeight, margin };
			setView((v) => (v.offset === next.offset && v.height === next.height && v.margin === next.margin ? v : next));
		};
		const onScroll = () => (raf ||= requestAnimationFrame(update));
		update();
		window.addEventListener("scroll", onScroll, { passive: true });
		window.addEventListener("resize", onScroll);
		return () => {
			window.removeEventListener("scroll", onScroll);
			window.removeEventListener("resize", onScroll);
			cancelAnimationFrame(raf);
		};
	}, [gridRef]);

	return (
		<Scrubber
			months={months}
			starts={starts}
			totalSize={totalSize}
			scrollOffset={view.offset}
			viewHeight={view.height}
			onSeek={(offset) => window.scrollTo({ top: offset + view.margin })}
			controls="asset-grid"
			dated={dated}
		/>
	);
}
