// 资料库界面流程测试（无头 Chrome），需要先运行 scripts/e2e-upload.mjs：node scripts/perf/library-ui.mjs <截图输出目录>
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
page.on("dialog", (d) => d.accept());
let failures = 0;
const check = (ok, label, detail = "") => {
	console.log(`${ok ? "✓" : "✗"} ${label}${detail ? `  ${detail}` : ""}`);
	if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clickText = async (text, scope = "body") => {
	const ok = await page.evaluate(
		(text, scope) => {
			const el = [...document.querySelector(scope).querySelectorAll("button, a")].find((b) => b.textContent.trim().startsWith(text));
			if (el) el.click();
			return !!el;
		},
		text,
		scope,
	);
	if (!ok) throw new Error(`no button "${text}"`);
	await sleep(400);
};
// 多选栏只直接放收藏、加入相册、删除，其余在“更多”菜单里
const clickMore = async (text) => {
	await page.click('[role="toolbar"] button[aria-label="更多操作"]');
	await sleep(200);
	await clickText(text, '[role="menu"]');
};
const tileCount = () => page.evaluate(() => document.querySelectorAll("div.group").length);
const folderCards = () =>
	page.evaluate(() => [...document.querySelectorAll("ul li a")].map((a) => a.querySelector("div.truncate")?.textContent + " | " + a.innerText.split("\n").at(-1)));
const openFolder = (name) =>
	page.evaluate((name) => [...document.querySelectorAll("ul li a")].find((a) => a.querySelector("div.truncate")?.textContent === name).click(), name);
const selectTiles = async (n) => {
	const boxes = await page.$$('div.group > button[aria-label="选择"]:last-of-type');
	for (const b of boxes.slice(0, n)) await b.evaluate((el) => el.click());
	await sleep(300);
};

// 1. 时间线：选中 2 张，新建相册并加入
await page.goto(BASE + "/", { waitUntil: "networkidle0" });
await page.waitForSelector("#timeline img");
await selectTiles(2);
check((await page.evaluate(() => document.body.innerText.includes("已选 2"))), "selection bar shows 2 selected");
await page.screenshot({ path: `${OUT}/lib-selection.png` });
await clickText("加入相册");
await page.type('[role="dialog"] input', "测试相册");
await clickText("新建并加入", '[role="dialog"]');
await sleep(800);
await page.goto(BASE + "/albums", { waitUntil: "networkidle0" });
const albumCard = await page.evaluate(() => document.querySelector("ul li a")?.innerText);
check(albumCard?.includes("测试相册") && /2 张照片|1 张照片 · 1 个视频|2 个视频/.test(albumCard), "album created with 2 items", JSON.stringify(albumCard));
await page.screenshot({ path: `${OUT}/lib-albums.png` });

// 2. 相册里移出一张
await page.click("ul li a");
await page.waitForSelector("div.group img");
await sleep(500);
await selectTiles(1);
await clickMore("移出相册");
await sleep(800);
check((await tileCount()) === 1, "removed one from album", `tiles=${await tileCount()}`);

// 3. 文件夹：根目录下有上传时建的“测试”，再在里面新建“子文件夹”
await page.goto(BASE + "/folders/root", { waitUntil: "networkidle0" });
const rootFolders = await folderCards();
check(rootFolders.some((f) => f.startsWith("测试 |")), "root lists uploaded folder", JSON.stringify(rootFolders));
await openFolder("测试");
await sleep(800);
await clickText("新建文件夹");
await page.type('[role="alertdialog"] input', "子文件夹");
await clickText("新建", '[role="alertdialog"]');
await sleep(800);
const sub = await folderCards();
check(sub.some((f) => f.startsWith("2024 |")) && sub.some((f) => f.startsWith("子文件夹 |")), "created subfolder", JSON.stringify(sub));
await page.screenshot({ path: `${OUT}/lib-folders.png` });

// 4. 时间线选 1 张 → 移到“测试/子文件夹”
await page.goto(BASE + "/", { waitUntil: "networkidle0" });
await page.waitForSelector("#timeline img");
await selectTiles(1);
await clickMore("移到文件夹");
await clickText("📁 测试", '[role="dialog"]');
await sleep(500);
await clickText("📁 子文件夹", '[role="dialog"]');
await sleep(500);
await clickText("移到", '[role="dialog"] > button, [role="dialog"]');
await sleep(800);
await page.goto(BASE + "/folders/root", { waitUntil: "networkidle0" });
await openFolder("测试");
await sleep(800);
const subCount = (await folderCards()).find((f) => f.startsWith("子文件夹 |"));
check(subCount?.includes("1 项"), "moved into subfolder", JSON.stringify(subCount));

// 5. 删除 → 回收站 → 在查看器里恢复
await page.goto(BASE + "/", { waitUntil: "networkidle0" });
await page.waitForSelector("#timeline img");
const before = await tileCount();
await selectTiles(1);
await clickText("删除");
check(!!(await page.$('[role="alertdialog"]')), "delete asks for confirmation");
await clickText("删除", '[role="alertdialog"]');
await sleep(1000);
check((await tileCount()) === before - 1, "trashed item leaves the timeline", `${before} → ${await tileCount()}`);
await page.goto(BASE + "/trash", { waitUntil: "networkidle0" });
await page.waitForSelector("div.group img");
check((await tileCount()) === 1, "trash lists it");
await page.screenshot({ path: `${OUT}/lib-trash.png` });
await page.click('div.group > button[aria-label="打开"]');
await page.waitForSelector('[role="dialog"]');
await sleep(500);
await page.click('[role="dialog"] button[aria-label="恢复"]');
await sleep(1200);
check(!(await page.$('[role="dialog"]')), "viewer closes after restoring the last item");
await page.goto(BASE + "/trash", { waitUntil: "networkidle0" });
await sleep(500);
check(await page.evaluate(() => document.body.innerText.includes("回收站是空的")), "trash is empty again");

// 6. 查看器里按 f 收藏 → 收藏页
await page.goto(BASE + "/", { waitUntil: "networkidle0" });
await page.waitForSelector("#timeline img");
await page.click('div.group > button[aria-label="打开"]');
await page.waitForSelector('[role="dialog"]');
await sleep(600);
await page.keyboard.press("f");
await sleep(1000);
const favLabel = await page.$eval('[role="dialog"] button[aria-label="取消收藏"]', () => true).catch(() => false);
check(favLabel, "viewer heart toggles to favorited");
await page.keyboard.press("Escape");
await page.goto(BASE + "/favorites", { waitUntil: "networkidle0" });
await sleep(500);
check((await tileCount()) === 1, "favorites lists it");

// 7. 批量下载：会发起 /api/downloads/<token> 的 GET
await page.goto(BASE + "/", { waitUntil: "networkidle0" });
await page.waitForSelector("#timeline img");
const cdp = await page.createCDPSession();
await cdp.send("Browser.setDownloadBehavior", { behavior: "deny" });
let downloadRequested = false;
page.on("request", (r) => r.url().includes("/api/downloads/") && r.method() === "GET" && (downloadRequested = true));
await selectTiles(3);
await clickMore("下载");
await sleep(1500);
check(downloadRequested, "download link opened");
check(await page.evaluate(() => document.body.innerText.includes("正在下载")), "download message shown");

// 8. 手机宽度：导航可以横向滚动，页面本身不能横向溢出
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
await page.goto(BASE + "/folders/root", { waitUntil: "networkidle0" });
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
check(!overflow, "no horizontal page overflow on mobile");
await page.screenshot({ path: `${OUT}/lib-mobile.png` });

console.log("page errors:", errors);
console.log(failures ? `${failures} failed` : "all passed");
await browser.close();
process.exit(failures ? 1 : 0);
