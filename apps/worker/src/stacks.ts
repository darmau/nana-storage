import { Hono } from "hono";
import { z } from "zod";
import {
	FP_MODEL_VER,
	STACK_BACKFILL_DAYS,
	STACK_BACKFILL_DAY_MAX,
	STACK_BACKFILL_LOCK_MS,
	STACK_BACKFILL_ROWS,
	STACK_DAY_MAX,
	STACK_LEADER_MAX,
	STACK_MAX_HAMMING,
	STACK_MAX_MEMBERS,
	STACK_MIN_COSINE,
} from "@nana/shared";
import { guardStub } from "./guard";
import { VISIBLE, offsetOf, page } from "./library";
import { asInt8, hamming } from "./similar";
import { ITEM_COLUMNS } from "./timeline";
import { ulid } from "./ulid";

/**
 * 相似照片折叠（时间线）：同一天里 phash 和 CLIP 向量都相似的一系列照片共用一个 stack_id，
 * 时间线把它们折叠成一张封面（右下角 +N），点击在原地展开。
 *
 * 只用 D1 里已有的指纹（asset_fp），不用 Vectorize、不启动容器、没有新的队列或 Cron：
 *  - 增量：process 任务写指纹时顺带跑 maybeStack()，只读“当天”的候选（assets_day 索引），
 *    和各组代表 + 未成组的单张比较（leader 聚类，和代表比而不是链式合并，避免传递性失控）。
 *    读取量有上限（STACK_DAY_MAX / STACK_LEADER_MAX），超过就跳过这张，交给补建。
 *  - 补建：只由用户在设置页点击触发，按天分 chunk（rebuildStacksChunk），进度记在 stacks_state，
 *    可以断点续跑，也可以重置后全库重跑（校准阈值后用）。
 *  - “不折叠这组”（stack_dismissed）：整组成员以后都不再参与分组。
 *
 * 分组结果只是显示用的：封面、可见性、张数都在时间线读取时算（和连拍一样），
 * 删除 / 归档 / 恢复 / 改时间都不需要维护 stack_id（读取时按 stack_id + local_day 分区，改天自动散开）。
 * 失败不影响处理任务（和 updateDuplicatePairs 一样只记日志）。
 */

type Bindings = { Bindings: Env };
export const stacks = new Hono<Bindings>();

const STACK_ID = z.string().regex(/^s:[0-9A-Z]{26}$/);
const DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** D1 单条语句最多 100 个参数。 */
const CHUNK = 90;

export const newStackId = () => `s:${ulid()}`;

// ---------------------------------------------------------------- 相似度

function norm8(v: Int8Array): number {
	let s = 0;
	for (let i = 0; i < v.length; i++) s += v[i]! * v[i]!;
	return Math.sqrt(s);
}
function dot8(a: Int8Array, b: Int8Array): number {
	let s = 0;
	for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
	return s;
}
function popcount(n: number): number {
	let x = n >>> 0;
	let d = 0;
	while (x) {
		x &= x - 1;
		d++;
	}
	return d;
}

// ---------------------------------------------------------------- 增量分组

/**
 * process 任务写指纹成功后调用：把这张照片归进当天最像的一组（或和某张单张新建一组）。
 * 只读当天的候选（窄行）和各组代表的向量，都有上限；任何失败只记日志，不让任务失败。
 */
