import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { guardStub } from "../src/guard";
import { handleJobMessage, handlers } from "../src/jobs";
import { processAsset, rotateAsset, type ProcessorLike } from "../src/process";
import { FP_MODEL_VER } from "@nana/shared";

// 用假的 Processor 代替容器：按输入 key 返回预设的元数据。
const fake = {
	metaByKey: new Map<string, Record<string, unknown>>(),
	shaByKey: new Map<string, string>(),
	transcodes: [] as { inputKey: string; outputKey: string }[],
	derives: 0,
	skipFingerprint: [] as (boolean | undefined)[],
};
const FP = { model: FP_MODEL_VER, phash: "fcc10bf9d813f031", embedding: btoa(String.fromCharCode(...Array.from({ length: 512 }, (_, i) => (i * 7) % 256))) };
const ok = <T,>(value: T) => ({ ok: true, value, containerSeconds: 1 });
const fakeProcessor = () =>
	({
		derive: async (i: { inputKey: string; skipFingerprint?: boolean }) => {
			fake.derives++;
			fake.skipFingerprint.push(i.skipFingerprint);
			return ok({
				meta: fake.metaByKey.get(i.inputKey) ?? {},
				sha256: fake.shaByKey.get(i.inputKey)!,
				size: 100,
				crc32: 12345,
				width: 400,
				height: 300,
				thumbSize: 1,
				previewSize: 2,
				fp: i.skipFingerprint ? null : FP,
			});
		},
		meta: async (key: string) => ok({ meta: fake.metaByKey.get(key) ?? {}, sha256: fake.shaByKey.get(key)!, size: 100, crc32: 678 }),
		transcode: async (inputKey: string, outputKey: string) => {
			fake.transcodes.push({ inputKey, outputKey });
			return ok({ size: 50 });
		},
	}) as unknown as ProcessorLike;

let n = 0;
async function seedAsset(kind: "photo" | "video", meta: Record<string, unknown>, opts: { badSha?: boolean } = {}) {
	n++;
	const assetId = `A${n}`;
	const key = `o/${assetId}/f${n}`;
	const sha = String(n).padStart(64, "0");
	fake.metaByKey.set(key, meta);
	fake.shaByKey.set(key, opts.badSha ? "f".repeat(64) : sha);
	const now = Date.now();
	await env.DB.batch([
		env.DB.prepare("INSERT INTO assets (id, kind, status, created_at, updated_at) VALUES (?, ?, 'pending', ?, ?)").bind(
			assetId, kind, now, now,
		),
		env.DB.prepare(
			"INSERT INTO asset_files (id, asset_id, role, r2_key, mime, size, sha256, original_name, created_at) VALUES (?, ?, 'original', ?, ?, 100, ?, ?, ?)",
		).bind(`f${n}`, assetId, key, kind === "photo" ? "image/heic" : "video/quicktime", sha, `IMG_${n}`, now),
		env.DB.prepare(
			"INSERT INTO jobs (id, asset_id, kind, status, attempts, updated_at) VALUES (?, ?, 'process', 'pending', 0, ?)",
		).bind(`J${n}`, assetId, now),
	]);
	return { assetId, jobId: `J${n}`, key };
}

const asset = (id: string) =>
	env.DB.prepare("SELECT kind, status, duration_ms, content_identifier FROM assets WHERE id = ?").bind(id).first<{
		kind: string; status: string; duration_ms: number | null; content_identifier: string | null;
	}>();
const roles = async (id: string) =>
	(await env.DB.prepare("SELECT role FROM asset_files WHERE asset_id = ? ORDER BY role").bind(id).all<{ role: string }>())
		.results.map((r) => r.role);

const PHOTO_META = { MIMEType: "image/heic", DateTimeOriginal: "2024:05:01 12:34:56", OffsetTimeOriginal: "+08:00", ContentIdentifier: "CID-9" };
const VIDEO_META = { MIMEType: "video/quicktime", CreationDate: "2024:05:01 12:34:56+08:00", Duration: 2.5, ContentIdentifier: "CID-9" };

