import { SELF, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PRICING, estimateCost, type CostInput } from "@nana/shared";
import { guardStub } from "../src/guard";
import { computeLibraryStats } from "../src/library-stats";
import { usageStats } from "../src/stats";
import { authHeaders, mockAccessJwks } from "./helpers";

beforeAll(() => mockAccessJwks());

const now = Date.UTC(2026, 9, 10, 12);

async function asset(id: string, opts: { kind?: string; status?: string; deleted?: number | null; created?: number; files: [string, number][] }) {
	await env.DB.prepare(
		"INSERT INTO assets (id, kind, status, deleted_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0)",
	)
		.bind(id, opts.kind ?? "photo", opts.status ?? "ready", opts.deleted ?? null, opts.created ?? now)
		.run();
	for (const [i, [role, size]] of opts.files.entries()) {
		await env.DB.prepare("INSERT INTO asset_files (id, asset_id, role, r2_key, mime, size, created_at) VALUES (?, ?, ?, ?, 'x/y', ?, 0)")
			.bind(`${id}-${i}`, id, role, `k/${id}/${i}`, size)
			.run();
	}
}

beforeEach(async () => {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM uploads"),
		env.DB.prepare("DELETE FROM asset_fp"),
		env.DB.prepare("DELETE FROM asset_files"),
		env.DB.prepare("DELETE FROM assets"),
		env.DB.prepare("DELETE FROM library_stats"),
	]);
	await guardStub(env).reset();
});

