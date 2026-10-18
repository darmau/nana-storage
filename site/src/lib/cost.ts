// 官网和文档里的费用表：构建时按应用自己的单价（packages/shared/src/pricing.ts）算，价格变了重新构建即可。
// 只算应用能估算的项（和应用的“统计数据 › 费用”一致），请求数、R2 操作、D1 读写行数在免费额度内，不算。
import { PRICING, containerCost } from "../../../packages/shared/src/pricing.ts";

/** 估算假设，写在表格下方。 */
export const ASSUME = {
	/** 平均每张原件（手机 HEIC / JPEG 混合）。 */
	originalMb: 4,
	/** 缩略图 + 长边 3840 的预览（WebP）。 */
	derivedMb: 0.9,
	/** 每张照片的容器时间，和上传面板的默认估算相同（apps/web/src/upload/estimate.ts 的 PHOTO_SECONDS）。 */
	containerSeconds: 8,
	/** 每张照片的向量：1 个 CLIP（512 维）+ 平均 1 张脸（512 维）。 */
	dimsPerPhoto: 1024,
} as const;

const GB = 1024;

export interface Scenario {
	photos: number;
	storageGb: number;
	monthly: { plan: number; r2: number; vectorize: number; total: number };
	/** 一次性导入：这么多照片在同一个月里由云端容器处理。 */
	importCost: number;
	importHours: number;
}

export function scenario(photos: number): Scenario {
	const storageGb = (photos * (ASSUME.originalMb + ASSUME.derivedMb)) / GB;
	const plan = PRICING.workersPaidMonthly;
	const r2 = Math.max(0, storageGb - PRICING.r2.includedGb) * PRICING.r2.perGbMonth;
	const dims = photos * ASSUME.dimsPerPhoto;
	const vectorize =
		(Math.max(0, dims - PRICING.vectorize.includedStoredDims) / 1e8) * PRICING.vectorize.perHundredMillionStoredDims;
	const seconds = photos * ASSUME.containerSeconds;
	return {
		photos,
		storageGb,
		monthly: { plan, r2, vectorize, total: plan + r2 + vectorize },
		importCost: containerCost(seconds),
		importHours: seconds / 3600,
	};
}

export const SCENARIOS = [1_000, 10_000, 50_000].map(scenario);

export const usd = (n: number) => (n < 0.01 && n > 0 ? "< $0.01" : `$${n.toFixed(2)}`);

export { PRICING };
export { DEFAULT_MONTHLY_BUDGET_USD, DEFAULT_PROCESSORS, MAX_JOB_ATTEMPTS } from "../../../packages/shared/src/limits.ts";
