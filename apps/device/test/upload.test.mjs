import assert from "node:assert/strict";
import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { after, test } from "node:test";
import { ApiError } from "../client.mjs";
import { PAGE_GONE_MS, STAGE_MAX_BYTES, Uploads } from "../upload.mjs";

const dirs = [];
after(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

/** 假的服务器：记录请求，按路径应答；create 可以换成别的行为（409、503 …）。 */
function fakeApi({ create } = {}) {
	const calls = [];
	let n = 0;
	return {
		calls,
		async request(path, opts = {}) {
			calls.push({ path, method: opts.method ?? "GET", json: opts.json, bytes: opts.body?.length });
			if (path === "/uploads") {
				if (create) return create(opts.json);
				return {
					assetId: `A${++n}`,
					partSize: 4,
					uploads: opts.json.files.map((f, i) => ({ uploadId: `U${n}-${i}`, role: f.role, parts: Math.ceil(f.size / 4) })),
				};
			}
			if (path.includes("/parts/")) return { partNumber: Number(path.split("/").pop()), etag: "e" };
			return { ok: true };
		},
	};
}

async function setup({ api = fakeApi(), attached = false, now } = {}) {
	const dir = await mkdtemp(join(tmpdir(), "nana-up-"));
	dirs.push(dir);
	let uploaded = 0;
	const u = new Uploads({ dir, getApi: () => api, isAttached: () => attached, onUploaded: () => uploaded++, now });
	await u.init();
	return { u, api, dir, uploaded: () => uploaded };
}

const file = (name, content, extra = {}) => ({ name, relativePath: name, size: Buffer.byteLength(content), lastModified: 1000, content, ...extra });

/** 模拟网页：按 next() 的要求一个个发，直到没有要发的。 */
async function sendAll(u, session, files, first) {
	for (;;) {
		const r = u.next(session);
		if (r.index === undefined) return r;
		await u.receive(r.index, Readable.from([Buffer.from(files[r.index - first].content)]));
	}
}

/** 等后台上传跑完（#pump 是异步的）。 */
async function settle(u) {
	for (let i = 0; i < 100; i++) {
		const c = u.summary().counts;
		if (!c.staged && !c.uploading) return;
		await new Promise((r) => setTimeout(r, 5));
	}
	throw new Error("uploads did not settle");
}

test("groups a Live Photo, uploads in parts with the same protocol as the browser, and cleans up when the cloud processes it", async () => {
	const { u, api, dir } = await setup();
	const files = [file("IMG_1.HEIC", "heic-bytes"), file("IMG_1.MOV", "mov"), file("notes.txt", "x")];
	const { first, groups, skipped } = u.start({ session: "s1", files, folderId: "F1", folderLabel: "Trips", tzOffsetMin: 480 });
	assert.deepEqual({ groups, skipped }, { groups: 1, skipped: [first + 2] });
	assert.deepEqual(await sendAll(u, "s1", files, first), { idle: true });
	await settle(u);

	const create = api.calls.find((c) => c.path === "/uploads");
	assert.equal(create.json.kind, "live");
	assert.equal(create.json.folderId, "F1");
	assert.equal(create.json.clientTzOffsetMin, 480);
	assert.deepEqual(
		create.json.files.map((f) => [f.role, f.name, f.size, f.sha256.length]),
		[
			["original", "IMG_1.HEIC", 10, 64],
			["live_video", "IMG_1.MOV", 3, 64],
		],
	);
	// 10 字节按 4 字节一块：3 块；3 字节：1 块；每个文件 complete 一次
	assert.equal(api.calls.filter((c) => c.path.includes("/parts/")).length, 4);
	assert.equal(api.calls.filter((c) => c.path.endsWith("/complete")).length, 2);
	const s = u.summary();
	assert.equal(s.counts.done, 1);
	assert.equal(s.sent, 13);
	assert.equal(s.recent[0].folder, "Trips");
	assert.equal(s.stagedBytes, 0);
	assert.deepEqual(await readdir(dir), []);
});

test("shows the destination with the kept folder structure", async () => {
	const { u } = await setup();
	u.start({ session: "s", files: [file("x.jpg", "x", { relativePath: "Trip/Kyoto/x.jpg" })], folderLabel: "Library" });
	assert.equal(u.summary().recent[0].folder, "Library / Trip / Kyoto");
});

test("marks duplicates without uploading any bytes", async () => {
	const api = fakeApi({
		create: () => {
			throw new ApiError(409, "duplicate");
		},
	});
	const { u, dir } = await setup({ api });
	const files = [file("a.jpg", "jpeg")];
	const { first } = u.start({ session: "s", files });
	await sendAll(u, "s", files, first);
	await settle(u);
	assert.equal(u.summary().counts.duplicate, 1);
	assert.equal(api.calls.filter((c) => c.path.includes("/parts/")).length, 0);
	assert.deepEqual(await readdir(dir), []);
});

test("keeps uploaded files for local processing while attached, and deletes each once a job has copied it", async () => {
	const { u, dir, uploaded } = await setup({ attached: true });
	const files = [file("b.jpg", "jpeg-b"), file("c.jpg", "jpeg-c")];
	const { first } = u.start({ session: "s", files });
	await sendAll(u, "s", files, first);
	await settle(u);
	assert.equal(uploaded(), 2);
	assert.equal(u.summary().waitingForProcessing, 2);

	const [path] = u.candidates("b.jpg", 6);
	assert.ok(path);
	assert.equal(u.candidates("other.jpg", 6).length, 2, "same size, other name: still a candidate");
	u.used(path);
	await new Promise((r) => setTimeout(r, 10));
	await assert.rejects(access(path));
	assert.equal(u.summary().waitingForProcessing, 1);

	u.dropReady();
	await new Promise((r) => setTimeout(r, 10));
	assert.equal(u.summary().stagedBytes, 0);
	assert.deepEqual(await readdir(dir), []);
});

test("asks the page to wait when staging is full, but always takes one file", async () => {
	const { u } = await setup();
	const big = Math.floor(STAGE_MAX_BYTES * 0.6);
	u.start({
		session: "s",
		files: [
			{ name: "v1.mov", relativePath: "v1.mov", size: big },
			{ name: "v2.mov", relativePath: "v2.mov", size: big },
		],
	});
	assert.equal(u.next("s").index, 0);
	assert.deepEqual(u.next("s"), { wait: 2000 });
	assert.equal(u.summary().stagedBytes, big);
});

test("evicts the oldest files waiting for local processing instead of making the page wait", async () => {
	let t = 1000;
	const { u, dir } = await setup({ attached: true, now: () => t });
	const files = [file("a.jpg", "aaaa"), file("b.jpg", "bbbbb")];
	const { first } = u.start({ session: "s", files });
	assert.equal(u.next("s").index, first);
	await u.receive(first, Readable.from([Buffer.from("aaaa")]));
	await settle(u);
	t += 1000;
	assert.equal(u.next("s").index, first + 1);
	await u.receive(first + 1, Readable.from([Buffer.from("bbbbb")]));
	await settle(u);
	assert.equal(u.summary().waitingForProcessing, 2);

	const big = STAGE_MAX_BYTES - 6;
	const { first: f2 } = u.start({ session: "s", files: [{ name: "v.mov", relativePath: "v.mov", size: big }] });
	assert.equal(u.next("s").index, f2, "no wait: oldest waiting file evicted");
	assert.equal(u.summary().waitingForProcessing, 1);
	assert.equal(u.candidates("a.jpg", 4).length, 0, "the older one went first");
	assert.equal(u.candidates("b.jpg", 5).length, 1);
	assert.equal(u.summary().stagedBytes, 5 + big);
	await new Promise((r) => setTimeout(r, 10));
	assert.deepEqual(await readdir(dir), [String(first + 1)]);
});

test("rejects a file whose size doesn't match the manifest, and gives up after three tries", async () => {
	const { u, dir } = await setup();
	u.start({ session: "s", files: [file("d.jpg", "12345")] });
	for (let i = 0; i < 3; i++) {
		const r = u.next("s");
		assert.equal(r.index, 0);
		await assert.rejects(u.receive(0, Readable.from([Buffer.from("123")])), /size mismatch/);
	}
	const s = u.summary();
	assert.equal(s.counts.failed, 1);
	assert.equal(s.stagedBytes, 0);
	assert.deepEqual(await readdir(dir), []);
	assert.deepEqual(u.next("s"), { idle: true });
});

test("stops when the server's cost protection trips, and resumes the same item later", async () => {
	let tripped = true;
	const base = fakeApi();
	const api = {
		calls: base.calls,
		request(path, opts) {
			if (path === "/uploads" && tripped) return Promise.reject(new ApiError(503, "guard tripped"));
			return base.request(path, opts);
		},
	};
	const { u } = await setup({ api });
	const files = [file("e.jpg", "eeee")];
	const { first } = u.start({ session: "s", files });
	await sendAll(u, "s", files, first);
	await new Promise((r) => setTimeout(r, 10));
	assert.equal(u.summary().stopped, "guard tripped");
	assert.equal(u.summary().counts.staged, 1);
	assert.deepEqual(u.next("s"), { wait: 5000 });

	tripped = false;
	u.resume();
	await settle(u);
	assert.equal(u.summary().counts.done, 1);
	assert.equal(u.summary().stopped, null);
});

test("reports files the page can no longer send after it was closed, and cancels them", async () => {
	let t = 1_000_000;
	const { u } = await setup({ now: () => t });
	u.start({ session: "old", files: [file("f.jpg", "ffff"), file("g.jpg", "gggg")] });
	assert.equal(u.summary().orphaned, 0);
	t += PAGE_GONE_MS + 1;
	assert.equal(u.summary().orphaned, 2);
	// 另一个网页不会被要求发旧网页的文件
	assert.deepEqual(u.next("new"), { idle: true });
	await u.cancel();
	const s = u.summary();
	assert.equal(s.orphaned, 0);
	assert.equal(s.counts.failed, 2);
	assert.equal(s.failed.length, 0, "cancelled items aren't listed as failures");
	assert.equal(u.clear(), true);
	assert.equal(u.summary().total, 0);
});
