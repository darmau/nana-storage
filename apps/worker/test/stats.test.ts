import { SELF, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
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
	]);
});

describe("storage summary", () => {
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

	it("is served behind authentication", async () => {
		const ok = await SELF.fetch("http://example.com/api/stats/summary", { headers: await authHeaders() });
		expect(ok.status).toBe(200);
		expect(ok.headers.get("cache-control") ?? "").not.toContain("public");
		const denied = await SELF.fetch("http://example.com/api/stats/summary");
		expect(denied.status).toBe(403);
	});
});

