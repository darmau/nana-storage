import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { FP_MODEL_VER, STACK_MAX_MEMBERS } from "@nana/shared";
import { clusterDay, maybeStack, rebuildStacksChunk, type StackRow } from "../src/stacks";
import { authHeaders, mockAccessJwks } from "./helpers";

/**
 * 相似照片折叠：按天 leader 聚类（phash + 余弦双阈值）、时间线折叠、展开用的成员接口、
 * “不折叠这组”、分批补建。指纹直接用构造的向量，不启动容器。
 */

beforeAll(() => mockAccessJwks());

const req = async (path: string, method = "GET", json?: unknown) =>
	SELF.fetch(`http://example.com/api${path}`, {
		method,
		headers: {
			...(await authHeaders()),
			...(method === "GET" ? {} : { Origin: "http://example.com", "X-Requested-With": "nana", "Content-Type": "application/json" }),
		},
		body: json === undefined ? undefined : JSON.stringify(json),
	});

const vec = (fn: (i: number) => number): ArrayBuffer => {
	const a = new Int8Array(512);
	for (let i = 0; i < 512; i++) a[i] = fn(i);
	return a.buffer;
};
const SAME = vec(() => 100);
const NEAR = vec((i) => (i < 10 ? 80 : 100)); // 余弦 ≈ 0.999
const ORTHO = vec((i) => (i % 2 ? 100 : -100)); // 余弦 0
const HALF = vec((i) => (i < 256 ? 100 : 0)); // 余弦 ≈ 0.707，低于阈值
const ZERO = vec(() => 0);
const P0 = "0000000000000000";
const P1 = "0000000000000001"; // 距离 1
const PFAR = "00000000ffffffff"; // 距离 32，超过阈值（20）
const PFF = "ffffffffffffffff";

const T0 = Date.UTC(2024, 5, 1, 10);
let seq = 0;
async function addAsset(
	opts: { day?: string; taken?: number; phash?: string; emb?: ArrayBuffer; kind?: string; fav?: number; stack?: string | null } = {},
): Promise<string> {
	const id = `ST${String(++seq).padStart(24, "0")}`;
	const day = opts.day ?? "2024-06-01";
	await env.DB.batch([
		env.DB.prepare(
			`INSERT INTO assets (id, kind, status, local_month, local_day, taken_at, width, height, favorite, stack_id, created_at, updated_at)
			 VALUES (?, ?, 'ready', ?, ?, ?, 400, 300, ?, ?, 0, 0)`,
		).bind(id, opts.kind ?? "photo", day.slice(0, 7), day, opts.taken ?? T0 + seq * 1000, opts.fav ?? 0, opts.stack ?? null),
		env.DB.prepare(
			`INSERT INTO asset_fp (asset_id, model, phash, b0, b1, b2, b3, b4, embedding, updated_at)
			 VALUES (?, ?, ?, 0, 0, 0, 0, 0, ?, 0)`,
		).bind(id, FP_MODEL_VER, opts.phash ?? P0, opts.emb ?? SAME),
	]);
	return id;
}
const stackOf = async (id: string) => (await env.DB.prepare("SELECT stack_id FROM assets WHERE id = ?").bind(id).first<{ stack_id: string | null }>())!.stack_id;
const monthItems = async (ym: string, q = "") => (await (await req(`/timeline/month/${ym}${q}`)).json()) as unknown[][];

describe("clusterDay", () => {
	const row = (id: string, phash: string, emb: ArrayBuffer, taken: number): StackRow => ({ id, phash, embedding: emb, taken_at: taken, stack_id: null });

	it("groups similar photos and leaves dissimilar ones alone", () => {
		const out = clusterDay([row("a", P0, SAME, 1), row("b", P1, NEAR, 2), row("c", PFF, ORTHO, 3), row("d", P0, SAME, 4)]);
		expect(out.get("a")).toBeTruthy();
		expect(out.get("b")).toBe(out.get("a"));
		expect(out.get("d")).toBe(out.get("a"));
		expect(out.get("c")).toBeNull();
	});

	it("requires both phash distance and cosine to pass", () => {
		// 向量一样但 phash 太远
		const a = clusterDay([row("a", P0, SAME, 1), row("b", PFAR, SAME, 2)]);
		expect(a.get("b")).toBeNull();
		// phash 一样但余弦不够
		const b = clusterDay([row("a", P0, SAME, 1), row("b", P1, HALF, 2)]);
		expect(b.get("b")).toBeNull();
	});

	it("compares against the leader, not transitively", () => {
		// cos(a,b)≈0.97、cos(b,c)≈0.94 都过阈值（0.86），但 cos(a,c)≈0.83 不过：c 不能并进 a 的组
		const mid = vec((i) => (i < 256 ? 100 : 60));
		const edge = vec((i) => (i < 256 ? 100 : 20));
		const out = clusterDay([row("a", P0, SAME, 1), row("b", P0, mid, 2), row("c", P0, edge, 3)]);
		expect(out.get("b")).toBe(out.get("a"));
		expect(out.get("c")).toBeNull();
	});

	it("caps group size and ignores zero vectors", () => {
		const rows = Array.from({ length: STACK_MAX_MEMBERS + 2 }, (_, i) => row(`x${i}`, P0, SAME, i));
		rows.push(row("z", P0, ZERO, 999));
		const out = clusterDay(rows);
		const groups = new Map<string, number>();
		for (const g of out.values()) if (g) groups.set(g, (groups.get(g) ?? 0) + 1);
		expect(Math.max(...groups.values())).toBeLessThanOrEqual(STACK_MAX_MEMBERS);
		expect(out.get("z")).toBeNull();
		expect(out.get(`x${STACK_MAX_MEMBERS}`)).toBeTruthy(); // 满员后另起一组
	});
});

