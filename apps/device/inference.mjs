import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";

/**
 * 推理线程池：设备端并发处理多张照片时，CLIP 和人脸模型的推理放进几个 worker 线程里跑。
 * onnxruntime-node 的 run() 在调用它的线程上同步执行：都放在主线程时，所有任务的推理排队挤在一个核上，
 * 界面、上传、下载也跟着卡住。交给 lib.mjs 的 setSessionFactory() 使用，处理代码不变，结果和容器完全一致
 * （换线程不改变推理结果）。
 *
 * 规模按 CPU 数：worker 数约为 CPU 数的 1/4（1–4 个），每个 worker 的推理线程合计约占一半的 CPU。
 * 实测（12 核、并发 9 张）：3 个 worker × 2 线程比全部在主线程上快一倍多。
 * 每个 worker 各自加载一份模型（CLIP 约 90 MB + 人脸约 190 MB），满负荷时整个容器约 1.5 GB 内存。
 * 模型在第一次用到时才加载。worker 意外退出时，它手上的推理失败（和推理出错一样只影响那一张的指纹 / 人脸），并换一个新的 worker。
 * 注意：推理进行中终止 worker（terminate）会让 onnxruntime 的原生代码中止整个进程，所以 close() 只在没有推理时调用；
 * 原生层面的崩溃本来也会带走整个进程，和推理在主线程上时一样。
 */
export function poolSize(cpus = availableParallelism()) {
	const workers = Math.min(4, Math.max(1, Math.round(cpus / 4)));
	const threads = Math.max(1, Math.floor(cpus / 2 / workers));
	return { workers, threads };
}

export class InferencePool {
	constructor({ workers, threads } = poolSize()) {
		this.threads = threads;
		this.workers = Array.from({ length: workers }, () => this.spawn());
		this.pending = new Map();
		this.seq = 0;
		this.names = new Map();
	}

	spawn() {
		const slot = { worker: new Worker(new URL("./inference-worker.mjs", import.meta.url), { workerData: { threads: this.threads } }), busy: 0, ids: new Set() };
		slot.worker.on("message", ({ id, error, names, outputs }) => {
			const p = this.pending.get(id);
			if (!p) return;
			this.pending.delete(id);
			slot.ids.delete(id);
			if (--slot.busy === 0) slot.worker.unref();
			if (error) p.reject(new Error(error));
			else p.resolve(names ?? outputs);
		});
		const crashed = (e) => {
			if (slot.dead) return;
			slot.dead = true;
			for (const id of slot.ids) {
				this.pending.get(id)?.reject(e instanceof Error ? e : new Error(`inference worker exited (${e})`));
				this.pending.delete(id);
			}
			const i = this.workers.indexOf(slot);
			if (i >= 0 && !this.closed) this.workers[i] = this.spawn();
		};
		slot.worker.on("error", crashed);
		slot.worker.on("exit", crashed);
		// 空闲的 worker 不应该让进程退不出去；有推理在跑时 ref（send），否则等结果期间进程可能先退出
		slot.worker.unref();
		return slot;
	}

	send(slot, msg) {
		const id = ++this.seq;
		if (slot.busy++ === 0) slot.worker.ref();
		slot.ids.add(id);
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			slot.worker.postMessage({ id, ...msg });
		});
	}

	/** 交给 setSessionFactory 的工厂：返回和 onnxruntime 会话同样用法的对象。 */
	open = async (path, opts) => {
		let names = this.names.get(path);
		if (!names) {
			names = this.send(this.workers[0], { op: "open", path, opts }).catch((e) => {
				this.names.delete(path);
				throw e;
			});
			this.names.set(path, names);
		}
		const { inputNames, outputNames } = await names;
		return {
			inputNames,
			outputNames,
			run: (feeds) => {
				const slot = this.workers.reduce((a, b) => (b.busy < a.busy ? b : a));
				const plain = {};
				for (const [name, t] of Object.entries(feeds)) plain[name] = { type: t.type, data: t.data, dims: t.dims };
				return this.send(slot, { op: "run", path, opts, feeds: plain });
			},
		};
	};

	close() {
		this.closed = true;
		return Promise.all(this.workers.map((s) => s.worker.terminate()));
	}
}
