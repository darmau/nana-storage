#!/usr/bin/env node
// 端到端上传测试：针对本地 wrangler dev（含容器）运行。
//   cd apps/worker && npx wrangler dev        # 另一个终端
//   node scripts/e2e-upload.mjs [http://localhost:8787]
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const BASE = process.argv[2] ?? "http://localhost:8787";
const FIX = new URL("../apps/processor/test/fixtures/", import.meta.url);
const headers = { Origin: BASE, "X-Requested-With": "nana" };
const read = (name, suffix = "") => Buffer.concat([readFileSync(new URL(name, FIX)), Buffer.from(suffix)]);
const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const salt = `\n${Date.now()}`; // 追加在文件末尾，让每次运行的哈希都不同（JPEG/MOV 会忽略尾部数据）

async function api(method, path, body, extra = {}) {
	const isBin = body instanceof Uint8Array;
	const res = await fetch(BASE + path, {
		method,
		headers: { ...headers, ...(isBin ? {} : body ? { "Content-Type": "application/json" } : {}), ...extra },
		body: isBin ? body : body ? JSON.stringify(body) : undefined,
	});
	const text = await res.text();
	let json;
	try { json = JSON.parse(text); } catch { json = text; }
	return { status: res.status, json, res };
}

async function upload(kind, files, opts = {}) {
	const specs = files.map((f) => ({ role: f.role, name: f.name, size: f.data.length, sha256: sha(f.data) }));
	const created = await api("POST", "/api/uploads", {
		kind, files: specs, clientMtime: Date.now(), clientTzOffsetMin: 480, ...opts,
	});
	if (created.status !== 201) return { status: created.status, json: created.json };
	const { assetId, partSize, uploads } = created.json;
	for (const [i, u] of uploads.entries()) {
		const data = files.find((f) => f.role === u.role).data;
		const parts = [];
		for (let n = 1; n <= u.parts; n++) {
			const chunk = data.subarray((n - 1) * partSize, n * partSize);
			const r = await api("PUT", `/api/uploads/${u.uploadId}/parts/${n}`, new Uint8Array(chunk));
			if (r.status !== 200) return { status: r.status, json: r.json, assetId };
			parts.push(r.json);
		}
		const done = await api("POST", `/api/uploads/${u.uploadId}/complete`, { parts });
		if (done.status !== 200) return { status: done.status, json: done.json, assetId };
		void i;
	}
	return { status: 201, assetId };
}

async function waitReady(assetId, timeoutMs = 300_000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const r = await api("GET", `/api/assets/${assetId}`);
		if (r.status === 404) return { gone: true };
		if ((r.json.status === "ready" && r.json.jobs_active === 0) || r.json.status === "failed") return r.json;
		await new Promise((r) => setTimeout(r, 1000));
	}
	throw new Error(`timeout waiting for ${assetId}`);
}

let failures = 0;
const check = (ok, label, detail = "") => {
	console.log(`${ok ? "  ✓" : "  ✗"} ${label}${detail ? `  ${detail}` : ""}`);
	if (!ok) failures++;
};

async function checkFile(assetId, role, expectType) {
	const r = await fetch(`${BASE}/api/a/${assetId}/${role}`);
	const buf = Buffer.from(await r.arrayBuffer());
	check(r.status === 200 && r.headers.get("content-type") === expectType, `${role}`, `${r.status} ${r.headers.get("content-type")} ${buf.length}B cache=${r.headers.get("cache-control")}`);
}

async function scenario(label, kind, files, expect, opts) {
	console.log(`\n${label}`);
	const up = await upload(kind, files, opts);
	check(up.status === 201, "uploaded", JSON.stringify(up.json ?? ""));
	if (up.status !== 201) return null;
	const t0 = Date.now();
	const a = await waitReady(up.assetId);
	check(a.status === "ready", `processed in ${((Date.now() - t0) / 1000).toFixed(1)}s`, a.status);
	if (a.status !== "ready") {
		const failed = await api("GET", "/api/jobs/failed");
		console.log("    jobs/failed:", JSON.stringify(failed.json).slice(0, 800));
		return a;
	}
	console.log(`    kind=${a.kind} taken=${a.taken_at && new Date(a.taken_at).toISOString()} tz=${a.tz_offset_min} day=${a.local_day} ${a.width}x${a.height} gps=${a.lat},${a.lon} camera=${a.camera} dur=${a.duration_ms} cid=${a.content_identifier}`);
	console.log(`    files: ${a.files.map((f) => `${f.role}(${f.mime},${f.size})`).join(" ")}`);
	for (const [k, v] of Object.entries(expect)) check(a[k] === v, `${k} = ${JSON.stringify(v)}`, `got ${JSON.stringify(a[k])}`);
	await checkFile(up.assetId, "thumb", "image/webp");
	await checkFile(up.assetId, "preview", "image/webp");
	return a;
}

