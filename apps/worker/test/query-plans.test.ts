import { SELF, env } from "cloudflare:test";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FP_MODEL_VER } from "@nana/shared";
import { deleteSearchRows, replaceSearchRow, searchSource, updateSearchDescription } from "../src/search";
import { refreshSmartSet } from "../src/similar";
import { authHeaders, mockAccessJwks } from "./helpers";

/**
 * 列表查询的执行计划（迁移 0018）。测试库和全新部署一样没有统计信息（sqlite_stat1），
 * 这时 SQLite 遇到 ORDER BY taken_at DESC, id DESC 会倾向于选 assets_timeline、逐行过滤，读完整个资料库。
 * 这里记下接口实际执行的每条 SQL，再用 EXPLAIN QUERY PLAN 确认它们走的是对应的窄索引。
 */

beforeAll(() => mockAccessJwks());
afterEach(() => vi.restoreAllMocks());

const ID = (n: number) => `QP${String(n).padStart(24, "0")}`;

/** 请求一个接口，返回它执行过的 SQL 和参数。 */
async function capture(path: string): Promise<{ sql: string; binds: unknown[] }[]> {
	const seen: { sql: string; binds: unknown[] }[] = [];
	const withSession = env.DB.withSession.bind(env.DB);
	vi.spyOn(env.DB, "withSession").mockImplementation((arg?: string) => {
		const session = withSession(arg as never);
		const prepare = session.prepare.bind(session);
		session.prepare = (sql: string) => {
			const stmt = prepare(sql);
			const entry = { sql, binds: [] as unknown[] };
			seen.push(entry);
			const bind = stmt.bind.bind(stmt);
			stmt.bind = (...values: unknown[]) => {
				entry.binds = values;
				return bind(...values);
			};
			return stmt;
		};
		return session;
	});
	const res = await SELF.fetch(`http://example.com/api${path}`, { headers: await authHeaders() });
	expect(res.status, path).toBe(200);
	await res.arrayBuffer();
	vi.restoreAllMocks();
	mockAccessJwks();
	return seen;
}

/** 直接调用（不经过接口的后台代码，比如 Cron、队列消费者里的写入），返回期间准备过的 SQL 和参数。 */
async function captureDirect(run: () => unknown): Promise<{ sql: string; binds: unknown[] }[]> {
	const seen: { sql: string; binds: unknown[] }[] = [];
	const prepare = env.DB.prepare.bind(env.DB);
	vi.spyOn(env.DB, "prepare").mockImplementation((sql: string) => {
		const stmt = prepare(sql);
		const entry = { sql, binds: [] as unknown[] };
		seen.push(entry);
		const bind = stmt.bind.bind(stmt);
		stmt.bind = (...values: unknown[]) => {
			entry.binds = values;
			return bind(...values);
		};
		return stmt;
	});
	try {
		await run();
	} finally {
		vi.restoreAllMocks();
		mockAccessJwks();
	}
	return seen;
}

async function plan(sql: string, binds: unknown[]): Promise<string> {
	const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
		.bind(...binds)
		.all<{ detail: string }>();
	return results.map((r) => r.detail).join(" | ");
}

/** 这个接口里读 assets 列表的那条查询（带 LIMIT 的分页查询）的执行计划。 */
async function listPlan(path: string, match: RegExp = /LIMIT \? OFFSET \?$/): Promise<string> {
	const stmts = await capture(path);
	const list = stmts.find((s) => match.test(s.sql.trim()));
	expect(list, `${path}: no list query`).toBeTruthy();
	return plan(list!.sql, list!.binds);
}

/**
 * 线上 0018 的 PRAGMA optimize 收集到的统计信息（迁移 0019 删掉了，这里还原出来）：deleted_at 几乎都是 NULL，
 * ANALYZE 却估成 deleted_at = ? 只有 34 行，规划器因此每个文件夹都顺着 assets_timeline 扫完整个资料库。
 * 同样的断言在这种统计信息下也要成立：以后有人再跑 ANALYZE，常用的列表也不会退化。
 */
