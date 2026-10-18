import { type RefObject, useLayoutEffect, useState } from "react";

/** 元素宽度（取整），宽度变化时更新。 */
export function useWidth(ref: RefObject<HTMLElement | null>): number {
	const [width, setWidth] = useState(0);
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		setWidth(Math.floor(el.clientWidth));
		const ro = new ResizeObserver(([entry]) => setWidth(Math.floor(entry!.contentRect.width)));
		ro.observe(el);
		return () => ro.disconnect();
	}, [ref]);
	return width;
}