describe("incremental stacking on fingerprint write", () => {
	it("joins the most similar group of the same day", async () => {
		const a = await addAsset();
		const b = await addAsset({ phash: P1, emb: NEAR });
		await maybeStack(env, b);
		const g = await stackOf(b);
		expect(g).toMatch(/^s:/);
		expect(await stackOf(a)).toBe(g);

		// 第三张加入同一组；不像的、别的日期的、视频都不参与
		const c = await addAsset({ emb: NEAR });
		await maybeStack(env, c);
		expect(await stackOf(c)).toBe(g);
		const d = await addAsset({ phash: PFF, emb: ORTHO });
		await maybeStack(env, d);
		expect(await stackOf(d)).toBeNull();
		const e = await addAsset({ day: "2024-06-02" });
		await maybeStack(env, e);
		expect(await stackOf(e)).toBeNull();
		const v = await addAsset({ kind: "video" });
		await maybeStack(env, v);
		expect(await stackOf(v)).toBeNull();
	});

	it("clears a stale group when reprocessing no longer matches", async () => {
		const a = await addAsset({ day: "2024-06-10", phash: PFF, emb: ORTHO, stack: "s:STALE000000000000000000000" });
		await maybeStack(env, a);
		expect(await stackOf(a)).toBeNull();
	});

	it("skips dismissed photos entirely", async () => {
		const a = await addAsset({ day: "2024-06-11" });
		await env.DB.prepare("INSERT INTO stack_dismissed (asset_id) VALUES (?)").bind(a).run();
		await maybeStack(env, a);
		expect(await stackOf(a)).toBeNull();
		const b = await addAsset({ day: "2024-06-11", phash: P1, emb: NEAR });
		await maybeStack(env, b);
		expect(await stackOf(b)).toBeNull(); // 唯一的候选被排除了
	});
});

