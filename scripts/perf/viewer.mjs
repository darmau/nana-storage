// 查看器测试（无头 Chrome），需要先运行 scripts/e2e-upload.mjs 上传真实样本：node scripts/perf/viewer.mjs <截图输出目录>
import puppeteer from "puppeteer-core";
const OUT = process.argv[2];
const BASE = "http://localhost:8787";
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const page = await browser.newPage();
// 选择器靠中文文案定位，界面语言固定为简体中文（无头 Chrome 默认是英文）
await page.evaluateOnNewDocument(() => localStorage.setItem("nana:lang", "zh-CN"));
await page.setViewport({ width: 1280, height: 800 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

const items = await (await fetch(`${BASE}/api/timeline/month/2024-05`)).json();
const real = items.filter((i) => !i[0].startsWith("SYN"));
console.log("real items in 2024-05:", real.map((i) => `${i[0]} kind=${i[3]}`));
const kinds = { 0: "photo", 1: "video", 2: "live" };

for (const it of real) {
	await page.goto(`${BASE}/?a=${it[0]}&m=2024-05`, { waitUntil: "networkidle0" });
	await page.waitForSelector('[role="dialog"]');
	await new Promise((r) => setTimeout(r, 1500));
	const state = await page.evaluate(() => {
		const d = document.querySelector('[role="dialog"]');
		const img = [...d.querySelectorAll("img")].find((i) => i.src.includes("/preview"));
		const v = d.querySelector("video");
		return {
			preview: img ? { loaded: img.complete && img.naturalWidth > 0, natural: `${img.naturalWidth}x${img.naturalHeight}` } : null,
			video: v ? { src: v.src.replace(location.origin, ""), readyState: v.readyState, paused: v.paused, error: v.error?.code ?? null, currentTime: +v.currentTime.toFixed(2), visible: getComputedStyle(v).opacity } : null,
			hevc: document.createElement("video").canPlayType('video/mp4; codecs="hvc1"'),
		};
	});
	console.log(kinds[it[3]], JSON.stringify(state));
	await page.screenshot({ path: `${OUT}/viewer-${kinds[it[3]]}.png` });
}

// 键盘：→ 切到下一张（更早），i 打开信息，Esc 关闭
await page.goto(`${BASE}/?a=${real[0][0]}&m=2024-05`, { waitUntil: "networkidle0" });
await page.waitForSelector('[role="dialog"]');
const before = new URL(page.url()).searchParams.get("a");
await page.keyboard.press("ArrowRight");
await new Promise((r) => setTimeout(r, 600));
const after = new URL(page.url()).searchParams.get("a");
const idx = (id) => items.findIndex((i) => i[0] === id);
console.log("arrow right:", { from: idx(before), to: idx(after), movedToNext: idx(after) === idx(before) + 1 });
await page.keyboard.press("i");
await new Promise((r) => setTimeout(r, 800));
await page.screenshot({ path: `${OUT}/viewer-info.png` });
const infoShown = await page.evaluate(() => !!document.querySelector('[role="dialog"] aside'));
await page.keyboard.press("Escape");
await new Promise((r) => setTimeout(r, 500));
const closed = await page.evaluate(() => !document.querySelector('[role="dialog"]'));
console.log({ infoShown, closedWithEscape: closed, urlAfterClose: page.url().replace(BASE, "") });

// 从时间线点开 → 浏览器后退应当关闭查看器并回到原来的滚动位置
await page.goto(`${BASE}/`, { waitUntil: "networkidle0" });
await page.evaluate(() => window.scrollTo(0, 5000));
await new Promise((r) => setTimeout(r, 800));
const y0 = await page.evaluate(() => scrollY);
const visible = await page.evaluateHandle(() =>
	[...document.querySelectorAll("#timeline button")].find((b) => { const r = b.getBoundingClientRect(); return r.top > 100 && r.bottom < 700; }),
);
await visible.click();
await page.waitForSelector('[role="dialog"]');
await page.goBack();
await new Promise((r) => setTimeout(r, 800));
const back = await page.evaluate(() => ({ dialog: !!document.querySelector('[role="dialog"]'), y: scrollY }));
console.log("back button", { closed: !back.dialog, scrollKept: Math.abs(back.y - y0) < 5, y0, y: back.y });
console.log("errors", errors);
await browser.close();