describe("process job", () => {
	const realHandler = handlers.process;
	afterEach(() => {
		handlers.process = realHandler;
	});
	beforeEach(async () => {
		handlers.process = (job, e) => processAsset(job, e, fakeProcessor);
		await guardStub(env).reset();
		fake.transcodes.length = 0;
		fake.derives = 0;
	});

	it("merges a separately uploaded Live Photo (photo first, then video)", async () => {
		const photo = await seedAsset("photo", PHOTO_META);
		const video = await seedAsset("video", VIDEO_META);
		expect(await handleJobMessage({ jobId: photo.jobId }, env)).toBe("ack");
		expect((await asset(photo.assetId))!.kind).toBe("photo"); // 视频还没处理好，暂不合并
		expect(await handleJobMessage({ jobId: video.jobId }, env)).toBe("ack");

		expect(await asset(video.assetId)).toBeNull(); // 视频条目被并入照片
		const merged = await asset(photo.assetId);
		expect(merged).toMatchObject({ kind: "live", status: "ready", duration_ms: 2500, content_identifier: "CID-9" });
		expect(await roles(photo.assetId)).toEqual(["live_video", "original", "preview", "thumb"]);
		expect(fake.transcodes).toHaveLength(0); // Live Photo 的动态部分不转码
	});

	it("merges in the other order too (video first, then photo)", async () => {
		const video = await seedAsset("video", VIDEO_META);
		const photo = await seedAsset("photo", PHOTO_META);
		await handleJobMessage({ jobId: video.jobId }, env);
		expect((await asset(video.assetId))!.kind).toBe("video");
		await handleJobMessage({ jobId: photo.jobId }, env);

		expect(await asset(video.assetId)).toBeNull();
		expect((await asset(photo.assetId))!.kind).toBe("live");
		expect(await roles(photo.assetId)).toEqual(["live_video", "original", "preview", "thumb"]);
		// 只有视频单独处理时转过一次（当时还是普通视频），合并后不再转码
		expect(fake.transcodes).toEqual([{ inputKey: video.key, outputKey: `d/${video.assetId}/video_preview-0.mp4` }]);
	});

	it("does not transcode the video part of a paired Live Photo", async () => {
		const live = await seedAsset("photo", PHOTO_META);
		const videoKey = `o/${live.assetId}/live`;
		fake.metaByKey.set(videoKey, VIDEO_META);
		const videoSha = "d".repeat(63) + "1";
		fake.shaByKey.set(videoKey, videoSha);
		await env.DB.batch([
			env.DB.prepare("UPDATE assets SET kind = 'live' WHERE id = ?").bind(live.assetId),
			env.DB.prepare(
				"INSERT INTO asset_files (id, asset_id, role, r2_key, mime, size, sha256, original_name, created_at) VALUES (?, ?, 'live_video', ?, 'video/quicktime', 100, ?, 'IMG.MOV', ?)",
			).bind(`${live.assetId}-live`, live.assetId, videoKey, videoSha, Date.now()),
		]);
		expect(await handleJobMessage({ jobId: live.jobId }, env)).toBe("ack");
		expect(await asset(live.assetId)).toMatchObject({ kind: "live", status: "ready" });
		expect(fake.transcodes).toHaveLength(0);
	});

	it("transcodes ordinary videos", async () => {
		const video = await seedAsset("video", { ...VIDEO_META, ContentIdentifier: null });
		await handleJobMessage({ jobId: video.jobId }, env);
		expect(await roles(video.assetId)).toContain("video_preview");
		expect(fake.transcodes).toEqual([{ inputKey: video.key, outputKey: `d/${video.assetId}/video_preview-0.mp4` }]);
	});

	it("does not merge photos with different identifiers", async () => {
		const photo = await seedAsset("photo", { ...PHOTO_META, ContentIdentifier: "CID-A" });
		const video = await seedAsset("video", { ...VIDEO_META, ContentIdentifier: "CID-B" });
		await handleJobMessage({ jobId: photo.jobId }, env);
		await handleJobMessage({ jobId: video.jobId }, env);
		expect((await asset(photo.assetId))!.kind).toBe("photo");
		expect((await asset(video.assetId))!.kind).toBe("video");
	});

	it("fails an integrity mismatch permanently without retrying", async () => {
		const bad = await seedAsset("photo", PHOTO_META, { badSha: true });
		expect(await handleJobMessage({ jobId: bad.jobId }, env)).toBe("ack");
		expect(fake.derives).toBe(1);
		const job = await env.DB.prepare("SELECT status, attempts, last_error FROM jobs WHERE id = ?").bind(bad.jobId).first<{
			status: string; attempts: number; last_error: string;
		}>();
		expect(job).toMatchObject({ status: "failed", attempts: 1 });
		expect(job!.last_error).toContain("integrity");
		expect((await asset(bad.assetId))!.status).toBe("failed");
	});

	it("skips transcoding videos longer than the limit", async () => {
		const long = await seedAsset("video", { ...VIDEO_META, ContentIdentifier: null, Duration: 3600 });
		await handleJobMessage({ jobId: long.jobId }, env);
		expect((await asset(long.assetId))!.status).toBe("ready");
		expect(fake.transcodes).toHaveLength(0);
	});

	describe("bursts", () => {
		const burstOf = async (id: string) =>
			(await env.DB.prepare("SELECT burst_id FROM assets WHERE id = ?").bind(id).first<{ burst_id: string | null }>())!.burst_id;
		const frame = (ms: number, extra: Record<string, unknown> = {}) => ({
			MIMEType: "image/jpeg",
			Make: "Google",
			Model: "Pixel 8",
			ImageWidth: 4000,
			ImageHeight: 3000,
			DateTimeOriginal: "2024:06:01 10:00:00",
			OffsetTimeOriginal: "+08:00",
			SubSecTimeOriginal: String(ms).padStart(3, "0"),
			...extra,
		});
		const run = async (metas: Record<string, unknown>[]) => {
			const seeded = [];
			for (const m of metas) seeded.push(await seedAsset("photo", m));
			for (const s of seeded) expect(await handleJobMessage({ jobId: s.jobId }, env)).toBe("ack");
			return Promise.all(seeded.map((s) => burstOf(s.assetId)));
		};

		it("uses Apple BurstUUID", async () => {
			const ids = await run([{ ...PHOTO_META, ContentIdentifier: null, BurstUUID: "AB-1" }, { ...PHOTO_META, ContentIdentifier: null, BurstUUID: "AB-1" }]);
			expect(ids).toEqual(["AB-1", "AB-1"]);
		});

		it("infers bursts from sub-second gaps and merges groups processed out of order", async () => {
			// 处理顺序：第 1、3 张先处理（隔得太远，各自不成组），第 2 张最后处理，把三张连起来
			const s = [await seedAsset("photo", frame(100)), await seedAsset("photo", frame(500)), await seedAsset("photo", frame(900))];
			await handleJobMessage({ jobId: s[0]!.jobId }, env);
			await handleJobMessage({ jobId: s[2]!.jobId }, env);
			expect(await burstOf(s[0]!.assetId)).toBeNull();
			await handleJobMessage({ jobId: s[1]!.jobId }, env);
			const ids = await Promise.all(s.map((x) => burstOf(x.assetId)));
			expect(ids[0]).toMatch(/^t:/);
			expect(new Set(ids).size).toBe(1);
		});

		it("does not group same-second photos without sub-second time, or different cameras", async () => {
			const noSub = { ...frame(0, { DateTimeOriginal: "2024:06:03 10:00:00" }), SubSecTimeOriginal: undefined };
			expect(await run([noSub, noSub])).toEqual([null, null]);
			expect(await run([frame(100, { DateTimeOriginal: "2024:06:02 10:00:00" }), frame(300, { DateTimeOriginal: "2024:06:02 10:00:00", Model: "Pixel 9" })])).toEqual([null, null]);
		});

		it("marks RAW attachments", async () => {
			const p = await seedAsset("photo", { MIMEType: "image/jpeg" });
			await env.DB.prepare(
				"INSERT INTO asset_files (id, asset_id, role, r2_key, mime, size, sha256, created_at) VALUES ('raw1', ?, 'raw', 'o/raw1', 'image/x-sony-arw', 100, ?, 0)",
			).bind(p.assetId, "e".repeat(64)).run();
			fake.shaByKey.set("o/raw1", "e".repeat(64));
			await handleJobMessage({ jobId: p.jobId }, env);
			const row = await env.DB.prepare("SELECT traits FROM assets WHERE id = ?").bind(p.assetId).first<{ traits: number }>();
			expect(row!.traits).toBe(8);
		});
	});
});

