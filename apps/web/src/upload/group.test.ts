import { describe, expect, it } from "vitest";
import { groupFiles, type InputFile } from "@nana/shared";

const f = (relativePath: string, size = 10): InputFile => ({ name: relativePath.split("/").pop()!, relativePath, size });
const summary = (files: InputFile[]) =>
	groupFiles(files)
		.groups.map((g) => `${g.kind}[${g.folderPath}] ${g.files.map((x) => `${x.role}:${x.file.name}`).join(" ")}`)
		.sort();

describe("groupFiles", () => {
	it("pairs Live Photos, RAW+JPEG, and leaves singles alone", () => {
		expect(
			summary([
				f("trip/IMG_1234.HEIC"),
				f("trip/IMG_1234.MOV"),
				f("trip/DSC0001.ARW"),
				f("trip/DSC0001.JPG"),
				f("trip/DSC0002.ARW"),
				f("trip/clip.mp4"),
				f("trip/IMG_9.PNG"),
			]),
		).toEqual([
			"live[trip] original:IMG_1234.HEIC live_video:IMG_1234.MOV",
			"photo[trip] original:DSC0001.JPG raw:DSC0001.ARW",
			"photo[trip] original:IMG_9.PNG",
			"photo[trip] raw:DSC0002.ARW",
			"video[trip] original:clip.mp4",
		]);
	});

	it("only pairs within the same folder", () => {
		expect(summary([f("a/IMG_1.HEIC"), f("b/IMG_1.MOV")])).toEqual([
			"photo[a] original:IMG_1.HEIC",
			"video[b] original:IMG_1.MOV",
		]);
	});

	it("prefers HEIC over JPG as the Live Photo still and keeps the JPG separately", () => {
		expect(summary([f("IMG_1.JPG"), f("IMG_1.HEIC"), f("IMG_1.MOV")])).toEqual([
			"live[] original:IMG_1.HEIC live_video:IMG_1.MOV",
			"photo[] original:IMG_1.JPG",
		]);
	});

	it("is case-insensitive on names and extensions", () => {
		expect(summary([f("img_1.heic"), f("IMG_1.mov")])).toEqual(["live[] original:img_1.heic live_video:IMG_1.mov"]);
	});

	it("skips unknown, empty and macOS metadata files", () => {
		const { groups, skipped } = groupFiles([f("a/notes.txt"), f("a/._IMG_1.HEIC"), f("a/.DS_Store"), f("a/empty.jpg", 0), f("a/x.svg")]);
		expect(groups).toEqual([]);
		expect(skipped).toHaveLength(5);
	});
});
