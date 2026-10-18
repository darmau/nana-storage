// 首页文案。中文是源语言，英文同样的结构（类型检查保证两边字段一致）。
import { DEFAULT_MONTHLY_BUDGET_USD } from "../lib/cost";

const zh = {
	lang: "zh-CN",
	title: "那时 · 装在自己 Cloudflare 上的私人相册",
	description: "一个只给自己用的开源相册，用起来像 Google Photos，照片存在你自己的 Cloudflare 账号里。每月 $5 起，处理费用有上限。",
	nav: { docs: "文档", deploy: "部署", github: "GitHub", switchLang: "English", switchHref: "en/" },
	hero: {
		eyebrow: "开源 · 自托管 · 只给一个人用",
		title: ["像 Google Photos，", "但装在你自己的 Cloudflare 上"],
		lead: "那时是一个开源相册，部署在你自己的 Cloudflare 账号上。照片存在你的 R2 里，只有你本人登录后能看。每月 $5 起，处理费用超过你定的上限就自动停下。",
		primary: "开始部署",
		secondary: "在 GitHub 上查看",
		stack: ["Workers", "R2", "D1", "Access", "Containers", "Vectorize"],
	},
	pillars: [
		{
			kicker: "数据",
			title: "照片在你自己的账号里",
			body: "原图、缩略图和数据库都建在你的 Cloudflare 账号下，我们这边没有任何服务器。你也不用租 VPS、换硬盘、打系统补丁。",
		},
		{
			kicker: "安全",
			title: "只有你能打开",
			body: "整个站点挡在 Cloudflare Access 登录后面，Worker 还会对每个请求再核对一次是不是你。存储桶不公开，也不生成分享链接。",
		},
		{
			kicker: "成本",
			title: "账单有上限",
			body: `容器费用每月有上限，默认 $${DEFAULT_MONTHLY_BUDGET_USD}，到了就暂停处理，等你决定。会反复触发自己的写法（死循环、重试风暴）在代码里就避开了，每次部署前都有自动检查。`,
		},
	],
	features: {
		title: "日常用得到的都做了",
		lead: "按 5 万张照片的资料库设计，时间线只渲染屏幕附近的格子，拖到哪里都不卡。",
		items: [
			{ id: "timeline", title: "时间线", body: "按拍摄日期排列。拖右边的滚动条可以直接跳到某年某月，连拍会叠成一张。" },
			{ id: "viewer", title: "查看器", body: "Live Photo 会动，视频尽量播原件。放大时换成原图，HEIC 和 RAW 也能看到全分辨率。" },
			{ id: "organize", title: "文件夹与相册", body: "上传整个文件夹会保留目录结构。另有相册、收藏和回收站，选中一批可以移动或打包下载。" },
			{ id: "map", title: "地图", body: "在地图上按位置看照片，地名跟着界面语言走。底图用 OpenFreeMap，免费，不用申请 key。" },
			{ id: "people", title: "人物", body: "自动认出照片里的人脸并按人归类，你来命名、合并、纠正。人脸数据只存在你自己的数据库里。" },
			{ id: "similar", title: "相似与重复", body: "找出重复的照片，看和某一张相似的照片。还可以教它认一类东西，比如家里的狗，它把像的挑出来给你确认。" },
			{ id: "edit", title: "编辑", body: "旋转、裁切、给某块区域打码，改拍摄时间、时区和位置。编辑只改缩略图和预览，原图不动。" },
			{ id: "stats", title: "统计数据", body: "每年每月拍了多少、用的哪台相机、哪些文件最占地方，还有这个月花了多少钱。" },
		],
		pwa: "可以添加到手机主屏幕当 App 用，有深色模式，界面有中文和英文。",
		mockNote: "示意图",
	},
	cost: {
		kicker: "成本",
		title: "要花多少钱",
		lead: "固定开销只有 Cloudflare 的 Workers Paid 套餐。存储按用量算；每张照片只在上传后处理一次，处理费也只付这一次。",
		head: { photos: "照片数", storage: "存储", plan: "Workers Paid", r2: "R2 存储", vectorize: "Vectorize", total: "每月合计", import: "一次性导入" },
		photos: (n: number) => `${n.toLocaleString("zh-CN")} 张`,
		perMonth: "/ 月",
		assume: (o: number, d: number, s: number) =>
			`按每张原件 ${o} MB、缩略图和预览 ${d} MB、每张 ${s} 秒容器时间估算，已扣除 Workers Paid 包含的免费额度。请求数、D1 读写等按次计费的项在正常使用下都在免费额度内。以 Cloudflare 账单为准。`,
		capNote: (cap: number) =>
			`一次性导入是在一个月内全部交给云端容器处理的费用。超过月度上限（默认 $${cap}）时处理会暂停：可以调高上限、分几个月导入，或者用设备端处理（不花容器费用）。`,
		guard: {
			title: "到上限就停",
			body: `应用自己记账。这个月容器的估算费用到了上限（默认 $${DEFAULT_MONTHLY_BUDGET_USD}，设置里能改），后台处理和上传就暂停。上传之前也会先估一下这一批大概多少钱，太贵的话会建议你用自己的电脑处理。`,
		},
	},
	device: {
		kicker: "设备端处理",
		title: "照片很多？用自己的电脑处理",
		body: "在自己的电脑上用 Docker 跑和云端一样的处理程序，不花容器费用。如果原图本来就在这台电脑上，它直接读本地文件，不用再从云端下载。",
		points: ["和云端同一套代码、同一套模型", "用你自己的 Access 账号登录，不另发令牌", "电脑关掉后大约 2 分钟，云端接着处理"],
		cta: "设备端处理怎么用",
	},
	privacy: {
		kicker: "隐私",
		title: "不经过第三方，也不收集使用数据",
		items: [
			{ title: "地图底图是唯一的外部请求", body: "OpenFreeMap 会知道你看了地图的哪一块，但看不到照片。" },
			{ title: "人脸和名字只在你的数据库里", body: "识别在你自己的容器里跑，不调用外部服务。" },
			{ title: "日志里只有 ID", body: "不记文件名、GPS、描述，也不记人名。" },
			{ title: "处理照片的容器不联网", body: "模型在构建镜像时就下载好，版本和校验和都是固定的。" },
		],
	},
	deploy: {
		kicker: "部署",
		title: "部署一次，之后自己更新",
		steps: [
			{ title: "Fork 仓库", body: "一个文件都不用改。你的域名和资源 ID 不会写进仓库。", code: "github.com/darmau/nana-storage → Fork" },
			{ title: "运行 setup", body: "自动创建存储、数据库、队列和登录保护。中途出错再跑一遍就行。", code: "pnpm install && pnpm run setup" },
			{ title: "连上 Workers Builds", body: "以后每次推送到 main，都会自动跑测试、迁移数据库、部署。", code: "NANA_DOMAIN=photos.example.com" },
		],
		after: "之后想更新，在 GitHub 上点一下 Sync fork，或者打开仓库自带的同步工作流。",
		cta: "阅读部署文档",
		req: "需要：Cloudflare Workers Paid（$5 / 月）、一个托管在 Cloudflare 的域名、Node 24。",
	},
	compare: {
		title: "和其他方案比",
		cols: ["那时", "Google Photos / iCloud", "服务器自托管"],
		rows: [
			{ label: "照片在谁手里", cells: ["你的 Cloudflare 账号", "服务商", "你的服务器"] },
			{ label: "要维护什么", cells: ["几乎不用", "不用", "服务器、磁盘、备份、更新"] },
			{ label: "费用", cells: ["$5 / 月起，按量", "按容量订阅", "硬件 + 电费 / VPS"] },
			{ label: "从外网访问", cells: ["直接能用，有登录保护", "直接能用", "要自己配反代和证书"] },
			{ label: "多用户、共享", cells: ["不支持，只给一个人用", "支持", "多数支持"] },
		],
	},
	footer: {
		license: "AGPL-3.0 开源。人脸识别模型（InsightFace）只允许非商业使用，可以在构建时关闭。",
		links: { docs: "文档", github: "GitHub", security: "报告安全问题", changelog: "更新记录" },
		credit: "示例照片来自公有领域 / CC0 作品，见致谢。",
	},
};

