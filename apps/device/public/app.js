// 本地界面：左边浏览相册（文件夹和照片），右边是正在进行的任务（上传、处理、最近完成），设置是单独的视图（#settings）。
// 设置和相册在同一个页面里切换，不跳转：要上传的文件句柄只在这个页面里，换页面会中断正在发送的文件。
// 本机状态每 2 秒读一次（只请求本机，不经过 Cloudflare）；
// 服务器队列每 10 秒读一次，最多 SERVER_MAX 次（标签页回到前台时重新计数）；标签页在后台时都不读。
// 卡片按任务 id 复用 DOM，缩略图每个任务只请求一次（浏览器缓存）。

const $ = (id) => document.getElementById(id);
const SERVER_MS = 10_000;
const SERVER_MAX = 360;

// 文案在 i18n.js（T、errorText、applyStatic）
const KINDS = T.kinds;
const ASSET_KINDS = T.assetKinds;
const RESULTS = T.results;
const STEPS = T.steps;
const STAGES = T.stages;
/** 进度条：每个阶段大致的位置（0–1） */
const PHASE = { queued: 0, decode: 0.3, images: 0.35, thumb: 0.55, fingerprint: 0.6, faces: 0.7, upload: 0.82, meta: 0.86, transcode: 0.88, complete: 0.95 };

let current = null;
let server = null;
let formFilled = false;

