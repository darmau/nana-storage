import { SELF, env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FACE_DIMS, FACE_MODEL_VER, MASK_MAX_POINTS, decodeMask, encodeMask, maskCoverage, rotatePoint } from "@nana/shared";
import { guardStub } from "../src/guard";
import { handleJobMessage, handlers } from "../src/jobs";
import { FACE_STATE, people, saveFaces } from "../src/people";
import { type ProcessorLike, rotateAsset } from "../src/process";
import type { DeriveInput } from "../src/processor";
import { authHeaders, mockAccessJwks } from "./helpers";

beforeAll(() => mockAccessJwks());

const ID = (n: number) => `MSK${String(n).padStart(23, "0")}`;
async function seed(n: number, kind = "photo") {
	await env.DB.batch([
		env.DB.prepare(
			`INSERT INTO assets (id, kind, status, local_month, local_day, taken_at, width, height, created_at, updated_at)
			 VALUES (?, ?, 'ready', '2024-05', '2024-05-01', 1714500000000, 4000, 3000, 0, 0)`,
		).bind(ID(n), kind),
		env.DB.prepare(
			"INSERT INTO asset_files (id, asset_id, role, r2_key, mime, size, sha256, created_at) VALUES (?, ?, 'original', ?, 'image/jpeg', 100, ?, 0)",
		).bind(`MKF${n}`, ID(n), `o/${ID(n)}/MKF${n}`, "1".padStart(64, "0")),
	]);
}
async function call<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
	const res = await SELF.fetch(`http://example.com/api${path}`, {
		method,
		headers: await authHeaders(
			method === "GET" ? {} : { Origin: "http://example.com", "X-Requested-With": "nana", "Content-Type": "application/json" },
		),
		body: body ? JSON.stringify(body) : undefined,
	});
	return { status: res.status, json: (await res.json()) as T };
}
const row = (n: number) => env.DB.prepare("SELECT * FROM assets WHERE id = ?").bind(ID(n)).first<Record<string, any>>();

/** 盖住人脸框（x 0.4–0.5，y 0.3–0.45）的一笔 */
const OVER_FACE = encodeMask([{ r: 0.06, p: [0.42, 0.37, 0.48, 0.37] }])!;
/** 左上角的一个点，和人脸不相干 */
const CORNER = encodeMask([{ r: 0.02, p: [0.05, 0.05] }])!;

