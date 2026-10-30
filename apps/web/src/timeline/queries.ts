import { api } from "../api";
import type { Bucket, TimelineItem } from "./types";

export const bucketsQuery = { queryKey: ["timeline", "buckets"], queryFn: () => api<Bucket[]>("/timeline/buckets") };

export const monthQuery = (month: string) => ({
	queryKey: ["timeline", "month", month],
	queryFn: () => api<TimelineItem[]>(`/timeline/month/${month}`),
	// 离开视口的月份 10 分钟后从内存里释放（最新的几个月会存进 IndexedDB，见 library/persist.ts）
	gcTime: 10 * 60_000,
	staleTime: 5 * 60_000,
});
