/**
 * 从拖放里取出文件。拖进来的文件夹会递归展开，路径和“选择文件夹”的 webkitRelativePath 一样，
 * 以被拖的文件夹名开头（“旅行/2024/IMG_1.HEIC”）；直接拖的文件只有文件名。
 *
 * DataTransferItemList 只在 drop 事件处理函数里同步有效，所以这里先同步取出所有 entry，再异步展开。
 */

export interface DroppedFile {
	file: File;
	path: string;
}

/** 防止误拖进整个磁盘之类的目录：展开到这么多文件就停。 */
export const MAX_DROP_FILES = 100_000;

export function filesFromDrop(dt: DataTransfer): Promise<DroppedFile[]> {
	const entries: FileSystemEntry[] = [];
	const loose: File[] = [];
	for (const item of dt.items) {
		if (item.kind !== "file") continue;
		const entry = item.webkitGetAsEntry?.();
		if (entry) entries.push(entry);
		else {
			const f = item.getAsFile();
			if (f) loose.push(f);
		}
	}
	// 不支持 webkitGetAsEntry 的浏览器只能拿到顶层文件
	if (!entries.length && !loose.length) loose.push(...dt.files);
	return collect(entries, loose);
}

async function collect(entries: FileSystemEntry[], loose: File[]) {
	const out: DroppedFile[] = loose.map((file) => ({ file, path: file.name }));
	const walk = async (entry: FileSystemEntry): Promise<void> => {
		if (out.length >= MAX_DROP_FILES) return;
		if (entry.isFile) {
			const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej)).catch(() => null);
			if (file) out.push({ file, path: entry.fullPath.replace(/^\//, "") || file.name });
			return;
		}
		if (!entry.isDirectory) return;
		const reader = (entry as FileSystemDirectoryEntry).createReader();
		// readEntries 每次只返回一批（Chrome 是 100 个），读到空数组为止
		for (;;) {
			const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej)).catch(() => []);
			if (!batch.length) return;
			for (const child of batch) await walk(child);
		}
	};
	for (const e of entries) await walk(e);
	return out;
}
