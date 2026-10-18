import { SELF, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FACE_DIMS, FACE_MODEL_VER } from "@nana/shared";
import { guardStub } from "../src/guard";
import {
	FACE_DEFER_MS,
	FACE_STATE,
	parseFaceScan,
	people,
	recognizeFace,
	recognizePendingFaces,
	saveFaces,
	spriteVersion,
} from "../src/people";
import type { FaceScan } from "../src/processor";
import { library } from "../src/library";
import { deleteAssetsPermanently } from "../src/purge";
import { FakeIndex } from "./fake-index";
import { authHeaders, mockAccessJwks } from "./helpers";

beforeAll(() => mockAccessJwks());

let index: FakeIndex;
const withIndex = () => ({ ...env, FACE_INDEX: index as unknown as VectorizeIndex }) as Env;

let seed = 7;
const rand = () => {
	seed = (seed * 1103515245 + 12345) & 0x7fffffff;
	return seed / 0x7fffffff;
};
const randomVec = () => Int8Array.from({ length: FACE_DIMS }, () => Math.round((rand() * 2 - 1) * 127));
const near = (base: Int8Array, noise = 30) =>
	Int8Array.from(base, (x) => Math.max(-127, Math.min(127, x + Math.round((rand() * 2 - 1) * noise))));
const toB64 = (v: Uint8Array | Int8Array) => btoa(String.fromCharCode(...new Uint8Array(v.buffer, v.byteOffset, v.byteLength)));

type Face = FaceScan["faces"][number];
const face = (v: Int8Array, extra: Partial<Face> = {}): Face => ({
	x: 0.4,
	y: 0.3,
	w: 0.1,
	h: 0.15,
	px: 120,
	score: 0.9,
	sharpness: 150,
	embedding: toB64(v),
	...extra,
});
const SPRITE = toB64(new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]));
const scan = (...faces: Face[]): FaceScan => ({ model: FACE_MODEL_VER, faces, sprite: faces.length ? SPRITE : null });

const aid = (n: number) => `PPL${String(n).padStart(23, "0")}`;
async function seedAsset(n: number, extra: { deleted?: boolean; kind?: string } = {}) {
	await env.DB.batch([
		env.DB.prepare(
			`INSERT INTO assets (id, kind, status, local_month, local_day, taken_at, width, height, deleted_at, created_at, updated_at)
			 VALUES (?, ?, 'ready', '2024-05', '2024-05-01', ?, 4000, 3000, ?, ?, 0)`,
		).bind(aid(n), extra.kind ?? "photo", 1714500000000 + n, extra.deleted ? Date.now() : null, n),
		env.DB.prepare(
			"INSERT INTO asset_files (id, asset_id, role, r2_key, mime, size, sha256, created_at) VALUES (?, ?, 'original', ?, 'image/jpeg', 100, ?, 0)",
		).bind(`PF${n}`, aid(n), `o/${aid(n)}/PF${n}`, String(n).padStart(64, "0")),
	]);
}

const facesOf = async (assetId: string) =>
	(
		await env.DB.prepare("SELECT id, idx, person_id, assigned, state, indexed FROM faces WHERE asset_id = ? ORDER BY idx")
			.bind(assetId)
			.all<{ id: string; idx: number; person_id: string | null; assigned: number; state: number; indexed: number }>()
	).results;
const personOf = async (assetId: string) => (await facesOf(assetId))[0]?.person_id ?? null;

async function call<T = any>(e: Env, method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
	const res = await people.request(
		path,
		{ method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined },
		e,
	);
	return { status: res.status, json: (await res.json()) as T };
}

beforeEach(async () => {
	index = new FakeIndex();
	await guardStub(env).reset();
	await env.DB.batch([
		env.DB.prepare("DELETE FROM face_rejects"),
		env.DB.prepare("DELETE FROM faces"),
		env.DB.prepare("DELETE FROM face_scans"),
		env.DB.prepare("DELETE FROM people"),
		env.DB.prepare("DELETE FROM jobs"),
		env.DB.prepare("DELETE FROM asset_files"),
		env.DB.prepare("DELETE FROM assets"),
	]);
});

