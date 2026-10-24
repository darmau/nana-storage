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

/** compress：原图压缩（src/compress.ts），1 次容器调用，不改缩略图和预览。 */
export type JobKind = "process" | "rotate" | "compress";

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

/** UsageGuard 记的一天的用量（UTC 日期）。 */
export interface UsageDay {
	day: string;
	containerSeconds: number;
	jobs: number;
	uploadBytes: number;
}

/** GET /api/stats/summary：侧边栏底部的存储空间统计。 */
export interface StorageSummary {
	/** asset_files 里所有文件（原图、RAW、Live 视频、缩略图、预览……，包括回收站）的字节数 */
	bytes: number;
	/** 处理好的、不在回收站的照片（包括 Live Photo）和视频 */
	photos: number;
	videos: number;
}

export interface UsageStats {
	now: number;
	/** 本月第一天 00:00 UTC。 */
	monthStart: number;
	library: { photo: number; video: number; live: number; processing: number; failed: number; trash: number };
	storage: {
		/** 不在回收站里的条目的文件，按角色。 */
		roles: Partial<Record<FileRole, { files: number; bytes: number }>>;
		trash: { files: number; bytes: number };
		/** 还没完成的分块上传（R2 照样按已传的部分计费，这里按声明的总大小算，是上限）。 */
		uploads: { files: number; bytes: number };
		d1Bytes: number | null;
		/** 已写进 Vectorize 的向量数。 */
		vectors: number;
	};
	/** 按上传月份（UTC），最近 12 个月，只算原件。 */
	growth: { month: string; assets: number; bytes: number }[];
	/** UsageGuard 的每日记账（UTC 日期）。 */
	days: UsageDay[];
	month: { containerSeconds: number; jobs: number; uploadBytes: number };
}


/**
 * GET /api/stats/library：资料库统计的快照（每天 Cron 统计一次，存在 library_stats）。
 * 只算处理好的、不在回收站的条目；连拍逐张计数；日期是拍摄地的本地日期。
 */
export interface LibraryStats {
	computedAt: number;
	/** 最近 LIBRARY_STATS_DAYS 天里每天拍的张数，[YYYY-MM-DD, 张数]，按日期升序，没有照片的日子不列 */
	days: [string, number][];
	/** 所有时间每月拍的张数，[YYYY-MM, 张数]，按月份升序 */
	months: [string, number][];
	/** 没有拍摄时间的张数（不在上面两组里） */
	noDate: number;
	/** 拍摄设备（EXIF 的 Make + Model），按张数降序，最多 LIBRARY_STATS_CAMERAS 个 */
	cameras: { camera: string; photos: number; videos: number }[];
	/** 没有设备信息的张数（截图、下载的图片、去掉了 EXIF 的） */
	unknownCamera: { photos: number; videos: number };
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
