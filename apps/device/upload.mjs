import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { groupFiles } from "../../packages/shared/src/group.ts";
import { ApiError, AuthError } from "./client.mjs";

/**
 * 设备端上传：在本地界面里选文件，浏览器把文件一个个推给这里（只经过本机），这里分组、算 sha256、
 * 按和浏览器完全相同的协议调用 /api/uploads（去重、建子文件夹、成本防护都在服务端），上传完由服务端建 process 任务。
 *
 * 省掉原图下载：上传用的那份文件留在暂存目录里，设备接管时认领到这张照片的任务，runner.mjs 的 fromLocal
 * 通过 candidates() 找到它（同样按大小 + sha256 核对，服务器再核对一次 R2 上的那份），复制走之后 used() 立即删掉。
 * 没有接管（云端处理）时，上传完就删。
 *
 * 磁盘上限：暂存的文件（还没上传 + 上传完等着处理的）不超过 STAGE_MAX_BYTES / STAGE_MAX_GROUPS。满了先删掉最早的
 * 等处理的暂存文件（那些任务照常下载原图），上传不被本机处理的速度拖住；只有还没上传完的就占满时浏览器才等
 * （next() 返回 wait）。等处理的暂存文件 STAGED_TTL_MS 后也会过期删除。
 * 单个文件比上限还大时，只在暂存为空时接收。
 *
 * 浏览器只负责读文件：网页关掉后剩下的文件就收不到了（文件句柄在网页里），界面提示重新选择或者取消。
 * 日志里只记 ID，不记文件名。
 */

export const STAGE_MAX_BYTES = 4 * 1024 ** 3;
export const STAGE_MAX_GROUPS = 32;
/** 同时往服务器上传几个条目（每个条目的分块按顺序传），和网页上传相同。每个条目最多占一个分块的内存（20 MB）。 */
const UPLOAD_CONCURRENCY = 6;
/** 浏览器推文件时连续这么久收不到数据就放弃这次（NAS / 网络盘卡住），文件退回等待。 */
export const RECEIVE_IDLE_MS = 60_000;
/** 每个文件最多接收几次（浏览器读不出来、大小不对）。 */
const RECEIVE_ATTEMPTS = 3;
/** 网页这么久没来要文件，认为它关掉了。 */
export const PAGE_GONE_MS = 30_000;
/** 上传完、等着本机处理的暂存文件最多留多久。 */
export const STAGED_TTL_MS = 2 * 3600_000;
/** 一次最多选这么多文件（清单本身也要放进内存）。 */
export const MANIFEST_MAX_FILES = 100_000;
/** 界面里最多列出这么多条最近的条目和失败的条目。 */
const LIST_MAX = 20;

/** 上传条目的状态。waiting：还有文件没收到；staged：都收到了，等着上传。 */
const ACTIVE = new Set(["waiting", "staged", "uploading"]);

export class Uploads {
	/**
	 * dir：暂存目录（容器里的临时目录，启动时清空）。
	 * getApi()：当前的 Api（没登录时为 null）。isAttached()：设备是否在接管处理。
	 * onUploaded()：有条目上传完（main.mjs 用来马上认领，不用等下一次轮询）。
	 */
	constructor({ dir, getApi, isAttached, onUploaded = () => {}, now = Date.now }) {
		this.dir = dir;
		this.getApi = getApi;
		this.isAttached = isAttached;
		this.onUploaded = onUploaded;
		this.now = now;
		/** 清单里的每个文件，下标就是浏览器那边的编号 */
		this.files = [];
		this.items = [];
		this.uploading = 0;
		/** 暂存目录里的字节数和条目数（收到的、正在收的、等处理的都算） */
		this.stagedBytes = 0;
		/** 上传完、等着本机处理的暂存文件：大小 → [{ path, name, file, expires }] */
		this.ready = new Map();
		/** 网页最近一次来要文件的时间：session → 时间 */
		this.sessions = new Map();
		/** 停下来的原因：guard tripped（服务端熔断）/ login（需要登录）；用户点“继续”后清除 */
		this.stopped = null;
		this.skipped = 0;
		this.nextItemId = 0;
	}

