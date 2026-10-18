import type { TimelineItem } from "../timeline/types";

/**
 * 最近查看 / 最常查看：查看器每打开一张照片记一次，只存在这台设备的 localStorage 里，不发给服务端。
 * 存的是格子需要的那几项（缩略图版本号、尺寸、类型），探索页直接画缩略图、打开查看器，不额外请求。
 * 只保留最近打开过的 MAX 张（按时间淘汰），“最常查看”也在这些里面按次数排。读写失败（隐私模式等）就当没有记录。
 */
const KEY = "nana:recent";
const MAX = 200;

interface Entry {
	item: TimelineItem;
	/** 最后一次打开的时间 */
	at: number;
	count: number;
}

const valid = (e: unknown): e is Entry => {
	const x = e as Entry;
	return !!x && Array.isArray(x.item) && typeof x.item[0] === "string" && typeof x.at === "number" && typeof x.count === "number";
};

function load(): Entry[] {
	try {
		const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
		return Array.isArray(v) ? v.filter(valid) : [];
	} catch {
		return [];
	}
}

function save(list: Entry[]) {
	try {
		localStorage.setItem(KEY, JSON.stringify(list));
	} catch {
		// 存不下就算了
	}
}

/** 查看器打开了一张照片。连拍封面的整组 id（第 9 项）不存：从这里打开的只是这一张。 */
export function recordView(item: TimelineItem) {
	const list = load();
	const old = list.find((e) => e.item[0] === item[0]);
	const entry: Entry = { item: item.slice(0, 8) as TimelineItem, at: Date.now(), count: (old?.count ?? 0) + 1 };
	save([entry, ...list.filter((e) => e !== old)].slice(0, MAX));
}

/** 缩略图读不到了（永久删除之类）：从记录里去掉 */
export function forgetView(id: string) {
	const list = load();
	const next = list.filter((e) => e.item[0] !== id);
	if (next.length !== list.length) save(next);
}

/** 最近打开的在前 */
export function recentViews(limit: number): TimelineItem[] {
	return load()
		.sort((a, b) => b.at - a.at)
		.slice(0, limit)
		.map((e) => e.item);
}

/** 打开次数最多的在前，只算看过至少两次的 */
export function mostViewed(limit: number): TimelineItem[] {
	return load()
		.filter((e) => e.count >= 2)
		.sort((a, b) => b.count - a.count || b.at - a.at)
		.slice(0, limit)
		.map((e) => e.item);
}
