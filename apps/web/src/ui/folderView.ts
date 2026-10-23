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

/**
 * 文件夹里照片的排序，和显示方式一样是这台设备的偏好、所有文件夹共用。
 * 默认按拍摄时间从新到旧；只有按拍摄时间排序时网格才按天分组、拖动条才带年份和月份。
 */
export const FOLDER_SORTS = ["taken", "name", "uploaded", "size", "format"] as const;
export type FolderSortKey = (typeof FOLDER_SORTS)[number];
export interface FolderSort {
	key: FolderSortKey;
	asc: boolean;
}
const SORT_KEY = "nana:folder-sort";
const DEFAULT_SORT: FolderSort = { key: "taken", asc: false };
/** 换排序方式时默认的方向：名称和格式从 A 到 Z，其余从新到旧 / 从大到小 */
export const defaultAsc = (key: FolderSortKey) => key === "name" || key === "format";
const sortListeners = new Set<() => void>();

function readSort(): FolderSort {
	try {
		const [key, dir] = (localStorage.getItem(SORT_KEY) ?? "").split(":");
		if (FOLDER_SORTS.includes(key as FolderSortKey)) return { key: key as FolderSortKey, asc: dir === "asc" };
	} catch {
		// 读不到就用默认
	}
	return DEFAULT_SORT;
}

let currentSort = readSort();

export function setFolderSort(sort: FolderSort) {
	currentSort = sort;
	try {
		if (sort.key === DEFAULT_SORT.key && sort.asc === DEFAULT_SORT.asc) localStorage.removeItem(SORT_KEY);
		else localStorage.setItem(SORT_KEY, `${sort.key}:${sort.asc ? "asc" : "desc"}`);
	} catch {
		// 存不下也照样在当前页面生效
	}
	sortListeners.forEach((l) => l());
}

const subscribeSort = (l: () => void) => {
	sortListeners.add(l);
	return () => sortListeners.delete(l);
};

export function useFolderSort(): FolderSort {
	return useSyncExternalStore(subscribeSort, () => currentSort);
}
