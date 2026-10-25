import { Hono } from "hono";
import { z } from "zod";
import {
	FP_MODEL_VER,
	SIMILAR_CENTER_SCAN_MAX,
	SIMILAR_GROUP_MAX,
	SIMILAR_GROUP_MIN_COSINE,
	SIMILAR_GROUP_PAGE,
	SIMILAR_GROUP_TOP_K,
	SIMILAR_SCAN_BATCH,
	SIMILAR_SCAN_SETTLE_MS,
	SIMILAR_SNOOZE_MAX,
} from "@nana/shared";
import { guardStub } from "./guard";
import {
	KEEPER_COLUMNS,
	type KeeperRow,
	asInt8,
	nearest,
	pickKeeper,
	selectByIds,
	similarPending,
	updateDuplicatePairs,
	vectorIndex,
} from "./similar";
import { toItem } from "./timeline";

/**
 * “相似照片”整理：看起来差不多的照片（同一张图被缩放、裁切、加水印、截图的各种版本，同一次拍摄里姿势略有不同的几张），
 * 只按 CLIP 向量判断，不看拍摄时间。每组推荐保留一张，其余可以移到回收站或归档；“暂不处理”把这一组排到队列末尾。
 *
 *  - 查近邻（scanSimilar）：每张照片在向量进 Vectorize SIMILAR_SCAN_SETTLE_MS 之后查一次前 SIMILAR_GROUP_TOP_K 个，
 *    余弦达到 SIMILAR_GROUP_MIN_COSINE 的存进 similar_pairs，并更新两边的相似照片数（asset_fp.similar_n）。
 *    同时补上这张照片的重复照片候选对（部署前的照片、全量补建被截断的部分都由它补齐）。
 *    由每小时的 Cron 和打开页面时的分批请求（POST /similar-groups/scan）触发，上限见 limits.ts。
 *    指纹重写时（saveFingerprint）旧的照片对一起删掉，similar_at 回到 NULL，之后重新查。
 *  - 待整理队列（GET /similar-groups）：不一次算出全部分组（几十万张时照片对有上百万），而是按 similar_n 从大到小
 *    逐个取“中心”，只读中心自己的照片对，拼成一组：组里每一张都和中心足够像，可见、没归档、不是视频；
 *    两张都认出了人物时，至少要有一个相同的人物（CLIP 分不太清同样打扮的不同的人）。
 *    暂不处理过的照片排在后面（按时间从早到晚轮流出现）。没有可分照片的中心把 similar_n 清零，
 *    处理过的组由前端调用 POST /similar-groups/recount 更新（撤销时再调用一次就恢复）。
 *
 * D1 的照片对是唯一真实数据；Vectorize 的结果一律用 D1 过滤（不存在的条目不会写进去）。本地开发没有 Vectorize：
 * 不查近邻，接口带 unavailable: true。
 */

type Bindings = { Bindings: Env };
export const similarGroups = new Hono<Bindings>();

const ID = z.string().regex(/^[0-9A-Z]{26}$/);
/** 同时进行的 Vectorize 查询数。 */
const QUERY_CONCURRENCY = 25;
/** 每次读多少个候选中心。 */
const CENTER_BATCH = 100;
/** json_each 一次展开多少个 id（整批作为一个 JSON 文本参数，D1 单条语句最多 100 个参数）。 */
const JSON_IDS = 2000;

/** 能参与整理的照片：可见、没归档、不是视频。 */
const ELIGIBLE = (t: string) => `${t}.deleted_at IS NULL AND ${t}.status = 'ready' AND ${t}.archived = 0 AND ${t}.kind != 'video'`;

/** x 的相似照片数：similar_pairs 里实际的数目，不能参与整理的是 0。 */
const COUNT_OF = (x: string) => `CASE WHEN ${ELIGIBLE(x)} THEN
	(SELECT COUNT(*) FROM similar_pairs WHERE a = ${x}.id) + (SELECT COUNT(*) FROM similar_pairs INDEXED BY similar_pairs_b WHERE b = ${x}.id) ELSE 0 END`;

/** 重新计数这些照片的相似照片数，没变的不写。 */
function recountStatement(env: Env, ids: string[]): D1PreparedStatement {
	return env.DB.prepare(
		`UPDATE asset_fp SET similar_n = c.n
		 FROM (SELECT x.id, ${COUNT_OF("x")} AS n FROM json_each(?) j CROSS JOIN assets x ON x.id = j.value) c
		 WHERE asset_fp.asset_id = c.id AND asset_fp.similar_n != c.n`,
	).bind(JSON.stringify(ids));
}

