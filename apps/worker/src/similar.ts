import { Hono } from "hono";
import { z } from "zod";
import {
	DUPLICATE_EMBED_MAX,
	DUPLICATE_IGNORE_MAX,
	DUPLICATE_MAX_HAMMING,
	DUPLICATE_MIN_COSINE,
	DUPLICATE_NEIGHBOR_MAX,
	DUPLICATE_SAME_CAPTURE_MS,
	DUPLICATE_SCAN_MAX,
	DUPLICATE_SCAN_PAGE,
	FP_DIMS,
	FP_MODEL_VER,
	SMART_SET_BACKGROUND,
	SMART_SET_CONFLICT,
	SMART_SET_CRON_BATCH,
	SMART_SET_CRON_QUIET_MS,
	SMART_SET_CV_FOLDS,
	SMART_SET_CV_MIN,
	SMART_SET_MAX,
	SMART_SET_MAX_EXAMPLES,
	SMART_SET_MAX_FOLDERS,
	SMART_SET_REFRESH_LOCK_MS,
	SMART_SET_SCAN_PAGE,
	SMART_SET_SENSITIVITY,
	SMART_SET_SUGGEST_FLOOR,
	SMART_SET_SUGGESTION_MAX,
	type SmartSetLevel,
	type SmartSetMetrics,
} from "@nana/shared";
import { NO_STORE } from "./dbcache";
import { guardStub } from "./guard";
import { TypeParam, andType, page, typeCondition } from "./library";
import type { Fingerprint } from "./processor";
import { type Classifier, decodeClassifier, encodeClassifier, score, trainClassifier } from "./smartset-model";
import { ITEM_COLUMNS, type ItemRow, toItem } from "./timeline";
import { ulid } from "./ulid";

/**
 * 相同照片、自定义主题。
 *
 * 指纹由容器在 derive 时算好（apps/processor/lib.mjs）：
 *  - phash：64 位感知哈希。汉明距离 ≤ DUPLICATE_MAX_HAMMING、拍摄时间对得上、CLIP 向量也几乎一样，才算同一张图
 *    （缩放、重新压缩、换格式、轻微裁剪）。用户可以把一组标记为“不是重复”（duplicate_ignores）。
 *    候选对（duplicate_pairs）在写指纹时增量算好，打开“整理重复”时只读候选对，不扫描全库。
 *  - embedding：CLIP 图像向量（512 个 int8）。复核重复照片；主题在它上面训练分类器（src/smartset-model.ts）。
 *
 * 都只存在 D1 的 asset_fp 里，不用 Vectorize。成本：查询只由用户操作触发；没有轮询，没有新的队列消息来源。
 */

type Bindings = { Bindings: Env };
export const similar = new Hono<Bindings>();

const ID = z.string().regex(/^[0-9A-Z]{26}$/);
const VISIBLE = "a.deleted_at IS NULL AND a.status = 'ready'";
const PAGE = 500;
/** D1 单条语句最多 100 个参数。 */
const CHUNK = 90;

// ---------------------------------------------------------------- 编码

const PHASH_RE = /^[0-9a-f]{16}$/;
/** 64 位拆成 5 段：13+13+13+13+12 位。距离 ≤ 4 的两个哈希至少有一段完全相同（鸽巢原理）。 */
const BANDS = [51, 38, 25, 12, 0] as const;
const BAND_BITS = [13, 13, 13, 13, 12] as const;

export function phashBands(phash: string): number[] {
	const v = BigInt(`0x${phash}`);
	return BANDS.map((shift, i) => Number((v >> BigInt(shift)) & ((1n << BigInt(BAND_BITS[i]!)) - 1n)));
}

