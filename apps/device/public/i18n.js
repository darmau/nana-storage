// 本地界面的文案（简体中文 / English）。按浏览器语言选择，设置里可以改（这台电脑的 localStorage，和相册不共享）。
// 后台进程（main.mjs）只返回错误码和参数，在这里翻译。新增文案时两种语言都要加。
"use strict";

const LANG_KEY = "nana-device:lang";

const MESSAGES = {
	"zh-CN": {
		title: "那时 - 设备端",
		tagline: "用这台电脑代替云端容器处理照片",
		pill: { off: "未接管", wait: "连接中…", on: "接管中" },
		toggle: { attach: "转移到设备端执行", detach: "交还云端" },
		stats: {
			active: "正在处理",
			rate: "速度",
			rateSub: "最近 10 分钟 · 每分钟",
			queue: "服务器排队",
			done: "启动以来",
			cpus: (n) => `Docker 可用 ${n} 个 CPU`,
			running: (n) => `处理中 ${n}`,
			stuck: (n) => `卡住 ${n}`,
			eta: (t) => `约 ${t}`,
			failed: (n) => `失败 ${n}`,
			uptime: (t) => `已运行 ${t}`,
			localJobs: (n, size) => `本机原件 ${n} 个，省下载 ${size}`,
			localScanning: "正在索引本机原件",
			localIndexed: (n) => `本机原件索引 ${n} 个文件`,
		},
		sections: { active: "正在处理", recent: "最近完成", settings: "设置" },
		nav: { settings: "设置", back: "返回相册" },
		settingsPage: { connection: "连接", processing: "处理", interface: "界面" },
		empty: { active: "没有正在处理的照片。", recent: "还没有完成的照片。" },
		average: (t) => `平均每个 ${t}`,
		kinds: { process: "处理", rotate: "重做预览" },
		assetKinds: { photo: "照片", video: "视频", live: "实况照片" },
		placeholder: { photo: "照片", video: "视频", live: "实况" },
		results: { done: "完成", retry: "失败，稍后重试", failed: "失败", lost: "已被重新认领" },
		failedBadge: "失败",
		processing: "处理中",
		steps: { decode: "读取元数据", images: "生成预览", thumb: "生成预览", fingerprint: "计算指纹", faces: "识别人脸" },
		stages: { queued: "等待", local: "读取本机原件", download: "下载原件", meta: "读取附件", transcode: "转码视频", upload: "上传结果", complete: "写回服务器" },
		form: {
			site: "站点地址",
			name: "设备名",
			concurrency: "并行任务数",
			cpusHint: (n) => `Docker 可用 ${n} 个 CPU；内存不够时调低`,
			autoAttach: "启动时自动接管",
			language: "语言",
			auto: "跟随浏览器",
			save: "保存",
			saved: "已保存",
		},
		library: {
			root: "相册",
			empty: "这个文件夹是空的。可以点“上传文件”，或者把文件、文件夹拖到这里。",
			more: "加载更多",
			drop: "松开，上传到这个文件夹",
			count: (n) => `${n} 项`,
			loadFailed: "读不到相册（需要先登录）",
		},
		upload: {
			title: "上传到相册",
			pickFiles: "上传文件",
			pickFolder: "上传文件夹",
			hintLocal: "上传的照片就在这台电脑上处理，不用再下载原图。",
			hintCloud: "现在没有接管，上传后由云端容器处理（会产生容器费用）。先点“转移到设备端执行”，上传的照片就在这台电脑上处理。",
			keepOpen: "发送期间不要关闭这个页面：文件是由这个页面读取后交给本机程序的。",
			progress: (done, total, sent, bytes) => `${done} / ${total} 项 · ${sent} / ${bytes}`,
			duplicates: (n) => `${n} 项已存在，跳过`,
			failedN: (n) => `${n} 项失败`,
			skippedN: (n) => `${n} 个文件不是照片或视频，已忽略`,
			staging: (used, max) => `暂存 ${used} / ${max}`,
			waitingForProcessing: (n) => `${n} 项等本机处理`,
			orphaned: (n) => `${n} 项要从已经关闭的页面发送：重新选择这些文件，或者取消剩下的。`,
			stoppedGuard: "服务器的成本防护已触发，上传已暂停。在相册的“设置 › 成本防护”里恢复后，点“继续”。",
			stoppedLogin: "需要登录相册，登录后点“继续”。",
			cancel: "取消剩下的",
			resume: "继续",
			clear: "清空列表",
			leaveWarning: "还有文件没发送完，关闭页面会中断上传。",
			status: { waiting: "等待发送", staged: "等待上传", uploading: "上传中", done: "已上传", duplicate: "已存在，跳过", failed: "失败" },
		},
		need: {
			login: "需要登录相册（Cloudflare Access）。",
			loginButton: "登录",
			loginLink: "在浏览器里打开下面的链接，用相册的账号登录。登录完成后会自动接管。",
			site: "先在设置里填写相册的站点地址。",
			siteButton: "打开设置",
			server: "服务器上还没有设备端处理的接口：先部署最新版本，再点“转移到设备端执行”。",
			tripped: "服务器的成本防护已触发，暂停处理。在相册的“设置 › 成本防护”里恢复之后，再点“转移到设备端执行”。",
		},
		errors: {
			unreachable: "连接不到本地程序，确认 Docker 容器还在运行",
			"consecutive-failures": (e) => `连续失败 ${e.n} 次，已交还云端`,
			"self-check": (e) => `本机环境检查失败，不接管任务：${e.detail ?? ""}`,
			"invalid site": "站点地址无效（需要 https://）",
			"site required": "先填写站点地址",
			"self-check failed": "本机环境检查失败",
			"too many files": "一次最多选 100,000 个文件",
			"bad manifest": "没有可以上传的文件",
			"read stalled": "读取文件卡住了（网络盘断开？）",
			"size mismatch": "文件大小和选择时不一致（文件在上传期间被修改了？）",
			"unsupported or mismatched file type": "不支持的文件类型",
			"folder not found": "目标文件夹已经不存在",
			"login required": "需要登录相册",
			cancelled: "已取消",
		},
		time: {
			seconds: (s) => `${s} 秒`,
			minutes: (m, s) => `${m} 分 ${s} 秒`,
			hours: (h, m) => `${h} 小时 ${m} 分`,
		},
	},
	en: {
		title: "那时 – Device",
		tagline: "Process photos on this computer instead of in cloud containers",
		pill: { off: "Not active", wait: "Connecting…", on: "Processing here" },
		toggle: { attach: "Process on this device", detach: "Hand back to the cloud" },
		stats: {
			active: "Processing",
			rate: "Speed",
			rateSub: "last 10 min · per minute",
			queue: "Server queue",
			done: "Since start",
			cpus: (n) => `${n} CPUs available to Docker`,
			running: (n) => `${n} running`,
			stuck: (n) => `${n} stuck`,
			eta: (t) => `about ${t}`,
			failed: (n) => `${n} failed`,
			uptime: (t) => `up ${t}`,
			localJobs: (n, size) => `${n} from local originals, saved ${size} of downloads`,
			localScanning: "indexing local originals",
			localIndexed: (n) => `${n} local files indexed`,
		},
		sections: { active: "Processing", recent: "Recently finished", settings: "Settings" },
		nav: { settings: "Settings", back: "Back to library" },
		settingsPage: { connection: "Connection", processing: "Processing", interface: "Interface" },
		empty: { active: "Nothing is being processed.", recent: "Nothing has finished yet." },
		average: (t) => `${t} on average`,
		kinds: { process: "Process", rotate: "Redo preview" },
		assetKinds: { photo: "Photo", video: "Video", live: "Live Photo" },
		placeholder: { photo: "Photo", video: "Video", live: "Live" },
		results: { done: "Done", retry: "Failed, will retry", failed: "Failed", lost: "Claimed by another worker" },
		failedBadge: "Failed",
		processing: "Processing",
		steps: { decode: "Reading metadata", images: "Generating previews", thumb: "Generating previews", fingerprint: "Computing fingerprint", faces: "Detecting faces" },
		stages: {
			queued: "Waiting",
			local: "Reading local original",
			download: "Downloading original",
			meta: "Reading attachments",
			transcode: "Transcoding video",
			upload: "Uploading results",
			complete: "Saving to server",
		},
		form: {
			site: "Library address",
			name: "Device name",
			concurrency: "Parallel tasks",
			cpusHint: (n) => `${n} CPUs available to Docker; lower this if memory runs short`,
			autoAttach: "Take over automatically on start",
			language: "Language",
			auto: "Browser default",
			save: "Save",
			saved: "Saved",
		},
		library: {
			root: "Library",
			empty: "This folder is empty. Click \"Upload files\", or drag files and folders here.",
			more: "Load more",
			drop: "Drop to upload into this folder",
			count: (n) => `${n} ${n === "1" ? "item" : "items"}`,
			loadFailed: "Can't read the library (sign in first)",
		},
		upload: {
			title: "Upload to the library",
			pickFiles: "Upload files",
			pickFolder: "Upload a folder",
			hintLocal: "Uploaded photos are processed on this computer, without downloading the originals again.",
			hintCloud: "This device isn't processing right now, so uploads are processed by cloud containers (which costs container time). Click \"Process on this device\" first to process them on this computer.",
			keepOpen: "Keep this page open while files are being sent: this page reads them and hands them to the local program.",
			progress: (done, total, sent, bytes) => `${done} / ${total} items · ${sent} / ${bytes}`,
			duplicates: (n) => `${n} already in the library, skipped`,
			failedN: (n) => `${n} failed`,
			skippedN: (n) => `${n} files aren't photos or videos and were ignored`,
			staging: (used, max) => `staging ${used} / ${max}`,
			waitingForProcessing: (n) => `${n} waiting for local processing`,
			orphaned: (n) => `${n} items were to be sent by a page that has been closed. Choose those files again, or cancel the rest.`,
			stoppedGuard: "The server's cost protection has tripped, so uploads are paused. Resume it in the library under Settings › Cost protection, then click Continue.",
			stoppedLogin: "Sign in to your library, then click Continue.",
			cancel: "Cancel the rest",
			resume: "Continue",
			clear: "Clear list",
			leaveWarning: "Some files haven't been sent yet. Closing the page stops the upload.",
			status: { waiting: "Waiting to send", staged: "Waiting to upload", uploading: "Uploading", done: "Uploaded", duplicate: "Already there, skipped", failed: "Failed" },
		},
		need: {
			login: "Sign in to your library (Cloudflare Access).",
			loginButton: "Sign in",
			loginLink: "Open the link below in your browser and sign in with your library account. Processing takes over automatically once you're signed in.",
			site: "First enter your library address in Settings.",
			siteButton: "Open Settings",
			server: "The server doesn't have the device endpoints yet. Deploy the latest version, then click \"Process on this device\".",
			tripped: "The server's cost protection has tripped, so processing is paused. Resume it in the library under Settings › Cost protection, then click \"Process on this device\".",
		},
		errors: {
			unreachable: "Can't reach the local program. Make sure the Docker container is still running.",
			"consecutive-failures": (e) => `Failed ${e.n} times in a row, handed back to the cloud`,
			"self-check": (e) => `Local environment check failed, not taking over: ${e.detail ?? ""}`,
			"invalid site": "Invalid library address (must be https://)",
			"site required": "Enter the library address first",
			"self-check failed": "Local environment check failed",
			"too many files": "You can choose at most 100,000 files at a time",
			"bad manifest": "There are no files to upload",
			"read stalled": "Reading the file stalled (network drive disconnected?)",
			"size mismatch": "The file size changed since it was chosen (modified during upload?)",
			"unsupported or mismatched file type": "Unsupported file type",
			"folder not found": "The target folder no longer exists",
			"login required": "Sign in to your library first",
			cancelled: "Cancelled",
		},
		time: {
			seconds: (s) => `${s}s`,
			minutes: (m, s) => `${m}m ${s}s`,
			hours: (h, m) => `${h}h ${m}m`,
		},
	},
};