describe("parseFaceScan", () => {
	it("accepts a valid scan and drops individual bad faces but keeps their slot", () => {
		const v = randomVec();
		const p = parseFaceScan(scan(face(v), face(v, { embedding: "bad!" }), face(v, { x: 2 })));
		expect(p!.faces.map((f) => f !== null)).toEqual([true, false, false]);
		expect(p!.sprite!.length).toBe(8);
	});
	it("rejects wrong model, missing sprite, or wrong dimension", () => {
		const v = randomVec();
		expect(parseFaceScan({ ...scan(face(v)), model: "other" })).toBeNull();
		expect(parseFaceScan({ ...scan(face(v)), sprite: null })).toBeNull();
		expect(parseFaceScan(scan(face(v, { embedding: toB64(new Int8Array(10).fill(1)) })))!.faces[0]).toBeNull();
		expect(parseFaceScan(null)).toBeNull();
		expect(parseFaceScan(scan())).toEqual({ faces: [], sprite: null });
	});
	it("reads the sprite version from its key", () => {
		expect(spriteVersion(`d/${aid(1)}/faces-3.webp`)).toBe(3);
		expect(spriteVersion(null)).toBeNull();
	});
});

describe("saveFaces", () => {
	it("writes the sprite, faces and scan; small or uncertain faces do not take part in recognition", async () => {
		await seedAsset(1);
		const v = randomVec();
		expect(await saveFaces(withIndex(), aid(1), scan(face(v), face(randomVec(), { px: 10 }), face(randomVec(), { score: 0.55 })), 2)).toBe(true);
		const rows = await facesOf(aid(1));
		expect(rows.map((r) => r.state)).toEqual([FACE_STATE.deferred, FACE_STATE.ignored, FACE_STATE.ignored]);
		expect(rows.map((r) => r.indexed)).toEqual([1, 0, 0]);
		expect([...index.vectors.keys()]).toEqual([rows[0]!.id]);
		const s = await env.DB.prepare("SELECT model, count, sprite_key FROM face_scans WHERE asset_id = ?").bind(aid(1)).first();
		expect(s).toEqual({ model: FACE_MODEL_VER, count: 3, sprite_key: `d/${aid(1)}/faces-2.webp` });
		expect(await env.PHOTOS.get(`d/${aid(1)}/faces-2.webp`)).not.toBeNull();
	});

	it("keeps an existing scan of the same model (user corrections survive reprocessing)", async () => {
		await seedAsset(1);
		await saveFaces(withIndex(), aid(1), scan(face(randomVec())), 0);
		const before = await facesOf(aid(1));
		expect(await saveFaces(withIndex(), aid(1), scan(face(randomVec()), face(randomVec())), 1)).toBe(true);
		expect(await facesOf(aid(1))).toEqual(before);
	});

	it("records photos without faces, and ignores invalid scans", async () => {
		await seedAsset(1);
		await seedAsset(2);
		expect(await saveFaces(withIndex(), aid(1), scan(), 0)).toBe(true);
		expect(await env.DB.prepare("SELECT count, sprite_key FROM face_scans WHERE asset_id = ?").bind(aid(1)).first()).toEqual({
			count: 0,
			sprite_key: null,
		});
		expect(await saveFaces(withIndex(), aid(2), { ...scan(face(randomVec())), model: "old" }, 0)).toBe(false);
		expect(await env.DB.prepare("SELECT 1 FROM face_scans WHERE asset_id = ?").bind(aid(2)).first()).toBeNull();
	});

	it("still records faces without Vectorize (local dev); they wait for the cron", async () => {
		await seedAsset(1);
		await saveFaces(env, aid(1), scan(face(randomVec())), 0);
		expect((await facesOf(aid(1)))[0]).toMatchObject({ state: FACE_STATE.pending, indexed: 0, person_id: null });
	});
});