async function post(action, body = {}) {
	const res = await fetch(`/api/${action}`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-nana-device": "1" },
		body: JSON.stringify(body),
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw data.error ? data : new Error(String(res.status));
	return data;
}

function showError(e) {
	const box = $("error");
	box.hidden = !e;
	box.textContent = e ? errorText(e) : "";
}

const el = (tag, cls, text) => {
	const e = document.createElement(tag);
	if (cls) e.className = cls;
	if (text !== undefined) e.textContent = text;
	return e;
};
const fmtNum = (n) => n.toLocaleString(LANG);
const fmtMs = (ms) => {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return T.time.seconds(s);
	if (s < 3600) return T.time.minutes(Math.floor(s / 60), s % 60);
	return T.time.hours(Math.floor(s / 3600), Math.round((s % 3600) / 60));
};
const fmtBytes = (b) =>
	b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : b >= 1024 ** 2 ? `${(b / 1024 ** 2).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`;

// ---- 缩略图：每个格子只设置一次 src，加载失败就保留占位
function setThumb(box, job) {
	if (!job.hasThumb || box.dataset.src) return;
	box.dataset.src = "1";
	const img = new Image();
	img.alt = "";
	img.decoding = "async";
	img.onload = () => box.classList.add("loaded");
	img.onerror = () => img.remove();
	img.src = `/api/thumb/${encodeURIComponent(job.jobId)}`;
	box.prepend(img);
}

function placeholder(job) {
	const box = el("div", "thumb");
	const ext = (job.name?.includes(".") ? job.name.split(".").pop() : "").toUpperCase().slice(0, 4);
	box.append(el("span", "ph", job.assetKind === "video" ? T.placeholder.video : job.assetKind === "live" ? T.placeholder.live : ext || T.placeholder.photo));
	return box;
}

// ---- 正在处理
const cards = new Map();

function stageText(j) {
	if (j.stage === "download" || j.stage === "local")
		return j.total ? `${STAGES[j.stage]} ${Math.floor((j.bytes / j.total) * 100)}% · ${fmtBytes(j.total)}` : STAGES[j.stage];
	if (j.stage === "derive") return STEPS[j.step] ?? T.processing;
	return STAGES[j.stage] ?? j.stage;
}
function phaseOf(j) {
	if (j.stage === "download" || j.stage === "local") return j.total ? (j.bytes / j.total) * 0.3 : 0;
	if (j.stage === "derive") return PHASE[j.step] ?? 0.3;
	return PHASE[j.stage] ?? 0;
}

function renderActive(s) {
	const root = $("active");
	const seen = new Set();
	for (const j of s.active) {
		seen.add(j.jobId);
		let c = cards.get(j.jobId);
		if (!c) {
			const card = el("article", "card");
			const thumb = placeholder(j);
			const body = el("div", "body");
			const name = el("div", "name", j.name ?? j.jobId);
			name.title = j.name ?? j.jobId;
			const meta = el("div", "meta");
			const stage = el("div", "stage");
			const bar = el("div", "bar");
			const fill = el("i");
			bar.append(fill);
			body.append(name, meta, stage, bar);
			card.append(thumb, body);
			root.append(card);
			c = { card, thumb, meta, stage, fill };
			cards.set(j.jobId, c);
		}
		setThumb(c.thumb, j);
		const label = [KINDS[j.kind] ?? j.kind, ASSET_KINDS[j.assetKind]].filter(Boolean).join(" · ");
		c.meta.textContent = `${label} · ${fmtMs(s.now - j.startedAt)}`;
		c.stage.textContent = stageText(j);
		c.fill.style.transform = `scaleX(${Math.max(0.02, Math.min(1, phaseOf(j)))})`;
	}
	for (const [id, c] of cards) {
		if (!seen.has(id)) {
			c.card.remove();
			cards.delete(id);
		}
	}
	$("active-empty").hidden = s.active.length > 0;
}

// ---- 最近完成
const tiles = new Map();

function renderRecent(s) {
	const root = $("recent");
	const items = s.history.filter((h) => h.status !== "lost").slice(0, 30);
	const order = [];
	for (const h of items) {
		let t = tiles.get(h.jobId);
		if (!t) {
			t = placeholder(h);
			t.classList.add("tile");
			if (h.status !== "done") {
				t.classList.add("bad");
				t.append(el("span", "badge", T.failedBadge));
			}
			t.title = `${h.name ?? h.jobId}\n${KINDS[h.kind] ?? h.kind} · ${RESULTS[h.status] ?? h.status} · ${fmtMs(h.ms)}${h.error ? `\n${h.error}` : ""}`;
			tiles.set(h.jobId, t);
		}
		setThumb(t, h);
		order.push(t);
	}
	// 新的在前；只在顺序变了时移动节点，已经显示的图片不会重新加载
	order.forEach((t, i) => {
		if (root.children[i] !== t) root.insertBefore(t, root.children[i] ?? null);
	});
	for (const [id, t] of tiles) {
		if (!order.includes(t)) {
			t.remove();
			tiles.delete(id);
		}
	}
	$("recent-empty").hidden = items.length > 0;
	const done = items.filter((h) => h.status === "done");
	$("recent-sub").textContent = done.length ? T.average(fmtMs(done.reduce((n, h) => n + h.ms, 0) / done.length)) : "";

	const failures = $("failures");
	failures.replaceChildren();
	for (const h of s.history.filter((h) => h.status === "failed" || h.status === "retry").slice(0, 10)) {
		const li = el("li");
		li.append(el("strong", "", h.name ?? h.jobId), el("span", "muted", ` ${RESULTS[h.status]}: ${h.error ?? ""}`));
		failures.append(li);
	}
}

// ---- 统计和状态
function renderStats(s) {
	$("s-active").textContent = `${s.active.length} / ${s.config.concurrency}`;
	$("s-active-sub").textContent = T.stats.cpus(s.cpus);
	$("s-rate").textContent = s.perMinute ? (s.perMinute < 10 ? s.perMinute.toFixed(1) : String(Math.round(s.perMinute))) : "–";
	$("s-done").textContent = fmtNum(s.done);
	const l = s.local;
	const localText = !l
		? null
		: l.jobs
			? T.stats.localJobs(fmtNum(l.jobs), fmtBytes(l.bytes))
			: l.scanning
				? T.stats.localScanning
				: l.available
					? T.stats.localIndexed(fmtNum(l.files))
					: null;
	$("s-done-sub").textContent = [T.stats.failed(fmtNum(s.failed)), T.stats.uptime(fmtMs(s.now - s.since)), localText].filter(Boolean).join(" · ");
	if (server?.counts) {
		const c = server.counts;
		const left = c.pending + c.running + c.stuck;
		$("s-queue").textContent = fmtNum(c.pending);
		$("s-queue-sub").textContent = [
			T.stats.running(fmtNum(c.running)),
			c.stuck && T.stats.stuck(fmtNum(c.stuck)),
			left && s.perMinute && T.stats.eta(fmtMs((left / s.perMinute) * 60_000)),
		]
			.filter(Boolean)
			.join(" · ");
	}
}

function render(s) {
	current = s;
	const leased = s.attached && s.leaseUntil > s.now;
	const pill = $("pill");
	pill.className = `pill ${leased ? "on" : s.attached ? "wait" : ""}`;
	pill.lastChild.textContent = leased ? T.pill.on : s.attached ? T.pill.wait : T.pill.off;
	const toggle = $("toggle");
	toggle.hidden = !s.config.site || s.need === "login";
	toggle.textContent = s.attached ? T.toggle.detach : T.toggle.attach;
	toggle.className = `btn ${s.attached ? "" : "primary"}`;
	$("subtitle").textContent = s.config.site ? `${s.config.name} · ${s.config.site.replace(/^https?:\/\//, "")}` : T.tagline;

	renderNeed(s);
	showError(s.need ? null : s.lastError);
	renderUpload(s, leased);
	renderStats(s);
	renderActive(s);
	renderRecent(s);

	if (!formFilled) {
		const f = $("config").elements;
		f.site.value = s.config.site;
		f.name.value = s.config.name;
		f.concurrency.value = s.config.concurrency;
		f.autoAttach.checked = s.config.autoAttach;
		f.lang.value = LANG_PREF;
		$("cpus").textContent = T.form.cpusHint(s.cpus);
		formFilled = true;
		// 还没填站点地址：先打开设置
		if (!s.config.site && !inSettings()) location.hash = "#settings";
	}
}

function renderNeed(s) {
	const box = $("need");
	const key = `${s.need}|${s.loginUrl}`;
	if (box.dataset.key === key) return;
	box.dataset.key = key;
	box.replaceChildren();
	box.hidden = !s.need && !s.loginUrl;
	const p = (text) => box.append(el("p", "", text));
	if (s.loginUrl) {
		p(T.need.loginLink);
		const a = el("a", "", s.loginUrl);
		a.href = s.loginUrl;
		a.target = "_blank";
		a.rel = "noopener noreferrer";
		box.append(a);
		return;
	}
	if (s.need === "site") {
		p(T.need.site);
		const a = el("a", "btn primary", T.need.siteButton);
		a.href = "#settings";
		box.append(a);
	}
	if (s.need === "server") p(T.need.server);
	if (s.need === "tripped") p(T.need.tripped);
	if (s.need === "login") {
		p(T.need.login);
		const b = el("button", "btn primary", T.need.loginButton);
		b.onclick = () => post("login").then(poll, showError);
		box.append(b);
	}
}

async function poll() {
	try {
		render(await (await fetch("/api/state")).json());
	} catch {
		showError("unreachable");
	}
}

let serverCount = 0;
let serverTimer = 0;
async function pollServer() {
	clearTimeout(serverTimer);
	if (document.hidden) return;
	try {
		const res = await fetch("/api/server");
		server = res.ok ? await res.json() : null;
		if (current) renderStats(current);
	} catch {}
	if (++serverCount < SERVER_MAX) serverTimer = setTimeout(pollServer, SERVER_MS);
}

// ---- 相册：浏览文件夹，在哪个文件夹就上传到哪里（和网页版一样）
// 浏览走本机程序代理的只读接口（main.mjs 的 LIB_ROUTES）；只在打开页面、切换文件夹、点“加载更多”和上传完成时请求，不轮询。
// 上传（upload.mjs）：这个页面只负责读文件，选好后把清单交给本机程序，它按需要一个个来要（next），这里把对应的 File 推过去（PUT）。
// 同时最多 SENDERS 个文件在路上；本机程序暂存满了会让这里等。文件句柄只在这个页面里，关掉页面剩下的就发不了了。

const SENDERS = 2;
const session = crypto.randomUUID();
/** 清单编号 → File（发出去之后删掉） */
const picked = new Map();
let senders = 0;

/** 当前文件夹："root" 或文件夹 id（记在地址的 #f= 里，前进 / 后退可用）；#settings 是设置视图，不改变当前文件夹 */
const folderOfHash = () => /^#f=([0-9A-Z]{26})$/.exec(location.hash)?.[1] ?? "root";
const inSettings = () => location.hash === "#settings";
let folder = inSettings() ? "root" : folderOfHash();
let crumbs = [];
/** crumbs 属于哪个文件夹：刚切换、还没加载完时和 folder 不一致，上传的显示路径就不用它 */
let crumbsFolder = null;
let nextOffset = null;
let loading = 0;
let lastDone = -1;
let refreshTimer = 0;

const thumbSrc = (id, rev) => `/api/lib/thumb/${id}?v=${rev}`;
const coverSrc = (c) => {
	const [id, rev] = c.split(":");
	return thumbSrc(id, rev);
};

async function getJson(path) {
	const res = await fetch(path);
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw data.error ? data : new Error(String(res.status));
	return data;
}

function go(id) {
	location.hash = id === "root" ? "" : `#f=${id}`;
	if (id === "root" && folder !== "root") {
		// 清空 hash 不触发 hashchange（有的浏览器），直接加载
		folder = "root";
		void loadFolder();
	}
}
function route() {
	const settings = inSettings();
	document.body.dataset.view = settings ? "settings" : "library";
	if (settings) {
		window.scrollTo(0, 0);
		return;
	}
	const id = folderOfHash();
	if (id === folder) return;
	folder = id;
	void loadFolder();
}
window.addEventListener("hashchange", route);
// 设置页的“返回相册”：回到进入设置之前所在的文件夹
$("settings-back").onclick = (e) => {
	e.preventDefault();
	location.hash = folder === "root" ? "" : `#f=${folder}`;
	if (folder === "root") route();
};

async function loadFolder({ keepScroll = false } = {}) {
	const ticket = ++loading;
	const libError = $("lib-error");
	try {
		const [info, page] = await Promise.all([getJson(`/api/lib/folders/${folder}`), getJson(`/api/lib/folders/${folder}/assets?offset=0`)]);
		if (ticket !== loading) return;
		libError.hidden = true;
		crumbs = info.path;
		crumbsFolder = folder;
		renderCrumbs();
		renderFolders(info.children);
		$("photos").replaceChildren();
		appendPhotos(page.items);
		nextOffset = page.next;
		$("lib-more").hidden = nextOffset === null;
		$("lib-empty").hidden = info.children.length > 0 || page.items.length > 0;
		if (!keepScroll) window.scrollTo(0, 0);
	} catch (e) {
		if (ticket !== loading) return;
		libError.hidden = false;
		libError.textContent = e?.error === "not found" ? errorText(e) : `${T.library.loadFailed}${e?.error ? ` (${errorText(e)})` : ""}`;
		// 文件夹被删掉了：回到根目录
		if (e?.error === "not found" && folder !== "root") go("root");
	}
}

function renderCrumbs() {
	const nav = $("crumbs");
	nav.replaceChildren();
	const parts = [{ id: "root", name: T.library.root }, ...crumbs];
	parts.forEach((p, i) => {
		if (i) nav.append(el("span", "sep", "›"));
		if (i === parts.length - 1) nav.append(el("span", "", p.name));
		else {
			const a = el("a", "", p.name);
			a.href = p.id === "root" ? "#" : `#f=${p.id}`;
			a.onclick = (e) => {
				e.preventDefault();
				go(p.id);
			};
			nav.append(a);
		}
	});
}

function renderFolders(children) {
	const root = $("folders");
	root.replaceChildren();
	for (const f of children) {
		const a = el("a", "folder");
		a.href = `#f=${f.id}`;
		const shown = f.covers.slice(0, f.covers.length >= 9 ? 9 : f.covers.length >= 4 ? 4 : 1);
		const cover = el("div", `cover${shown.length === 9 ? " g9" : shown.length === 4 ? " g4" : ""}`);
		if (!shown.length) cover.append(el("span", "ph", "▢"));
		for (const c of shown) {
			const img = new Image();
			img.alt = "";
			img.loading = "lazy";
			img.decoding = "async";
			img.onerror = () => (img.style.visibility = "hidden");
			img.src = coverSrc(c);
			cover.append(img);
		}
		a.append(cover, el("span", "fname", f.name), el("span", "fsub", T.library.count(fmtNum(f.count))));
		root.append(a);
	}
}

function appendPhotos(items) {
	const root = $("photos");
	for (const [id, , , kind, , durationMs, , rev] of items) {
		const box = el("div", "photo");
		const img = new Image();
		img.alt = "";
		img.loading = "lazy";
		img.decoding = "async";
		img.onerror = () => img.remove();
		img.src = thumbSrc(id, rev);
		box.append(img);
		if (kind === 1 && durationMs) box.append(el("span", "dur", fmtDuration(durationMs)));
		root.append(box);
	}
}

const fmtDuration = (ms) => {
	const s = Math.round(ms / 1000);
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

$("lib-more").onclick = async () => {
	if (nextOffset === null) return;
	const button = $("lib-more");
	button.disabled = true;
	try {
		const page = await getJson(`/api/lib/folders/${folder}/assets?offset=${nextOffset}`);
		appendPhotos(page.items);
		nextOffset = page.next;
		button.hidden = nextOffset === null;
	} catch (e) {
		showError(e);
	} finally {
		button.disabled = false;
	}
};

/** 上传完成的条目变多了：过一会儿刷新当前文件夹（新照片要等处理完才显示，所以每 10 秒最多一次）。 */
function refreshAfterUpload(done) {
	if (lastDone === -1 || done <= lastDone) {
		lastDone = done;
		return;
	}
	lastDone = done;
	if (refreshTimer) return;
	refreshTimer = setTimeout(() => {
		refreshTimer = 0;
		void loadFolder({ keepScroll: true });
	}, 10_000);
}

async function pick(files, paths) {
	if (!files.length) return;
	const folderId = folder === "root" ? null : folder;
	try {
		const r = await post("upload/start", {
			session,
			folderId,
			folderLabel: crumbsFolder === folder ? crumbs.map((c) => c.name).join(" / ") : "",
			tzOffsetMin: -new Date().getTimezoneOffset(),
			files: files.map((f, i) => ({ name: f.name, relativePath: paths?.[i] ?? f.name, size: f.size, lastModified: f.lastModified })),
		});
		files.forEach((f, i) => picked.set(r.first + i, f));
		for (const index of r.skipped) picked.delete(index);
		showError(null);
		while (senders < SENDERS) void sender();
		poll();
	} catch (e) {
		showError(e);
	}
}

/** 一个发送循环：问本机程序要下一个文件，推过去；它让等就等，没有要发的就退出。连续出错 5 次就停。 */
async function sender() {
	senders++;
	let errors = 0;
	try {
		while (errors < 5) {
			let r;
			try {
				r = await post("upload/next", { session });
			} catch {
				errors++;
				await new Promise((ok) => setTimeout(ok, 2000 * errors));
				continue;
			}
			if (r.idle) return;
			if (r.wait) {
				await new Promise((ok) => setTimeout(ok, r.wait));
				continue;
			}
			const file = picked.get(r.index);
			if (!file) continue;
			try {
				const res = await fetch(`/api/upload/file/${r.index}`, { method: "PUT", headers: { "x-nana-device": "1" }, body: file });
				if (!res.ok) throw await res.json().catch(() => new Error(String(res.status)));
				picked.delete(r.index);
				errors = 0;
			} catch (e) {
				// 本机程序记次数，读不出来的文件三次后算失败；这里只是稍等再要下一个
				errors++;
				showError(e);
				await new Promise((ok) => setTimeout(ok, 1000));
			}
		}
	} finally {
		senders--;
	}
}

let libraryStarted = false;

function renderUpload(s, leased) {
	const u = s.uploads;
	const canUpload = Boolean(s.config.site) && s.need !== "login";
	$("up-files").disabled = !canUpload;
	$("up-dir").disabled = !canUpload;
	$("library").hidden = !s.config.site;
	if (canUpload && !libraryStarted) {
		libraryStarted = true;
		void loadFolder({ keepScroll: true });
	}
	const sending = picked.size > 0;
	$("up-hint").textContent = [leased ? T.upload.hintLocal : T.upload.hintCloud, sending && T.upload.keepOpen].filter(Boolean).join(" ");

	$("up-progress").hidden = !u || u.total === 0;
	if (!u || u.total === 0) return;
	const c = u.counts;
	refreshAfterUpload(c.done);
	const active = c.waiting + c.staged + c.uploading;
	const finished = c.done + c.duplicate;
	$("up-fill").style.transform = `scaleX(${u.bytes ? Math.min(1, u.sent / u.bytes) : 0})`;
	$("up-text").textContent = [
		T.upload.progress(fmtNum(finished), fmtNum(u.total), fmtBytes(u.sent), fmtBytes(u.bytes)),
		c.duplicate && T.upload.duplicates(fmtNum(c.duplicate)),
		u.failed.length && T.upload.failedN(fmtNum(u.failed.length)),
		u.skipped && T.upload.skippedN(fmtNum(u.skipped)),
		u.waitingForProcessing && T.upload.waitingForProcessing(fmtNum(u.waitingForProcessing)),
		active && T.upload.staging(fmtBytes(u.stagedBytes), fmtBytes(u.stagedMax)),
	]
		.filter(Boolean)
		.join(" · ");
	const alert = u.stopped === "guard tripped" ? T.upload.stoppedGuard : u.stopped === "login" ? T.upload.stoppedLogin : u.orphaned ? T.upload.orphaned(fmtNum(u.orphaned)) : "";
	$("up-alert").hidden = !alert;
	$("up-alert").textContent = alert;
	$("up-cancel").hidden = c.waiting + c.staged === 0;
	$("up-resume").hidden = !u.stopped && u.failed.length === 0;
	$("up-clear").hidden = active > 0;

	const list = $("up-list");
	list.replaceChildren();
	// 不逐个列出上传的文件（右栏放不下，进度看上面的数字），只列失败的
	const rows = u.failed.slice(0, 5);
	for (const i of rows) {
		const li = el("li");
		const status = el("span", `up-status ${i.status}`, ` ${T.upload.status[i.status] ?? i.status}${i.error ? `: ${errorText(i.error)}` : ""}`);
		li.append(el("strong", "", i.name), el("span", "muted", i.folder ? ` → ${i.folder}` : ""), status);
		list.append(li);
	}
}

$("up-files").onclick = () => $("up-input-files").click();
$("up-dir").onclick = () => $("up-input-dir").click();
$("up-input-files").onchange = (e) => {
	void pick([...e.target.files]);
	e.target.value = "";
};
$("up-input-dir").onchange = (e) => {
	// 选的文件夹按目录结构建子文件夹（webkitRelativePath 以所选文件夹的名字开头）
	const files = [...e.target.files];
	void pick(files, files.map((f) => f.webkitRelativePath || f.name));
	e.target.value = "";
};

// ---- 拖放：文件和文件夹都可以拖到页面上任何地方，上传到当前文件夹（和网页版的 upload/drop.ts 一样展开文件夹）
const MAX_DROP_FILES = 100_000;
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes("Files");
document.addEventListener("dragenter", (e) => {
	if (!hasFiles(e) || $("up-files").disabled || inSettings()) return;
	e.preventDefault();
	dragDepth++;
	$("drop").hidden = false;
});
document.addEventListener("dragover", (e) => {
	if (hasFiles(e)) e.preventDefault();
});
document.addEventListener("dragleave", () => {
	if (dragDepth && --dragDepth === 0) $("drop").hidden = true;
});
document.addEventListener("drop", (e) => {
	if (!hasFiles(e)) return;
	e.preventDefault();
	dragDepth = 0;
	$("drop").hidden = true;
	if ($("up-files").disabled || inSettings()) return;
	// DataTransferItemList 只在 drop 事件里同步有效：先取出所有 entry，再异步展开
	const entries = [];
	const loose = [];
	for (const item of e.dataTransfer.items) {
		if (item.kind !== "file") continue;
		const entry = item.webkitGetAsEntry?.();
		if (entry) entries.push(entry);
		else {
			const f = item.getAsFile();
			if (f) loose.push(f);
		}
	}
	if (!entries.length && !loose.length) loose.push(...e.dataTransfer.files);
	void collectDropped(entries, loose).then((out) =>
		pick(
			out.map((o) => o.file),
			out.map((o) => o.path),
		),
	);
});

async function collectDropped(entries, loose) {
	const out = loose.map((file) => ({ file, path: file.name }));
	const walk = async (entry) => {
		if (out.length >= MAX_DROP_FILES) return;
		if (entry.isFile) {
			const file = await new Promise((ok, fail) => entry.file(ok, fail)).catch(() => null);
			if (file) out.push({ file, path: entry.fullPath.replace(/^\//, "") || file.name });
			return;
		}
		if (!entry.isDirectory) return;
		const reader = entry.createReader();
		// readEntries 每次只返回一批，读到空数组为止
		for (;;) {
			const batch = await new Promise((ok, fail) => reader.readEntries(ok, fail)).catch(() => []);
			if (!batch.length) return;
			for (const child of batch) await walk(child);
		}
	};
	for (const entry of entries) await walk(entry);
	return out;
}

$("up-cancel").onclick = () =>
	post("upload/cancel").then(() => {
		picked.clear();
		poll();
	}, showError);
$("up-resume").onclick = () =>
	post("upload/resume").then(() => {
		while (picked.size && senders < SENDERS) void sender();
		poll();
	}, showError);
$("up-clear").onclick = () => post("upload/clear").then(poll, showError);
window.addEventListener("beforeunload", (e) => {
	if (picked.size) {
		e.preventDefault();
		e.returnValue = T.upload.leaveWarning;
	}
});

applyStatic();
route();

$("toggle").onclick = () =>
	post(current?.attached ? "detach" : "attach").then(() => {
		showError(null);
		poll();
	}, showError);
$("config").onsubmit = (e) => {
	e.preventDefault();
	const f = e.target.elements;
	// 语言只存在这台电脑的浏览器里，改了就重新加载
	if (f.lang.value !== LANG_PREF) {
		writeLangPref(f.lang.value);
		location.reload();
		return;
	}
	post("config", {
		site: f.site.value,
		name: f.name.value,
		concurrency: Number(f.concurrency.value),
		autoAttach: f.autoAttach.checked,
	}).then(() => {
		showError(null);
		const saved = $("saved");
		saved.hidden = false;
		clearTimeout(saved.timer);
		saved.timer = setTimeout(() => (saved.hidden = true), 2000);
		formFilled = false;
		poll();
		serverCount = 0;
		pollServer();
	}, showError);
};

document.addEventListener("visibilitychange", () => {
	if (!document.hidden) {
		poll();
		serverCount = 0;
		pollServer();
	}
});
setInterval(() => {
	if (!document.hidden) poll();
}, 2000);
poll();
pollServer();
