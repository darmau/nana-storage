import { containerCost, MAX_TRANSCODE_BYTES } from "@nana/shared";

/**
 * 上传面板的容器费用估算（只是提醒，不限制）：这一批照片处理完大约要多少容器时间、本月要多付多少钱。
 * 每个任务的时间优先用本月的实际平均值（UsageGuard 记的容器时长 / 任务数），任务太少时用下面的粗略默认值。
 * 费用是 containerCost() 的增量，已经扣掉本月剩下的免费额度，和月度上限用的是同一个算法。
 */

/** 本月任务少于这么多时，平均值不可靠，用默认值。 */
const MIN_HISTORY_JOBS = 50;
/** 默认值：一张照片（缩略图、预览、指纹、人脸）的容器秒数。 */
const PHOTO_SECONDS = 8;
/** 默认值：视频按大小粗算（读元数据 + 转码 H.264），超过 MAX_TRANSCODE_BYTES 的不转码。 */
const VIDEO_BASE_SECONDS = 15;
const VIDEO_SECONDS_PER_MB = 1.5;
/** 加起来超过这么多钱，或者会超过月度上限时，建议用设备端处理。 */
export const SUGGEST_DEVICE_USD = 1;

export interface EstimateInput {
	items: { kind: "photo" | "live" | "video"; bytes: number }[];
	month: { containerSeconds: number; jobs: number };
	monthCostUsd: number;
	budgetUsd: number;
}

export interface Estimate {
	seconds: number;
	/** 这一批增加的估算费用（扣掉本月剩下的免费额度）。 */
	costUsd: number;
	/** 按本月的实际平均值估算时，每个任务的秒数；用默认值时为 null。 */
	perJobSeconds: number | null;
	/** 处理完这一批后，本月估算费用会达到月度上限（处理会在中途暂停）。 */
	overBudget: boolean;
	suggestDevice: boolean;
}

export function estimateUpload({ items, month, monthCostUsd, budgetUsd }: EstimateInput): Estimate {
	const perJob = month.jobs >= MIN_HISTORY_JOBS ? month.containerSeconds / month.jobs : null;
	let seconds = 0;
	for (const it of items) {
		if (perJob !== null) seconds += perJob;
		else if (it.kind === "video") seconds += VIDEO_BASE_SECONDS + (Math.min(it.bytes, MAX_TRANSCODE_BYTES) / 1024 ** 2) * VIDEO_SECONDS_PER_MB;
		else seconds += PHOTO_SECONDS;
	}
	const costUsd = containerCost(month.containerSeconds + seconds) - containerCost(month.containerSeconds);
	const overBudget = items.length > 0 && monthCostUsd + costUsd >= budgetUsd;
	return { seconds, costUsd, perJobSeconds: perJob, overBudget, suggestDevice: overBudget || costUsd >= SUGGEST_DEVICE_USD };
}