describe("recognition", () => {
	it("groups faces of the same person once there are enough of them, then adds new ones", async () => {
		const alice = randomVec();
		for (let i = 1; i <= 5; i++) await seedAsset(i);
		await saveFaces(withIndex(), aid(1), scan(face(near(alice))), 0);
		await saveFaces(withIndex(), aid(2), scan(face(near(alice))), 0);
		// 前两张附近的脸不够（核心至少 3 张），先推迟
		expect((await facesOf(aid(1)))[0]!.state).toBe(FACE_STATE.deferred);
		expect(await personOf(aid(2))).toBeNull();
		// 第三张是核心：新建人物，把前两张一起归进来
		await saveFaces(withIndex(), aid(3), scan(face(near(alice))), 0);
		const p = await personOf(aid(3));
		expect(p).not.toBeNull();
		expect(await personOf(aid(1))).toBe(p);
		expect(await personOf(aid(2))).toBe(p);
		expect((await facesOf(aid(1)))[0]).toMatchObject({ state: FACE_STATE.done, assigned: 1 });
		// 之后的照片直接归入
		await saveFaces(withIndex(), aid(4), scan(face(near(alice))), 0);
		expect(await personOf(aid(4))).toBe(p);
		// 别人不归入
		await saveFaces(withIndex(), aid(5), scan(face(randomVec())), 0);
		expect(await personOf(aid(5))).toBeNull();
		expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM people").first<{ n: number }>())!.n).toBe(1);
	});

	it("handles several people in one photo", async () => {
		const [a, b] = [randomVec(), randomVec()];
		for (let i = 1; i <= 3; i++) {
			await seedAsset(i);
			await saveFaces(withIndex(), aid(i), scan(face(near(a)), face(near(b))), 0);
		}
		const rows = await facesOf(aid(3));
		expect(rows[0]!.person_id).not.toBeNull();
		expect(rows[1]!.person_id).not.toBeNull();
		expect(rows[0]!.person_id).not.toBe(rows[1]!.person_id);
		expect((await facesOf(aid(1)))[1]!.person_id).toBe(rows[1]!.person_id);
	});

	it("the cron finishes deferred faces after a while, indexes missed vectors and recognizes pending ones", async () => {
		await seedAsset(1);
		await seedAsset(2);
		await saveFaces(withIndex(), aid(1), scan(face(randomVec())), 0);
		await saveFaces(env, aid(2), scan(face(randomVec())), 0); // 当时没有 Vectorize
		const r = await recognizePendingFaces(withIndex(), Date.now() + FACE_DEFER_MS + 1000);
		expect(r).toEqual({ indexed: 1, recognized: 2 });
		expect((await facesOf(aid(1)))[0]!.state).toBe(FACE_STATE.done);
		expect((await facesOf(aid(2)))[0]).toMatchObject({ indexed: 1, state: FACE_STATE.deferred });
		// 推迟的还没到时间：不处理
		expect((await recognizePendingFaces(withIndex())).recognized).toBe(0);
	});

	it("the cron does nothing while the guard is tripped", async () => {
		await seedAsset(1);
		await saveFaces(env, aid(1), scan(face(randomVec())), 0);
		await guardStub(env).trip("test");
		expect(await recognizePendingFaces(withIndex())).toEqual({ indexed: 0, recognized: 0 });
		expect(index.queries).toBe(0);
	});

	it("never puts a face back into a person the user said it is not", async () => {
		const a = randomVec();
		for (let i = 1; i <= 4; i++) await seedAsset(i);
		for (let i = 1; i <= 3; i++) await saveFaces(withIndex(), aid(i), scan(face(near(a))), 0);
		const p = (await personOf(aid(1)))!;
		const { status } = await call(withIndex(), "POST", `/people/${p}/remove`, { assetIds: [aid(1)] });
		expect(status).toBe(200);
		// 当场重新识别：附近只有否认过的人物，不算核心，推迟（不会自己成一个新人物）
		expect((await facesOf(aid(1)))[0]).toMatchObject({ person_id: null, assigned: 0, state: FACE_STATE.deferred });
		// 再识别一次（比如 Cron）也不会归回来
		expect(await recognizeFace(withIndex(), (await facesOf(aid(1)))[0]!.id, true)).toBe("none");
		expect(await personOf(aid(1))).toBeNull();
		expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM people").first<{ n: number }>())!.n).toBe(1);
		// 新的脸核心扩展时也不会把它带回来
		await saveFaces(withIndex(), aid(4), scan(face(near(a))), 0);
		expect(await personOf(aid(4))).toBe(p);
		expect(await personOf(aid(1))).toBeNull();
	});

	it("re-recognizes faces removed from the wrong person, so they land in the right one", async () => {
		const [a, b] = [randomVec(), randomVec()];
		for (let i = 1; i <= 9; i++) await seedAsset(i);
		for (let i = 1; i <= 4; i++) await saveFaces(withIndex(), aid(i), scan(face(near(a))), 0);
		for (let i = 5; i <= 7; i++) await saveFaces(withIndex(), aid(i), scan(face(near(b))), 0);
		const [pa, pb] = [(await personOf(aid(1)))!, (await personOf(aid(5)))!];
		// 两张其实是 A 的脸被认成了 B
		await saveFaces(withIndex(), aid(8), scan(face(near(a))), 0);
		await saveFaces(withIndex(), aid(9), scan(face(near(a))), 0);
		await env.DB.prepare("UPDATE faces SET person_id = ? WHERE asset_id IN (?, ?)").bind(pb, aid(8), aid(9)).run();

		expect((await call(withIndex(), "POST", `/people/${pb}/remove`, { assetIds: [aid(8)] })).json).toEqual({ removed: 1 });
		expect((await facesOf(aid(8)))[0]).toMatchObject({ person_id: pa, assigned: 1, state: FACE_STATE.done });
		// 查看器里的“这不是 B”同样重新识别
		const f9 = (await facesOf(aid(9)))[0]!.id;
		expect((await call(withIndex(), "POST", `/faces/${f9}/reject`, { personId: pb })).status).toBe(200);
		expect(await personOf(aid(9))).toBe(pa);
		expect(await personOf(aid(5))).toBe(pb);
	});

	it("leaves removed faces pending for the cron while the guard is tripped", async () => {
		const a = randomVec();
		for (let i = 1; i <= 3; i++) {
			await seedAsset(i);
			await saveFaces(withIndex(), aid(i), scan(face(near(a))), 0);
		}
		const p = (await personOf(aid(1)))!;
		await guardStub(env).trip("test");
		const before = index.queries;
		await call(withIndex(), "POST", `/people/${p}/remove`, { assetIds: [aid(1)] });
		expect(index.queries).toBe(before);
		expect((await facesOf(aid(1)))[0]).toMatchObject({ person_id: null, assigned: 0, state: FACE_STATE.pending });
	});

	it("votes among nearby faces instead of following the single closest one", async () => {
		const a = randomVec();
		const twin = near(a, 10);
		for (let i = 1; i <= 6; i++) await seedAsset(i);
		for (let i = 1; i <= 4; i++) await saveFaces(withIndex(), aid(i), scan(face(near(a))), 0);
		const pa = (await personOf(aid(1)))!;
		// 一张几乎一样的脸被手动指定成了另一个人
		await saveFaces(withIndex(), aid(5), scan(face(twin)), 0);
		const other = "PERSON0000000000000000OTHR";
		await env.DB.batch([
			env.DB.prepare("INSERT INTO people (id, name, created_at, updated_at) VALUES (?, 'Other', 0, 0)").bind(other),
			env.DB.prepare("UPDATE faces SET person_id = ?, assigned = 2 WHERE asset_id = ?").bind(other, aid(5)),
		]);
		await saveFaces(withIndex(), aid(6), scan(face(twin)), 0);
		expect(await personOf(aid(6))).toBe(pa);
	});
});