/**
 * 人物有变化（合并、改人、新认出的脸）之后，“相似的照片都是别的人物”的中心（similar_n = -1）可能又能成组了：
 * people 版本号和上次不同时把它们重新计数。只在打开页面时检查，每次 2 行读取；有变化时读写的是这些中心的行。
 */
async function reviveParked(env: Env) {
	const [cv, st] = await env.DB.batch<{ v: number }>([
		env.DB.prepare("SELECT v FROM cache_versions WHERE name = 'people'"),
		env.DB.prepare("SELECT people_v AS v FROM similar_state WHERE id = 1"),
	]);
	const v = cv!.results[0]?.v ?? 0;
	if (st!.results[0]?.v === v) return;
	await env.DB.batch([
		env.DB.prepare(
			`UPDATE asset_fp SET similar_n = c.n
			 FROM (SELECT x.id, ${COUNT_OF("x")} AS n FROM asset_fp f INDEXED BY asset_fp_similar_parked CROSS JOIN assets x ON x.id = f.asset_id
			       WHERE f.similar_n < 0) c
			 WHERE asset_fp.asset_id = c.id`,
		),
		env.DB.prepare("INSERT OR REPLACE INTO similar_state (id, people_v) VALUES (1, ?)").bind(v),
	]);
}

// ---------------------------------------------------------------- 查近邻

/**
 * 查最多 limit 张还没查过的照片的近邻。只查已经进索引、而且进索引超过 SIMILAR_SCAN_SETTLE_MS 的（updated_at 就是进索引的时间），
 * 所以差不多同时处理的两张照片，后查的那张一定能查到前一张。熔断时跳过；Vectorize 出错就停下，剩下的留给下一次。
 * 返回这次查完的张数。
 */
export async function scanSimilar(env: Env, limit: number, now = Date.now()): Promise<number> {
	return (await scanBatch(env, limit, now)).scanned;
}

/** 同 scanSimilar；failed：Vectorize 出过错（这一批没查完，剩下的可以稍后再试）。 */
async function scanBatch(env: Env, limit: number, now = Date.now()): Promise<{ scanned: number; failed: boolean }> {
	if (!vectorIndex(env) || (await guardStub(env).isTripped())) return { scanned: 0, failed: false };
	const { results } = await env.DB.prepare(
		`SELECT asset_id, phash, embedding, updated_at FROM asset_fp INDEXED BY asset_fp_similar_pending
		 WHERE similar_at IS NULL AND indexed = 1 AND updated_at <= ? AND model = ? ORDER BY updated_at LIMIT ?`,
	)
		.bind(now - SIMILAR_SCAN_SETTLE_MS, FP_MODEL_VER, limit)
		.all<{ asset_id: string; phash: string; embedding: ArrayBuffer; updated_at: number }>();
	const done: { id: string; phash: string; embedding: Int8Array; updatedAt: number; near: [string, number][] }[] = [];
	// QUERY_CONCURRENCY 个查询并行，一个结束就补下一个（不等整轮）；出错之后不再发新的查询
	let next = 0;
	let failed = false;
	const lane = async () => {
		while (!failed && next < results.length) {
			const r = results[next++]!;
			const vector = asInt8(r.embedding);
			const near = await nearest(env, vector, SIMILAR_GROUP_TOP_K + 1, SIMILAR_GROUP_MIN_COSINE);
			if (!near) {
				failed = true;
				return;
			}
			done.push({
				id: r.asset_id,
				phash: r.phash,
				embedding: vector,
				updatedAt: r.updated_at,
				near: near.filter((n) => n.id !== r.asset_id).map((n) => [n.id, n.score]),
			});
		}
	};
	await Promise.all(Array.from({ length: Math.min(QUERY_CONCURRENCY, results.length) }, lane));
	if (!done.length) return { scanned: 0, failed };
	await updateDuplicatePairs(env, done);
	const writes = done.flatMap((r) => [
		// 只写还存在的条目（索引里可能残留已删除照片的向量）
		env.DB.prepare(
			`INSERT OR IGNORE INTO similar_pairs (a, b, score)
			 SELECT min(?1, x.id), max(?1, x.id), json_extract(j.value, '$[1]')
			 FROM json_each(?2) j JOIN assets x ON x.id = json_extract(j.value, '$[0]')
			 WHERE x.id != ?1`,
		).bind(r.id, JSON.stringify(r.near)),
		// 期间指纹被重写过的不标记，下次重新查
		env.DB.prepare("UPDATE asset_fp SET similar_at = ? WHERE asset_id = ? AND updated_at = ?").bind(now, r.id, r.updatedAt),
	]);
	// 各批互不依赖（INSERT OR IGNORE、按条目各自 UPDATE），一起发，不一批等一批
	const batches: Promise<unknown>[] = [];
	for (let i = 0; i < writes.length; i += 50) batches.push(env.DB.batch(writes.slice(i, i + 50)));
	await Promise.all(batches);
	// 照片对都写完之后，重算这一批和它们的近邻的相似照片数（新的照片对可能让清零过的中心重新进队列）
	const touched = [...new Set(done.flatMap((r) => [r.id, ...r.near.map(([id]) => id)]))];
	const recount: D1PreparedStatement[] = [];
	for (let i = 0; i < touched.length; i += JSON_IDS) recount.push(recountStatement(env, touched.slice(i, i + JSON_IDS)));
	await env.DB.batch(recount);
	console.log(JSON.stringify({ event: "similar_scanned", count: done.length }));
	return { scanned: done.length, failed };
}