describe("usage stats", () => {
	it("counts assets by kind and sums original bytes separately from derived files and trash", async () => {
		await asset("S1", { files: [["original", 1000], ["raw", 5000], ["thumb", 10], ["preview", 100]] });
		await asset("S2", { kind: "live", files: [["original", 2000], ["live_video", 3000], ["thumb", 10]] });
		await asset("S3", { kind: "video", files: [["original", 9000], ["poster", 50]] });
		await asset("S4", { deleted: now, files: [["original", 700], ["thumb", 5]] });
		await asset("S5", { status: "failed", files: [["original", 1]] });
		await asset("S6", { status: "processing", files: [["original", 1]] });
		await asset("S7", { status: "uploading", files: [] });
		await asset("OLD", { created: Date.UTC(2026, 7, 3), files: [["original", 400]] });

		const s = await usageStats(env, now);
		expect(s.library).toEqual({ photo: 2, video: 1, live: 1, processing: 1, failed: 1, trash: 1 });
		expect(s.storage.roles.original).toEqual({ files: 6, bytes: 1000 + 2000 + 9000 + 1 + 1 + 400 });
		expect(s.storage.roles.raw).toEqual({ files: 1, bytes: 5000 });
		expect(s.storage.roles.live_video).toEqual({ files: 1, bytes: 3000 });
		expect(s.storage.roles.thumb).toEqual({ files: 2, bytes: 20 });
		expect(s.storage.trash).toEqual({ files: 2, bytes: 705 });
		expect(s.monthStart).toBe(Date.UTC(2026, 9, 1));
		// 按上传月份：只算原件，不算回收站和还在上传的
		expect(s.growth).toEqual([
			{ month: "2026-08", assets: 1, bytes: 400 },
			{ month: "2026-10", assets: 5, bytes: 1000 + 5000 + 2000 + 3000 + 9000 + 2 },
		]);
	});

	it("summary: all stored bytes, ready photos (incl. live) and videos outside the trash", async () => {
		await asset("S1", { files: [["original", 1000], ["thumb", 10]] });
		await asset("S2", { kind: "live", files: [["original", 2000], ["live_video", 3000]] });
		await asset("S3", { kind: "video", files: [["original", 9000], ["poster", 50]] });
		await asset("S4", { deleted: now, files: [["original", 700]] });
		await asset("S5", { status: "processing", files: [["original", 1]] });
		const res = await SELF.fetch("http://example.com/api/stats/summary", { headers: await authHeaders() });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ bytes: 1010 + 5000 + 9050 + 700 + 1, photos: 2, videos: 1 });
	});

	it("summary: the counters follow every change without rescanning (triggers, including cascades)", async () => {
		const summary = async () =>
			(await (await SELF.fetch("http://example.com/api/stats/summary", { headers: await authHeaders() })).json()) as {
				bytes: number;
				photos: number;
				videos: number;
			};
		await asset("C1", { status: "processing", files: [["original", 100]] });
		await asset("C2", { kind: "video", status: "processing", files: [["original", 300]] });
		expect(await summary()).toEqual({ bytes: 400, photos: 0, videos: 0 });

		await env.DB.prepare("UPDATE assets SET status = 'ready' WHERE id IN ('C1', 'C2')").run();
		await env.DB.prepare(
			"INSERT INTO asset_files (id, asset_id, role, r2_key, mime, size, created_at) VALUES ('C1t', 'C1', 'thumb', 'k/C1t', 'x/y', 7, 0)",
		).run();
		expect(await summary()).toEqual({ bytes: 407, photos: 1, videos: 1 });

		// Live Photo 合并：视频条目并进照片（kind 改成 live，仍然算照片），视频条目删掉
		await env.DB.batch([
			env.DB.prepare("UPDATE asset_files SET asset_id = 'C1', role = 'live_video' WHERE asset_id = 'C2'"),
			env.DB.prepare("UPDATE assets SET kind = 'live' WHERE id = 'C1'"),
			env.DB.prepare("DELETE FROM assets WHERE id = 'C2'"),
		]);
		expect(await summary()).toEqual({ bytes: 407, photos: 1, videos: 0 });

		await env.DB.prepare("UPDATE assets SET deleted_at = 1 WHERE id = 'C1'").run();
		expect(await summary()).toEqual({ bytes: 407, photos: 0, videos: 0 }); // 回收站里的文件仍然占空间
		await env.DB.prepare("UPDATE assets SET deleted_at = NULL WHERE id = 'C1'").run();
		expect(await summary()).toEqual({ bytes: 407, photos: 1, videos: 0 });

		await env.DB.prepare("DELETE FROM assets WHERE id = 'C1'").run(); // 文件随条目级联删除
		expect(await summary()).toEqual({ bytes: 0, photos: 0, videos: 0 });
	});

	it("corrects drifted summary counters when the full stats are computed", async () => {
		await asset("D1", { files: [["original", 10]] });
		await env.DB.prepare("UPDATE storage_totals SET bytes = 999, photos = 5 WHERE id = 1").run();
		await usageStats(env, now);
		expect(await env.DB.prepare("SELECT bytes, photos, videos FROM storage_totals").first()).toEqual({ bytes: 10, photos: 1, videos: 0 });
	});

	it("includes incomplete uploads and indexed face vectors", async () => {
		await asset("U1", { status: "uploading", files: [] });
		await env.DB.prepare(
			`INSERT INTO uploads (id, asset_id, file_id, role, r2_key, r2_upload_id, mime, size, sha256, created_at)
			 VALUES ('up1', 'U1', 'f1', 'original', 'k/U1', 'r2up', 'image/jpeg', 12345, 'abc', 0)`,
		).run();
		await asset("V1", { files: [["original", 1]] });
		await env.DB.prepare(
			`INSERT INTO faces (id, asset_id, idx, x, y, w, h, px, score, sharpness, embedding, indexed, created_at)
			 VALUES ('F1', 'V1', 0, 0, 0, 0.1, 0.1, 100, 0.9, 1, x'00', 1, 0), ('F2', 'V1', 1, 0, 0, 0.1, 0.1, 100, 0.9, 1, x'00', 0, 0)`,
		).run();
		const s = await usageStats(env, now);
		expect(s.storage.uploads).toEqual({ files: 1, bytes: 12345 });
		expect(s.storage.vectors).toBe(1);
	});

	it("returns this month's guard usage from the daily history", async () => {
		const guard = guardStub(env);
		await guard.recordContainer(120);
		expect((await guard.reserveJob("H1")).ok).toBe(true);
		const s = await usageStats(env);
		expect(s.month.containerSeconds).toBe(120);
		expect(s.month.jobs).toBe(1);
		expect(s.days.at(-1)).toMatchObject({ day: new Date().toISOString().slice(0, 10), containerSeconds: 120, jobs: 1 });
	});

	it("is served behind authentication", async () => {
		const ok = await SELF.fetch("http://example.com/api/stats", { headers: await authHeaders() });
		expect(ok.status).toBe(200);
		expect(ok.headers.get("cache-control") ?? "").not.toContain("public");
		const denied = await SELF.fetch("http://example.com/api/stats");
		expect(denied.status).toBe(403);
	});
});

async function dated(id: string, day: string | null, opts: { kind?: string; camera?: string | null; status?: string; deleted?: number | null; size?: number } = {}) {
	await env.DB.prepare(
		`INSERT INTO assets (id, kind, status, deleted_at, local_day, local_month, camera, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)`,
	)
		.bind(id, opts.kind ?? "photo", opts.status ?? "ready", opts.deleted ?? null, day, day?.slice(0, 7) ?? null, opts.camera ?? null)
		.run();
	if (opts.size)
		await env.DB.prepare("INSERT INTO asset_files (id, asset_id, role, r2_key, mime, size, created_at) VALUES (?, ?, 'original', ?, 'x/y', ?, 0)")
			.bind(`${id}-o`, id, `k/${id}`, opts.size)
			.run();
}

