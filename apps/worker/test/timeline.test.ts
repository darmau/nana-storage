import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { authHeaders, mockAccessJwks } from "./helpers";

beforeAll(async () => {
	mockAccessJwks();
	const rows: [string, string, string | null, number | null, string, number | null][] = [
		// id, kind, month, taken_at, status, deleted_at
		["a1", "photo", "2024-05", Date.UTC(2024, 4, 1), "ready", null],
		["a2", "live", "2024-05", Date.UTC(2024, 4, 20), "ready", null],
		["a3", "video", "2023-12", Date.UTC(2023, 11, 31), "ready", null],
		["a4", "photo", null, null, "ready", null],
		["a5", "photo", "2024-05", Date.UTC(2024, 4, 2), "processing", null], // 未处理完不显示
		["a6", "photo", "2024-05", Date.UTC(2024, 4, 3), "ready", Date.now()], // 回收站不显示
	];
	await env.DB.batch(
		rows.map(([id, kind, month, taken, status, deleted]) =>
			env.DB.prepare(
				`INSERT INTO assets (id, kind, status, local_month, local_day, taken_at, width, height, deleted_at, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, 400, 300, ?, 0, 0)`,
			).bind(id, kind, status, month, month ? `${month}-01` : null, taken, deleted),
		),
	);
});

const get = async (path: string) => SELF.fetch(`http://example.com/api${path}`, { headers: await authHeaders() });

describe("timeline API", () => {
	it("returns month buckets newest first, unknown dates last, excluding trash and unfinished", async () => {
		const res = await get("/timeline/buckets");
		expect(await res.json()).toEqual([
			{ month: "2024-05", count: 2 },
			{ month: "2023-12", count: 1 },
			{ month: "unknown", count: 1 },
		]);
	});

	it("returns a month's items newest first in compact form", async () => {
		const items = (await (await get("/timeline/month/2024-05")).json()) as unknown[][];
		expect(items.map((i) => i[0])).toEqual(["a2", "a1"]);
		expect(items[0]).toEqual(["a2", 400, 300, 2, "2024-05-01", null, 0, 0]);
	});

	it("returns undated items", async () => {
		const items = (await (await get("/timeline/month/unknown")).json()) as unknown[][];
		expect(items.map((i) => i[0])).toEqual(["a4"]);
	});

	it("rejects malformed months", async () => {
		expect((await get("/timeline/month/2024-5'")).status).toBe(400);
	});

	it("uses the month index without a temp sort", async () => {
		const { results } = await env.DB.prepare(
			`EXPLAIN QUERY PLAN SELECT id FROM assets WHERE local_month = ? AND deleted_at IS NULL AND status = 'ready'
			 ORDER BY taken_at DESC, id DESC`,
		)
			.bind("2024-05")
			.all<{ detail: string }>();
		const plan = results.map((r) => r.detail).join(" | ");
		expect(plan).toContain("assets_month");
		expect(plan).not.toContain("TEMP B-TREE");
	});

	it("folds a burst into one cover (favorite first, else earliest) carrying all frame ids", async () => {
		const t0 = Date.UTC(2022, 2, 1, 10);
		await env.DB.batch(
			[
				["B0000000000000000000000001", t0, 0],
				["B0000000000000000000000002", t0 + 200, 0],
				["B0000000000000000000000003", t0 + 400, 0],
			].map(([id, taken, fav]) =>
				env.DB.prepare(
					`INSERT INTO assets (id, kind, status, local_month, local_day, taken_at, width, height, favorite, burst_id, created_at, updated_at)
					 VALUES (?, 'photo', 'ready', '2022-03', '2022-03-01', ?, 400, 300, ?, 'B', 0, 0)`,
				).bind(id, taken, fav),
			),
		);
		const buckets = (await (await get("/timeline/buckets")).json()) as { month: string; count: number }[];
		expect(buckets.find((b) => b.month === "2022-03")!.count).toBe(1);
		let items = (await (await get("/timeline/month/2022-03")).json()) as unknown[][];
		expect(items).toHaveLength(1);
		expect(items[0]![0]).toBe("B0000000000000000000000001");
		expect(items[0]![8]).toEqual(["B0000000000000000000000001", "B0000000000000000000000002", "B0000000000000000000000003"]);

		await env.DB.prepare("UPDATE assets SET favorite = 1 WHERE id = 'B0000000000000000000000003'").run();
		items = (await (await get("/timeline/month/2022-03")).json()) as unknown[][];
		expect(items[0]![0]).toBe("B0000000000000000000000003");

		const frames = (await (await get("/bursts/B0000000000000000000000002/assets")).json()) as { items: unknown[][] };
		expect(frames.items.map((i) => i[0])).toEqual(["B0000000000000000000000001", "B0000000000000000000000002", "B0000000000000000000000003"]);
	});
});