// ---------------------------------------------------------------- 待整理队列

/** 队列位置：1 = 没暂不处理过的（按相似照片数从多到少），2 = 暂不处理过的（按时间从早到晚）。 */
type Cursor = { phase: 1; n: number; id: string } | { phase: 2; at: number; id: string };
const START: Cursor = { phase: 1, n: Number.MAX_SAFE_INTEGER, id: "" };

export function encodeCursor(c: Cursor): string {
	return `${c.phase}.${c.phase === 1 ? c.n : c.at}.${c.id}`;
}
export function decodeCursor(s: string | undefined): Cursor {
	const m = s?.match(/^([12])\.(\d{1,16})\.([0-9A-Z]{26})$/);
	if (!m) return START;
	return m[1] === "1" ? { phase: 1, n: Number(m[2]), id: m[3]! } : { phase: 2, at: Number(m[2]), id: m[3]! };
}

/** 从 cur 之后取最多 limit 个能参与整理的中心。 */
async function nextCenters(env: Env, cur: Cursor, limit: number): Promise<{ id: string; at: Cursor }[]> {
	if (cur.phase === 1) {
		const { results } = await env.DB.prepare(
			`SELECT f.asset_id AS id, f.similar_n AS k FROM asset_fp f INDEXED BY asset_fp_similar_queue CROSS JOIN assets x ON x.id = f.asset_id
			 WHERE f.similar_n > 0 AND (f.similar_n < ?1 OR (f.similar_n = ?1 AND f.asset_id > ?2)) AND ${ELIGIBLE("x")}
			   AND NOT EXISTS (SELECT 1 FROM similar_snoozes s WHERE s.asset_id = f.asset_id)
			 ORDER BY f.similar_n DESC, f.asset_id LIMIT ?3`,
		)
			.bind(cur.n, cur.id, limit)
			.all<{ id: string; k: number }>();
		return results.map((r) => ({ id: r.id, at: { phase: 1, n: r.k, id: r.id } }));
	}
	const { results } = await env.DB.prepare(
		`SELECT s.asset_id AS id, s.snoozed_at AS k FROM similar_snoozes s INDEXED BY similar_snoozes_queue CROSS JOIN assets x ON x.id = s.asset_id
		 WHERE (s.snoozed_at > ?1 OR (s.snoozed_at = ?1 AND s.asset_id > ?2)) AND ${ELIGIBLE("x")}
		 ORDER BY s.snoozed_at, s.asset_id LIMIT ?3`,
	)
		.bind(cur.at, cur.id, limit)
		.all<{ id: string; k: number }>();
	return results.map((r) => ({ id: r.id, at: { phase: 2, at: r.k, id: r.id } }));
}

/** 按 JSON_IDS 个一组展开 id，对每组执行同一条查询（一次 batch）。 */
async function eachChunk<T>(env: Env, sql: string, ids: string[]): Promise<T[]> {
	const stmts: D1PreparedStatement[] = [];
	for (let i = 0; i < ids.length; i += JSON_IDS) stmts.push(env.DB.prepare(sql).bind(JSON.stringify(ids.slice(i, i + JSON_IDS))));
	if (!stmts.length) return [];
	return (await env.DB.batch<T>(stmts)).flatMap((r) => r.results);
}

/** 两张都认出了人物时，至少要有一个相同的人物。 */
function samePeople(a: Set<string> | undefined, b: Set<string> | undefined): boolean {
	if (!a || !b) return true;
	for (const p of a) if (b.has(p)) return true;
	return false;
}

