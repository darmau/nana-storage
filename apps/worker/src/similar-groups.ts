import { Hono } from "hono";
import { z } from "zod";
import {
	FP_MODEL_VER,
	SIMILAR_GROUP_MAX,
	SIMILAR_GROUP_MIN_COSINE,
	SIMILAR_GROUP_TOP_K,
	SIMILAR_PAIR_MAX,
	SIMILAR_SCAN_BATCH,
	SIMILAR_SCAN_SETTLE_MS,
	SIMILAR_SNOOZE_MAX,
} from "@nana/shared";
import { guardStub } from "./guard";
import { KEEPER_COLUMNS, type KeeperRow, asInt8, nearest, pickKeeper, selectByIds, vectorIndex } from "./similar";
import { toItem } from "./timeline";

/**
 * “相似照片”整理：看起来差不多的照片（同一张图被缩放、裁切、加水印、截图的各种版本，同一次拍摄里姿势略有不同的几张），
 * 只按 CLIP 向量判断，不看拍摄时间。每组推荐保留一张，其余可以移到回收站或归档；“暂不处理”把这一组排到队列末尾。
 *
 *  - 查近邻（scanSimilar）：每张照片在向量进 Vectorize SIMILAR_SCAN_SETTLE_MS 之后查一次前 SIMILAR_GROUP_TOP_K 个，
 *    余弦达到 SIMILAR_GROUP_MIN_COSINE 的存进 similar_pairs。由每小时的 Cron 和打开页面时的分批请求（POST /similar-groups/scan）触发，
 *    上限见 limits.ts。指纹重写时（saveFingerprint）旧的照片对一起删掉，similar_at 回到 NULL，之后重新查。
 *  - 分组（GET /similar-groups）：只读照片对，两张都可见、没归档、不是视频；两张都认出了人物时，至少要有一个相同的人物
 *    （CLIP 分不太清是谁：同一场演出、同样打扮的两个人也会很像）。以一张为中心，组里每一张都和它足够像（groupSimilar）。
 *
 * D1 的照片对是唯一真实数据；Vectorize 的结果一律用 D1 过滤（不存在的条目不会写进去）。本地开发没有 Vectorize：
 * 不查近邻，接口带 unavailable: true。
 */

type Bindings = { Bindings: Env };
export const similarGroups = new Hono<Bindings>();

const ID = z.string().regex(/^[0-9A-Z]{26}$/);
const GROUP_PAGE = 100;
/** 同时进行的 Vectorize 查询数。 */
const QUERY_CONCURRENCY = 6;
/** 每次 batch 写多少张照片（每张 2 条语句）。 */
const WRITE_ROWS = 25;

// ---------------------------------------------------------------- 查近邻

/**
 * 查最多 limit 张还没查过的照片的近邻。只查已经进索引、而且进索引超过 SIMILAR_SCAN_SETTLE_MS 的（updated_at 就是进索引的时间），
 * 所以差不多同时处理的两张照片，后查的那张一定能查到前一张。熔断时跳过；Vectorize 出错就停下，剩下的留给下一次。
 * 返回这次查完的张数。
 */
export async function scanSimilar(env: Env, limit: number, now = Date.now()): Promise<number> {
	if (!vectorIndex(env) || (await guardStub(env).isTripped())) return 0;
	const { results } = await env.DB.prepare(
		`SELECT asset_id, embedding, updated_at FROM asset_fp INDEXED BY asset_fp_similar_pending
		 WHERE similar_at IS NULL AND indexed = 1 AND updated_at <= ? AND model = ? ORDER BY updated_at LIMIT ?`,
	)
		.bind(now - SIMILAR_SCAN_SETTLE_MS, FP_MODEL_VER, limit)
		.all<{ asset_id: string; embedding: ArrayBuffer; updated_at: number }>();
	const done: { id: string; updatedAt: number; near: [string, number][] }[] = [];
	for (let i = 0; i < results.length; i += QUERY_CONCURRENCY) {
		const chunk = results.slice(i, i + QUERY_CONCURRENCY);
		const found = await Promise.all(chunk.map((r) => nearest(env, asInt8(r.embedding), SIMILAR_GROUP_TOP_K + 1, SIMILAR_GROUP_MIN_COSINE)));
		let failed = false;
		chunk.forEach((r, k) => {
			const near = found[k];
			if (!near) failed = true;
			else done.push({ id: r.asset_id, updatedAt: r.updated_at, near: near.filter((n) => n.id !== r.asset_id).map((n) => [n.id, n.score]) });
		});
		if (failed) break;
	}
	for (let i = 0; i < done.length; i += WRITE_ROWS) {
		await env.DB.batch(
			done.slice(i, i + WRITE_ROWS).flatMap((r) => [
				// 只写还存在的条目（索引里可能残留已删除照片的向量）
				env.DB.prepare(
					`INSERT OR IGNORE INTO similar_pairs (a, b, score)
					 SELECT min(?1, x.id), max(?1, x.id), json_extract(j.value, '$[1]')
					 FROM json_each(?2) j JOIN assets x ON x.id = json_extract(j.value, '$[0]')
					 WHERE x.id != ?1`,
				).bind(r.id, JSON.stringify(r.near)),
				// 期间指纹被重写过的不标记，下次重新查
				env.DB.prepare("UPDATE asset_fp SET similar_at = ? WHERE asset_id = ? AND updated_at = ?").bind(now, r.id, r.updatedAt),
			]),
		);
	}
	if (done.length) console.log(JSON.stringify({ event: "similar_scanned", count: done.length }));
	return done.length;
}