beforeEach(async () => {
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

describe("mask encoding", () => {
	it("round-trips strokes (quantized) and rejects malformed or oversized input", () => {
		const s = encodeMask([
			{ r: 0.05, p: [0.1, 0.2, 0.3, 0.4] },
			{ r: 0.5, p: [1.2, -1] }, // 半径和坐标都收进范围
		])!;
		const back = decodeMask(s)!;
		expect(back).toHaveLength(2);
		expect(back[0]!.r).toBeCloseTo(0.05, 4);
		expect(back[0]!.p.map((v) => +v.toFixed(4))).toEqual([0.1, 0.2, 0.3, 0.4]);
		expect(back[1]!.r).toBeCloseTo(0.25, 4);
		expect(back[1]!.p).toEqual([1, 0]);
		// 解码再编码不变（服务端按这个形式比较、保存）
		expect(encodeMask(back)).toBe(s);

		expect(encodeMask([])).toBeNull();
		expect(encodeMask([{ r: 0.1, p: [0.5] }])).toBeNull();
		expect(decodeMask("")).toBeNull();
		expect(decodeMask("not base64!")).toBeNull();
		expect(decodeMask(s.slice(0, -4))).toBeNull();
		expect(decodeMask(`${s}AAAA`)).toBeNull();
		const big = Array.from({ length: MASK_MAX_POINTS + 1 }, (_, i) => i / (MASK_MAX_POINTS + 1));
		expect(() => encodeMask([{ r: 0.01, p: [...big, ...big] }])).toThrow("mask too large");
	});

	it("measures how much of a box is covered, in the photo's real proportions", () => {
		const strokes = decodeMask(OVER_FACE)!;
		expect(maskCoverage(strokes, { x: 0.4, y: 0.3, w: 0.1, h: 0.15 }, 4 / 3)).toBeGreaterThan(0.9);
		expect(maskCoverage(strokes, { x: 0.8, y: 0.8, w: 0.1, h: 0.1 }, 4 / 3)).toBe(0);
		// 半径按长边算：同一个点在竖长的图上横向盖住的比例更大
		const dot = [{ r: 0.1, p: [0.5, 0.5] }];
		const box = { x: 0.35, y: 0.45, w: 0.3, h: 0.1 };
		expect(maskCoverage(dot, box, 0.25)).toBeGreaterThan(maskCoverage(dot, box, 4));
		expect(rotatePoint(0.1, 0.2, 90)).toEqual([0.8, 0.1]);
		const [x, y] = rotatePoint(...rotatePoint(0.1, 0.2, 90), 270);
		expect([x, y].map((v) => +v.toFixed(9))).toEqual([0.1, 0.2]);
	});
});

describe("PATCH mask", () => {
	it("stores the normalized mask, bumps the revision and queues one rotate job; same mask is a no-op; null clears", async () => {
		await seed(1);
		expect((await call("PATCH", `/assets/${ID(1)}`, { mask: "garbage!" })).status).toBe(400);
		expect((await call("PATCH", `/assets/${ID(1)}`, { mask: CORNER })).json).toEqual({ ok: true, rotating: true });
		expect(await row(1)).toMatchObject({ mask: CORNER, derived_rev: 1 });
		expect((await call("PATCH", `/assets/${ID(1)}`, { mask: CORNER, rotation: 0 })).json).toEqual({ ok: true });
		expect(await row(1)).toMatchObject({ derived_rev: 1 });
		// 只改角度时打码不用换算（相对于旋转之前的图）
		await call("PATCH", `/assets/${ID(1)}`, { rotation: 90 });
		expect(await row(1)).toMatchObject({ mask: CORNER, derived_rev: 2 });
		await call("PATCH", `/assets/${ID(1)}`, { mask: null });
		expect(await row(1)).toMatchObject({ mask: null, derived_rev: 3 });
		const jobs = await env.DB.prepare("SELECT kind FROM jobs WHERE asset_id = ? AND status = 'pending'").bind(ID(1)).all();
		expect(jobs.results).toEqual([{ kind: "rotate" }]);
	});

	it("refuses to blur videos", async () => {
		await seed(1, "video");
		expect((await call("PATCH", `/assets/${ID(1)}`, { mask: CORNER })).status).toBe(400);
	});
});

describe("mask in the rotate job", () => {
	const real = { rotate: handlers.rotate };
	afterEach(() => Object.assign(handlers, real));
	const calls: DeriveInput[] = [];
	const fake = (() => ({
		derive: async (i: DeriveInput) => {
			calls.push(i);
			return {
				ok: true,
				containerSeconds: 1,
				value: { meta: {}, sha256: "1".padStart(64, "0"), size: 100, crc32: 1, width: 400, height: 300, thumbSize: 1, previewSize: 2, fp: null, faces: null },
			};
		},
	})) as unknown as () => ProcessorLike;

	it("passes the mask and a base key even without a crop", async () => {
		await seed(1);
		await call("PATCH", `/assets/${ID(1)}`, { mask: CORNER });
		const job = await env.DB.prepare("SELECT id FROM jobs WHERE asset_id = ? AND status = 'pending'").bind(ID(1)).first<{ id: string }>();
		calls.length = 0;
		handlers.rotate = (j, e) => rotateAsset(j, e, fake);
		expect(await handleJobMessage({ jobId: job!.id }, env)).toBe("ack");
		expect(calls).toEqual([expect.objectContaining({ mask: CORNER, crop: null, baseKey: `d/${ID(1)}/base-1.webp`, skipFingerprint: true })]);
	});
});

describe("masked faces", () => {
	const vec = (k: number) => btoa(String.fromCharCode(...Array.from({ length: FACE_DIMS }, (_, i) => ((i * k) % 200) + 1)));
	const SPRITE = btoa(String.fromCharCode(82, 73, 70, 70, 1, 2, 3, 4));
	const face = (x: number, k: number) => ({ x, y: 0.3, w: 0.1, h: 0.15, px: 120, score: 0.9, sharpness: 150, embedding: vec(k) });
	const faces = () =>
		env.DB.prepare("SELECT id, x, person_id, assigned, state, indexed, masked FROM faces WHERE asset_id = ? ORDER BY x")
			.bind(ID(1))
			.all<{ id: string; x: number; person_id: string | null; assigned: number; state: number; indexed: number; masked: number }>()
			.then((r) => r.results);
	const peopleCall = (method: string, path: string, body?: unknown) =>
		people.request(path, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined }, env);

	it("leaves covered faces out of people and the info panel, and brings them back when the blur is removed", async () => {
		await seed(1);
		await saveFaces(env, ID(1), { model: FACE_MODEL_VER, faces: [face(0.4, 3), face(0.7, 5)], sprite: SPRITE }, 0);
		const [covered, other] = await faces();
		await peopleCall("POST", `/faces/${covered!.id}/assign`, { name: "Alice" });

		await call("PATCH", `/assets/${ID(1)}`, { mask: OVER_FACE });
		let rows = await faces();
		expect(rows[0]).toMatchObject({ masked: 1, person_id: null, assigned: 0, state: FACE_STATE.ignored, indexed: 0 });
		expect(rows[1]).toMatchObject({ masked: 0, state: other!.state });
		const panel = (await (await peopleCall("GET", `/assets/${ID(1)}/faces`)).json()) as { items: { id: string }[] };
		expect(panel.items.map((f) => f.id)).toEqual([other!.id]);
		// 盖住的脸不能再手动归入人物
		expect((await peopleCall("POST", `/faces/${covered!.id}/assign`, { name: "Alice" })).status).toBe(404);

		await call("PATCH", `/assets/${ID(1)}`, { mask: null });
		rows = await faces();
		expect(rows[0]).toMatchObject({ masked: 0, person_id: null, assigned: 0, state: FACE_STATE.pending, indexed: 0 });
	});

	it("marks faces found under an existing blur when the photo is scanned", async () => {
		await seed(1);
		await env.DB.prepare("UPDATE assets SET mask = ? WHERE id = ?").bind(OVER_FACE, ID(1)).run();
		await saveFaces(env, ID(1), { model: FACE_MODEL_VER, faces: [face(0.4, 3), face(0.7, 5)], sprite: SPRITE }, 0);
		expect((await faces()).map((f) => [f.masked, f.state])).toEqual([
			[1, FACE_STATE.ignored],
			[0, FACE_STATE.pending],
		]);
	});
});
