import { SELF, env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { guardStub } from "../src/guard";
import { handleJobMessage, handlers } from "../src/jobs";
import { processAsset, type ProcessorLike, rotateAsset } from "../src/process";
import { replaceSearchRow } from "../src/search";
import { authHeaders, mockAccessJwks } from "./helpers";

beforeAll(() => mockAccessJwks());

const ID = (n: number) => `MET${String(n).padStart(23, "0")}`;
async function seed(n: number, o: { kind?: string; name?: string; camera?: string; day?: string; fav?: number } = {}) {
	const day = o.day ?? "2024-05-01";
	await env.DB.batch([
		env.DB.prepare(
			`INSERT INTO assets (id, kind, status, local_month, local_day, taken_at, tz_offset_min, width, height, camera, favorite, created_at, updated_at)
			 VALUES (?, ?, 'ready', ?, ?, ?, 480, 4000, 3000, ?, ?, 0, 0)`,
		).bind(ID(n), o.kind ?? "photo", day.slice(0, 7), day, Date.parse(`${day}T04:00:00Z`) + n, o.camera ?? null, o.fav ?? 0),
		env.DB.prepare(
			"INSERT INTO asset_files (id, asset_id, role, r2_key, mime, size, sha256, original_name, created_at) VALUES (?, ?, 'original', ?, 'image/jpeg', 100, ?, ?, 0)",
		).bind(`MF${n}`, ID(n), `o/${ID(n)}/MF${n}`, String(n).padStart(64, "0"), o.name ?? `IMG_${n}.JPG`),
		...replaceSearchRow(env, ID(n), o.name ?? `IMG_${n}.JPG`),
	]);
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
const row = (n: number) => env.DB.prepare("SELECT * FROM assets WHERE id = ?").bind(ID(n)).first<Record<string, any>>();

beforeEach(async () => {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM jobs"),
		env.DB.prepare("DELETE FROM asset_files"),
		env.DB.prepare("DELETE FROM asset_search"),
		env.DB.prepare("DELETE FROM asset_search_ids"),
		env.DB.prepare("DELETE FROM assets"),
	]);
	await guardStub(env).reset();
});

describe("batch metadata edits", () => {
	it("sets the same time on many assets and locks it", async () => {
		await seed(1);
		await seed(2, { day: "2024-06-01" });
		const r = await call("POST", "/assets/batch", {
			action: "set-time",
			ids: [ID(1), ID(2)],
			takenAt: { local: "2023-12-31T23:30", tzOffsetMin: -300 },
		});
		expect(r.json).toEqual({ changed: 2 });
		for (const n of [1, 2]) {
			const a = (await row(n))!;
			expect(new Date(a.taken_at).toISOString()).toBe("2024-01-01T04:30:00.000Z");
			expect(a).toMatchObject({ tz_offset_min: -300, local_day: "2023-12-31", local_month: "2023-12", meta_locked: 1 });
		}
		expect(
			(await call("POST", "/assets/batch", { action: "set-time", ids: [ID(1)], takenAt: { local: "2023-02-30T10:00", tzOffsetMin: 0 } }))
				.status,
		).toBe(400);
	});

	it("shifts times, recomputing the local day in each asset's own timezone", async () => {
		await seed(1); // 2024-05-01T04:00Z，UTC+8 → 本地 12:00
		await seed(2, { day: "2024-05-31" });
		await env.DB.prepare("UPDATE assets SET tz_offset_min = NULL WHERE id = ?").bind(ID(2)).run();
		await seed(3);
		await env.DB.prepare("UPDATE assets SET taken_at = NULL, local_day = NULL, local_month = NULL WHERE id = ?").bind(ID(3)).run();

		// +13 小时
		const r = await call("POST", "/assets/batch", {
			action: "shift-time",
			ids: [ID(1), ID(2), ID(3)],
			deltaMin: 13 * 60,
			fallbackTzOffsetMin: 0,
		});
		expect(r.json).toEqual({ changed: 2 }); // 没有拍摄时间的不改
		expect(await row(1)).toMatchObject({ taken_at: Date.parse("2024-05-01T17:00:00Z") + 1, local_day: "2024-05-02", local_month: "2024-05", tz_offset_min: 480, meta_locked: 1 });
		expect(await row(2)).toMatchObject({ local_day: "2024-05-31", local_month: "2024-05", tz_offset_min: 0 });
		expect(await row(3)).toMatchObject({ taken_at: null, meta_locked: 0 });

		// 平移到未来的不改
		const future = await call("POST", "/assets/batch", { action: "shift-time", ids: [ID(1)], deltaMin: 100 * 365 * 1440, fallbackTzOffsetMin: 0 });
		expect(future.json).toEqual({ changed: 0 });
	});

	it("sets and clears location in batch", async () => {
		await seed(1);
		await seed(2);
		await call("POST", "/assets/batch", { action: "set-location", ids: [ID(1), ID(2)], location: { lat: 35.6812, lon: 139.7671 } });
		expect(await row(2)).toMatchObject({ lat: 35.6812, lon: 139.7671, meta_locked: 2 });
		await call("POST", "/assets/batch", { action: "set-location", ids: [ID(1), ID(2)], location: null });
		expect(await row(1)).toMatchObject({ lat: null, lon: null, meta_locked: 2 });
	});
});