export async function maybeStack(env: Env, assetId: string): Promise<void> {
	try {
		const self = await env.DB.prepare(
			`SELECT a.kind, a.local_day, a.stack_id, EXISTS (SELECT 1 FROM stack_dismissed d WHERE d.asset_id = a.id) AS off
			 FROM assets a WHERE a.id = ?`,
		)
			.bind(assetId)
			.first<{ kind: string; local_day: string | null; stack_id: string | null; off: number }>();
		if (!self || self.kind === "video" || !self.local_day || self.off) return;
		const fp = await env.DB.prepare("SELECT phash, embedding FROM asset_fp WHERE asset_id = ? AND model = ?")
			.bind(assetId, FP_MODEL_VER)
			.first<{ phash: string; embedding: ArrayBuffer }>();
		if (!fp) return;
		const sv = asInt8(fp.embedding);
		const sn = norm8(sv);
		if (!(sn > 0)) return;

		const { results: near } = await env.DB.prepare(
			`SELECT a.id, a.stack_id, a.taken_at FROM assets a INDEXED BY assets_day
			 WHERE a.local_day = ?1 AND a.deleted_at IS NULL AND a.status = 'ready' AND a.archived = 0
			   AND a.kind != 'video' AND a.id != ?2
			   AND NOT EXISTS (SELECT 1 FROM stack_dismissed d WHERE d.asset_id = a.id)
			 ORDER BY a.taken_at, a.id LIMIT ?3`,
		)
			.bind(self.local_day, assetId, STACK_DAY_MAX + 1)
			.all<{ id: string; stack_id: string | null; taken_at: number | null }>();
		if (near.length > STACK_DAY_MAX) return; // 超密的一天交给补建

		// 代表：每组最早的一张（near 按拍摄时间正序）+ 所有未成组的单张
		const byStack = new Map<string, { id: string; stackId: string; count: number }>();
		const leaders: { id: string; stackId: string | null; count: number }[] = [];
		for (const r of near) {
			if (r.stack_id) {
				const g = byStack.get(r.stack_id);
				if (g) g.count++;
				else {
					const l = { id: r.id, stackId: r.stack_id, count: 1 };
					byStack.set(r.stack_id, l);
					leaders.push(l);
				}
			} else leaders.push({ id: r.id, stackId: null, count: 1 });
		}
		if (leaders.length > STACK_LEADER_MAX) return;

		const fps = new Map<string, { phash: string; v: Int8Array; n: number }>();
		const stmts: D1PreparedStatement[] = [];
		for (let i = 0; i < leaders.length; i += CHUNK) {
			const chunk = leaders.slice(i, i + CHUNK);
			stmts.push(
				env.DB.prepare(`SELECT asset_id, phash, embedding FROM asset_fp WHERE model = ? AND asset_id IN (${chunk.map(() => "?").join(",")})`).bind(
					FP_MODEL_VER,
					...chunk.map((l) => l.id),
				),
			);
		}
		for (let i = 0; i < stmts.length; i += 50) {
			for (const res of await env.DB.batch<{ asset_id: string; phash: string; embedding: ArrayBuffer }>(stmts.slice(i, i + 50))) {
				for (const r of res.results) {
					const v = asInt8(r.embedding);
					const n = norm8(v);
					if (n > 0) fps.set(r.asset_id, { phash: r.phash, v, n });
				}
			}
		}

		let bestGroup: { id: string; stackId: string } | null = null;
		let bestSingle: { id: string } | null = null;
		let bestGroupCos = STACK_MIN_COSINE;
		let bestSingleCos = STACK_MIN_COSINE;
		for (const l of leaders) {
			if (l.stackId && l.count >= STACK_MAX_MEMBERS) continue;
			const f = fps.get(l.id);
			if (!f || hamming(fp.phash, f.phash) > STACK_MAX_HAMMING) continue;
			const cos = dot8(sv, f.v) / (sn * f.n);
			// 优先并入已有的组（哪怕单张更像一点）：避免同一天裂出多个相似的组
			if (l.stackId) {
				if (cos >= bestGroupCos) {
					bestGroupCos = cos;
					bestGroup = { id: l.id, stackId: l.stackId };
				}
			} else if (cos >= bestSingleCos) {
				bestSingleCos = cos;
				bestSingle = { id: l.id };
			}
		}

		if (bestGroup) {
			if (self.stack_id !== bestGroup.stackId) await env.DB.prepare("UPDATE assets SET stack_id = ? WHERE id = ?").bind(bestGroup.stackId, assetId).run();
		} else if (bestSingle) {
			const gid = newStackId();
			await env.DB.batch([
				env.DB.prepare("UPDATE assets SET stack_id = ? WHERE id = ?").bind(gid, assetId),
				env.DB.prepare("UPDATE assets SET stack_id = ? WHERE id = ?").bind(gid, bestSingle.id),
			]);
		} else if (self.stack_id) {
			// 重新处理后不再像原来那组（比如换了模型）：移出
			await env.DB.prepare("UPDATE assets SET stack_id = NULL WHERE id = ?").bind(assetId).run();
		}
	} catch (e) {
		console.warn(JSON.stringify({ event: "stacks_failed", assetId, error: String(e).slice(0, 300) }));
	}
}

// ---------------------------------------------------------------- 按天聚类（补建）

export interface StackRow {
	id: string;
	stack_id: string | null;
	taken_at: number | null;
	phash: string;
	embedding: ArrayBuffer | number[] | Uint8Array | string;
}

/**
 * 一天的照片（按拍摄时间正序）做 leader 聚类：每张和已有各组的代表比（phash 粗筛 + 余弦），
 * 最像的组收下它；都不像就自成一个新代表。返回 id → stack_id（单张为 null）。
 * 和代表比而不是链式并查集：A 像 B、B 像 C 但 A 不像 C 时不会并成一组。
 */
