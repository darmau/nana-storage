import { ApiError, api, errorText } from "../api";
import { t } from "../i18n";
import { type Group, groupFiles } from "@nana/shared";
import { sha256File } from "./hasher";
import { FileChangedError, StallError, readBlob, withReadSlot } from "./read";

/**
 * 上传队列。
 *  - 同时上传 CONCURRENCY 个条目；读本地文件另有限流（read.ts），分块先读进内存再发。
 *  - 每个请求最多尝试 MAX_ATTEMPTS 次，指数退避；429 等更久。超过次数就把这个条目标记为失败，继续下一个。
 *  - 服务端返回 409（重复）就跳过；返回 503（成本防护已触发）就整体暂停，不再继续发请求。
 *  - 读文件卡住（NAS 断开）也整体暂停：再开新的读取只会占住更多浏览器线程，等用户确认连接后点“继续”。
 *  - 断点续传靠“重新选择 + 去重”：已经传完的文件会被 409 跳过。
 */

const CONCURRENCY = 6;
const MAX_ATTEMPTS = 3;
const NOTIFY_MS = 200;

type UploadFile = File & { relativePath: string };

export type ItemStatus = "queued" | "hashing" | "uploading" | "done" | "duplicate" | "failed";

export interface Item {
	id: number;
	group: Group<UploadFile>;
	label: string;
	bytes: number;
	sent: number;
	status: ItemStatus;
	error?: string;
	assetId?: string;
	folderId: string | null;
	/** 显示用的目标文件夹路径（目标文件夹 + 保留的目录结构），为空表示不放进文件夹。 */
	folder: string;
}

export interface Snapshot {
	items: Item[];
	skipped: File[];
	running: boolean;
	stoppedReason: string | null;
	counts: Record<ItemStatus, number>;
	totalBytes: number;
	sentBytes: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withRetry<T>(fn: () => Promise<T>, signal: AbortSignal): Promise<T> {
	let lastError: unknown;
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		if (signal.aborted) throw new Error("cancelled");
		try {
			return await fn();
		} catch (e) {
			lastError = e;
			// 这些错误重试也没用
			if (e instanceof ApiError && [400, 403, 404, 409, 413, 415, 503].includes(e.status)) throw e;
			if (attempt < MAX_ATTEMPTS) {
				const wait = e instanceof ApiError && e.status === 429 ? 15_000 : 1000 * 4 ** (attempt - 1);
				await sleep(wait);
			}
		}
	}
	throw lastError;
}

/**
 * 上传一个分块。用 XHR 而不是 fetch，是为了拿到发送中的字节进度（20 MB 的分块在慢网络上要很久）。
 * 和 api() 一样：同源、带 X-Requested-With，失败抛 ApiError。
 */
function putPart(path: string, body: Uint8Array<ArrayBuffer>, signal: AbortSignal, onProgress: (loaded: number) => void) {
	return new Promise<{ partNumber: number; etag: string }>((resolve, reject) => {
		const xhr = new XMLHttpRequest();
		xhr.open("PUT", `/api${path}`);
		xhr.setRequestHeader("X-Requested-With", "nana");
		xhr.upload.onprogress = (e) => onProgress(e.loaded);
		xhr.onload = () => {
			let body: unknown = xhr.responseText;
			try {
				body = xhr.responseText ? JSON.parse(xhr.responseText) : null;
			} catch {}
			if (xhr.status >= 200 && xhr.status < 300) resolve(body as { partNumber: number; etag: string });
			else reject(new ApiError(xhr.status, body));
		};
		xhr.onerror = () => reject(new Error(t.upload.network));
		const abort = () => xhr.abort();
		xhr.onabort = () => reject(new Error("cancelled"));
		xhr.onloadend = () => signal.removeEventListener("abort", abort);
		signal.addEventListener("abort", abort);
		xhr.send(body);
	});
}

interface CreateResponse {
	assetId: string;
	partSize: number;
	uploads: { uploadId: string; role: string; parts: number }[];
}

export class Uploader {
	private items: Item[] = [];
	private skipped: File[] = [];
	private queue: Item[] = [];
	private running = 0;
	private stoppedReason: string | null = null;
	private controller = new AbortController();
	private listeners = new Set<() => void>();
	private snapshot: Snapshot = this.buildSnapshot();
	private notifyScheduled = false;
	private nextId = 0;

	subscribe = (fn: () => void) => {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	};
	getSnapshot = () => this.snapshot;

	private notify() {
		// 合并成每 NOTIFY_MS 最多一次：重建快照和面板排序都要遍历全部条目，几万个文件时每帧做一次会一直占着主线程
		if (this.notifyScheduled) return;
		this.notifyScheduled = true;
		setTimeout(
			() =>
				requestAnimationFrame(() => {
					this.notifyScheduled = false;
					this.snapshot = this.buildSnapshot();
					for (const fn of this.listeners) fn();
				}),
			NOTIFY_MS,
		);
	}

	private buildSnapshot(): Snapshot {
		const counts: Record<ItemStatus, number> = { queued: 0, hashing: 0, uploading: 0, done: 0, duplicate: 0, failed: 0 };
		let totalBytes = 0;
		let sentBytes = 0;
		for (const it of this.items) {
			counts[it.status]++;
			totalBytes += it.bytes;
			sentBytes += it.status === "duplicate" ? it.bytes : it.sent;
		}
		return {
			items: this.items,
			skipped: this.skipped,
			running: this.running > 0,
			stoppedReason: this.stoppedReason,
			counts,
			totalBytes,
			sentBytes,
		};
	}

