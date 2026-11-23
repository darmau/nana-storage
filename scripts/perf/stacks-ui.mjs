#!/usr/bin/env node
// 相似照片折叠的界面流程测试（无头 Chrome）。先灌数据并启动本地 wrangler dev：
//   cd apps/worker
//   npx wrangler d1 migrations apply nana-db --local
//   npx wrangler d1 execute nana-db --local --file ../../scripts/perf/seed-50k.sql
//   npx wrangler d1 execute nana-db --local --file ../../scripts/perf/seed-stacks.sql
//   npx wrangler dev
// 然后：node scripts/perf/stacks-ui.mjs <截图输出目录>
// 验证：补建接口分组 → 时间线顶部出现 +N 封面 → 点击原地展开 → 收起 → 展开后打开查看器并前后切换。
import puppeteer from "puppeteer-core";
const OUT = process.argv[2];
const BASE = process.argv[3] ?? "http://localhost:8787";
const headers = { Origin: BASE, "X-Requested-With": "nana", "Content-Type": "application/json" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, label, detail = "") => {
	console.log(`${ok ? "✓" : "✗"} ${label}${detail ? `  ${detail}` : ""}`);
	if (!ok) failures++;
};

// 等 dev 服务器就绪（首次启动要编译）
let ready = false;
for (let i = 0; i < 120 && !ready; i++) {
	try {
		ready = (await fetch(`${BASE}/api/me`, { headers })).status === 200;
	} catch {}
	if (!ready) await sleep(1000);
}
if (!ready) {
	console.error("dev server not ready");
	process.exit(1);
}

// 补建：顺序请求直到 done（测试库一个 chunk 就够）
let r = await (await fetch(`${BASE}/api/stacks/rebuild`, { method: "POST", headers, body: "{}" })).json();
for (let i = 0; i < 100 && !r.done; i++) r = await (await fetch(`${BASE}/api/stacks/rebuild`, { method: "POST", headers, body: "{}" })).json();
check(r.done === true, "backfill done", JSON.stringify(r));

