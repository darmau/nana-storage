#!/usr/bin/env node
// 官网和文档的截图：对着导入了示例照片的本地实例（seed-demo.mjs），用本机 Chrome 无头截图。
//   node site/scripts/screenshots.mjs [http://localhost:8787]
// 输出 site/src/assets/screenshots/{id}-{light|dark}-{zh|en}.webp，构建时 Astro 再缩放压缩。
// 人物、相似照片依赖 Vectorize，本地没有，不截（官网用示意图）。
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";

const BASE = process.argv[2] ?? "http://localhost:8787";
const OUT = new URL("../src/assets/screenshots/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (path) => (await fetch(BASE + path)).json();

// 挑一张横图做查看器 / 编辑的示例，再找文件夹 Travel 的 id
const buckets = await get("/api/timeline/buckets");
const months = (buckets.items ?? buckets).map((b) => b.month ?? b[0]).filter(Boolean);
let sample = null;
for (const m of months) {
	const items = await get(`/api/timeline/month/${m}`);
	const wide = (items.items ?? items).find((i) => i[1] > i[2] * 1.3);
	if (wide && m.startsWith("2024-10")) {
		sample = { id: wide[0], month: m };
		break;
	}
	if (wide && !sample) sample = { id: wide[0], month: m };
}
const root = await get("/api/folders/root");
const travel = (root.children ?? root.folders ?? []).find((f) => f.name === "Travel");
console.log({ sample, travel: travel?.id, months: months.length });

/** id、地址、视口、截图前要做的事。 */
const SHOTS = [
	{ id: "hero", path: "/", w: 1440, h: 810 },
	{ id: "timeline", path: "/", w: 1280, h: 800, scroll: 900 },
	{ id: "viewer", path: `/?a=${sample.id}&m=${sample.month}`, w: 1280, h: 800, viewer: true },
	{ id: "info", path: `/?a=${sample.id}&m=${sample.month}`, w: 1280, h: 800, viewer: true, key: "i", wait: 2500 },
	{ id: "edit", path: `/?a=${sample.id}&m=${sample.month}`, w: 1280, h: 800, viewer: true, key: "e", wait: 1500 },
	{ id: "organize", path: travel ? `/folders/${travel.id}` : "/folders/root", w: 1280, h: 800 },
	{ id: "albums", path: "/albums", w: 1280, h: 800 },
	{ id: "map", path: "/map", w: 1280, h: 800, wait: 4000 },
	{ id: "search", path: "/search", w: 1280, h: 800 },
	{ id: "processing", path: "/settings/processing", w: 1280, h: 800 },
	{ id: "guard", path: "/settings/guard", w: 1280, h: 800 },
	{ id: "mobile", path: "/", w: 390, h: 844, mobile: true },
];

const browser = await puppeteer.launch({
	executablePath: process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	headless: true,
});
let failures = 0;
for (const lang of ["zh", "en"]) {
	for (const theme of ["light", "dark"]) {
		const page = await browser.newPage();
		await page.evaluateOnNewDocument(
			(lang, theme) => {
				localStorage.setItem("nana:lang", lang === "zh" ? "zh-CN" : "en");
				localStorage.setItem("nana:theme", theme);
			},
			lang,
			theme,
		);
		await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
		for (const s of SHOTS) {
			try {
				await page.setViewport({ width: s.w, height: s.h, deviceScaleFactor: s.mobile ? 3 : 1.5, isMobile: !!s.mobile, hasTouch: !!s.mobile });
				await page.goto(BASE + s.path, { waitUntil: "networkidle0", timeout: 60_000 });
				if (s.viewer) {
					await page.waitForSelector('[role="dialog"]');
					// 等预览真正显示出来
					await page.waitForFunction(
						() => [...document.querySelectorAll('[role="dialog"] img')].some((i) => i.src.includes("/preview") && i.complete && i.naturalWidth > 0),
						{ timeout: 20_000 },
					);
				}
				if (s.scroll) await page.evaluate((y) => window.scrollTo(0, y), s.scroll);
				if (s.key) await page.keyboard.press(s.key);
				await sleep(s.wait ?? 1200);
				// 鼠标移出页面，避免悬停状态
				await page.mouse.move(1, s.h - 1);
				await page.screenshot({ path: `${OUT}${s.id}-${theme}-${lang}.webp`, type: "webp", quality: 88 });
				process.stdout.write(`✓ ${s.id}-${theme}-${lang}\n`);
			} catch (e) {
				failures++;
				console.log(`✗ ${s.id}-${theme}-${lang}: ${e.message}`);
			}
		}
		await page.close();
	}
}
await browser.close();
process.exit(failures ? 1 : 0);
