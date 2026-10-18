// 地图界面测试（无头 Chrome）。底图来自 OpenFreeMap，需要能联网；
// 并且已经运行过 scripts/e2e-upload.mjs（测试照片的 GPS 在上海）。
//   node scripts/perf/map-ui.mjs <截图输出目录>
import puppeteer from "puppeteer-core";
const OUT = process.argv[2];
const BASE = "http://localhost:8787";
const browser = await puppeteer.launch({
	executablePath: process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	headless: true,
	args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"], // 无头模式下用软件 WebGL
});
const page = await browser.newPage();
// 选择器靠中文文案定位，界面语言固定为简体中文（无头 Chrome 默认是英文）
await page.evaluateOnNewDocument(() => localStorage.setItem("nana:lang", "zh-CN"));
await page.setViewport({ width: 1280, height: 860 });
const errors = [];
const csp = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
	const t = m.text();
	if (/Content Security Policy|Refused to/.test(t)) csp.push(t);
	else if (m.type() === "error" && !t.includes("404")) errors.push(t);
});
const statuses = {};
const external = [];
page.on("response", (r) => {
	const u = new URL(r.url());
	// 底图只允许来自 OpenFreeMap，其他外部请求一律算失败
	if (u.origin === "https://tiles.openfreemap.org") {
		const kind = u.pathname.startsWith("/fonts/") ? "fonts" : u.pathname.startsWith("/sprites/") ? "sprites" : u.pathname.startsWith("/planet") ? "tiles" : "other";
		(statuses[kind] ??= {})[r.status()] = (statuses[kind][r.status()] ?? 0) + 1;
		return;
	}
	if (u.origin !== BASE && !u.protocol.startsWith("data") && !u.protocol.startsWith("blob")) external.push(r.url());
});
let failures = 0;
const check = (ok, label, detail = "") => {
	console.log(`${ok ? "✓" : "✗"} ${label}${detail ? `  ${detail}` : ""}`);
	if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (path, init) => (await fetch(BASE + "/api" + path, init)).json();

// 1. 先看中国东部的全局视图：应该有上海的照片标记
await page.goto(BASE + "/settings", { waitUntil: "networkidle0" });
await page.evaluate(() => sessionStorage.setItem("nana:map-view", JSON.stringify({ center: [121.47, 31.23], zoom: 8 })));
await page.goto(BASE + "/map", { waitUntil: "networkidle0" });
await page.waitForSelector(".maplibregl-canvas", { timeout: 20000 });
await page.waitForSelector("[data-photo-marker]", { timeout: 20000 }).catch(() => {});
await sleep(2500);
// 地图必须真的画出来了：画布尺寸正常，而且不是一片纯色
const canvasInfo = await page.evaluate(() => {
	const c = document.querySelector(".maplibregl-canvas");
	const gl = c.getContext("webgl2", { preserveDrawingBuffer: true }) ?? c.getContext("webgl");
	return { w: c.clientWidth, h: c.clientHeight };
});
const shot = await page.screenshot({ clip: { x: 100, y: 100, width: 400, height: 300 }, encoding: "base64" });
const distinct = new Set(Buffer.from(shot, "base64").subarray(0, 60000).toString("hex").match(/.{6}/g)).size;
check(canvasInfo.w > 500 && canvasInfo.h > 500, "map canvas has a real size", JSON.stringify(canvasInfo));
check(distinct > 2000, "map actually renders (not a blank canvas)", `distinct byte triples=${distinct}`);
const markers = await page.$$eval("[data-photo-marker]", (els) => els.map((e) => e.getAttribute("aria-label")));
check(markers.length > 0, "photo markers appear", JSON.stringify(markers));
await page.screenshot({ path: `${OUT}/map-overview.png` });

// 2. 点击标记 → 侧边栏列出照片，数量和标记一致
await page.click("[data-photo-marker]");
await page.waitForSelector("div.group img", { timeout: 10000 });
await sleep(800);
const listed = await page.$$eval("div.group", (els) => els.length);
const expected = Number(markers[0].match(/\d+/)[0]);
check(listed === expected, "side panel lists the cell's photos", `listed=${listed} marker=${expected}`);
await page.screenshot({ path: `${OUT}/map-panel.png` });

// 3. 从侧边栏打开查看器
await page.click('div.group > button[aria-label="打开"]');
await page.waitForSelector('[role="dialog"]', { timeout: 5000 });
check(true, "viewer opens from the map panel");
await page.keyboard.press("Escape");
await sleep(500);

// 4. 放大到街道级别，看中文标注
await page.evaluate(() => sessionStorage.setItem("nana:map-view", JSON.stringify({ center: [121.4737, 31.2304], zoom: 15 })));
await page.goto(BASE + "/map", { waitUntil: "networkidle0" });
await page.waitForSelector(".maplibregl-canvas");
await sleep(4000);
await page.screenshot({ path: `${OUT}/map-street.png` });

// 5. 查看器里“在地图上选”位置
const photo = (await api("/timeline/month/2024-05")).find((i) => i[3] === 0);
await page.goto(`${BASE}/?a=${photo[0]}&m=2024-05`, { waitUntil: "networkidle0" });
await page.waitForSelector('[role="dialog"]');
await page.keyboard.press("i");
await page.waitForSelector("aside");
await page.evaluate(() => [...document.querySelectorAll("aside button")].find((b) => ["修改", "添加"].includes(b.textContent.trim()) && b.closest("div").innerText.startsWith("位置")).click());
await sleep(300);
await page.evaluate(() => [...document.querySelectorAll("aside button")].find((b) => b.textContent.trim() === "在地图上选").click());
await page.waitForSelector('[aria-label="在地图上选择位置"] .maplibregl-canvas', { timeout: 15000 });
await sleep(2500);
const canvas = await page.$('[aria-label="在地图上选择位置"] .maplibregl-canvas');
const box = await canvas.boundingBox();
await page.mouse.click(box.x + box.width * 0.7, box.y + box.height * 0.3);
await sleep(500);
const pickedText = await page.$eval('[aria-label="在地图上选择位置"]', (el) => el.innerText);
const m = pickedText.match(/(-?\d+\.\d+), (-?\d+\.\d+)/);
check(!!m, "click on the map picks a coordinate", m?.[0]);
await page.screenshot({ path: `${OUT}/map-picker.png` });
await page.evaluate(() => [...document.querySelectorAll('[aria-label="在地图上选择位置"] button')].find((b) => b.textContent.includes("使用这个位置")).click());
await sleep(1000);
const saved = await api(`/assets/${photo[0]}`);
check(m && Math.abs(saved.lat - Number(m[1])) < 1e-5 && Math.abs(saved.lon - Number(m[2])) < 1e-5, "picked location saved", `${saved.lat}, ${saved.lon}`);

// 6. 深色模式
await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
await page.evaluate(() => sessionStorage.setItem("nana:map-view", JSON.stringify({ center: [121.4737, 31.2304], zoom: 12 })));
await page.goto(BASE + "/map", { waitUntil: "networkidle0" });
await page.waitForSelector(".maplibregl-canvas");
await sleep(3500);
await page.screenshot({ path: `${OUT}/map-dark.png` });

console.log("asset statuses:", JSON.stringify(statuses));
check(!statuses.tiles?.["404"] && (statuses.tiles?.["200"] ?? 0) > 0, "tiles loaded from OpenFreeMap");
check(!statuses.fonts?.["404"] && (statuses.fonts?.["200"] ?? 0) > 0, "fonts served");
check(external.length === 0, "no requests to other external hosts", external.slice(0, 3).join(" "));
check(csp.length === 0, "no CSP violations", csp.slice(0, 2).join(" | "));
console.log("page errors:", errors.slice(0, 5));
console.log(failures ? `${failures} failed` : "all passed");
await browser.close();
process.exit(failures ? 1 : 0);
