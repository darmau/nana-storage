import type { QueryClient } from "@tanstack/react-query";
import { isExpanded } from "./expand";
import { monthQuery, stackQuery } from "./queries";
import type { TimelineItem } from "./types";

/**
 * 一个月的“有效列表”：展开的组换成它的成员（拍摄时间从新到旧，和周围一致），其余照旧。
 * 成员数据按需取（stackQuery）；查看器导航和 Shift 范围选择都用它，展开的成员才能被逐张走到 / 选到。
 */
export async function effectiveMonthItems(qc: QueryClient, month: string): Promise<TimelineItem[]> {
	const items = await qc.ensureQueryData(monthQuery(month));
	let out: TimelineItem[] | null = null;
	for (let i = 0; i < items.length; i++) {
		const it = items[i]!;
		const sid = it[9];
		let members: TimelineItem[] | null = null;
		if (sid && isExpanded(sid)) {
			try {
				const res = await qc.ensureQueryData(stackQuery(sid, it[4]));
				// 成员都不可见了（缓存过期的竞态）或请求失败：保持封面，等数据刷新
				if (res.items.length) members = [...res.items].reverse();
			} catch {
				members = null;
			}
		}
		if (members) (out ??= items.slice(0, i)).push(...members);
		else if (out) out.push(it);
	}
	return out ?? items;
}

/** 同步版（查看器打开时找当前条目）：成员数据没缓存就退回封面列表。 */
export function findEffectiveItem(qc: QueryClient, id: string, month: string): TimelineItem | undefined {
	const items = qc.getQueryData<TimelineItem[]>(monthQuery(month).queryKey);
	if (!items) return undefined;
	for (const it of items) {
		if (it[0] === id) return it;
		const sid = it[9];
		if (sid && isExpanded(sid)) {
			const res = qc.getQueryData<{ items: TimelineItem[] }>(stackQuery(sid, it[4]).queryKey);
			const m = res?.items.find((x) => x[0] === id);
			if (m) return m;
		}
	}
	return undefined;
}