export function clusterDay(rows: StackRow[]): Map<string, string | null> {
	interface Leader {
		hi: number;
		lo: number;
		v: Int8Array;
		n: number;
		stackId: string | null;
		ids: string[];
	}
	const leaders: Leader[] = [];
	const out = new Map<string, string | null>();
	for (const r of rows) {
		const v = asInt8(r.embedding);
		const n = norm8(v);
		if (!(n > 0)) {
			out.set(r.id, null);
			continue;
		}
		const hi = parseInt(r.phash.slice(0, 8), 16);
		const lo = parseInt(r.phash.slice(8, 16), 16);
		let bestGroup: Leader | null = null;
		let bestSingle: Leader | null = null;
		let bestGroupCos = STACK_MIN_COSINE;
		let bestSingleCos = STACK_MIN_COSINE;
		for (const l of leaders) {
			if (l.ids.length >= STACK_MAX_MEMBERS) continue;
			if (popcount(hi ^ l.hi) + popcount(lo ^ l.lo) > STACK_MAX_HAMMING) continue;
			const cos = dot8(v, l.v) / (n * l.n);
			// 优先并入已有的组，避免裂出多个相似的组
			if (l.stackId) {
				if (cos >= bestGroupCos) {
					bestGroupCos = cos;
					bestGroup = l;
				}
			} else if (cos >= bestSingleCos) {
				bestSingleCos = cos;
				bestSingle = l;
			}
		}
		const best = bestGroup ?? bestSingle;
		if (best) {
			if (!best.stackId) best.stackId = newStackId();
			best.ids.push(r.id);
			out.set(r.id, best.stackId);
		} else {
			leaders.push({ hi, lo, v, n, stackId: null, ids: [r.id] });
			out.set(r.id, null);
		}
	}
	// 收到第二张时才成组：代表自己也要写上组 id
	for (const l of leaders) if (l.stackId) out.set(l.ids[0]!, l.stackId);
	return out;
}

interface StateRow {
	cursor: string;
	done: number;
	processed: number;
	lock_until: number;
}

/**
 * 补建的一个 chunk：从 cursor 之后按天升序处理最多 STACK_BACKFILL_DAYS 天（累计读 STACK_BACKFILL_ROWS 行就停），
 * 每天整体重新聚类，只写和现有 stack_id 不同的行。超过 STACK_BACKFILL_DAY_MAX 张的天跳过。
 * 进度记在 stacks_state；处理完全部天数后 done = 1。reset 时从头重跑（校准阈值后用）。
 */
export async function rebuildStacksChunk(env: Env, reset = false): Promise<{ done: boolean; cursor: string; processed: number; busy?: boolean }> {
	await env.DB.prepare("INSERT OR IGNORE INTO stacks_state (id) VALUES (1)").run();
	if (reset) await env.DB.prepare("UPDATE stacks_state SET cursor = '', done = 0, processed = 0 WHERE id = 1").run();
	const state = (await env.DB.prepare("SELECT cursor, done, processed, lock_until FROM stacks_state WHERE id = 1").first<StateRow>())!;
	if (state.done) return { done: true, cursor: state.cursor, processed: state.processed };
	const now = Date.now();
	if (state.lock_until > now) return { done: false, cursor: state.cursor, processed: state.processed, busy: true };
	await env.DB.prepare("UPDATE stacks_state SET lock_until = ? WHERE id = 1").bind(now + STACK_BACKFILL_LOCK_MS).run();
	try {
		const { results: days } = await env.DB.prepare(
			// 写明索引：没有统计信息时规划器会顺着 assets_timeline 扫全库再临时排序去重
			`SELECT DISTINCT local_day FROM assets INDEXED BY assets_day
			 WHERE local_day > ? AND local_day IS NOT NULL AND deleted_at IS NULL AND status = 'ready' AND archived = 0
			 ORDER BY local_day LIMIT ?`,
		)
			.bind(state.cursor, STACK_BACKFILL_DAYS)
			.all<{ local_day: string }>();
		let lastDay = state.cursor;
		let processed = state.processed;
		let rowsRead = 0;
		for (const { local_day: day } of days) {
			lastDay = day;
			const { results: rows } = await env.DB.prepare(
				`SELECT a.id, a.stack_id, a.taken_at, f.phash, f.embedding
				 FROM assets a INDEXED BY assets_day JOIN asset_fp f ON f.asset_id = a.id AND f.model = ?
				 WHERE a.local_day = ? AND a.deleted_at IS NULL AND a.status = 'ready' AND a.archived = 0 AND a.kind != 'video'
				   AND NOT EXISTS (SELECT 1 FROM stack_dismissed d WHERE d.asset_id = a.id)
				 ORDER BY a.taken_at, a.id LIMIT ?`,
			)
				.bind(FP_MODEL_VER, day, STACK_BACKFILL_DAY_MAX + 1)
				.all<StackRow>();
			if (rows.length > STACK_BACKFILL_DAY_MAX) continue;
			rowsRead += rows.length;
			const want = clusterDay(rows);
			const writes: D1PreparedStatement[] = [];
			for (const r of rows) {
				const target = want.get(r.id) ?? null;
				if (target !== r.stack_id) writes.push(env.DB.prepare("UPDATE assets SET stack_id = ? WHERE id = ?").bind(target, r.id));
			}
			for (let i = 0; i < writes.length; i += 50) await env.DB.batch(writes.slice(i, i + 50));
			processed += rows.length;
			if (rowsRead >= STACK_BACKFILL_ROWS) break;
		}
		const done = days.length < STACK_BACKFILL_DAYS && (days.length === 0 || lastDay === days[days.length - 1]!.local_day);
		await env.DB.prepare("UPDATE stacks_state SET cursor = ?, done = ?, processed = ?, lock_until = 0, updated_at = ? WHERE id = 1")
			.bind(lastDay, done ? 1 : 0, processed, Date.now())
			.run();
		return { done, cursor: lastDay, processed };
	} catch (e) {
		await env.DB.prepare("UPDATE stacks_state SET lock_until = 0 WHERE id = 1").run().catch(() => {});
		throw e;
	}
}

