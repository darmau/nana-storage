import { describe, expect, it } from "vitest";
import { parseMeta, parseOffset } from "../src/exif";

const fb = { clientMtime: Date.UTC(2025, 0, 2, 3, 4, 5), clientTzOffsetMin: 480 };

describe("parseMeta", () => {
	it("uses DateTimeOriginal + OffsetTimeOriginal (real fixture output)", () => {
		const p = parseMeta(
			{
				MIMEType: "image/jpeg",
				DateTimeOriginal: "2024:05:01 12:34:56",
				OffsetTimeOriginal: "+08:00",
				SubSecTimeOriginal: 250,
				GPSLatitude: 31.2304,
				GPSLongitude: 121.4737,
				Make: "Apple",
				Model: "iPhone 15 Pro",
				LensModel: "iPhone 15 Pro back camera",
				Orientation: 6,
				ImageWidth: 4032,
				ImageHeight: 3024,
			},
			fb,
		);
		expect(p.takenAt).toBe(Date.UTC(2024, 4, 1, 4, 34, 56, 250));
		expect(p.tzOffsetMin).toBe(480);
		expect(p.localDay).toBe("2024-05-01");
		expect(p.localMonth).toBe("2024-05");
		expect({ w: p.width, h: p.height }).toEqual({ w: 3024, h: 4032 }); // 方向 6 → 竖图
		expect({ lat: p.lat, lon: p.lon }).toEqual({ lat: 31.2304, lon: 121.4737 });
		expect(p.camera).toBe("Apple iPhone 15 Pro");
		expect(p.lens).toBe("iPhone 15 Pro back camera");
	});

	it("local day follows the shooting location, not UTC", () => {
		// 东京晚上 23:30 = UTC 14:30，同一天；纽约晚上 23:30 = 次日 UTC
		const ny = parseMeta({ DateTimeOriginal: "2024:12:31 23:30:00", OffsetTimeOriginal: "-05:00" }, fb);
		expect(ny.localDay).toBe("2024-12-31");
		expect(new Date(ny.takenAt!).toISOString()).toBe("2025-01-01T04:30:00.000Z");
	});

	it("parses Apple QuickTime CreationDate with offset (real fixture output)", () => {
		const p = parseMeta(
			{
				MIMEType: "video/quicktime",
				CreationDate: "2024:05:01 12:34:56+08:00",
				CreateDate: "0000:00:00 00:00:00",
				Duration: 3,
				ContentIdentifier: "TEST-CID-1234",
				ImageWidth: 1920,
				ImageHeight: 1080,
				Rotation: 90,
				GPSCoordinates: "31.2304 121.4737 12.5",
			},
			fb,
		);
		expect(p.takenAt).toBe(Date.UTC(2024, 4, 1, 4, 34, 56));
		expect(p.tzOffsetMin).toBe(480);
		expect(p.durationMs).toBe(3000);
		expect(p.contentIdentifier).toBe("TEST-CID-1234");
		expect({ w: p.width, h: p.height }).toEqual({ w: 1080, h: 1920 });
		expect({ lat: p.lat, lon: p.lon }).toEqual({ lat: 31.2304, lon: 121.4737 });
	});

	it("DateTimeOriginal without offset keeps the EXIF local day and marks tz unknown", () => {
		const p = parseMeta({ DateTimeOriginal: "2024:05:01 00:10:00" }, { clientMtime: null, clientTzOffsetMin: 480 });
		expect(p.localDay).toBe("2024-05-01");
		expect(p.tzOffsetMin).toBeNull();
		expect(new Date(p.takenAt!).toISOString()).toBe("2024-04-30T16:10:00.000Z");
	});

	it("treats QuickTime CreateDate as UTC for non-Apple videos", () => {
		const p = parseMeta({ MIMEType: "video/mp4", CreateDate: "2024:05:01 20:00:00" }, fb);
		expect(new Date(p.takenAt!).toISOString()).toBe("2024-05-01T20:00:00.000Z");
		expect(p.localDay).toBe("2024-05-02"); // 浏览器在 +08:00
	});

	it("falls back to the file modification time", () => {
		const p = parseMeta({ MIMEType: "image/png" }, fb);
		expect(p.takenAt).toBe(fb.clientMtime);
		expect(p.localDay).toBe("2025-01-02");
	});

	it("ignores garbage dates and null-island GPS", () => {
		const p = parseMeta(
			{ DateTimeOriginal: "0000:00:00 00:00:00", GPSLatitude: 0, GPSLongitude: 0, Make: "SONY", Model: "ILCE-7M4" },
			{ clientMtime: null, clientTzOffsetMin: null },
		);
		expect(p.takenAt).toBeNull();
		expect(p.lat).toBeNull();
		expect(p.camera).toBe("SONY ILCE-7M4");
	});

	it("parses offsets", () => {
		expect(parseOffset("+05:30")).toBe(330);
		expect(parseOffset("-0800")).toBe(-480);
		expect(parseOffset("Z")).toBe(0);
		expect(parseOffset("+25:00")).toBeNull();
	});
});

describe("photo traits", () => {
	const base = { MIMEType: "image/jpeg", Make: "Apple", Model: "iPhone 15 Pro", ImageWidth: 4032, ImageHeight: 3024 };

	it("detects panoramas by projection tag or aspect ratio, but not screenshots", () => {
		expect(parseMeta({ ...base, ImageWidth: 16000, ImageHeight: 5000 }, fb).traits & 1).toBe(1);
		expect(parseMeta({ ...base, ProjectionType: "equirectangular" }, fb).traits & 1).toBe(1);
		expect(parseMeta({ ...base }, fb).traits & 1).toBe(0);
		// 截图很长，但没有相机信息
		expect(parseMeta({ MIMEType: "image/png", ImageWidth: 1179, ImageHeight: 2556 }, fb).traits).toBe(0);
	});

	it("detects long exposures and portrait mode", () => {
		expect(parseMeta({ ...base, ExposureTime: 2 }, fb).traits).toBe(2);
		expect(parseMeta({ ...base, ExposureTime: 1 / 120 }, fb).traits).toBe(0);
		expect(parseMeta({ ...base, AuxiliaryImageType: "urn:com:apple:photo:2018:aux:portraiteffectsmatte" }, fb).traits).toBe(4);
		expect(parseMeta({ ...base, GDepthFormat: "RangeInverse" }, fb).traits).toBe(4);
		expect(parseMeta({ ...base, AuxiliaryImageType: "urn:com:apple:photo:2020:aux:hdrgainmap" }, fb).traits).toBe(0);
	});

	it("reads Apple BurstUUID for photos only", () => {
		expect(parseMeta({ ...base, BurstUUID: "B-1" }, fb).burstUuid).toBe("B-1");
		expect(parseMeta({ MIMEType: "video/quicktime", BurstUUID: "B-1" }, fb).burstUuid).toBeNull();
	});
});
