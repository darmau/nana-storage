/**
 * 流式 zip（只存储、不压缩）。CRC32 和大小都事先知道（容器处理时已算好），
 * 所以文件头可以一次写好，数据直接从 R2 转发，Worker 几乎不消耗 CPU；总长度也能提前算出。
 * 单个文件或偏移量超过 4 GB 时自动使用 ZIP64。
 */

export interface ZipEntry {
	name: string;
	size: number;
	crc32: number;
	/** 用于文件时间（本地墙钟时间的毫秒数，按 UTC 解读） */
	mtime: number;
}

export type ZipPart = { kind: "bytes"; data: Uint8Array } | { kind: "entry"; index: number };

const MAX32 = 0xffffffff;
const MAX16 = 0xffff;

class Writer {
	private buf: Uint8Array;
	private view: DataView;
	private pos = 0;
	constructor(size: number) {
		this.buf = new Uint8Array(size);
		this.view = new DataView(this.buf.buffer);
	}
	u16(v: number) {
		this.view.setUint16(this.pos, v, true);
		this.pos += 2;
	}
	u32(v: number) {
		this.view.setUint32(this.pos, v >>> 0, true);
		this.pos += 4;
	}
	u64(v: number) {
		this.view.setBigUint64(this.pos, BigInt(v), true);
		this.pos += 8;
	}
	bytes(b: Uint8Array) {
		this.buf.set(b, this.pos);
		this.pos += b.length;
	}
	done() {
		if (this.pos !== this.buf.length) throw new Error(`zip writer size mismatch ${this.pos} != ${this.buf.length}`);
		return this.buf;
	}
}

function dosDateTime(ms: number): [number, number] {
	const d = new Date(Number.isFinite(ms) && ms > Date.UTC(1980, 0, 1) ? ms : Date.UTC(1980, 0, 1));
	const time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2);
	const date = ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
	return [time, date];
}

const FLAG_UTF8 = 0x0800;

function localHeader(e: ZipEntry, name: Uint8Array, zip64Limit: number): Uint8Array {
	const zip64 = e.size >= zip64Limit;
	const w = new Writer(30 + name.length + (zip64 ? 20 : 0));
	const [time, date] = dosDateTime(e.mtime);
	w.u32(0x04034b50);
	w.u16(zip64 ? 45 : 20);
	w.u16(FLAG_UTF8);
	w.u16(0); // store
	w.u16(time);
	w.u16(date);
	w.u32(e.crc32);
	w.u32(zip64 ? MAX32 : e.size);
	w.u32(zip64 ? MAX32 : e.size);
	w.u16(name.length);
	w.u16(zip64 ? 20 : 0);
	w.bytes(name);
	if (zip64) {
		w.u16(0x0001);
		w.u16(16);
		w.u64(e.size);
		w.u64(e.size);
	}
	return w.done();
}

function centralHeader(e: ZipEntry, name: Uint8Array, offset: number, zip64Limit: number): Uint8Array {
	const zip64 = e.size >= zip64Limit || offset >= zip64Limit;
	const w = new Writer(46 + name.length + (zip64 ? 28 : 0));
	const [time, date] = dosDateTime(e.mtime);
	w.u32(0x02014b50);
	w.u16((3 << 8) | 45); // made by: Unix, 4.5
	w.u16(zip64 ? 45 : 20);
	w.u16(FLAG_UTF8);
	w.u16(0);
	w.u16(time);
	w.u16(date);
	w.u32(e.crc32);
	w.u32(zip64 ? MAX32 : e.size);
	w.u32(zip64 ? MAX32 : e.size);
	w.u16(name.length);
	w.u16(zip64 ? 28 : 0);
	w.u16(0); // comment
	w.u16(0); // disk
	w.u16(0); // internal attrs
	w.u32((0o100644 << 16) >>> 0); // -rw-r--r--
	w.u32(zip64 ? MAX32 : offset);
	w.bytes(name);
	if (zip64) {
		w.u16(0x0001);
		w.u16(24);
		w.u64(e.size);
		w.u64(e.size);
		w.u64(offset);
	}
	return w.done();
}

function endRecords(count: number, cdSize: number, cdOffset: number, zip64Limit: number, forceZip64: boolean): Uint8Array {
	const zip64 = forceZip64 || count >= MAX16 || cdSize >= zip64Limit || cdOffset >= zip64Limit;
	const w = new Writer((zip64 ? 56 + 20 : 0) + 22);
	if (zip64) {
		const zip64EocdOffset = cdOffset + cdSize;
		w.u32(0x06064b50);
		w.u64(44);
		w.u16((3 << 8) | 45);
		w.u16(45);
		w.u32(0);
		w.u32(0);
		w.u64(count);
		w.u64(count);
		w.u64(cdSize);
		w.u64(cdOffset);
		w.u32(0x07064b50);
		w.u32(0);
		w.u64(zip64EocdOffset);
		w.u32(1);
	}
	w.u32(0x06054b50);
	w.u16(0);
	w.u16(0);
	w.u16(zip64 ? MAX16 : count);
	w.u16(zip64 ? MAX16 : count);
	w.u32(zip64 ? MAX32 : cdSize);
	w.u32(zip64 ? MAX32 : cdOffset);
	w.u16(0);
	return w.done();
}

/**
 * 计算 zip 的组成部分和总长度。entry 部分由调用方用对应文件的字节流填充。
 * zip64Limit 只在测试里调小，用来覆盖 ZIP64 分支。
 */
export function zipLayout(entries: ZipEntry[], zip64Limit = MAX32): { parts: ZipPart[]; totalSize: number } {
	const enc = new TextEncoder();
	const parts: ZipPart[] = [];
	const central: Uint8Array[] = [];
	let offset = 0;
	let anyZip64 = false;
	entries.forEach((e, index) => {
		const name = enc.encode(e.name);
		const lh = localHeader(e, name, zip64Limit);
		central.push(centralHeader(e, name, offset, zip64Limit));
		if (e.size >= zip64Limit || offset >= zip64Limit) anyZip64 = true;
		parts.push({ kind: "bytes", data: lh }, { kind: "entry", index });
		offset += lh.length + e.size;
	});
	const cdOffset = offset;
	const cdSize = central.reduce((n, c) => n + c.length, 0);
	for (const c of central) parts.push({ kind: "bytes", data: c });
	const end = endRecords(entries.length, cdSize, cdOffset, zip64Limit, anyZip64);
	parts.push({ kind: "bytes", data: end });
	return { parts, totalSize: cdOffset + cdSize + end.length };
}

/** 同名文件加序号："IMG_1.JPG" → "IMG_1 (2).JPG"。去掉路径分隔符和控制字符。 */
export function uniqueNames(names: string[]): string[] {
	const used = new Set<string>();
	return names.map((raw) => {
		const clean = raw.replace(/[\u0000-\u001f\u007f/\\]/g, "_").replace(/^\.+/, "_") || "file";
		const dot = clean.lastIndexOf(".");
		const [base, ext] = dot > 0 ? [clean.slice(0, dot), clean.slice(dot)] : [clean, ""];
		let name = clean;
		for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base} (${n})${ext}`;
		used.add(name.toLowerCase());
		return name;
	});
}