describe("people API", () => {
	async function twoPeople() {
		const [a, b] = [randomVec(), randomVec()];
		for (let i = 1; i <= 6; i++) await seedAsset(i);
		for (let i = 1; i <= 3; i++) await saveFaces(withIndex(), aid(i), scan(face(near(a))), 0);
		for (let i = 4; i <= 6; i++) await saveFaces(withIndex(), aid(i), scan(face(near(b))), 0);
		return { a: (await personOf(aid(1)))!, b: (await personOf(aid(4)))!, va: a, vb: b };
	}

	it("lists people with covers, names, merges and hides them", async () => {
		const { a, b } = await twoPeople();
		let list = await call(withIndex(), "GET", "/people");
		expect(list.json.items).toHaveLength(2);
		expect(list.json.items[0]).toMatchObject({ name: null, count: 3, cover: { idx: 0, count: 1, v: 0, rotation: 0 } });

		expect((await call(withIndex(), "PATCH", `/people/${a}`, { name: "Alice" })).json).toMatchObject({ name: "Alice", count: 3 });
		const taken = await call(withIndex(), "PATCH", `/people/${b}`, { name: "Alice" });
		expect(taken).toEqual({ status: 409, json: { error: "name taken", personId: a } });
		list = await call(withIndex(), "GET", "/people");
		expect(list.json.items.map((p: { name: string | null }) => p.name)).toEqual(["Alice", null]);

		expect((await call(withIndex(), "POST", `/people/${a}/merge`, { ids: [b] })).json).toEqual({ merged: 1 });
		expect((await call(withIndex(), "GET", `/people/${a}`)).json).toMatchObject({ name: "Alice", count: 6 });
		expect((await call(withIndex(), "GET", `/people/${b}`)).status).toBe(404);
		const assets = await call(withIndex(), "GET", `/people/${a}/assets`);
		expect(assets.json.items).toHaveLength(6);

		await call(withIndex(), "PATCH", `/people/${a}`, { hidden: true });
		list = await call(withIndex(), "GET", "/people");
		expect(list.json).toMatchObject({ items: [], hidden: 1 });
		expect((await call(withIndex(), "GET", "/people?hidden=1")).json.items).toHaveLength(1);
	});

	it("sets the cover by face or by photo, and falls back when cleared", async () => {
		const { a, b } = await twoPeople();
		const f2 = (await facesOf(aid(2)))[0]!.id;
		expect((await call(withIndex(), "PATCH", `/people/${a}`, { coverFaceId: f2 })).json.cover).toMatchObject({ id: f2, assetId: aid(2) });
		const r = await call(withIndex(), "PATCH", `/people/${a}`, { coverAssetId: aid(3) });
		expect(r.json.cover.assetId).toBe(aid(3));
		// 别人的照片 / 别人的脸不行
		expect(await call(withIndex(), "PATCH", `/people/${a}`, { coverAssetId: aid(4) })).toEqual({ status: 400, json: { error: "face not in person" } });
		const fb = (await facesOf(aid(4)))[0]!.id;
		expect((await call(withIndex(), "PATCH", `/people/${a}`, { coverFaceId: fb })).status).toBe(400);
		expect((await call(withIndex(), "GET", "/people")).json.items.find((p: { id: string }) => p.id === a).cover.assetId).toBe(aid(3));
		expect((await call(withIndex(), "PATCH", `/people/${a}`, { coverFaceId: null })).json.cover).not.toBeNull();
		void b;
	});

	it("does not list unnamed people with too few photos, or photos in the trash", async () => {
		const { a } = await twoPeople();
		await env.DB.prepare("UPDATE assets SET deleted_at = 1 WHERE id = ?").bind(aid(1)).run();
		const list = await call(withIndex(), "GET", "/people");
		expect(list.json.items.map((p: { id: string }) => p.id)).not.toContain(a);
		await call(withIndex(), "PATCH", `/people/${a}`, { name: "Alice" });
		expect((await call(withIndex(), "GET", "/people")).json.items[0]).toMatchObject({ id: a, count: 2 });
	});

	it("lists the people in one folder only (not subfolders), counting photos in that folder", async () => {
		const { a, b } = await twoPeople();
		const [top, sub] = ["FOLDERPPL00000000000000TOP", "FOLDERPPL00000000000000SUB"];
		await env.DB.batch([
			env.DB.prepare("INSERT OR IGNORE INTO folders (id, parent_id, name, created_at) VALUES (?, NULL, 'top', 0)").bind(top),
			env.DB.prepare("INSERT OR IGNORE INTO folders (id, parent_id, name, created_at) VALUES (?, ?, 'sub', 0)").bind(sub, top),
			env.DB.prepare("UPDATE assets SET folder_id = ? WHERE id IN (?, ?)").bind(top, aid(1), aid(2)),
			env.DB.prepare("UPDATE assets SET folder_id = ? WHERE id = ?").bind(sub, aid(4)),
		]);
		const inTop = await call(withIndex(), "GET", `/folders/${top}/people`);
		expect(inTop.json.items).toEqual([expect.objectContaining({ id: a, count: 2, cover: expect.objectContaining({ idx: 0 }) })]);
		expect((await call(withIndex(), "GET", `/folders/${sub}/people`)).json.items).toMatchObject([{ id: b, count: 1 }]);
		// 根目录：没有文件夹的照片
		expect((await call(withIndex(), "GET", "/folders/root/people")).json.items).toMatchObject([
			{ id: b, count: 2 },
			{ id: a, count: 1 },
		]);
		// 回收站里的照片不算，隐藏的人物不列
		await env.DB.prepare("UPDATE assets SET deleted_at = 1 WHERE id = ?").bind(aid(4)).run();
		expect((await call(withIndex(), "GET", `/folders/${sub}/people`)).json.items).toEqual([]);
		await call(withIndex(), "PATCH", `/people/${a}`, { hidden: true });
		expect((await call(withIndex(), "GET", `/folders/${top}/people`)).json.items).toEqual([]);
		await env.DB.prepare("UPDATE assets SET folder_id = NULL").run();
		await env.DB.batch([sub, top].map((id) => env.DB.prepare("DELETE FROM folders WHERE id = ?").bind(id)));
	});

	it("filters a folder's photos by person, and drops photos removed from that person", async () => {
		const { a, b } = await twoPeople();
		const top = "FOLDERPPL00000000000000TOP";
		await env.DB.batch([
			env.DB.prepare("INSERT OR IGNORE INTO folders (id, parent_id, name, created_at) VALUES (?, NULL, 'top', 0)").bind(top),
			env.DB.prepare("UPDATE assets SET folder_id = ? WHERE id IN (?, ?, ?)").bind(top, aid(1), aid(4), aid(5)),
		]);
		const ids = async (person: string) => {
			const res = await library.request(`/folders/${top}/people/${person}/assets`, {}, withIndex());
			return ((await res.json()) as { items: string[][] }).items.map((it) => it[0]).sort();
		};
		expect(await ids(a)).toEqual([aid(1)]);
		expect(await ids(b)).toEqual([aid(4), aid(5)].sort());
		await call(withIndex(), "POST", `/people/${b}/remove`, { assetIds: [aid(4)] });
		expect(await ids(b)).toEqual([aid(5)]);
		await env.DB.prepare("UPDATE assets SET folder_id = NULL").run();
		await env.DB.prepare("DELETE FROM folders WHERE id = ?").bind(top).run();
	});

	it("assigns a face by name, rejects, and shows the faces of a photo", async () => {
		const { a } = await twoPeople();
		await seedAsset(7);
		await saveFaces(withIndex(), aid(7), scan(face(randomVec())), 0);
		const fid = (await facesOf(aid(7)))[0]!.id;

		let faces = await call(withIndex(), "GET", `/assets/${aid(7)}/faces`);
		expect(faces.json).toMatchObject({ scanned: true, items: [{ id: fid, person: null, recognizable: true, box: { x: 0.4 } }] });

		const r = await call(withIndex(), "POST", `/faces/${fid}/assign`, { name: "Bob" });
		const bob = r.json.personId;
		expect((await facesOf(aid(7)))[0]).toMatchObject({ person_id: bob, assigned: 2 });
		faces = await call(withIndex(), "GET", `/assets/${aid(7)}/faces`);
		expect(faces.json.items[0].person).toEqual({ id: bob, name: "Bob", hidden: false });
		// 同名的再指定一次：用已有的人物，不新建
		await seedAsset(8);
		await saveFaces(withIndex(), aid(8), scan(face(randomVec())), 0);
		const fid8 = (await facesOf(aid(8)))[0]!.id;
		expect((await call(withIndex(), "POST", `/faces/${fid8}/assign`, { name: "Bob" })).json.personId).toBe(bob);

		expect((await call(withIndex(), "POST", `/faces/${fid}/reject`, { personId: bob })).status).toBe(200);
		expect((await facesOf(aid(7)))[0]).toMatchObject({ person_id: null, assigned: 0 });
		expect((await call(withIndex(), "POST", `/faces/${fid}/assign`, { personId: a })).json.personId).toBe(a);
		expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM face_rejects").first()).toEqual({ n: 1 });

		expect((await call(withIndex(), "GET", `/assets/${aid(99)}/faces`)).json).toEqual({ scanned: false, items: [] });
	});

	it("reassigns the faces of selected photos to another person, by id or by name", async () => {
		const { a, b } = await twoPeople();
		let r = await call(withIndex(), "POST", `/people/${a}/reassign`, { assetIds: [aid(1), aid(4)], personId: b });
		expect(r.json).toEqual({ personId: b, moved: 1 }); // aid(4) 本来就是 b，不算
		expect((await facesOf(aid(1)))[0]).toMatchObject({ person_id: b, assigned: 2 });
		expect(await env.DB.prepare("SELECT person_id FROM face_rejects WHERE face_id = ?").bind((await facesOf(aid(1)))[0]!.id).first()).toEqual({ person_id: a });

		r = await call(withIndex(), "POST", `/people/${a}/reassign`, { assetIds: [aid(2)], name: "Carol" });
		const carol = r.json.personId;
		expect(r.json.moved).toBe(1);
		expect((await call(withIndex(), "GET", `/people/${carol}`)).json).toMatchObject({ name: "Carol", count: 1 });
		// 同名的再来一次：用已有的
		expect((await call(withIndex(), "POST", `/people/${a}/reassign`, { assetIds: [aid(3)], name: "Carol" })).json.personId).toBe(carol);
		expect((await call(withIndex(), "POST", `/people/${a}/reassign`, { assetIds: [aid(3)], personId: aid(99) })).status).toBe(404);
	});

	it("review suggests similar unassigned faces, excluding rejected ones", async () => {
		const { a, va } = await twoPeople();
		await seedAsset(7);
		await seedAsset(8);
		// 手动移出、不再自动归入的脸，以及一张被否认的脸
		await saveFaces(env, aid(7), scan(face(near(va, 60))), 0);
		await saveFaces(env, aid(8), scan(face(near(va, 60))), 0);
		const f7 = (await facesOf(aid(7)))[0]!.id;
		const f8 = (await facesOf(aid(8)))[0]!.id;
		await env.DB.prepare("UPDATE faces SET indexed = 1, state = 2 WHERE asset_id IN (?, ?)").bind(aid(7), aid(8)).run();
		await index.upsert([
			{ id: f7, values: Array.from(near(va, 60)) },
			{ id: f8, values: Array.from(near(va, 60)) },
		]);
		await call(withIndex(), "POST", `/faces/${f8}/reject`, { personId: a });
		const review = await call(withIndex(), "GET", `/people/${a}/review`);
		expect(review.json.items.map((i: { id: string }) => i.id)).toEqual([f7]);
		expect((await call(env, "GET", `/people/${a}/review`)).json).toEqual({ items: [], unavailable: true });
	});

	it("is behind authentication like every other route", async () => {
		expect((await SELF.fetch("http://example.com/api/people")).status).toBe(403);
		expect((await SELF.fetch("http://example.com/api/people", { headers: await authHeaders() })).status).toBe(200);
	});
});