/** 已经进索引、还没查过近邻的张数（包括还没到 SIMILAR_SCAN_SETTLE_MS 的）。 */
async function pendingCount(env: Env): Promise<number> {
	const row = await env.DB.prepare(
		"SELECT COUNT(*) AS n FROM asset_fp INDEXED BY asset_fp_similar_pending WHERE similar_at IS NULL AND indexed = 1",
	).first<{ n: number }>();
	return row?.n ?? 0;
}

// ---------------------------------------------------------------- 分组

/**
 * 以一张为中心分组：按相似的照片数从多到少挑中心，组里是中心和它还没被分走的相似照片（按相似度从高到低，最多 max 张）。
 * 组里每一张都和中心足够像，不会像并查集那样 A 像 B、B 像 C 就把不像的 A 和 C 连进同一组。
 * 返回下标数组，中心在第一个。
 */
export function groupSimilar(ids: string[], pairs: [number, number, number][], max = SIMILAR_GROUP_MAX): number[][] {
	const adj: [number, number][][] = ids.map(() => []);
	for (const [i, j, s] of pairs) {
		adj[i]!.push([j, s]);
		adj[j]!.push([i, s]);
	}
	const order = ids
		.map((_, i) => i)
		.filter((i) => adj[i]!.length)
		.sort((a, b) => adj[b]!.length - adj[a]!.length || (ids[a]! < ids[b]! ? -1 : 1));
	const taken = new Uint8Array(ids.length);
	const groups: number[][] = [];
	for (const c of order) {
		if (taken[c]) continue;
		const members = adj[c]!.filter(([j]) => !taken[j]).sort((x, y) => y[1] - x[1] || (ids[x[0]]! < ids[y[0]]! ? -1 : 1));
		if (!members.length) continue;
		const g = [c, ...members.slice(0, max - 1).map(([j]) => j)];
		for (const i of g) taken[i] = 1;
		groups.push(g);
	}
	return groups;
}

/** 两张都认出了人物时，至少要有一个相同的人物。 */
function samePeople(a: Set<string> | undefined, b: Set<string> | undefined): boolean {
	if (!a || !b) return true;
	for (const p of a) if (b.has(p)) return true;
	return false;
}

const PAIR_VISIBLE = (t: string) => `${t}.deleted_at IS NULL AND ${t}.status = 'ready' AND ${t}.archived = 0 AND ${t}.kind != 'video'`;

/**
 * GET /api/similar-groups?offset=：每页 GROUP_PAGE 组。没处理过的组在前（照片多的在前），“暂不处理”过的排在后面
 * （按时间从早到晚，所以一直点“暂不处理”会轮流看到每一组）。读取量和照片对的数量成正比（最多 SIMILAR_PAIR_MAX 对）
 * + 有人物的脸 + 暂不处理的记录；推荐保留要用的列只给当前页的照片查。只由用户打开页面和操作之后的刷新触发。
 */