	/**
	 * 加入一批文件。folderId 是目标文件夹（为空表示不放进文件夹，或按所选文件夹的目录结构建）；
	 * folderLabel 是它的显示路径。paths 和 files 一一对应（拖进来的文件夹），给了就按它保留目录结构。
	 */
	add(files: File[], opts: { folderId: string | null; folderLabel: string; keepStructure: boolean; paths?: string[] }) {
		const { groups, skipped } = groupFiles(
			files.map((f, i) =>
				Object.assign(f, {
					relativePath: opts.paths?.[i] ?? (opts.keepStructure ? f.webkitRelativePath || f.name : f.name),
				}),
			) as UploadFile[],
		);
		this.skipped.push(...skipped);
		const newItems: Item[] = groups.map((g) => ({
			id: this.nextId++,
			group: g,
			label: g.files[0]!.file.name,
			bytes: g.files.reduce((a, f) => a + f.file.size, 0),
			sent: 0,
			status: "queued",
			folderId: opts.folderId,
			folder: [opts.folderLabel, g.folderPath].filter(Boolean).join(" / "),
		}));
		this.items.push(...newItems);
		this.queue.push(...newItems);
		this.stoppedReason = null;
		this.pump();
		this.notify();
	}

	cancel() {
		this.controller.abort();
		this.controller = new AbortController();
		for (const it of this.queue) {
			it.status = "failed";
			it.error = t.upload.cancelled;
		}
		this.queue = [];
		this.notify();
	}

	/** 清空列表（只在没有进行中的条目时）。 */
	clear() {
		if (this.running || this.queue.length) return;
		this.items = [];
		this.skipped = [];
		this.stoppedReason = null;
		this.notify();
	}

	/** 重试失败的条目（排到最前），同时解除暂停。 */
	retryFailed() {
		const failed = this.items.filter((it) => it.status === "failed");
		for (const it of failed) {
			it.status = "queued";
			it.error = undefined;
			it.sent = 0;
		}
		this.queue.unshift(...failed);
		this.stoppedReason = null;
		this.pump();
		this.notify();
	}

	private pump() {
		while (this.running < CONCURRENCY && this.queue.length && !this.stoppedReason) {
			const item = this.queue.shift()!;
			this.running++;
			this.uploadItem(item, this.controller.signal)
				.catch((e) => {
					if (e instanceof ApiError && e.status === 409) {
						item.status = "duplicate";
					} else {
						item.status = "failed";
						item.error = e instanceof StallError ? t.upload.readTimeout : e instanceof FileChangedError ? t.upload.fileChanged : errorText(e);
						if (e instanceof StallError) {
							this.stoppedReason ??= t.upload.stalled;
						} else if (e instanceof ApiError && e.status === 503) {
							// 服务端熔断或超出当天上传量：停止发送，避免继续消耗
							this.stoppedReason = t.upload.guardTripped;
							for (const q of this.queue) q.status = "queued";
						}
					}
				})
				.finally(() => {
					this.running--;
					this.notify();
					this.pump();
				});
		}
	}

	private async uploadItem(item: Item, signal: AbortSignal) {
		const { group } = item;
		item.status = "hashing";
		this.notify();
		const hashes: string[] = [];
		for (const f of group.files) hashes.push(await withReadSlot(() => sha256File(f.file)));

		item.status = "uploading";
		this.notify();
		const primary = group.files[0]!.file;
		const created = await withRetry(
			() =>
				api<CreateResponse>("/uploads", {
					method: "POST",
					json: {
						kind: group.kind,
						folderId: item.folderId,
						folderPath: group.folderPath || undefined,
						clientMtime: primary.lastModified || null,
						clientTzOffsetMin: -new Date().getTimezoneOffset(),
						files: group.files.map((f, i) => ({ role: f.role, name: f.file.name, size: f.file.size, sha256: hashes[i] })),
					},
				}),
			signal,
		);
		item.assetId = created.assetId;

		const finished = new Set<string>();
		try {
			await this.sendFiles(item, created, finished, signal);
		} catch (e) {
			// 取消没传完的上传：条目里一个文件都没传完时服务端连条目一起删，重试时不会留下“上传中断”的空条目
			for (const u of created.uploads) {
				if (!finished.has(u.uploadId)) void api(`/uploads/${u.uploadId}`, { method: "DELETE" }).catch(() => {});
			}
			throw e;
		}
		item.status = "done";
	}

	private async sendFiles(item: Item, created: CreateResponse, finished: Set<string>, signal: AbortSignal) {
		const { group } = item;
		for (const u of created.uploads) {
			const file = group.files.find((f) => f.role === u.role)!.file;
			const parts: { partNumber: number; etag: string }[] = [];
			for (let n = 1; n <= u.parts; n++) {
				const body = await withReadSlot(() => readBlob(file.slice((n - 1) * created.partSize, n * created.partSize)));
				if (signal.aborted) throw new Error("cancelled");
				const base = item.sent;
				const part = await withRetry(
					() =>
						putPart(`/uploads/${u.uploadId}/parts/${n}`, body, signal, (loaded) => {
							item.sent = base + loaded;
							this.notify();
						}),
					signal,
				);
				parts.push(part);
				item.sent = base + body.length;
				this.notify();
			}
			await withRetry(() => api(`/uploads/${u.uploadId}/complete`, { method: "POST", json: { parts }, signal }), signal);
			finished.add(u.uploadId);
		}
	}
}

export const uploader = new Uploader();
