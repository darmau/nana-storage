/**
 * 读本地文件（算校验和、读分块）的限流和卡住检测。
 *
 * 文件在 NAS / 网络盘上时，连接断开（比如 Mac 睡眠后）会让浏览器读文件的系统调用一直不返回。
 * 每个卡住的读取都会占住浏览器进程的一个后台线程，而且网页没办法取消它；线程全被占满之后，
 * 整个浏览器里要读写磁盘的事情都会排队，看起来就是浏览器卡死。所以：
 *  - 同时最多 READ_CONCURRENCY 个读取，上传的并发主要用来等网络，分块先读进内存再发；
 *  - 连续 STALL_MS 没有读到新数据就放弃（StallError），由上传队列暂停，等用户确认连接后再继续。
 */

export const READ_CONCURRENCY = 2;
export const STALL_MS = 60_000;

/** hash.worker 也导入这个文件，所以这里的错误不带界面文案（不把 i18n 打进 Worker），显示时由上传队列翻译。 */
export class StallError extends Error {
	constructor() {
		super("read stalled");
		this.name = "StallError";
	}
}

export class FileChangedError extends Error {
	constructor() {
		super("file changed while reading");
		this.name = "FileChangedError";
	}
}

/** 等待 p，超过 STALL_MS 没结果就抛 StallError（p 本身取消不了，只是不再等它）。 */
export function withStall<T>(p: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const stall = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new StallError()), STALL_MS);
	});
	return Promise.race([p, stall]).finally(() => clearTimeout(timer));
}

let reading = 0;
const waiters: (() => void)[] = [];

/**
 * 占一个读取名额执行 fn。卡住放弃时名额也归还：底层的读取还挂着，但队列已经暂停，
 * 只有用户点“继续”才会发起新的读取，卡住的线程数不会自己增长。
 */
export async function withReadSlot<T>(fn: () => Promise<T>): Promise<T> {
	while (reading >= READ_CONCURRENCY) await new Promise<void>((r) => waiters.push(r));
	reading++;
	try {
		return await fn();
	} finally {
		reading--;
		waiters.shift()?.();
	}
}

/** 把一个分块整个读进内存（带卡住检测），之后的发送和重试都不再碰磁盘。 */
export async function readBlob(blob: Blob): Promise<Uint8Array<ArrayBuffer>> {
	const out = new Uint8Array(blob.size);
	const reader = blob.stream().getReader();
	let offset = 0;
	try {
		for (;;) {
			const { done, value } = await withStall(reader.read());
			if (done) break;
			out.set(value, offset);
			offset += value.length;
		}
	} catch (e) {
		void reader.cancel().catch(() => {});
		throw e;
	}
	if (offset !== blob.size) throw new FileChangedError();
	return out;
}