describe("conditional requests and D1 sessions", () => {
	const fetchWith = async (path: string, extra: Record<string, string> = {}) =>
		SELF.fetch(`http://example.com/api${path}`, { headers: { ...(await authHeaders()), ...extra } });

	it("answers 304 while the data is unchanged and a fresh body after a visible asset changes", async () => {
		const first = await fetchWith("/timeline/buckets");
		const etag = first.headers.get("etag")!;
		expect(etag).toMatch(/^W\/".+-\d+"$/);
		await first.arrayBuffer();

		const again = await fetchWith("/timeline/buckets", { "if-none-match": etag });
		expect(again.status).toBe(304);
		expect(again.headers.get("cache-control")).toBe("private, no-cache");

		// 其他列表接口共用同一个版本号
		const month = await fetchWith("/timeline/month/2024-05", { "if-none-match": etag });
		expect(month.status).toBe(304);

		await env.DB.prepare("UPDATE assets SET favorite = 1 WHERE id = 'a1'").run(); // 触发器把版本号加一
		const changed = await fetchWith("/timeline/buckets", { "if-none-match": etag });
		expect(changed.status).toBe(200);
		expect(changed.headers.get("etag")).not.toBe(etag);
		await changed.arrayBuffer();
	});

	it("GET /sync reports the data version and whether jobs are still pending", async () => {
		const read = async () => (await (await fetchWith("/sync")).json()) as { v: number; busy: boolean };
		const before = await read();
		expect(before.busy).toBe(false);
		expect(before.v).toBe((await env.DB.prepare("SELECT v FROM data_version").first<{ v: number }>())!.v);

		await env.DB.prepare(
			"INSERT INTO jobs (id, asset_id, kind, status, attempts, updated_at) VALUES ('JS1', 'a5', 'process', 'pending', 0, 0)",
		).run();
		await env.DB.prepare("UPDATE assets SET status = 'ready' WHERE id = 'a5'").run();
		const during = await read();
		expect(during.busy).toBe(true);
		expect(during.v).toBeGreaterThan(before.v);

		await env.DB.prepare("UPDATE jobs SET status = 'done' WHERE id = 'JS1'").run();
		expect((await read()).busy).toBe(false);
		await env.DB.batch([
			env.DB.prepare("DELETE FROM jobs WHERE id = 'JS1'"),
			env.DB.prepare("UPDATE assets SET status = 'processing' WHERE id = 'a5'"),
		]);
	});

	it("bumps the list version on album changes, but not the sync version (migration 0018)", async () => {
		const sync = async () => (await env.DB.prepare("SELECT v FROM data_version").first<{ v: number }>())!.v;
		const list = async () => (await env.DB.prepare("SELECT v FROM cache_versions WHERE name = 'library'").first<{ v: number }>())!.v;
		const [syncBefore, listBefore] = [await sync(), await list()];
		await env.DB.prepare("INSERT INTO albums (id, name, created_at, updated_at) VALUES ('AL1', 'x', 0, 0)").run();
		await env.DB.prepare("INSERT INTO album_assets (album_id, asset_id, added_at) VALUES ('AL1', 'a1', 0)").run();
		expect(await sync()).toBe(syncBefore);
		expect(await list()).toBe(listBefore + 2);
	});

	it("does not use ETags on endpoints whose result depends on other tables or the clock", async () => {
		for (const path of ["/folders/root/unfinished", "/sync", "/stats/summary", "/people/x/review"]) {
			const res = await fetchWith(path);
			expect(res.headers.get("etag"), path).toBeNull();
			await res.arrayBuffer();
		}
	});

	const version = async (name: string) =>
		(await env.DB.prepare("SELECT v FROM cache_versions WHERE name = ?").bind(name).first<{ v: number }>())!.v;

	it("keeps list ETags while uploads and processing only change invisible assets", async () => {
		const first = await fetchWith("/folders/root");
		const etag = first.headers.get("etag")!;
		expect(etag).toBeTruthy();
		await first.arrayBuffer();
		const before = await version("library");

		// 上传、排队、处理中、失败：列表里看不到，不改版本号（data_version 照常加一，资料库同步靠它）
		await env.DB.prepare(
			"INSERT INTO assets (id, kind, status, created_at, updated_at) VALUES ('up1', 'photo', 'uploading', 0, 0)",
		).run();
		await env.DB.prepare("UPDATE assets SET status = 'pending' WHERE id = 'up1'").run();
		await env.DB.prepare("UPDATE assets SET status = 'processing' WHERE id = 'up1'").run();
		await env.DB.prepare("UPDATE assets SET status = 'failed' WHERE id = 'up1'").run();
		expect(await version("library")).toBe(before);
		expect((await fetchWith("/folders/root", { "if-none-match": etag })).status).toBe(304);

		// 处理完、移进回收站、文件夹变化：都会让列表变，版本号加一
		await env.DB.prepare("UPDATE assets SET status = 'ready' WHERE id = 'up1'").run();
		expect(await version("library")).toBe(before + 1);
		await env.DB.prepare("UPDATE assets SET deleted_at = 1 WHERE id = 'up1'").run();
		await env.DB.prepare("DELETE FROM assets WHERE id = 'up1'").run();
		await env.DB.prepare("INSERT INTO folders (id, parent_id, name, created_at) VALUES ('FV1', NULL, 'v', 0)").run();
		expect(await version("library")).toBe(before + 4);
		const changed = await fetchWith("/folders/root", { "if-none-match": etag });
		expect(changed.status).toBe(200);
		expect(((await changed.json()) as { children: { id: string }[] }).children.map((c) => c.id)).toContain("FV1");
		await env.DB.prepare("DELETE FROM folders WHERE id = 'FV1'").run();
	});

	it("gives people and smart sets their own versions on top of the library version", async () => {
		const people = await fetchWith("/people");
		const sets = await fetchWith("/smart-sets");
		const timeline = await fetchWith("/timeline/buckets");
		const [pe, se, te] = [people, sets, timeline].map((r) => r.headers.get("etag")!) as [string, string, string];
		await Promise.all([people.arrayBuffer(), sets.arrayBuffer(), timeline.arrayBuffer()]);
		expect(pe).toMatch(/^W\/".+-\d+\.\d+"$/);

		// 人物的变化不影响时间线和主题
		await env.DB.prepare("INSERT INTO people (id, name, created_at, updated_at) VALUES ('P1', 'x', 0, 0)").run();
		expect((await fetchWith("/people", { "if-none-match": pe })).status).toBe(200);
		expect((await fetchWith("/smart-sets", { "if-none-match": se })).status).toBe(304);
		expect((await fetchWith("/timeline/buckets", { "if-none-match": te })).status).toBe(304);

		// 条目的变化影响所有列表（人物和主题里的照片也要过滤回收站）
		await env.DB.prepare("UPDATE assets SET favorite = 0 WHERE id = 'a1'").run();
		expect((await fetchWith("/smart-sets", { "if-none-match": se })).status).toBe(200);
		await env.DB.prepare("DELETE FROM people WHERE id = 'P1'").run();
	});

	it("does not give an ETag to smart sets while one is refreshing (the lock can expire without a write)", async () => {
		await env.DB.prepare(
			"INSERT INTO smart_sets (id, name, created_at, updated_at, labels_changed_at, refreshing_until) VALUES ('SS1', 's', 0, 0, 0, ?)",
		)
			.bind(Date.now() + 60_000)
			.run();
		for (const path of ["/smart-sets", "/smart-sets/SS1"]) {
			const res = await fetchWith(path);
			expect(res.status).toBe(200);
			expect(res.headers.get("etag"), path).toBeNull();
			expect(res.headers.get("cache-control")).toBe("private, no-store");
			await res.arrayBuffer();
		}
		await env.DB.prepare("UPDATE smart_sets SET refreshing_until = NULL WHERE id = 'SS1'").run();
		const res = await fetchWith("/smart-sets/SS1");
		expect(res.headers.get("etag")).toBeTruthy();
		await res.arrayBuffer();
		await env.DB.prepare("DELETE FROM smart_sets WHERE id = 'SS1'").run();
	});

	it("returns a D1 bookmark and accepts it back, ignoring malformed ones", async () => {
		const res = await fetchWith("/timeline/buckets");
		await res.arrayBuffer();
		const bookmark = res.headers.get("x-d1-bookmark")!;
		expect(bookmark).toMatch(/^[0-9a-f-]{16,128}$/);
		const next = await fetchWith("/timeline/buckets", { "x-d1-bookmark": bookmark });
		expect(next.status).toBe(200);
		expect(next.headers.get("x-d1-bookmark")).toBeTruthy();
		await next.arrayBuffer();
		const bad = await fetchWith("/timeline/buckets", { "x-d1-bookmark": "not a bookmark; drop table" });
		expect(bad.status).toBe(200);
		await bad.arrayBuffer();
	});
});
