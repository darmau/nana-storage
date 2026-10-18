import { Hono } from "hono";
import { z } from "zod";
import {
	FACE_CORE_MIN,
	FACE_CRON_BATCH,
	FACE_DIMS,
	FACE_MATCH_MIN,
	FACE_MATCH_TOP_K,
	FACE_MIN_PX,
	FACE_MIN_SCORE,
	FACE_MODEL_VER,
	FACE_REJECT_RECOGNIZE_MAX,
	FACE_REVIEW_MAX,
	FACE_REVIEW_MIN,
	FACE_REVIEW_SEEDS,
	FACE_REVIEW_TOP_K,
	MASK_FACE_COVER,
	PEOPLE_MIN_ASSETS,
	decodeMask,
	maskCoverage,
	type MaskStroke,
} from "@nana/shared";
import { derivedKey } from "./derived";
import { guardStub } from "./guard";
import { andType, offsetOf, page, TypeParam, typeCondition } from "./library";
import type { FaceScan } from "./processor";
import { asInt8, base64ToBytes, blobOf } from "./similar";
import { ITEM_COLUMNS } from "./timeline";
import { ulid } from "./ulid";

/**
 * 人物（人脸识别）。交互参照 iOS 相册 / Google 相册：人物就是一组同一个人的脸，名字可有可无。
 *
 * 人脸由容器在 derive 时算好（apps/processor/faces.mjs）：人脸框、置信度、清晰度、ArcFace 向量（512 个 int8），
 * 以及所有头像横向拼成的一张 WebP（R2，key 记在 face_scans.sprite_key）。都按用户旋转之前的图像计算，旋转不重算。
 *
 * D1 的 faces 是唯一真实数据；Vectorize（FACE_INDEX）只存 face_id 和向量，用来找最像的脸。查询结果一律再用 D1 过滤。
 * 写入失败时 indexed = 0，由每小时的 Cron 补写。本地开发没有 Vectorize：只记录人脸，不归入人物。
 *
 * 归入人物（recognizeFace，类似 DBSCAN）：
 *  - 新照片的脸在 process / faces 任务里当场识别；推迟的和漏掉的由每小时的 Cron 处理（每次最多 FACE_CRON_BATCH 张）。
 *  - 用户的操作优先：手动指定（assigned = 2）的脸、否认过的（face_rejects）人物都不会被自动处理改掉。
 *    否认之后移出来的脸改回待识别、当场重新识别（排除否认过的人物），可能归到本来该是的那个人。
 *  - 被打码盖住的脸（faces.masked，见 applyMaskToFaces）不参与识别：不属于任何人物、state = 3、不在 Vectorize 里，信息面板也不列出。
 *
 * 成本：每张脸识别 1 次 Vectorize 查询 + 几次 D1 读写；列表和“确认更多照片”只由用户打开页面触发，没有轮询。
 */

type Bindings = { Bindings: Env };
export const people = new Hono<Bindings>();

const ID = z.string().regex(/^[0-9A-Z]{26}$/);
const VISIBLE = "a.deleted_at IS NULL AND a.status = 'ready'";
/** D1 单条语句最多 100 个参数。 */
const CHUNK = 90;
const marks = (n: number) => Array.from({ length: n }, () => "?").join(",");

/** 绑定缺失（本地开发、测试）时返回 undefined。 */
export function faceIndex(env: Env): VectorizeIndex | undefined {
	return (env as { FACE_INDEX?: VectorizeIndex }).FACE_INDEX;
}

/** 识别进度（faces.state）。 */
export const FACE_STATE = { pending: 0, deferred: 1, done: 2, ignored: 3 } as const;
/** faces.assigned */
export const ASSIGNED = { none: 0, auto: 1, manual: 2 } as const;

// ---------------------------------------------------------------- 写入

export interface ParsedFace {
	x: number;
	y: number;
	w: number;
	h: number;
	px: number;
	score: number;
	sharpness: number;
	embedding: Int8Array;
}

const unit = (v: unknown) => typeof v === "number" && v >= 0 && v <= 1;
const finite = (v: unknown) => typeof v === "number" && Number.isFinite(v);

/** 校验容器返回的人脸。整体格式不对就当作没有（不让任务失败）；单张脸不对就丢掉这张（序号保持，头像拼图要用）。 */
export function parseFaceScan(scan: FaceScan | null | undefined): { faces: (ParsedFace | null)[]; sprite: Uint8Array | null } | null {
	if (!scan || scan.model !== FACE_MODEL_VER || !Array.isArray(scan.faces) || scan.faces.length > 64) return null;
	let sprite: Uint8Array | null = null;
	if (scan.faces.length) {
		if (typeof scan.sprite !== "string") return null;
		try {
			sprite = base64ToBytes(scan.sprite);
		} catch {
			return null;
		}
	}
	const faces = scan.faces.map((f): ParsedFace | null => {
		if (!f || ![f.x, f.y, f.w, f.h].every(unit) || ![f.px, f.score, f.sharpness].every(finite) || typeof f.embedding !== "string") return null;
		let bytes: Uint8Array;
		try {
			bytes = base64ToBytes(f.embedding);
		} catch {
			return null;
		}
		if (bytes.length !== FACE_DIMS) return null;
		const embedding = new Int8Array(bytes.buffer, bytes.byteOffset, bytes.length);
		if (!embedding.some((x) => x !== 0)) return null;
		return { x: f.x, y: f.y, w: f.w, h: f.h, px: f.px, score: f.score, sharpness: f.sharpness, embedding };
	});
	return { faces, sprite };
}

/** 够大、够确定的脸才参与识别。 */
export const recognizable = (f: Pick<ParsedFace, "score" | "px">) => f.score >= FACE_MIN_SCORE && f.px >= FACE_MIN_PX;

/** 用户旋转之前的宽高比（assets.width / height 是旋转之后的）。不知道尺寸时按正方形算。 */
function originalAspect(a: { width: number | null; height: number | null; rotation: number }) {
	if (!a.width || !a.height) return 1;
	return a.rotation % 180 ? a.height / a.width : a.width / a.height;
}

