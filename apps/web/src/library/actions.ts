import type { QueryClient } from "@tanstack/react-query";
import { api } from "../api";

export type BatchAction =
	| { action: "favorite"; value: boolean }
	| { action: "archive"; value: boolean }
	| { action: "trash" }
	| { action: "restore" }
	| { action: "delete-forever" }
	| { action: "move"; folderId: string | null }
	| { action: "set-time"; takenAt: { local: string; tzOffsetMin: number } }
	| { action: "shift-time"; deltaMin: number; fallbackTzOffsetMin: number }
	| { action: "set-location"; location: { lat: number; lon: number } | null };

/** 资料库里任何数据变了以后，刷新所有相关列表。 */
export function invalidateLibrary(qc: QueryClient) {
	for (const key of ["timeline", "list", "asset", "folders", "albums", "smart-sets", "similar", "duplicates", "people", "storage-summary"])
		void qc.invalidateQueries({ queryKey: [key] });
}

export async function batch(qc: QueryClient, ids: string[], action: BatchAction) {
	const res = await api<{ changed: number }>("/assets/batch", { method: "POST", json: { ids, ...action } });
	invalidateLibrary(qc);
	return res;
}

export async function addToAlbum(qc: QueryClient, albumId: string, ids: string[]) {
	const res = await api<{ added: number }>(`/albums/${albumId}/assets`, { method: "POST", json: { assetIds: ids } });
	invalidateLibrary(qc);
	return res;
}

export async function removeFromAlbum(qc: QueryClient, albumId: string, ids: string[]) {
	const res = await api<{ removed: number }>(`/albums/${albumId}/remove`, { method: "POST", json: { assetIds: ids } });
	invalidateLibrary(qc);
	return res;
}

/** 让浏览器自己的下载管理器接收 zip（不经过页面内存）。 */
export async function downloadZip(ids: string[]) {
	const r = await api<{ url: string; files: number; bytes: number; skipped: number }>("/downloads", {
		method: "POST",
		json: { ids },
	});
	const a = document.createElement("a");
	a.href = r.url;
	a.rel = "noopener";
	document.body.appendChild(a);
	a.click();
	a.remove();
	return r;
}

/**
 * 主题的样本：1 正例，-1 反例，0 移出样本。只记录，不重新训练（点“更新”或每小时的 Cron 才会）。
 * conflicts：主题训练过时，其中标签和分类器矛盾的张数。
 */
export async function setSmartSetExamples(qc: QueryClient, setId: string, ids: string[], label: 1 | -1 | 0) {
	const res = await api<{ changed: number; conflicts: number }>(`/smart-sets/${setId}/examples`, {
		method: "POST",
		json: { ids, label },
	});
	invalidateLibrary(qc);
	return res;
}

/** 新建主题，服务端会立即查找一次。 */
export async function createSmartSet(qc: QueryClient, name: string, ids: string[]) {
	const res = await api<{ id: string; suggestions: number }>("/smart-sets", { method: "POST", json: { name, ids } });
	invalidateLibrary(qc);
	return res;
}

/** 按现在的标记重新学习，并在全库里重新查找建议（几秒钟）。 */
export async function refreshSmartSet(qc: QueryClient, setId: string) {
	const res = await api<{ suggestions: number }>(`/smart-sets/${setId}/refresh`, { method: "POST" });
	invalidateLibrary(qc);
	return res;
}

/** 主题的范围：文件夹 id（含子文件夹），空数组表示整个资料库。服务端会立即重新查找（几秒钟）。 */
export async function setSmartSetFolders(qc: QueryClient, setId: string, folders: string[]) {
	const res = await api<{ ok: true; suggestions?: number | null }>(`/smart-sets/${setId}`, {
		method: "PATCH",
		json: { folders: folders.length ? folders : null },
	});
	invalidateLibrary(qc);
	return res;
}

/** 标记为“不是重复”（pivot：只有这张和其他几张不是），undo 为 true 时撤销同样的标记。 */
export async function ignoreDuplicates(qc: QueryClient, ids: string[], pivot?: string, undo = false) {
	const res = await api<{ pairs: number }>(`/duplicates/${undo ? "unignore" : "ignore"}`, { method: "POST", json: { ids, pivot } });
	void qc.invalidateQueries({ queryKey: ["duplicates"] });
	return res;
}
