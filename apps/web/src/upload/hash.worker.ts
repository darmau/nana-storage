import { createSHA256, type IHasher } from "hash-wasm";
import { StallError, withStall } from "./read";

/**
 * 在 Web Worker 里流式计算 SHA-256，不阻塞界面，也不把整个文件读进内存。
 * createSHA256() 每次都新建一个 WASM 实例（各自一块内存），几万个文件时会堆积到 GC 跟不上，
 * 所以实例用完放回来复用；同一个 Worker 里可能同时算几个文件，实例数等于最大并发数。
 * 读取卡住（NAS 断开）时放弃并回报 stalled；卡住的那次 read() 之后返回也没人接，实例可以照常放回。
 */
const free: IHasher[] = [];

self.onmessage = async (e: MessageEvent<{ id: number; file: File }>) => {
	const { id, file } = e.data;
	let hasher: IHasher | undefined;
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	try {
		hasher = free.pop() ?? (await createSHA256());
		hasher.init();
		reader = file.stream().getReader();
		for (;;) {
			const { done, value } = await withStall(reader.read());
			if (done) break;
			hasher.update(value);
		}
		postMessage({ id, sha256: hasher.digest("hex") });
	} catch (err) {
		void reader?.cancel().catch(() => {});
		postMessage({ id, error: String(err), stalled: err instanceof StallError });
	} finally {
		if (hasher) free.push(hasher);
	}
};
