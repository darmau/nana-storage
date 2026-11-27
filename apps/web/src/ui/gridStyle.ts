import { useSyncExternalStore } from "react";

/**
 * 手机（窄屏）上照片网格的样式：方形 3 列（默认，和 iOS 相册一样）还是自适应比例（justified）。
 * 只是这台设备上的偏好，存在 localStorage（读写失败就当方形）。平板和桌面（宽屏）始终是自适应。
 */
export type GridStyle = "square" | "justified";
const KEY = "nana:grid-style";
const listeners = new Set<() => void>();

function read(): GridStyle {
	try {
		return localStorage.getItem(KEY) === "justified" ? "justified" : "square";
	} catch {
		return "square";
	}
}

let current = read();

export function setGridStyle(style: GridStyle) {
	current = style;
	try {
		if (style === "square") localStorage.removeItem(KEY);
		else localStorage.setItem(KEY, style);
	} catch {
		// 存不下也照样在当前页面生效
	}
	listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
	listeners.add(l);
	return () => listeners.delete(l);
};

export function useGridStyle(): GridStyle {
	return useSyncExternalStore(subscribe, () => current);
}
