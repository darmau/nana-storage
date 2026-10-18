import { t } from "../i18n";
import { StallError } from "./read";

/** 三个哈希 Worker 轮流使用。 */
const POOL_SIZE = 3;

type Pending = { resolve: (v: string) => void; reject: (e: Error) => void; worker: number };
const workers: (Worker | undefined)[] = [];
const pending = new Map<number, Pending>();
let nextId = 0;

function worker(i: number) {
	if (!workers[i]) {
		const w = new Worker(new URL("./hash.worker.ts", import.meta.url), { type: "module" });
		w.onmessage = (e: MessageEvent<{ id: number; sha256?: string; error?: string; stalled?: boolean }>) => {
			const p = pending.get(e.data.id);
			pending.delete(e.data.id);
			if (!p) return;
			if (e.data.sha256) p.resolve(e.data.sha256);
			else if (e.data.stalled) p.reject(new StallError());
			else p.reject(new Error(e.data.error ?? "hash failed"));
		};
		// Worker 崩了（比如内存不足）不会再回消息：把它手上的任务都判失败，下次换一个新的，
		// 否则这些条目会永远停在“计算校验和”，占着上传的并发名额。
		w.onerror = (e) => {
			e.preventDefault();
			w.terminate();
			if (workers[i] === w) workers[i] = undefined;
			for (const [id, p] of pending) {
				if (p.worker !== i) continue;
				pending.delete(id);
				p.reject(new Error(t.upload.hashFailed));
			}
		};
		workers[i] = w;
	}
	return workers[i]!;
}

export function sha256File(file: File): Promise<string> {
	const id = nextId++;
	const i = id % POOL_SIZE;
	return new Promise((resolve, reject) => {
		pending.set(id, { resolve, reject, worker: i });
		worker(i).postMessage({ id, file });
	});
}