function readLangPref() {
	try {
		const v = localStorage.getItem(LANG_KEY);
		return v === "zh-CN" || v === "en" ? v : "auto";
	} catch {
		return "auto";
	}
}

function writeLangPref(v) {
	try {
		if (v === "auto") localStorage.removeItem(LANG_KEY);
		else localStorage.setItem(LANG_KEY, v);
	} catch {}
}

const LANG_PREF = readLangPref();
const LANG =
	LANG_PREF !== "auto" ? LANG_PREF : (navigator.languages ?? [navigator.language]).some((l) => /^zh\b/i.test(l ?? "")) ? "zh-CN" : "en";
const T = MESSAGES[LANG];

/** 错误：后台给的是 { code, ...参数 } 或者错误码字符串，认识的翻译，其余原样显示。 */
function errorText(e) {
	if (!e) return "";
	const code = typeof e === "string" ? e : (e.code ?? e.error ?? e.message);
	const m = T.errors[code];
	if (typeof m === "function") return m(typeof e === "object" ? e : {});
	if (m) return m;
	return String(typeof e === "object" ? (e.detail ?? e.message ?? code) : e);
}

/** 静态文案：data-i18n="a.b" 设置 textContent，data-i18n-title 设置 title 和 aria-label。 */
function applyStatic(root = document) {
	document.documentElement.lang = LANG;
	document.title = T.title;
	const get = (path) => path.split(".").reduce((o, k) => o?.[k], T);
	for (const node of root.querySelectorAll("[data-i18n]")) {
		const v = get(node.dataset.i18n);
		if (typeof v === "string") node.textContent = v;
	}
	for (const node of root.querySelectorAll("[data-i18n-title]")) {
		const v = get(node.dataset.i18nTitle);
		if (typeof v === "string") {
			node.title = v;
			node.setAttribute("aria-label", v);
		}
	}
}