/** 两个 16 位十六进制哈希的汉明距离。 */
export function hamming(a: string, b: string): number {
	let d = 0;
	for (let i = 0; i < 16; i += 8) d += popcount(parseInt(a.slice(i, i + 8), 16) ^ parseInt(b.slice(i, i + 8), 16));
	return d;
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

export function base64ToBytes(b64: string): Uint8Array {
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

/**
 * 绑定 BLOB 参数时一律传 ArrayBuffer。线上 D1 会把 Int8Array / Uint8Array 这类视图 String() 成 "-3,5,1,…" 的文本
 * 存进去（本地模拟器不会，所以测试发现不了），读出来就解不成向量。
 */
export function blobOf(v: ArrayBufferView): ArrayBuffer {
	return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer;
}

/**
 * D1 返回的 BLOB 是 ArrayBuffer 或数组，统一成 Int8Array。
 * 也接受修复之前线上写进去的逗号分隔文本（每个数是一个 int8），老数据不用重算。
 */
export function asInt8(blob: ArrayBuffer | number[] | Uint8Array | string): Int8Array {
	if (typeof blob === "string") return Int8Array.from(blob.split(","), Number);
	if (Array.isArray(blob)) return Int8Array.from(blob, (x) => (x > 127 ? x - 256 : x));
	return new Int8Array(blob instanceof Uint8Array ? blob.slice().buffer : blob);
}
function asFloat32(blob: ArrayBuffer | number[] | Uint8Array): Float32Array {
	const bytes = Array.isArray(blob) ? Uint8Array.from(blob) : blob instanceof Uint8Array ? blob.slice() : new Uint8Array(blob);
	return new Float32Array(bytes.buffer, 0, bytes.byteLength / 4);
}

/** 归一化成单位向量（余弦相似度 = 点积）。全零向量返回 null。 */
export function normalize(v: ArrayLike<number>): Float32Array | null {
	let sum = 0;
	for (let i = 0; i < v.length; i++) sum += v[i]! * v[i]!;
	if (!(sum > 0)) return null;
	const n = Math.sqrt(sum);
	return Float32Array.from(v as ArrayLike<number>, (x) => x / n);
}

export function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
	let s = 0;
	for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
	return s;
}

/** 校验容器返回的指纹。格式不对就当作没有（不让任务失败）。 */
export function parseFingerprint(fp: Fingerprint | null | undefined): { phash: string; embedding: Int8Array } | null {
	if (!fp || fp.model !== FP_MODEL_VER || !PHASH_RE.test(fp.phash) || typeof fp.embedding !== "string") return null;
	let bytes: Uint8Array;
	try {
		bytes = base64ToBytes(fp.embedding);
	} catch {
		return null;
	}
	if (bytes.length !== FP_DIMS) return null;
	const embedding = new Int8Array(bytes.buffer, bytes.byteOffset, bytes.length);
	if (!embedding.some((x) => x !== 0)) return null;
	return { phash: fp.phash, embedding };
}

// ---------------------------------------------------------------- 写入

/**
 * process / fingerprint 任务调用：写 D1，更新重复照片的候选对，再给已有的主题打分。
 * 只有 D1 写入失败会抛错。
 */
export async function saveFingerprint(env: Env, assetId: string, fp: Fingerprint | null): Promise<boolean> {
	const parsed = parseFingerprint(fp);
	if (!parsed) {
		if (fp) console.warn(JSON.stringify({ event: "fingerprint_invalid", assetId }));
		return false;
	}
	const now = Date.now();
	const bands = phashBands(parsed.phash);
	await env.DB.prepare(
		`INSERT OR REPLACE INTO asset_fp (asset_id, model, phash, b0, b1, b2, b3, b4, embedding, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(assetId, FP_MODEL_VER, parsed.phash, ...bands, blobOf(parsed.embedding), now)
		.run();
	await updateDuplicatePairs(env, [{ id: assetId, phash: parsed.phash, embedding: parsed.embedding }]);
	await scoreForSmartSets(env, assetId, parsed.embedding);
	return true;
}

/**
 * 更新这些照片的候选重复对：按 5 段哈希查可能的近邻（每段都有索引，每张最多 DUPLICATE_NEIGHBOR_MAX 个），
 * 留下汉明距离以内、照片 / 视频一致、向量也几乎一样的，和删掉旧的候选对一起写入。
 * 只存不会变的条件；连拍、拍摄时间、回收站、“不是重复”在读取时过滤。
 * 写指纹时调用；D1 按批读写（每次 batch 最多 50 条语句），不是每张几次请求。
 * 失败不影响任务：删掉 duplicate_pairs_state，下次打开“整理重复”时全量补上。
 */
export async function updateDuplicatePairs(env: Env, rows: { id: string; phash: string; embedding: Int8Array }[]) {
	if (!rows.length) return;
	try {
		const reads = rows.flatMap((r) => [
			env.DB.prepare("SELECT id, kind FROM assets WHERE id = ?").bind(r.id),
			env.DB.prepare(
				`SELECT f.asset_id AS id, f.phash, a.kind FROM asset_fp f JOIN assets a ON a.id = f.asset_id
				 WHERE (f.b0 = ? OR f.b1 = ? OR f.b2 = ? OR f.b3 = ? OR f.b4 = ?) AND f.asset_id != ? LIMIT ?`,
			).bind(...phashBands(r.phash), r.id, DUPLICATE_NEIGHBOR_MAX),
		]);
		// 只读，各批一起发；下面的写入有先后（先删这张的旧照片对再插），仍按顺序一批一批写
		const chunks: Promise<D1Result<{ id: string; phash: string; kind: string }>[]>[] = [];
		for (let i = 0; i < reads.length; i += 50) chunks.push(env.DB.batch<{ id: string; phash: string; kind: string }>(reads.slice(i, i + 50)));
		const results = (await Promise.all(chunks)).flat();
		const close = rows.map((r, k) => {
			const isVideo = results[2 * k]!.results[0]?.kind === "video";
			return results[2 * k + 1]!.results.filter((n) => (n.kind === "video") === isVideo && hamming(n.phash, r.phash) <= DUPLICATE_MAX_HAMMING);
		});
		const vectors = await loadVectors(env, [...new Set(close.flat().map((n) => n.id))]);
		const writes = rows.flatMap((r, k) => {
			const own = normalize(r.embedding);
			const keep = close[k]!.filter((n) => {
				const v = vectors.get(n.id);
				return !own || !v || dot(own, v) >= DUPLICATE_MIN_COSINE;
			});
			return [
				env.DB.prepare("DELETE FROM duplicate_pairs WHERE a = ?1 OR b = ?1").bind(r.id),
				...insertPairs(env, keep.map((n) => [r.id, n.id])),
			];
		});
		for (let i = 0; i < writes.length; i += 50) await env.DB.batch(writes.slice(i, i + 50));
	} catch (e) {
		console.warn(JSON.stringify({ event: "duplicate_pairs_failed", count: rows.length, error: String(e).slice(0, 300) }));
		await env.DB.prepare("DELETE FROM duplicate_pairs_state").run().catch(() => {});
	}
}

/** 每条语句 45 对（D1 单条语句最多 100 个参数）。 */
function insertPairs(env: Env, pairs: [string, string][]): D1PreparedStatement[] {
	const stmts: D1PreparedStatement[] = [];
	for (let i = 0; i < pairs.length; i += 45) {
		const chunk = pairs.slice(i, i + 45).map(([a, b]) => (a < b ? [a, b] : [b, a]));
		stmts.push(
			env.DB.prepare(`INSERT OR IGNORE INTO duplicate_pairs (a, b) VALUES ${chunk.map(() => "(?, ?)").join(",")}`).bind(...chunk.flat()),
		);
	}
	return stmts;
}

/**
 * 新照片处理完：用每个训练过的主题（最多 SMART_SET_MAX 个）打一次分，够像的进“建议”。不读全库。
 * 指定了范围的主题只在照片位于范围里（某个范围文件夹是它的文件夹或上级）时打分。
 */
async function scoreForSmartSets(env: Env, assetId: string, embedding: Int8Array) {
	const { results } = await env.DB.prepare("SELECT id, weights, folders FROM smart_sets WHERE weights IS NOT NULL LIMIT ?")
		.bind(SMART_SET_MAX)
		.all<{ id: string; weights: ArrayBuffer; folders: string | null }>();
	let ancestors: Set<string> | null = null;
	if (results.some((s) => s.folders !== null)) {
		const { results: up } = await env.DB.prepare(
			`WITH RECURSIVE up(id) AS (
			   SELECT folder_id FROM assets WHERE id = ? AND folder_id IS NOT NULL
			   UNION SELECT f.parent_id FROM folders f JOIN up ON f.id = up.id WHERE f.parent_id IS NOT NULL)
			 SELECT id FROM up`,
		)
			.bind(assetId)
			.all<{ id: string }>();
		ancestors = new Set(up.map((r) => r.id));
	}
	const hits: { id: string; score: number }[] = [];
	for (const s of results) {
		if (s.folders !== null && !parseFolders(s.folders).some((f) => ancestors?.has(f))) continue;
		const c = decodeClassifier(s.weights);
		const p = c ? score(c, embedding) : 0;
		if (p >= SMART_SET_SUGGEST_FLOOR) hits.push({ id: s.id, score: p });
	}
	if (!hits.length) return;
	await env.DB.batch(
		hits.map((h) =>
			env.DB.prepare(
				`INSERT OR REPLACE INTO smart_set_suggestions (set_id, asset_id, score)
				 SELECT ?1, ?2, ?3 WHERE NOT EXISTS (SELECT 1 FROM smart_set_examples WHERE set_id = ?1 AND asset_id = ?2)`,
			).bind(h.id, assetId, h.score),
		),
	);
}

// ---------------------------------------------------------------- 查询

/** 按 id 分块查可见条目，所有分块一起发（每次 batch 最多 50 条语句），不一条等一条。 */
export async function selectByIds<T extends { id: string }>(env: Env, columns: string, ids: string[]): Promise<Map<string, T>> {
	const rows = new Map<string, T>();
	const stmts: D1PreparedStatement[] = [];
	for (let i = 0; i < ids.length; i += CHUNK) {
		const chunk = ids.slice(i, i + CHUNK);
		stmts.push(env.DB.prepare(`SELECT ${columns} FROM assets a WHERE a.id IN (${chunk.map(() => "?").join(",")}) AND ${VISIBLE}`).bind(...chunk));
	}
	for (let i = 0; i < stmts.length; i += 50) {
		for (const res of await env.DB.batch<T>(stmts.slice(i, i + 50))) for (const r of res.results) rows.set(r.id, r);
	}
	return rows;
}

// ---------------------------------------------------------------- 重复照片

interface DupRow {
	id: string;
	phash: string;
	kind: string;
	burst_id: string | null;
	width: number | null;
	height: number | null;
	favorite: number;
	traits: number;
	taken_at: number | null;
	camera: string | null;
	meta_locked: number;
	created_at: number;
	size: number | null;
}
type PairRow = Pick<DupRow, "id" | "phash" | "kind" | "burst_id"> & Partial<Pick<DupRow, "taken_at" | "camera" | "meta_locked">>;
/** 分组要用的列（从候选对里读出来）。 */
type ScanRow = Pick<DupRow, "id" | "phash" | "kind" | "burst_id" | "taken_at" | "camera" | "meta_locked">;
/** 推荐保留哪一张要用的列：只给当前页里的照片查，不在全库扫描里读。 */
export type KeeperRow = ItemRow & Pick<DupRow, "traits" | "created_at" | "size">;
export const KEEPER_COLUMNS = `${ITEM_COLUMNS}, a.traits, a.created_at,
	(SELECT size FROM asset_files WHERE asset_id = a.id AND role IN ('original', 'raw') ORDER BY role = 'original' DESC LIMIT 1) AS size`;

/** 候选对的上限：全黑、全白这类哈希相同的照片很多时，避免两两组合撑爆内存。 */
const DUPLICATE_PAIR_MAX = 200_000;
const QUARTER_HOUR = 15 * 60_000;

/**
 * 两张都有相机 EXIF 时，拍摄时间是否可能是同一次拍摄：相差不超过 DUPLICATE_SAME_CAPTURE_MS，
 * 或者差的是整刻钟（副本丢了时区，被当成别的时区解析）。缺少信息、或者用户改过时间的，不用时间判断。
 */
export function sameCapture(a: Omit<PairRow, "id" | "phash" | "kind" | "burst_id">, b: Omit<PairRow, "id" | "phash" | "kind" | "burst_id">): boolean {
	if (!a.camera || !b.camera || a.taken_at == null || b.taken_at == null) return true;
	if (((a.meta_locked ?? 0) | (b.meta_locked ?? 0)) & 1) return true;
	const d = Math.abs(a.taken_at - b.taken_at);
	const r = d % QUARTER_HOUR;
	return d <= 26 * 3600_000 && Math.min(r, QUARTER_HOUR - r) <= DUPLICATE_SAME_CAPTURE_MS;
}

export const pairKey = (a: string, b: string) => (a < b ? `${a}:${b}` : `${b}:${a}`);

/** 会变的条件（存进 duplicate_pairs 之后读取时再判断）：同一组连拍、拍摄时间对不上的不算。 */
function samePicture(a: PairRow, b: PairRow): boolean {
	if (a.burst_id && a.burst_id === b.burst_id) return false;
	return sameCapture(a, b);
}

/**
 * 找出哈希距离以内的照片对：每一段相同的放进同一个桶，只在桶里两两比较（同一对只在第一个相同的段里算一次）。
 * 视频和照片不互相比较；同一组连拍、拍摄时间对不上、被标记为“不是重复”的不算（stableOnly 时只看哈希和照片 / 视频）。
 */
export function duplicatePairs(
	rows: PairRow[],
	{ maxDistance = DUPLICATE_MAX_HAMMING, ignored, stableOnly = false }: { maxDistance?: number; ignored?: Set<string>; stableOnly?: boolean } = {},
): { pairs: [number, number][]; truncated: boolean } {
	const isVideo = (r: PairRow) => r.kind === "video";
	// 分段和哈希的高低 32 位都先算好，配对循环里不再解析字符串、不分配内存
	const nb = BANDS.length;
	const bands = new Int32Array(rows.length * nb);
	const hi = new Uint32Array(rows.length);
	const lo = new Uint32Array(rows.length);
	rows.forEach((r, i) => {
		bands.set(phashBands(r.phash), i * nb);
		hi[i] = parseInt(r.phash.slice(0, 8), 16);
		lo[i] = parseInt(r.phash.slice(8, 16), 16);
	});
	const pairs: [number, number][] = [];
	for (let b = 0; b < nb; b++) {
		const buckets = new Map<number, number[]>();
		for (let i = 0; i < rows.length; i++) {
			const key = bands[i * nb + b]!;
			const list = buckets.get(key);
			if (list) list.push(i);
			else buckets.set(key, [i]);
		}
		for (const list of buckets.values()) {
			for (let x = 0; x < list.length; x++) {
				for (let y = x + 1; y < list.length; y++) {
					const i = list[x]!;
					const j = list[y]!;
					let seen = false; // 前面的段已经比过
					for (let k = 0; k < b && !seen; k++) seen = bands[i * nb + k] === bands[j * nb + k];
					if (seen) continue;
					const ri = rows[i]!;
					const rj = rows[j]!;
					if (isVideo(ri) !== isVideo(rj)) continue;
					if (popcount(hi[i]! ^ hi[j]!) + popcount(lo[i]! ^ lo[j]!) > maxDistance) continue;
					if (!stableOnly && !samePicture(ri, rj)) continue;
					if (ignored?.has(pairKey(ri.id, rj.id))) continue;
					if (pairs.length >= DUPLICATE_PAIR_MAX) return { pairs, truncated: true };
					pairs.push([i, j]);
				}
			}
		}
	}
	return { pairs, truncated: false };
}

/** 并查集把照片对连成组（每组至少 2 张）。 */
export function groupPairs<T>(rows: T[], pairs: [number, number][]): T[][] {
	const parent = rows.map((_, i) => i);
	const find = (i: number): number => {
		while (parent[i] !== i) {
			parent[i] = parent[parent[i]!]!;
			i = parent[i]!;
		}
		return i;
	};
	for (const [i, j] of pairs) {
		const pi = find(i);
		const pj = find(j);
		if (pi !== pj) parent[pi] = pj;
	}
	const groups = new Map<number, T[]>();
	rows.forEach((r, i) => {
		const root = find(i);
		const g = groups.get(root);
		if (g) g.push(r);
		else groups.set(root, [r]);
	});
	return [...groups.values()].filter((g) => g.length > 1);
}

/**
 * 分组。vectors（id → 单位向量）里两张都有的，余弦相似度还要至少 DUPLICATE_MIN_COSINE。
 */
export function groupDuplicates<T extends PairRow>(
	rows: T[],
	opts: { maxDistance?: number; ignored?: Set<string>; vectors?: Map<string, Float32Array> } = {},
): T[][] {
	const { pairs } = duplicatePairs(rows, opts);
	return groupPairs(rows, filterByVectors(rows, pairs, opts.vectors));
}

function filterByVectors(rows: PairRow[], pairs: [number, number][], vectors: Map<string, Float32Array> | undefined) {
	if (!vectors?.size) return pairs;
	return pairs.filter(([i, j]) => {
		const a = vectors.get(rows[i]!.id);
		const b = vectors.get(rows[j]!.id);
		return !a || !b || dot(a, b) >= DUPLICATE_MIN_COSINE;
	});
}

/** 读出这些照片的 CLIP 向量（归一化），最多 DUPLICATE_EMBED_MAX 张。 */
async function loadVectors(env: Env, ids: string[]): Promise<Map<string, Float32Array>> {
	const out = new Map<string, Float32Array>();
	const stmts: D1PreparedStatement[] = [];
	for (let i = 0; i < Math.min(ids.length, DUPLICATE_EMBED_MAX); i += CHUNK) {
		const chunk = ids.slice(i, Math.min(i + CHUNK, DUPLICATE_EMBED_MAX));
		stmts.push(
			env.DB.prepare(`SELECT asset_id, embedding FROM asset_fp WHERE model = ? AND asset_id IN (${chunk.map(() => "?").join(",")})`).bind(
				FP_MODEL_VER,
				...chunk,
			),
		);
	}
	for (let i = 0; i < stmts.length; i += 50) {
		for (const res of await env.DB.batch<{ asset_id: string; embedding: ArrayBuffer }>(stmts.slice(i, i + 50))) {
			for (const r of res.results) {
				const v = normalize(asInt8(r.embedding));
				if (v) out.set(r.asset_id, v);
			}
		}
	}
	return out;
}

/** 推荐保留的一张：收藏的 > Live Photo（动态部分删了找不回来）> 有 RAW 的 > 像素最多的 > 文件最大的 > 最早导入的。 */
export function pickKeeper<T extends Pick<DupRow, "id" | "kind" | "favorite" | "traits" | "width" | "height" | "size" | "created_at">>(group: T[]): T {
	const rank = (r: T) => [r.favorite ? 1 : 0, r.kind === "live" ? 1 : 0, r.traits & 8 ? 1 : 0, (r.width ?? 0) * (r.height ?? 0), r.size ?? 0, -r.created_at];
	return group.reduce((best, r) => {
		const a = rank(r);
		const b = rank(best);
		for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! > b[i]! ? r : best;
		return best;
	});
}

/**
 * 全量补建候选对：按 ID 分页读全部指纹（包括回收站里的，恢复后也要能找到），每页 DUPLICATE_SCAN_PAGE 行，
 * 最多 DUPLICATE_SCAN_MAX 行，在内存里分桶配对，再读候选照片的向量复核（最多 DUPLICATE_EMBED_MAX 张）。
 * 只追加（INSERT OR IGNORE），不清空：同时写指纹的任务自己会写它的候选对。只在 duplicate_pairs_state 没有那一行时运行。
 */
export async function rebuildDuplicatePairs(env: Env): Promise<{ truncated: boolean }> {
	const rows: PairRow[] = [];
	let after = "";
	let truncated = false;
	for (;;) {
		const { results } = await env.DB.prepare(
			`SELECT f.asset_id AS id, f.phash, a.kind, NULL AS burst_id FROM asset_fp f JOIN assets a ON a.id = f.asset_id
			 WHERE f.asset_id > ? ORDER BY f.asset_id LIMIT ?`,
		)
			.bind(after, DUPLICATE_SCAN_PAGE)
			.all<PairRow>();
		rows.push(...results);
		if (results.length < DUPLICATE_SCAN_PAGE) break;
		if (rows.length >= DUPLICATE_SCAN_MAX) {
			truncated = true;
			break;
		}
		after = results[results.length - 1]!.id;
	}
	const found = duplicatePairs(rows, { stableOnly: true });
	const candidates = [...new Set(found.pairs.flat())].map((i) => rows[i]!.id);
	const vectors = await loadVectors(env, candidates);
	const pairs = filterByVectors(rows, found.pairs, vectors).map(([i, j]): [string, string] => [rows[i]!.id, rows[j]!.id]);
	truncated ||= found.truncated || candidates.length > DUPLICATE_EMBED_MAX;
	const stmts = insertPairs(env, pairs);
	for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
	await env.DB.prepare("INSERT OR REPLACE INTO duplicate_pairs_state (id, built_at, truncated) VALUES (1, ?, ?)")
		.bind(Date.now(), truncated ? 1 : 0)
		.run();
	return { truncated };
}

/**
 * GET /api/duplicates：所有重复组（每组至少 2 张），按组里最新的拍摄时间倒序，每页 200 组。
 * 只读候选对（duplicate_pairs，两张都可见、没被标记为“不是重复”的），再按连拍和拍摄时间过滤、并查集分组，
 * 读取量和候选对的数量成正比，和照片总数无关（CROSS JOIN 固定从候选对出发，否则规划器会扫完整个资料库；检查了多少张读 storage_totals）。
 * 部署前的指纹还没有候选对时，先全量补建一次（rebuildDuplicatePairs）。只由用户打开“整理重复”页面触发。
 * 推荐保留哪一张要用的列（尺寸、文件大小 …）只给当前页的照片查。
 */
similar.get("/duplicates", async (c) => {
	const offset = Math.max(0, Math.floor(Number(c.req.query("offset") ?? 0)) || 0);
	const state = await c.env.DB.prepare("SELECT truncated FROM duplicate_pairs_state WHERE id = 1").first<{ truncated: number }>();
	const truncated = state ? !!state.truncated : (await rebuildDuplicatePairs(c.env)).truncated;
	const side = (t: string) => `${t}.kind AS ${t}_kind, ${t}.burst_id AS ${t}_burst, ${t}.taken_at AS ${t}_taken, ${t}.camera AS ${t}_camera, ${t}.meta_locked AS ${t}_locked`;
	type Side = "x" | "y";
	type PairResult = { a: string; b: string } & Record<`${Side}_${"kind" | "burst" | "camera"}`, string | null> &
		Record<`${Side}_${"taken" | "locked"}`, number | null>;
	const [pairRes, countRes] = await c.env.DB.batch<unknown>([
		c.env.DB.prepare(
			`SELECT p.a, p.b, ${side("x")}, ${side("y")}
			 FROM duplicate_pairs p CROSS JOIN assets x ON x.id = p.a CROSS JOIN assets y ON y.id = p.b
			 WHERE x.deleted_at IS NULL AND x.status = 'ready' AND y.deleted_at IS NULL AND y.status = 'ready'
			   AND NOT EXISTS (SELECT 1 FROM duplicate_ignores i WHERE i.a = p.a AND i.b = p.b)
			 LIMIT ?`,
		).bind(DUPLICATE_PAIR_MAX),
		// 检查了多少张：读 storage_totals 那一行（触发器维护的可见照片 + 视频数），不数 asset_fp（每次打开都要读全库）
		c.env.DB.prepare("SELECT photos + videos AS n FROM storage_totals WHERE id = 1"),
	]);
	const pairRows = pairRes!.results as PairResult[];
	const rows: ScanRow[] = [];
	const index = new Map<string, number>();
	const rowOf = (r: PairResult, s: Side, id: string) => {
		let i = index.get(id);
		if (i === undefined) {
			i = rows.push({ id, phash: "", kind: r[`${s}_kind`]!, burst_id: r[`${s}_burst`], taken_at: r[`${s}_taken`], camera: r[`${s}_camera`], meta_locked: r[`${s}_locked`] ?? 0 }) - 1;
			index.set(id, i);
		}
		return i;
	};
	const pairs: [number, number][] = [];
	for (const r of pairRows) {
		const i = rowOf(r, "x", r.a);
		const j = rowOf(r, "y", r.b);
		if ((rows[i]!.kind === "video") === (rows[j]!.kind === "video") && samePicture(rows[i]!, rows[j]!)) pairs.push([i, j]);
	}
	const groups = groupPairs(rows, pairs)
		.map((g) => g.sort((a, b) => (a.taken_at ?? 0) - (b.taken_at ?? 0) || a.id.localeCompare(b.id)))
		.sort((a, b) => Math.max(...b.map((r) => r.taken_at ?? 0)) - Math.max(...a.map((r) => r.taken_at ?? 0)));
	const GROUP_PAGE = 200;
	const pageGroups = groups.slice(offset, offset + GROUP_PAGE);
	const items = await selectByIds<KeeperRow>(c.env, KEEPER_COLUMNS, pageGroups.flat().map((r) => r.id));
	return c.json({
		groups: pageGroups.map((g) => {
			const present = g.map((r) => items.get(r.id)).filter((r): r is KeeperRow => !!r);
			return { keep: present.length ? pickKeeper(present).id : g[0]!.id, items: present.map(toItem) };
		}),
		total: groups.length,
		next: offset + GROUP_PAGE < groups.length ? offset + GROUP_PAGE : null,
		scanned: (countRes!.results[0] as { n: number } | undefined)?.n ?? 0,
		truncated: truncated || pairRows.length >= DUPLICATE_PAIR_MAX,
	});
});

/**
 * 标记为“不是重复”：ids 两两之间各记一条；给了 pivot 时只记 pivot 和其他每一张（“这张和它们不一样”）。
 * POST /duplicates/ignore 记录，POST /duplicates/unignore 撤销。
 */
const IgnoreBody = z
	.object({ ids: z.array(ID).min(2).max(DUPLICATE_IGNORE_MAX), pivot: ID.optional() })
	.refine((b) => !b.pivot || b.ids.includes(b.pivot), "pivot must be one of ids");

export function ignorePairs(ids: string[], pivot?: string): [string, string][] {
	const uniq = [...new Set(ids)];
	const out: [string, string][] = [];
	for (let i = 0; i < uniq.length; i++)
		for (let j = i + 1; j < uniq.length; j++) {
			const [a, b] = [uniq[i]!, uniq[j]!];
			if (pivot && a !== pivot && b !== pivot) continue;
			out.push(a < b ? [a, b] : [b, a]);
		}
	return out;
}

similar.post("/duplicates/ignore", async (c) => {
	const body = IgnoreBody.parse(await c.req.json());
	const { results } = await c.env.DB.prepare(`SELECT id FROM assets WHERE id IN (${body.ids.map(() => "?").join(",")})`)
		.bind(...body.ids)
		.all<{ id: string }>();
	const exists = new Set(results.map((r) => r.id));
	const pairs = ignorePairs(body.ids.filter((id) => exists.has(id)), body.pivot);
	const now = Date.now();
	const ROWS = 33; // 每行 3 个参数
	const stmts: D1PreparedStatement[] = [];
	for (let i = 0; i < pairs.length; i += ROWS) {
		const chunk = pairs.slice(i, i + ROWS);
		stmts.push(
			c.env.DB.prepare(`INSERT OR IGNORE INTO duplicate_ignores (a, b, created_at) VALUES ${chunk.map(() => "(?, ?, ?)").join(",")}`).bind(
				...chunk.flatMap(([a, b]) => [a, b, now]),
			),
		);
	}
	if (stmts.length) await c.env.DB.batch(stmts);
	return c.json({ pairs: pairs.length });
});

similar.post("/duplicates/unignore", async (c) => {
	const body = IgnoreBody.parse(await c.req.json());
	const pairs = ignorePairs(body.ids, body.pivot);
	const ROWS = 45; // 每行 2 个参数
	const stmts: D1PreparedStatement[] = [];
	for (let i = 0; i < pairs.length; i += ROWS) {
		const chunk = pairs.slice(i, i + ROWS);
		stmts.push(
			c.env.DB.prepare(`DELETE FROM duplicate_ignores WHERE (a, b) IN (VALUES ${chunk.map(() => "(?, ?)").join(",")})`).bind(...chunk.flat()),
		);
	}
	if (stmts.length) await c.env.DB.batch(stmts);
	return c.json({ pairs: pairs.length });
});

// ---------------------------------------------------------------- 指纹进度

/** 还没有当前模型指纹的可见条目。 */
const MISSING_FP = `FROM assets a LEFT JOIN asset_fp f ON f.asset_id = a.id AND f.model = '${FP_MODEL_VER}'
	WHERE ${VISIBLE} AND f.asset_id IS NULL`;

similar.get("/fingerprints/status", async (c) => {
	const [total, missing] = await c.env.DB.batch<{ n: number }>([
		c.env.DB.prepare(`SELECT COUNT(*) AS n FROM assets a WHERE ${VISIBLE}`),
		c.env.DB.prepare(`SELECT COUNT(*) AS n ${MISSING_FP}`),
	]);
	return c.json({
		total: total?.results[0]?.n ?? 0,
		missing: missing?.results[0]?.n ?? 0,
	});
});

// ---------------------------------------------------------------- 自定义主题

/**
 * 主题 = 用户标的样本（正例 / 反例）+ 一个分类器（src/smartset-model.ts）。分类器只负责建议，
 * 照片放进哪个相册由用户在“结果”里手动挑，所以样本保持小规模（最多 SMART_SET_MAX_EXAMPLES）。
 *  - 标记样本只写 D1（POST /examples），不重新训练；界面提示“更新”，用户点了就训练并扫描全库（POST /refresh），
 *    否则由每小时的 Cron 自动更新（refreshStaleSmartSets，标记停止变化 SMART_SET_CRON_QUIET_MS 之后）。
 *  - 扫描直接读 D1 的 asset_fp（不用 Vectorize），所以没有前 100 个的限制；建议最多保留 SMART_SET_SUGGESTION_MAX 条。
 *  - 结果（GET /assets）= 正例 + 分数达到灵敏度的建议，按拍摄时间倒序，可以排除已经在某个相册里的。
 *  - 质量：正例、反例都够多时训练顺带做交叉验证（smart_sets.metrics），每张样本记下没见过它的模型给的分数（score），
 *    标签和分数矛盾的（SMART_SET_CONFLICT）在界面上标出来；标记时正好在建议里的照片记下当时的分数（review_score），
 *    用来算每档灵敏度的实测准确率。
 */

const IDS = z.array(ID).min(1).max(SMART_SET_MAX_EXAMPLES);
const Name = z.string().trim().min(1).max(100);
/** 一条语句写多少行：整批作为一个 JSON 文本参数传进去，用 json_each 展开（D1 单条语句最多 100 个参数）。 */
const JSON_ROWS = 2000;
/** 背景分成几段连续的行去取：同一段往往是同一次上传的照片，分段让样本更分散。 */
const BACKGROUND_RUNS = 10;
const LEVELS = Object.keys(SMART_SET_SENSITIVITY) as SmartSetLevel[];
/** 标签和分类器矛盾的样本（e 是 smart_set_examples）。 */
const CONFLICT = `((e.label = 1 AND e.score < ${SMART_SET_CONFLICT.positiveBelow}) OR (e.label = -1 AND e.score >= ${SMART_SET_CONFLICT.negativeFrom}))`;
const isConflict = (label: number, p: number | undefined) =>
	p !== undefined && (label > 0 ? p < SMART_SET_CONFLICT.positiveBelow : p >= SMART_SET_CONFLICT.negativeFrom);

async function setExists(env: Env, id: string) {
	return !!(await env.DB.prepare("SELECT 1 AS x FROM smart_sets WHERE id = ?").bind(id).first());
}

async function classifierOf(env: Env, setId: string): Promise<Classifier | null> {
	const row = await env.DB.prepare("SELECT weights FROM smart_sets WHERE id = ?").bind(setId).first<{ weights: ArrayBuffer | null }>();
	return row?.weights ? decodeClassifier(row.weights) : null;
}

/** smart_sets.folders 的 JSON 文本 → 范围的根文件夹 id。 */
function parseFolders(json: string): string[] {
	try {
		const v: unknown = JSON.parse(json);
		return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
	} catch {
		return [];
	}
}

/**
 * 主题的范围展开成整棵子树的文件夹 id（JSON 文本，交给 json_each）；null 表示整个资料库。
 * 范围在每次读取时展开，所以之后新建的子文件夹、移进来的文件夹都算在内；删掉的文件夹自然不在了。
 * 文件夹表很小（几百到几千行），递归 CTE 不和条目相关，只跑一次。
 */
const scopeStmt = (env: Env, folders: string) =>
	env.DB.prepare(
		`WITH RECURSIVE t(id) AS (
		   SELECT id FROM folders WHERE id IN (SELECT value FROM json_each(?))
		   UNION SELECT f.id FROM folders f JOIN t ON f.parent_id = t.id)
		 SELECT id FROM t`,
	).bind(folders);
const scopeJson = (rows: { id: string }[]) => JSON.stringify(rows.map((r) => r.id));

async function scopeOf(env: Env, folders: string | null): Promise<string | null> {
	if (folders === null) return null;
	return scopeJson((await scopeStmt(env, folders).all<{ id: string }>()).results);
}

async function scopeOfSet(env: Env, setId: string): Promise<string | null> {
	const row = await env.DB.prepare("SELECT folders FROM smart_sets WHERE id = ?").bind(setId).first<{ folders: string | null }>();
	return scopeOf(env, row?.folders ?? null);
}

/** 范围条件：参数是 scopeOf() 的结果，为 null 时不加条件。 */
const IN_SCOPE = (param: string) => ` AND a.folder_id IN (SELECT value FROM json_each(${param}))`;

/** 背景样本：随机的几段 rowid（每段 SMART_SET_BACKGROUND / BACKGROUND_RUNS 行），只读这么多行，不扫描全表。 */
async function backgroundSample(env: Env, exclude: Set<string>): Promise<Float32Array[]> {
	const max = await env.DB.prepare("SELECT MAX(rowid) AS m FROM asset_fp").first<{ m: number | null }>();
	if (!max?.m) return [];
	const per = Math.ceil(SMART_SET_BACKGROUND / BACKGROUND_RUNS);
	const stmts = Array.from({ length: BACKGROUND_RUNS }, () =>
		env.DB.prepare(
			// CROSS JOIN 固定从 asset_fp 的 rowid 出发：规划器自己选时会顺着 assets_timeline 读完整个资料库再排序（每段 50 多万行）
			`SELECT f.asset_id, f.embedding FROM asset_fp f CROSS JOIN assets a ON a.id = f.asset_id
			 WHERE f.rowid >= ? AND f.model = ? AND ${VISIBLE} ORDER BY f.rowid LIMIT ?`,
		).bind(Math.floor(Math.random() * max.m!), FP_MODEL_VER, per),
	);
	const seen = new Set<string>();
	const out: Float32Array[] = [];
	for (const r of await env.DB.batch<{ asset_id: string; embedding: ArrayBuffer }>(stmts))
		for (const row of r.results) {
			if (seen.has(row.asset_id) || exclude.has(row.asset_id)) continue;
			seen.add(row.asset_id);
			const v = normalize(asInt8(row.embedding));
			if (v) out.push(v);
		}
	return out;
}

/**
 * 交叉验证：正例、反例各自按顺序轮流分成 SMART_SET_CV_FOLDS 份，每次留出一份，用其余的（加上全部背景）训练、给留出的打分。
 * 返回每张样本“没见过它的模型”给的分数，顺序和输入一致。正例或反例少于 SMART_SET_CV_MIN 张时返回 null。
 */
export function crossValidate(pos: Float32Array[], neg: Float32Array[], background: Float32Array[]): { pos: number[]; neg: number[] } | null {
	if (pos.length < SMART_SET_CV_MIN || neg.length < SMART_SET_CV_MIN) return null;
	const out = { pos: new Array<number>(pos.length).fill(0), neg: new Array<number>(neg.length).fill(0) };
	for (let k = 0; k < SMART_SET_CV_FOLDS; k++) {
		const train = (_: unknown, i: number) => i % SMART_SET_CV_FOLDS !== k;
		const model = trainClassifier(pos.filter(train), neg.filter(train), background);
		if (!model) continue;
		for (let i = k; i < pos.length; i += SMART_SET_CV_FOLDS) out.pos[i] = score(model, pos[i]!);
		for (let i = k; i < neg.length; i += SMART_SET_CV_FOLDS) out.neg[i] = score(model, neg[i]!);
	}
	return out;
}

/** 质量指标：每档灵敏度下，正例被认出来、反例被排除的比例。 */
export function metricsOf(positives: number, negatives: number, cv: { pos: number[]; neg: number[] } | null): SmartSetMetrics {
	if (!cv) return { positives, negatives, cv: null };
	const share = (xs: number[], ok: (p: number) => boolean) => xs.filter(ok).length / xs.length;
	const recall = {} as Record<SmartSetLevel, number>;
	const rejection = {} as Record<SmartSetLevel, number>;
	for (const l of LEVELS) {
		recall[l] = share(cv.pos, (p) => p >= SMART_SET_SENSITIVITY[l]);
		rejection[l] = share(cv.neg, (p) => p < SMART_SET_SENSITIVITY[l]);
	}
	return { positives, negatives, cv: { recall, rejection } };
}

/** [[id, 分数], …] 切成每段 JSON_ROWS 行的 JSON 文本，交给 json_each 展开。 */
const jsonChunks = (rows: [string, number][]) => {
	const out: string[] = [];
	for (let i = 0; i < rows.length; i += JSON_ROWS) out.push(JSON.stringify(rows.slice(i, i + JSON_ROWS)));
	return out;
};

/**
 * 训练，然后扫描全库替换“建议”，并更新每张样本的分数和质量指标。
 * 同一个主题同时只跑一次（refreshing_until 是锁，出错时也会释放，进程死掉则自动过期）。
 * 训练用的样本在开始时读取，期间又改了标记的话 labels_changed_at 会晚于 trained_at，界面继续提示更新。
 * 返回 null 表示主题不存在，"busy" 表示正在更新。
 */
export async function refreshSmartSet(env: Env, setId: string): Promise<{ suggestions: number } | null | "busy"> {
	const started = Date.now();
	const lock = await env.DB.prepare(
		"UPDATE smart_sets SET refreshing_until = ? WHERE id = ? AND (refreshing_until IS NULL OR refreshing_until < ?)",
	)
		.bind(started + SMART_SET_REFRESH_LOCK_MS, setId, started)
		.run();
	if (!lock.meta.changes) return (await setExists(env, setId)) ? "busy" : null;
	try {
		const { results: examples } = await env.DB.prepare(
			`SELECT e.asset_id, e.label, f.embedding FROM smart_set_examples e
			 LEFT JOIN asset_fp f ON f.asset_id = e.asset_id AND f.model = ?
			 WHERE e.set_id = ? ORDER BY e.asset_id LIMIT ?`,
		)
			.bind(FP_MODEL_VER, setId, SMART_SET_MAX_EXAMPLES)
			.all<{ asset_id: string; label: number; embedding: ArrayBuffer | null }>();
		const exampleIds = new Set(examples.map((e) => e.asset_id));
		// 范围只影响扫描哪些照片；样本不论在哪个文件夹都用来训练，背景仍从全库抽
		const scope = await scopeOfSet(env, setId);
		const pos: { id: string; v: Float32Array }[] = [];
		const neg: { id: string; v: Float32Array }[] = [];
		for (const e of examples) {
			const v = e.embedding ? normalize(asInt8(e.embedding)) : null;
			if (v) (e.label > 0 ? pos : neg).push({ id: e.asset_id, v });
		}
		const background = pos.length ? await backgroundSample(env, exampleIds) : [];
		const vs = (xs: { v: Float32Array }[]) => xs.map((x) => x.v);
		const model = pos.length ? trainClassifier(vs(pos), vs(neg), background) : null;
		// 样本的分数：做了交叉验证就用没见过它的模型打的分（更诚实），否则用整个模型
		const cv = model ? crossValidate(vs(pos), vs(neg), background) : null;
		const sampleScores: [string, number][] = model
			? [
					...pos.map((p, i): [string, number] => [p.id, cv ? cv.pos[i]! : score(model, p.v)]),
					...neg.map((n, i): [string, number] => [n.id, cv ? cv.neg[i]! : score(model, n.v)]),
				]
			: [];
		const metrics = model ? metricsOf(pos.length, neg.length, cv) : null;

		// 全库扫描：按 asset_id 分页，只留够像的；超过上限的两倍时截断一次，内存有界
		let hits: { id: string; score: number }[] = [];
		let after = "";
		while (model) {
			const { results } = await env.DB.prepare(
				// CROSS JOIN 固定按 asset_fp 的主键往后读一页：规划器自己选时会顺着 assets_timeline 读完整个资料库再排序，
				// 每页都读一遍全库，一次更新是平方级（线上每页约 50 万行）
				`SELECT f.asset_id, f.embedding FROM asset_fp f CROSS JOIN assets a ON a.id = f.asset_id
				 WHERE f.model = ? AND f.asset_id > ? AND ${VISIBLE}${scope === null ? "" : IN_SCOPE("?")} ORDER BY f.asset_id LIMIT ?`,
			)
				.bind(FP_MODEL_VER, after, ...(scope === null ? [] : [scope]), SMART_SET_SCAN_PAGE)
				.all<{ asset_id: string; embedding: ArrayBuffer }>();
			for (const r of results) {
				if (exampleIds.has(r.asset_id)) continue;
				const p = score(model, asInt8(r.embedding));
				if (p >= SMART_SET_SUGGEST_FLOOR) hits.push({ id: r.asset_id, score: p });
			}
			if (hits.length > 2 * SMART_SET_SUGGESTION_MAX) hits = hits.sort((a, b) => b.score - a.score).slice(0, SMART_SET_SUGGESTION_MAX);
			if (results.length < SMART_SET_SCAN_PAGE) break;
			after = results[results.length - 1]!.asset_id;
		}
		hits = hits.sort((a, b) => b.score - a.score).slice(0, SMART_SET_SUGGESTION_MAX);

		// 一次 batch（D1 的 batch 是一个事务）：替换建议、写样本分数、保存模型和指标、释放锁
		await env.DB.batch([
			env.DB.prepare("DELETE FROM smart_set_suggestions WHERE set_id = ?").bind(setId),
			...jsonChunks(hits.map((h) => [h.id, h.score])).map((rows) =>
				env.DB.prepare(
					`INSERT INTO smart_set_suggestions (set_id, asset_id, score)
					 SELECT ?1, json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?2)`,
				).bind(setId, rows),
			),
			...jsonChunks(sampleScores).map((rows) =>
				env.DB.prepare(
					`UPDATE smart_set_examples SET score = v.s
					 FROM (SELECT json_extract(value, '$[0]') AS id, json_extract(value, '$[1]') AS s FROM json_each(?2)) AS v
					 WHERE smart_set_examples.set_id = ?1 AND smart_set_examples.asset_id = v.id`,
				).bind(setId, rows),
			),
			env.DB.prepare(
				"UPDATE smart_sets SET weights = ?, metrics = ?, trained_at = ?, refreshing_until = NULL, updated_at = ? WHERE id = ?",
			).bind(model ? blobOf(encodeClassifier(model)) : null, metrics && JSON.stringify(metrics), started, Date.now(), setId),
		]);
		console.log(
			JSON.stringify({
				event: "smart_set_refreshed",
				setId,
				positives: pos.length,
				negatives: neg.length,
				cv: !!cv,
				suggestions: hits.length,
				scoped: scope !== null,
				ms: Date.now() - started,
			}),
		);
		return { suggestions: hits.length };
	} catch (e) {
		await env.DB.prepare("UPDATE smart_sets SET refreshing_until = NULL WHERE id = ?").bind(setId).run();
		throw e;
	}
}

/**
 * 每小时 Cron：标记有变化（或从没训练过）、而且已经 SMART_SET_CRON_QUIET_MS 没再改的主题，自动更新。
 * 只挑有正例的；每次最多 SMART_SET_CRON_BATCH 个，逐个运行；熔断时跳过。正在手动更新的会被锁跳过。
 */
export async function refreshStaleSmartSets(env: Env): Promise<number> {
	if (await guardStub(env).isTripped()) return 0;
	const now = Date.now();
	const { results } = await env.DB.prepare(
		`SELECT s.id FROM smart_sets s
		 WHERE (s.trained_at IS NULL OR s.labels_changed_at > s.trained_at)
		   AND s.labels_changed_at <= ?1
		   AND (s.refreshing_until IS NULL OR s.refreshing_until < ?2)
		   AND EXISTS (SELECT 1 FROM smart_set_examples e WHERE e.set_id = s.id AND e.label = 1)
		 ORDER BY s.labels_changed_at LIMIT ?3`,
	)
		.bind(now - SMART_SET_CRON_QUIET_MS, now, SMART_SET_CRON_BATCH)
		.all<{ id: string }>();
	let done = 0;
	for (const { id } of results) {
		try {
			const r = await refreshSmartSet(env, id);
			if (r && r !== "busy") done++;
		} catch (e) {
			console.warn(JSON.stringify({ event: "smart_set_cron_failed", setId: id, error: String(e).slice(0, 300) }));
		}
	}
	return done;
}

const SET_COLUMNS = `s.id, s.name, s.updated_at, s.trained_at, s.folders,
	(s.trained_at IS NULL OR s.labels_changed_at > s.trained_at) AS dirty,
	(s.refreshing_until IS NOT NULL AND s.refreshing_until > ?1) AS refreshing,
	(SELECT COUNT(*) FROM smart_set_examples e JOIN assets a ON a.id = e.asset_id WHERE e.set_id = s.id AND e.label = 1 AND ${VISIBLE}) AS positives,
	(SELECT COUNT(*) FROM smart_set_examples e JOIN assets a ON a.id = e.asset_id WHERE e.set_id = s.id AND e.label = -1 AND ${VISIBLE}) AS negatives`;

/** 列表：matches 是“标准”灵敏度下的建议数（结果 = 正例 + 建议）。 */
similar.get("/smart-sets", async (c) => {
	const { results } = await c.env.DB.prepare(
		`SELECT ${SET_COLUMNS},
			(SELECT COUNT(*) FROM smart_set_suggestions g JOIN assets a ON a.id = g.asset_id
			 WHERE g.set_id = s.id AND g.score >= ?2 AND ${VISIBLE}) AS matches,
			(SELECT a.id || ':' || a.derived_rev FROM smart_set_examples e JOIN assets a ON a.id = e.asset_id
			 WHERE e.set_id = s.id AND e.label = 1 AND ${VISIBLE} ORDER BY e.created_at, a.id LIMIT 1) AS cover
		 FROM smart_sets s ORDER BY s.name`,
	)
		.bind(Date.now(), SMART_SET_SENSITIVITY.normal)
		.all<Record<string, unknown> & { id: string; folders: string | null; positives: number }>();
	// 指定了范围的主题：结果只算范围里的正例和建议（建议在更新时只扫范围里的，之后移出去的照片在这里去掉）
	const scoped = results.filter((s) => s.folders !== null);
	const scopes = scoped.length
		? (await c.env.DB.batch<{ id: string }>(scoped.map((s) => scopeStmt(c.env, s.folders!)))).map((r) => scopeJson(r.results))
		: [];
	const counts = scoped.length
		? await c.env.DB.batch<{ in_scope: number; matches: number }>(
				scoped.map((s, i) =>
					c.env.DB.prepare(
						`SELECT
							(SELECT COUNT(*) FROM smart_set_examples e JOIN assets a ON a.id = e.asset_id
							 WHERE e.set_id = ?1 AND e.label = 1 AND ${VISIBLE}${IN_SCOPE("?3")}) AS in_scope,
							(SELECT COUNT(*) FROM smart_set_suggestions g JOIN assets a ON a.id = g.asset_id
							 WHERE g.set_id = ?1 AND g.score >= ?2 AND ${VISIBLE}${IN_SCOPE("?3")}) AS matches`,
					).bind(s.id, SMART_SET_SENSITIVITY.normal, scopes[i]),
				),
			)
		: [];
	const byId = new Map(scoped.map((s, i) => [s.id, counts[i]!.results[0]!]));
	const items = results.map((r) => {
		const { folders, ...rest } = r;
		return { ...withFlags(rest), scoped: folders !== null, in_scope: r.positives, ...byId.get(r.id) };
	});
	if (items.some((s) => s.refreshing)) c.header("Cache-Control", NO_STORE); // 锁过期不写库，这时的结果不能带 ETag
	return c.json({ items, next: null });
});

/** SQLite 的布尔值是 0 / 1，转成 true / false。 */
const withFlags = (r: Record<string, unknown>) => ({ ...r, dirty: !!r.dirty, refreshing: !!r.refreshing });

similar.post("/smart-sets", async (c) => {
	const body = z.object({ name: Name, ids: IDS }).parse(await c.req.json());
	const n = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM smart_sets").first<{ n: number }>();
	if ((n?.n ?? 0) >= SMART_SET_MAX) return c.json({ error: "too many smart sets" }, 409);
	const id = ulid();
	const now = Date.now();
	await c.env.DB.prepare("INSERT INTO smart_sets (id, name, created_at, updated_at, labels_changed_at) VALUES (?, ?, ?, ?, ?)")
		.bind(id, body.name, now, now, now)
		.run();
	await addExamples(c.env, id, body.ids, 1, new Map());
	const r = await refreshSmartSet(c.env, id);
	return c.json({ id, suggestions: r && r !== "busy" ? r.suggestions : 0 });
});

/**
 * 详情：
 *  - suggestions：每档灵敏度的建议数（结果 = positives + 这个数）；
 *  - conflicts：标签和分类器矛盾的样本数；changed：上次训练之后新标的（或改了标签的）样本数；
 *  - metrics：上次训练的质量指标（SmartSetMetrics），没训练过时为 null；
 *  - reviewed：每档灵敏度下，标记时正好在建议里、分数达到这一档的样本数（n）和其中标成正例的（yes），即实测准确率；
 *  - folders：范围的根文件夹（还存在的），null 表示整个资料库；in_scope：范围里的正例数（结果 = in_scope + 建议），
 *    建议数也只算范围里的。
 */
similar.get("/smart-sets/:id", async (c) => {
	const id = c.req.param("id");
	const { strict, normal, loose } = SMART_SET_SENSITIVITY;
	const row = await c.env.DB.prepare(
		`SELECT ${SET_COLUMNS}, s.metrics,
			(SELECT COUNT(*) FROM smart_set_examples e JOIN assets a ON a.id = e.asset_id WHERE e.set_id = s.id AND ${CONFLICT} AND ${VISIBLE}) AS conflicts,
			(SELECT COUNT(*) FROM smart_set_examples e WHERE e.set_id = s.id AND e.created_at > COALESCE(s.trained_at, 0)) AS changed
		 FROM smart_sets s WHERE s.id = ?2`,
	)
		.bind(Date.now(), id)
		.first<Record<string, unknown> & { metrics: string | null; folders: string | null; positives: number }>();
	if (!row) return c.json({ error: "not found" }, 404);
	const scope = await scopeOf(c.env, row.folders);
	const scopeSql = scope === null ? "" : IN_SCOPE("?5");
	const scopeBind = scope === null ? [] : [scope];
	const [levels, reviewed, inScope, folders] = await c.env.DB.batch<Record<string, number | string | null>>([
		c.env.DB.prepare(
			`SELECT SUM(g.score >= ?2) AS strict, SUM(g.score >= ?3) AS normal, SUM(g.score >= ?4) AS loose
			 FROM smart_set_suggestions g JOIN assets a ON a.id = g.asset_id WHERE g.set_id = ?1 AND ${VISIBLE}${scopeSql}`,
		).bind(id, strict, normal, loose, ...scopeBind),
		c.env.DB.prepare(
			`SELECT SUM(e.review_score >= ?2) AS strict_n, SUM(e.review_score >= ?2 AND e.label = 1) AS strict_yes,
				SUM(e.review_score >= ?3) AS normal_n, SUM(e.review_score >= ?3 AND e.label = 1) AS normal_yes,
				SUM(e.review_score >= ?4) AS loose_n, SUM(e.review_score >= ?4 AND e.label = 1) AS loose_yes
			 FROM smart_set_examples e JOIN assets a ON a.id = e.asset_id WHERE e.set_id = ?1 AND e.review_score IS NOT NULL AND ${VISIBLE}`,
		).bind(id, strict, normal, loose),
		scope === null
			? c.env.DB.prepare("SELECT ? AS n").bind(row.positives)
			: c.env.DB.prepare(
					`SELECT COUNT(*) AS n FROM smart_set_examples e JOIN assets a ON a.id = e.asset_id
					 WHERE e.set_id = ?1 AND e.label = 1 AND ${VISIBLE}${IN_SCOPE("?2")}`,
				).bind(id, scope),
		c.env.DB.prepare("SELECT f.id, f.name FROM json_each(?) j JOIN folders f ON f.id = j.value ORDER BY f.name, f.id").bind(row.folders ?? "[]"),
	]);
	const l = levels!.results[0] ?? {};
	const r = reviewed!.results[0] ?? {};
	const { metrics, folders: _folders, ...rest } = row;
	const set = withFlags(rest);
	if (set.refreshing) c.header("Cache-Control", NO_STORE);
	return c.json({
		...set,
		scoped: row.folders !== null,
		in_scope: inScope!.results[0]?.n ?? 0,
		folders: row.folders === null ? null : folders!.results,
		metrics: metrics ? (JSON.parse(metrics) as SmartSetMetrics) : null,
		suggestions: Object.fromEntries(LEVELS.map((k) => [k, l[k] ?? 0])),
		reviewed: Object.fromEntries(LEVELS.map((k) => [k, { n: r[`${k}_n`] ?? 0, yes: r[`${k}_yes`] ?? 0 }])),
	});
});

/**
 * 改名，或者改范围（folders：文件夹 id，含子文件夹；null 或空数组表示整个资料库）。
 * 改范围时只保留还存在的文件夹，然后立即更新一次（和新建主题一样）；正在更新的话标记为需要更新，由用户或 Cron 再跑。
 */
similar.patch("/smart-sets/:id", async (c) => {
	const body = z
		.object({ name: Name.optional(), folders: z.array(ID).max(SMART_SET_MAX_FOLDERS).nullable().optional() })
		.refine((b) => b.name !== undefined || b.folders !== undefined)
		.parse(await c.req.json());
	const id = c.req.param("id");
	const now = Date.now();
	let folders: string | null | undefined;
	if (body.folders !== undefined) {
		const { results } = body.folders?.length
			? await c.env.DB.prepare("SELECT id FROM folders WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id")
					.bind(JSON.stringify(body.folders))
					.all<{ id: string }>()
			: { results: [] };
		if (body.folders?.length && !results.length) return c.json({ error: "folder not found" }, 404);
		folders = results.length ? JSON.stringify(results.map((r) => r.id)) : null;
	}
	const res = await c.env.DB.prepare(
		`UPDATE smart_sets SET name = COALESCE(?1, name),
		   folders = CASE WHEN ?2 THEN ?3 ELSE folders END,
		   labels_changed_at = CASE WHEN ?2 AND folders IS NOT ?3 THEN ?4 ELSE labels_changed_at END,
		   updated_at = ?4
		 WHERE id = ?5 RETURNING (labels_changed_at = ?4) AS rescoped`,
	)
		.bind(body.name ?? null, folders !== undefined ? 1 : 0, folders ?? null, now, id)
		.first<{ rescoped: number }>();
	if (!res) return c.json({ error: "not found" }, 404);
	if (!res.rescoped) return c.json({ ok: true });
	const r = await refreshSmartSet(c.env, id);
	return c.json({ ok: true, suggestions: r && r !== "busy" ? r.suggestions : null });
});

similar.delete("/smart-sets/:id", async (c) => {
	const id = c.req.param("id");
	if (!(await setExists(c.env, id))) return c.json({ error: "not found" }, 404);
	await c.env.DB.batch([
		c.env.DB.prepare("DELETE FROM smart_set_suggestions WHERE set_id = ?").bind(id),
		c.env.DB.prepare("DELETE FROM smart_set_examples WHERE set_id = ?").bind(id),
		c.env.DB.prepare("DELETE FROM smart_sets WHERE id = ?").bind(id),
	]);
	return c.json({ ok: true });
});

/**
 * 写样本（label 0 是移出样本），并记下标记变了的时间。scores 是当前模型给的分数（没有模型时为空），先存着，下次训练时更新。
 * 正好在建议里的照片：记下当时的建议分数（review_score），再从建议里去掉。改了标签的样本按新标记的时间排在前面。
 */
async function addExamples(env: Env, setId: string, ids: string[], label: 1 | -1 | 0, scores: Map<string, number>) {
	const now = Date.now();
	for (let i = 0; i < ids.length; i += 50) {
		const chunk = ids.slice(i, i + 50);
		await env.DB.batch(
			chunk.flatMap((assetId) =>
				label === 0
					? [env.DB.prepare("DELETE FROM smart_set_examples WHERE set_id = ? AND asset_id = ?").bind(setId, assetId)]
					: [
							env.DB.prepare(
								`INSERT INTO smart_set_examples (set_id, asset_id, label, train, score, review_score, created_at)
								 SELECT ?1, ?2, ?3, 1, ?4, (SELECT g.score FROM smart_set_suggestions g WHERE g.set_id = ?1 AND g.asset_id = ?2), ?5
								 WHERE EXISTS (SELECT 1 FROM assets WHERE id = ?2)
								 ON CONFLICT (set_id, asset_id) DO UPDATE SET
								   score = COALESCE(excluded.score, score),
								   created_at = CASE WHEN label = excluded.label THEN created_at ELSE excluded.created_at END,
								   label = excluded.label`,
							).bind(setId, assetId, label, scores.get(assetId) ?? null, now),
							env.DB.prepare("DELETE FROM smart_set_suggestions WHERE set_id = ? AND asset_id = ?").bind(setId, assetId),
						],
			),
		);
	}
	await env.DB.prepare("UPDATE smart_sets SET labels_changed_at = ? WHERE id = ?").bind(now, setId).run();
}

/** 用当前的分类器给这些照片打分。没有指纹的不在结果里。 */
async function scoresOf(env: Env, model: Classifier, ids: string[]): Promise<Map<string, number>> {
	const out = new Map<string, number>();
	for (let i = 0; i < ids.length; i += CHUNK) {
		const chunk = ids.slice(i, i + CHUNK);
		const { results } = await env.DB.prepare(
			`SELECT asset_id, embedding FROM asset_fp WHERE model = ? AND asset_id IN (${chunk.map(() => "?").join(",")})`,
		)
			.bind(FP_MODEL_VER, ...chunk)
			.all<{ asset_id: string; embedding: ArrayBuffer }>();
		for (const r of results) out.set(r.asset_id, score(model, asInt8(r.embedding)));
	}
	return out;
}

/**
 * 标为正例（1）、反例（-1），或者移出样本（0）。只记录，不重新训练（用户点“更新”或 Cron 时才训练）。
 * 主题训练过的话先用当前模型打分，conflicts 是其中和标签矛盾的张数（分类器认不出来的正例、它很确定的反例）。
 */
similar.post("/smart-sets/:id/examples", async (c) => {
	const id = c.req.param("id");
	const body = z.object({ ids: IDS, label: z.union([z.literal(1), z.literal(-1), z.literal(0)]) }).parse(await c.req.json());
	if (!(await setExists(c.env, id))) return c.json({ error: "not found" }, 404);
	if (body.label !== 0) {
		// 已经是样本的只是改标签，不占新名额
		const others = await c.env.DB.prepare(
			"SELECT COUNT(*) AS n FROM smart_set_examples WHERE set_id = ? AND asset_id NOT IN (SELECT value FROM json_each(?))",
		)
			.bind(id, JSON.stringify(body.ids))
			.first<{ n: number }>();
		if ((others?.n ?? 0) + body.ids.length > SMART_SET_MAX_EXAMPLES) return c.json({ error: "too many examples" }, 409);
	}
	const model = body.label === 0 ? null : await classifierOf(c.env, id);
	const scores = model ? await scoresOf(c.env, model, body.ids) : new Map<string, number>();
	await addExamples(c.env, id, body.ids, body.label, scores);
	const conflicts = body.label === 0 ? 0 : body.ids.filter((assetId) => isConflict(body.label, scores.get(assetId))).length;
	return c.json({ changed: body.ids.length, conflicts });
});

/** 训练并扫描全库，替换建议。正在更新时返回 409。 */
similar.post("/smart-sets/:id/refresh", async (c) => {
	const r = await refreshSmartSet(c.env, c.req.param("id"));
	if (!r) return c.json({ error: "not found" }, 404);
	if (r === "busy") return c.json({ error: "already refreshing" }, 409);
	return c.json(r);
});

const Offset = (c: { req: { query: (k: string) => string | undefined } }) => Math.max(0, Math.floor(Number(c.req.query("offset") ?? 0)) || 0);
/** 灵敏度（最低分数），不低于 SMART_SET_SUGGEST_FLOOR；不传时是 fallback。 */
const MinScore = (v: string | undefined, fallback: number) => Math.min(1, Math.max(SMART_SET_SUGGEST_FLOOR, Number(v) || fallback));

/**
 * 样本，最近标记的在前。filter：positive / negative / conflict（标签和分类器矛盾的），不传是全部。
 * marks 和 items 一一对应：[标签 1 / -1, 分数（没有时为 null）]。
 */
similar.get("/smart-sets/:id/examples", async (c) => {
	const offset = Offset(c);
	const filter = c.req.query("filter");
	const cond =
		filter === "positive" ? " AND e.label = 1" : filter === "negative" ? " AND e.label = -1" : filter === "conflict" ? ` AND ${CONFLICT}` : "";
	const { results } = await c.env.DB.prepare(
		`SELECT ${ITEM_COLUMNS}, e.label, e.score FROM smart_set_examples e JOIN assets a ON a.id = e.asset_id
		 WHERE e.set_id = ?${cond} AND ${VISIBLE} ORDER BY e.created_at DESC, a.id LIMIT ? OFFSET ?`,
	)
		.bind(c.req.param("id"), PAGE + 1, offset)
		.all<ItemRow & { label: number; score: number | null }>();
	const rows = results.slice(0, PAGE);
	return c.json({
		items: rows.map(toItem),
		marks: rows.map((r) => [r.label, r.score === null ? null : Math.round(r.score * 1000) / 1000]),
		next: results.length > PAGE ? offset + PAGE : null,
	});
});

/**
 * 建议（还不是样本的照片），给“判断”用。order=uncertain：分类器最拿不准的在前（分数最接近“标准”档），
 * 标这些最能让它变准；否则按分数从高到低。scores 和 items 一一对应。
 */
similar.get("/smart-sets/:id/suggestions", async (c) => {
	const offset = Offset(c);
	const min = MinScore(c.req.query("min"), SMART_SET_SUGGEST_FLOOR);
	const order = c.req.query("order") === "uncertain" ? `ABS(g.score - ${SMART_SET_SENSITIVITY.normal}), a.id` : "g.score DESC, a.id";
	const scope = await scopeOfSet(c.env, c.req.param("id"));
	const { results } = await c.env.DB.prepare(
		`SELECT ${ITEM_COLUMNS}, g.score FROM smart_set_suggestions g JOIN assets a ON a.id = g.asset_id
		 WHERE g.set_id = ? AND g.score >= ? AND ${VISIBLE}${scope === null ? "" : IN_SCOPE("?")} ORDER BY ${order} LIMIT ? OFFSET ?`,
	)
		.bind(c.req.param("id"), min, ...(scope === null ? [] : [scope]), PAGE + 1, offset)
		.all<ItemRow & { score: number }>();
	const rows = results.slice(0, PAGE);
	return c.json({
		items: rows.map(toItem),
		scores: rows.map((r) => Math.round(r.score * 1000) / 1000),
		next: results.length > PAGE ? offset + PAGE : null,
	});
});

/**
 * 结果：正例 + 分数达到灵敏度（min，默认“标准”）的建议，按拍摄时间倒序，带每月张数。指定了范围时只看范围里的（正例也是）。
 * notInAlbum：去掉已经在这个相册里的（挑过一轮之后只看新增的）；type：和相册一样的类型筛选。
 */
similar.get("/smart-sets/:id/assets", async (c) => {
	const id = c.req.param("id");
	const min = MinScore(c.req.query("min"), SMART_SET_SENSITIVITY.normal);
	const album = ID.safeParse(c.req.query("notInAlbum"));
	const type = typeCondition(TypeParam.parse(c.req.query("type")));
	const scope = await scopeOfSet(c.env, id);
	return c.json(
		await page(
			c.env,
			`SELECT ${ITEM_COLUMNS} FROM assets a
			 WHERE a.id IN (SELECT asset_id FROM smart_set_examples WHERE set_id = ? AND label = 1
			                UNION ALL SELECT asset_id FROM smart_set_suggestions WHERE set_id = ? AND score >= ?)
			   AND ${VISIBLE}${scope === null ? "" : IN_SCOPE("?")}${album.success ? " AND NOT EXISTS (SELECT 1 FROM album_assets x WHERE x.album_id = ? AND x.asset_id = a.id)" : ""}${andType(type)}
			 ORDER BY a.taken_at DESC, a.id DESC`,
			[id, id, min, ...(scope === null ? [] : [scope]), ...(album.success ? [album.data] : []), ...(type?.binds ?? [])],
			Offset(c),
			{ withMonths: true },
		),
	);
});
