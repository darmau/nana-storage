import type { QueryClient } from "@tanstack/react-query";
import { bucketsQuery, monthQuery } from "../timeline/queries";
import type { Bucket, TimelineItem } from "../timeline/types";

export interface Neighbor {
	id: string;
	item: TimelineItem;
	/** 时间线专用：所在月份 */
	month?: string;
}

/** 查看器的数据源：当前条目，以及往前（dir = -1）/往后（dir = 1）第 steps 张（默认 1）。 */
export interface ViewerNav {
	item: TimelineItem | undefined;
	neighbor: (dir: -1 | 1, steps?: number) => Promise<Neighbor | null>;
}

/** 时间线：在月份内找前后，跨月时自动加载相邻月份。 */
export function timelineNav(qc: QueryClient, id: string, month: string): ViewerNav {
	return {
		item: findItem(qc, id, month),
		neighbor: async (dir, steps = 1) => {
			let n = await neighbor(qc, id, month, dir);
			for (let k = 1; k < steps && n; k++) n = await neighbor(qc, n.id, n.month!, dir);
			return n;
		},
	};
}

/** 列表：在已加载的条目里找；到末尾时加载下一页再找。 */
export function listNav(
	id: string,
	items: TimelineItem[],
	loadMore: (() => Promise<TimelineItem[]>) | null,
): ViewerNav {
	return {
		item: items.find((it) => it[0] === id),
		neighbor: async (dir, steps = 1) => {
			let list = items;
			let i = list.findIndex((it) => it[0] === id);
			if (i < 0) return null;
			if (dir === 1 && i + steps >= list.length && loadMore) {
				list = await loadMore();
				i = list.findIndex((it) => it[0] === id);
			}
			const it = list[i + dir * steps];
			return it ? { id: it[0], item: it } : null;
		},
	};
}

export async function neighbor(qc: QueryClient, id: string, month: string, dir: -1 | 1): Promise<Neighbor | null> {
	const items = await qc.ensureQueryData(monthQuery(month));
	const i = items.findIndex((it) => it[0] === id);
	const j = i + dir;
	if (i >= 0 && j >= 0 && j < items.length) return { id: items[j]![0], month, item: items[j]! };

	const buckets: Bucket[] = await qc.ensureQueryData(bucketsQuery);
	let b = buckets.findIndex((x) => x.month === month) + dir;
	while (b >= 0 && b < buckets.length) {
		const other = await qc.ensureQueryData(monthQuery(buckets[b]!.month));
		if (other.length) {
			const it = dir === 1 ? other[0]! : other[other.length - 1]!;
			return { id: it[0], month: buckets[b]!.month, item: it };
		}
		b += dir;
	}
	return null;
}

export function findItem(qc: QueryClient, id: string, month: string): TimelineItem | undefined {
	return qc.getQueryData<TimelineItem[]>(monthQuery(month).queryKey)?.find((it) => it[0] === id);
}
