import { SELF, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { guardStub } from "../src/guard";
import { authHeaders, mockAccessJwks } from "./helpers";

beforeAll(() => mockAccessJwks());

beforeEach(async () => {
	await guardStub(env).reset();
	await env.DB.batch([
		env.DB.prepare("DELETE FROM jobs"),
		env.DB.prepare("DELETE FROM uploads"),
		env.DB.prepare("DELETE FROM asset_files"),
		env.DB.prepare("DELETE FROM assets"),
	]);
});

// sniff 至少要 16 字节
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(28).fill(1)]);
const sha = (c: string) => c.repeat(64);

async function call<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
	const res = await SELF.fetch(`http://example.com/api${path}`, {
		method,
		headers: await authHeaders({ Origin: "http://example.com", "X-Requested-With": "nana", "Content-Type": "application/json" }),
		body: body ? JSON.stringify(body) : undefined,
	});
	return { status: res.status, json: (await res.json()) as T };
}

async function putPart(uploadId: string, data: Uint8Array) {
	const res = await SELF.fetch(`http://example.com/api/uploads/${uploadId}/parts/1`, {
		method: "PUT",
		headers: await authHeaders({ Origin: "http://example.com", "X-Requested-With": "nana" }),
		body: data,
	});
	expect(res.status).toBe(200);
	return (await res.json()) as { partNumber: number; etag: string };
}

const counts = async () => ({
	assets: await env.DB.prepare("SELECT status FROM assets").all().then((r) => r.results.map((x) => x.status)),
	jobs: await env.DB.prepare("SELECT kind, status FROM jobs").all().then((r) => r.results),
	uploads: await env.DB.prepare("SELECT COUNT(*) AS n FROM uploads").first("n"),
});

describe("uploads", () => {
	it("creates the asset and its upload rows together, and finishes with a pending process job", async () => {
		const created = await call("POST", "/uploads", {
			kind: "photo",
			files: [{ role: "original", name: "a.jpg", size: JPEG.length, sha256: sha("a") }],
		});
		expect(created.status).toBe(201);
		expect(await counts()).toEqual({ assets: ["uploading"], jobs: [], uploads: 1 });

		const [u] = created.json.uploads;
		const part = await putPart(u.uploadId, JPEG);
		const done = await call("POST", `/uploads/${u.uploadId}/complete`, { parts: [part] });
		expect(done).toEqual({ status: 200, json: { assetId: created.json.assetId, status: "pending" } });
		expect(await counts()).toEqual({ assets: ["pending"], jobs: [{ kind: "process", status: "pending" }], uploads: 0 });
	});

	it("only creates the job when the last file of an asset completes", async () => {
		const created = await call("POST", "/uploads", {
			kind: "photo",
			files: [
				{ role: "original", name: "a.jpg", size: JPEG.length, sha256: sha("b") },
				{ role: "raw", name: "a.dng", size: 32, sha256: sha("c") },
			],
		});
		const [jpg, raw] = created.json.uploads;
		const first = await call("POST", `/uploads/${jpg.uploadId}/complete`, { parts: [await putPart(jpg.uploadId, JPEG)] });
		expect(first.json.status).toBe("uploading");
		expect((await counts()).jobs).toEqual([]);

		// RAW 的文件头：TIFF 小端
		const dng = new Uint8Array([0x49, 0x49, 0x2a, 0x00, 8, ...new Array(27).fill(0)]);
		const second = await call("POST", `/uploads/${raw.uploadId}/complete`, { parts: [await putPart(raw.uploadId, dng)] });
		expect(second.json.status).toBe("pending");
		expect(await counts()).toEqual({ assets: ["pending"], jobs: [{ kind: "process", status: "pending" }], uploads: 0 });
	});

	it("accepts a retried complete after the multipart upload was already merged", async () => {
		const created = await call("POST", "/uploads", {
			kind: "photo",
			files: [{ role: "original", name: "a.jpg", size: JPEG.length, sha256: sha("d") }],
		});
		const [u] = created.json.uploads;
		const part = await putPart(u.uploadId, JPEG);
		// 模拟上一次 complete 合并了对象、但写 D1 时出错
		const row = await env.DB.prepare("SELECT r2_key, r2_upload_id FROM uploads WHERE id = ?")
			.bind(u.uploadId)
			.first<{ r2_key: string; r2_upload_id: string }>();
		await env.PHOTOS.resumeMultipartUpload(row!.r2_key, row!.r2_upload_id).complete([part]);

		const done = await call("POST", `/uploads/${u.uploadId}/complete`, { parts: [part] });
		expect(done.status).toBe(200);
		expect(await counts()).toEqual({ assets: ["pending"], jobs: [{ kind: "process", status: "pending" }], uploads: 0 });
	});
});
