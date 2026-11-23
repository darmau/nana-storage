import { useSyncExternalStore } from "react";
import type { TimelineItem } from "./types";

/**
 * 时间线里原地展开的相似照片组。展开状态存在查询数据之外：
 * 月份滚出视口被卸载、滚回来重挂载，或者资料库同步刷新数据，展开都保持。
 * stackId → 展开时的封面 id（“收起”按钮挂在那个格子上）；反向索引 anchor → stackId。
 */
const expanded = new Map<string, string>();
const anchors = new Map<string, string>();
const listeners = new Set<() => void>();
let version = 0;
/** 同时展开的组数上限：每个展开的组都占一份成员缓存，超了先收起最早的。 */
const MAX_EXPANDED = 50;

const notify = () => {
	version++;
	listeners.forEach((l) => l());
};

export function expandStack(stackId: string, anchorId: string) {
	if (expanded.has(stackId)) return;
	if (expanded.size >= MAX_EXPANDED) collapseStack(expanded.keys().next().value as string);
	expanded.set(stackId, anchorId);
	anchors.set(anchorId, stackId);
	notify();
}

export function collapseStack(stackId: string) {
	const anchor = expanded.get(stackId);
	if (anchor === undefined) return;
	expanded.delete(stackId);
	anchors.delete(anchor);
	notify();
}

export const isExpanded = (stackId: string) => expanded.has(stackId);
export const anchorStack = (assetId: string) => anchors.get(assetId);

const subscribe = (l: () => void) => {
	listeners.add(l);
	return () => listeners.delete(l);
};

/** 订阅展开状态变化：返回版本号（原始值），渲染时自己读 store 的内容。 */
export const useExpandVersion = () => useSyncExternalStore(subscribe, () => version);

/** 格子的折叠状态：0 普通，1 折叠的组封面（显示 +N，点击展开），2 已展开组的锚点（显示“收起”）。 */
export function tileStackCode(it: TimelineItem): 0 | 1 | 2 {
	if (it[9] && it[8] && it[8].length > 1) return 1;
	return anchors.has(it[0]) ? 2 : 0;
}

export const useTileStackCode = (it: TimelineItem): 0 | 1 | 2 => useSyncExternalStore(subscribe, () => tileStackCode(it));