/** 照片的打码笔画和宽高比，没有打码时为 null。 */
async function maskOf(env: Env, assetId: string): Promise<{ strokes: MaskStroke[]; aspect: number } | null> {
	const a = await env.DB.prepare("SELECT mask, width, height, rotation FROM assets WHERE id = ?")
		.bind(assetId)
		.first<{ mask: string | null; width: number | null; height: number | null; rotation: number }>();
	const strokes = decodeMask(a?.mask);
	return a && strokes ? { strokes, aspect: originalAspect(a) } : null;
}

const isMasked = (m: { strokes: MaskStroke[]; aspect: number } | null, box: { x: number; y: number; w: number; h: number }) =>
	!!m && maskCoverage(m.strokes, box, m.aspect) >= MASK_FACE_COVER;

/**
 * 打码改变之后（PATCH /assets/:id）：新盖住的脸移出人物、不再参与识别，删掉向量；不再盖住的脸改回待识别，
 * 由每小时的 Cron 补写向量、重新归入（和新照片一样，原来手动指定的人物不保留）。返回新盖住和放开的脸数。
 */
export async function applyMaskToFaces(env: Env, assetId: string): Promise<{ masked: number; unmasked: number }> {
	const [m, { results }] = await Promise.all([
		maskOf(env, assetId),
		env.DB.prepare("SELECT id, x, y, w, h, masked FROM faces WHERE asset_id = ?")
			.bind(assetId)
			.all<{ id: string; x: number; y: number; w: number; h: number; masked: number }>(),
	]);
	const hide = results.filter((f) => !f.masked && isMasked(m, f)).map((f) => f.id);
	const show = results.filter((f) => f.masked && !isMasked(m, f)).map((f) => f.id);
	const stmts: D1PreparedStatement[] = [];
	if (hide.length) {
		stmts.push(
			env.DB.prepare(
				`UPDATE faces SET masked = 1, person_id = NULL, assigned = ${ASSIGNED.none}, state = ${FACE_STATE.ignored}, indexed = 0
				 WHERE id IN (${marks(hide.length)})`,
			).bind(...hide),
		);
	}
	if (show.length) {
		stmts.push(
			env.DB.prepare(
				`UPDATE faces SET masked = 0, assigned = ${ASSIGNED.none}, indexed = 0,
				   state = CASE WHEN score >= ? AND px >= ? THEN ${FACE_STATE.pending} ELSE ${FACE_STATE.ignored} END
				 WHERE id IN (${marks(show.length)})`,
			).bind(FACE_MIN_SCORE, FACE_MIN_PX, ...show),
		);
	}
	if (stmts.length) await env.DB.batch(stmts);
	await deleteFaceVectors(env, hide);
	return { masked: hide.length, unmasked: show.length };
}

/**
 * process / faces 任务调用：写头像拼图（R2）和 D1，再尽力写 Vectorize，然后当场识别。
 * 已经用当前模型扫描过的照片（比如重新处理）保留原来的结果，不覆盖用户的修改。
 * 返回是否有可用的结果；只有 D1 / R2 写入失败会抛错，识别失败只记日志。
 */