/**
 * 从 cursor 开始取最多 SIMILAR_GROUP_PAGE 组（最多看 SIMILAR_CENTER_SCAN_MAX 个中心）。
 * 一张照片只有在它的相似照片里没有排在它前面的（同一阶段、也能当中心）时才当中心，否则它归到前面那张的组里：
 * 这样每组只有一个中心，不管它落在哪一页，翻页时不会把上一页的组换个中心再列一遍。
 * 中心按顺序认领：已经在这一页别的组里的跳过；组员是中心的照片对里能参与整理、人物对得上、这一页还没用过的
 * （没暂不处理过的组不收暂不处理过的照片），按相似度从高到低，最多 SIMILAR_GROUP_MAX 张。
 * 一张能参与整理的组员都没有的中心不会再成组：similar_n 清零（暂不处理过的同时删掉记录），以后不再读它；
 * 只是因为人物对不上的记成 -1，人物有变化时重新计数（reviveParked）。
 */
export async function similarQueue(env: Env, cursor: string | undefined) {
	await reviveParked(env);
	let cur = decodeCursor(cursor);
	const groups: { ids: string[]; snoozed: boolean }[] = [];
	const taken = new Set<string>();
	const dead: string[] = [];
	const parked: string[] = [];
	let examined = 0;
	let exhausted = false;
	scan: while (groups.length < SIMILAR_GROUP_PAGE && examined < SIMILAR_CENTER_SCAN_MAX) {
		const centers = await nextCenters(env, cur, CENTER_BATCH);
		if (!centers.length) {
			if (cur.phase === 1) {
				cur = { phase: 2, at: -1, id: "" };
				continue;
			}
			exhausted = true;
			break;
		}
		examined += centers.length;
		const centerIds = centers.map((c) => c.id);
		const pairs = await eachChunk<{ c: string; o: string; score: number }>(
			env,
			`SELECT p.a AS c, p.b AS o, p.score FROM json_each(?) j CROSS JOIN similar_pairs p ON p.a = j.value
			 UNION ALL
			 SELECT p.b AS c, p.a AS o, p.score FROM json_each(?1) j CROSS JOIN similar_pairs p INDEXED BY similar_pairs_b ON p.b = j.value`,
			centerIds,
		);
		const neighbors = new Map<string, { id: string; score: number }[]>();
		for (const p of pairs) {
			const list = neighbors.get(p.c);
			if (list) list.push({ id: p.o, score: p.score });
			else neighbors.set(p.c, [{ id: p.o, score: p.score }]);
		}
		const involved = [...new Set([...centerIds, ...pairs.map((p) => p.o)])];
		const [eligible, faces] = await Promise.all([
			eachChunk<{ id: string; n: number | null; at: number | null }>(
				env,
				`SELECT x.id, f.similar_n AS n, s.snoozed_at AS at FROM json_each(?) j CROSS JOIN assets x ON x.id = j.value
				 LEFT JOIN asset_fp f ON f.asset_id = x.id LEFT JOIN similar_snoozes s ON s.asset_id = x.id
				 WHERE ${ELIGIBLE("x")}`,
				involved,
			),
			eachChunk<{ asset_id: string; person_id: string }>(
				env,
				"SELECT f.asset_id, f.person_id FROM json_each(?) j CROSS JOIN faces f INDEXED BY faces_asset ON f.asset_id = j.value WHERE f.person_id IS NOT NULL",
				involved,
			),
		]);
		const ok = new Map(eligible.map((r) => [r.id, r]));
		/** m 在队列里排在中心 c 前面，而且自己也能当中心。 */
		const ahead = (c: Cursor, m: { id: string; n: number | null; at: number | null }) =>
			c.phase === 1
				? m.at === null && (m.n ?? 0) > 0 && ((m.n ?? 0) > c.n || (m.n === c.n && m.id < c.id))
				: m.at !== null && (m.at < c.at || (m.at === c.at && m.id < c.id));
		const people = new Map<string, Set<string>>();
		for (const f of faces) {
			const s = people.get(f.asset_id);
			if (s) s.add(f.person_id);
			else people.set(f.asset_id, new Set([f.person_id]));
		}
		for (const c of centers) {
			cur = c.at;
			if (taken.has(c.id)) continue;
			const visible = (neighbors.get(c.id) ?? []).filter((n) => ok.has(n.id));
			const candidates = visible.filter((n) => samePeople(people.get(c.id), people.get(n.id)));
			if (!candidates.length) {
				(visible.length ? parked : dead).push(c.id);
				continue;
			}
			if (candidates.some((n) => ahead(c.at, ok.get(n.id)!))) continue;
			const members = candidates
				.filter((n) => !taken.has(n.id) && (cur.phase === 2 || ok.get(n.id)!.at === null))
				.sort((x, y) => y.score - x.score || (x.id < y.id ? -1 : 1))
				.slice(0, SIMILAR_GROUP_MAX - 1);
			if (!members.length) continue;
			const ids = [c.id, ...members.map((n) => n.id)];
			for (const id of ids) taken.add(id);
			groups.push({ ids, snoozed: cur.phase === 2 });
			if (groups.length >= SIMILAR_GROUP_PAGE) break scan;
		}
	}
	if (dead.length || parked.length) {
		await env.DB.batch([
			env.DB.prepare("UPDATE asset_fp SET similar_n = 0 WHERE asset_id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(dead)),
			env.DB.prepare("UPDATE asset_fp SET similar_n = -1 WHERE asset_id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(parked)),
			env.DB.prepare("DELETE FROM similar_snoozes WHERE asset_id IN (SELECT value FROM json_each(?))").bind(JSON.stringify([...dead, ...parked])),
		]);
	}
	return { groups, next: exhausted ? null : encodeCursor(cur) };
}

/**
 * GET /api/similar-groups?cursor=：待整理队列的一页（见 similarQueue）。推荐保留的在每组最前面，其余按分辨率从高到低。
 * next 是下一页的位置，null 表示到底了。只由用户打开页面、加载更多和操作之后的刷新触发。
 */
similarGroups.get("/similar-groups", async (c) => {
	const { groups, next } = await similarQueue(c.env, c.req.query("cursor"));
	const items = await selectByIds<KeeperRow>(c.env, KEEPER_COLUMNS, groups.flatMap((g) => g.ids));
	const pixels = (r: KeeperRow) => (r.width ?? 0) * (r.height ?? 0);
	return c.json({
		groups: groups.flatMap((g) => {
			const present = g.ids.map((id) => items.get(id)).filter((r): r is KeeperRow => !!r);
			if (present.length < 2) return [];
			const keep = pickKeeper(present);
			const sorted = [keep, ...present.filter((r) => r !== keep).sort((x, y) => pixels(y) - pixels(x) || (x.id < y.id ? -1 : 1))];
			return [{ keep: keep.id, items: sorted.map(toItem), snoozed: g.snoozed }];
		}),
		next,
		pending: await similarPending(c.env),
		...(vectorIndex(c.env) ? {} : { unavailable: true }),
	});
});

/**
 * POST /api/similar-groups/scan：页面分批补查（每次 SIMILAR_SCAN_BATCH 张），前端在有剩余时继续请求，次数有上限。
 * failed：Vectorize 出过错，前端退避后再试（次数有上限）；scanned = 0 且没有 failed 表示暂时没有能查的了。
 */
similarGroups.post("/similar-groups/scan", async (c) => c.json(await scanBatch(c.env, SIMILAR_SCAN_BATCH)));

const Ids = z.object({ ids: z.array(ID).min(1).max(SIMILAR_SNOOZE_MAX) });

/** POST /api/similar-groups/snooze { ids }：暂不处理，这些照片排到队列末尾（不再当没处理过的组的中心）。 */
similarGroups.post("/similar-groups/snooze", async (c) => {
	const { ids } = Ids.parse(await c.req.json());
	const json = JSON.stringify(ids);
	const [res] = await c.env.DB.batch<{ asset_id: string }>([
		c.env.DB.prepare(
			`INSERT OR REPLACE INTO similar_snoozes (asset_id, snoozed_at)
			 SELECT x.id, ? FROM json_each(?) j JOIN assets x ON x.id = j.value RETURNING asset_id`,
		).bind(Date.now(), json),
		c.env.DB.prepare("UPDATE asset_fp SET similar_n = 0 WHERE asset_id IN (SELECT value FROM json_each(?))").bind(json),
	]);
	return c.json({ snoozed: res!.results.length });
});

/**
 * POST /api/similar-groups/recount { ids }：一组照片被移到回收站 / 归档（或撤销）之后，按实际的照片对重算它们的相似照片数，
 * 进了回收站、归档的不再当中心，撤销后恢复。
 */
similarGroups.post("/similar-groups/recount", async (c) => {
	const { ids } = Ids.parse(await c.req.json());
	await recountStatement(c.env, ids).run();
	return c.json({ ok: true });
});
