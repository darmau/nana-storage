#!/usr/bin/env node
// 把 demo-photos.json 里的示例照片导入本地 wrangler dev，给官网截图用。
// 用和浏览器相同的上传协议（同 scripts/e2e-upload.mjs），处理完后补上拍摄时间、位置、收藏和相册。
//
//   cd apps/web && npx vite build
//   cd apps/worker && npx wrangler dev --persist-to ../../site/.demo/state   # 独立的本地数据，不碰平时开发用的
//   node site/scripts/seed-demo.mjs [http://localhost:8787]
//
// 可以重复运行：已经导入的照片服务端按 sha256 判重（409），只补元数据。
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const BASE = process.argv[2] ?? "http://localhost:8787";
const DIR = new URL("../.demo/photos/", import.meta.url);
const photos = JSON.parse(readFileSync(new URL("./demo-photos.json", import.meta.url), "utf8"));
const headers = { Origin: BASE, "X-Requested-With": "nana" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, body) {
	const bin = body instanceof Uint8Array;
	const res = await fetch(BASE + path, {
		method,
		headers: { ...headers, ...(body && !bin ? { "Content-Type": "application/json" } : {}) },
		body: bin ? body : body ? JSON.stringify(body) : undefined,
	});
	const text = await res.text();
	let json;
	try {
		json = JSON.parse(text);
	} catch {
		json = text;
	}
	return { status: res.status, json };
}

// 1. 下载（已经下载过的跳过）
mkdirSync(DIR, { recursive: true });
for (const p of photos) {
	const file = new URL(`${p.id}.jpg`, DIR);
	if (existsSync(file)) continue;
	const res = await fetch(p.url, { headers: { "User-Agent": "nana-storage-site/1.0 (screenshots)" } });
	if (!res.ok) throw new Error(`download ${p.id}: ${res.status}`);
	writeFileSync(file, Buffer.from(await res.arrayBuffer()));
	process.stdout.write(".");
}
console.log(`\n${photos.length} photos downloaded`);

// 2. 上传
const ids = new Map(); // demo id → asset id
for (const p of photos) {
	const data = readFileSync(new URL(`${p.id}.jpg`, DIR));
	const sha256 = createHash("sha256").update(data).digest("hex");
	const created = await api("POST", "/api/uploads", {
		kind: "photo",
		folderPath: p.folder === "Home" ? "Home" : `Travel/${p.folder}`,
		clientMtime: Date.parse(`${p.local}:00Z`) - p.tzOffsetMin * 60_000,
		clientTzOffsetMin: p.tzOffsetMin,
		files: [{ role: "original", name: `${p.folder.replace(/\s/g, "")}_${p.id.slice(0, 8)}.jpg`, size: data.length, sha256 }],
	});
	if (created.status === 409) {
		const existing = created.json.existingAssetId;
		if (existing) ids.set(p.id, existing);
		continue;
	}
	if (created.status !== 201) throw new Error(`create ${p.id}: ${created.status} ${JSON.stringify(created.json)}`);
	const { assetId, partSize, uploads } = created.json;
	for (const u of uploads) {
		const parts = [];
		for (let n = 1; n <= u.parts; n++) {
			const r = await api("PUT", `/api/uploads/${u.uploadId}/parts/${n}`, new Uint8Array(data.subarray((n - 1) * partSize, n * partSize)));
			if (r.status !== 200) throw new Error(`part ${p.id}: ${r.status}`);
			parts.push(r.json);
		}
		const done = await api("POST", `/api/uploads/${u.uploadId}/complete`, { parts });
		if (done.status !== 200) throw new Error(`complete ${p.id}: ${done.status}`);
	}
	ids.set(p.id, assetId);
	process.stdout.write("↑");
}
console.log(`\n${ids.size} uploaded`);

// 3. 等处理完（本地容器，最多 20 分钟）
const deadline = Date.now() + 20 * 60_000;
for (const [demo, id] of ids) {
	for (;;) {
		const r = await api("GET", `/api/assets/${id}`);
		if (r.status === 200 && r.json.status === "ready" && r.json.jobs_active === 0) break;
		if (r.json?.status === "failed") throw new Error(`processing failed: ${demo}`);
		if (Date.now() > deadline) throw new Error("timeout waiting for processing");
		await sleep(2000);
	}
}
console.log("all processed");

// 4. 元数据：每张单独的时间和位置（同一时间 / 位置的才能合批，这里逐张改，100 张很快）
for (const p of photos) {
	const id = ids.get(p.id);
	if (!id) continue;
	await api("POST", "/api/assets/batch", { action: "set-time", ids: [id], takenAt: { local: p.local, tzOffsetMin: p.tzOffsetMin } });
	await api("POST", "/api/assets/batch", { action: "set-location", ids: [id], location: { lat: p.lat, lon: p.lon } });
}
const favs = photos.filter((p) => p.favorite).map((p) => ids.get(p.id)).filter(Boolean);
if (favs.length) await api("POST", "/api/assets/batch", { action: "favorite", ids: favs, value: true });

// 5. 相册（已有同名相册时跳过）
const albums = (await api("GET", "/api/albums")).json.items ?? [];
const ALBUMS = [
	{ name: "Best of 2024", pick: (p) => p.local.startsWith("2024") && p.favorite !== undefined && (p.id.charCodeAt(0) % 3 === 0 || p.favorite) },
	{ name: "Pets", pick: (p) => p.folder === "Home" && photos.indexOf(p) % 15 < 10 },
	{ name: "Mountains & water", pick: (p) => ["Iceland", "Yosemite"].includes(p.folder) },
	{ name: "City lights", pick: (p) => p.folder === "Hong Kong" },
];
for (const a of ALBUMS) {
	if (albums.some((x) => x.name === a.name)) continue;
	const assetIds = photos.filter(a.pick).map((p) => ids.get(p.id)).filter(Boolean);
	await api("POST", "/api/albums", { name: a.name, assetIds });
}
console.log("done");
