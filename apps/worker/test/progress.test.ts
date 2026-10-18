import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { JOB_STALE_MS } from "@nana/shared";
import { assetJobs, failedJobs, jobsOverview, ulidTime } from "../src/progress";
import { CANCELLED_ERROR, cancelJobs, retryFailed } from "../src/jobs";
import { ulid } from "../src/ulid";

const now = Date.now();

async function job(n: number, status: string, opts: { created?: number; updated?: number; started?: number | null; attempts?: number } = {}) {
	const asset = `PRG${n}`;
	await env.DB.batch([
		env.DB.prepare("INSERT INTO assets (id, kind, status, created_at, updated_at) VALUES (?, 'photo', 'pending', 0, 0)").bind(asset),
		env.DB.prepare(
			`INSERT INTO asset_files (id, asset_id, role, r2_key, mime, size, original_name, created_at)
			 VALUES (?, ?, 'original', ?, 'image/jpeg', 100, ?, 0)`,
		).bind(`F${n}`, asset, `o/${asset}/F${n}`, `IMG_${n}.JPG`),
		env.DB.prepare("INSERT INTO jobs (id, asset_id, kind, status, attempts, started_at, updated_at) VALUES (?, ?, 'process', ?, ?, ?, ?)").bind(
			ulid(opts.created ?? now - 60_000),
			asset,
			status,
			opts.attempts ?? 0,
			opts.started ?? null,
			opts.updated ?? now - 60_000,
		),
	]);
}

beforeEach(async () => {
	await env.DB.batch([env.DB.prepare("DELETE FROM jobs"), env.DB.prepare("DELETE FROM assets")]);
});

describe("jobs overview", () => {
	it("decodes the time from a ULID", () => {
		expect(ulidTime(ulid(1714500000123))).toBe(1714500000123);
	});

	it("is empty when nothing is queued", async () => {
		const o = await jobsOverview(env);
		expect(o.counts).toEqual({ pending: 0, running: 0, stuck: 0, retrying: 0 });
		expect(o.batch).toBeNull();
		expect(o.running).toEqual([]);
	});

	it("reports the current batch, running and pending jobs with file names", async () => {
		await job(1, "done", { created: now - 120_000, updated: now - 30_000 });
		await job(2, "failed", { created: now - 120_000, updated: now - 20_000 });
		await job(3, "running", { created: now - 120_000, started: now - 5_000, attempts: 1 });
		await job(4, "running", { created: now - 120_000, started: now - JOB_STALE_MS - 1, attempts: 1 });
		await job(5, "pending", { created: now - 120_000, attempts: 1 });
		await job(6, "pending", { created: now - 100_000 });
		// 这一批开始之前完成的不算
		await job(7, "done", { created: now - 3600_000, updated: now - 3000_000 });

		const o = await jobsOverview(env);
		expect(o.counts).toEqual({ pending: 2, running: 1, stuck: 1, retrying: 1 });
		expect(o.batch).toMatchObject({ done: 1, failed: 1 });
		expect(o.perMinute).toBeCloseTo(0.1);
		expect(o.running.map((j) => j.names)).toEqual([["IMG_4.JPG"], ["IMG_3.JPG"]]);
		expect(o.pending).toHaveLength(2);
		expect(o.pending[0]).toMatchObject({ asset_id: "PRG5", size: 100, attempts: 1 });
	});
});

describe("failed jobs", () => {
	it("lists failed jobs with file names, newest first, and retries only failed ones", async () => {
		await job(1, "failed", { updated: now - 2000, attempts: 3 });
		await job(2, "failed", { updated: now - 1000, attempts: 3 });
		await job(3, "done");
		const f = await failedJobs(env);
		expect(f.total).toBe(2);
		expect(f.items.map((j) => j.names)).toEqual([["IMG_2.JPG"], ["IMG_1.JPG"]]);

		const done = (await env.DB.prepare("SELECT id FROM jobs WHERE status = 'done'").first<{ id: string }>())!.id;
		const ids = [...f.items.map((j) => j.id), done, f.items[0]!.id];
		expect(await retryFailed(env, ids)).toBe(2);
		const rows = await env.DB.prepare("SELECT status, attempts FROM jobs WHERE status = 'pending'").all();
		expect(rows.results).toEqual([
			{ status: "pending", attempts: 0 },
			{ status: "pending", attempts: 0 },
		]);
		expect((await failedJobs(env)).total).toBe(0);
		// 已经不是 failed 的不会再次入队
		expect(await retryFailed(env, ids)).toBe(0);
	});
});

describe("asset jobs", () => {
	/** 给 PRG1 再加一个任务（job() 每次都会新建条目）。 */
	async function extra(status: string, created: number, opts: { started?: number | null; kind?: string } = {}) {
		const id = ulid(created);
		await env.DB.prepare("INSERT INTO jobs (id, asset_id, kind, status, attempts, started_at, updated_at) VALUES (?, 'PRG1', ?, ?, 1, ?, ?)")
			.bind(id, opts.kind ?? "rotate", status, opts.started ?? null, created)
			.run();
		return id;
	}

	it("lists every job of one asset, newest first", async () => {
		await job(1, "done", { created: now - 300_000 });
		await job(2, "pending");
		await extra("failed", now - 200_000);
		await extra("pending", now - 100_000);
		const r = await assetJobs(env, "PRG1");
		expect(r.items.map((j) => [j.kind, j.status])).toEqual([
			["rotate", "pending"],
			["rotate", "failed"],
			["process", "done"],
		]);
		expect(r.items[0]).toMatchObject({ names: ["IMG_1.JPG"], asset_id: "PRG1" });
		expect((await assetJobs(env, "NOPE")).items).toEqual([]);
	});

	it("cancels pending and stuck jobs only, and they can be retried", async () => {
		await job(1, "pending");
		const stuck = await extra("running", now - 100_000, { started: now - JOB_STALE_MS - 1 });
		const running = await extra("running", now - 90_000, { started: now - 1000 });
		const done = await extra("done", now - 80_000);
		const pending = (await env.DB.prepare("SELECT id FROM jobs WHERE asset_id = 'PRG1' AND kind = 'process'").first<{ id: string }>())!.id;

		expect(await cancelJobs(env, [pending, stuck, running, done, pending])).toBe(2);
		const rows = await env.DB.prepare("SELECT id, status, last_error FROM jobs WHERE asset_id = 'PRG1'").all<{ id: string; status: string; last_error: string | null }>();
		const by = Object.fromEntries(rows.results.map((r) => [r.id, r]));
		expect(by[pending]).toMatchObject({ status: "failed", last_error: CANCELLED_ERROR });
		expect(by[stuck]).toMatchObject({ status: "failed", last_error: CANCELLED_ERROR });
		expect(by[running]!.status).toBe("running");
		expect(by[done]!.status).toBe("done");
		// 条目还在 pending，跟着变成 failed
		expect((await env.DB.prepare("SELECT status FROM assets WHERE id = 'PRG1'").first<{ status: string }>())!.status).toBe("failed");
		// 再停一次不会重复计数；停止的可以照常重试
		expect(await cancelJobs(env, [pending])).toBe(0);
		expect(await retryFailed(env, [pending])).toBe(1);
	});
});