describe("PATCH /api/assets/:id", () => {
	it("edits the shooting time in its own timezone and moves it to the right month", async () => {
		await seed(1);
		const r = await call("PATCH", `/assets/${ID(1)}`, { takenAt: { local: "2023-12-31T23:30", tzOffsetMin: -300 } });
		expect(r.status).toBe(200);
		const a = (await row(1))!;
		expect(new Date(a.taken_at).toISOString()).toBe("2024-01-01T04:30:00.000Z");
		expect(a).toMatchObject({ tz_offset_min: -300, local_day: "2023-12-31", local_month: "2023-12", meta_locked: 1 });
		expect((await call("GET", "/timeline/month/2023-12")).json.map((i: unknown[]) => i[0])).toEqual([ID(1)]);
	});

	it("rejects impossible dates and future dates", async () => {
		await seed(1);
		expect((await call("PATCH", `/assets/${ID(1)}`, { takenAt: { local: "2023-02-30T10:00", tzOffsetMin: 0 } })).status).toBe(400);
		expect((await call("PATCH", `/assets/${ID(1)}`, { takenAt: { local: "2999-01-01T10:00", tzOffsetMin: 0 } })).status).toBe(400);
		expect((await call("PATCH", `/assets/${ID(1)}`, { bogus: 1 })).status).toBe(400);
	});

	it("sets and clears location", async () => {
		await seed(1);
		await call("PATCH", `/assets/${ID(1)}`, { location: { lat: 35.6812, lon: 139.7671 } });
		expect(await row(1)).toMatchObject({ lat: 35.6812, lon: 139.7671, meta_locked: 2 });
		await call("PATCH", `/assets/${ID(1)}`, { location: null });
		expect(await row(1)).toMatchObject({ lat: null, lon: null });
	});

	it("makes descriptions searchable", async () => {
		await seed(1);
		await call("PATCH", `/assets/${ID(1)}`, { description: "  东京塔的夜景  " });
		expect((await row(1))!.description).toBe("东京塔的夜景");
		expect((await call("GET", "/search?q=东京塔")).json.items.map((i: unknown[]) => i[0])).toEqual([ID(1)]);
		await call("PATCH", `/assets/${ID(1)}`, { description: "" });
		expect((await row(1))!.description).toBeNull();
		expect((await call("GET", "/search?q=东京塔")).json.items).toEqual([]);
	});

	it("rotation swaps dimensions, bumps the revision and coalesces into one pending job", async () => {
		await seed(1);
		await call("PATCH", `/assets/${ID(1)}`, { rotation: 90 });
		await call("PATCH", `/assets/${ID(1)}`, { rotation: 180 });
		await call("PATCH", `/assets/${ID(1)}`, { rotation: 270 });
		expect(await row(1)).toMatchObject({ rotation: 270, derived_rev: 3, width: 3000, height: 4000 });
		const { results } = await env.DB.prepare("SELECT kind, status FROM jobs WHERE asset_id = ?").bind(ID(1)).all();
		expect(results).toEqual([{ kind: "rotate", status: "pending" }]);
	});

	it("creates a new rotate job when the previous one is already running", async () => {
		await seed(1);
		await call("PATCH", `/assets/${ID(1)}`, { rotation: 90 });
		// 模拟消费者已经认领了第一个任务（它读到的是旧角度）
		await env.DB.prepare("UPDATE jobs SET status = 'running', started_at = ? WHERE asset_id = ?").bind(Date.now(), ID(1)).run();
		await call("PATCH", `/assets/${ID(1)}`, { rotation: 180 });
		await call("PATCH", `/assets/${ID(1)}`, { rotation: 270 }); // 和上一个排队中的任务合并
		const { results } = await env.DB.prepare("SELECT status FROM jobs WHERE asset_id = ? ORDER BY status").bind(ID(1)).all();
		expect(results).toEqual([{ status: "pending" }, { status: "running" }]);
	});

	it("refuses to rotate videos", async () => {
		await seed(1, { kind: "video" });
		expect((await call("PATCH", `/assets/${ID(1)}`, { rotation: 90 })).status).toBe(400);
		expect((await call("PATCH", `/assets/${ID(1)}`, { crop: { x: 0, y: 0, w: 0.5, h: 0.5 } })).status).toBe(400);
	});

	it("crop is stored, bumps the revision and lists report the cropped size", async () => {
		await seed(1); // 4000×3000
		await call("PATCH", `/assets/${ID(1)}`, { crop: { x: 0.1, y: 0.2, w: 0.5, h: 0.5 } });
		expect(await row(1)).toMatchObject({ crop_x: 0.1, crop_y: 0.2, crop_w: 0.5, crop_h: 0.5, derived_rev: 1, width: 4000, height: 3000 });
		const { results } = await env.DB.prepare("SELECT kind, status FROM jobs WHERE asset_id = ?").bind(ID(1)).all();
		expect(results).toEqual([{ kind: "rotate", status: "pending" }]);
		const month = (await call("GET", "/timeline/month/2024-05")).json as unknown[][];
		expect(month[0]!.slice(0, 3)).toEqual([ID(1), 2000, 1500]);
		// 同样的框不再改版本号
		await call("PATCH", `/assets/${ID(1)}`, { crop: { x: 0.1, y: 0.2, w: 0.5, h: 0.5 } });
		expect((await row(1))!.derived_rev).toBe(1);
	});

	it("rotating alone turns the crop with the picture; full-size or null crop clears it", async () => {
		await seed(1);
		await call("PATCH", `/assets/${ID(1)}`, { crop: { x: 0.1, y: 0.2, w: 0.5, h: 0.3 } });
		await call("PATCH", `/assets/${ID(1)}`, { rotation: 90 });
		// 顺时针 90°：{ x: 1 - y - h, y: x, w: h, h: w }
		expect(await row(1)).toMatchObject({ rotation: 90, crop_x: 0.5, crop_y: 0.1, crop_w: 0.3, crop_h: 0.5, width: 3000, height: 4000 });
		// 和角度一起提交的框按新的角度理解
		await call("PATCH", `/assets/${ID(1)}`, { rotation: 180, crop: { x: 0, y: 0, w: 0.5, h: 1 } });
		expect(await row(1)).toMatchObject({ rotation: 180, crop_x: 0, crop_y: 0, crop_w: 0.5, crop_h: 1 });
		await call("PATCH", `/assets/${ID(1)}`, { crop: { x: 0, y: 0, w: 1, h: 0.99999 } });
		expect(await row(1)).toMatchObject({ crop_x: null, crop_w: null });
		await call("PATCH", `/assets/${ID(1)}`, { crop: { x: 0.5, y: 0.5, w: 0.9, h: 0.9 } });
		// 超出图片的框收进图片里
		expect(await row(1)).toMatchObject({ crop_x: 0.1, crop_y: 0.1, crop_w: 0.9, crop_h: 0.9 });
		await call("PATCH", `/assets/${ID(1)}`, { crop: null });
		expect(await row(1)).toMatchObject({ crop_x: null, crop_y: null, crop_w: null, crop_h: null });
	});
});

