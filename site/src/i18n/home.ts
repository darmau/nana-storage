// 首页文案。中文是源语言，英文同样的结构（类型检查保证两边字段一致）。
import { DEFAULT_MONTHLY_BUDGET_USD } from "../lib/cost";

const zh = {
	lang: "zh-CN",
	title: "那时 · 部署在你自己 Cloudflare 上的私人相册",
	description: "类似 Google Photos 的私人相册，照片存在你自己的 Cloudflare 账号里，只有你能看，账单有硬上限。开源，fork 后几步部署。",
	nav: { docs: "文档", deploy: "部署", github: "GitHub", switchLang: "English", switchHref: "en/" },
	hero: {
		eyebrow: "开源 · 自托管 · 单用户",
		title: ["你的照片，", "留在你自己的云里"],
		lead: "那时是一个部署在你自己 Cloudflare 账号上的私人相册。时间线、地图、人物、相似照片，该有的都有；照片存在你的 R2 里，只有你能打开，账单有硬上限。",
		primary: "开始部署",
		secondary: "在 GitHub 上查看",
		stack: ["Workers", "R2", "D1", "Access", "Containers", "Vectorize"],
	},
	pillars: [
		{
			kicker: "数据",
			title: "照片在你自己的 R2 里",
			body: "原件、缩略图和元数据都在你的 Cloudflare 账号里，没有中间商。不用租服务器，不用管磁盘和系统更新。",
		},
		{
			kicker: "安全",
			title: "除了你，谁都拿不到",
			body: "整个站点在 Cloudflare Access 后面，Worker 收到每个请求还会再验一次身份。R2 不开公开访问、不发预签名链接。",
		},
		{
			kicker: "成本",
			title: "账单不会失控",
			body: `结构上没有死循环和重试风暴；本月容器费用到了上限（默认 $${DEFAULT_MONTHLY_BUDGET_USD}）就自动熔断，等你确认。`,
		},
	],
	features: {
		title: "一个相册该有的，都在这里",
		lead: "几万张照片也一样流畅：时间线只渲染屏幕附近的部分，5 万张时页面上最多约 1100 个节点。",
		items: [
			{ id: "timeline", title: "时间线", body: "按拍摄日期排好，拖动右侧的滚动条直接跳到任意年月，连拍自动折叠成一张。" },
			{ id: "viewer", title: "查看器", body: "Live Photo 自动播放，视频优先播原件；放大时自动换成原图，HEIC、RAW 也能看最高清。" },
			{ id: "organize", title: "文件夹与相册", body: "按目录结构上传，文件夹、相册、收藏、回收站；多选后批量移动、下载成 zip。" },
			{ id: "map", title: "地图", body: "照片按位置聚合，地名跟着界面语言；底图免费，不需要任何 API key。" },
			{ id: "people", title: "人物", body: "自动识别人脸并按人归组，可以命名、合并、纠错。向量只存在你自己的数据库里。" },
			{ id: "similar", title: "相似与重复", body: "找出重复照片，查看相似照片；“主题”按内容（狗、汽车……）给出建议，由你挑选。" },
			{ id: "edit", title: "编辑", body: "旋转、裁切、给照片打码（毛玻璃）；改拍摄时间、时区和位置。原件永远不动。" },
			{ id: "stats", title: "统计数据", body: "按拍摄时间和设备统计，找出最大的文件，费用和容器时长一目了然。" },
		],
		pwa: "支持添加到主屏幕（PWA）、深色模式、简体中文 / English。",
		mockNote: "示意图",
	},
	cost: {
		kicker: "成本",
		title: "要花多少钱",
		lead: "唯一固定的费用是 Cloudflare 的 Workers Paid 套餐。存储按量计费，照片处理只在上传时花一次钱。",
		head: { photos: "照片数", storage: "存储", plan: "Workers Paid", r2: "R2 存储", vectorize: "Vectorize", total: "每月合计", import: "一次性导入" },
		photos: (n: number) => `${n.toLocaleString("zh-CN")} 张`,
		perMonth: "/ 月",
		assume: (o: number, d: number, s: number) =>
			`按每张原件 ${o} MB、缩略图和预览 ${d} MB、每张 ${s} 秒容器时间估算，已扣除 Workers Paid 包含的免费额度。请求数、D1 读写等按次计费的项在正常使用下都在免费额度内。以 Cloudflare 账单为准。`,
		capNote: (cap: number) =>
			`一次性导入是在一个月内全部交给云端容器处理的费用。超过月度上限（默认 $${cap}）时处理会暂停：可以调高上限、分几个月导入，或者用设备端处理（不花容器费用）。`,
		guard: {
			title: "硬上限，而不只是告警",
			body: `应用自己记账：本月容器的估算费用到了月度上限（默认 $${DEFAULT_MONTHLY_BUDGET_USD}，设置页可改）就暂停后台处理和上传。上传前会估算这一批要花多少，太多时建议用设备端处理。`,
		},
	},
	device: {
		kicker: "设备端处理",
		title: "大批量导入？让自己的电脑来处理",
		body: "在自己的电脑上用 Docker 跑同一套处理代码，代替云端容器：不花容器费用，结果完全一样。还能直接读本机的原图目录，省掉下载。",
		points: ["同一套代码和模型，结果一致", "用你自己的 Access 登录，没有额外的令牌", "关掉之后约 2 分钟，云端自动接手"],
		cta: "了解设备端处理",
	},
	privacy: {
		kicker: "隐私",
		title: "没有第三方，没有遥测",
		items: [
			{ title: "唯一的外部请求是地图底图", body: "OpenFreeMap 能看到你浏览的地图范围，看不到任何照片。" },
			{ title: "人脸和人名只在你的数据库里", body: "识别在你自己的容器里完成，不调用任何外部服务。" },
			{ title: "日志只记 ID", body: "不记录文件名、GPS、描述和人名。" },
			{ title: "处理容器没有外网", body: "处理照片的容器断网运行，模型在构建镜像时就固定了版本和校验和。" },
		],
	},
	deploy: {
		kicker: "部署",
		title: "三步上线，之后自动更新",
		steps: [
			{ title: "Fork 仓库", body: "不需要改任何文件。你的域名和资源 ID 都不写进仓库。", code: "github.com/darmau/nana-storage → Fork" },
			{ title: "运行初始化", body: "创建存储、数据库、队列和登录保护，可以重复运行。", code: "pnpm install && pnpm run setup" },
			{ title: "连接 Workers Builds", body: "推送到 main 自动测试、迁移数据库、部署。", code: "NANA_DOMAIN=photos.example.com" },
		],
		after: "以后在 GitHub 上点 Sync fork（或者启用自带的同步工作流）就会自动更新。",
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
			{ label: "从外网访问", cells: ["开箱即用，带登录保护", "开箱即用", "要自己配反代和证书"] },
			{ label: "多用户、共享", cells: ["不支持（只给一个人用）", "支持", "多数支持"] },
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
		"A Google Photos–style private library that lives in your own Cloudflare account. Only you can see it, and the bill has a hard cap. Open source, deploy from a fork in a few steps.",
	nav: { docs: "Docs", deploy: "Deploy", github: "GitHub", switchLang: "简体中文", switchHref: "" },
	hero: {
		eyebrow: "Open source · Self-hosted · Single user",
		title: ["Your photos,", "in your own cloud"],
		lead: "Nana is a private photo library that runs in your own Cloudflare account. Timeline, map, people, similar photos — it's all there. Photos stay in your R2, only you can open them, and the bill has a hard cap.",
		primary: "Deploy it",
		secondary: "View on GitHub",
		stack: ["Workers", "R2", "D1", "Access", "Containers", "Vectorize"],
	},
	pillars: [
		{
			kicker: "Data",
			title: "Photos stay in your R2",
			body: "Originals, thumbnails and metadata all live in your Cloudflare account. No middleman, no server to rent, no disks or OS updates to look after.",
		},
		{
			kicker: "Security",
			title: "Nobody but you gets in",
			body: "The whole site sits behind Cloudflare Access, and the Worker checks your identity again on every request. No public buckets, no presigned links.",
		},
		{
			kicker: "Cost",
			title: "No runaway bills",
			body: `No loops or retry storms by design, and a circuit breaker stops processing once this month's container spend reaches your cap ($${DEFAULT_MONTHLY_BUDGET_USD} by default).`,
		},
	],
	features: {
		title: "Everything a photo library should do",
		lead: "Smooth with tens of thousands of photos: the timeline only renders what's near the screen — about 1,100 DOM nodes at 50,000 photos.",
		items: [
			{ id: "timeline", title: "Timeline", body: "Sorted by capture date. Drag the scrubber to jump to any month; bursts fold into one." },
			{ id: "viewer", title: "Viewer", body: "Live Photos play, videos stream the original when possible, and zooming swaps in the full-resolution image — HEIC and RAW included." },
			{ id: "organize", title: "Folders & albums", body: "Upload whole directory trees. Folders, albums, favorites and trash; select many to move or download as a zip." },
			{ id: "map", title: "Map", body: "Photos clustered by location, place names in your language. Free base map, no API key." },
			{ id: "people", title: "People", body: "Faces are detected and grouped by person; name, merge and fix them. Vectors stay in your own database." },
			{ id: "similar", title: "Similar & duplicates", body: "Find duplicates and similar shots. Themes suggest photos by subject (dogs, cars…) for you to pick." },
			{ id: "edit", title: "Editing", body: "Rotate, crop and blur out areas; fix capture time, time zone and location. Originals are never touched." },
			{ id: "stats", title: "Statistics", body: "By capture date and camera, the largest files, plus cost and container time at a glance." },
		],
		pwa: "Add to Home Screen (PWA), dark mode, English / 简体中文.",
		mockNote: "Illustration",
	},
	cost: {
		kicker: "Cost",
		title: "What it costs",
		lead: "The only fixed cost is Cloudflare's Workers Paid plan. Storage is pay-as-you-go, and processing is paid once, when you upload.",
		head: { photos: "Photos", storage: "Storage", plan: "Workers Paid", r2: "R2 storage", vectorize: "Vectorize", total: "Per month", import: "One-time import" },
		photos: (n: number) => n.toLocaleString("en-US"),
		perMonth: "/ mo",
		assume: (o: number, d: number, s: number) =>
			`Assumes ${o} MB per original, ${d} MB of thumbnails and previews, and ${s} seconds of container time per photo, after the free allowance included in Workers Paid. Per-request items (requests, D1 reads and writes) stay within the free allowance in normal use. Your Cloudflare bill is authoritative.`,
		capNote: (cap: number) =>
			`The one-time import is what it costs if cloud containers process everything within one month. Above your monthly cap ($${cap} by default) processing pauses: raise the cap, spread the import over a few months, or process on your own computer (no container cost).`,
		guard: {
			title: "A hard cap, not just an alert",
			body: `The app keeps its own books: once this month's estimated container spend reaches your cap ($${DEFAULT_MONTHLY_BUDGET_USD} by default, adjustable in Settings), processing and uploads pause. Before an upload it estimates what the batch will cost and suggests on-device processing for big ones.`,
		},
	},
	device: {
		kicker: "On-device processing",
		title: "Importing a lot? Let your own computer do it",
		body: "Run the same processing code on your computer with Docker instead of cloud containers: no container cost, identical results. It can even read your local originals instead of downloading them.",
		points: ["Same code and models, same results", "Signs in with your own Access login — no extra tokens", "Stop it and the cloud takes over within about 2 minutes"],
		cta: "About on-device processing",
	},
	privacy: {
		kicker: "Privacy",
		title: "No third parties, no telemetry",
		items: [
			{ title: "The only outside request is the base map", body: "OpenFreeMap sees which map area you browse, never your photos." },
			{ title: "Faces and names stay in your database", body: "Recognition runs in your own container; no outside service is called." },
			{ title: "Logs hold IDs only", body: "No file names, GPS data, descriptions or names of people." },
			{ title: "Processing runs offline", body: "The processing container has no internet access; models are pinned by version and checksum at build time." },
		],
	},
	deploy: {
		kicker: "Deploy",
		title: "Three steps, then it updates itself",
		steps: [
			{ title: "Fork the repository", body: "No files to edit. Your domain and resource IDs never go into the repository.", code: "github.com/darmau/nana-storage → Fork" },
			{ title: "Run setup", body: "Creates storage, database, queues and the login gate. Safe to run again.", code: "pnpm install && pnpm run setup" },
			{ title: "Connect Workers Builds", body: "Every push to main is tested, migrated and deployed.", code: "NANA_DOMAIN=photos.example.com" },
		],
		after: "From then on, click Sync fork on GitHub (or enable the bundled sync workflow) to update.",
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
			{ label: "Access from anywhere", cells: ["Built in, behind a login", "Built in", "Set up a proxy and TLS yourself"] },
			{ label: "Multiple users, sharing", cells: ["No (one person only)", "Yes", "Mostly yes"] },
		],
	},
	footer: {
		license: "Open source under AGPL-3.0. The face recognition model (InsightFace) is for non-commercial use only and can be left out at build time.",
		links: { docs: "Docs", github: "GitHub", security: "Report a vulnerability", changelog: "Changelog" },
		credit: "Sample photos are public domain / CC0 works; see Credits.",
	},
};

export const HOME = { zh, en };
