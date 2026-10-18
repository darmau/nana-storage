import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { type ZipEntry, uniqueNames, zipLayout } from "../src/zip";

// 用本机的 python3 和 unzip 校验输出；CI 环境里没有这两个工具时跳过（会打印提示）
const hasTool = (cmd: string, args: string[]) => {
	try {
		execFileSync(cmd, args, { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
};
const canValidate = hasTool("python3", ["--version"]) && hasTool("unzip", ["-v"]);
if (!canValidate) console.warn("python3 或 unzip 不可用，跳过 zip 格式校验");

function build(files: { name: string; data: Buffer }[], zip64Limit?: number) {
	const entries: ZipEntry[] = files.map((f) => ({
		name: f.name,
		size: f.data.length,
		crc32: crc32(f.data),
		mtime: Date.UTC(2024, 4, 1, 12, 34, 56),
	}));
	const { parts, totalSize } = zipLayout(entries, zip64Limit);
	const out = Buffer.concat(parts.map((p) => (p.kind === "bytes" ? Buffer.from(p.data) : files[p.index]!.data)));
	expect(out.length).toBe(totalSize);
	const path = join(mkdtempSync(join(tmpdir(), "zip-")), "t.zip");
	writeFileSync(path, out);
	return path;
}

const pyCheck = (path: string) =>
	JSON.parse(
		execFileSync("python3", [
			"-I",
			"-c",
			`import zipfile,json,sys
z=zipfile.ZipFile(sys.argv[1]); bad=z.testzip()
print(json.dumps({"bad":bad,"files":[[i.filename,i.file_size,list(i.date_time)] for i in z.infolist()],"data":[z.read(i).decode("latin1") for i in z.infolist()]}))`,
			path,
		]).toString(),
	);

const files = [
	{ name: "IMG_0001.JPG", data: Buffer.from("hello jpeg bytes") },
	{ name: "东京/旅行.HEIC", data: Buffer.from("x".repeat(5000)) },
	{ name: "empty.txt", data: Buffer.alloc(0) },
];

describe.skipIf(!canValidate)("zipLayout", () => {
	it("produces a valid archive (python zipfile + unzip -t)", () => {
		const path = build(files);
		const r = pyCheck(path);
		expect(r.bad).toBeNull();
		expect(r.files).toEqual([
			["IMG_0001.JPG", 16, [2024, 5, 1, 12, 34, 56]],
			["东京/旅行.HEIC", 5000, [2024, 5, 1, 12, 34, 56]],
			["empty.txt", 0, [2024, 5, 1, 12, 34, 56]],
		]);
		expect(r.data[0]).toBe("hello jpeg bytes");
		expect(execFileSync("unzip", ["-tq", path]).toString()).toContain("No errors");
	});

	it("produces a valid ZIP64 archive when sizes/offsets exceed the limit", () => {
		// 把阈值调到 100 字节，覆盖 ZIP64 的本地头、中央目录和结束记录
		const path = build(files, 100);
		const r = pyCheck(path);
		expect(r.bad).toBeNull();
		expect(r.files.map((f: unknown[]) => f[1])).toEqual([16, 5000, 0]);
		expect(execFileSync("unzip", ["-tq", path]).toString()).toContain("No errors");
	});
});

describe("uniqueNames", () => {
	it("deduplicates case-insensitively and strips path separators", () => {
		expect(uniqueNames(["IMG_1.JPG", "img_1.jpg", "IMG_1.JPG", "a/b.png", "..hidden", ""])).toEqual([
			"IMG_1.JPG",
			"img_1 (2).jpg",
			"IMG_1 (3).JPG",
			"a_b.png",
			"_hidden",
			"file",
		]);
	});
});