export async function saveFaces(env: Env, assetId: string, scan: FaceScan | null, rev: number): Promise<boolean> {
	const parsed = parseFaceScan(scan);
	if (!parsed) {
		if (scan) console.warn(JSON.stringify({ event: "faces_invalid", assetId }));
		return false;
	}
	const old = await env.DB.prepare("SELECT model, sprite_key FROM face_scans WHERE asset_id = ?")
		.bind(assetId)
		.first<{ model: string; sprite_key: string | null }>();
	if (old?.model === FACE_MODEL_VER) return true;

	const now = Date.now();
	const spriteKey = parsed.sprite ? derivedKey(assetId, "faces", rev, "webp") : null;
	if (spriteKey && parsed.sprite) await env.PHOTOS.put(spriteKey, parsed.sprite, { httpMetadata: { contentType: "image/webp" } });

	// 打码盖住的脸只记录，不参与识别（见 applyMaskToFaces）
	const mask = await maskOf(env, assetId);
	const rows = parsed.faces.flatMap((f, idx) => (f ? [{ ...f, idx, id: ulid(), masked: isMasked(mask, f) }] : []));
	const usable = rows.filter((f) => recognizable(f) && !f.masked);
	// 先写 Vectorize，成功了就直接插入 indexed = 1，省掉事后再改一遍每一行（和 faces_unindexed 索引）。
	// D1 写入失败时 Vectorize 里会多出没有对应行的向量，查询结果一律用 D1 过滤，不影响。
	const vectorized = (await upsertFaceVectors(env, usable)) > 0;
	await env.DB.batch([
		env.DB.prepare("DELETE FROM faces WHERE asset_id = ?").bind(assetId),
		...rows.map((f) =>
			env.DB.prepare(
				`INSERT INTO faces (id, asset_id, idx, x, y, w, h, px, score, sharpness, embedding, state, indexed, masked, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).bind(
				f.id,
				assetId,
				f.idx,
				f.x,
				f.y,
				f.w,
				f.h,
				Math.round(f.px),
				f.score,
				f.sharpness,
				blobOf(f.embedding),
				recognizable(f) && !f.masked ? FACE_STATE.pending : FACE_STATE.ignored,
				vectorized && recognizable(f) && !f.masked ? 1 : 0,
				f.masked ? 1 : 0,
				now,
			),
		),
		env.DB.prepare(
			"INSERT OR REPLACE INTO face_scans (asset_id, model, count, sprite_key, updated_at) VALUES (?, ?, ?, ?, ?)",
		).bind(assetId, FACE_MODEL_VER, parsed.faces.length, spriteKey, now),
	]);
	if (old?.sprite_key && old.sprite_key !== spriteKey) await env.PHOTOS.delete(old.sprite_key);

	try {
		for (const f of usable) await recognizeFace(env, f.id, false);
	} catch (e) {
		// 留在 pending，由 Cron 再识别
		console.warn(JSON.stringify({ event: "face_recognize_failed", assetId, error: String(e).slice(0, 300) }));
	}
	return true;
}

/** 写入 Vectorize，返回写入的条数（失败或没有索引时为 0）。 */
async function upsertFaceVectors(env: Env, rows: { id: string; embedding: Int8Array }[]): Promise<number> {
	const index = faceIndex(env);
	if (!index || !rows.length) return 0;
	try {
		await index.upsert(rows.map((r) => ({ id: r.id, values: Array.from(r.embedding) })));
	} catch (e) {
		console.warn(JSON.stringify({ event: "face_upsert_failed", count: rows.length, error: String(e).slice(0, 300) }));
		return 0;
	}
	return rows.length;
}

/** 补写已经在 D1 里的人脸：写入 Vectorize，成功后标记 indexed。 */
async function indexFaces(env: Env, rows: { id: string; embedding: Int8Array }[]): Promise<number> {
	if (!(await upsertFaceVectors(env, rows))) return 0;
	for (let i = 0; i < rows.length; i += CHUNK) {
		const chunk = rows.slice(i, i + CHUNK).map((r) => r.id);
		await env.DB.prepare(`UPDATE faces SET indexed = 1 WHERE id IN (${marks(chunk.length)})`).bind(...chunk).run();
	}
	return rows.length;
}

/** 永久删除时调用：尽力删掉 Vectorize 里的人脸向量（失败也没关系，查询结果会被 D1 过滤）。 */
export async function deleteFaceVectors(env: Env, faceIds: string[]) {
	const index = faceIndex(env);
	if (!index || !faceIds.length) return;
	try {
		for (let i = 0; i < faceIds.length; i += 1000) await index.deleteByIds(faceIds.slice(i, i + 1000));
	} catch (e) {
		console.warn(JSON.stringify({ event: "face_vector_delete_failed", count: faceIds.length, error: String(e).slice(0, 300) }));
	}
}

// ---------------------------------------------------------------- 归入人物

interface NeighborRow {
	id: string;
	person_id: string | null;
	assigned: number;
}

/** Vectorize 里和这个向量最像的脸（相似度至少 minScore），按相似度从高到低。 */
async function similarFaces(index: VectorizeIndex, vector: ArrayLike<number>, topK: number, minScore: number) {
	const { matches } = await index.query(Array.from(vector), { topK, returnValues: false, returnMetadata: "none" });
	return matches.filter((m) => m.score >= minScore && ID.safeParse(m.id).success);
}

/** 按 ids 的顺序取出还存在、参与识别、不在回收站里的脸。 */
async function neighborRows(env: Env, ids: string[]): Promise<NeighborRow[]> {
	if (!ids.length) return [];
	const { results } = await env.DB.prepare(
		`SELECT f.id, f.person_id, f.assigned FROM faces f JOIN assets a ON a.id = f.asset_id
		 WHERE f.id IN (${marks(ids.length)}) AND f.state != ${FACE_STATE.ignored} AND ${VISIBLE}`,
	)
		.bind(...ids)
		.all<NeighborRow>();
	const byId = new Map(results.map((r) => [r.id, r]));
	return ids.flatMap((id) => byId.get(id) ?? []);
}

/** 附近的脸按人物投票（相似度相加），得票最多的人物；附近没有人物时返回 null。 */
function votePerson(near: NeighborRow[], score: Map<string, number>): string | null {
	const votes = new Map<string, number>();
	for (const r of near) if (r.person_id) votes.set(r.person_id, (votes.get(r.person_id) ?? 0) + (score.get(r.id) ?? 0));
	let best: string | null = null;
	for (const [id, v] of votes) if (best === null || v > votes.get(best)!) best = id;
	return best;
}

/**
 * 识别一张脸。final 为 false 时，附近的脸不够、也没有人物就推迟（state 1）；为 true 时就此结束（state 2）。
 * 返回结果：assigned（归入已有人物）/ created（新建了人物）/ deferred / none / skipped。
 */
export async function recognizeFace(env: Env, faceId: string, final: boolean): Promise<string> {
	const index = faceIndex(env);
	if (!index) return "skipped";
	const face = await env.DB.prepare("SELECT id, person_id, assigned, state, embedding FROM faces WHERE id = ?")
		.bind(faceId)
		.first<NeighborRow & { state: number; embedding: ArrayBuffer }>();
	if (!face || face.state >= FACE_STATE.done) return "skipped";
	if (face.person_id || face.assigned === ASSIGNED.manual) {
		await env.DB.prepare("UPDATE faces SET state = ? WHERE id = ?").bind(FACE_STATE.done, faceId).run();
		return "skipped";
	}

	const matches = (await similarFaces(index, asInt8(face.embedding), FACE_MATCH_TOP_K, FACE_MATCH_MIN)).filter((m) => m.id !== faceId);
	const score = new Map(matches.map((m) => [m.id, m.score]));
	const all = await neighborRows(env, matches.map((m) => m.id));
	const { results: rejects } = await env.DB.prepare("SELECT person_id FROM face_rejects WHERE face_id = ?")
		.bind(faceId)
		.all<{ person_id: string }>();
	const rejected = new Set(rejects.map((r) => r.person_id));

	// 否认过的人物里的脸不算邻居：既不投票，也不凑“核心”，否则移出来的脸会自己成一个人物
	const near = all.filter((r) => !r.person_id || !rejected.has(r.person_id));
	const core = near.length + 1 >= FACE_CORE_MIN;
	let person = votePerson(near, score);
	if (!person && !core) {
		await env.DB.prepare("UPDATE faces SET state = ? WHERE id = ?")
			.bind(final ? FACE_STATE.done : FACE_STATE.deferred, faceId)
			.run();
		return final ? "none" : "deferred";
	}

	const now = Date.now();
	const created = !person;
	const stmts: D1PreparedStatement[] = [];
	if (!person) {
		person = ulid();
		stmts.push(env.DB.prepare("INSERT INTO people (id, name, created_at, updated_at) VALUES (?, NULL, ?, ?)").bind(person, now, now));
	}
	// 条件里再确认一次：期间用户可能手动改过
	const assign = (ids: string[]) =>
		env.DB.prepare(
			`UPDATE faces SET person_id = ?, assigned = ${ASSIGNED.auto}, state = ${FACE_STATE.done}
			 WHERE id IN (${marks(ids.length)}) AND person_id IS NULL AND assigned != ${ASSIGNED.manual}
			   AND NOT EXISTS (SELECT 1 FROM face_rejects r WHERE r.face_id = faces.id AND r.person_id = ?)`,
		).bind(person, ...ids, person);
	stmts.push(assign([faceId]));
	// 核心点：附近还没有人物的脸一起归进来（密度可达）
	const free = core ? near.filter((r) => !r.person_id && r.assigned !== ASSIGNED.manual).map((r) => r.id) : [];
	if (free.length) stmts.push(assign(free));
	await env.DB.batch(stmts);
	return created ? "created" : "assigned";
}

/** 推迟的脸等这么久再做最后一次识别（批量导入时，同一个人的其他照片多半已经处理完了）。 */
export const FACE_DEFER_MS = 6 * 3600_000;

/**
 * 每小时 Cron：补写没进 Vectorize 的人脸，再识别漏掉的（state 0）和推迟超过 FACE_DEFER_MS 的（state 1，这次就此结束），
 * 合计每次最多 FACE_CRON_BATCH 张；最后删掉已经没有脸的未命名人物。熔断时跳过，不会自我触发。
 */
export async function recognizePendingFaces(env: Env, now = Date.now()): Promise<{ indexed: number; recognized: number }> {
	const index = faceIndex(env);
	if (!index || (await guardStub(env).isTripped())) return { indexed: 0, recognized: 0 };

	const { results: unindexed } = await env.DB.prepare(
		`SELECT id, embedding FROM faces WHERE indexed = 0 AND state != ${FACE_STATE.ignored} ORDER BY created_at LIMIT ?`,
	)
		.bind(FACE_CRON_BATCH)
		.all<{ id: string; embedding: ArrayBuffer }>();
	let indexed = 0;
	for (let i = 0; i < unindexed.length; i += 500) {
		indexed += await indexFaces(env, unindexed.slice(i, i + 500).map((r) => ({ id: r.id, embedding: asInt8(r.embedding) })));
	}

	const { results } = await env.DB.prepare(
		`SELECT id, state FROM faces
		 WHERE (state = ${FACE_STATE.pending} AND indexed = 1) OR (state = ${FACE_STATE.deferred} AND created_at < ?)
		 ORDER BY state, created_at LIMIT ?`,
	)
		.bind(now - FACE_DEFER_MS, FACE_CRON_BATCH)
		.all<{ id: string; state: number }>();
	let recognized = 0;
	for (const r of results) {
		await recognizeFace(env, r.id, r.state === FACE_STATE.deferred);
		recognized++;
	}
	await env.DB.prepare(
		"DELETE FROM people WHERE name IS NULL AND NOT EXISTS (SELECT 1 FROM faces f WHERE f.person_id = people.id)",
	).run();
	if (indexed || recognized) console.log(JSON.stringify({ event: "faces_recognized", indexed, recognized }));
	return { indexed, recognized };
}

// ---------------------------------------------------------------- 查询

/**
 * 前端画头像需要的信息：拼图地址由 assetId + v 组成，第 idx 格，共 count 格；rotation 是照片的旋转角度。
 * rev 是照片当前的派生文件版本号（缩略图地址用）。
 */
export interface FaceRef {
	id: string;
	assetId: string;
	idx: number;
	count: number;
	v: number;
	rotation: number;
	rev: number;
}

interface FaceRefRow {
	id: string;
	asset_id: string;
	idx: number;
	count: number;
	sprite_key: string | null;
	rotation: number;
	derived_rev: number;
}
const FACE_REF_COLUMNS = "f.id, f.asset_id, f.idx, s.count, s.sprite_key, a.rotation, a.derived_rev";
const FACE_REF_JOIN = "JOIN face_scans s ON s.asset_id = f.asset_id JOIN assets a ON a.id = f.asset_id";

/** 拼图的 key 是 d/{assetId}/faces-{v}.webp，v 就是生成时的派生文件版本号。 */
export function spriteVersion(key: string | null): number | null {
	const m = key?.match(/\/faces-(\d+)\.webp$/);
	return m ? Number(m[1]) : null;
}

function faceRef(r: FaceRefRow): FaceRef | null {
	const v = spriteVersion(r.sprite_key);
	if (v === null) return null;
	return { id: r.id, assetId: r.asset_id, idx: r.idx, count: r.count, v, rotation: r.rotation, rev: r.derived_rev };
}

interface PersonRow {
	id: string;
	name: string | null;
	hidden: number;
	favorite: number;
	cover_face_id: string | null;
	count: number;
}

/** 封面：用户选的（还在这个人物里、照片可见），否则挑一张手动确认过的、最大最清楚的脸。 */
async function covers(env: Env, rows: PersonRow[]): Promise<Map<string, FaceRef>> {
	const out = new Map<string, FaceRef>();
	if (!rows.length) return out;
	// 人物不多时（详情、文件夹里的人物）只读这几个人物的脸（faces_person 索引），否则一次扫完全部
	const only = rows.length <= CHUNK ? rows.map((r) => r.id) : [];
	const { results } = await env.DB.prepare(
		`SELECT person_id, ${FACE_REF_COLUMNS} FROM (
		   SELECT f.*, ROW_NUMBER() OVER (
		     PARTITION BY f.person_id
		     ORDER BY f.id = p.cover_face_id DESC, f.assigned = ${ASSIGNED.manual} DESC, f.px * f.score * MIN(f.sharpness, 200) DESC
		   ) AS rn
		   FROM faces f JOIN people p ON p.id = f.person_id JOIN assets a ON a.id = f.asset_id
		   WHERE ${VISIBLE}${only.length ? ` AND f.person_id IN (${marks(only.length)})` : ""}
		 ) f ${FACE_REF_JOIN} WHERE f.rn = 1`,
	)
		.bind(...only)
		.all<FaceRefRow & { person_id: string }>();
	const wanted = new Set(rows.map((r) => r.id));
	for (const r of results) {
		if (!wanted.has(r.person_id)) continue;
		const ref = faceRef(r);
		if (ref) out.set(r.person_id, ref);
	}
	return out;
}

const personJson = (r: PersonRow, cover: FaceRef | undefined) => ({
	id: r.id,
	name: r.name,
	hidden: !!r.hidden,
	favorite: !!r.favorite,
	count: r.count,
	cover: cover ?? null,
});

/** 人物列表：个人收藏在前，然后是已命名的、未命名的，各按照片数排序。未命名的至少要有 PEOPLE_MIN_ASSETS 张。 */
people.get("/people", async (c) => {
	const hidden = c.req.query("hidden") === "1" ? 1 : 0;
	const { results } = await c.env.DB.prepare(
		`SELECT p.id, p.name, p.hidden, p.favorite, p.cover_face_id, COUNT(DISTINCT f.asset_id) AS count
		 -- CROSS JOIN 从人物的脸出发（faces_person）按主键读照片；否则规划器会扫完整个资料库再逐张查脸
		 FROM people p CROSS JOIN faces f ON f.person_id = p.id CROSS JOIN assets a ON a.id = f.asset_id
		 WHERE p.hidden = ? AND ${VISIBLE}
		 GROUP BY p.id HAVING p.name IS NOT NULL OR count >= ?
		 ORDER BY p.favorite DESC, p.name IS NULL, count DESC, p.id`,
	)
		.bind(hidden, PEOPLE_MIN_ASSETS)
		.all<PersonRow>();
	const cv = await covers(c.env, results);
	const hiddenCount = hidden
		? 0
		: ((await c.env.DB.prepare("SELECT COUNT(*) AS n FROM people WHERE hidden = 1").first<{ n: number }>())?.n ?? 0);
	return c.json({ items: results.map((r) => personJson(r, cv.get(r.id))), hidden: hiddenCount, indexAvailable: !!faceIndex(c.env) });
});

/** 文件夹页顶部最多列出的人物数。 */
const FOLDER_PEOPLE_MAX = 40;

/**
 * GET /api/folders/:id/people（id = "root" 表示根目录）→ 这个文件夹里的照片中出现的人物，只看本文件夹、不含子文件夹。
 * 和人物列表一样不列隐藏的人物，未命名的人物在全库至少要有 PEOPLE_MIN_ASSETS 张；count 是本文件夹里的张数。
 * 只取决于可见的条目和人物，带 ETag（library + people，src/dbcache.ts），没变时只读版本号。
 * 读取量约等于本文件夹的照片数 + 其中的脸数（assets_folder_visible、faces_asset 索引）。
 */
people.get("/folders/:id/people", async (c) => {
	const id = c.req.param("id") === "root" ? null : ID.parse(c.req.param("id"));
	const { results } = await c.env.DB.prepare(
		`WITH here AS (
		   SELECT f.person_id, COUNT(DISTINCT f.asset_id) AS count
		   FROM assets a INDEXED BY assets_folder_visible JOIN faces f ON f.asset_id = a.id
		   WHERE ${id ? "a.folder_id = ?" : "a.folder_id IS NULL"} AND ${VISIBLE} AND f.person_id IS NOT NULL
		   GROUP BY f.person_id
		 )
		 SELECT p.id, p.name, p.hidden, p.favorite, p.cover_face_id, h.count
		 FROM here h JOIN people p ON p.id = h.person_id
		 WHERE p.hidden = 0 AND (p.name IS NOT NULL OR (
		   SELECT COUNT(DISTINCT f.asset_id) FROM faces f JOIN assets a ON a.id = f.asset_id WHERE f.person_id = p.id AND ${VISIBLE}
		 ) >= ?)
		 ORDER BY p.favorite DESC, p.name IS NULL, h.count DESC, p.id LIMIT ?`,
	)
		.bind(...(id ? [id] : []), PEOPLE_MIN_ASSETS, FOLDER_PEOPLE_MAX)
		.all<PersonRow>();
	const cv = await covers(c.env, results);
	return c.json({ items: results.map((r) => personJson(r, cv.get(r.id))) });
});

async function personRow(env: Env, id: string): Promise<PersonRow | null> {
	return env.DB.prepare(
		`SELECT p.id, p.name, p.hidden, p.favorite, p.cover_face_id,
		   (SELECT COUNT(DISTINCT f.asset_id) FROM faces f JOIN assets a ON a.id = f.asset_id WHERE f.person_id = p.id AND ${VISIBLE}) AS count
		 FROM people p WHERE p.id = ?`,
	)
		.bind(id)
		.first<PersonRow>();
}

people.get("/people/:id", async (c) => {
	const row = await personRow(c.env, ID.parse(c.req.param("id")));
	if (!row) return c.json({ error: "not found" }, 404);
	const cv = await covers(c.env, [row]);
	return c.json(personJson(row, cv.get(row.id)));
});

/** 人物的照片，按拍摄时间倒序（和相册一样支持 ?type= 筛选和拖动条的每月张数）。 */
people.get("/people/:id/assets", async (c) => {
	const type = typeCondition(TypeParam.parse(c.req.query("type")));
	return c.json(
		await page(
			c.env,
			// 从这个人物的脸出发（CROSS JOIN 固定连接顺序）：写成 a.id IN (...) 时，没有统计信息的 SQLite 会顺着 assets_timeline 扫完整个资料库
			`SELECT ${ITEM_COLUMNS}
			 FROM (SELECT DISTINCT asset_id FROM faces WHERE person_id = ?) p CROSS JOIN assets a ON a.id = p.asset_id
			 WHERE ${VISIBLE}${andType(type)}
			 ORDER BY a.taken_at DESC, a.id DESC`,
			[ID.parse(c.req.param("id")), ...(type?.binds ?? [])],
			offsetOf(c.req.query("offset")),
			{ withMonths: true },
		),
	);
});

const Name = z.string().trim().min(1).max(100);
const PatchBody = z.object({
	name: Name.nullable().optional(),
	hidden: z.boolean().optional(),
	favorite: z.boolean().optional(),
	coverFaceId: ID.nullable().optional(),
	/** 用这张照片里属于这个人物的脸做封面（网格右键菜单只知道照片）。有几张时取最大最清楚的。 */
	coverAssetId: ID.optional(),
});

/**
 * 改名字 / 隐藏 / 个人收藏 / 封面。名字和另一个人物重复时返回 409 和那个人物的 id（前端问要不要合并）。
 * 封面可以直接给脸（coverFaceId，null 恢复自动挑选），也可以给照片（coverAssetId）。
 */
people.patch("/people/:id", async (c) => {
	const id = ID.parse(c.req.param("id"));
	const body = PatchBody.parse(await c.req.json());
	if (!(await c.env.DB.prepare("SELECT 1 FROM people WHERE id = ?").bind(id).first())) return c.json({ error: "not found" }, 404);
	if (body.name) {
		const other = await c.env.DB.prepare("SELECT id FROM people WHERE name = ? AND id != ?").bind(body.name, id).first<{ id: string }>();
		if (other) return c.json({ error: "name taken", personId: other.id }, 409);
	}
	if (body.coverFaceId) {
		const ok = await c.env.DB.prepare("SELECT 1 FROM faces WHERE id = ? AND person_id = ?").bind(body.coverFaceId, id).first();
		if (!ok) return c.json({ error: "face not in person" }, 400);
	}
	if (body.coverAssetId) {
		const face = await c.env.DB.prepare(
			"SELECT id FROM faces WHERE asset_id = ? AND person_id = ? ORDER BY px * score * MIN(sharpness, 200) DESC LIMIT 1",
		)
			.bind(body.coverAssetId, id)
			.first<{ id: string }>();
		if (!face) return c.json({ error: "face not in person" }, 400);
		body.coverFaceId = face.id;
	}
	const sets: string[] = [];
	const binds: unknown[] = [];
	const set = (column: string, value: unknown) => {
		sets.push(`${column} = ?`);
		binds.push(value);
	};
	if (body.name !== undefined) set("name", body.name);
	if (body.hidden !== undefined) set("hidden", body.hidden ? 1 : 0);
	if (body.favorite !== undefined) set("favorite", body.favorite ? 1 : 0);
	if (body.coverFaceId !== undefined) set("cover_face_id", body.coverFaceId);
	if (sets.length) {
		await c.env.DB.prepare(`UPDATE people SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`)
			.bind(...binds, Date.now(), id)
			.run();
	}
	const row = await personRow(c.env, id);
	return c.json(personJson(row!, (await covers(c.env, [row!])).get(id)));
});

/** 把 ids 这几个人物合并进 :id。名字、封面以 :id 为准（:id 没有名字时用第一个有名字的）。 */
people.post("/people/:id/merge", async (c) => {
	const id = ID.parse(c.req.param("id"));
	const { ids } = z.object({ ids: z.array(ID).min(1).max(CHUNK) }).parse(await c.req.json());
	const from = [...new Set(ids)].filter((x) => x !== id);
	const target = await c.env.DB.prepare("SELECT name FROM people WHERE id = ?").bind(id).first<{ name: string | null }>();
	if (!target) return c.json({ error: "not found" }, 404);
	if (!from.length) return c.json({ merged: 0 });
	const { results: sources } = await c.env.DB.prepare(`SELECT id, name FROM people WHERE id IN (${marks(from.length)})`)
		.bind(...from)
		.all<{ id: string; name: string | null }>();
	const list = sources.map((s) => s.id);
	if (!list.length) return c.json({ merged: 0 });
	const name = target.name ?? sources.find((s) => s.name)?.name ?? null;
	const now = Date.now();
	await c.env.DB.batch([
		c.env.DB.prepare(`UPDATE faces SET person_id = ? WHERE person_id IN (${marks(list.length)})`).bind(id, ...list),
		// 合并进来的脸以前被否认过属于 :id 的，否认作废（用户现在说它们是同一个人）
		c.env.DB.prepare(
			`DELETE FROM face_rejects WHERE person_id = ? AND face_id IN (SELECT id FROM faces WHERE person_id = ?)`,
		).bind(id, id),
		c.env.DB.prepare(`DELETE FROM people WHERE id IN (${marks(list.length)})`).bind(...list),
		c.env.DB.prepare("UPDATE people SET name = ?, updated_at = ? WHERE id = ?").bind(name, now, id),
	]);
	return c.json({ merged: list.length });
});

/**
 * 否认之后移出来的脸改回待识别（太小、太不确定的不参与识别）：记过 face_rejects，重新识别时不会归回原来的人物，
 * 而是归到附近其他的人物（比如本来就该是的那个人），没有就推迟 / 不归入。
 */
const UNASSIGN = `person_id = NULL, assigned = ${ASSIGNED.none},
	state = CASE WHEN masked = 0 AND score >= ${FACE_MIN_SCORE} AND px >= ${FACE_MIN_PX} THEN ${FACE_STATE.pending} ELSE ${FACE_STATE.ignored} END`;

/**
 * 当场重新识别否认后移出来的脸，最多 FACE_REJECT_RECOGNIZE_MAX 张（只由用户操作触发），剩下的和失败的留在 pending，由每小时的 Cron 处理。
 * 熔断时和 Cron 一样跳过。
 */
async function recognizeRejected(env: Env, faceIds: string[]) {
	const ids = faceIds.slice(0, FACE_REJECT_RECOGNIZE_MAX);
	if (!ids.length || !faceIndex(env) || (await guardStub(env).isTripped())) return;
	try {
		for (const id of ids) await recognizeFace(env, id, false);
	} catch (e) {
		console.warn(JSON.stringify({ event: "face_recognize_failed", count: ids.length, error: String(e).slice(0, 300) }));
	}
}

/** 从人物中移除这些照片：照片里属于这个人物的脸移出来，记下“不是这个人”，再重新识别（不会归回这个人物）。 */
people.post("/people/:id/remove", async (c) => {
	const id = ID.parse(c.req.param("id"));
	const { assetIds } = z.object({ assetIds: z.array(ID).min(1).max(1000) }).parse(await c.req.json());
	const faceIds: string[] = [];
	let removed = 0;
	for (let i = 0; i < assetIds.length; i += CHUNK - 2) {
		const chunk = assetIds.slice(i, i + CHUNK - 2);
		const [, res] = await c.env.DB.batch([
			c.env.DB.prepare(
				`INSERT OR IGNORE INTO face_rejects (face_id, person_id)
				 SELECT id, ? FROM faces WHERE person_id = ? AND asset_id IN (${marks(chunk.length)})`,
			).bind(id, id, ...chunk),
			c.env.DB.prepare(
				`UPDATE faces SET ${UNASSIGN}
				 WHERE person_id = ? AND asset_id IN (${marks(chunk.length)}) RETURNING id, state`,
			).bind(id, ...chunk),
		]);
		for (const r of (res?.results ?? []) as { id: string; state: number }[]) if (r.state === FACE_STATE.pending) faceIds.push(r.id);
		removed += res?.results.length ?? 0;
	}
	await recognizeRejected(c.env, faceIds);
	return c.json({ removed });
});

/**
 * “这是其他人物”：照片里属于这个人物的脸改归到另一个人物（已有的，或者一个名字：有同名的就用它，没有就新建），
 * 算手动指定；同时记下“不是原来这个人”，以后不会再自动归回来。
 */
people.post("/people/:id/reassign", async (c) => {
	const id = ID.parse(c.req.param("id"));
	const body = z
		.object({ assetIds: z.array(ID).min(1).max(1000) })
		.and(z.union([z.object({ personId: ID }), z.object({ name: Name })]))
		.parse(await c.req.json());
	if (!(await c.env.DB.prepare("SELECT 1 FROM people WHERE id = ?").bind(id).first())) return c.json({ error: "not found" }, 404);
	const now = Date.now();
	let target: string;
	if ("personId" in body) {
		if (!(await c.env.DB.prepare("SELECT 1 FROM people WHERE id = ?").bind(body.personId).first())) return c.json({ error: "not found" }, 404);
		target = body.personId;
	} else {
		const existing = await c.env.DB.prepare("SELECT id FROM people WHERE name = ?").bind(body.name).first<{ id: string }>();
		target = existing?.id ?? ulid();
		if (!existing) {
			await c.env.DB.prepare("INSERT INTO people (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)").bind(target, body.name, now, now).run();
		}
	}
	if (target === id) return c.json({ personId: id, moved: 0 });
	let moved = 0;
	for (let i = 0; i < body.assetIds.length; i += CHUNK - 4) {
		const chunk = body.assetIds.slice(i, i + CHUNK - 4);
		const [, , res] = await c.env.DB.batch([
			c.env.DB.prepare(
				`INSERT OR IGNORE INTO face_rejects (face_id, person_id)
				 SELECT id, ? FROM faces WHERE person_id = ? AND asset_id IN (${marks(chunk.length)})`,
			).bind(id, id, ...chunk),
			c.env.DB.prepare(
				`DELETE FROM face_rejects WHERE person_id = ?
				 AND face_id IN (SELECT id FROM faces WHERE person_id = ? AND asset_id IN (${marks(chunk.length)}))`,
			).bind(target, id, ...chunk),
			c.env.DB.prepare(
				`UPDATE faces SET person_id = ?, assigned = ${ASSIGNED.manual}, state = ${FACE_STATE.done}
				 WHERE person_id = ? AND asset_id IN (${marks(chunk.length)}) RETURNING id`,
			).bind(target, id, ...chunk),
		]);
		moved += res?.results.length ?? 0;
	}
	await c.env.DB.prepare("UPDATE people SET updated_at = ? WHERE id = ?").bind(now, target).run();
	return c.json({ personId: target, moved });
});

/**
 * “确认更多照片”：还没有人物、像这个人的脸，按相似度从高到低，最多 FACE_REVIEW_MAX 张。
 * 用最有代表性的几张脸（手动确认的优先）分别查 Vectorize，取各自最高的相似度。
 */
people.get("/people/:id/review", async (c) => {
	const id = ID.parse(c.req.param("id"));
	const index = faceIndex(c.env);
	if (!index) return c.json({ items: [], unavailable: true });
	const { results: seeds } = await c.env.DB.prepare(
		`SELECT f.embedding FROM faces f JOIN assets a ON a.id = f.asset_id WHERE f.person_id = ? AND ${VISIBLE}
		 ORDER BY f.assigned = ${ASSIGNED.manual} DESC, f.px * f.score DESC LIMIT ?`,
	)
		.bind(id, FACE_REVIEW_SEEDS)
		.all<{ embedding: ArrayBuffer }>();
	const best = new Map<string, number>();
	for (const s of seeds) {
		for (const m of await similarFaces(index, asInt8(s.embedding), FACE_REVIEW_TOP_K, FACE_REVIEW_MIN)) {
			best.set(m.id, Math.max(best.get(m.id) ?? 0, m.score));
		}
	}
	const ids = [...best.keys()];
	const items: (FaceRef & { score: number })[] = [];
	for (let i = 0; i < ids.length; i += CHUNK - 1) {
		const chunk = ids.slice(i, i + CHUNK - 1);
		const { results } = await c.env.DB.prepare(
			`SELECT ${FACE_REF_COLUMNS} FROM faces f ${FACE_REF_JOIN}
			 WHERE f.id IN (${marks(chunk.length)}) AND f.person_id IS NULL AND f.state != ${FACE_STATE.ignored} AND ${VISIBLE}
			   AND NOT EXISTS (SELECT 1 FROM face_rejects r WHERE r.face_id = f.id AND r.person_id = ?)`,
		)
			.bind(...chunk, id)
			.all<FaceRefRow>();
		for (const r of results) {
			const ref = faceRef(r);
			if (ref) items.push({ ...ref, score: best.get(r.id)! });
		}
	}
	items.sort((a, b) => b.score - a.score);
	return c.json({ items: items.slice(0, FACE_REVIEW_MAX) });
});

/** 一张照片里的人脸（查看器信息面板），打码盖住的不列出。scanned 为 false 表示还没扫描过。 */
people.get("/assets/:id/faces", async (c) => {
	const id = ID.parse(c.req.param("id"));
	type Row = FaceRefRow & { x: number; y: number; w: number; h: number; state: number; person_id: string | null; name: string | null; hidden: number };
	const [scanRes, facesRes] = await c.env.DB.batch<Row | { one: number }>([
		c.env.DB.prepare("SELECT 1 AS one FROM face_scans WHERE asset_id = ?").bind(id),
		c.env.DB.prepare(
			`SELECT ${FACE_REF_COLUMNS}, f.x, f.y, f.w, f.h, f.state, p.id AS person_id, p.name, p.hidden
			 FROM faces f ${FACE_REF_JOIN} LEFT JOIN people p ON p.id = f.person_id
			 WHERE f.asset_id = ? AND f.masked = 0 ORDER BY f.x`,
		).bind(id),
	]);
	const scan = scanRes!.results.length > 0;
	const results = facesRes!.results as Row[];
	const items = results.flatMap((r) => {
		const ref = faceRef(r);
		if (!ref) return [];
		return [
			{
				...ref,
				box: { x: r.x, y: r.y, w: r.w, h: r.h },
				recognizable: r.state !== FACE_STATE.ignored,
				person: r.person_id ? { id: r.person_id, name: r.name, hidden: !!r.hidden } : null,
			},
		];
	});
	return c.json({ scanned: scan, items });
});

const AssignBody = z.union([z.object({ personId: ID }), z.object({ name: Name })]);

/** 指定这张脸是谁：已有的人物，或者一个名字（有同名的就用它，没有就新建）。 */
people.post("/faces/:id/assign", async (c) => {
	const faceId = ID.parse(c.req.param("id"));
	const body = AssignBody.parse(await c.req.json());
	// 打码盖住的脸不能归入人物
	if (!(await c.env.DB.prepare("SELECT 1 FROM faces WHERE id = ? AND masked = 0").bind(faceId).first())) return c.json({ error: "not found" }, 404);
	const now = Date.now();
	const stmts: D1PreparedStatement[] = [];
	let personId: string;
	if ("personId" in body) {
		if (!(await c.env.DB.prepare("SELECT 1 FROM people WHERE id = ?").bind(body.personId).first())) return c.json({ error: "not found" }, 404);
		personId = body.personId;
	} else {
		const existing = await c.env.DB.prepare("SELECT id FROM people WHERE name = ?").bind(body.name).first<{ id: string }>();
		personId = existing?.id ?? ulid();
		if (!existing) {
			stmts.push(c.env.DB.prepare("INSERT INTO people (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)").bind(personId, body.name, now, now));
		}
	}
	stmts.push(
		c.env.DB.prepare(
			`UPDATE faces SET person_id = ?, assigned = ${ASSIGNED.manual}, state = ${FACE_STATE.done} WHERE id = ?`,
		).bind(personId, faceId),
		c.env.DB.prepare("DELETE FROM face_rejects WHERE face_id = ? AND person_id = ?").bind(faceId, personId),
		c.env.DB.prepare("UPDATE people SET updated_at = ? WHERE id = ?").bind(now, personId),
	);
	await c.env.DB.batch(stmts);
	return c.json({ personId });
});

/** “这不是 X”：记下否认；脸当前属于 X 时移出来并重新识别（不会归回 X）。 */
people.post("/faces/:id/reject", async (c) => {
	const faceId = ID.parse(c.req.param("id"));
	const { personId } = z.object({ personId: ID }).parse(await c.req.json());
	const ok = await c.env.DB.prepare("SELECT (SELECT 1 FROM faces WHERE id = ?) AND (SELECT 1 FROM people WHERE id = ?) AS ok")
		.bind(faceId, personId)
		.first<{ ok: number | null }>();
	if (!ok?.ok) return c.json({ error: "not found" }, 404);
	const [, res] = await c.env.DB.batch([
		c.env.DB.prepare("INSERT OR IGNORE INTO face_rejects (face_id, person_id) VALUES (?, ?)").bind(faceId, personId),
		c.env.DB.prepare(`UPDATE faces SET ${UNASSIGN} WHERE id = ? AND person_id = ? RETURNING state`).bind(faceId, personId),
	]);
	if ((res?.results[0] as { state: number } | undefined)?.state === FACE_STATE.pending) await recognizeRejected(c.env, [faceId]);
	return c.json({ ok: true });
});

// ---------------------------------------------------------------- 识别进度

/** 还没有当前模型人脸扫描的照片（视频不认人脸）。 */
const MISSING_FACES = `FROM assets a LEFT JOIN face_scans s ON s.asset_id = a.id AND s.model = '${FACE_MODEL_VER}'
	WHERE ${VISIBLE} AND a.kind != 'video' AND s.asset_id IS NULL`;

people.get("/faces/status", async (c) => {
	const [total, missing, faces, pending, unindexed] = await c.env.DB.batch<{ n: number }>([
		c.env.DB.prepare(`SELECT COUNT(*) AS n FROM assets a WHERE ${VISIBLE} AND a.kind != 'video'`),
		c.env.DB.prepare(`SELECT COUNT(*) AS n ${MISSING_FACES}`),
		c.env.DB.prepare("SELECT COUNT(*) AS n FROM faces"),
		c.env.DB.prepare(`SELECT COUNT(*) AS n FROM faces WHERE state IN (${FACE_STATE.pending}, ${FACE_STATE.deferred})`),
		c.env.DB.prepare(`SELECT COUNT(*) AS n FROM faces WHERE indexed = 0 AND state != ${FACE_STATE.ignored}`),
	]);
	const n = (r: D1Result<{ n: number }> | undefined) => r?.results[0]?.n ?? 0;
	return c.json({
		total: n(total),
		missing: n(missing),
		faces: n(faces),
		pending: n(pending),
		unindexed: n(unindexed),
		indexAvailable: !!faceIndex(c.env),
	});
});