// 假的 Processor：记录调用，返回固定的元数据
const calls: { inputKey: string; rotation: number; thumbKey: string; previewKey?: string; previewEdge?: number }[] = [];
const fake = (meta: Record<string, unknown>) =>
	(() => ({
		derive: async (i: (typeof calls)[number]) => {
			calls.push(i);
			return {
				ok: true,
				containerSeconds: 1,
				value: { meta, sha256: i.inputKey.endsWith("MF1") ? "1".padStart(64, "0") : "", size: 100, crc32: 1, width: 300, height: 400, thumbSize: 1, previewSize: 2 },
			};
		},
		meta: async () => ({ ok: true, containerSeconds: 1, value: { meta: {}, sha256: "", size: 100, crc32: 1 } }),
		transcode: async () => ({ ok: true, containerSeconds: 1, value: { size: 1 } }),
	})) as unknown as () => ProcessorLike;

describe("jobs respect manual edits", () => {
	const real = { process: handlers.process, rotate: handlers.rotate };
	afterEach(() => Object.assign(handlers, real));

	it("reprocessing keeps edited time and location but refreshes the rest", async () => {
		await seed(1);
		await call("PATCH", `/assets/${ID(1)}`, { takenAt: { local: "2020-01-02T03:04", tzOffsetMin: 540 }, location: { lat: 1, lon: 2 } });
		await env.DB.prepare("INSERT INTO jobs (id, asset_id, kind, status, attempts, updated_at) VALUES ('JP', ?, 'process', 'pending', 0, 0)")
			.bind(ID(1))
			.run();
		handlers.process = (job, e) =>
			processAsset(job, e, fake({ DateTimeOriginal: "2024:05:01 12:00:00", OffsetTimeOriginal: "+08:00", GPSLatitude: 31, GPSLongitude: 121, Model: "X100V", Make: "FUJIFILM" }));
		expect(await handleJobMessage({ jobId: "JP" }, env)).toBe("ack");
		expect(await row(1)).toMatchObject({ local_day: "2020-01-02", tz_offset_min: 540, lat: 1, lon: 2, camera: "FUJIFILM X100V", status: "ready" });
	});

	it("rotate job regenerates derived files at the current revision and deletes the old ones", async () => {
		await seed(1);
		await env.DB.prepare(
			"INSERT INTO asset_files (id, asset_id, role, r2_key, mime, size, created_at) VALUES ('T0', ?, 'thumb', 'd/old-thumb', 'image/webp', 1, 0), ('P0', ?, 'preview', 'd/old-preview', 'image/webp', 1, 0)",
		)
			.bind(ID(1), ID(1))
			.run();
		await env.PHOTOS.put("d/old-thumb", "x");
		await call("PATCH", `/assets/${ID(1)}`, { rotation: 90 });
		const job = await env.DB.prepare("SELECT id FROM jobs WHERE asset_id = ?").bind(ID(1)).first<{ id: string }>();
		calls.length = 0;
		handlers.rotate = (j, e) => rotateAsset(j, e, fake({}));
		expect(await handleJobMessage({ jobId: job!.id }, env)).toBe("ack");
		expect(calls).toEqual([expect.objectContaining({ rotation: 90, thumbKey: `d/${ID(1)}/thumb-1.webp` })]);
		const files = await env.DB.prepare("SELECT role, r2_key FROM asset_files WHERE asset_id = ? AND role IN ('thumb','preview') ORDER BY role")
			.bind(ID(1))
			.all();
		expect(files.results).toEqual([
			{ role: "preview", r2_key: `d/${ID(1)}/preview-1.webp` },
			{ role: "thumb", r2_key: `d/${ID(1)}/thumb-1.webp` },
		]);
		expect(await env.PHOTOS.head("d/old-thumb")).toBeNull();
		expect(await row(1)).toMatchObject({ rotation: 90, status: "ready" });
	});
});