describe("fingerprints", () => {
	const real = { ...handlers };
	afterEach(() => Object.assign(handlers, real));
	beforeEach(async () => {
		handlers.process = (job, e) => processAsset(job, e, fakeProcessor);
		handlers.rotate = (job, e) => rotateAsset(job, e, fakeProcessor);
		await guardStub(env).reset();
		fake.skipFingerprint.length = 0;
	});
	const fpRow = (id: string) => env.DB.prepare("SELECT phash, model, indexed FROM asset_fp WHERE asset_id = ?").bind(id).first();
	const addJob = async (id: string, assetId: string, kind: string) =>
		env.DB.prepare("INSERT INTO jobs (id, asset_id, kind, status, attempts, updated_at) VALUES (?, ?, ?, 'pending', 0, 0)").bind(id, assetId, kind).run();

	it("stores the fingerprint from the single derive call (no extra container call)", async () => {
		const p = await seedAsset("photo", { MIMEType: "image/jpeg" });
		await handleJobMessage({ jobId: p.jobId }, env);
		expect(await fpRow(p.assetId)).toEqual({ phash: FP.phash, model: FP_MODEL_VER, indexed: 0 }); // 测试里没有 Vectorize
		expect(fake.skipFingerprint).toEqual([undefined]);
	});

	it("rotation regenerates derivatives without recomputing the fingerprint", async () => {
		const p = await seedAsset("photo", { MIMEType: "image/jpeg" });
		await handleJobMessage({ jobId: p.jobId }, env);
		await addJob(`R${p.jobId}`, p.assetId, "rotate");
		await handleJobMessage({ jobId: `R${p.jobId}` }, env);
		expect(fake.skipFingerprint).toEqual([undefined, true]);
		expect(await fpRow(p.assetId)).toMatchObject({ phash: FP.phash });
	});
});
