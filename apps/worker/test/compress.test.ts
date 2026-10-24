import { SELF, env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { compressAsset } from "../src/compress";
import { guardStub } from "../src/guard";
import { handleJobMessage, handlers } from "../src/jobs";
import type { ProcessorLike } from "../src/process";
import type { CompressOutput } from "../src/processor";
import { authHeaders, mockAccessJwks } from "./helpers";

beforeAll(() => mockAccessJwks());

const MB = 1024 ** 2;
const id = (n: number) => `CMP${String(n).padStart(23, "0")}`;
const sha = (n: number) => String(n).padStart(64, "0");

async function seed(
	n: number,
	size: number,
	opts: { mime?: string; kind?: string; deleted?: number; width?: number; height?: number; previewTarget?: number } = {},
) {
	await env.DB.batch([
		env.DB.prepare(
			`INSERT INTO assets (id, kind, status, local_day, taken_at, width, height, preview_target, deleted_at, created_at, updated_at)
			 VALUES (?, ?, 'ready', '2024-05-01', 1, ?, ?, ?, ?, 0, 0)`,
		).bind(id(n), opts.kind ?? "photo", opts.width ?? 4, opts.height ?? 3, opts.previewTarget ?? null, opts.deleted ?? null),
		env.DB.prepare(
			"INSERT INTO asset_files (id, asset_id, role, r2_key, mime, size, sha256, original_name, created_at) VALUES (?, ?, 'original', ?, ?, ?, ?, ?, 0)",
		).bind(`F${n}`, id(n), `o/${id(n)}/F${n}`, opts.mime ?? "image/jpeg", size, sha(n), `IMG_${n}.JPG`),
	]);
	await env.PHOTOS.put(`o/${id(n)}/F${n}`, "original");
}

async function call<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
	const res = await SELF.fetch(`http://example.com/api${path}`, {
		method,
		headers: await authHeaders(
			method === "GET" ? {} : { Origin: "http://example.com", "X-Requested-With": "nana", "Content-Type": "application/json" },
		),
		body: body ? JSON.stringify(body) : undefined,
	});
	return { status: res.status, json: (await res.json()) as T };
}

/** 假的容器：按设定返回压缩结果，压缩了就把字节写到 outputKey。 */
const fake = { result: null as ((size: number, sha: string, maxPixels: number) => CompressOutput) | null, calls: [] as string[], maxPixels: [] as number[] };
const fakeProcessor = () =>
	({
		compress: async (inputKey: string, outputKey: string, maxPixels = 0) => {
			fake.calls.push(inputKey);
			fake.maxPixels.push(maxPixels);
			const file = await env.DB.prepare("SELECT size, sha256 FROM asset_files WHERE r2_key = ?").bind(inputKey).first<{ size: number; sha256: string }>();
			const value = fake.result!(file!.size, file!.sha256, maxPixels);
			if (value.out) await env.PHOTOS.put(outputKey, "small");
			return { ok: true, value, containerSeconds: 3 };
		},
	}) as unknown as ProcessorLike;
const shrink = (size: number, s: string): CompressOutput => ({ sha256: s, size, skipped: null, out: { sha256: "e".repeat(64), size: Math.floor(size / 4), crc32: 99 } });

const original = (n: number) =>
	env.DB.prepare("SELECT r2_key, size, sha256, crc32, compress_state, compress_skip, source_sha256, source_size FROM asset_files WHERE id = ?")
		.bind(`F${n}`)
		.first<{
			r2_key: string;
			size: number;
			sha256: string;
			crc32: number | null;
			compress_state: number | null;
			compress_skip: string | null;
			source_sha256: string | null;
			source_size: number | null;
		}>();

const jobOf = (n: number) =>
	env.DB.prepare("SELECT id, status, last_error FROM jobs WHERE asset_id = ? AND kind = 'compress'").bind(id(n)).first<{ id: string; status: string; last_error: string | null }>();