similarGroups.get("/similar-groups", async (c) => {
	const offset = Math.max(0, Math.floor(Number(c.req.query("offset") ?? 0)) || 0);
	const [pairRes, faceRes, snoozeRes, fpRes] = await c.env.DB.batch<unknown>([
		c.env.DB.prepare(
			`SELECT p.a, p.b, p.score FROM similar_pairs p CROSS JOIN assets x ON x.id = p.a CROSS JOIN assets y ON y.id = p.b
			 WHERE ${PAIR_VISIBLE("x")} AND ${PAIR_VISIBLE("y")} LIMIT ?`,
		).bind(SIMILAR_PAIR_MAX),
		c.env.DB.prepare("SELECT asset_id, person_id FROM faces INDEXED BY faces_person WHERE person_id IS NOT NULL"),
		c.env.DB.prepare("SELECT asset_id, snoozed_at FROM similar_snoozes"),
		c.env.DB.prepare("SELECT COUNT(*) AS n FROM asset_fp"),
	]);
	const pairRows = pairRes!.results as { a: string; b: string; score: number }[];
	const people = new Map<string, Set<string>>();
	for (const r of faceRes!.results as { asset_id: string; person_id: string }[]) {
		const s = people.get(r.asset_id);
		if (s) s.add(r.person_id);
		else people.set(r.asset_id, new Set([r.person_id]));
	}
	const snoozed = new Map((snoozeRes!.results as { asset_id: string; snoozed_at: number }[]).map((r) => [r.asset_id, r.snoozed_at]));

	const ids: string[] = [];
	const index = new Map<string, number>();
	const at = (id: string) => {
		let i = index.get(id);
		if (i === undefined) {
			i = ids.push(id) - 1;
			index.set(id, i);
		}
		return i;
	};
	const pairs: [number, number, number][] = [];
	for (const r of pairRows) if (samePeople(people.get(r.a), people.get(r.b))) pairs.push([at(r.a), at(r.b), r.score]);

	const groups = groupSimilar(ids, pairs)
		.map((g) => ({ ids: g.map((i) => ids[i]!), snoozedAt: Math.max(0, ...g.map((i) => snoozed.get(ids[i]!) ?? 0)) }))
		.sort((x, y) => x.snoozedAt - y.snoozedAt || y.ids.length - x.ids.length || (x.ids[0]! < y.ids[0]! ? -1 : 1));
	const pageGroups = groups.slice(offset, offset + GROUP_PAGE);
	const items = await selectByIds<KeeperRow>(c.env, KEEPER_COLUMNS, pageGroups.flatMap((g) => g.ids));
	const pixels = (r: KeeperRow) => (r.width ?? 0) * (r.height ?? 0);
	return c.json({
		groups: pageGroups.flatMap((g) => {
			const present = g.ids.map((id) => items.get(id)).filter((r): r is KeeperRow => !!r);
			if (present.length < 2) return [];
			const keep = pickKeeper(present);
			// 推荐保留的在最前面，其余按分辨率从高到低
			const sorted = [keep, ...present.filter((r) => r !== keep).sort((x, y) => pixels(y) - pixels(x) || (x.id < y.id ? -1 : 1))];
			return [{ keep: keep.id, items: sorted.map(toItem), snoozed: g.snoozedAt > 0 }];
		}),
		total: groups.length,
		next: offset + GROUP_PAGE < groups.length ? offset + GROUP_PAGE : null,
		fingerprints: (fpRes!.results[0] as { n: number }).n,
		pending: await pendingCount(c.env),
		truncated: pairRows.length >= SIMILAR_PAIR_MAX,
		...(vectorIndex(c.env) ? {} : { unavailable: true }),
	});
});

/** POST /api/similar-groups/scan：页面分批补查（每次 SIMILAR_SCAN_BATCH 张），前端在有剩余时继续请求，次数有上限。 */
similarGroups.post("/similar-groups/scan", async (c) => {
	const scanned = await scanSimilar(c.env, SIMILAR_SCAN_BATCH);
	return c.json({ scanned, pending: await pendingCount(c.env) });
});

/** POST /api/similar-groups/snooze { ids }：暂不处理，这些照片所在的组排到队列末尾。 */
similarGroups.post("/similar-groups/snooze", async (c) => {
	const { ids } = z.object({ ids: z.array(ID).min(1).max(SIMILAR_SNOOZE_MAX) }).parse(await c.req.json());
	const { results } = await c.env.DB.prepare(
		`INSERT OR REPLACE INTO similar_snoozes (asset_id, snoozed_at)
		 SELECT x.id, ? FROM json_each(?) j JOIN assets x ON x.id = j.value RETURNING asset_id`,
	)
		.bind(Date.now(), JSON.stringify(ids))
		.all();
	return c.json({ snoozed: results.length });
});
