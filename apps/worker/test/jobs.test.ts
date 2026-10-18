import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JOB_STALE_MS, MAX_JOB_ATTEMPTS, MAX_PROCESS_PER_ASSET_PER_HOUR, RESUME_BATCH, UPLOAD_ACTIVE_MS } from "@nana/shared";
import { guardStub } from "../src/guard";
import { createJob, handleJobMessage, handlers, moreWorkExpected, requeuePending } from "../src/jobs";

const now = Date.now();

async function seed(jobId: string, assetId = `asset-${jobId}`) {
	await env.DB.batch([
		env.DB.prepare(
			"INSERT INTO assets (id, kind, status, created_at, updated_at) VALUES (?, 'photo', 'pending', ?, ?)",
		).bind(assetId, now, now),
		env.DB.prepare(
			"INSERT INTO jobs (id, asset_id, kind, status, attempts, updated_at) VALUES (?, ?, 'process', 'pending', 0, ?)",
		).bind(jobId, assetId, now),
	]);
}

const jobRow = (id: string) =>
	env.DB.prepare("SELECT status, attempts, last_error FROM jobs WHERE id = ?").bind(id).first<{
		status: string;
		attempts: number;
		last_error: string | null;
	}>();

describe("test environment", () => {
	it("does not run the real queue consumer in the background", async () => {
		await env.DB.prepare(
			"INSERT INTO assets (id, kind, status, created_at, updated_at) VALUES ('asset-bg', 'photo', 'pending', 0, 0)",
		).run();
		const jobId = await createJob(env, "asset-bg", "process");
		await new Promise((r) => setTimeout(r, 1500));
		const row = await env.DB.prepare("SELECT status, attempts FROM jobs WHERE id = ?").bind(jobId).first();
		expect(row).toEqual({ status: "pending", attempts: 0 });
	});
});

describe("createJob", () => {
	it("removes the job again when it cannot be enqueued", async () => {
		await env.DB.prepare(
			"INSERT INTO assets (id, kind, status, created_at, updated_at) VALUES ('asset-send-fail', 'photo', 'ready', 0, 0)",
		).run();
		const broken = { ...env, JOBS: { send: async () => Promise.reject(new Error("queue down")) } } as unknown as Env;
		await expect(createJob(broken, "asset-send-fail", "rotate")).rejects.toThrow("queue down");
		expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE asset_id = 'asset-send-fail'").first("n")).toBe(0);
	});
});

