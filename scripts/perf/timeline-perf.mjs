// 时间线性能测试（无头 Chrome）：node scripts/perf/timeline-perf.mjs <截图输出目录>
// 先灌数据：cd apps/worker && npx wrangler d1 execute nana-db --local --file ../../scripts/perf/seed-50k.sql
import puppeteer from "puppeteer-core";
const OUT = process.argv[2];
const BASE = "http://localhost:8787";
const browser = await puppeteer.launch({
	executablePath: process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	headless: true,
	args: ["--window-size=1440,900", ...(process.env.CHROME_ARGS?.split(" ") ?? [])],
});
const page = await browser.newPage();
// 选择器靠中文文案定位，界面语言固定为简体中文（无头 Chrome 默认是英文）
await page.evaluateOnNewDocument(() => localStorage.setItem("nana:lang", "zh-CN"));
await page.setViewport({ width: 1440, height: 900 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && !m.text().includes("404") && errors.push(m.text()));
const statusCounts = {};
let thumbRequests = 0;
const t0 = Date.now();
page.on("response", (r) => {
	if (r.url().includes("/thumb")) thumbRequests++;
	statusCounts[r.status()] = (statusCounts[r.status()] ?? 0) + 1;
});

await page.goto(BASE + "/", { waitUntil: "networkidle0" });
await page.waitForSelector("#timeline div.group");
const stats = () =>
	page.evaluate(() => ({
		nodes: document.getElementsByTagName("*").length,
		tiles: document.querySelectorAll("#timeline div.group").length,
		sections: document.querySelectorAll("#timeline section").length,
		scrollHeight: document.documentElement.scrollHeight,
		y: Math.round(scrollY),
	}));
console.log("initial", await stats());
await page.screenshot({ path: `${OUT}/timeline-top.png` });

// 1. 连续滚动整条时间线，记录最大 DOM 节点数和长任务
await page.evaluate(() => {
	window.__long = [];
	new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__long.push(e.duration))).observe({ type: "longtask", buffered: true });
});
let maxNodes = 0, maxTiles = 0, blank = 0;
const total = (await stats()).scrollHeight;
const steps = 150;
for (let k = 1; k <= steps; k++) {
	await page.evaluate((y) => window.scrollTo(0, y), Math.round((total * k) / steps));
	await new Promise((r) => setTimeout(r, 120));
	const s = await stats();
	maxNodes = Math.max(maxNodes, s.nodes);
	maxTiles = Math.max(maxTiles, s.tiles);
	// 视口中间应当有照片格子（或者正在加载的占位），不能完全空白
	const hasContent = await page.evaluate(() => {
		const el = document.elementFromPoint(600, 450);
		return !!el && (el.closest("#timeline button") || el.closest("#timeline section")) !== null;
	});
	if (!hasContent) blank++;
}
const longTasks = await page.evaluate(() => window.__long);
console.log("scroll-through", { steps, maxNodes, maxTiles, blankViewports: blank, longTasks: longTasks.length, worstLongTaskMs: Math.round(Math.max(0, ...longTasks)) });
await page.screenshot({ path: `${OUT}/timeline-bottom.png` });

/** 一段操作期间主线程花在脚本 / 布局 / 样式重算上的时间（毫秒），比帧时间更能看出前后差别 */
const cpu = async (fn) => {
	const a = await page.metrics();
	const result = await fn();
	const b = await page.metrics();
	const ms = (k) => Math.round((b[k] - a[k]) * 1000);
	return { ...result, scriptMs: ms("ScriptDuration"), layoutMs: ms("LayoutDuration"), styleMs: ms("RecalcStyleDuration") };
};
let thumbsBefore = thumbRequests;

// 1b. 快速滚动（模拟甩动：1.5 秒匀速扫过 60% 的高度）：期间应当只画占位（格子数为 0），没有长帧；停下后恢复
const fling = await cpu(() => page.evaluate(async () => {
	const total = document.documentElement.scrollHeight;
	const y0 = scrollY;
	const y1 = Math.max(0, y0 - total * 0.6);
	const t0 = performance.now();
	let last = t0, worstFrame = 0, maxTiles = 0;
	await new Promise((done) => {
		const step = (t) => {
			const k = Math.min(1, (t - t0) / 1500);
			window.scrollTo(0, y0 + (y1 - y0) * k);
			worstFrame = Math.max(worstFrame, t - last);
			last = t;
			if (k > 0.1) maxTiles = Math.max(maxTiles, document.querySelectorAll("#timeline div.group").length);
			if (k < 1) requestAnimationFrame(step);
			else done();
		};
		requestAnimationFrame(step);
	});
	await new Promise((r) => setTimeout(r, 1000));
	return { worstFrameMs: Math.round(worstFrame), maxTilesDuringFling: maxTiles, tilesAfter: document.querySelectorAll("#timeline div.group").length };
}));
console.log("fling", { ...fling, thumbRequests: thumbRequests - thumbsBefore });

// 2. 拖动右侧滚动条跳到 40% 位置
const bar = await page.$('[role="scrollbar"]');
const box = await bar.boundingBox();

// 2a. 按住拖动条从 90% 慢慢拖到 10%（60 步），期间不应挂载格子、不请求缩略图
thumbsBefore = thumbRequests;
const longDrag = await cpu(async () => {
	const x = box.x + box.width / 2;
	await page.mouse.move(x, box.y + box.height * 0.9);
	await page.mouse.down();
	let maxTiles = 0;
	for (let k = 1; k <= 60; k++) {
		await page.mouse.move(x, box.y + box.height * (0.9 - (0.8 * k) / 60));
		if (k % 10 === 0) maxTiles = Math.max(maxTiles, await page.evaluate(() => document.querySelectorAll("#timeline div.group").length));
	}
	await page.mouse.up();
	await new Promise((r) => setTimeout(r, 800));
	return { maxTilesDuringDrag: maxTiles };
});
console.log("long scrubber drag", { ...longDrag, thumbRequests: thumbRequests - thumbsBefore });

await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.4);
await page.mouse.down();
await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.42, { steps: 5 });
await new Promise((r) => setTimeout(r, 50));
await page.screenshot({ path: `${OUT}/scrubber-drag.png` });
await page.mouse.up();
await new Promise((r) => setTimeout(r, 800));
const afterSeek = await stats();
const visibleMonth = await page.evaluate(() => {
	const secs = [...document.querySelectorAll("#timeline section")];
	const s = secs.find((el) => { const r = el.getBoundingClientRect(); return r.top <= 450 && r.bottom >= 450; });
	return s?.getAttribute("aria-label");
});
console.log("after scrubber seek", { ...afterSeek, visibleMonth });
await page.screenshot({ path: `${OUT}/after-seek.png` });

// 3. 窄屏（手机）
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
await page.evaluate(() => window.scrollTo(0, 0));
await new Promise((r) => setTimeout(r, 800));
const mobile = await stats();
const overflowX = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
console.log("mobile", { ...mobile, horizontalOverflow: overflowX });
await page.screenshot({ path: `${OUT}/mobile.png` });

console.log("requests", { thumbRequests, seconds: Math.round((Date.now() - t0) / 1000), statusCounts });
console.log("errors", errors.filter((e) => !e.includes("429")).slice(0, 5));
await browser.close();
