import { SELF, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DUPLICATE_MAX_HAMMING, FP_DIMS, FP_MODEL_VER, SMART_SET_CRON_QUIET_MS, SMART_SET_CV_MIN } from "@nana/shared";
import { guardStub } from "../src/guard";
import { deleteAssetsPermanently } from "../src/purge";
import {
	crossValidate,
	dot,
	groupDuplicates,
	hamming,
	metricsOf,
	normalize,
	pairKey,
	phashBands,
	pickKeeper,
	refreshStaleSmartSets,
	saveFingerprint,
	similar,
} from "../src/similar";
import { decodeClassifier, encodeClassifier, score, trainClassifier } from "../src/smartset-model";
import { authHeaders, mockAccessJwks } from "./helpers";

beforeAll(() => mockAccessJwks());

// 确定性的伪随机数，测试结果可复现
let seed = 1;
const rand = () => {
	seed = (seed * 1103515245 + 12345) & 0x7fffffff;
	return seed / 0x7fffffff;
};
const randomHash = () => Array.from({ length: 16 }, () => Math.floor(rand() * 16).toString(16)).join("");
function flipBits(hash: string, n: number) {
	let v = BigInt(`0x${hash}`);
	const used = new Set<number>();
	while (used.size < n) used.add(Math.floor(rand() * 64));
	for (const b of used) v ^= 1n << BigInt(b);
	return v.toString(16).padStart(16, "0");
}
const randomVec = () => Int8Array.from({ length: FP_DIMS }, () => Math.round((rand() * 2 - 1) * 127));
/** 在 base 上加一点噪声：和 base 很像，但不完全一样。 */
const near = (base: Int8Array, noise = 20) =>
	Int8Array.from(base, (x) => Math.max(-127, Math.min(127, x + Math.round((rand() * 2 - 1) * noise))));
const toB64 = (v: Int8Array) => btoa(String.fromCharCode(...new Uint8Array(v.buffer)));
const fp = (phash: string, v: Int8Array) => ({ model: FP_MODEL_VER, phash, embedding: toB64(v) });

const aid = (n: number) => `SIM${String(n).padStart(23, "0")}`;
async function seed_(n: number, extra: { deleted?: boolean; kind?: string; favorite?: number; width?: number; burst?: string } = {}) {
	await env.DB.prepare(
		`INSERT INTO assets (id, kind, status, local_month, local_day, taken_at, width, height, favorite, burst_id, deleted_at, created_at, updated_at)
		 VALUES (?, ?, 'ready', '2024-05', '2024-05-01', ?, ?, 3000, ?, ?, ?, ?, 0)`,
	)
		.bind(aid(n), extra.kind ?? "photo", 1714500000000 + n, extra.width ?? 4000, extra.favorite ?? 0, extra.burst ?? null, extra.deleted ? Date.now() : null, n)
		.run();
	await env.DB.prepare(
		"INSERT INTO asset_files (id, asset_id, role, r2_key, mime, size, created_at) VALUES (?, ?, 'original', ?, 'image/jpeg', 100, 0)",
	)
		.bind(`SF${n}`, aid(n), `o/${aid(n)}/SF${n}`)
		.run();
}

async function call<T = any>(e: Env, method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
	const res = await similar.request(
		path,
		{ method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined },
		e,
	);
	return { status: res.status, json: (await res.json()) as T };
}

beforeEach(async () => {
	await guardStub(env).reset();
	await env.DB.batch([
		env.DB.prepare("DELETE FROM smart_set_suggestions"),
		env.DB.prepare("DELETE FROM smart_set_examples"),
		env.DB.prepare("DELETE FROM smart_sets"),
		env.DB.prepare("DELETE FROM asset_fp"),
		env.DB.prepare("DELETE FROM duplicate_ignores"),
		env.DB.prepare("DELETE FROM duplicate_pairs"),
		env.DB.prepare("DELETE FROM duplicate_pairs_state"),
		env.DB.prepare("DELETE FROM faces"),
		env.DB.prepare("DELETE FROM people"),
		env.DB.prepare("DELETE FROM jobs"),
		env.DB.prepare("DELETE FROM asset_files"),
		env.DB.prepare("DELETE FROM assets"),
	]);
});