describe("crop in the rotate job", () => {
	const real = { rotate: handlers.rotate };
	afterEach(() => Object.assign(handlers, real));
	const derivedRows = () =>
		env.DB.prepare("SELECT role, r2_key FROM asset_files WHERE asset_id = ? AND role IN ('thumb','preview') ORDER BY role")
			.bind(ID(1))
			.all()
			.then((r) => r.results);
	const runRotate = async () => {
		const job = await env.DB.prepare("SELECT id FROM jobs WHERE asset_id = ? AND status = 'pending'").bind(ID(1)).first<{ id: string }>();
		calls.length = 0;
		handlers.rotate = (j, e) => rotateAsset(j, e, fake({}));
		expect(await handleJobMessage({ jobId: job!.id }, env)).toBe("ack");
	};

	it("passes the crop and base key, and deletes base images of other revisions", async () => {
		await seed(1);
		await call("PATCH", `/assets/${ID(1)}`, { crop: { x: 0.1, y: 0.2, w: 0.5, h: 0.5 } });
		await runRotate();
		expect(calls).toEqual([
			expect.objectContaining({ crop: { x: 0.1, y: 0.2, w: 0.5, h: 0.5 }, baseKey: `d/${ID(1)}/base-1.webp`, thumbKey: `d/${ID(1)}/thumb-1.webp` }),
		]);
		expect(await derivedRows()).toEqual([
			{ role: "preview", r2_key: `d/${ID(1)}/preview-1.webp` },
			{ role: "thumb", r2_key: `d/${ID(1)}/thumb-1.webp` },
		]);

		// 底图不记在 asset_files 里：换了版本就按前缀删掉旧的
		await env.PHOTOS.put(`d/${ID(1)}/base-1.webp`, "x");
		await call("PATCH", `/assets/${ID(1)}`, { crop: { x: 0, y: 0, w: 0.5, h: 0.5 } });
		await runRotate();
		expect(calls).toEqual([expect.objectContaining({ baseKey: `d/${ID(1)}/base-2.webp` })]);
		await env.PHOTOS.put(`d/${ID(1)}/base-2.webp`, "x");
		expect(await env.PHOTOS.head(`d/${ID(1)}/base-1.webp`)).toBeNull();

		await call("PATCH", `/assets/${ID(1)}`, { crop: null });
		await runRotate();
		expect(calls).toEqual([expect.objectContaining({ crop: null, baseKey: undefined })]);
		expect(await env.PHOTOS.head(`d/${ID(1)}/base-2.webp`)).toBeNull();
	});
});

