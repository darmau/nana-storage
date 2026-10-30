export type AssetKind = "photo" | "video" | "live";
export type AssetStatus = "uploading" | "pending" | "processing" | "ready" | "failed";
export type FileRole =
	| "original"
	| "raw"
	| "live_video"
	| "thumb"
	| "preview"
	| "poster"
	| "video_preview";

/**
 * compress：原图压缩（src/compress.ts），1 次容器调用，不改缩略图和预览。
 * compose：拼接 / 切割生成的新照片（src/compose.ts），1 次 compose（生成原件）+ 1 次 derive。
 */
export type JobKind = "process" | "rotate" | "compress" | "compose";

/** 拼接 / 切割的方向：vertical 上下排列（纵向拼接、横着切），horizontal 左右排列。 */
export type ComposeDirection = "vertical" | "horizontal";

/** 队列消息只携带任务 ID，真实状态在 D1 的 jobs 表里。 */
export interface JobMessage {
	jobId: string;
}

export type GuardMetric = "containerSeconds" | "jobs" | "uploadBytes";

export interface GuardStatus {
	day: string;
	tripped: boolean;
	trippedReason: string | null;
	trippedAt: number | null;
	/** 因为同一条目一小时内反复处理而熔断时，是哪一个条目；其他原因为 null。 */
	trippedAssetId: string | null;
	/** 今天（UTC）的用量，只记账，不限制。 */
	usage: Record<GuardMetric, number>;
	/** 本月（UTC 自然月）到目前为止的用量。 */
	month: Record<GuardMetric, number>;
	/** 本月容器的估算超额费用（containerCost）。达到 budgetUsd 就熔断。 */
	monthCostUsd: number;
	budgetUsd: number;
	/** 现在允许同时运行的容器数。 */
	processors: number;
	/** 当前被占用的容器槽位数。 */
	busySlots: number;
	/** 临时调高的容器数还在生效时，它的到期时间；否则为 null（processors 就是默认值）。 */
	overrideExpiresAt: number | null;
	/** 设备端处理的租约还有效时，设备名和到期时间；否则为 null。 */
	device: DeviceLease | null;
}

export interface DeviceLease {
	name: string;
	until: number;
}

/** assets.traits 的位标志：处理时根据元数据识别出来的照片类型。 */
export const TRAIT = { panorama: 1, longExposure: 2, portrait: 4, raw: 8 } as const;
export type TraitName = keyof typeof TRAIT;

/**
 * 列表的类型筛选（文件夹 / 相册的筛选条，搜索的 type 参数）：前三个是媒体类型（assets.kind），
 * 后面是照片类型（连拍看 burst_id，其余看 traits）。
 */
export const ASSET_TYPES = ["photo", "video", "live", "burst", "panorama", "long-exposure", "portrait", "raw"] as const;
export type AssetType = (typeof ASSET_TYPES)[number];

/** GET /api/stats/summary：侧边栏底部的存储空间统计。 */
export interface StorageSummary {
	/** asset_files 里所有文件（原图、RAW、Live 视频、缩略图、预览……，包括回收站）的字节数 */
	bytes: number;
	/** 处理好的、不在回收站的照片（包括 Live Photo）和视频 */
	photos: number;
	videos: number;
}

/** 主题的灵敏度档位（SMART_SET_SENSITIVITY 的键）。 */
export type SmartSetLevel = "strict" | "normal" | "loose";

/** 主题分类器上次训练的质量指标（smart_sets.metrics，GET /api/smart-sets/:id 原样返回）。 */
export interface SmartSetMetrics {
	/** 训练用到的正例 / 反例数（有指纹的） */
	positives: number;
	negatives: number;
	/**
	 * 交叉验证：每档灵敏度下，正例被认出来的比例（recall）、反例被排除的比例（rejection），0–1。
	 * 正例或反例少于 SMART_SET_CV_MIN 张时为 null。
	 */
	cv: { recall: Record<SmartSetLevel, number>; rejection: Record<SmartSetLevel, number> } | null;
}