describe("perceptual hash", () => {
	it("splits into 5 bands that reassemble to the hash", () => {
		const h = "fcc10bf9d813f031";
		const [b0, b1, b2, b3, b4] = phashBands(h).map(BigInt) as [bigint, bigint, bigint, bigint, bigint];
		expect(((b0 << 51n) | (b1 << 38n) | (b2 << 25n) | (b3 << 12n) | b4).toString(16)).toBe(h);
		expect(hamming(h, h)).toBe(0);
		expect(hamming("0000000000000000", "ffffffffffffffff")).toBe(64);
		expect(hamming(h, flipBits(h, 3))).toBe(3);
	});

	it("never misses a pair within the distance limit (pigeonhole over the bands)", () => {
		const rows: { id: string; phash: string; kind: string; burst_id: null; origin: number }[] = [];
		for (let i = 0; i < 300; i++) {
			const h = randomHash();
			rows.push({ id: `o${i}`, phash: h, kind: "photo", burst_id: null, origin: i });
			rows.push({ id: `v${i}`, phash: flipBits(h, 1 + (i % DUPLICATE_MAX_HAMMING)), kind: "photo", burst_id: null, origin: i });
		}
		const groups = groupDuplicates(rows);
		expect(groups).toHaveLength(300);
		for (const g of groups) expect(new Set(g.map((r) => r.origin)).size).toBe(1);
	});

	it("does not group photos with videos, frames of the same burst, or distant hashes", () => {
		const h = randomHash();
		const groups = groupDuplicates([
			{ id: "a", phash: h, kind: "photo", burst_id: null },
			{ id: "b", phash: h, kind: "video", burst_id: null },
			{ id: "c", phash: flipBits(h, 5), kind: "video", burst_id: null },
			{ id: "d", phash: h, kind: "live", burst_id: "B" },
			{ id: "e", phash: h, kind: "photo", burst_id: "B" },
		]);
		// a 和 d、e 都是同一张图（d、e 同一组连拍，但都和 a 相同，所以通过 a 连在一起）；b 和 c 距离 5，不算
		expect(groups.map((g) => g.map((r) => r.id).sort())).toEqual([["a", "d", "e"]]);
	});

	it("does not group different captures: times that differ, vectors that differ, or ignored pairs", () => {
		const h = randomHash();
		const t = 1714500000000;
		const cam = { camera: "Apple iPhone 15 Pro", meta_locked: 0 };
		const row = (id: string, extra: Record<string, unknown> = {}) => ({ id, phash: h, kind: "photo", burst_id: null, ...extra });
		const ids = (groups: { id: string }[][]) => groups.map((g) => g.map((r) => r.id).sort());

		// 同一次拍摄：时间相同、丢了亚秒、丢了时区（差整 8 小时）
		expect(ids(groupDuplicates([row("a", { ...cam, taken_at: t + 400 }), row("b", { ...cam, taken_at: t }), row("c", { ...cam, taken_at: t + 8 * 3600_000 })]))).toEqual([["a", "b", "c"]]);
		// 两次拍摄，隔了 3 秒
		expect(groupDuplicates([row("a", { ...cam, taken_at: t }), row("b", { ...cam, taken_at: t + 3000 })])).toEqual([]);
		// 没有相机 EXIF（时间可能来自文件修改时间）或者改过时间的，不按时间判断
		expect(groupDuplicates([row("a", { taken_at: t }), row("b", { taken_at: t + 3000 })])).toHaveLength(1);
		expect(groupDuplicates([row("a", { ...cam, taken_at: t }), row("b", { ...cam, taken_at: t + 3000, meta_locked: 1 })])).toHaveLength(1);

		// 向量：两张都有时才比较
		const raw = randomVec();
		const vectors = new Map([["a", normalize(raw)!], ["b", normalize(near(raw, 10))!], ["c", normalize(randomVec())!]]);
		expect(ids(groupDuplicates([row("a"), row("b"), row("c")], { vectors }))).toEqual([["a", "b"]]);
		expect(ids(groupDuplicates([row("c"), row("d")], { vectors }))).toEqual([["c", "d"]]); // d 没有向量

		// 标记过“不是重复”的对
		expect(groupDuplicates([row("a"), row("b")], { ignored: new Set([pairKey("b", "a")]) })).toEqual([]);
	});

	it("keeps favorites, then Live Photos, then RAW, then the largest", () => {
		const base = { kind: "photo", traits: 0, favorite: 0, width: 4000, height: 3000, size: 100, created_at: 0 };
		expect(pickKeeper([{ ...base, id: "a" }, { ...base, id: "b", width: 8000 }]).id).toBe("b");
		expect(pickKeeper([{ ...base, id: "a", width: 8000 }, { ...base, id: "b", traits: 8 }]).id).toBe("b");
		expect(pickKeeper([{ ...base, id: "a", traits: 8 }, { ...base, id: "b", favorite: 1 }]).id).toBe("b");
		// 同一张照片的静态副本（JPEG 往往比 HEIC 大、尺寸相同）不能把 Live Photo 挤掉
		expect(pickKeeper([{ ...base, id: "a", size: 900 }, { ...base, id: "b", kind: "live" }]).id).toBe("b");
		expect(pickKeeper([{ ...base, id: "a", width: 8000, traits: 8 }, { ...base, id: "b", kind: "live" }]).id).toBe("b");
		expect(pickKeeper([{ ...base, id: "a", kind: "live" }, { ...base, id: "b", favorite: 1 }]).id).toBe("b");
		expect(pickKeeper([{ ...base, id: "a", created_at: 5 }, { ...base, id: "b", created_at: 1 }]).id).toBe("b");
	});
});