describe("POST /api/assets/:id/full-preview", () => {
	const real = { rotate: handlers.rotate };
	afterEach(() => Object.assign(handlers, real));
	const jobs = () => env.DB.prepare("SELECT id, kind, status FROM jobs WHERE asset_id = ?").bind(ID(1)).all<{ id: string; kind: string; status: string }>();

	it("queues one rotate job at the original size, then reports done", async () => {
		await seed(1); // 4000×3000
		const r = await call("POST", `/assets/${ID(1)}/full-preview`);
		expect(r.json).toEqual({ state: "queued", edge: 4000 });
		expect(await row(1)).toMatchObject({ preview_target: 4000, derived_rev: 1 });
		// 重复点击不会再建任务，也不会再改版本号
		expect((await call("POST", `/assets/${ID(1)}/full-preview`)).json).toEqual({ state: "queued", edge: 4000 });
		const { results } = await jobs();
		expect(results).toEqual([expect.objectContaining({ kind: "rotate", status: "pending" })]);
		expect((await row(1))!.derived_rev).toBe(1);

		calls.length = 0;
		handlers.rotate = (j, e) => rotateAsset(j, e, fake({}));
		expect(await handleJobMessage({ jobId: results[0]!.id }, env)).toBe("ack");
		expect(calls).toEqual([expect.objectContaining({ previewEdge: 4000, previewKey: `d/${ID(1)}/preview-1.webp` })]);
		expect(await row(1)).toMatchObject({ preview_edge: 4000 });
		expect((await call("POST", `/assets/${ID(1)}/full-preview`)).json).toEqual({ state: "done", edge: 4000 });

		// 之后再旋转，仍然按原图尺寸生成
		await call("PATCH", `/assets/${ID(1)}`, { rotation: 90 });
		const rot = (await jobs()).results.find((j) => j.status === "pending")!;
		calls.length = 0;
		expect(await handleJobMessage({ jobId: rot.id }, env)).toBe("ack");
		expect(calls).toEqual([expect.objectContaining({ rotation: 90, previewEdge: 4000 })]);
	});

	it("does nothing when the preview already covers the original", async () => {
		await seed(1);
		await env.DB.prepare("UPDATE assets SET width = 3000, height = 2000 WHERE id = ?").bind(ID(1)).run();
		expect((await call("POST", `/assets/${ID(1)}/full-preview`)).json).toEqual({ state: "done", edge: 3840 });
		expect((await jobs()).results).toEqual([]);
	});

	it("caps the size by pixel count and rejects videos and a tripped guard", async () => {
		await seed(1);
		await env.DB.prepare("UPDATE assets SET width = 12000, height = 8000 WHERE id = ?").bind(ID(1)).run();
		await guardStub(env).trip("test");
		expect((await call("POST", `/assets/${ID(1)}/full-preview`)).status).toBe(503);
		expect((await jobs()).results).toEqual([]);
		await guardStub(env).reset();
		// 12000×8000 = 9600 万像素 → 缩到 6000 万像素以内
		expect((await call("POST", `/assets/${ID(1)}/full-preview`)).json).toEqual({ state: "queued", edge: 9486 });
		await seed(2, { kind: "video" });
		expect((await call("POST", `/assets/${ID(2)}/full-preview`)).status).toBe(400);
	});
});