	/** 启动时清空暂存目录（上次运行留下的都没用了）。 */
	async init() {
		await rm(this.dir, { recursive: true, force: true });
		await mkdir(this.dir, { recursive: true });
	}

	/**
	 * 网页选好了一批文件（只有清单，不含内容）。folderId 为空表示根目录；relativePath 带目录时按目录结构建子文件夹。
	 * 返回这批文件在清单里的起始编号（网页按 first + i 记住每个 File）和被忽略的文件的编号。
	 */
	start({ session, files, folderId = null, folderLabel = "", tzOffsetMin = null }) {
		if (!session || !Array.isArray(files) || !files.length) throw new Error("bad manifest");
		if (this.files.length + files.length > MANIFEST_MAX_FILES) throw new Error("too many files");
		const first = this.files.length;
		const input = files.map((f, i) => ({
			index: first + i,
			name: String(f.name ?? "").slice(0, 255),
			relativePath: String(f.relativePath ?? f.name ?? "").slice(0, 4096),
			size: Math.max(0, Math.floor(Number(f.size) || 0)),
			lastModified: Number.isFinite(f.lastModified) ? Math.floor(f.lastModified) : null,
			session,
			// 接收状态：path（收到了）、inflight（正在收）、attempts
			path: null,
			sha256: null,
			inflight: false,
			attempts: 0,
		}));
		const { groups, skipped } = groupFiles(input);
		this.skipped += skipped.length;
		for (const f of input) this.files.push(f);
		for (const g of groups) {
			this.items.push({
				id: this.nextItemId++,
				kind: g.kind,
				folderId,
				folderPath: g.folderPath,
				folder: [folderLabel, ...g.folderPath.split("/")].filter(Boolean).join(" / "),
				files: g.files.map((x) => ({ role: x.role, entry: x.file })),
				tzOffsetMin: Number.isInteger(tzOffsetMin) ? tzOffsetMin : null,
				status: "waiting",
				error: null,
				bytes: g.files.reduce((n, x) => n + x.file.size, 0),
				sent: 0,
				updatedAt: this.now(),
			});
		}
		this.sessions.set(session, this.now());
		this.stopped = null;
		// 网页据此丢掉不会被要的文件（不是照片 / 视频的），否则它一直以为还有文件没发完
		return { first, groups: groups.length, skipped: skipped.map((f) => f.index) };
	}

	/** 网页要下一个该发的文件：{ index } / { wait: 毫秒 }（暂存满了或停下了）/ { idle: true }（这个网页没有要发的了）。 */
	next(session) {
		this.sessions.set(session, this.now());
		this.#expire();
		if (this.stopped) return { wait: 5000 };
		let waiting = false;
		for (const item of this.items) {
			if (item.status !== "waiting") continue;
			const pending = item.files.map((f) => f.entry).filter((e) => !e.path && !e.inflight && e.session === session);
			if (!pending.length) {
				if (item.files.some((f) => f.entry.inflight)) waiting = true;
				continue;
			}
			const f = pending[0];
			if (!this.#fits(f.size, item) && !this.#evictReady(f.size, item)) return { wait: 2000 };
			f.inflight = true;
			this.stagedBytes += f.size;
			return { index: f.index, size: f.size };
		}
		return waiting ? { wait: 1000 } : { idle: true };
	}

	/** 暂存还放得下：字节和条目数都在上限内；一个都没有时，再大的文件也收（否则永远收不了）。 */
	#fits(size, item) {
		if (this.stagedBytes === 0) return true;
		const started = item.files.some((f) => f.entry.path || f.entry.inflight);
		const groups = this.items.filter((i) => i.status === "staged" || i.status === "uploading").length + this.#readyGroups();
		if (!started && groups >= STAGE_MAX_GROUPS) return false;
		return this.stagedBytes + size <= STAGE_MAX_BYTES;
	}