describe("smart set classifier", () => {
	// 模拟 CLIP：所有向量都有很大的公共分量，再加上主体、背景和噪声
	const unitVec = () => normalize(Array.from({ length: FP_DIMS }, () => rand() * 2 - 1))!;
	const mix = (parts: [Float32Array, number][]) => {
		const v = new Float32Array(FP_DIMS);
		for (const [p, w] of [...parts, [unitVec(), 0.6] as [Float32Array, number]]) for (let d = 0; d < FP_DIMS; d++) v[d]! += p[d]! * w;
		return normalize(v)!;
	};

	it("learns the shared subject, not the shared background", () => {
		const common = unitVec();
		const heel = unitVec();
		const flat = unitVec();
		const floor = unitVec();
		const scenes = Array.from({ length: 30 }, unitVec);
		const pos = Array.from({ length: 20 }, () => mix([[common, 1], [heel, 0.8], [floor, 0.5]]));
		const neg = Array.from({ length: 5 }, () => mix([[common, 1], [flat, 0.8], [floor, 0.5]]));
		const bg = Array.from({ length: 200 }, (_, i) => mix([[common, 1], [scenes[i % 30]!, 0.8]]));
		const c = trainClassifier(pos, neg, bg)!;
		const median = (xs: Float32Array[]) => xs.map((x) => score(c, x)).sort((a, b) => a - b)[xs.length >> 1]!;
		// 换了背景的高跟鞋：高分；同样的地板、没有高跟鞋：低于“标准”档；平底鞋（负例）：很低
		const heelElsewhere = median(Array.from({ length: 20 }, (_, i) => mix([[common, 1], [heel, 0.8], [scenes[i]!, 0.5]])));
		const floorOnly = median(Array.from({ length: 20 }, () => mix([[common, 1], [floor, 0.8]])));
		expect(heelElsewhere).toBeGreaterThan(0.7);
		expect(floorOnly).toBeLessThan(0.5);
		expect(heelElsewhere - floorOnly).toBeGreaterThan(0.4);
		expect(median(Array.from({ length: 20 }, (_, i) => mix([[common, 1], [flat, 0.8], [scenes[i]!, 0.5]])))).toBeLessThan(0.1);
		// int8 存储和未归一化的输入打分一样
		const x = mix([[common, 1], [heel, 0.8]]);
		expect(score(c, Int8Array.from(x, (v) => Math.round(v * 300)))).toBeCloseTo(score(c, x), 1);
		const back = decodeClassifier(encodeClassifier(c))!;
		expect(score(back, x)).toBeCloseTo(score(c, x), 5);
	});

	it("needs positives and something to contrast with", () => {
		const v = normalize(randomVec())!;
		expect(trainClassifier([], [v], [v])).toBeNull();
		expect(trainClassifier([v], [], [])).toBeNull();
		expect(decodeClassifier(new Uint8Array(12))).toBeNull();
	});
});

describe("fingerprint storage", () => {
	it("writes the fingerprint to D1, replacing an older one", async () => {
		await seed_(1);
		const h = randomHash();
		expect(await saveFingerprint(env, aid(1), fp(randomHash(), randomVec()))).toBe(true);
		expect(await saveFingerprint(env, aid(1), fp(h, randomVec()))).toBe(true);
		const rows = await env.DB.prepare("SELECT phash, b0 FROM asset_fp").all<{ phash: string; b0: number }>();
		expect(rows.results).toEqual([{ phash: h, b0: phashBands(h)[0] }]);
	});

	it("rejects malformed fingerprints without failing", async () => {
		await seed_(1);
		expect(await saveFingerprint(env, aid(1), null)).toBe(false);
		expect(await saveFingerprint(env, aid(1), { model: FP_MODEL_VER, phash: "xyz", embedding: "" })).toBe(false);
		expect(await saveFingerprint(env, aid(1), { ...fp(randomHash(), randomVec()), model: "old-model" })).toBe(false);
		expect(await saveFingerprint(env, aid(1), { model: FP_MODEL_VER, phash: randomHash(), embedding: btoa("short") })).toBe(false);
		expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM asset_fp").first("n")).toBe(0);
	});

	it("permanent delete removes the fingerprint", async () => {
		await seed_(1);
		await saveFingerprint(env, aid(1), fp(randomHash(), randomVec()));
		await deleteAssetsPermanently(env, [aid(1)]);
		expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM asset_fp").first("n")).toBe(0);
	});
});