describe("GET /api/search", () => {
	beforeEach(async () => {
		await seed(1, { name: "IMG_1234.HEIC", camera: "Apple iPhone 15 Pro", day: "2024-05-01" });
		await seed(2, { name: "DSC_0001.ARW", camera: "SONY ILCE-7M4", day: "2023-08-15", fav: 1 });
		await seed(3, { name: "猫.jpg", kind: "video", day: "2022-01-01" });
	});
	const ids = async (qs: string) => (await call("GET", `/search?${qs}`)).json.items.map((i: unknown[]) => i[0]);

	it("matches file names via FTS (≥3 chars) and LIKE (short)", async () => {
		expect(await ids("q=1234")).toEqual([ID(1)]);
		expect(await ids("q=dsc_0")).toEqual([ID(2)]); // trigram 不区分大小写
		expect(await ids(`q=${encodeURIComponent("猫")}`)).toEqual([ID(3)]);
		expect(await ids("q=%25")).toEqual([]); // % 被当作普通字符
	});

	it("filters by date range, kind, favorite and camera", async () => {
		expect(await ids("from=2023-01-01&to=2023-12-31")).toEqual([ID(2)]);
		expect(await ids("kind=video")).toEqual([ID(3)]);
		expect(await ids("favorite=1")).toEqual([ID(2)]);
		expect(await ids(`camera=${encodeURIComponent("SONY ILCE-7M4")}`)).toEqual([ID(2)]);
		expect(await ids("")).toEqual([]);
	});

	it("survives FTS syntax in the query", async () => {
		expect((await call("GET", `/search?q=${encodeURIComponent('IMG" OR "x')}`)).status).toBe(200);
		expect((await call("GET", `/search?q=${encodeURIComponent("NEAR(a b)")}`)).status).toBe(200);
	});

	it("lists cameras", async () => {
		expect((await call("GET", "/search/cameras")).json.map((c: { camera: string }) => c.camera).sort()).toEqual([
			"Apple iPhone 15 Pro",
			"SONY ILCE-7M4",
		]);
	});
});

describe("derived file caching around rotation", () => {
	it("does not mark a stale derived file as immutable under the new revision", async () => {
		await seed(1);
		await env.DB.prepare(
			"INSERT INTO asset_files (id, asset_id, role, r2_key, mime, size, created_at) VALUES ('T0', ?, 'thumb', ?, 'image/webp', 1, 0)",
		)
			.bind(ID(1), `d/${ID(1)}/thumb-0.webp`)
			.run();
		await env.PHOTOS.put(`d/${ID(1)}/thumb-0.webp`, "old");
		const get = async (v: number) =>
			SELF.fetch(`http://example.com/api/a/${ID(1)}/thumb?v=${v}`, { headers: await authHeaders() });
		expect((await get(0)).headers.get("cache-control")).toContain("immutable");
		await call("PATCH", `/assets/${ID(1)}`, { rotation: 90 }); // derived_rev → 1，新图还没生成
		const stale = await get(1);
		expect(await stale.text()).toBe("old");
		expect(stale.headers.get("cache-control")).not.toContain("immutable");
	});

	it("serves a versioned derived file straight from R2, with range and conditional requests", async () => {
		// 没有 asset_files 行也能读到：说明这条路径不查 D1
		await env.PHOTOS.put(`d/${ID(7)}/preview-3.webp`, "0123456789");
		const get = async (headers: Record<string, string> = {}, query = "v=3") =>
			SELF.fetch(`http://example.com/api/a/${ID(7)}/preview?${query}`, { headers: { ...(await authHeaders()), ...headers } });

		const full = await get();
		expect(full.status).toBe(200);
		expect(await full.text()).toBe("0123456789");
		expect(full.headers.get("content-type")).toBe("image/webp");
		expect(full.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
		expect(full.headers.get("content-disposition")).toBeNull();
		// 不随 cookie 变：Access 会话续期后浏览器缓存的缩略图、预览仍然有效
		expect(full.headers.get("vary") ?? "").not.toContain("Cookie");
		expect(full.headers.get("content-security-policy")).toContain("default-src 'self'");

		const part = await get({ range: "bytes=2-4" });
		expect(part.status).toBe(206);
		expect(await part.text()).toBe("234");
		expect(part.headers.get("content-range")).toBe("bytes 2-4/10");

		const etag = full.headers.get("etag")!;
		expect((await get({ "if-none-match": etag })).status).toBe(304);

		// 其他版本、下载、不合法的版本号都走查 D1 的路径（这里没有对应的行，所以 404）
		expect((await get({}, "v=4")).status).toBe(404);
		expect((await get({}, "v=3&download=1")).status).toBe(404);
		expect((await get({}, "v=3.0")).status).toBe(404);
	});
});
