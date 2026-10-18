// 大列表压力测试（无头 Chrome）：node scripts/perf/library-stress.mjs <截图输出目录> <列表路径>...
// 例：先灌 5 万张（seed-50k.sql），把它们放进一个相册 / 文件夹，再跑
//   node scripts/perf/library-stress.mjs /tmp/shots /albums/<id> /folders/<id> /folders/root
// 每个路径一直滚到底（加载完所有分页），记录最大 DOM 节点数、格子数、JS 堆和长任务。
import puppeteer from "puppeteer-core";
const [OUT, ...paths] = process.argv.slice(2);
const BASE = "http://localhost:8787";
const browser = await puppeteer.launch({
	executablePath: process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	headless: true,
	args: ["--window-size=1440,900", "--enable-precise-memory-info", ...(process.env.CHROME_ARGS?.split(" ") ?? [])],
});
let failures = 0;
for (const path of paths) {
	const page = await browser.newPage();
	// 选择器靠中文文案定位，界面语言固定为简体中文（无头 Chrome 默认是英文）
	await page.evaluateOnNewDocument(() => localStorage.setItem("nana:lang", "zh-CN"));
	await page.setViewport({ width: 1440, height: 900 });
	const errors = [];
	page.on("pageerror", (e) => errors.push(String(e)));
	let listRequests = 0;
	let pending = 0;
	page.on("request", (r) => r.url().includes("offset=") && (listRequests++, pending++));
	page.on("requestfinished", (r) => r.url().includes("offset=") && pending--);
	page.on("requestfailed", (r) => r.url().includes("offset=") && pending--);
	const t0 = Date.now();
	await page.goto(BASE + path, { waitUntil: "networkidle0" });
	await page.evaluate(() => {
		window.__long = [];
		new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__long.push(e.duration))).observe({ type: "longtask", buffered: true });
	});
	const stats = () =>
		page.evaluate(() => ({
			nodes: document.getElementsByTagName("*").length,
			tiles: document.querySelectorAll("div.group").length,
			imgs: document.images.length,
			height: document.documentElement.scrollHeight,
			heapMB: Math.round(performance.memory.usedJSHeapSize / 1048576),
		}));
	const first = await stats();
	let max = { ...first };
	// 一屏一屏往下滚，直到高度不再增长（所有分页都加载完）
	let still = 0;
	let lastHeight = 0;
	while (still < 50) {
		await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
		await new Promise((r) => setTimeout(r, 30));
		const s = await stats();
		for (const k of Object.keys(max)) max[k] = Math.max(max[k], s[k]);
		const atBottom = await page.evaluate(() => scrollY + innerHeight >= document.documentElement.scrollHeight - 5);
		if (atBottom && !pending && s.height === lastHeight) still++;
		else still = 0;
		lastHeight = s.height;
	}
	await page.screenshot({ path: `${OUT}/${path.replaceAll("/", "_")}-bottom.png` });
	// 跳回顶部和中间，看虚拟化后格子还在
	await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight / 2));
	await new Promise((r) => setTimeout(r, 300));
	const mid = await stats();
	await page.screenshot({ path: `${OUT}/${path.replaceAll("/", "_")}-middle.png` });
	const long = await page.evaluate(() => window.__long);
	const result = {
		path,
		seconds: Math.round((Date.now() - t0) / 1000),
		listRequests,
		first,
		max,
		mid,
		longTasks: long.length,
		longestMs: Math.round(Math.max(0, ...long)),
		errors,
	};
	console.log(JSON.stringify(result));
	if (errors.length || mid.tiles + mid.imgs === 0) failures++;
	await page.close();
}
await browser.close();
process.exit(failures ? 1 : 0);