describe("duplicates", () => {
	it("groups visually identical photos and recommends one to keep", async () => {
		const h = randomHash();
		const v = randomVec();
		await seed_(1);
		await seed_(2, { width: 8000 }); // 分辨率最高，推荐保留
		await seed_(3);
		await seed_(4, { deleted: true });
		await seed_(5);
		await seed_(6);
		await saveFingerprint(env, aid(1), fp(h, near(v)));
		await saveFingerprint(env, aid(2), fp(flipBits(h, 2), near(v)));
		await saveFingerprint(env, aid(3), fp(flipBits(h, 4), near(v)));
		await saveFingerprint(env, aid(4), fp(h, near(v)));
		await saveFingerprint(env, aid(5), fp(randomHash(), near(v)));
		await saveFingerprint(env, aid(6), fp(h, randomVec())); // 哈希相同，但内容明显不同

		const r = await call(env, "GET", "/duplicates");
		expect(r.json.total).toBe(1);
		expect(r.json.groups[0].keep).toBe(aid(2));
		expect(r.json.groups[0].items.map((i: unknown[]) => i[0]).sort()).toEqual([aid(1), aid(2), aid(3)]);
		expect(r.json.next).toBeNull();
	});

	it("can mark a group, or one photo of it, as not duplicates, and undo it", async () => {
		const h = randomHash();
		const v = randomVec();
		for (const n of [1, 2, 3]) {
			await seed_(n);
			await saveFingerprint(env, aid(n), fp(h, near(v)));
		}
		const ids = () => call(env, "GET", "/duplicates").then((r) => r.json.groups.map((g: { items: unknown[][] }) => g.items.map((i) => i[0]).sort()));
		expect(await ids()).toEqual([[aid(1), aid(2), aid(3)]]);

		// 3 和另外两张不一样
		expect((await call(env, "POST", "/duplicates/ignore", { ids: [aid(1), aid(2), aid(3)], pivot: aid(3) })).json).toEqual({ pairs: 2 });
		expect(await ids()).toEqual([[aid(1), aid(2)]]);
		// 整组都不是重复
		await call(env, "POST", "/duplicates/ignore", { ids: [aid(1), aid(2)] });
		expect(await ids()).toEqual([]);
		// 重复标记不报错；撤销后恢复
		expect((await call(env, "POST", "/duplicates/ignore", { ids: [aid(2), aid(1)] })).status).toBe(200);
		await call(env, "POST", "/duplicates/unignore", { ids: [aid(1), aid(2), aid(3)] });
		expect(await ids()).toEqual([[aid(1), aid(2), aid(3)]]);

		// 不存在的条目跳过；永久删除时级联删除
		expect((await call(env, "POST", "/duplicates/ignore", { ids: [aid(1), aid(99)] })).json).toEqual({ pairs: 0 });
		await call(env, "POST", "/duplicates/ignore", { ids: [aid(1), aid(2)] });
		await env.DB.prepare("DELETE FROM assets WHERE id = ?").bind(aid(1)).run();
		expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM duplicate_ignores").first("n")).toBe(0);
	});
});

describe("duplicate pairs", () => {
	const pairs = async () =>
		(await env.DB.prepare("SELECT a, b FROM duplicate_pairs ORDER BY a, b").all<{ a: string; b: string }>()).results.map((r) => `${r.a}:${r.b}`);
	const groupIds = () =>
		call(env, "GET", "/duplicates").then((r) => r.json.groups.map((g: { items: unknown[][] }) => g.items.map((i) => i[0]).sort()));

	it("keeps candidate pairs up to date as fingerprints are written", async () => {
		const h = randomHash();
		const v = randomVec();
		for (const n of [1, 2, 3]) await seed_(n);
		await env.DB.prepare("INSERT INTO duplicate_pairs_state (id, built_at) VALUES (1, 0)").run();
		await saveFingerprint(env, aid(1), fp(h, near(v)));
		await saveFingerprint(env, aid(2), fp(flipBits(h, 3), near(v)));
		await saveFingerprint(env, aid(3), fp(h, randomVec())); // 向量不像，不存
		expect(await pairs()).toEqual([`${aid(1)}:${aid(2)}`]);
		expect(await groupIds()).toEqual([[aid(1), aid(2)]]);

		// 会变的条件在读取时过滤：进回收站、改到另一个时刻（两张都有相机信息）
		await env.DB.prepare("UPDATE assets SET deleted_at = 1 WHERE id = ?").bind(aid(2)).run();
		expect(await groupIds()).toEqual([]);
		await env.DB.prepare("UPDATE assets SET deleted_at = NULL, camera = 'X' WHERE id IN (?, ?)").bind(aid(1), aid(2)).run();
		await env.DB.prepare("UPDATE assets SET taken_at = taken_at + 7000 WHERE id = ?").bind(aid(2)).run();
		expect(await groupIds()).toEqual([]);
		await env.DB.prepare("UPDATE assets SET taken_at = taken_at - 7000 WHERE id = ?").bind(aid(2)).run();
		expect(await groupIds()).toEqual([[aid(1), aid(2)]]);

		// 重新处理后哈希变了：旧的候选对删掉
		await saveFingerprint(env, aid(2), fp(randomHash(), near(v)));
		expect(await pairs()).toEqual([]);
	});

	it("builds pairs for fingerprints written before the table existed, once", async () => {
		const h = randomHash();
		const v = randomVec();
		for (const n of [1, 2, 3, 4]) {
			await seed_(n, n === 4 ? { deleted: true } : {});
			await saveFingerprint(env, aid(n), fp(n === 3 ? randomHash() : flipBits(h, n === 4 ? 1 : n), near(v)));
		}
		// 模拟部署前：没有候选对，也没有建好的标记
		await env.DB.batch([env.DB.prepare("DELETE FROM duplicate_pairs"), env.DB.prepare("DELETE FROM duplicate_pairs_state")]);
		const r = await call(env, "GET", "/duplicates");
		expect(r.json.groups.map((g: { items: unknown[][] }) => g.items.map((i) => i[0]).sort())).toEqual([[aid(1), aid(2)]]);
		expect(r.json.scanned).toBe(3);
		// 回收站里的也建好了，恢复后直接出现
		expect(await pairs()).toEqual([`${aid(1)}:${aid(2)}`, `${aid(1)}:${aid(4)}`, `${aid(2)}:${aid(4)}`]);
		expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM duplicate_pairs_state").first("n")).toBe(1);
		await env.DB.prepare("UPDATE assets SET deleted_at = NULL WHERE id = ?").bind(aid(4)).run();
		expect(await groupIds()).toEqual([[aid(1), aid(2), aid(4)]]);
	});
});

