import { SELF, env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { composeAsset } from "../src/compose";
import { guardStub } from "../src/guard";
import { handleJobMessage, handlers } from "../src/jobs";
import type { ProcessorLike } from "../src/process";
import type { ComposeInput, ComposeOp } from "../src/processor";
import { authHeaders, mockAccessJwks } from "./helpers";

beforeAll(() => mockAccessJwks());

const id = (n: number) => `CMS${String(n).padStart(23, "0")}`;
const sha = (n: number) => String(n).padStart(64, "0");

async function seed(n: number, opts: { kind?: string; mask?: string; width?: number; height?: number; rotation?: number; album?: string; favorite?: number } = {}) {
	await env.DB.batch([
		env.DB.prepare(
			`INSERT INTO assets (id, kind, status, local_day, taken_at, tz_offset_min, lat, lon, width, height, rotation, mask, favorite, created_at, updated_at)
			 VALUES (?, ?, 'ready', '2024-05-01', ?, 480, 31.2, 121.5, ?, ?, ?, ?, ?, 0, 0)`,
		).bind(id(n), opts.kind ?? "photo", 1_714_000_000_000 + n, opts.width ?? 1000, opts.height ?? 2000, opts.rotation ?? 0, opts.mask ?? null, opts.favorite ?? 0),
		env.DB.prepare(
			"INSERT INTO asset_files (id, asset_id, role, r2_key, mime, size, sha256, original_name, created_at) VALUES (?, ?, 'original', ?, 'image/jpeg', 100, ?, ?, 0)",
		).bind(`CF${n}`, id(n), `o/${id(n)}/CF${n}`, sha(n), `IMG_${n}.HEIC`),
		...(opts.album
			? [env.DB.prepare("INSERT INTO album_assets (album_id, asset_id, added_at) VALUES (?, ?, 0)").bind(opts.album, id(n))]
			: []),
	]);
	await env.PHOTOS.put(`o/${id(n)}/CF${n}`, "original");
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

/** 假的容器：compose 按输入的 sha256 回报完整性、把生成的字节写到 outputKey；derive 按 r2_key 读回 sha256。 */
const fake = {
	composes: [] as { inputs: ComposeInput[]; op: ComposeOp }[],
	failCompose: false,
	failDerive: false,
	n: 0,
};
const ok = <T,>(value: T) => ({ ok: true, value, containerSeconds: 2 });
const fileByKey = (key: string) =>
	env.DB.prepare("SELECT size, sha256 FROM asset_files WHERE r2_key = ?").bind(key).first<{ size: number; sha256: string }>();
const fakeProcessor = () =>
	({
		compose: async (inputs: ComposeInput[], op: ComposeOp, outputKey: string) => {
			fake.composes.push({ inputs, op });
			if (fake.failCompose) return { ok: false, error: "boom", containerSeconds: 1 };
			const files = await Promise.all(inputs.map((i) => fileByKey(i.key)));
			await env.PHOTOS.put(outputKey, "composed");
			fake.n++;
			return ok({
				inputs: files.map((f) => ({ sha256: f!.sha256, size: f!.size, crc32: 1 })),
				out: { sha256: `c${String(fake.n).padStart(63, "0")}`, size: 8, crc32: 7, width: 1000, height: 3000 },
			});
		},
		derive: async (i: { inputKey: string }) => {
			if (fake.failDerive) return { ok: false, error: "derive boom", containerSeconds: 1 };
			const f = await fileByKey(i.inputKey);
			return ok({ meta: {}, sha256: f!.sha256, size: f!.size, crc32: 7, width: 1000, height: 3000, thumbSize: 1, previewSize: 2, fp: null, faces: null });
		},
	}) as unknown as ProcessorLike;

const assetRow = (assetId: string) =>
	env.DB.prepare("SELECT status, deleted_at, taken_at, lat, favorite, meta_locked, width, height FROM assets WHERE id = ?")
		.bind(assetId)
		.first<{ status: string; deleted_at: number | null; taken_at: number | null; lat: number | null; favorite: number; meta_locked: number; width: number; height: number }>();
const jobOf = (assetId: string) =>
	env.DB.prepare("SELECT id, status, last_error FROM jobs WHERE asset_id = ? AND kind = 'compose'").bind(assetId).first<{ id: string; status: string; last_error: string | null }>();
const run = async (assetId: string) => handleJobMessage({ jobId: (await jobOf(assetId))!.id }, env);

describe("stitch and split", () => {
	const real = handlers.compose;
	beforeEach(async () => {
		handlers.compose = (job, e) => composeAsset(job, e, fakeProcessor);
		fake.composes.length = 0;
		fake.failCompose = false;
		fake.failDerive = false;
		await guardStub(env).reset();
		await env.DB.batch([
			env.DB.prepare("DELETE FROM jobs"),
			env.DB.prepare("DELETE FROM compose_specs"),
			env.DB.prepare("DELETE FROM album_assets"),
			env.DB.prepare("DELETE FROM albums"),
			env.DB.prepare("DELETE FROM asset_files"),
			env.DB.prepare("DELETE FROM assets"),
		]);
	});
	afterEach(() => {
		handlers.compose = real;
	});

	it("stitches photos into a new one, then trashes the sources", async () => {
		await env.DB.prepare("INSERT INTO albums (id, name, created_at, updated_at) VALUES ('ALB', 'trip', 0, 0)").run();
		await seed(1, { album: "ALB" });
		await seed(2, { rotation: 90, favorite: 1 });
		const r = await call("POST", "/compose/stitch", { ids: [id(2), id(1)], direction: "vertical" });
		expect(r.status).toBe(201);
		const [created] = r.json.assetIds as string[];
		// 处理好之前看不到，原照片也还在
		expect((await assetRow(created!))!.status).toBe("pending");
		expect((await assetRow(id(1)))!.deleted_at).toBeNull();

		expect(await run(created!)).toBe("ack");
		expect((await jobOf(created!))!.status).toBe("done");
		// 按选中的顺序、带上各自的旋转
		expect(fake.composes[0]!.op).toEqual({ mode: "stitch", direction: "vertical" });
		expect(fake.composes[0]!.inputs.map((i) => [i.key, i.rotation])).toEqual([
			[`o/${id(2)}/CF2`, 90],
			[`o/${id(1)}/CF1`, 0],
		]);
		const a = (await assetRow(created!))!;
		// 时间、位置沿用第一张，记成手动编辑过；任意一张收藏过就收藏
		expect(a).toMatchObject({ status: "ready", taken_at: 1_714_000_000_002, lat: 31.2, favorite: 1, width: 1000, height: 3000 });
		expect(a.meta_locked & 3).toBe(3);
		const original = await env.DB.prepare("SELECT mime, original_name FROM asset_files WHERE asset_id = ? AND role = 'original'")
			.bind(created)
			.first<{ mime: string; original_name: string }>();
		expect(original).toEqual({ mime: "image/jpeg", original_name: "IMG_2_stitched.jpg" });
		// 原照片进回收站，新照片进原照片所在的相册
		expect((await assetRow(id(1)))!.deleted_at).not.toBeNull();
		expect((await assetRow(id(2)))!.deleted_at).not.toBeNull();
		const albums = await env.DB.prepare("SELECT album_id FROM album_assets WHERE asset_id = ?").bind(created).all();
		expect(albums.results).toEqual([{ album_id: "ALB" }]);
	});

	it("splits a photo into pieces and trashes it only after every piece is ready", async () => {
		await seed(1);
		const r = await call("POST", "/compose/split", { id: id(1), direction: "vertical", cuts: [0.25, 0.5] });
		expect(r.status).toBe(201);
		const pieces = r.json.assetIds as string[];
		expect(pieces).toHaveLength(3);

		await run(pieces[0]!);
		await run(pieces[1]!);
		expect((await assetRow(id(1)))!.deleted_at).toBeNull();
		await run(pieces[2]!);
		expect((await assetRow(id(1)))!.deleted_at).not.toBeNull();

		const ops = fake.composes.map((c) => c.op);
		expect(ops).toEqual([
			{ mode: "split", direction: "vertical", from: 0, to: 0.25 },
			{ mode: "split", direction: "vertical", from: 0.25, to: 0.5 },
			{ mode: "split", direction: "vertical", from: 0.5, to: 1 },
		]);
		const names = await env.DB.prepare("SELECT original_name FROM asset_files WHERE role = 'original' AND asset_id IN (?, ?, ?) ORDER BY original_name")
			.bind(...pieces)
			.all<{ original_name: string }>();
		expect(names.results.map((n) => n.original_name)).toEqual(["IMG_1_1.jpg", "IMG_1_2.jpg", "IMG_1_3.jpg"]);
	});

	it("keeps the generated original when only the processing step fails", async () => {
		await seed(1);
		await seed(2);
		const [created] = (await call("POST", "/compose/stitch", { ids: [id(1), id(2)], direction: "horizontal" })).json.assetIds as string[];
		fake.failDerive = true;
		expect(await run(created!)).toBe("retry");
		expect((await assetRow(id(1)))!.deleted_at).toBeNull();
		fake.failDerive = false;
		expect(await run(created!)).toBe("ack");
		// 第二次不再生成原件
		expect(fake.composes).toHaveLength(1);
		expect((await assetRow(created!))!.status).toBe("ready");
		expect((await assetRow(id(1)))!.deleted_at).not.toBeNull();
	});

	it("leaves the sources alone when composing fails", async () => {
		await seed(1);
		await seed(2);
		const [created] = (await call("POST", "/compose/stitch", { ids: [id(1), id(2)], direction: "vertical" })).json.assetIds as string[];
		fake.failCompose = true;
		for (let i = 0; i < 3; i++) await run(created!);
		expect((await jobOf(created!))!.status).toBe("failed");
		expect((await assetRow(created!))!.status).toBe("failed");
		expect((await assetRow(id(1)))!.deleted_at).toBeNull();
		const files = await env.DB.prepare("SELECT COUNT(*) AS n FROM asset_files WHERE asset_id = ?").bind(created).first<{ n: number }>();
		expect(files!.n).toBe(0);
	});

	it("rejects videos, masked photos, oversized results and tiny pieces", async () => {
		await seed(1);
		await seed(2, { kind: "video" });
		await seed(3, { mask: "AAAA" });
		await seed(4, { width: 1000, height: 64_000 });
		expect((await call("POST", "/compose/stitch", { ids: [id(1), id(2)], direction: "vertical" })).json).toEqual({ error: "not composable" });
		expect((await call("POST", "/compose/stitch", { ids: [id(1), id(3)], direction: "vertical" })).json).toEqual({ error: "has mask" });
		expect((await call("POST", "/compose/stitch", { ids: [id(1), id(4)], direction: "vertical" })).json).toEqual({ error: "too large" });
		expect((await call("POST", "/compose/stitch", { ids: [id(1), id(9)], direction: "vertical" })).status).toBe(404);
		expect((await call("POST", "/compose/stitch", { ids: [id(1), id(1)], direction: "vertical" })).status).toBe(400);
		expect((await call("POST", "/compose/split", { id: id(1), direction: "vertical", cuts: [0.5, 0.501] })).json).toEqual({ error: "piece too small" });
		expect((await call("POST", "/compose/split", { id: id(1), direction: "vertical", cuts: [0.6, 0.4] })).status).toBe(400);
		const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs").first<{ n: number }>();
		expect(n!.n).toBe(0);
	});

	it("runs in the container even while a device has taken over", async () => {
		await seed(1);
		await seed(2);
		const [created] = (await call("POST", "/compose/stitch", { ids: [id(1), id(2)], direction: "vertical" })).json.assetIds as string[];
		await guardStub(env).renewDevice("mac");
		// 设备认领不到
		const claim = await call("POST", "/device/claim", { name: "mac", max: 4 });
		expect(claim.json.jobs).toEqual([]);
		expect(await run(created!)).toBe("ack");
		expect((await jobOf(created!))!.status).toBe("done");
	});
});