export type HomeMessages = typeof zh;

const en: HomeMessages = {
	lang: "en",
	title: "Nana · A private photo library on your own Cloudflare",
	description:
		"An open-source photo library for one person. It works much like Google Photos, and the photos stay in your own Cloudflare account. From $5 a month, with a cap on processing costs.",
	nav: { docs: "Docs", deploy: "Deploy", github: "GitHub", switchLang: "简体中文", switchHref: "" },
	hero: {
		eyebrow: "Open source · Self-hosted · For one person",
		title: ["Like Google Photos,", "but on your own Cloudflare"],
		lead: "Nana is an open-source photo library you deploy to your own Cloudflare account. Your photos live in your R2 bucket and only you can sign in to see them. It starts at $5 a month, and processing stops by itself if it ever hits the spending cap you set.",
		primary: "Deploy it",
		secondary: "View on GitHub",
		stack: ["Workers", "R2", "D1", "Access", "Containers", "Vectorize"],
	},
	pillars: [
		{
			kicker: "Data",
			title: "Photos stay in your account",
			body: "Originals, thumbnails and the database are all created under your Cloudflare account. We don't run a server of our own. And you don't rent a VPS, swap disks or patch an OS.",
		},
		{
			kicker: "Security",
			title: "Only you can open it",
			body: "The whole site sits behind a Cloudflare Access login, and the Worker checks again on every request that it's really you. The bucket is private and there are no share links.",
		},
		{
			kicker: "Cost",
			title: "The bill has a ceiling",
			body: `Container spend has a monthly cap, $${DEFAULT_MONTHLY_BUDGET_USD} by default. When it's reached, processing pauses until you decide. Code that could trigger itself in a loop or retry endlessly is kept out, and checked automatically before every deploy.`,
		},
	],
	features: {
		title: "What it does",
		lead: "Built for libraries of 50,000 photos. The timeline only draws what's near the screen, so it stays smooth wherever you scroll.",
		items: [
			{ id: "timeline", title: "Timeline", body: "Sorted by when each photo was taken. Drag the scrubber on the right to jump to any month. Bursts stack into one." },
			{ id: "viewer", title: "Viewer", body: "Live Photos move, and videos play the original when your browser can. Zoom in and the full-resolution image loads, HEIC and RAW too." },
			{ id: "organize", title: "Folders & albums", body: "Upload a whole folder and its structure is kept. There are albums, favorites and a trash too. Select a batch to move it or download it as a zip." },
			{ id: "map", title: "Map", body: "See photos by where they were taken, with place names in your language. The base map is OpenFreeMap: free, no key to sign up for." },
			{ id: "people", title: "People", body: "Faces are found and grouped by person. You name, merge and correct them. Face data stays in your own database." },
			{ id: "similar", title: "Similar & duplicates", body: "Find duplicate photos and ones that look like a given shot. You can also teach it a subject, say your dog, and it picks out likely matches for you to confirm." },
			{ id: "edit", title: "Editing", body: "Rotate, crop, blur out part of a photo, fix the date, time zone and location. Edits change the thumbnail and preview; the original file stays as it was." },
			{ id: "stats", title: "Statistics", body: "How many photos you took each month, with which camera, which files take the most space, and what this month has cost." },
		],
		pwa: "Add it to your phone's home screen and use it like an app. Dark mode, English and 简体中文.",
		mockNote: "Illustration",
	},
	cost: {
		kicker: "Cost",
		title: "What it costs",
		lead: "The only fixed cost is Cloudflare's Workers Paid plan. Storage is billed by use. Each photo is processed once after upload, so you pay for processing once.",
		head: { photos: "Photos", storage: "Storage", plan: "Workers Paid", r2: "R2 storage", vectorize: "Vectorize", total: "Per month", import: "One-time import" },
		photos: (n: number) => n.toLocaleString("en-US"),
		perMonth: "/ mo",
		assume: (o: number, d: number, s: number) =>
			`Assumes ${o} MB per original, ${d} MB of thumbnails and previews, and ${s} seconds of container time per photo, after the free allowance included in Workers Paid. Per-request items (requests, D1 reads and writes) stay within the free allowance in normal use. Your Cloudflare bill is authoritative.`,
		capNote: (cap: number) =>
			`The one-time import is what it costs if cloud containers process everything within one month. Above your monthly cap ($${cap} by default) processing pauses: raise the cap, spread the import over a few months, or process on your own computer (no container cost).`,
		guard: {
			title: "It stops at the cap",
			body: `The app keeps its own books. When this month's estimated container spend reaches your cap ($${DEFAULT_MONTHLY_BUDGET_USD} by default, change it in Settings), processing and uploads pause. Before an upload it also estimates what the batch will cost, and if that's a lot, suggests processing on your own computer.`,
		},
	},
	device: {
		kicker: "On-device processing",
		title: "Lots of photos? Process them on your own computer",
		body: "Run the same processing program the cloud uses, on your computer with Docker, and pay nothing for containers. If the originals are already on that computer, it reads them from disk instead of downloading them again.",
		points: ["Same code and the same models as the cloud", "Signs in with your own Access account, no extra tokens", "Turn it off and the cloud picks up again in about 2 minutes"],
		cta: "How on-device processing works",
	},
	privacy: {
		kicker: "Privacy",
		title: "Nothing is sent to anyone else",
		items: [
			{ title: "The base map is the only outside request", body: "OpenFreeMap can tell which part of the map you're looking at. It can't see your photos." },
			{ title: "Faces and names stay in your database", body: "Recognition runs in your own container and calls no outside service." },
			{ title: "Logs only contain IDs", body: "No file names, GPS, descriptions, or people's names." },
			{ title: "The processing container is offline", body: "Models are downloaded when the image is built, pinned to a version and checksum." },
		],
	},
	deploy: {
		kicker: "Deploy",
		title: "Deploy once, then it keeps itself up to date",
		steps: [
			{ title: "Fork the repository", body: "You don't edit a single file. Your domain and resource IDs never end up in the repository.", code: "github.com/darmau/nana-storage → Fork" },
			{ title: "Run setup", body: "Creates the storage, database, queues and login gate. If something fails halfway, just run it again.", code: "pnpm install && pnpm run setup" },
			{ title: "Connect Workers Builds", body: "From then on, every push to main runs the tests, migrates the database and deploys.", code: "NANA_DOMAIN=photos.example.com" },
		],
		after: "To update later, click Sync fork on GitHub, or turn on the sync workflow that comes with the repository.",
		cta: "Read the deploy guide",
		req: "You need: Cloudflare Workers Paid ($5 / month), a domain on Cloudflare, Node 24.",
	},
	compare: {
		title: "How it compares",
		cols: ["Nana", "Google Photos / iCloud", "Self-hosted on a server"],
		rows: [
			{ label: "Who holds the photos", cells: ["Your Cloudflare account", "The provider", "Your server"] },
			{ label: "Maintenance", cells: ["Almost none", "None", "Server, disks, backups, updates"] },
			{ label: "Price", cells: ["From $5 / month, usage-based", "Storage subscription", "Hardware + power / VPS"] },
			{ label: "Access from anywhere", cells: ["Works out of the box, behind a login", "Works out of the box", "Set up a proxy and TLS yourself"] },
			{ label: "Multiple users, sharing", cells: ["No, it's for one person", "Yes", "Mostly yes"] },
		],
	},
	footer: {
		license: "Open source under AGPL-3.0. The face recognition model (InsightFace) is for non-commercial use only and can be left out at build time.",
		links: { docs: "Docs", github: "GitHub", security: "Report a vulnerability", changelog: "Changelog" },
		credit: "Sample photos are public domain / CC0 works; see Credits.",
	},
};

export const HOME = { zh, en };
