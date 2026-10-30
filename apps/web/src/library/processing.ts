import { useSyncExternalStore } from "react";
import { api } from "../api";
import type { AssetDetail } from "../viewer/types";

/**
 * 这次会话里用户编辑过（旋转 / 裁切 / 打码）、拼接 / 切割过，正在等后台生成新图的照片。
 * 格子和查看器给它们叠一层黑色遮罩，表示还在处理。
 *
 * 只在这台设备的内存里，不查服务端：列表接口带 ETag，后台任务不改 library 版本，服务端的标记会过期。
 * 标记一定会被清掉：编辑由 useEditSave 的轮询结束时清；拼接 / 切割由下面的 watchCompose 清（有上限的轮询）。
 */

const marks = new Map<string, number>();
const listeners = new Set<() => void>();
const emit = () => {
	for (const l of listeners) l();
};

/** 标记一批照片正在处理。可以重复标记（计数），每次 mark 对应一次 unmark。 */
export function markProcessing(ids: readonly string[]) {
	for (const id of ids) marks.set(id, (marks.get(id) ?? 0) + 1);
	emit();
}

export function unmarkProcessing(ids: readonly string[]) {
	for (const id of ids) {
		const n = (marks.get(id) ?? 0) - 1;
		if (n > 0) marks.set(id, n);
		else marks.delete(id);
	}
	emit();
}

const subscribe = (l: () => void) => {
	listeners.add(l);
	return () => listeners.delete(l);
};

export function useProcessing(id: string) {
	return useSyncExternalStore(subscribe, () => marks.has(id));
}

/** 拼接 / 切割：每 3 秒看一张新照片，最多 200 次（10 分钟），所有新照片都没有排队 / 运行中的任务时结束。 */
const COMPOSE_POLL_MS = 3000;
const COMPOSE_POLL_MAX = 200;

/**
 * 原照片在新照片处理好之前一直带遮罩。新照片处理好后服务端把原照片移进回收站（列表由 sync.ts 刷新）；
 * 失败时原照片不动，遮罩照样去掉。出错（断网、新照片已被删除）就不等了。
 */
export function watchCompose(sourceIds: readonly string[], newIds: readonly string[], onDone: () => void) {
	markProcessing(sourceIds);
	void (async () => {
		const waiting = [...newIds];
		try {
			for (let i = 0; i < COMPOSE_POLL_MAX && waiting.length; i++) {
				await new Promise((res) => setTimeout(res, COMPOSE_POLL_MS));
				const a = await api<AssetDetail>(`/assets/${waiting[0]}`);
				if (!a.jobs_active) waiting.shift();
			}
		} catch {}
		unmarkProcessing(sourceIds);
		onDone();
	})();
}