describe("queue consumer", () => {
	beforeEach(async () => {
		await guardStub(env).reset();
	});
	afterEach(() => {
		delete handlers.process;
	});

	it("runs a job once and ignores duplicate messages", async () => {
		let calls = 0;
		handlers.process = async () => {
			calls++;
			return { containerSeconds: 1 };
		};
		await seed("j1");
		expect(await handleJobMessage({ jobId: "j1" }, env)).toBe("ack");
		expect(await handleJobMessage({ jobId: "j1" }, env)).toBe("ack");
		expect(calls).toBe(1);
		expect((await jobRow("j1"))!.status).toBe("done");
	});

	it(`stops after ${MAX_JOB_ATTEMPTS} attempts when a job always fails`, async () => {
		let calls = 0;
		handlers.process = async () => {
			calls++;
			throw new Error("always fails");
		};
		await seed("j2");
		const outcomes = [];
		// 模拟平台不断重新投递（比 max_retries 多得多）
		for (let i = 0; i < 10; i++) outcomes.push(await handleJobMessage({ jobId: "j2" }, env));
		expect(calls).toBe(MAX_JOB_ATTEMPTS);
		expect(outcomes.slice(0, MAX_JOB_ATTEMPTS - 1)).toEqual(Array(MAX_JOB_ATTEMPTS - 1).fill("retry"));
		expect(outcomes.slice(MAX_JOB_ATTEMPTS - 1).every((o) => o === "ack")).toBe(true);
		const row = await jobRow("j2");
		expect(row!.status).toBe("failed");
		expect(row!.attempts).toBe(MAX_JOB_ATTEMPTS);
		const asset = await env.DB.prepare("SELECT status FROM assets WHERE id = 'asset-j2'").first<{ status: string }>();
		expect(asset!.status).toBe("failed");
	});

	it("skips work while the guard is tripped and keeps the job pending", async () => {
		let calls = 0;
		handlers.process = async () => {
			calls++;
			return { containerSeconds: 1 };
		};
		await seed("j3");
		await guardStub(env).trip("test");
		expect(await handleJobMessage({ jobId: "j3" }, env)).toBe("ack");
		expect(calls).toBe(0);
		const row = await jobRow("j3");
		expect(row!.status).toBe("pending");
		expect(row!.attempts).toBe(0);
	});

	it("does not consume an attempt when the guard refuses the reservation", async () => {
		handlers.process = async () => ({ containerSeconds: 1 });
		// 同一个条目反复处理会被 UsageGuard 拒绝（疑似循环）
		for (let i = 0; i < MAX_PROCESS_PER_ASSET_PER_HOUR; i++) await guardStub(env).reserveJob("asset-j4");
		await seed("j4", "asset-j4");
		expect(await handleJobMessage({ jobId: "j4" }, env)).toBe("ack");
		const row = await jobRow("j4");
		expect(row!.status).toBe("pending");
		expect(row!.attempts).toBe(0);
	});

	it("records container seconds from failed attempts too", async () => {
		const before = (await guardStub(env).status()).month.containerSeconds;
		handlers.process = async () => {
			throw Object.assign(new Error("timeout"), { containerSeconds: 11 });
		};
		await seed("j5");
		await handleJobMessage({ jobId: "j5" }, env);
		expect((await guardStub(env).status()).month.containerSeconds).toBe(before + 11);
	});

	it("returns busy without consuming an attempt when no container slot frees up", async () => {
		let calls = 0;
		handlers.process = async () => {
			calls++;
			return { containerSeconds: 1 };
		};
		await guardStub(env).setProcessorsOverride(1, 3600_000);
		const held = await guardStub(env).acquireSlot(0);
		expect(held.ok).toBe(true);
		await seed("j6");
		try {
			expect(await handleJobMessage({ jobId: "j6" }, env, { slotWaitMs: 50 })).toBe("busy");
		} finally {
			if (held.ok) await guardStub(env).releaseSlot(held.lease);
			await env.KV.delete("guard:limits-override");
		}
		expect(calls).toBe(0);
		expect(await jobRow("j6")).toMatchObject({ status: "pending", attempts: 0 });
	});

	it("rechecks later instead of dropping the message while the job is running", async () => {
		let calls = 0;
		handlers.process = async () => {
			calls++;
			return { containerSeconds: 1 };
		};
		await seed("j8");
		// 上一个消费者认领之后被杀掉：任务停在 running，平台重投消息
		await env.DB.prepare("UPDATE jobs SET status = 'running', attempts = 1, started_at = ? WHERE id = 'j8'").bind(Date.now()).run();
		expect(await handleJobMessage({ jobId: "j8" }, env)).toBe("recheck");
		expect(calls).toBe(0);
		// 过了 JOB_STALE_MS 再来：算卡住，重新认领
		await env.DB.prepare("UPDATE jobs SET started_at = ? WHERE id = 'j8'").bind(Date.now() - JOB_STALE_MS - 1).run();
		expect(await handleJobMessage({ jobId: "j8" }, env)).toBe("ack");
		expect(calls).toBe(1);
		expect(await jobRow("j8")).toMatchObject({ status: "done", attempts: 2 });
	});

	it("passes the granted slot to the handler and releases it afterwards", async () => {
		let slot = -1;
		handlers.process = async (job) => {
			slot = job.slot;
			expect((await guardStub(env).status()).busySlots).toBe(1);
			return { containerSeconds: 1 };
		};
		await seed("j7");
		expect(await handleJobMessage({ jobId: "j7" }, env)).toBe("ack");
		expect(slot).toBe(0);
		expect((await guardStub(env).status()).busySlots).toBe(0);
	});
});

