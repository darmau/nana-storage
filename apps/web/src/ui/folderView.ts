import { useSyncExternalStore } from "react";

/**
 * 文件夹页的显示方式：网格（默认）或列表。只是这台设备上的偏好，存在 localStorage（读写失败就当网格）。
 * 所有文件夹共用同一个设置。
 */
export type FolderView = "grid" | "list";
const KEY = "nana:folder-view";
const listeners = new Set<() => void>();

function read(): FolderView {
	try {
		return localStorage.getItem(KEY) === "list" ? "list" : "grid";
	} catch {
		return "grid";
	}
}

let current = read();

export function setFolderView(view: FolderView) {
	current = view;
	try {
		if (view === "grid") localStorage.removeItem(KEY);
		else localStorage.setItem(KEY, view);
	} catch {
		// 存不下也照样在当前页面生效
	}
	listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
	listeners.add(l);
	return () => listeners.delete(l);
};

export function useFolderView(): FolderView {
	return useSyncExternalStore(subscribe, () => current);
}