const SKEWED_STATS: [string, string][] = [
	["assets_timeline", "152971 34 1 1"],
	["assets_folder_visible", "152643 223 1 1"],
	["assets_folder", "152972 223 1"],
	["assets_month", "152643 36 1 1"],
	["assets_favorite_visible", "0 0 0 0 0"],
	["assets_archived_visible", "0 0 0 0 0"],
	["assets_deleted", "329 5"],
	["assets_burst", "4132 7"],
	["assets_geo", "13950 4 2"],
	["sqlite_autoindex_assets_1", "152972 1"],
];

for (const stats of [false, true]) describe(`list query plans ${stats ? "with skewed statistics" : "without statistics"}`, () => {
	if (stats) {
		beforeAll(async () => {
			// ANALYZE sqlite_schema 不扫数据表，只建 sqlite_stat1 并让规划器重新加载统计信息
			await env.DB.prepare("ANALYZE sqlite_schema").run();
			await env.DB.batch(SKEWED_STATS.map(([idx, stat]) => env.DB.prepare("INSERT INTO sqlite_stat1 (tbl, idx, stat) VALUES ('assets', ?, ?)").bind(idx, stat)));
			await env.DB.prepare("ANALYZE sqlite_schema").run();
		});
		afterAll(async () => {
			await env.DB.prepare("DELETE FROM sqlite_stat1").run();
			await env.DB.prepare("ANALYZE sqlite_schema").run();
		});
	}

	beforeAll(async () => {
		// 两组共用同一份数据（存储在同一个文件的 describe 之间不重置）
		if (await env.DB.prepare("SELECT 1 FROM folders WHERE id = 'QPFOLDER00000000000000000A'").first()) return;
		await env.DB.batch([
			env.DB.prepare("INSERT INTO folders (id, parent_id, name, created_at) VALUES ('QPFOLDER00000000000000000A', NULL, 'qp', 0)"),
			env.DB.prepare(
				"INSERT INTO people (id, name, hidden, favorite, created_at, updated_at) VALUES ('QPPERSON00000000000000000A', 'qp', 0, 0, 0, 0)",
			),
			env.DB.prepare("INSERT INTO albums (id, name, created_at, updated_at) VALUES ('QPALBUM000000000000000000A', 'qp', 0, 0)"),
		]);
		for (let i = 1; i <= 20; i++) {
			await env.DB.prepare(
				`INSERT INTO assets (id, kind, status, local_month, local_day, taken_at, width, height, folder_id, favorite, burst_id, lat, lon, created_at, updated_at)
				 VALUES (?, 'photo', 'ready', '2024-05', '2024-05-01', ?, 4, 3, ?, ?, ?, ?, ?, 0, 0)`,
			)
				.bind(ID(i), 1714500000000 + i, i % 2 ? "QPFOLDER00000000000000000A" : null, i % 3 ? 0 : 1, i < 3 ? "qp-burst" : null, i % 4 ? null : 35, i % 4 ? null : 139)
				.run();	await env.DB.prepare("INSERT INTO album_assets (album_id, asset_id, added_at) VALUES ('QPALBUM000000000000000000A', ?, 0)").bind(ID(i)).run();
		}
		await env.DB.prepare(
			`INSERT INTO faces (id, asset_id, idx, x, y, w, h, px, score, sharpness, embedding, person_id, assigned, state, created_at)
			 VALUES ('QPFACE000000000000000000A', ?, 0, 0, 0, 0.1, 0.1, 100, 1, 1, x'00', 'QPPERSON00000000000000000A', 2, 2, 0)`,
		)
			.bind(ID(1))
			.run();
	});

	const cases: [string, string, RegExp][] = [
		["folder", "/folders/QPFOLDER00000000000000000A/assets", /assets_folder_visible/],
		["root folder", "/folders/root/assets", /assets_folder_visible/],
		["folder, list view", "/folders/root/assets?view=list", /assets_folder_visible/],
		["folder filtered by person", "/folders/QPFOLDER00000000000000000A/people/QPPERSON00000000000000000A/assets", /faces_person/],
		["folder with archived", "/folders/QPFOLDER00000000000000000A/assets?archived=1", /assets_folder_visible/],
		["folder sorted by name", "/folders/QPFOLDER00000000000000000A/assets?sort=name", /assets_folder_visible/],
		["root folder sorted by format", "/folders/root/assets?sort=format&order=asc", /assets_folder_visible/],
		["folder sorted by size, list view", "/folders/root/assets?sort=size&view=list", /assets_folder_visible/],
		["folder sorted by upload time", "/folders/QPFOLDER00000000000000000A/assets?sort=uploaded&order=asc", /assets_folder_visible/],
		["folder sorted by taken, ascending", "/folders/QPFOLDER00000000000000000A/assets?sort=taken&order=asc", /assets_folder_visible/],
		["favorites", "/favorites/assets", /assets_favorite_visible/],
		["archive", "/archive/assets", /assets_archived_visible/],
		["archive filtered by type", "/archive/assets?type=burst", /assets_archived_visible/],
		["burst", `/bursts/${ID(1)}/assets`, /assets_burst/],
		["person", "/people/QPPERSON00000000000000000A/assets", /faces_person/],
	];
	for (const [name, path, index] of cases) {
		it(`${name} uses its own index`, async () => {
			const p = await listPlan(path);
			expect(p, p).toMatch(index);
			expect(p, p).not.toMatch(/assets_timeline/);
		});
	}

	it("map queries use the geo index", async () => {
		for (const path of ["/map/points?w=-180&s=-90&e=180&n=90&cell=1", "/map/assets?w=-180&s=-90&e=180&n=90"]) {
			const stmts = await capture(path);
			const p = await plan(stmts.at(-1)!.sql, stmts.at(-1)!.binds);
			expect(p, p).toMatch(/assets_geo/);
		}
	});

	it("folder detail reads only the subtree's rows", async () => {
		for (const path of ["/folders/root", "/folders/QPFOLDER00000000000000000A"]) {
			const stmt = (await capture(path)).find((s) => s.sql.includes("WITH RECURSIVE tree"));
			const p = await plan(stmt!.sql, stmt!.binds);
			expect(p, p).not.toMatch(/assets_timeline/);
			expect(p, p).toMatch(/assets_folder_visible/);
		}
	});

	// 其他接口里读 assets 的查询：不能顺着 assets_timeline（deleted_at = NULL）扫完整个资料库
	const others: [string, RegExp][] = [
		["/timeline/month/2024-05", /FROM assets INDEXED BY assets_month/],
		["/timeline/month/unknown", /FROM assets INDEXED BY assets_month/],
		["/albums", /WITH stats/],
		["/albums/QPALBUM000000000000000000A/assets", /LIMIT \? OFFSET \?$/],
		["/albums/QPALBUM000000000000000000A/assets?archived=1", /LIMIT \? OFFSET \?$/],
		["/search?q=abc", /LIMIT \? OFFSET \?$/],
		["/search?q=ab", /LIMIT \? OFFSET \?$/],
		["/search?q=abc&favorite=1", /LIMIT \? OFFSET \?$/],
		["/people", /COUNT\(DISTINCT f.asset_id\)/],
		["/duplicates", /FROM duplicate_pairs p/],
		["/similar-groups", /INDEXED BY asset_fp_similar_queue/],
	];
	for (const [path, match] of others) {
		it(`${path} does not scan the whole library`, async () => {
			const stmt = (await capture(path)).find((s) => match.test(s.sql.trim()));
			expect(stmt, `${path}: query not found`).toBeTruthy();
			const p = await plan(stmt!.sql, stmt!.binds);
			expect(p, p).not.toMatch(/assets_timeline/);
			expect(p, p).not.toMatch(/SCAN a\b(?! USING)/);
		});
	}

	it("largest photos and videos read only the top rows of assets_size", async () => {
		for (const path of ["/stats/largest/photo", "/stats/largest/video"]) {
			const stmts = (await capture(path)).filter((s) => s.sql.includes("INDEXED BY assets_size"));
			expect(stmts.length, path).toBeGreaterThan(0);
			for (const stmt of stmts) {
				const p = await plan(stmt.sql, stmt.binds);
				expect(p, p).toMatch(/assets_size/);
				expect(p, p).not.toMatch(/TEMP B-TREE/);
			}
		}
	});

	// FTS5 的非全文列没有索引：按条目 id 过滤 FTS 表本身会扫描整个索引（线上每处理一张照片读 24 万行），只能按 rowid 定位
	it("full-text index writes locate rows by rowid", async () => {
		const stmts = await captureDirect(() => [
			...replaceSearchRow(env, ID(1), "IMG_1.JPG"),
			updateSearchDescription(env, ID(1), "x"),
			...deleteSearchRows(env, [ID(1), ID(2)]),
		]);
		expect(stmts.length).toBe(6);
		for (const stmt of stmts) {
			const p = await plan(stmt.sql, stmt.binds);
			expect(p, `${stmt.sql}\n${p}`).not.toMatch(/VIRTUAL TABLE INDEX 0:( |$)/);
			expect(p, p).not.toMatch(/SCAN (asset_search_ids|assets)\b(?! USING)/);
		}
		for (const q of ["abc", "ab"]) {
			const p = await plan(`SELECT * FROM ${searchSource(q).sql}`, searchSource(q).binds);
			expect(p, p).toMatch(/SEARCH i USING INTEGER PRIMARY KEY/);
		}
	});

	// 主题更新：全库扫描按 asset_fp 的主键分页、背景样本按 rowid 读几段，每页只读这一页的行。
	// 规划器自己选时会顺着 assets_timeline 读完整个资料库再排序，每页都读一遍全库（线上每页约 50 万行）
	it("smart set refresh reads asset_fp page by page", async () => {
		await env.DB.batch([
			...Array.from({ length: 20 }, (_, i) =>
				env.DB.prepare(
					`INSERT OR IGNORE INTO asset_fp (asset_id, model, phash, b0, b1, b2, b3, b4, embedding, indexed, updated_at)
					 VALUES (?, ?, '0000000000000000', 0, 0, 0, 0, 0, randomblob(512), 1, 0)`,
				).bind(ID(i + 1), FP_MODEL_VER),
			),
			env.DB.prepare("INSERT OR IGNORE INTO smart_sets (id, name, created_at, updated_at) VALUES ('QPSET000000000000000000000', 'qp', 0, 0)"),
			env.DB.prepare(
				"INSERT OR IGNORE INTO smart_set_examples (set_id, asset_id, label, created_at) VALUES ('QPSET000000000000000000000', ?, 1, 0)",
			).bind(ID(1)),
		]);
		const stmts = (await captureDirect(() => refreshSmartSet(env, "QPSET000000000000000000000"))).filter((s) =>
			s.sql.includes("FROM asset_fp f"),
		);
		expect(stmts.some((s) => s.sql.includes("f.asset_id > ?")), "scan query not found").toBe(true);
		expect(stmts.some((s) => s.sql.includes("f.rowid >= ?")), "background query not found").toBe(true);
		for (const stmt of stmts) {
			const p = await plan(stmt.sql, stmt.binds);
			expect(p, p).not.toMatch(/assets_timeline/);
			expect(p, p).not.toMatch(/TEMP B-TREE/);
		}
	});

	it("folder people read only the folder's rows", async () => {
		for (const path of ["/folders/root/people", "/folders/QPFOLDER00000000000000000A/people"]) {
			const stmt = (await capture(path)).find((s) => s.sql.includes("WITH here"));
			const p = await plan(stmt!.sql, stmt!.binds);
			expect(p, p).toMatch(/assets_folder_visible/);
		}
	});
});
