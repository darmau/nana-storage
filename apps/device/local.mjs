import { createReadStream } from "node:fs";
import { opendir, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * 本机的原件索引：compose.override.yaml 把存原图的目录只读挂到 /local 下（见 README）。
 * 输入文件在这里找得到（大小一样，再按 sha256 确认）就不用从服务器下载。
 *
 * 索引只记大小 → [路径, 文件名]，按大小找候选，同名的排前面（照片库导出的文件名可能和上传时不同，所以不要求同名）。
 * 扫描在后台进行，扫描期间用已经扫到的部分；找不到时最多每 RESCAN_MS 重新扫一次（新拷进来的文件）。
 * 不跟随符号链接，跳过隐藏目录（.Trashes、@eaDir 之类），最多记 MAX_FILES 个文件。
 */

const RESCAN_MS = 5 * 60_000;
const MAX_FILES = 2_000_000;
/** 每个输入最多读几个候选（大小一样、内容不同的文件很少见） */
export const MAX_CANDIDATES = 3;

export class LocalFiles {
	constructor(root) {
		this.root = root;
		this.bySize = new Map();
		this.files = 0;
		this.scanning = null;
		this.scannedAt = 0;
		this.available = false;
	}

	/** 后台扫描；已经在扫或者 RESCAN_MS 内扫过就不扫。 */
	refresh({ force = false } = {}) {
		if (this.scanning || (!force && Date.now() - this.scannedAt < RESCAN_MS)) return this.scanning;
		this.scannedAt = Date.now();
		this.scanning = this.#scan()
			.catch((e) => console.warn(JSON.stringify({ event: "local_scan_failed", error: String(e?.message ?? e).slice(0, 200) })))
			.finally(() => {
				this.scanning = null;
			});
		return this.scanning;
	}

	async #scan() {
		const root = await stat(this.root).catch(() => null);
		if (!root?.isDirectory()) {
			this.available = false;
			return;
		}
		const bySize = new Map();
		let files = 0;
		const dirs = [this.root];
		while (dirs.length && files < MAX_FILES) {
			const dir = dirs.pop();
			let handle;
			try {
				handle = await opendir(dir);
			} catch {
				continue;
			}
			for await (const entry of handle) {
				if (entry.name.startsWith(".") || entry.name.startsWith("@")) continue;
				const path = join(dir, entry.name);
				if (entry.isDirectory()) dirs.push(path);
				else if (entry.isFile()) {
					const s = await stat(path).catch(() => null);
					if (!s || s.size === 0) continue;
					const list = bySize.get(s.size);
					const item = [path, entry.name.normalize("NFC")];
					if (list) list.push(item);
					else bySize.set(s.size, [item]);
					if (++files >= MAX_FILES) break;
				}
			}
		}
		this.bySize = bySize;
		this.files = files;
		this.available = true;
	}

	/** 大小一样的候选路径，同名的在前，最多 MAX_CANDIDATES 个。没有的话安排一次重新扫描（下一个任务才用得上）。 */
	candidates(name, size) {
		const list = this.bySize.get(size);
		if (!list) {
			void this.refresh();
			return [];
		}
		const want = name?.normalize("NFC");
		return [...list.filter(([, n]) => n === want), ...list.filter(([, n]) => n !== want)].slice(0, MAX_CANDIDATES).map(([p]) => p);
	}
}

export const openLocal = (path) => createReadStream(path, { highWaterMark: 1024 * 1024 });
