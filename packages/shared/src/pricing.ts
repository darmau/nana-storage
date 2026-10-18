/**
 * Cloudflare 单价和 Workers Paid 套餐每月的免费额度（2026-10 的定价页面），用来在“使用统计”页估算费用，UsageGuard 的月度费用上限也按这里的容器单价算（containerCost）。
 * 实际账单以 Cloudflare 后台为准：按账单周期计费，免费额度是整个账户共享的。价格变了就改这里。
 * GB 按 2^30 字节算，和界面上显示的容量一致（如果 Cloudflare 按 10^9 算，实际会多几个百分点，金额上只差几美分）。
 */
export const PRICING = {
	workersPaidMonthly: 5,
	r2: { includedGb: 10, perGbMonth: 0.015 },
	d1: { includedGb: 5, perGbMonth: 0.75 },
	vectorize: { includedStoredDims: 10e6, perHundredMillionStoredDims: 0.05 },
	/** 每条消息大约 3 次操作（写入、读取、确认）。 */
	queues: { includedOps: 1e6, perMillionOps: 0.4, opsPerMessage: 3 },
	/**
	 * 容器规格（processor.ts 按这里的数值启动，两边不会不一致）：自定义实例 1 vCPU、3 GiB 内存、12 GB 磁盘。
	 * 内存和磁盘按配置量计费，CPU 只按实际使用计费，这里按满载算（上限）。
	 * 3 GiB 是每 vCPU 允许的最小内存。原来的 standard-2 是 6 GiB，内存费用占一半以上，实测（2026-10，3 GiB 上限）
	 * HEIC / 6000 万像素全尺寸预览 / 4K HEVC 转码都正常，进程内存最多约 0.6 GiB，其余是可回收的文件缓存。
	 * 磁盘保持 12 GB：原件要整个写进容器（磁盘很便宜，每 GB 的单价是内存的 1/35）。
	 */
	containers: {
		vcpu: 1,
		memoryGib: 3,
		diskGb: 12,
		perVcpuSecond: 0.00002,
		perGibSecond: 0.0000025,
		perGbSecond: 0.00000007,
		includedVcpuSeconds: 375 * 60,
		includedGibSeconds: 25 * 3600,
		includedGbSeconds: 200 * 3600,
	},
} as const;

/**
 * 估算费用的输入：本月到目前为止的用量，只用应用自己能算出来的部分。请求数、R2 操作、D1 读写行数这类按次计费的项
 * 不估算（正常用量都在免费额度内，以 Cloudflare 后台为准）。拿不到的（D1 大小）传 null，对应的项不计费并标出来。
 */
export interface CostInput {
	/** R2 里本应用的字节数（原件 + 派生 + 回收站 + 未完成的上传）。 */
	r2Bytes: number;
	d1Bytes: number | null;
	containerSeconds: number;
	jobs: number;
	vectorDims: number;
}

export type CostUnit = "bytes" | "count" | "seconds" | "gibSeconds" | "gbSeconds";

/** 费用项。显示名称在前端的语言文件里（usage.costLines），按 key 取。 */
export type CostKey =
	| "plan"
	| "r2Storage"
	| "containerCpu"
	| "containerMemory"
	| "containerDisk"
	| "d1Storage"
	| "vectorize"
	| "queues";

export interface CostLine {
	key: CostKey;
	service: string;
	unit: CostUnit;
	/** null：没有数据（不计入合计）。 */
	used: number | null;
	included: number;
	cost: number | null;
}

const over = (used: number, included: number, price: number, per: number) => (Math.max(0, used - included) / per) * price;

/**
 * 容器运行 seconds 秒（所有容器加在一起）的估算超额费用，扣掉每月免费额度，CPU 按满载算（上限）。
 * UsageGuard 的月度上限和 estimateCost() 用的是同一个算法。
 */
export function containerCost(seconds: number): number {
	const C = PRICING.containers;
	return (
		over(seconds * C.vcpu, C.includedVcpuSeconds, C.perVcpuSecond, 1) +
		over(seconds * C.memoryGib, C.includedGibSeconds, C.perGibSecond, 1) +
		over(seconds * C.diskGb, C.includedGbSeconds, C.perGbSecond, 1)
	);
}

/** 按“本月到目前为止的用量”估算本月费用（存储按当前容量算一整个月）。 */
export function estimateCost(u: CostInput): { lines: CostLine[]; total: number; missing: boolean } {
	const P = PRICING;
	const GB = 1024 ** 3;
	const line = (
		key: CostKey,
		service: string,
		unit: CostUnit,
		used: number | null,
		included: number,
		price: number,
		per: number,
	): CostLine => ({ key, service, unit, used, included, cost: used === null ? null : over(used, included, price, per) });

	const s = u.containerSeconds;
	const C = P.containers;
	const lines: CostLine[] = [
		{ key: "plan", service: "Workers", unit: "count", used: null, included: 0, cost: P.workersPaidMonthly },
		line("r2Storage", "R2", "bytes", u.r2Bytes, P.r2.includedGb * GB, P.r2.perGbMonth, GB),
		line("containerCpu", "Containers", "seconds", s * C.vcpu, C.includedVcpuSeconds, C.perVcpuSecond, 1),
		line("containerMemory", "Containers", "gibSeconds", s * C.memoryGib, C.includedGibSeconds, C.perGibSecond, 1),
		line("containerDisk", "Containers", "gbSeconds", s * C.diskGb, C.includedGbSeconds, C.perGbSecond, 1),
		line("d1Storage", "D1", "bytes", u.d1Bytes, P.d1.includedGb * GB, P.d1.perGbMonth, GB),
		line("vectorize", "Vectorize", "count", u.vectorDims, P.vectorize.includedStoredDims, P.vectorize.perHundredMillionStoredDims, 1e8),
		line("queues", "Queues", "count", u.jobs * P.queues.opsPerMessage, P.queues.includedOps, P.queues.perMillionOps, 1e6),
	];
	return {
		lines,
		total: lines.reduce((acc, l) => acc + (l.cost ?? 0), 0),
		missing: lines.some((l) => l.cost === null),
	};
}
