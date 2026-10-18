import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { LocalFiles, MAX_CANDIDATES } from "../local.mjs";

const root = await mkdtemp(join(tmpdir(), "nana-local-"));
after(() => rm(root, { recursive: true, force: true }));

test("indexes files by size, same name first, skipping hidden dirs and symlinks", async () => {
	await mkdir(join(root, "a/b"), { recursive: true });
	await mkdir(join(root, ".Trashes"));
	await mkdir(join(root, "@eaDir"));
	await writeFile(join(root, "a/other.jpg"), "12345");
	await writeFile(join(root, "a/b/IMG_0001.HEIC"), "abcde");
	await writeFile(join(root, ".Trashes/IMG_0001.HEIC"), "zzzzz");
	await writeFile(join(root, "@eaDir/IMG_0001.HEIC"), "zzzzz");
	await writeFile(join(root, "empty"), "");
	await symlink(join(root, "a/other.jpg"), join(root, "link.jpg"));
	// macOS 的文件名是 NFD，上传时记下的是 NFC
	await writeFile(join(root, "a/café.jpg"), "xyz");

	const local = new LocalFiles(root);
	await local.refresh({ force: true });
	assert.equal(local.available, true);
	assert.equal(local.files, 3);
	assert.deepEqual(local.candidates("IMG_0001.HEIC", 5), [join(root, "a/b/IMG_0001.HEIC"), join(root, "a/other.jpg")]);
	assert.deepEqual(local.candidates("café.jpg".normalize("NFC"), 3), [join(root, "a/café.jpg")]);
	assert.deepEqual(local.candidates("x", 999), []);
});

test("limits candidates and rescans at most every few minutes", async () => {
	const dir = await mkdtemp(join(root, "many-"));
	for (let i = 0; i < 5; i++) await writeFile(join(dir, `f${i}`), "same size");
	const local = new LocalFiles(dir);
	await local.refresh({ force: true });
	assert.equal(local.candidates("f4", 9).length, MAX_CANDIDATES);
	assert.equal(local.candidates("f4", 9)[0], join(dir, "f4"));

	await writeFile(join(dir, "new"), "1234567890ab");
	assert.deepEqual(local.candidates("new", 12), []);
	assert.equal(local.scanning, null); // 刚扫过，不会马上再扫
	local.scannedAt = 0;
	assert.deepEqual(local.candidates("new", 12), []);
	await local.scanning;
	assert.deepEqual(local.candidates("new", 12), [join(dir, "new")]);
});

test("a missing root is just unavailable", async () => {
	const local = new LocalFiles(join(root, "nope"));
	await local.refresh({ force: true });
	assert.equal(local.available, false);
	assert.deepEqual(local.candidates("a", 1), []);
});