const me = await api("GET", "/api/me");
check(me.status === 200, "authenticated as", JSON.stringify(me.json));

const jpg = read("photo.jpg", salt);
await scenario("JPEG 照片", "photo", [{ role: "original", name: "IMG_0001.JPG", data: jpg }], {
	kind: "photo", local_day: "2024-05-01", tz_offset_min: 480, width: 3024, height: 4032, lat: 31.2304,
});

await scenario("HEIC 照片 + 文件夹路径", "photo", [{ role: "original", name: "IMG_0002.HEIC", data: read("photo.heic", salt) }], {
	kind: "photo", local_day: "2024-05-01",
}, { folderPath: "测试/2024" });

const live = await scenario("Live Photo（同一组上传）", "live", [
	{ role: "original", name: "IMG_0003.JPG", data: read("photo.jpg", salt + "live") },
	{ role: "live_video", name: "IMG_0003.MOV", data: read("video.mov", salt) },
], { kind: "live", duration_ms: 3000, content_identifier: "TEST-CID-1234" });
// Live Photo 的动态部分不转码（浏览器不能解码 HEVC 时只显示静态照片），见 CLAUDE.md
if (live?.files) check(!live.files.some((f) => f.role === "video_preview"), "no H.264 video_preview (Live Photo motion is not transcoded)");

const vid = await scenario("视频", "video", [{ role: "original", name: "clip.mov", data: read("video.mov", salt + "v") }], {
	kind: "video", duration_ms: 3000,
});
if (vid?.files) check(vid.files.some((f) => f.role === "video_preview"), "has H.264 video_preview");

console.log("\n去重");
const dup = await upload("photo", [{ role: "original", name: "again.jpg", data: jpg }]);
check(dup.status === 409, "same bytes rejected", `${dup.status} ${JSON.stringify(dup.json)}`);

console.log("\n恶意文件");
const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>${salt}`.padEnd(200, " "));
const bad = await upload("photo", [{ role: "original", name: "cute.jpg", data: svg }]);
check(bad.status === 415, "SVG disguised as JPEG rejected", `${bad.status}`);
const mismatch = await upload("photo", [{ role: "original", name: "a.jpg", data: read("video.mov", salt + "m") }]);
check(mismatch.status === 415, "video uploaded as photo rejected", `${mismatch.status}`);

console.log("\nRange 请求");
if (vid?.id) {
	const r = await fetch(`${BASE}/api/a/${vid.id}/video_preview`, { headers: { Range: "bytes=0-99" } });
	check(r.status === 206 && (await r.arrayBuffer()).byteLength === 100, "206 partial content", r.headers.get("content-range"));
}

console.log("\n批量下载（zip）");
{
	const ids = [live?.id, vid?.id].filter(Boolean);
	const r = await api("POST", "/api/downloads", { ids });
	check(r.status === 200 && r.json.files === 3, "manifest created", JSON.stringify(r.json));
	if (r.status === 200) {
		const res = await fetch(BASE + r.json.url);
		const buf = Buffer.from(await res.arrayBuffer());
		check(res.status === 200 && Number(res.headers.get("content-length")) === buf.length, "content-length matches body", `${buf.length}B`);
		const { mkdtempSync, writeFileSync } = await import("node:fs");
		const { execFileSync } = await import("node:child_process");
		const dir = mkdtempSync((process.env.TMPDIR ?? "/tmp/") + "nana-zip-");
		writeFileSync(`${dir}/a.zip`, buf);
		let ok = false;
		try { ok = execFileSync("unzip", ["-tq", `${dir}/a.zip`]).toString().includes("No errors"); } catch {}
		check(ok, "unzip -t passes");
		const listing = execFileSync("unzip", ["-Z1", `${dir}/a.zip`]).toString().trim().split("\n");
		check(listing.length === 3, "contains original + live video + video", listing.join(", "));
		execFileSync("unzip", ["-q", "-o", `${dir}/a.zip`, "-d", `${dir}/x`]);
		const got = sha(readFileSync(`${dir}/x/IMG_0003.MOV`));
		check(got === sha(read("video.mov", salt)), "extracted bytes identical to upload");
	}
	const expired = await fetch(`${BASE}/api/downloads/${"0".repeat(48)}`);
	check(expired.status === 410, "unknown token → 410", String(expired.status));
}

const guard = await api("GET", "/api/guard");
console.log("\nguard:", JSON.stringify(guard.json));
console.log(failures ? `\n${failures} 项失败` : "\n全部通过");
process.exit(failures ? 1 : 0);
