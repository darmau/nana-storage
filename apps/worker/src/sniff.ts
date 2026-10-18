/**
 * 按文件头（magic bytes）判断类型，不信任文件名和浏览器给的 MIME。
 * 不认识的一律拒绝；SVG/HTML 这类能在同源下执行脚本的格式永远不会通过。
 */

export type Category = "image" | "raw" | "video";
export interface Sniffed {
	mime: string;
	category: Category;
}

const RAW_EXT = new Set(["arw", "srf", "sr2", "nef", "nrw", "cr2", "dng", "pef", "rwl", "3fr", "iiq", "erf", "mef", "mos", "kdc", "dcr", "srw"]);

const ascii = (b: Uint8Array, start: number, len: number) =>
	String.fromCharCode(...b.subarray(start, start + len));

export function sniff(bytes: Uint8Array, filename = ""): Sniffed | null {
	const ext = filename.toLowerCase().split(".").pop() ?? "";
	if (bytes.length < 16) return null;

	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { mime: "image/jpeg", category: "image" };
	if (ascii(bytes, 0, 8) === "\x89PNG\r\n\x1a\n") return { mime: "image/png", category: "image" };
	if (ascii(bytes, 0, 4) === "GIF8") return { mime: "image/gif", category: "image" };
	if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return { mime: "image/webp", category: "image" };
	if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "AVI ") return { mime: "video/x-msvideo", category: "video" };
	if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3)
		return { mime: "video/x-matroska", category: "video" };

	// ISO BMFF（HEIC/AVIF/MP4/MOV/CR3）
	if (ascii(bytes, 4, 4) === "ftyp") {
		const brand = ascii(bytes, 8, 4);
		if (["heic", "heix", "hevc", "hevx", "heim", "heis"].includes(brand)) return { mime: "image/heic", category: "image" };
		if (["mif1", "msf1"].includes(brand)) return { mime: "image/heif", category: "image" };
		if (["avif", "avis"].includes(brand)) return { mime: "image/avif", category: "image" };
		if (brand === "crx ") return { mime: "image/x-canon-cr3", category: "raw" };
		if (brand === "qt  ") return { mime: "video/quicktime", category: "video" };
		if (/^(isom|iso[2-9]|mp4[12]|avc1|M4V |M4VP|MSNV|dash|3gp\d|3g2\w)$/.test(brand))
			return { mime: "video/mp4", category: "video" };
		return null;
	}
	// 老式 QuickTime（没有 ftyp，直接是 moov/mdat/wide/free）
	if (["moov", "mdat", "wide", "free", "skip"].includes(ascii(bytes, 4, 4)) && ext === "mov")
		return { mime: "video/quicktime", category: "video" };

	if (ascii(bytes, 0, 15) === "FUJIFILMCCD-RAW") return { mime: "image/x-fuji-raf", category: "raw" };
	const head4 = ascii(bytes, 0, 4);
	if (head4 === "IIRO" || head4 === "IIRS" || head4 === "MMOR") return { mime: "image/x-olympus-orf", category: "raw" };
	if (head4 === "IIU\0") return { mime: "image/x-panasonic-rw2", category: "raw" };
	if (head4 === "II*\0" || head4 === "MM\0*") {
		if (ascii(bytes, 8, 2) === "CR") return { mime: "image/x-canon-cr2", category: "raw" };
		if (RAW_EXT.has(ext)) return { mime: `image/x-raw-${ext}`, category: "raw" };
		return { mime: "image/tiff", category: "image" };
	}
	return null;
}
