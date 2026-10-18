// 推理线程池的 worker（见 inference.mjs）：在这个线程里打开 onnxruntime 会话、跑推理，主线程不再被推理卡住。
// 消息：{ id, op: "open" | "run", path, opts, feeds? }，回复 { id, names? , outputs?, error? }。
import { parentPort, workerData } from "node:worker_threads";
import { ort } from "../processor/lib.mjs";

const sessions = new Map();

/** 同一个模型、同样的选项只打开一次（线程数由线程池决定，不看调用方传的）。 */
function open(path, opts) {
	const { intraOpNumThreads, ...rest } = opts ?? {};
	const key = `${path} ${JSON.stringify(Object.entries(rest).sort())}`;
	let s = sessions.get(key);
	if (!s) {
		s = ort.InferenceSession.create(path, { ...rest, intraOpNumThreads: workerData.threads }).catch((e) => {
			sessions.delete(key); // 下次再试
			throw e;
		});
		sessions.set(key, s);
	}
	return s;
}

parentPort.on("message", async ({ id, op, path, opts, feeds }) => {
	try {
		const session = await open(path, opts);
		if (op === "open") {
			parentPort.postMessage({ id, names: { inputNames: session.inputNames, outputNames: session.outputNames } });
			return;
		}
		const tensors = {};
		for (const [name, t] of Object.entries(feeds)) tensors[name] = new ort.Tensor(t.type, t.data, t.dims);
		const result = await session.run(tensors);
		const outputs = {};
		for (const [name, t] of Object.entries(result)) outputs[name] = { type: t.type, data: t.data, dims: t.dims };
		// 输出很小（几百 KB 以内），直接复制：onnxruntime 的输出缓冲区可能共用或来自原生内存，不适合转移
		parentPort.postMessage({ id, outputs });
	} catch (e) {
		parentPort.postMessage({ id, error: String(e?.message ?? e) });
	}
});