// ---------------------------------------------------------------- 接口

/** 补建进度（设置页用）。依赖 stacks_state，不在 ETag 名单里。 */
stacks.get("/state", async (c) => {
	const s = await c.env.DB.prepare("SELECT cursor, done, processed FROM stacks_state WHERE id = 1").first<StateRow>();
	return c.json({ cursor: s?.cursor ?? "", done: !!s?.done, processed: s?.processed ?? 0 });
});

const RebuildBody = z.object({ reset: z.boolean().optional() });
/** 推进一个 chunk。只由用户点击触发（前端顺序请求，有次数上限）；熔断时拒绝。 */
stacks.post("/rebuild", async (c) => {
	if (await guardStub(c.env).isTripped()) return c.json({ error: "guard tripped" }, 409);
	const { reset } = RebuildBody.parse(await c.req.json().catch(() => ({})));
	const r = await rebuildStacksChunk(c.env, reset);
	if (r.busy) return c.json({ error: "busy" }, 409);
	return c.json(r);
});

/** 一组的成员（展开时按需取）。?day= 限定同一天：改过时间的成员在别的天显示，不混进这一天。 */
stacks.get("/:id/assets", async (c) => {
	const id = STACK_ID.parse(c.req.param("id"));
	const day = c.req.query("day");
	if (day !== undefined && !DAY.safeParse(day).success) return c.json({ error: "bad day" }, 400);
	return c.json(
		await page(
			c.env,
			// 先按 stack_id 索引找出成员再按主键读（CROSS JOIN 固定连接顺序），和连拍页一样
			`SELECT ${ITEM_COLUMNS}
			 FROM (SELECT id FROM assets WHERE stack_id = ?) g
			 CROSS JOIN assets a ON a.id = g.id
			 WHERE ${VISIBLE} AND a.archived = 0${day !== undefined ? " AND a.local_day = ?" : ""}
			 ORDER BY a.taken_at, a.id`,
			day !== undefined ? [id, day] : [id],
			offsetOf(c.req.query("offset")),
		),
	);
});

/** “不折叠这组”：整组成员记进 stack_dismissed（以后不再参与分组）并清掉 stack_id。 */
stacks.post("/:id/dismiss", async (c) => {
	const id = STACK_ID.parse(c.req.param("id"));
	const [, upd] = await c.env.DB.batch([
		c.env.DB.prepare("INSERT OR IGNORE INTO stack_dismissed (asset_id) SELECT id FROM assets WHERE stack_id = ?").bind(id),
		// 计数用 RETURNING：触发器会让 meta.changes 多算
		c.env.DB.prepare("UPDATE assets SET stack_id = NULL WHERE stack_id = ? RETURNING id").bind(id),
	]);
	return c.json({ dismissed: upd!.results.length });
});
