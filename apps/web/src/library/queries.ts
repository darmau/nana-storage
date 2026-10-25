import { SMART_SET_CONFLICT, type SmartSetLevel, type SmartSetMetrics, type StorageSummary } from "@nana/shared";
import { api } from "../api";
import type { Bucket, TimelineItem } from "../timeline/types";

export interface Page {
	items: TimelineItem[];
	next: number | null;
	/** 只在第一页、而且不止一页时有：整个列表的每月张数（拖动条用） */
	months?: Bucket[];
	/** 只有列表视图（?view=list）有，和 items 一一对应 */
	details?: ItemDetail[];
	/** 只有主题的样本列表有，和 items 一一对应：[标签 1 正例 / -1 反例, 上次训练时的分数] */
	marks?: [1 | -1, number | null][];
	/** 主题的建议、相似照片：和 items 一一对应的分数 */
	scores?: number[];
}
/** 列表视图每行的信息：[原始文件名, 原件总字节数, 拍摄时间（UTC 毫秒）, 时区偏移, 上传时间]，与 worker 的 ItemDetail 一致 */
export type ItemDetail = [string | null, number, number | null, number | null, number];
export interface FolderChild {
	id: string;
	name: string;
	count: number;
	subfolders: number;
	/** 整棵子树里原件的总字节数 */
	size: number;
	/** 上次修改（UTC 毫秒）：子树里可见条目最近一次变化，没有照片时是创建时间 */
	modified: number;
	/** 九宫格封面，最近拍的最多 9 张（"id:rev"） */
	covers: string[];
}
export interface UnfinishedAsset {
	id: string;
	state: "processing" | "failed" | "abandoned";
	/** 条目里的原始文件名（Live Photo / RAW+JPEG 有多个） */
	names: string[];
}
export interface FolderInfo {
	path: { id: string; name: string; parent_id: string | null }[];
	children: FolderChild[];
}
/** 文件夹里还没处理完的条目，单独请求：文件夹详情带 ETag，这部分和时间有关、上传处理中一直在变。 */
export interface FolderUnfinished {
	items: UnfinishedAsset[];
	/** 子文件夹 id → 整棵子树里还没处理完（上传中、处理中、失败）的条目数，列表里看不到，但删除文件夹时算在内 */
	children: Record<string, number>;
}
export interface AlbumSummary {
	id: string;
	name: string;
	count: number;
	/** 照片（包括 Live Photo）和视频的张数，加起来等于 count */
	photos: number;
	videos: number;
	cover: string | null;
	/** 卡片上的小图（"id:rev"），按固定的伪随机顺序，最多 10 张，可能包含封面 */
	samples: string[];
	updated_at: number;
}

/** 列表的数据源：key 用于缓存，path 是分页接口。 */
export interface ListSource {
	key: readonly unknown[];
	path: string;
}

export const listQuery = (src: ListSource) => ({
	queryKey: ["list", ...src.key],
	queryFn: ({ pageParam }: { pageParam: number }) =>
		api<Page>(`${src.path}${src.path.includes("?") ? "&" : "?"}offset=${pageParam}`),
	initialPageParam: 0,
	getNextPageParam: (last: Page) => last.next ?? undefined,
});

export const folderQuery = (id: string) => ({
	queryKey: ["folders", id],
	queryFn: () => api<FolderInfo>(`/folders/${id}`),
});
export const folderUnfinishedQuery = (id: string) => ({
	queryKey: ["folders", id, "unfinished"],
	queryFn: () => api<FolderUnfinished>(`/folders/${id}/unfinished`),
});
export const albumsQuery = { queryKey: ["albums"], queryFn: () => api<AlbumSummary[]>("/albums") };

/** cover 字段是 "id:rev" */
export const coverUrl = (cover: string | null) => {
	if (!cover) return null;
	const [id, rev] = cover.split(":");
	return `/api/a/${id}/thumb?v=${rev}`;
};

// ------------------------------------------------------------------ 相同 / 相似照片

export interface SmartSetSummary {
	id: string;
	name: string;
	/** 正例 / 反例的张数 */
	positives: number;
	negatives: number;
	/** “标准”灵敏度下的建议数（指定了范围时只算范围里的）；结果 = in_scope + 建议 */
	matches: number;
	/** 指定了文件夹范围 */
	scoped: boolean;
	/** 范围里的正例数（没有范围时等于 positives） */
	in_scope: number;
	cover: string | null;
	updated_at: number;
	/** 标记改过（或者从没训练过），需要“更新” */
	dirty: boolean;
	refreshing: boolean;
}
/** GET /api/smart-sets/:id */
export interface SmartSetDetail extends SmartSetSummary {
	trained_at: number | null;
	/** 标签和分类器矛盾的样本数 */
	conflicts: number;
	/** 上次训练之后新标（或改了标签）的样本数 */
	changed: number;
	metrics: SmartSetMetrics | null;
	/** 范围的根文件夹（含子文件夹；已删除的不在里面），null 表示整个资料库 */
	folders: { id: string; name: string }[] | null;
	/** 每档灵敏度的建议数（不含正例） */
	suggestions: Record<SmartSetLevel, number>;
	/** 实测准确率：标记时正好在建议里、分数达到这一档的样本数，和其中标成正例的 */
	reviewed: Record<SmartSetLevel, { n: number; yes: number }>;
}
/** 样本的标签和分数矛盾：分类器认不出来的正例，或者它很确定的反例（和服务端的 SMART_SET_CONFLICT 一致）。 */
export const sampleConflict = (label: 1 | -1, score: number | null) =>
	score !== null && (label > 0 ? score < SMART_SET_CONFLICT.positiveBelow : score >= SMART_SET_CONFLICT.negativeFrom);
export interface DuplicateGroups {
	groups: { keep: string; items: TimelineItem[] }[];
	total: number;
	next: number | null;
	scanned: number;
	truncated: boolean;
}
export const smartSetsQuery = {
	queryKey: ["smart-sets"],
	queryFn: async () => (await api<{ items: SmartSetSummary[] }>("/smart-sets")).items,
};
/** 侧边栏底部 / 资料库首页的存储空间统计（服务端只读一行计数）。资料库数据变化时随 invalidateLibrary() 刷新，不轮询。 */
export const storageSummaryQuery = {
	queryKey: ["storage-summary"],
	queryFn: () => api<StorageSummary>("/stats/summary"),
	staleTime: 5 * 60_000,
};
