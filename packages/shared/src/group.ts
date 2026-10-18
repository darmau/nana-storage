/**
 * 浏览器上传（apps/web/src/upload）和设备端上传（apps/device/upload.mjs）共用。
 * 这个文件不能 import 任何东西、只能用可擦除的 TypeScript 语法：设备端用 Node 直接加载它（类型擦除），不经过构建。
 *
 * 把选中的文件按“同目录 + 同名主干”配对成条目：
 *   IMG_1234.HEIC + IMG_1234.MOV          → live
 *   DSC0001.ARW  + DSC0001.JPG            → photo（JPEG 主图 + RAW 附件）
 *   DSC0002.ARW                           → photo（只有 RAW）
 *   clip.mp4                              → video
 * 同名的多张图片（比如 .JPG 和 .HEIC）各自成为独立条目，HEIC 优先和视频配对。
 */

export type Role = "original" | "raw" | "live_video";
export type Kind = "photo" | "video" | "live";

export interface InputFile {
	name: string;
	/** 相对于所选文件夹的路径（webkitRelativePath），单选文件时为空。 */
	relativePath: string;
	size: number;
}

export interface Group<F extends InputFile = InputFile> {
	kind: Kind;
	/** 文件夹路径（不含文件名），没有时为空字符串。 */
	folderPath: string;
	files: { role: Role; file: F }[];
}

const IMAGE = new Set(["jpg", "jpeg", "heic", "heif", "png", "webp", "gif", "avif", "tif", "tiff"]);
const RAW = new Set(["arw", "srf", "sr2", "nef", "nrw", "cr2", "cr3", "dng", "raf", "orf", "rw2", "pef", "rwl", "3fr", "iiq", "erf", "srw"]);
const VIDEO = new Set(["mov", "mp4", "m4v", "avi", "mkv", "3gp"]);

const ext = (name: string) => name.toLowerCase().split(".").pop() ?? "";
const stem = (name: string) => name.replace(/\.[^.]+$/, "").toLowerCase();
const dirOf = (f: InputFile) => {
	const p = f.relativePath || f.name;
	const i = p.lastIndexOf("/");
	return i < 0 ? "" : p.slice(0, i);
};

/** 图片作为 Live Photo 主图的优先级：HEIC 最高。 */
const imageRank = (name: string) => (["heic", "heif"].includes(ext(name)) ? 0 : 1);

export function classify(name: string): "image" | "raw" | "video" | null {
	const e = ext(name);
	if (IMAGE.has(e)) return "image";
	if (RAW.has(e)) return "raw";
	if (VIDEO.has(e)) return "video";
	return null;
}

export function groupFiles<F extends InputFile>(files: F[]): { groups: Group<F>[]; skipped: F[] } {
	const buckets = new Map<string, F[]>();
	const skipped: F[] = [];
	for (const f of files) {
		if (!classify(f.name) || f.size === 0 || f.name.startsWith("._") || f.name.startsWith(".")) {
			skipped.push(f);
			continue;
		}
		const key = `${dirOf(f)}\u0000${stem(f.name)}`;
		const list = buckets.get(key);
		if (list) list.push(f);
		else buckets.set(key, [f]);
	}

	const groups: Group<F>[] = [];
	for (const list of buckets.values()) {
		const folderPath = dirOf(list[0]!);
		const images = list.filter((f) => classify(f.name) === "image").sort((a, b) => imageRank(a.name) - imageRank(b.name));
		const raws = list.filter((f) => classify(f.name) === "raw");
		const videos = list.filter((f) => classify(f.name) === "video");

		// 第一张图片拿走第一段视频和第一个 RAW
		const first = images.shift();
		if (first) {
			const g: Group<F> = { kind: "photo", folderPath, files: [{ role: "original", file: first }] };
			const video = videos.shift();
			if (video) {
				g.kind = "live";
				g.files.push({ role: "live_video", file: video });
			}
			const raw = raws.shift();
			if (raw) g.files.push({ role: "raw", file: raw });
			groups.push(g);
		}
		for (const img of images) groups.push({ kind: "photo", folderPath, files: [{ role: "original", file: img }] });
		for (const raw of raws) groups.push({ kind: "photo", folderPath, files: [{ role: "raw", file: raw }] });
		for (const v of videos) groups.push({ kind: "video", folderPath, files: [{ role: "original", file: v }] });
	}
	return { groups, skipped };
}