describe("original compression", () => {
	const real = handlers.compress;
	beforeEach(async () => {
		handlers.compress = (job, e) => compressAsset(job, e, fakeProcessor);
		fake.result = shrink;
		fake.calls.length = 0;
		fake.maxPixels.length = 0;
		await guardStub(env).reset();
		await env.DB.batch([env.DB.prepare("DELETE FROM jobs"), env.DB.prepare("DELETE FROM asset_files"), env.DB.prepare("DELETE FROM assets")]);
	});
	afterEach(() => {
		handlers.compress = real;
	});

	it("lists unprocessed JPEG originals above the threshold, largest first", async () => {
		await seed(1, 30 * MB);
		await seed(2, 70 * MB);
		await seed(3, 1 * MB); // 低于最小值
		await seed(4, 50 * MB, { mime: "image/heic" });
		await seed(5, 90 * MB, { kind: "video", mime: "video/mp4" });
		await seed(6, 80 * MB, { deleted: Date.now() });
		await seed(7, 10 * MB);

		const all = await call("GET", "/compress/candidates");
		expect(all.json.items.map((i: unknown[]) => i[0])).toEqual([id(2), id(1), id(7)]);
		expect(all.json.details.map((d: unknown[]) => d[1])).toEqual([70 * MB, 30 * MB, 10 * MB]);

		const big = await call("GET", `/compress/candidates?min=${20 * MB}`);
		expect(big.json.items.map((i: unknown[]) => i[0])).toEqual([id(2), id(1)]);
		const summary = await call("GET", `/compress/summary?min=${20 * MB}`);
		expect(summary.json).toMatchObject({ candidates: { count: 2, bytes: 100 * MB }, compressed: { count: 0 }, queued: 0 });
	});

	it("replaces the original with the compressed file and remembers the source", async () => {
		await seed(1, 40 * MB);
		const r = await call("POST", "/compress", { ids: [id(1)] });
		expect(r.json).toEqual({ queued: 1, skipped: 0 });
		// 排队中的不再列出，也不会重复建任务
		expect((await call("GET", "/compress/candidates")).json.items).toEqual([]);
		expect((await call("POST", "/compress", { ids: [id(1)] })).json).toEqual({ queued: 0, skipped: 1 });

		const job = await jobOf(1);
		expect(await handleJobMessage({ jobId: job!.id }, env)).toBe("ack");
		expect((await jobOf(1))!.status).toBe("done");

		const f = await original(1);
		expect(f).toMatchObject({ size: 10 * MB, sha256: "e".repeat(64), crc32: 99, compress_state: 1, source_sha256: sha(1), source_size: 40 * MB });
		expect(f!.r2_key).toBe(`o/${id(1)}/c-${job!.id}-1`);
		expect(await env.PHOTOS.head(`o/${id(1)}/F1`)).toBeNull(); // 旧文件删掉了
		expect(await env.PHOTOS.head(f!.r2_key)).not.toBeNull();
		const asset = await env.DB.prepare("SELECT file_size FROM assets WHERE id = ?").bind(id(1)).first<{ file_size: number }>();
		expect(asset!.file_size).toBe(10 * MB); // 触发器跟着更新

		const summary = await call("GET", "/compress/summary");
		expect(summary.json).toMatchObject({ candidates: { count: 0 }, compressed: { count: 1, before: 40 * MB, after: 10 * MB }, queued: 0 });
		// 不会再压缩第二次
		expect((await call("POST", "/compress", { ids: [id(1)] })).json.queued).toBe(0);
		// 重新上传压缩前的原文件仍然算重复
		const check = await call("POST", "/uploads/check", { hashes: [sha(1)] });
		expect(check.json.existing).toEqual({ [sha(1)]: id(1) });
	});

	it("keeps the original when compression is not worth it", async () => {
		await seed(1, 8 * MB);
		fake.result = (size, s) => ({ sha256: s, size, skipped: "not-smaller", out: null });
		await call("POST", "/compress", { ids: [id(1)] });
		await handleJobMessage({ jobId: (await jobOf(1))!.id }, env);
		expect(await original(1)).toMatchObject({
			r2_key: `o/${id(1)}/F1`,
			size: 8 * MB,
			sha256: sha(1),
			compress_state: 2,
			compress_skip: "not-smaller",
			source_sha256: null,
		});
		expect(await env.PHOTOS.head(`o/${id(1)}/F1`)).not.toBeNull();
		expect((await call("GET", "/compress/summary")).json).toMatchObject({ skipped: 1, candidates: { count: 0 }, reasons: { "not-smaller": 1 } });
	});

	it("lists processed originals with the reason they were skipped", async () => {
		await seed(1, 8 * MB);
		await seed(2, 30 * MB);
		await seed(3, 20 * MB);
		await seed(4, 9 * MB);
		const reasons: Record<number, string> = { 1: "not-smaller", 2: "extra-data", 3: "not-smaller" };
		fake.result = (size, s) => {
			const n = Number(s);
			return n in reasons ? { sha256: s, size, skipped: reasons[n]!, out: null } : shrink(size, s);
		};
		await call("POST", "/compress", { ids: [id(1), id(2), id(3), id(4)] });
		for (const n of [1, 2, 3, 4]) await handleJobMessage({ jobId: (await jobOf(n))!.id }, env);
		// 没记原因的旧数据
		await seed(5, 5 * MB);
		await env.DB.prepare("UPDATE asset_files SET compress_state = 2 WHERE id = 'F5'").run();

		const summary = await call("GET", "/compress/summary");
		expect(summary.json.reasons).toEqual({ "not-smaller": 2, "extra-data": 1, unknown: 1 });
		const ids = async (q: string) => (await call("GET", `/compress/done?${q}`)).json.items.map((i: unknown[]) => i[0]);
		expect(await ids("state=skipped")).toEqual([id(2), id(3), id(1), id(5)]);
		expect(await ids("state=skipped&reason=not-smaller")).toEqual([id(3), id(1)]);
		expect(await ids("state=skipped&reason=unknown")).toEqual([id(5)]);
		expect(await ids("state=compressed")).toEqual([id(4)]);
	});

	it("downscales high-resolution originals when a pixel limit is chosen", async () => {
		// 4800 万像素，显示方向是竖的（文件里存的是 8000×6000），全尺寸预览比缩小后的长边还大
		await seed(1, 12 * MB, { width: 6000, height: 8000, previewTarget: 8000 });
		await seed(2, 12 * MB, { width: 6000, height: 8000 });
		fake.result = (size, s) => ({ sha256: s, size, width: 8000, height: 6000, skipped: s === sha(2) ? "extra-data" : "not-smaller", out: null });
		await call("POST", "/compress", { ids: [id(1), id(2)] });
		for (const n of [1, 2]) await handleJobMessage({ jobId: (await jobOf(n))!.id }, env);
		await env.DB.prepare("DELETE FROM jobs").run();

		// 不选分辨率：处理过的不再处理；选了：只是不值得压缩的可以再处理，带附图的不行
		expect((await call("POST", "/compress", { ids: [id(1), id(2)] })).json).toEqual({ queued: 0, skipped: 2 });
		expect((await call("POST", "/compress", { ids: [id(1)], maxPixels: 123 })).status).toBe(400);
		expect((await call("POST", "/compress", { ids: [id(1), id(2)], maxPixels: 24_000_000 })).json).toEqual({ queued: 1, skipped: 1 });

		fake.result = (size, s, maxPixels) => {
			const k = Math.sqrt(maxPixels / 48_000_000);
			const out = { sha256: "e".repeat(64), size: Math.floor(size / 2), crc32: 7, width: Math.floor(8000 * k), height: Math.floor(6000 * k) };
			return { sha256: s, size, width: 8000, height: 6000, skipped: null, out };
		};
		const job = await jobOf(1);
		await handleJobMessage({ jobId: job!.id }, env);
		expect(fake.maxPixels.at(-1)).toBe(24_000_000);
		expect((await jobOf(1))!.status).toBe("done");
		expect(await original(1)).toMatchObject({ size: 6 * MB, compress_state: 1, compress_skip: null, source_sha256: sha(1), source_size: 12 * MB });
		const a = await env.DB.prepare("SELECT width, height, preview_target FROM assets WHERE id = ?").bind(id(1)).first();
		expect(a).toEqual({ width: 4242, height: 5656, preview_target: 5656 }); // 显示方向不变

		// 缩小之后不再超过上限，不会再处理
		await env.DB.prepare("DELETE FROM jobs").run();
		expect((await call("POST", "/compress", { ids: [id(1)], maxPixels: 24_000_000 })).json.queued).toBe(0);
		// 更小的上限还可以再缩一次，最早的原图的 sha256 仍然留着
		expect((await call("POST", "/compress", { ids: [id(1)], maxPixels: 12_000_000 })).json.queued).toBe(1);
	});

	it("fails when the processor ignores the pixel limit", async () => {
		await seed(1, 12 * MB, { width: 8000, height: 6000 });
		// 旧版设备端：不认识上限，也不返回尺寸
		fake.result = (size, s) => ({ sha256: s, size, skipped: null, out: { sha256: "e".repeat(64), size: size / 2, crc32: 1 } });
		await call("POST", "/compress", { ids: [id(1)], maxPixels: 16_000_000 });
		const job = await jobOf(1);
		await handleJobMessage({ jobId: job!.id }, env);
		expect(await original(1)).toMatchObject({ r2_key: `o/${id(1)}/F1`, compress_state: null });
		expect(await env.PHOTOS.head(`o/${id(1)}/c-${job!.id}-1`)).toBeNull();
		expect((await jobOf(1))!.last_error).toMatch(/resolution limit/);
	});

	it("fails permanently and leaves the original alone when the input does not match", async () => {
		await seed(1, 8 * MB);
		fake.result = (size) => ({ ...shrink(size, "f".repeat(64)) });
		await call("POST", "/compress", { ids: [id(1)] });
		const job = await jobOf(1);
		await handleJobMessage({ jobId: job!.id }, env);
		expect((await jobOf(1))!.status).toBe("failed");
		expect(await original(1)).toMatchObject({ r2_key: `o/${id(1)}/F1`, compress_state: null });
		expect(await env.PHOTOS.head(`o/${id(1)}/c-${job!.id}-1`)).toBeNull(); // 写出来的新文件删掉了
		// 失败的仍然是候选，可以再试
		expect((await call("GET", "/compress/candidates")).json.items).toHaveLength(1);
	});

	it("discards the result when the original changed meanwhile", async () => {
		await seed(1, 8 * MB);
		await call("POST", "/compress", { ids: [id(1)] });
		const job = await jobOf(1);
		// 容器运行期间原件被换掉（比如另一个任务先压缩完）
		handlers.compress = async (j, e) => {
			const proc = fakeProcessor();
			return compressAsset(j, e, () => ({
				...proc,
				compress: async (i: string, o: string) => {
					const r = await proc.compress(i, o);
					await env.DB.prepare("UPDATE asset_files SET r2_key = 'o/other' WHERE id = 'F1'").run();
					return r;
				},
			}) as ProcessorLike);
		};
		await handleJobMessage({ jobId: job!.id }, env);
		expect(await original(1)).toMatchObject({ r2_key: "o/other", compress_state: null });
		expect(await env.PHOTOS.head(`o/${id(1)}/c-${job!.id}-1`)).toBeNull();
	});

	it("refuses to queue while the guard is tripped", async () => {
		await seed(1, 8 * MB);
		await guardStub(env).trip("test");
		expect((await call("POST", "/compress", { ids: [id(1)] })).status).toBe(503);
		expect(await jobOf(1)).toBeNull();
	});
});
