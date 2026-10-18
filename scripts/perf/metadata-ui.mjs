// 编辑元数据与搜索的界面测试（无头 Chrome），需要先运行 scripts/e2e-upload.mjs：node scripts/perf/metadata-ui.mjs <截图输出目录>
import puppeteer from "puppeteer-core";
const OUT = process.argv[2];
const BASE = "http://localhost:8787";
const browser = await puppeteer.launch({
	executablePath: process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	headless: true,
});
const page = await browser.newPage();
// 选择器靠中文文案定位，界面语言固定为简体中文（无头 Chrome 默认是英文）
await page.evaluateOnNewDocument(() => localStorage.setItem("nana:lang", "zh-CN"));
await page.setViewport({ width: 1280, height: 860 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
let failures = 0;
const check = (ok, label, detail = "") => {
	console.log(`${ok ? "✓" : "✗"} ${label}${detail ? `  ${detail}` : ""}`);
	if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (path, init) => (await fetch(BASE + "/api" + path, init)).json();
const clickIn = (scope, text) =>
	page.evaluate((scope, text) => {
		const el = [...document.querySelector(scope).querySelectorAll("button")].find((b) => b.textContent.trim() === text);
		el?.click();
		return !!el;
	}, scope, text);

const month = await api("/timeline/month/2024-05");
const photo = month.find((i) => i[3] === 0); // 普通照片
check(!!photo, "found a photo to edit", photo?.[0]);
const id = photo[0];

// 1. 描述：输入后失焦保存，然后能搜到
await page.goto(`${BASE}/?a=${id}&m=2024-05`, { waitUntil: "networkidle0" });
await page.waitForSelector('[role="dialog"]');
await page.keyboard.press("i");
await page.waitForSelector("aside textarea");
const desc = `外滩夜景${Date.now()}`; // 每次运行都不同，测试可以重复跑
await page.type("aside textarea", desc);
await page.click("aside h2"); // 失焦
await sleep(1000);
check((await api(`/assets/${id}`)).description === desc, "description saved on blur");
const found = await api(`/search?q=${encodeURIComponent(desc)}`);
check(found.items.length === 1 && found.items[0][0] === id, "description is searchable");

// 2. 时间：改到 2023-12-31 23:30 UTC-05:00 → 出现在 2023 年 12 月
await clickIn("aside", "修改");
await page.waitForSelector('aside input[type="datetime-local"]');
await page.$eval('aside input[type="datetime-local"]', (el) => {
	const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
	set.call(el, "2023-12-31T23:30:00");
	el.dispatchEvent(new Event("input", { bubbles: true }));
});
await page.select('aside select[aria-label="拍摄地时区"]', "-300");
await clickIn("aside", "保存");
await sleep(1000);
const edited = await api(`/assets/${id}`);
check(edited.local_day === "2023-12-31" && edited.tz_offset_min === -300 && new Date(edited.taken_at).toISOString() === "2024-01-01T04:30:00.000Z", "time edited with timezone", `${edited.local_day} ${edited.tz_offset_min}`);
check((await api("/timeline/month/2023-12")).some((i) => i[0] === id), "moved to 2023-12 in the timeline");
check(await page.evaluate(() => document.querySelector("aside").innerText.includes("UTC-05:00")), "panel shows the new time with timezone");

// 3. 位置：粘贴坐标
const locButton = await page.evaluate(() => {
	const b = [...document.querySelectorAll("aside button")].find((b) => ["修改", "添加"].includes(b.textContent.trim()) && b.closest("div").innerText.startsWith("位置"));
	b?.click();
	return !!b;
});
check(locButton, "opened location editor");
await page.waitForSelector('aside input[placeholder^="纬度"]');
await page.$eval('aside input[placeholder^="纬度"]', (el) => {
	const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
	set.call(el, "35.6812, 139.7671");
	el.dispatchEvent(new Event("input", { bubbles: true }));
});
await clickIn("aside", "保存");
await sleep(800);
const loc = await api(`/assets/${id}`);
check(loc.lat === 35.6812 && loc.lon === 139.7671 && loc.meta_locked === 7, "location saved, all three fields locked", `meta_locked=${loc.meta_locked}`);
await page.screenshot({ path: `${OUT}/meta-panel.png` });

// 4. 编辑（旋转 + 裁切）：编辑界面里转一次、把裁切框右下角往里拖 → 完成 → 先用 CSS 显示结果 → 后台生成后换成新图
const before = await page.evaluate(() => {
	const img = [...document.querySelectorAll('[role="dialog"] img')].find((i) => i.src.includes("/preview"));
	return `${img.naturalWidth}x${img.naturalHeight}`;
});
await page.click('[role="dialog"] button[aria-label="编辑"]');
await page.waitForSelector('[role="dialog"][aria-label="编辑"] .cursor-move');
await sleep(300);
await page.click('[aria-label="编辑"] button[aria-label="旋转"]');
await sleep(200);
const frame = await page.$eval('[aria-label="编辑"] .cursor-move', (el) => {
	const r = el.getBoundingClientRect();
	return { x: r.right, y: r.bottom, w: r.width, h: r.height };
});
await page.mouse.move(frame.x, frame.y);
await page.mouse.down();
await page.mouse.move(frame.x - frame.w / 2, frame.y - frame.h / 4, { steps: 5 });
await page.mouse.up();
await clickIn('[role="dialog"][aria-label="编辑"]', "完成");
await sleep(300);
const cssRotated = await page.evaluate(() => [...document.querySelectorAll('[role="dialog"] img')].some((i) => i.style.transform.includes("rotate(90deg)")));
check(cssRotated, "shows the edit with CSS while the new preview is generated");
let after = before;
let replaced = false;
for (let i = 0; i < 40; i++) {
	await sleep(1000);
	const s = await page.evaluate(() => {
		const img = [...document.querySelectorAll('[role="dialog"] img')].find((i) => i.src.includes("/preview") && i.src.includes("&b="));
		const rotated = [...document.querySelectorAll('[role="dialog"] img')].some((i) => i.style.transform.includes("rotate("));
		return { dims: img && img.complete ? `${img.naturalWidth}x${img.naturalHeight}` : "", rotated };
	});
	if (!s.rotated && s.dims) {
		after = s.dims;
		replaced = true;
		break;
	}
}
const [bw, bh] = before.split("x").map(Number);
const [aw, ah] = after.split("x").map(Number);
// 转了 90°，再裁掉右边一半、下面四分之一（以转过之后的方向算）
check(replaced && Math.abs(aw - bh / 2) <= 2 && Math.abs(ah - (bw * 3) / 4) <= 2, "the generated preview is rotated and cropped", `${before} → ${after}`);
const rot = await api(`/assets/${id}`);
check(
	rot.rotation === 90 && rot.width < rot.height === bw > bh && Math.abs(rot.crop_w - 0.5) < 0.02 && Math.abs(rot.crop_h - 0.75) < 0.02,
	"server stored rotation, crop and swapped dimensions",
	`${rot.width}x${rot.height} crop ${rot.crop_w}x${rot.crop_h}`,
);
await page.screenshot({ path: `${OUT}/meta-edited.png` });

// 5. 搜索页：文件名 + 类型筛选
await page.goto(`${BASE}/search`, { waitUntil: "networkidle0" });
await page.type('input[type="search"]', "IMG_0003");
await sleep(1500);
const res1 = await page.evaluate(() => document.querySelectorAll("div.group").length);
const expected1 = (await api("/search?q=IMG_0003")).items.length;
check(res1 > 0 && res1 === expected1, "search by file name", `results=${res1} api=${expected1}`);
await page.$eval('input[type="search"]', (el) => {
	const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
	set.call(el, "");
	el.dispatchEvent(new Event("input", { bubbles: true }));
});
await page.select('select[aria-label="类型"]', "video");
await sleep(1500);
const res2 = await page.evaluate(() => document.querySelectorAll("div.group").length);
const expected2 = (await api("/search?kind=video")).items.length;
check(res2 > 0 && res2 === expected2, "filter by type", `results=${res2} api=${expected2}`);
await page.screenshot({ path: `${OUT}/meta-search.png` });

console.log("page errors:", errors);
console.log(failures ? `${failures} failed` : "all passed");
await browser.close();
process.exit(failures ? 1 : 0);