describe("library stats", () => {
	it("counts visible assets by shooting day, month and camera", async () => {
		await dated("L1", "2026-10-09", { camera: "iPhone 15 Pro" });
		await dated("L2", "2026-10-09", { camera: "iPhone 15 Pro", kind: "live" });
		await dated("L3", "2026-10-01", { camera: "iPhone 15 Pro", kind: "video" });
		await dated("L4", "2024-03-05", { camera: "Sony ILCE-7M4" });
		await dated("L5", null);
		await dated("L6", "2026-10-09", { camera: "Sony ILCE-7M4", deleted: now });
		await dated("L7", "2026-10-09", { camera: "Sony ILCE-7M4", status: "pending" });

		const s = await computeLibraryStats(env, now);
		// 一年内的每日张数不含 2024 年的
		expect(s.days).toEqual([
			["2026-10-01", 1],
			["2026-10-09", 2],
		]);
		expect(s.months).toEqual([
			["2024-03", 1],
			["2026-10", 3],
		]);
		expect(s.noDate).toBe(1);
		expect(s.cameras).toEqual([
			{ camera: "iPhone 15 Pro", photos: 2, videos: 1 },
			{ camera: "Sony ILCE-7M4", photos: 1, videos: 0 },
		]);
		expect(s.unknownCamera).toEqual({ photos: 1, videos: 0 });
	});

	it("serves the stored snapshot and computes it once when missing", async () => {
		await dated("L1", "2026-10-09", { camera: "X" });
		const first = await SELF.fetch("http://example.com/api/stats/library", { headers: await authHeaders() });
		expect(first.status).toBe(200);
		expect(((await first.json()) as { months: unknown }).months).toEqual([["2026-10", 1]]);
		// 之后只读快照，新加的条目要等下一次 Cron
		await dated("L2", "2026-10-09", { camera: "X" });
		const second = (await (await SELF.fetch("http://example.com/api/stats/library", { headers: await authHeaders() })).json()) as { months: unknown };
		expect(second.months).toEqual([["2026-10", 1]]);
	});

	it("lists the largest photos (photo + live merged) and videos, outside the trash", async () => {
		await dated("P1", "2026-10-01", { size: 100 });
		await dated("P2", "2026-10-01", { kind: "live", size: 300 });
		await dated("P3", "2026-10-01", { size: 200 });
		await dated("P4", "2026-10-01", { size: 900, deleted: now });
		await dated("V1", "2026-10-01", { kind: "video", size: 5000 });
		const get = async (kind: string) =>
			(await (await SELF.fetch(`http://example.com/api/stats/largest/${kind}`, { headers: await authHeaders() })).json()) as {
				items: [string][];
				details: [string | null, number][];
				next: null;
			};
		const photos = await get("photo");
		expect(photos.items.map((i) => i[0])).toEqual(["P2", "P3", "P1"]);
		expect(photos.details.map((d) => d[1])).toEqual([300, 200, 100]);
		expect(photos.next).toBeNull();
		expect((await get("video")).items.map((i) => i[0])).toEqual(["V1"]);
		const bad = await SELF.fetch("http://example.com/api/stats/largest/raw", { headers: await authHeaders() });
		expect(bad.status).toBe(404);
	});
});

describe("cost estimate", () => {
	const zero: CostInput = {
		r2Bytes: 0,
		d1Bytes: 0,
		containerSeconds: 0,
		jobs: 0,
		vectorDims: 0,
	};

	it("costs only the base plan within the free allowances", () => {
		const e = estimateCost(zero);
		expect(e.total).toBe(PRICING.workersPaidMonthly);
		expect(e.missing).toBe(false);
	});

	it("charges storage above 10 GB and containers above the included usage", () => {
		const e = estimateCost({ ...zero, r2Bytes: 110e9, containerSeconds: 10 * 3600 });
		const cost = (k: string) => e.lines.find((l) => l.key === k)!.cost!;
		expect(cost("r2Storage")).toBeCloseTo((110e9 / 1024 ** 3 - 10) * 0.015);
		// 10 小时：CPU 36000 − 22500 秒；内存 3 × 36000 − 90000 GiB·s；磁盘 12 × 36000 − 720000 → 0
		expect(cost("containerCpu")).toBeCloseTo(13500 * 0.00002);
		expect(cost("containerMemory")).toBeCloseTo(18000 * 0.0000025);
		expect(cost("containerDisk")).toBe(0);
	});

	it("marks lines without data and leaves them out of the total", () => {
		const e = estimateCost({ ...zero, d1Bytes: null });
		expect(e.missing).toBe(true);
		expect(e.lines.find((l) => l.key === "d1Storage")!.cost).toBeNull();
		expect(e.total).toBe(PRICING.workersPaidMonthly);
	});
});