describe("face files and deletion", () => {
	it("serves the sprite only by version, privately", async () => {
		await seedAsset(1);
		await saveFaces(withIndex(), aid(1), scan(face(randomVec())), 4);
		const h = await authHeaders();
		const ok = await SELF.fetch(`http://example.com/api/a/${aid(1)}/faces?v=4`, { headers: h });
		expect(ok.status).toBe(200);
		expect(ok.headers.get("cache-control")).toContain("private");
		await ok.arrayBuffer();
		expect((await SELF.fetch(`http://example.com/api/a/${aid(1)}/faces`, { headers: h })).status).toBe(404);
		expect((await SELF.fetch(`http://example.com/api/a/${aid(1)}/faces?v=5`, { headers: h })).status).toBe(404);
	});

	it("permanent delete removes faces, sprite and face vectors", async () => {
		await seedAsset(1);
		await saveFaces(withIndex(), aid(1), scan(face(randomVec())), 0);
		const fid = (await facesOf(aid(1)))[0]!.id;
		await deleteAssetsPermanently(withIndex(), [aid(1)]);
		expect(await facesOf(aid(1))).toEqual([]);
		expect(await env.PHOTOS.get(`d/${aid(1)}/faces-0.webp`)).toBeNull();
		expect(index.deleted).toContain(fid);
	});
});

describe("faces status", () => {
	it("counts photos without a scan (not videos)", async () => {
		await seedAsset(1);
		await seedAsset(2, { kind: "video" });
		await seedAsset(3);
		await saveFaces(env, aid(3), scan(), 0);
		const h = await authHeaders();
		const status = await (await SELF.fetch("http://example.com/api/faces/status", { headers: h })).json();
		expect(status).toMatchObject({ total: 2, missing: 1 });
	});
});