describe("fingerprint status", () => {
	it("counts visible assets without a current fingerprint", async () => {
		for (let i = 1; i <= 4; i++) await seed_(i, { deleted: i === 4 });
		await saveFingerprint(env, aid(1), fp(randomHash(), randomVec()));
		const status = await call(env, "GET", "/fingerprints/status");
		expect(status.json).toEqual({ total: 3, missing: 2 });
	});
});

describe("smart sets", () => {
	it("stores BLOBs as BLOBs and still reads the comma text production D1 wrote for typed arrays", async () => {
		const cat = randomVec();
		for (let i = 1; i <= 20; i++) await seed_(i);
		const vecs: Record<number, Int8Array> = { 1: near(cat), 2: near(cat), 3: near(cat) };
		for (let i = 4; i <= 20; i++) vecs[i] = randomVec();
		for (const [n, v] of Object.entries(vecs)) await saveFingerprint(env, aid(Number(n)), fp(randomHash(), v));
		expect(await env.DB.prepare("SELECT DISTINCT typeof(embedding) AS t FROM asset_fp").all()).toMatchObject({ results: [{ t: "blob" }] });

		// 修复之前线上的样子：Int8Array 被 String() 成 "-3,5,1,…" 存成 TEXT
		for (const [n, v] of Object.entries(vecs))
			await env.DB.prepare("UPDATE asset_fp SET embedding = ? WHERE asset_id = ?").bind(String(v), aid(Number(n))).run();
		const created = await call(env, "POST", "/smart-sets", { name: "猫", ids: [aid(1), aid(2)] });
		expect(created.json.suggestions).toBe(1);
		const row = await env.DB.prepare("SELECT typeof(weights) AS t, weights FROM smart_sets").first<{ t: string; weights: ArrayBuffer }>();
		expect(row?.t).toBe("blob");
		expect(decodeClassifier(row!.weights)).not.toBeNull();

		// 线上写成文本的模型也能读
		const model = decodeClassifier(row!.weights)!;
		const text = String(encodeClassifier(model));
		expect(decodeClassifier(text)).toEqual(model);
	});

	it("trains on demand, scans the whole library, and scores new photos", async () => {
		const cat = randomVec();
		const dog = randomVec();
		for (let i = 1; i <= 40; i++) await seed_(i);
		await seed_(41, { deleted: true });
		const vecs: Record<number, Int8Array> = { 1: near(cat), 2: near(cat), 3: near(cat), 4: near(cat), 5: near(dog), 6: near(dog), 41: near(cat) };
		for (let i = 9; i <= 40; i++) vecs[i] = randomVec(); // 其他照片，用作背景
		// 不写 Vectorize：主题只读 D1
		for (const [n, v] of Object.entries(vecs)) await saveFingerprint(env, aid(Number(n)), fp(randomHash(), v));

		const created = await call(env, "POST", "/smart-sets", { name: "猫", ids: [aid(1), aid(2)] });
		expect(created.status).toBe(200);
		const id = created.json.id;
		expect(created.json.suggestions).toBe(2);
		const ids = (r: { json: { items: unknown[][] } }) => r.json.items.map((i) => i[0] as string).sort();
		const suggestions = async (q = "") => ids(await call(env, "GET", `/smart-sets/${id}/suggestions${q}`));
		const results = async (q = "") => ids(await call(env, "GET", `/smart-sets/${id}/assets${q}`));
		expect(await suggestions()).toEqual([aid(3), aid(4)]); // 不包括样本、狗、回收站里的猫
		expect(await results()).toEqual([aid(1), aid(2), aid(3), aid(4)]); // 结果 = 正例 + 建议
		expect((await call(env, "GET", `/smart-sets/${id}`)).json).toMatchObject({
			name: "猫",
			positives: 2,
			negatives: 0,
			conflicts: 0,
			changed: 0,
			dirty: false,
			refreshing: false,
			suggestions: { strict: 2, normal: 2, loose: 2 },
			metrics: { positives: 2, negatives: 0, cv: null }, // 样本太少，不做交叉验证
		});
		const sugg = (await call(env, "GET", `/smart-sets/${id}/suggestions?order=uncertain`)).json;
		expect(sugg.scores).toHaveLength(2);

		// 标记只记录：建议里去掉这两张、记下当时的建议分数，但不重新训练
		await call(env, "POST", `/smart-sets/${id}/examples`, { ids: [aid(3)], label: 1 });
		expect((await call(env, "POST", `/smart-sets/${id}/examples`, { ids: [aid(4)], label: -1 })).json).toEqual({ changed: 1, conflicts: 1 });
		expect(await suggestions()).toEqual([]);
		let detail = (await call(env, "GET", `/smart-sets/${id}`)).json;
		expect(detail).toMatchObject({ dirty: true, positives: 3, negatives: 1, changed: 2, conflicts: 1 });
		expect(detail.reviewed.loose).toEqual({ n: 2, yes: 1 });
		expect(await results()).toEqual([aid(1), aid(2), aid(3)]);
		expect((await call(env, "POST", `/smart-sets/${id}/refresh`)).json).toEqual({ suggestions: 0 });
		detail = (await call(env, "GET", `/smart-sets/${id}`)).json;
		expect(detail).toMatchObject({ dirty: false, changed: 0 });

		// 正在更新时拒绝；锁过期后可以再跑
		await env.DB.prepare("UPDATE smart_sets SET refreshing_until = ? WHERE id = ?").bind(Date.now() + 60_000, id).run();
		expect((await call(env, "POST", `/smart-sets/${id}/refresh`)).status).toBe(409);
		await env.DB.prepare("UPDATE smart_sets SET refreshing_until = ? WHERE id = ?").bind(Date.now() - 1, id).run();
		expect((await call(env, "POST", `/smart-sets/${aid(99)}/refresh`)).status).toBe(404);

		// 新照片处理完：像的直接进建议
		await saveFingerprint(env, aid(7), fp(randomHash(), near(cat)));
		await saveFingerprint(env, aid(8), fp(randomHash(), near(dog)));
		expect(await suggestions()).toEqual([aid(7)]);

		// 分类器认不出来的正例：照样学，但标成矛盾
		expect((await call(env, "POST", `/smart-sets/${id}/examples`, { ids: [aid(5)], label: 1 })).json).toEqual({ changed: 1, conflicts: 1 });
		const examples = async (q = "") => (await call(env, "GET", `/smart-sets/${id}/examples${q}`)).json;
		const all = await examples();
		expect(all.items.map((i: unknown[]) => i[0])[0]).toBe(aid(5)); // 最近标的在前
		expect(all.marks).toHaveLength(5);
		expect(all.marks[0][0]).toBe(1);
		expect(all.marks[0][1]).toBeLessThan(0.3);
		// aid(4)（标成反例的猫）重新训练后的分数取决于随机抽的背景，是否还算矛盾不固定，只检查确定的部分
		const conflicts = async () => ids({ json: await examples("?filter=conflict") });
		expect(await conflicts()).toContain(aid(5));
		expect(ids({ json: await examples("?filter=negative") })).toEqual([aid(4)]);
		expect(ids({ json: await examples("?filter=positive") })).toEqual([aid(1), aid(2), aid(3), aid(5)]);

		// 改标签：不占新名额，排到前面
		await call(env, "POST", `/smart-sets/${id}/examples`, { ids: [aid(5)], label: -1 });
		await call(env, "POST", `/smart-sets/${id}/examples`, { ids: [aid(1)], label: -1 });
		await call(env, "POST", `/smart-sets/${id}/examples`, { ids: [aid(1)], label: 1 });
		expect((await examples()).items[0][0]).toBe(aid(1));
		expect(ids({ json: await examples("?filter=negative") })).toEqual([aid(4), aid(5)]);
		expect(await conflicts()).not.toContain(aid(5)); // 认不出来的狗改成反例：不再矛盾
		expect(await conflicts()).not.toContain(aid(1));
		await call(env, "POST", `/smart-sets/${id}/refresh`);
		expect(await suggestions()).toEqual([aid(7)]);

		const list = (await call(env, "GET", "/smart-sets")).json.items;
		expect(list).toEqual([expect.objectContaining({ id, name: "猫", positives: 3, negatives: 2, matches: 1, cover: `${aid(2)}:0`, dirty: false })]);

		// 结果可以去掉已经在某个相册里的
		await env.DB.batch([
			env.DB.prepare("INSERT INTO albums (id, name, created_at, updated_at) VALUES (?, 'a', 0, 0)").bind(aid(90)),
			env.DB.prepare("INSERT INTO album_assets (album_id, asset_id, added_at) VALUES (?, ?, 0), (?, ?, 0)").bind(aid(90), aid(1), aid(90), aid(7)),
		]);
		expect(await results()).toEqual([aid(1), aid(2), aid(3), aid(7)]);
		expect(await results(`?notInAlbum=${aid(90)}`)).toEqual([aid(2), aid(3)]);
		await env.DB.prepare("DELETE FROM albums WHERE id = ?").bind(aid(90)).run();

		// 移出样本
		await call(env, "POST", `/smart-sets/${id}/examples`, { ids: [aid(3)], label: 0 });
		expect(ids({ json: await examples("?filter=positive") })).toEqual([aid(1), aid(2)]);

		expect((await call(env, "PATCH", `/smart-sets/${id}`, { name: "小猫" })).status).toBe(200);
		expect((await call(env, "PATCH", `/smart-sets/${aid(99)}`, { name: "小猫" })).status).toBe(404);
		expect((await call(env, "DELETE", `/smart-sets/${id}`)).status).toBe(200);
		expect((await call(env, "GET", "/smart-sets")).json.items).toEqual([]);
		expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM smart_set_examples").first("n")).toBe(0);
	});

	it("limits suggestions and results to the chosen folders (including subfolders)", async () => {
		const cat = randomVec();
		const F = (n: number) => `FOLD${String(n).padStart(22, "0")}`;
		await env.DB.batch([
			env.DB.prepare("INSERT INTO folders (id, parent_id, name, created_at) VALUES (?, NULL, 'trip', 0)").bind(F(1)),
			env.DB.prepare("INSERT INTO folders (id, parent_id, name, created_at) VALUES (?, ?, 'day1', 0)").bind(F(2), F(1)),
			env.DB.prepare("INSERT INTO folders (id, parent_id, name, created_at) VALUES (?, NULL, 'other', 0)").bind(F(3)),
		]);
		for (let i = 1; i <= 40; i++) await seed_(i);
		// 1–2 正例（1 在范围外），3 在 trip，4 在 trip/day1，5 在 other，6 在根目录：都是猫
		const where: Record<number, string> = { 2: F(1), 3: F(1), 4: F(2), 5: F(3), 7: F(1) };
		for (const [n, f] of Object.entries(where)) await env.DB.prepare("UPDATE assets SET folder_id = ? WHERE id = ?").bind(f, aid(Number(n))).run();
		const vecs: Record<number, Int8Array> = { 1: near(cat), 2: near(cat), 3: near(cat), 4: near(cat), 5: near(cat), 6: near(cat) };
		for (let i = 9; i <= 40; i++) vecs[i] = randomVec();
		for (const [n, v] of Object.entries(vecs)) await saveFingerprint(env, aid(Number(n)), fp(randomHash(), v));

		const id = (await call(env, "POST", "/smart-sets", { name: "猫", ids: [aid(1), aid(2)] })).json.id;
		const ids = (r: { json: { items: unknown[][] } }) => r.json.items.map((i) => i[0] as string).sort();
		const suggestions = async () => ids(await call(env, "GET", `/smart-sets/${id}/suggestions`));
		const results = async () => ids(await call(env, "GET", `/smart-sets/${id}/assets`));
		expect(await suggestions()).toEqual([aid(3), aid(4), aid(5), aid(6)]);

		const patched = await call(env, "PATCH", `/smart-sets/${id}`, { folders: [F(1), aid(99)] });
		expect(patched.json).toEqual({ ok: true, suggestions: 2 }); // 不存在的文件夹丢掉，改范围立即更新
		expect(await suggestions()).toEqual([aid(3), aid(4)]);
		expect(await results()).toEqual([aid(2), aid(3), aid(4)]); // 范围外的正例 1 照样用来训练，但不在结果里
		expect((await call(env, "GET", `/smart-sets/${id}`)).json).toMatchObject({
			dirty: false,
			scoped: true,
			positives: 2,
			in_scope: 1,
			folders: [{ id: F(1), name: "trip" }],
			suggestions: { loose: 2 },
		});
		expect((await call(env, "GET", "/smart-sets")).json.items).toEqual([
			expect.objectContaining({ id, scoped: true, positives: 2, in_scope: 1, matches: 2 }),
		]);

		// 新照片：只有范围里的才打分
		await saveFingerprint(env, aid(7), fp(randomHash(), near(cat)));
		await saveFingerprint(env, aid(8), fp(randomHash(), near(cat)));
		expect(await suggestions()).toEqual([aid(3), aid(4), aid(7)]);

		// 移出范围的照片在下次更新前也不显示
		await env.DB.prepare("UPDATE assets SET folder_id = ? WHERE id = ?").bind(F(3), aid(4)).run();
		expect(await suggestions()).toEqual([aid(3), aid(7)]);

		// 改名不动范围；清空范围回到整个资料库
		expect((await call(env, "PATCH", `/smart-sets/${id}`, { name: "小猫" })).json).toEqual({ ok: true });
		expect((await call(env, "GET", `/smart-sets/${id}`)).json).toMatchObject({ name: "小猫", scoped: true });
		expect((await call(env, "PATCH", `/smart-sets/${id}`, { folders: [aid(99)] })).status).toBe(404);
		expect((await call(env, "PATCH", `/smart-sets/${id}`, { folders: null })).json.suggestions).toBe(6);
		expect((await call(env, "GET", `/smart-sets/${id}`)).json).toMatchObject({ scoped: false, folders: null, in_scope: 2 });
		await env.DB.batch([
			env.DB.prepare("UPDATE assets SET folder_id = NULL"),
			env.DB.prepare("DELETE FROM folders WHERE parent_id IS NOT NULL"),
			env.DB.prepare("DELETE FROM folders"),
		]);
	});

	it("cross-validates once there are enough samples of both kinds", async () => {
		const cat = randomVec();
		const dog = randomVec();
		const n = SMART_SET_CV_MIN;
		for (let i = 1; i <= 2 * n + 30; i++) await seed_(i);
		for (let i = 1; i <= n; i++) await saveFingerprint(env, aid(i), fp(randomHash(), near(cat)));
		for (let i = n + 1; i <= 2 * n; i++) await saveFingerprint(env, aid(i), fp(randomHash(), near(dog)));
		for (let i = 2 * n + 1; i <= 2 * n + 30; i++) await saveFingerprint(env, aid(i), fp(randomHash(), randomVec()));
		const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => aid(a + i));
		const id = (await call(env, "POST", "/smart-sets", { name: "猫", ids: range(1, n) })).json.id;
		await call(env, "POST", `/smart-sets/${id}/examples`, { ids: range(n + 1, 2 * n), label: -1 });
		await call(env, "POST", `/smart-sets/${id}/refresh`);
		const detail = (await call(env, "GET", `/smart-sets/${id}`)).json;
		expect(detail.metrics).toMatchObject({ positives: n, negatives: n });
		expect(detail.metrics.cv.recall.normal).toBe(1);
		expect(detail.metrics.cv.rejection.normal).toBe(1);
		expect(detail.conflicts).toBe(0);
		// 每张样本都有分数（没见过它的模型打的）
		expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM smart_set_examples WHERE set_id = ? AND score IS NULL").bind(id).first("n")).toBe(0);
		// 交叉验证要训练 6 次，CI 的机器上整个用例要 5 秒多
	}, 30_000);

	it("computes cross-validated metrics per sensitivity level", () => {
		expect(crossValidate([], [], [])).toBeNull();
		expect(metricsOf(3, 1, null)).toEqual({ positives: 3, negatives: 1, cv: null });
		const m = metricsOf(4, 2, { pos: [0.9, 0.6, 0.4, 0.1], neg: [0.2, 0.75] });
		expect(m.cv!.recall).toEqual({ strict: 0.25, normal: 0.5, loose: 0.75 });
		expect(m.cv!.rejection).toEqual({ strict: 1, normal: 0.5, loose: 0.5 });
	});

	it("refreshes changed sets from the hourly cron once labels settle", async () => {
		const cat = randomVec();
		for (let i = 1; i <= 20; i++) await seed_(i);
		const vecs: Record<number, Int8Array> = { 1: near(cat), 2: near(cat), 3: near(cat), 4: near(cat) };
		for (let i = 5; i <= 20; i++) vecs[i] = randomVec();
		for (const [n, v] of Object.entries(vecs)) await saveFingerprint(env, aid(Number(n)), fp(randomHash(), v));
		const id = (await call(env, "POST", "/smart-sets", { name: "猫", ids: [aid(1), aid(2)] })).json.id;
		const suggestions = async () =>
			(await call(env, "GET", `/smart-sets/${id}/suggestions`)).json.items.map((i: unknown[]) => i[0]).sort();
		// 把“上次训练 → 改标记”整体挪到 ms 之前
		const setLabelsAge = (ms: number) =>
			env.DB.prepare("UPDATE smart_sets SET labels_changed_at = ?1, trained_at = ?1 - 1 WHERE id = ?2").bind(Date.now() - ms, id).run();

		// 刚创建已经训练过：不重跑
		expect(await refreshStaleSmartSets(env)).toBe(0);

		await call(env, "POST", `/smart-sets/${id}/examples`, { ids: [aid(3)], label: 1 });
		expect(await suggestions()).toEqual([aid(4)]);
		// 还在标记：先不动
		expect(await refreshStaleSmartSets(env)).toBe(0);
		expect((await call(env, "GET", `/smart-sets/${id}`)).json.dirty).toBe(true);

		// 熔断时跳过
		await setLabelsAge(SMART_SET_CRON_QUIET_MS + 1000);
		await guardStub(env).trip("test");
		expect(await refreshStaleSmartSets(env)).toBe(0);
		await guardStub(env).reset();

		// 正在手动更新时跳过
		await env.DB.prepare("UPDATE smart_sets SET refreshing_until = ? WHERE id = ?").bind(Date.now() + 60_000, id).run();
		expect(await refreshStaleSmartSets(env)).toBe(0);
		await env.DB.prepare("UPDATE smart_sets SET refreshing_until = NULL WHERE id = ?").bind(id).run();

		expect(await refreshStaleSmartSets(env)).toBe(1);
		expect((await call(env, "GET", `/smart-sets/${id}`)).json.dirty).toBe(false);
		expect(await suggestions()).toEqual([aid(4)]);
		expect(await refreshStaleSmartSets(env)).toBe(0);

		// 没有正例：不跑
		await call(env, "POST", `/smart-sets/${id}/examples`, { ids: [aid(1), aid(2), aid(3)], label: -1 });
		await setLabelsAge(SMART_SET_CRON_QUIET_MS + 1000);
		expect(await refreshStaleSmartSets(env)).toBe(0);
	});

	it("is mounted behind auth and validates input", async () => {
		const post = async (path: string, body: unknown) =>
			(
				await SELF.fetch(`http://example.com/api${path}`, {
					method: "POST",
					headers: await authHeaders({ Origin: "http://example.com", "X-Requested-With": "nana", "Content-Type": "application/json" }),
					body: JSON.stringify(body),
				})
			).status;
		expect(await post("/smart-sets", { name: "", ids: [aid(1)] })).toBe(400);
		expect(await post("/smart-sets", { name: "x", ids: [] })).toBe(400);
		expect(await post(`/smart-sets/${aid(99)}/examples`, { ids: [aid(1)], label: 1 })).toBe(404);
		expect(await post("/duplicates/ignore", { ids: [aid(1)] })).toBe(400);
		expect(await post("/duplicates/ignore", { ids: [aid(1), aid(2)], pivot: aid(3) })).toBe(400);
		expect((await SELF.fetch("http://example.com/api/duplicates")).status).toBe(403); // 没有身份
	});
});