describe("moreWorkExpected", () => {
	beforeEach(async () => {
		await env.DB.batch([env.DB.prepare("DELETE FROM uploads"), env.DB.prepare("DELETE FROM jobs")]);
	});

	const upload = (id: string, createdAt: number) =>
		env.DB.batch([
			env.DB.prepare(
				"INSERT OR IGNORE INTO assets (id, kind, status, created_at, updated_at) VALUES ('asset-up', 'photo', 'uploading', 0, 0)",
			),
			env.DB.prepare(
				`INSERT INTO uploads (id, asset_id, file_id, role, r2_key, r2_upload_id, mime, size, sha256, created_at)
				 VALUES (?, 'asset-up', ?, 'original', ?, 'u', 'image/jpeg', 1, 'x', ?)`,
			).bind(id, `f-${id}`, `k-${id}`, createdAt),
		]);

	it("is false when nothing is queued and no upload started recently", async () => {
		await seed("m1");
		await env.DB.prepare("UPDATE jobs SET status = 'done' WHERE id = 'm1'").run();
		await upload("old", now - UPLOAD_ACTIVE_MS - 1000);
		expect(await moreWorkExpected(env, now)).toBe(false);
	});

	it("is true while jobs are pending", async () => {
		await seed("m2");
		expect(await moreWorkExpected(env, now)).toBe(true);
	});

	it("is true while uploads are still being created", async () => {
		await upload("new", now - 1000);
		expect(await moreWorkExpected(env, now)).toBe(true);
	});
});

describe("requeuePending", () => {
	const capture = () => {
		const sent: string[] = [];
		const e = {
			...env,
			JOBS: { sendBatch: async (msgs: { body: { jobId: string } }[]) => void sent.push(...msgs.map((m) => m.body.jobId)) },
		} as unknown as Env;
		return { e, sent };
	};

	beforeEach(async () => {
		await env.DB.prepare("DELETE FROM jobs").run();
	});

	it("sends stuck jobs first, then the oldest pending, and moves on to the next batch when clicked again", async () => {
		const stmts = [];
		for (let i = 0; i < RESUME_BATCH + 10; i++) {
			const id = `rq-p${String(i).padStart(4, "0")}`;
			stmts.push(
				env.DB.prepare("INSERT INTO assets (id, kind, status, created_at, updated_at) VALUES (?, 'photo', 'ready', 0, 0)").bind(`a-${id}`),
				env.DB.prepare("INSERT INTO jobs (id, asset_id, kind, status, attempts, updated_at) VALUES (?, ?, 'rotate', 'pending', 0, ?)").bind(id, `a-${id}`, now - 3600_000 + i),
			);
		}
		stmts.push(
			env.DB.prepare("INSERT INTO assets (id, kind, status, created_at, updated_at) VALUES ('a-rq', 'photo', 'ready', 0, 0)"),
			// 卡住的比所有 pending 都新，仍然排在最前
			env.DB.prepare("INSERT INTO jobs (id, asset_id, kind, status, attempts, started_at, updated_at) VALUES ('rq-stuck', 'a-rq', 'rotate', 'running', 1, ?, ?)").bind(now - JOB_STALE_MS - 1, now),
			env.DB.prepare("INSERT INTO jobs (id, asset_id, kind, status, attempts, started_at, updated_at) VALUES ('rq-running', 'a-rq', 'process', 'running', 1, ?, ?)").bind(now, now),
			env.DB.prepare("INSERT INTO jobs (id, asset_id, kind, status, attempts, updated_at) VALUES ('rq-done', 'a-rq', 'process', 'done', 1, 0)"),
		);
		await env.DB.batch(stmts);

		const first = capture();
		expect(await requeuePending(first.e)).toBe(RESUME_BATCH);
		expect(first.sent[0]).toBe("rq-stuck");
		expect(first.sent).toContain("rq-p0000");
		expect(first.sent).not.toContain("rq-running");
		expect(first.sent).not.toContain("rq-done");

		// 第二次补发：卡住的还没被处理，仍然最先；然后是第一次没轮到的，而不是重复发第一批
		const second = capture();
		expect(await requeuePending(second.e)).toBe(RESUME_BATCH);
		expect(second.sent[0]).toBe("rq-stuck");
		const rest = [...Array(11).keys()].map((i) => `rq-p${String(RESUME_BATCH - 1 + i).padStart(4, "0")}`);
		expect(first.sent).not.toContain(rest[1]);
		for (const id of rest) expect(second.sent).toContain(id);
	});
});