describe("timeline folding", () => {
	it("folds a stack into one cover with member ids and the stack id; buckets count groups", async () => {
		// 按真实上传顺序：一张处理完再来下一张
		const a = await addAsset({ day: "2024-07-01" });
		const b = await addAsset({ day: "2024-07-01", phash: P1, emb: NEAR });
		await maybeStack(env, b);
		const c = await addAsset({ day: "2024-07-01", emb: NEAR, fav: 1 });
		await maybeStack(env, c);
		const g = (await stackOf(a))!;

		let items = await monthItems("2024-07");
		expect(items).toHaveLength(1);
		expect(items[0]![0]).toBe(c); // 收藏的当封面
		expect(items[0]![8]).toEqual([a, b, c]);
		expect(items[0]![9]).toBe(g);
		const buckets = (await (await req("/timeline/buckets")).json()) as { month: string; count: number }[];
		expect(buckets.find((x) => x.month === "2024-07")!.count).toBe(1);

		// 关掉折叠：三张都在，没有 stack 标记
		items = await monthItems("2024-07", "?stacks=0");
		expect(items).toHaveLength(3);
		expect(items.every((i) => i.length === 8)).toBe(true);
		const plain = (await (await req("/timeline/buckets?stacks=0")).json()) as { month: string; count: number }[];
		expect(plain.find((x) => x.month === "2024-07")!.count).toBe(3);

		// 归档一张：组成员少一个；只剩一张时不再折叠
		await env.DB.prepare("UPDATE assets SET archived = 1 WHERE id = ?").bind(b).run();
		items = await monthItems("2024-07");
		expect(items[0]![8]).toEqual([a, c]);
		await env.DB.prepare("UPDATE assets SET archived = 1 WHERE id = ?").bind(a).run();
		items = await monthItems("2024-07");
		expect(items).toHaveLength(1);
		expect(items[0]!.length).toBe(8);
		await env.DB.batch([
			env.DB.prepare("UPDATE assets SET archived = 0 WHERE id = ?").bind(a),
			env.DB.prepare("UPDATE assets SET archived = 0 WHERE id = ?").bind(b),
		]);
	});

	it("splits a stack across days when the time is edited (read-time guard)", async () => {
		const a = await addAsset({ day: "2024-09-02" });
		const b = await addAsset({ day: "2024-09-02", phash: P1, emb: NEAR });
		await maybeStack(env, b);
		expect(await stackOf(b)).toBe(await stackOf(a));
		await env.DB.prepare("UPDATE assets SET local_day = '2024-09-03', taken_at = ? WHERE id = ?").bind(T0 + 86_400_000, b).run();
		const items = await monthItems("2024-09");
		expect(items).toHaveLength(2); // 各显示各的，不混组
		expect(items.every((i) => i.length === 8)).toBe(true);
	});

	it("serves stack members for expansion, filtered by day, with an ETag", async () => {
		const a = await addAsset({ day: "2024-10-04" });
		const b = await addAsset({ day: "2024-10-04", phash: P1, emb: NEAR });
		await maybeStack(env, b);
		const g = (await stackOf(a))!;
		const res = await req(`/stacks/${g}/assets?day=2024-10-04`);
		expect(res.status).toBe(200);
		expect(res.headers.get("etag")).toBeTruthy();
		const body = (await res.json()) as { items: unknown[][]; next: number | null };
		expect(body.items.map((i) => i[0])).toEqual([a, b]); // 拍摄时间正序
		expect(body.next).toBeNull();
		expect(((await (await req(`/stacks/${g}/assets?day=2024-10-05`)).json()) as { items: unknown[] }).items).toHaveLength(0);
		expect((await req(`/stacks/bad-id/assets`)).status).toBe(400);
		expect((await req(`/stacks/${g}/assets?day=oops`)).status).toBe(400);
	});

	it("dismiss unstacks the whole group and keeps it out of future grouping", async () => {
		const a = await addAsset({ day: "2024-11-05" });
		const b = await addAsset({ day: "2024-11-05", phash: P1, emb: NEAR });
		await maybeStack(env, b);
		const g = (await stackOf(a))!;
		const res = await req(`/stacks/${g}/dismiss`, "POST", {});
		expect(((await res.json()) as { dismissed: number }).dismissed).toBe(2);
		expect(await stackOf(a)).toBeNull();
		expect(await stackOf(b)).toBeNull();
		const items = await monthItems("2024-11");
		expect(items.find((i) => i[0] === a)!.length).toBe(8);
		// 新来的相似照片不会把它们拉回组里
		const c = await addAsset({ day: "2024-11-05", emb: NEAR });
		await maybeStack(env, c);
		expect(await stackOf(c)).toBeNull();
	});
});

describe("backfill", () => {
	it("processes day by day, finishes, and can reset", async () => {
		const a = await addAsset({ day: "2024-08-01" });
		const b = await addAsset({ day: "2024-08-01", phash: P1, emb: NEAR });
		await addAsset({ day: "2024-08-02", phash: PFF, emb: ORTHO });
		// 先清掉增量分组可能写上的组，验证补建自己会分
		await env.DB.prepare("UPDATE assets SET stack_id = NULL WHERE local_month = '2024-08'").run();

		// 测试库天数少，一个 chunk 就处理完全部
		const r = await rebuildStacksChunk(env);
		expect(r.done).toBe(true);
		expect(r.cursor >= "2024-08-02").toBe(true);
		const g = await stackOf(a);
		expect(g).toMatch(/^s:/);
		expect(await stackOf(b)).toBe(g);

		// 重置后重跑：重新分组（组 id 会换），仍然收敛
		const again = await rebuildStacksChunk(env, true);
		expect(again.done).toBe(true);
		expect(await stackOf(a)).toMatch(/^s:/);
		expect(await stackOf(b)).toBe(await stackOf(a));
		expect(await stackOf(a)).not.toBe(g);
	});

	it("rejects concurrent chunks and malformed requests", async () => {
		// cursor 在所有日期之后：锁放开后下一个 chunk 找不到天数，直接 done
		await env.DB.prepare("INSERT OR REPLACE INTO stacks_state (id, cursor, done, processed, lock_until, updated_at) VALUES (1, '2024-12-31', 0, 0, ?, 0)")
			.bind(Date.now() + 60_000)
			.run();
		const res = await req("/stacks/rebuild", "POST", {});
		expect(res.status).toBe(409);
		await env.DB.prepare("UPDATE stacks_state SET lock_until = 0 WHERE id = 1").run();
		const after = (await (await req("/stacks/rebuild", "POST", {})).json()) as { done: boolean };
		expect(after.done).toBe(true);
		const state = (await (await req("/stacks/state")).json()) as { done: boolean; cursor: string; processed: number };
		expect(state.done).toBe(true);
	});
});