const browser = await puppeteer.launch({
	executablePath: process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	headless: true,
	args: ["--window-size=1440,900", ...(process.env.CHROME_ARGS?.split(" ") ?? [])],
});
const page = await browser.newPage();
await page.goto("about:blank"); // 等主框架就绪，否则 evaluateOnNewDocument 可能报 "Requesting main frame too early"
await page.evaluateOnNewDocument(() => localStorage.setItem("nana:lang", "zh-CN"));
await page.setViewport({ width: 1440, height: 900 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && !m.text().includes("404") && errors.push(m.text()));

await page.goto(BASE + "/", { waitUntil: "networkidle0" });
await page.waitForSelector("#timeline div.group");

// 格子 / 角标 / 收起按钮的统计和点击都靠 DOM 文案定位
const stats = () =>
	page.evaluate(() => {
		const tiles = [...document.querySelectorAll("#timeline div.group")];
		const badges = tiles.filter((t) => [...t.querySelectorAll("span")].some((s) => /^\+\d+$/.test(s.textContent.trim())));
		const collapse = tiles.filter((t) => [...t.querySelectorAll("button")].some((b) => b.textContent.trim() === "收起"));
		return { tiles: tiles.length, badges: badges.map((b) => b.textContent.match(/\+\d+/)[0]), collapse: collapse.length };
	});
const clickTile = async (pred) => {
	const box = await page.evaluate((predSrc) => {
		const pred = new Function("t", `return ${predSrc}`);
		const tiles = [...document.querySelectorAll("#timeline div.group")];
		const el = tiles.find(pred);
		if (!el) return null;
		const r = el.getBoundingClientRect();
		return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
	}, pred);
	if (!box) return false;
	await page.mouse.click(box.x, box.y);
	return true;
};
const hasBadge = `([...t.querySelectorAll("span")].some(s => /^\\+\\d+$/.test(s.textContent.trim())))`;
const hasCollapse = `([...t.querySelectorAll("button")].some(b => b.textContent.trim() === "收起"))`;

let s = await stats();
check(s.badges.includes("+39") && s.badges.includes("+19"), "stack covers at the top", JSON.stringify(s.badges));
await page.screenshot({ path: `${OUT}/stacks-collapsed.png` });
// 虚拟化只渲染视口附近的格子，不能数总格子数：用第一个月份（2026-11）的高度判断展开
const monthHeight = () => page.evaluate(() => document.querySelector("#timeline section")?.getBoundingClientRect().height ?? 0);
const h0 = await monthHeight();

// 点击 +39 的封面：原地展开成 40 张，月份长高，锚点上出现“收起”
check(await clickTile(`(${hasBadge}) && t.textContent.includes("+39")`), "click +39 cover");
await page.waitForFunction(() => [...document.querySelectorAll("#timeline button")].some((b) => b.textContent.trim() === "收起"));
await sleep(300);
s = await stats();
const h1 = await monthHeight();
check(h1 > h0 + 800, "expanded in place (month grew)", `${Math.round(h0)} → ${Math.round(h1)}px`);
check(!s.badges.includes("+39"), "the expanded cover is gone", JSON.stringify(s.badges));
check(s.collapse === 1, "collapse chip on the anchor");
await page.screenshot({ path: `${OUT}/stacks-expanded.png` });

// 展开后打开查看器：点一张成员（不是锚点），→ 切换到下一张，Esc 关闭
check(await clickTile(`!(${hasBadge}) && !(${hasCollapse})`), "open a member in the viewer");
await page.waitForFunction(() => new URL(location.href).searchParams.has("a"));
const a1 = await page.evaluate(() => new URL(location.href).searchParams.get("a"));
await sleep(500);
await page.keyboard.press("ArrowRight");
await sleep(500);
const a2 = await page.evaluate(() => new URL(location.href).searchParams.get("a"));
check(!!a1 && !!a2 && a1 !== a2, "viewer navigates between expanded members", `${a1} → ${a2}`);
await page.screenshot({ path: `${OUT}/stacks-viewer.png` });
await page.keyboard.press("Escape");
await page.waitForFunction(() => !new URL(location.href).searchParams.has("a"));

// 收起：锚点在展开块的末尾，先滚到它再点“收起”按钮本身（格子中心是照片，会打开查看器）
await page.evaluate((src) => {
	const pred = new Function("t", `return ${src}`);
	[...document.querySelectorAll("#timeline div.group")].find(pred)?.scrollIntoView({ block: "center" });
}, hasCollapse);
await sleep(400);
const collapseBox = await page.evaluate(() => {
	const b = [...document.querySelectorAll("#timeline button")].find((b) => b.textContent.trim() === "收起");
	if (!b) return null;
	const r = b.getBoundingClientRect();
	return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
check(!!collapseBox, "collapse chip visible");
if (collapseBox) await page.mouse.click(collapseBox.x, collapseBox.y);
await sleep(300);
s = await stats();
const h2 = await monthHeight();
check(s.badges.includes("+39") && Math.abs(h2 - h0) < 50, "collapsed back", `${JSON.stringify(s.badges)} ${Math.round(h2)}px`);

// 右键菜单里有“不折叠这组”
const menuOk = await page.evaluate(() => {
	const tiles = [...document.querySelectorAll("#timeline div.group")];
	const el = tiles.find((t) => [...t.querySelectorAll("span")].some((s) => s.textContent.trim() === "+39"));
	if (!el) return false;
	const r = el.getBoundingClientRect();
	el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }));
	return true;
});
await sleep(300);
const menuText = await page.evaluate(() => document.body.textContent);
check(menuOk && menuText.includes("不折叠这组") && menuText.includes("相似照片 · 40 张"), "context menu offers unstack");
await page.screenshot({ path: `${OUT}/stacks-menu.png` });
await page.keyboard.press("Escape");

check(errors.length === 0, "no page errors", errors.slice(0, 3).join(" | "));
await browser.close();
console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
