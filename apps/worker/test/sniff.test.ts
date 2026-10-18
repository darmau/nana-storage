import { describe, expect, it } from "vitest";
import { sniff } from "../src/sniff";

const bytes = (...parts: (string | number[])[]) => {
	const out: number[] = [];
	for (const p of parts) out.push(...(typeof p === "string" ? [...p].map((c) => c.charCodeAt(0)) : p));
	while (out.length < 32) out.push(0);
	return new Uint8Array(out);
};
const ftyp = (brand: string) => bytes([0, 0, 0, 0x18], "ftyp", brand);

describe("sniff", () => {
	it.each([
		[bytes([0xff, 0xd8, 0xff, 0xe1]), "a.jpg", "image/jpeg", "image"],
		[bytes("\x89PNG\r\n\x1a\n"), "a.png", "image/png", "image"],
		[ftyp("heic"), "IMG_1.HEIC", "image/heic", "image"],
		[ftyp("mif1"), "a.heif", "image/heif", "image"],
		[ftyp("qt  "), "IMG_1.MOV", "video/quicktime", "video"],
		[ftyp("isom"), "a.mp4", "video/mp4", "video"],
		[ftyp("crx "), "a.CR3", "image/x-canon-cr3", "raw"],
		[bytes("II*\0", [8, 0, 0, 0], "CR"), "a.CR2", "image/x-canon-cr2", "raw"],
		[bytes("II*\0"), "DSC0001.ARW", "image/x-raw-arw", "raw"],
		[bytes("II*\0"), "a.dng", "image/x-raw-dng", "raw"],
		[bytes("II*\0"), "scan.tif", "image/tiff", "image"],
		[bytes("FUJIFILMCCD-RAW 0201"), "a.RAF", "image/x-fuji-raf", "raw"],
	])("detects %#", (b, name, mime, category) => {
		expect(sniff(b, name)).toEqual({ mime, category });
	});

	it.each([
		["<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>", "x.svg"],
		["<!doctype html><html><script>alert(1)</script>", "x.jpg"],
		["%PDF-1.7 ...............", "x.pdf"],
	])("rejects active/unknown content %#", (text, name) => {
		expect(sniff(bytes(text), name)).toBeNull();
	});

	it("rejects unknown ftyp brands and short input", () => {
		expect(sniff(ftyp("zzzz"), "a.mp4")).toBeNull();
		expect(sniff(new Uint8Array([0xff, 0xd8]), "a.jpg")).toBeNull();
	});
});
