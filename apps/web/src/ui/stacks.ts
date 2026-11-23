import type { QueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";

/**
 * 时间线是否折叠相似照片（src/stacks.ts）。只是这台设备上的显示偏好，存在 localStorage；
 * 分组本身一直在服务端维护，关掉只是不折叠（接口带 ?stacks=0），连拍照常折叠。
 */
const KEY = "nana:stacks-off";
const listeners = new Set<() => void>();

function read(): boolean {
	try {
		return localStorage.getItem(KEY) !== "1";
	} catch {
		return true;
	}
}

let current = read();

/** 非 React 环境（查询函数）读当前值。 */
export const stacksEnabled = () => current;

export function setStacksEnabled(qc: QueryClient, on: boolean) {
	current = on;
	try {
		if (on) localStorage.removeItem(KEY);
		else localStorage.setItem(KEY, "1");
	} catch {
		// 存不下也照样在当前页面生效
	}
	// 两种模式的响应不同，缓存的月份 / 张数全部重取
	void qc.invalidateQueries({ queryKey: ["timeline"] });
	listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
	listeners.add(l);
	return () => listeners.delete(l);
};

export function useStacksEnabled(): boolean {
	return useSyncExternalStore(subscribe, () => current);
}