	/**
	 * 删掉最早的等处理的暂存文件，直到放得下这个文件。那些任务认领时找不到暂存文件，照常下载原图。
	 * 正在被 fromLocal 复制的那份删掉后复制失败，同样退回下载。返回最后是否放得下。
	 */
	#evictReady(size, item) {
		const all = [...this.ready.values()].flat().sort((a, b) => a.expires - b.expires);
		for (const r of all) {
			const list = this.ready.get(r.entry.size);
			list.splice(list.indexOf(r), 1);
			if (!list.length) this.ready.delete(r.entry.size);
			void this.#release(r);
			if (this.#fits(size, item)) return true;
		}
		return false;
	}

	#readyGroups() {
		let n = 0;
		for (const list of this.ready.values()) n += list.length;
		return n;
	}

	/**
	 * 接收网页推过来的文件内容（stream 是请求体）。边写暂存文件边算 sha256，大小必须和清单一致。
	 * 出错（网页读不出来、卡住、大小不对）就删掉这次写的内容，文件退回等待，最多 RECEIVE_ATTEMPTS 次。
	 */
	async receive(index, stream) {
		const entry = this.files[index];
		if (!entry || !entry.inflight) throw new Error("not requested");
		const item = this.items.find((i) => i.files.some((f) => f.entry === entry));
		const path = join(this.dir, String(index));
		const hash = createHash("sha256");
		let size = 0;
		let idle;
		const counter = new Transform({
			transform(chunk, _enc, cb) {
				size += chunk.length;
				if (size > entry.size) return cb(new Error("size mismatch"));
				hash.update(chunk);
				idle.refresh();
				cb(null, chunk);
			},
		});
		try {
			await new Promise((resolve, reject) => {
				idle = setTimeout(() => {
					const e = new Error("read stalled");
					stream.destroy?.(e);
					reject(e);
				}, RECEIVE_IDLE_MS);
				pipeline(stream, counter, createWriteStream(path)).then(resolve, reject);
			}).finally(() => clearTimeout(idle));
			if (size !== entry.size) throw new Error("size mismatch");
		} catch (e) {
			await rm(path, { force: true });
			// 期间被取消了的话，cancel() 已经扣过字节
			if (entry.inflight) {
				entry.inflight = false;
				this.stagedBytes -= entry.size;
			}
			entry.attempts++;
			if (item && item.status === "waiting" && entry.attempts >= RECEIVE_ATTEMPTS) {
				this.#fail(item, String(e?.message ?? e));
				await this.#drop(item);
			}
			throw e;
		}
		if (!entry.inflight) {
			// 收的时候被取消了
			await rm(path, { force: true });
			throw new Error("cancelled");
		}
		entry.inflight = false;
		entry.path = path;
		entry.sha256 = hash.digest("hex");
		if (item && item.status === "waiting" && item.files.every((f) => f.entry.path)) {
			item.status = "staged";
			item.updatedAt = this.now();
			this.#pump();
		}
	}

	#pump() {
		while (this.uploading < UPLOAD_CONCURRENCY && !this.stopped) {
			const item = this.items.find((i) => i.status === "staged");
			if (!item) return;
			this.uploading++;
			item.status = "uploading";
			item.updatedAt = this.now();
			this.#upload(item)
				.catch((e) => this.#uploadError(item, e))
				.finally(() => {
					this.uploading--;
					this.#pump();
				});
		}
	}

	async #upload(item) {
		const api = this.getApi();
		if (!api) throw new AuthError("login required");
		const primary = item.files[0].entry;
		let created;
		try {
			created = await api.request("/uploads", {
				method: "POST",
				json: {
					kind: item.kind,
					folderId: item.folderId,
					folderPath: item.folderPath || undefined,
					clientMtime: primary.lastModified || null,
					clientTzOffsetMin: item.tzOffsetMin,
					files: item.files.map((f) => ({ role: f.role, name: f.entry.name, size: f.entry.size, sha256: f.entry.sha256 })),
				},
			});
		} catch (e) {
			if (e instanceof ApiError && e.status === 409) {
				// 先删暂存文件再改状态：界面看到“重复”时磁盘已经腾出来了
				await this.#drop(item);
				item.status = "duplicate";
				item.updatedAt = this.now();
				return;
			}
			throw e;
		}
		const finished = new Set();
		try {
			for (const u of created.uploads) {
				const entry = item.files.find((f) => f.role === u.role).entry;
				const parts = [];
				const file = await open(entry.path);
				try {
					for (let n = 1; n <= u.parts; n++) {
						const offset = (n - 1) * created.partSize;
						const buf = Buffer.alloc(Math.min(created.partSize, entry.size - offset));
						await file.read(buf, 0, buf.length, offset);
						parts.push(
							await api.request(`/uploads/${encodeURIComponent(u.uploadId)}/parts/${n}`, {
								method: "PUT",
								body: buf,
								headers: { "content-type": "application/octet-stream" },
							}),
						);
						item.sent += buf.length;
					}
				} finally {
					await file.close();
				}
				await api.request(`/uploads/${encodeURIComponent(u.uploadId)}/complete`, { method: "POST", json: { parts } });
				finished.add(u.uploadId);
			}
		} catch (e) {
			// 和浏览器一样：取消没传完的上传，条目里一个文件都没传完时服务端连条目一起删
			for (const u of created.uploads) {
				if (!finished.has(u.uploadId)) void api.request(`/uploads/${encodeURIComponent(u.uploadId)}`, { method: "DELETE" }).catch(() => {});
			}
			throw e;
		}
		item.assetId = created.assetId;
		if (this.isAttached()) {
			// 留给本机处理：认领到这个任务时 runner 从这里拿，不下载
			for (const f of item.files) this.#keep(f.entry);
			this.onUploaded();
		} else await this.#drop(item);
		item.status = "done";
		item.updatedAt = this.now();
	}

	async #uploadError(item, e) {
		if (e instanceof AuthError) this.stopped = "login";
		else if (e instanceof ApiError && e.status === 503 && e.code === "guard tripped") this.stopped = "guard tripped";
		if (this.stopped) {
			// 停下来：这个条目退回等上传，恢复后重新来
			item.status = "staged";
			item.sent = 0;
			item.updatedAt = this.now();
			return;
		}
		console.warn(JSON.stringify({ event: "device_upload_failed", item: item.id, error: String(e?.message ?? e).slice(0, 200) }));
		this.#fail(item, e instanceof ApiError ? e.code : String(e?.message ?? e));
		await this.#drop(item);
	}

	#fail(item, error) {
		item.status = "failed";
		item.error = String(error).slice(0, 200);
		item.updatedAt = this.now();
	}

	/** 删掉条目的暂存文件（还在等发送的不管）。 */
	async #drop(item) {
		for (const f of item.files) {
			const e = f.entry;
			if (!e.path) continue;
			const path = e.path;
			e.path = null;
			this.stagedBytes -= e.size;
			await rm(path, { force: true });
		}
	}

	#keep(entry) {
		const list = this.ready.get(entry.size) ?? [];
		list.push({ path: entry.path, name: entry.name.normalize("NFC"), entry, expires: this.now() + STAGED_TTL_MS });
		this.ready.set(entry.size, list);
	}

	/** 过期的暂存文件删掉（处理任务没来认领，比如排在很多旧任务后面）；任务照常下载原图。 */
	#expire() {
		const now = this.now();
		for (const [size, list] of this.ready) {
			const keep = list.filter((r) => r.expires > now);
			for (const r of list) if (r.expires <= now) void this.#release(r);
			if (keep.length) this.ready.set(size, keep);
			else this.ready.delete(size);
		}
	}

	async #release(r) {
		if (!r.entry.path) return;
		r.entry.path = null;
		this.stagedBytes -= r.entry.size;
		await rm(r.path, { force: true });
	}

	// ---- 给 runner.mjs 的 fromLocal 用（和 local.mjs 的 LocalFiles 同样的接口）

	/** 大小一样的暂存文件，同名的在前。 */
	candidates(name, size) {
		const list = this.ready.get(size);
		if (!list) return [];
		const want = name?.normalize("NFC");
		return [...list.filter((r) => r.name === want), ...list.filter((r) => r.name !== want)].map((r) => r.path);
	}

	/** fromLocal 已经把这个文件复制到任务的临时目录：暂存的那份可以删了。 */
	used(path) {
		for (const [size, list] of this.ready) {
			const i = list.findIndex((r) => r.path === path);
			if (i < 0) continue;
			const [r] = list.splice(i, 1);
			if (!list.length) this.ready.delete(size);
			void this.#release(r);
			return;
		}
	}

	/** 交还云端：等本机处理的暂存文件都删掉（云端会从 R2 读）。 */
	dropReady() {
		for (const list of this.ready.values()) for (const r of list) void this.#release(r);
		this.ready.clear();
	}

	// ---- 用户操作

	/** 取消所有还没上传完的条目（正在上传的那几个传完为止）。 */
	async cancel() {
		for (const item of this.items) {
			if (item.status !== "waiting" && item.status !== "staged") continue;
			this.#fail(item, "cancelled");
			await this.#drop(item);
			for (const f of item.files) {
				if (f.entry.inflight) {
					f.entry.inflight = false;
					this.stagedBytes -= f.entry.size;
				}
			}
		}
	}

	/** 继续（停下来之后）并重试失败的条目：已经收到的文件直接上传，没收到的要网页重新发（同一个网页还开着时）。 */
	resume() {
		this.stopped = null;
		for (const item of this.items) {
			if (item.status !== "failed" || item.error === "cancelled") continue;
			item.error = null;
			item.sent = 0;
			for (const f of item.files) f.entry.attempts = 0;
			item.status = item.files.every((f) => f.entry.path) ? "staged" : "waiting";
			item.updatedAt = this.now();
		}
		this.#pump();
	}

	/** 列表清空（没有进行中的条目时）。 */
	clear() {
		if (this.items.some((i) => ACTIVE.has(i.status))) return false;
		this.items = [];
		this.files = [];
		this.skipped = 0;
		return true;
	}

	/** 界面用的摘要：计数、字节、最近的条目（带文件名，只给本机界面）。 */
	summary() {
		this.#expire();
		const counts = { waiting: 0, staged: 0, uploading: 0, done: 0, duplicate: 0, failed: 0 };
		let bytes = 0;
		let sent = 0;
		let orphaned = 0;
		const now = this.now();
		for (const item of this.items) {
			counts[item.status]++;
			if (item.error === "cancelled") continue;
			bytes += item.bytes;
			sent += item.status === "duplicate" || item.status === "done" ? item.bytes : item.sent;
			if (item.status === "waiting" && item.files.some((f) => !f.entry.path && now - (this.sessions.get(f.entry.session) ?? 0) > PAGE_GONE_MS))
				orphaned++;
		}
		const view = (i) => ({ id: i.id, name: i.files[0].entry.name, kind: i.kind, folder: i.folder, status: i.status, error: i.error });
		const recent = [...this.items].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, LIST_MAX).map(view);
		const failed = this.items.filter((i) => i.status === "failed" && i.error !== "cancelled").slice(-LIST_MAX).map(view);
		return {
			counts,
			total: this.items.length,
			skipped: this.skipped,
			bytes,
			sent,
			stagedBytes: this.stagedBytes,
			stagedMax: STAGE_MAX_BYTES,
			waitingForProcessing: this.#readyGroups(),
			orphaned,
			stopped: this.stopped,
			recent,
			failed,
		};
	}
}
