import { SELF, env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FP_MODEL_VER, encodeMask } from "@nana/shared";
import { guardStub } from "../src/guard";
import { handleJobMessage, handlers, requeueAfterDevice } from "../src/jobs";
import { authHeaders, mockAccessJwks } from "./helpers";

beforeAll(() => mockAccessJwks());

beforeEach(async () => {
	await guardStub(env).reset();
	await guardStub(env).detachDevice();
	await guardStub(env).clearDeviceSkipped();
	await env.DB.batch([
		env.DB.prepare("DELETE FROM jobs"),
		env.DB.prepare("DELETE FROM asset_files"),
		env.DB.prepare("DELETE FROM assets"),
	]);
});

const ORIGIN = "http://example.com";

async function call<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
	const res = await SELF.fetch(`${ORIGIN}/api${path}`, {
		method,
		headers: await authHeaders({ Origin: ORIGIN, "X-Requested-With": "nana", "Content-Type": "application/json" }),
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	return { status: res.status, json: (await res.json()) as T };
}

async function put(path: string, data: Uint8Array) {
	const res = await SELF.fetch(`${ORIGIN}/api${path}`, {
		method: "PUT",
		headers: await authHeaders({ Origin: ORIGIN, "X-Requested-With": "nana", "Content-Length": String(data.byteLength) }),
		body: data,
	});
	return { status: res.status, json: (await res.json()) as any };
}

const SHA = "a".repeat(64);
const ORIGINAL = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

async function seed(id: string, { kind = "photo", job = "process", status = "pending", sha = SHA } = {}) {
	const now = Date.now();
	await env.PHOTOS.put(`o/${id}/f`, ORIGINAL);
	await env.DB.batch([
		env.DB.prepare("INSERT INTO assets (id, kind, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").bind(id, kind, status, now, now),
		env.DB.prepare(
			"INSERT INTO asset_files (id, asset_id, role, r2_key, mime, size, sha256, original_name, created_at) VALUES (?, ?, 'original', ?, 'image/jpeg', ?, ?, 'IMG.JPG', ?)",
		).bind(`f-${id}`, id, `o/${id}/f`, ORIGINAL.byteLength, sha, now),
		env.DB.prepare("INSERT INTO jobs (id, asset_id, kind, status, attempts, updated_at) VALUES (?, ?, ?, 'pending', 0, ?)").bind(
			`J-${id}`,
			id,
			job,
			now,
		),
	]);
}

const job = (id: string) =>
	env.DB.prepare("SELECT status, attempts, last_error FROM jobs WHERE id = ?").bind(id).first<{ status: string; attempts: number; last_error: string | null }>();

const deriveResult = {
	meta: { MIMEType: "image/jpeg", DateTimeOriginal: "2024:05:01 12:34:56", OffsetTimeOriginal: "+08:00", CompatibleBrands: ["heic", "mif1"] },
	sha256: SHA,
	size: ORIGINAL.byteLength,
	crc32: 99,
	width: 400,
	height: 300,
	fp: { model: FP_MODEL_VER, phash: "fcc10bf9d813f031", embedding: btoa(String.fromCharCode(...new Array(512).fill(1))) },
	faces: null,
};

/** 认领 → 上传缩略图和预览 → complete，返回 complete 的结果 */
async function processOnDevice(plan: any, results: unknown = { derive: deriveResult }) {
	const t = plan.token;
	for (const name of ["thumb", "preview"]) {
		const r = await put(`/device/jobs/${plan.jobId}/out/${name}?t=${t}&key=${encodeURIComponent(plan.outputs[name])}`, new Uint8Array([9, 9, 9]));
		expect(r.status).toBe(200);
	}
	return call("POST", `/device/jobs/${plan.jobId}/complete`, { t, results });
}

describe("device lease", () => {
	afterEach(() => {
		delete handlers.process;
	});

	it("makes the queue consumer leave jobs for the device, and the cron requeues them after the lease ends", async () => {
		await seed("A1");
		let ran = 0;
		handlers.process = async () => {
			ran++;
			return { containerSeconds: 0 };
		};
		expect((await call("POST", "/device/attach", { name: "mac" })).status).toBe(200);
		expect(await handleJobMessage({ jobId: "J-A1" }, env)).toBe("ack");
		expect(ran).toBe(0);
		expect(await job("J-A1")).toMatchObject({ status: "pending", attempts: 0 });

		// 租约还有效时不补发
		const sent: unknown[] = [];
		const spy = { ...env, JOBS: { sendBatch: async (m: unknown[]) => void sent.push(...m) } } as unknown as Env;
		expect(await requeueAfterDevice(spy)).toBe(0);

		await guardStub(env).detachDevice();
		expect(await requeueAfterDevice(spy)).toBe(1);
		expect(sent).toEqual([{ body: { jobId: "J-A1" } }]);
		// 补发完就清掉标志，之后不再补发
		expect(await requeueAfterDevice(spy)).toBe(0);

		// 消息回到容器路径
		expect(await handleJobMessage({ jobId: "J-A1" }, env, { slotWaitMs: 0 })).toBe("ack");
		expect(ran).toBe(1);
	});

	it("gives the device UI queue counts without file names", async () => {
		await seed("A3");
		await call("POST", "/device/attach", { name: "mac" });
		const { json } = await call("GET", "/device/queue");
		expect(json).toMatchObject({ counts: { pending: 1, running: 0, stuck: 0 }, device: { name: "mac" } });
		expect(JSON.stringify(json)).not.toContain("IMG");
	});


	it("shows the device in the processing overview", async () => {
		await call("POST", "/device/attach", { name: "mac" });
		const { json } = await call("GET", "/jobs/active");
		expect(json.device).toMatchObject({ name: "mac" });
	});

	it("refuses to attach or claim while the guard is tripped", async () => {
		await seed("A2");
		await guardStub(env).trip("test");
		expect((await call("POST", "/device/attach", { name: "mac" })).status).toBe(409);
		expect((await call("POST", "/device/claim", { name: "mac", max: 4 })).status).toBe(409);
		expect(await job("J-A2")).toMatchObject({ status: "pending", attempts: 0 });
	});
});

describe("device jobs", () => {
	it("claims a job, serves its input, and finishes it through the normal process handler", async () => {
		await seed("B1");
		const { status, json } = await call("POST", "/device/claim", { name: "mac", max: 4 });
		expect(status).toBe(200);
		expect(json.jobs).toHaveLength(1);
		const plan = json.jobs[0];
		expect(plan).toMatchObject({
			jobId: "J-B1",
			kind: "process",
			inputs: [{ fileId: "f-B1", role: "original", size: ORIGINAL.byteLength, name: "IMG.JPG", sha256: SHA }],
			derive: { fileId: "f-B1", kind: "image", rotation: 0, mode: "full" },
			meta: [],
			transcode: null,
			outputs: { thumb: "d/B1/thumb-0.webp", preview: "d/B1/preview-0.webp" },
			info: { name: "IMG.JPG", assetKind: "photo" },
		});
		expect(await job("J-B1")).toMatchObject({ status: "running", attempts: 1 });
		// 再认领拿不到同一个任务
		expect((await call("POST", "/device/claim", { name: "mac", max: 4 })).json.jobs).toHaveLength(0);

		const input = await SELF.fetch(`${ORIGIN}/api/device/jobs/J-B1/input/f-B1?t=${plan.token}`, { headers: await authHeaders() });
		expect(input.status).toBe(200);
		expect(new Uint8Array(await input.arrayBuffer())).toEqual(ORIGINAL);

		// 本机找到原件时：Worker 对 R2 上的对象算 sha256
		const verify = await call("GET", `/device/jobs/J-B1/input/f-B1/sha256?t=${plan.token}`);
		expect(verify).toEqual({
			status: 200,
			json: { sha256: "66840dda154e8a113c31dd0ad32f7f3a366a80e8136979d8f5a101d3d29d6f72", size: ORIGINAL.byteLength },
		});

		const done = await processOnDevice(plan);
		expect(done).toEqual({ status: 200, json: { status: "done" } });
		expect(await job("J-B1")).toMatchObject({ status: "done" });
		// 任务结束后认领失效
		expect((await call("GET", `/device/jobs/J-B1/input/f-B1/sha256?t=${plan.token}`)).status).toBe(409);
		const asset = await env.DB.prepare("SELECT status, width, height, taken_at FROM assets WHERE id = 'B1'").first();
		expect(asset).toMatchObject({ status: "ready", width: 400, height: 300 });
		expect(asset!.taken_at).toBeTypeOf("number");
		const roles = await env.DB.prepare("SELECT role, size FROM asset_files WHERE asset_id = 'B1' ORDER BY role").all();
		expect(roles.results).toEqual([
			{ role: "original", size: ORIGINAL.byteLength },
			{ role: "preview", size: 3 },
			{ role: "thumb", size: 3 },
		]);
		expect(await env.DB.prepare("SELECT phash FROM asset_fp WHERE asset_id = 'B1'").first("phash")).toBe("fcc10bf9d813f031");
	});

	it("puts the job back when the device result does not match the current state (rotated meanwhile)", async () => {
		await seed("B2");
		const plan = (await call("POST", "/device/claim", { name: "mac", max: 1 })).json.jobs[0];
		for (const name of ["thumb", "preview"]) {
			await put(`/device/jobs/${plan.jobId}/out/${name}?t=${plan.token}&key=${encodeURIComponent(plan.outputs[name])}`, new Uint8Array([1]));
		}
		await env.DB.prepare("UPDATE assets SET rotation = 90, derived_rev = derived_rev + 1 WHERE id = 'B2'").run();
		const r = await call("POST", `/device/jobs/${plan.jobId}/complete`, { t: plan.token, results: { derive: deriveResult } });
		expect(r.json.status).toBe("retry");
		expect(await job("J-B2")).toMatchObject({ status: "pending", attempts: 1 });
		expect((await job("J-B2"))!.last_error).toContain("device");
		expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM asset_files WHERE asset_id = 'B2' AND role = 'thumb'").first("n")).toBe(0);
	});

	it("rejects outputs outside the plan and requests after the claim was lost", async () => {
		await seed("B3");
		const plan = (await call("POST", "/device/claim", { name: "mac", max: 1 })).json.jobs[0];
		const t = plan.token;
		expect((await put(`/device/jobs/${plan.jobId}/out/thumb?t=${t}&key=${encodeURIComponent("d/OTHER/thumb-0.webp")}`, new Uint8Array([1]))).status).toBe(409);
		expect((await put(`/device/jobs/${plan.jobId}/out/original?t=${t}&key=${encodeURIComponent("o/B3/f")}`, new Uint8Array([1]))).status).toBe(409);
		expect(await env.PHOTOS.get("o/B3/f").then((o) => o?.size)).toBe(ORIGINAL.byteLength);

		// 被别人重新认领（started_at 变了）之后，旧凭证一律 409
		await env.DB.prepare("UPDATE jobs SET started_at = started_at + 1 WHERE id = ?").bind(plan.jobId).run();
		expect((await call("POST", `/device/jobs/${plan.jobId}/complete`, { t, results: { derive: deriveResult } })).status).toBe(409);
		const input = await SELF.fetch(`${ORIGIN}/api/device/jobs/${plan.jobId}/input/f-B3?t=${t}`, { headers: await authHeaders() });
		expect(input.status).toBe(409);
	});

	it("does not serve files of other assets", async () => {
		await seed("B4");
		await seed("B5", { sha: "b".repeat(64) });
		const plan = (await call("POST", "/device/claim", { name: "mac", max: 1 })).json.jobs[0];
		const other = plan.jobId === "J-B4" ? "f-B5" : "f-B4";
		const res = await SELF.fetch(`${ORIGIN}/api/device/jobs/${plan.jobId}/input/${other}?t=${plan.token}`, { headers: await authHeaders() });
		expect(res.status).toBe(404);
		expect((await call("GET", `/device/jobs/${plan.jobId}/input/${other}/sha256?t=${plan.token}`)).status).toBe(404);
	});

	it("counts device failures like container failures and releases without using an attempt", async () => {
		await seed("B6");
		let plan = (await call("POST", "/device/claim", { name: "mac", max: 1 })).json.jobs[0];
		expect((await call("POST", `/device/jobs/${plan.jobId}/fail`, { t: plan.token, error: "vips failed" })).json.status).toBe("retry");
		expect(await job("J-B6")).toMatchObject({ status: "pending", attempts: 1, last_error: "Error: device: vips failed" });

		plan = (await call("POST", "/device/claim", { name: "mac", max: 1 })).json.jobs[0];
		expect(plan.attempts).toBe(2);
		await call("POST", `/device/jobs/${plan.jobId}/release`, { t: plan.token });
		expect(await job("J-B6")).toMatchObject({ status: "pending", attempts: 1 });
	});

	it("needs authentication", async () => {
		const res = await SELF.fetch(`${ORIGIN}/api/device/claim`, {
			method: "POST",
			headers: { Origin: ORIGIN, "X-Requested-With": "nana", "Content-Type": "application/json" },
			body: JSON.stringify({ name: "mac", max: 1 }),
		});
		expect(res.status).toBe(403);
	});

	it("gives rotate jobs a skip-fingerprint plan and finishes them", async () => {
		await seed("B7", { job: "rotate", status: "ready" });
		await env.DB.prepare("UPDATE assets SET rotation = 90, derived_rev = 2 WHERE id = 'B7'").run();
		const plan = (await call("POST", "/device/claim", { name: "mac", max: 1 })).json.jobs[0];
		expect(plan.derive).toMatchObject({ mode: "skip", rotation: 90 });
		expect(plan.outputs).toEqual({ thumb: "d/B7/thumb-2.webp", preview: "d/B7/preview-2.webp" });
		expect((await processOnDevice(plan, { derive: { ...deriveResult, fp: null } })).json.status).toBe("done");
		expect(await env.DB.prepare("SELECT r2_key FROM asset_files WHERE asset_id = 'B7' AND role = 'thumb'").first("r2_key")).toBe("d/B7/thumb-2.webp");
	});

	it("passes the blur to the device and refuses results from a device that ignored it", async () => {
		const mask = encodeMask([{ r: 0.05, p: [0.5, 0.5] }])!;
		await seed("B9", { job: "rotate", status: "ready" });
		await env.DB.prepare("UPDATE assets SET mask = ?, derived_rev = 1 WHERE id = 'B9'").bind(mask).run();
		let plan = (await call("POST", "/device/claim", { name: "mac", max: 1 })).json.jobs[0];
		expect(plan.derive).toMatchObject({ mode: "skip", crop: null, mask });
		expect(plan.outputs).toEqual({ thumb: "d/B9/thumb-1.webp", preview: "d/B9/preview-1.webp", base: "d/B9/base-1.webp" });
		const upload = async (p: any) => {
			for (const name of ["thumb", "preview", "base"]) {
				await put(`/device/jobs/${p.jobId}/out/${name}?t=${p.token}&key=${encodeURIComponent(p.outputs[name])}`, new Uint8Array([1]));
			}
		};

		// 旧版设备端：结果里没有 mask，上传的没打码的图要删掉
		await upload(plan);
		const old = await call("POST", `/device/jobs/${plan.jobId}/complete`, { t: plan.token, results: { derive: { ...deriveResult, fp: null } } });
		expect(old.json.status).toBe("retry");
		expect((await job("J-B9"))!.last_error).toContain("mask");
		for (const name of ["thumb", "preview", "base"]) expect(await env.PHOTOS.head(`d/B9/${name}-1.webp`)).toBeNull();

		plan = (await call("POST", "/device/claim", { name: "mac", max: 1 })).json.jobs[0];
		await upload(plan);
		const ok = await call("POST", `/device/jobs/${plan.jobId}/complete`, { t: plan.token, results: { derive: { ...deriveResult, fp: null, mask } } });
		expect(ok.json.status).toBe("done");
	});

	it("finishes jobs with nothing to do (deleted asset) without any processing", async () => {
		await seed("B8");
		await env.DB.prepare("UPDATE assets SET deleted_at = 1 WHERE id = 'B8'").run();
		const plan = (await call("POST", "/device/claim", { name: "mac", max: 1 })).json.jobs[0];
		expect(plan).toMatchObject({ derive: null, inputs: [] });
		expect((await call("POST", `/device/jobs/${plan.jobId}/complete`, { t: plan.token, results: {} })).json.status).toBe("done");
	});

	it("compresses originals on the device and checks the uploaded bytes", async () => {
		const small = new Uint8Array([7, 7, 7]);
		const smallSha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", small))].map((b) => b.toString(16).padStart(2, "0")).join("");
		const compressResult = (input: string, sha256: string) => ({ compress: { sha256: input, size: ORIGINAL.byteLength, skipped: null, out: { sha256, size: small.byteLength, crc32: 5 } } });
		await seed("C1", { job: "compress", status: "ready" });
		await seed("C2", { job: "compress", status: "ready", sha: "c".repeat(64) });
		const plans = (await call("POST", "/device/claim", { name: "mac", max: 2 })).json.jobs;
		expect(plans[0]).toMatchObject({ derive: null, compress: { fileId: "f-C1", quality: 90 }, inputs: [{ fileId: "f-C1" }] });
		const key = plans[0].outputs.compressed;
		expect(key).toBe("o/C1/c-J-C1-1");
		for (const plan of plans) {
			const r = await put(`/device/jobs/${plan.jobId}/out/compressed?t=${plan.token}&key=${encodeURIComponent(plan.outputs.compressed)}`, small);
			expect(r.status).toBe(200);
		}
		// 设备报的 sha256 和上传的字节对不上：不换，删掉上传的文件，任务退回
		const bad = await call("POST", `/device/jobs/${plans[1].jobId}/complete`, { t: plans[1].token, results: compressResult("c".repeat(64), "b".repeat(64)) });
		expect(bad.json.status).toBe("retry");
		expect(await env.PHOTOS.head(plans[1].outputs.compressed)).toBeNull();
		expect(await env.DB.prepare("SELECT r2_key FROM asset_files WHERE id = 'f-C2'").first("r2_key")).toBe("o/C2/f");

		const ok = await call("POST", `/device/jobs/${plans[0].jobId}/complete`, { t: plans[0].token, results: compressResult(SHA, smallSha) });
		expect(ok.json.status).toBe("done");
		const f = await env.DB.prepare("SELECT r2_key, size, sha256, compress_state, source_sha256 FROM asset_files WHERE id = 'f-C1'").first();
		expect(f).toEqual({ r2_key: key, size: 3, sha256: smallSha, compress_state: 1, source_sha256: SHA });
		expect(await env.PHOTOS.head("o/C1/f")).toBeNull();
	});
});
