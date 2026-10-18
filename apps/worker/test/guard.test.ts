import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	containerCost,
	DEFAULT_MONTHLY_BUDGET_USD,
	DEFAULT_PROCESSORS,
	MAX_MONTHLY_BUDGET_USD,
	MAX_PROCESS_PER_ASSET_PER_HOUR,
	MAX_RETRIES_PER_ASSET_PER_HOUR,
	PROCESSOR_POOL_SIZE,
} from "@nana/shared";
import { guardStub } from "../src/guard";

describe("UsageGuard", () => {
	beforeEach(async () => {
		await guardStub(env).reset();
		await env.KV.delete("guard:limits-override");
	});

	it("does not limit daily jobs, container time or uploads", async () => {
		const guard = guardStub(env);
		for (let i = 0; i < 50; i++) expect((await guard.reserveJob(`d${i}`)).ok).toBe(true);
		await guard.recordContainer(3 * 3600);
		expect(await guard.reserveUpload(500 * 1024 ** 3)).toBe(true);
		expect(await guard.isTripped()).toBe(false);
		const status = await guard.status();
		expect(status.usage.jobs).toBeGreaterThanOrEqual(50);
		expect(status.month.containerSeconds).toBeGreaterThanOrEqual(3 * 3600);
		expect(status.budgetUsd).toBe(DEFAULT_MONTHLY_BUDGET_USD);
	});

	it("trips when this month's estimated container cost reaches the budget, and stays tripped", async () => {
		const guard = guardStub(env);
		// 先用掉免费额度，之后每秒都计费
		await guard.recordContainer(6 * 3600);
		const before = (await guard.status()).monthCostUsd;
		expect(before).toBeGreaterThan(0);
		await guard.setBudget(before + 0.05);
		await guard.recordContainer(60);
		expect(await guard.isTripped()).toBe(false);
		expect(await guard.overBudget()).toBe(false);
		await guard.recordContainer(3600);
		expect(await guard.isTripped()).toBe(true);
		expect(await guard.overBudget()).toBe(true);
		const status = await guard.status();
		expect(status.trippedReason).toContain("budget");
		expect(status.monthCostUsd).toBeCloseTo(containerCost(status.month.containerSeconds));
		// 熔断后一律拒绝；调高上限也不会自动恢复
		await guard.setBudget(DEFAULT_MONTHLY_BUDGET_USD);
		expect(await guard.reserveJob("b1")).toEqual({ ok: false, reason: "tripped" });
		expect(await guard.reserveUpload(1)).toBe(false);
		await guard.reset();
		expect((await guard.reserveJob("b2")).ok).toBe(true);
	});

	it("refuses a job when the budget is already used up", async () => {
		const guard = guardStub(env);
		await guard.recordContainer(6 * 3600);
		await guard.setBudget((await guard.status()).monthCostUsd);
		await guard.reset();
		expect(await guard.reserveJob("c1")).toEqual({ ok: false, reason: "budget" });
		expect(await guard.isTripped()).toBe(true);
		await guard.setBudget(DEFAULT_MONTHLY_BUDGET_USD);
	});

	it("caps the budget", async () => {
		const guard = guardStub(env);
		await guard.setBudget(1e9);
		expect((await guard.status()).budgetUsd).toBe(MAX_MONTHLY_BUDGET_USD);
		await guard.setBudget(-1);
		expect((await guard.status()).budgetUsd).toBe(MAX_MONTHLY_BUDGET_USD);
		await guard.setBudget(DEFAULT_MONTHLY_BUDGET_USD);
	});

	it("detects an asset being processed in a loop", async () => {
		const guard = guardStub(env);
		for (let i = 0; i < MAX_PROCESS_PER_ASSET_PER_HOUR; i++) {
			expect((await guard.reserveJob("same")).ok).toBe(true);
		}
		expect(await guard.reserveJob("same")).toEqual({ ok: false, reason: "loop" });
		expect(await guard.isTripped()).toBe(true);
		expect((await guard.status()).trippedAssetId).toBe("same");
		await guard.reset();
		expect((await guard.status()).trippedAssetId).toBeNull();
	});

	it("allows many user-triggered runs but few automatic retries", async () => {
		const guard = guardStub(env);
		// 旋转、加载原图这些新任务不按重试的上限算
		for (let i = 0; i < MAX_RETRIES_PER_ASSET_PER_HOUR + 2; i++) expect((await guard.reserveJob("rot")).ok).toBe(true);
		for (let i = 0; i < MAX_RETRIES_PER_ASSET_PER_HOUR; i++) expect((await guard.reserveJob("retry", true)).ok).toBe(true);
		// 新任务仍然可以跑，再一次自动重试就熔断
		expect((await guard.reserveJob("retry")).ok).toBe(true);
		expect(await guard.reserveJob("retry", true)).toEqual({ ok: false, reason: "loop" });
		const s = await guard.status();
		expect(s.trippedAssetId).toBe("retry");
		expect(s.trippedReason).toMatch(/^asset retry retried 7 times/);
		await guard.reset();
	});

	it("reads the asset of a trip recorded before trippedAssetId existed", async () => {
		const guard = guardStub(env);
		await guard.trip("asset OLD1 processed 7 times within an hour (possible loop)");
		expect((await guard.status()).trippedAssetId).toBe("OLD1");
		await guard.reset();
		await guard.trip("manual");
		expect((await guard.status()).trippedAssetId).toBeNull();
		await guard.reset();
	});

	it("reset() clears the trip", async () => {
		const guard = guardStub(env);
		await guard.trip("manual");
		expect(await guard.isTripped()).toBe(true);
		await guard.reset();
		expect(await guard.isTripped()).toBe(false);
	});

	it("caps processor overrides at 7 days", async () => {
		const guard = guardStub(env);
		await guard.setProcessorsOverride(8, 365 * 24 * 3600_000);
		const raw = await env.KV.get<{ expiresAt: number }>("guard:limits-override", "json");
		expect(raw!.expiresAt - Date.now()).toBeLessThanOrEqual(7 * 24 * 3600_000 + 1000);
	});

	it("ignores retired daily-limit fields in an old override record", async () => {
		await env.KV.put("guard:limits-override", JSON.stringify({ limits: { jobs: 1, containerSeconds: 1 }, expiresAt: Date.now() + 3600_000 }));
		const guard = guardStub(env);
		expect((await guard.status()).processors).toBe(DEFAULT_PROCESSORS);
		expect((await guard.reserveJob("old")).ok).toBe(true);
		expect(await guard.isTripped()).toBe(false);
	});

	it("reports an active override and can end it early without dropping the record", async () => {
		const guard = guardStub(env);
		expect((await guard.status()).overrideExpiresAt).toBeNull();
		await guard.setProcessorsOverride(8, 3600_000);
		const raised = await guard.status();
		expect(raised.processors).toBe(8);
		expect(raised.overrideExpiresAt).toBeGreaterThan(Date.now());
		await guard.clearProcessorsOverride();
		const after = await guard.status();
		expect(after.overrideExpiresAt).toBeNull();
		expect(after.processors).toBe(DEFAULT_PROCESSORS);
	});

	describe("container slots", () => {
		const leases: string[] = [];
		const take = async (waitMs = 0) => {
			const g = await guardStub(env).acquireSlot(waitMs);
			if (g.ok) leases.push(g.lease);
			return g;
		};
		beforeEach(async () => {
			for (const l of leases.splice(0)) await guardStub(env).releaseSlot(l);
		});

		it("hands out distinct slots up to the default processor count, then reports busy", async () => {
			const slots = [];
			for (let i = 0; i < DEFAULT_PROCESSORS; i++) {
				const g = await take();
				expect(g.ok).toBe(true);
				if (g.ok) slots.push(g.slot);
			}
			expect(new Set(slots).size).toBe(DEFAULT_PROCESSORS);
			expect(Math.max(...slots)).toBe(DEFAULT_PROCESSORS - 1);
			expect(await take(50)).toEqual({ ok: false, reason: "busy" });
			expect((await guardStub(env).status()).busySlots).toBe(DEFAULT_PROCESSORS);
		});

		it("wakes a waiter as soon as a slot is released", async () => {
			for (let i = 0; i < DEFAULT_PROCESSORS; i++) await take();
			const waiting = take(10_000);
			const released = leases.shift()!;
			await guardStub(env).releaseSlot(released);
			const g = await waiting;
			expect(g.ok).toBe(true);
		});

		it("raising the processor count admits waiters, capped at the pool size", async () => {
			for (let i = 0; i < DEFAULT_PROCESSORS; i++) await take();
			const waiting = take(10_000);
			await guardStub(env).setProcessorsOverride(1000, 3600_000);
			const g = await waiting;
			expect(g.ok && g.slot).toBe(DEFAULT_PROCESSORS);
			expect((await guardStub(env).status()).processors).toBe(PROCESSOR_POOL_SIZE);
		});

		it("tripping releases waiters without granting a slot", async () => {
			for (let i = 0; i < DEFAULT_PROCESSORS; i++) await take();
			const waiting = take(10_000);
			await guardStub(env).trip("test");
			expect(await waiting).toEqual({ ok: false, reason: "tripped" });
			expect(await take()).toEqual({ ok: false, reason: "tripped" });
		});
	});
});
