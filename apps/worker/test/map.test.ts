import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { authHeaders, mockAccessJwks } from "./helpers";

const ID = (n: number) => `MAP${String(n).padStart(23, "0")}`;

beforeAll(async () => {
	mockAccessJwks();
	const pts: [number, number, number, number | null][] = [
		// n, lat, lon, deleted
		[1, 31.2304, 121.4737, null], // 上海
		[2, 31.2310, 121.4740, null], // 上海（同一格）
		[3, 35.6812, 139.7671, null], // 东京
		[4, 13.7563, 100.5018, null], // 曼谷
		[5, 13.7563, 100.5018, Date.now()], // 回收站里，不显示
	];
	await env.DB.batch(
		pts.map(([n, lat, lon, del]) =>
			env.DB.prepare(
				`INSERT INTO assets (id, kind, status, lat, lon, taken_at, width, height, derived_rev, deleted_at, local_day, created_at, updated_at)
				 VALUES (?, 'photo', 'ready', ?, ?, ?, 4, 3, ?, ?, '2024-05-01', 0, 0)`,
			).bind(ID(n), lat, lon, 1714500000000 + n, n, del),
		),
	);
});

const get = async (path: string, headers: Record<string, string> = {}) =>
	SELF.fetch(`http://example.com/api/map${path}`, { headers: await authHeaders(headers) });

describe("map points", () => {
	it("clusters by grid cell and picks the latest asset as cover", async () => {
		const res = await get("/points?w=90&s=0&e=150&n=50&cell=1");
		const points = (await res.json()) as { count: number; lat: number; cover: string; bbox: number[] }[];
		expect(points).toHaveLength(3);
		const shanghai = points.find((p) => p.count === 2)!;
		expect(shanghai.lat).toBeCloseTo(31.2307, 3);
		expect(shanghai.cover).toBe(`${ID(2)}:2`); // 同一格里拍摄时间最新的那张
		expect(shanghai.bbox).toEqual([121 , 31, 122, 32]);
	});

	it("only returns points inside the bbox and excludes trash", async () => {
		const points = (await (await get("/points?w=95&s=5&e=110&n=20&cell=1")).json()) as { count: number }[];
		expect(points).toEqual([expect.objectContaining({ count: 1 })]);
	});

	it("lists assets inside a cell", async () => {
		const page = (await (await get("/assets?w=121&s=31&e=122&n=32")).json()) as { items: unknown[][] };
		expect(page.items.map((i) => i[0])).toEqual([ID(2), ID(1)]);
	});

	it("validates input", async () => {
		expect((await get("/points?w=0&s=0&e=1&n=1&cell=0")).status).toBe(400);
		expect((await get("/points?w=0&s=0&e=1&n=999&cell=1")).status).toBe(400);
	});
});

describe("map auth", () => {
	it("requires authentication", async () => {
		const res = await SELF.fetch("http://example.com/api/map/points?w=90&s=0&e=150&n=50&cell=1");
		expect(res.status).toBe(403);
	});

	it("no longer serves basemap files from R2", async () => {
		expect((await get("/tiles/world")).status).toBe(404);
		expect((await get("/config")).status).toBe(404);
	});
});
