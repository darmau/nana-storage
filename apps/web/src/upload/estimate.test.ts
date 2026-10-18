import { describe, expect, it } from "vitest";
import { containerCost, PRICING } from "@nana/shared";
import { estimateUpload, SUGGEST_DEVICE_USD } from "./estimate";

const photos = (n: number) => Array.from({ length: n }, () => ({ kind: "photo" as const, bytes: 3e6 }));
const fresh = { month: { containerSeconds: 0, jobs: 0 }, monthCostUsd: 0, budgetUsd: 10 };

describe("estimateUpload", () => {
	it("is free while the batch fits in the remaining free allowance", () => {
		const e = estimateUpload({ ...fresh, items: photos(100) });
		expect(e.seconds).toBe(800);
		expect(e.costUsd).toBe(0);
		expect(e.perJobSeconds).toBeNull();
		expect(e.suggestDevice).toBe(false);
	});

	it("charges only what goes beyond the free allowance already used this month", () => {
		const used = PRICING.containers.includedVcpuSeconds; // CPU 的免费额度已经用完
		const e = estimateUpload({ ...fresh, month: { containerSeconds: used, jobs: 10 }, items: photos(10) });
		expect(e.costUsd).toBeCloseTo(containerCost(used + 80) - containerCost(used));
		expect(e.costUsd).toBeGreaterThan(0);
	});

	it("uses this month's real average once there is enough history", () => {
		const e = estimateUpload({ ...fresh, month: { containerSeconds: 1200, jobs: 100 }, items: [{ kind: "video", bytes: 5e8 }, ...photos(9)] });
		expect(e.perJobSeconds).toBe(12);
		expect(e.seconds).toBe(120);
	});

	it("estimates videos by size when there is no history", () => {
		const small = estimateUpload({ ...fresh, items: [{ kind: "video", bytes: 10 * 1024 ** 2 }] });
		const huge = estimateUpload({ ...fresh, items: [{ kind: "video", bytes: 50 * 1024 ** 3 }] });
		expect(small.seconds).toBe(30);
		// 超过转码上限的不转码，不会无限增长
		expect(huge.seconds).toBeLessThan(15 + 2048 * 1.5 + 1);
	});

	it("suggests device processing for large batches and warns before the monthly budget", () => {
		const big = estimateUpload({ ...fresh, items: photos(50_000) });
		expect(big.costUsd).toBeGreaterThanOrEqual(SUGGEST_DEVICE_USD);
		expect(big.suggestDevice).toBe(true);
		const tight = estimateUpload({ ...fresh, monthCostUsd: 9.99, items: photos(50_000) });
		expect(tight.overBudget).toBe(true);
		expect(estimateUpload({ ...fresh, monthCostUsd: 10, items: [] }).overBudget).toBe(false);
	});
});
