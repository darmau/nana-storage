/**
 * 与 worker 的 /api/timeline/month 返回值一致：[id, w, h, kind, localDay, durationMs, favorite, rev, burst?, stackId?]
 * burst 只在时间线里出现：这张是一组连拍（或相似照片）的封面，值是整组的 id（包括它自己）。
 * stackId 只有相似照片组才有（连拍没有）：格子显示 +N，点击在原地展开。
 */
export type TimelineItem = [string, number, number, 0 | 1 | 2, string | null, number | null, 0 | 1, number, string[]?, string?];

/** 一个格子代表的所有照片：连拍 / 相似照片封面是整组，其他就是自己。 */
export const idsOf = (it: TimelineItem): string[] => it[8] ?? [it[0]];
/** 相似照片组的 id（连拍和单张没有）。 */
export const stackOf = (it: TimelineItem): string | undefined => it[9];
export interface Bucket {
	month: string;
	count: number;
}
export const KIND_VIDEO = 1;
export const KIND_LIVE = 2;

export const thumbUrl = (id: string, rev: number) => `/api/a/${id}/thumb?v=${rev}`;
export const previewUrl = (id: string, rev: number) => `/api/a/${id}/preview?v=${rev}`;
