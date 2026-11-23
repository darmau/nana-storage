import { api } from "../api";
import { stacksEnabled } from "../ui/stacks";
import type { Bucket, TimelineItem } from "./types";

// 关掉折叠时带 ?stacks=0（两种模式是不同的缓存条目；切换时 setStacksEnabled 会失效重取）
const stacksParam = () => (stacksEnabled() ? "" : "?stacks=0");

export const bucketsQuery = { queryKey: ["timeline", "buckets"], queryFn: () => api<Bucket[]>(`/timeline/buckets${stacksParam()}`) };

export const monthQuery = (month: string) => ({
	queryKey: ["timeline", "month", month],
	queryFn: () => api<TimelineItem[]>(`/timeline/month/${month}${stacksParam()}`),
	// 离开视口的月份 10 分钟后从内存里释放（最新的几个月会存进 IndexedDB，见 library/persist.ts）
	gcTime: 10 * 60_000,
	staleTime: 5 * 60_000,
});

/** 相似照片组的成员（点击展开时按需取）。组不超过 STACK_MAX_MEMBERS 张，一页就够。 */
export const stackQuery = (stackId: string, day: string | null) => ({
	queryKey: ["stack", stackId, day],
	queryFn: () => api<{ items: TimelineItem[]; next: number | null }>(`/stacks/${stackId}/assets${day ? `?day=${day}` : ""}`),
	gcTime: 10 * 60_000,
	staleTime: 5 * 60_000,
});
