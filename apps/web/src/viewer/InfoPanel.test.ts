import { describe, expect, it } from "vitest";
import { parseLatLon, photoTypes } from "./InfoPanel";

describe("parseLatLon", () => {
	it.each([
		["35.6812, 139.7671", { lat: 35.6812, lon: 139.7671 }],
		["-33.8688 151.2093", { lat: -33.8688, lon: 151.2093 }],
		["31.23，121.47", { lat: 31.23, lon: 121.47 }],
	])("parses %s", (text, expected) => expect(parseLatLon(text)).toEqual(expected));
	it.each(["", "abc", "91, 0", "0, 181", "1,2,3"])("rejects %s", (text) => expect(parseLatLon(text)).toBeNull());
});

describe("photoTypes", () => {
	it("lists burst first, then traits", () => {
		expect(photoTypes("B", 1 | 8)).toBe("连拍、全景、RAW");
		expect(photoTypes(null, 2 | 4)).toBe("长曝光、人像");
		expect(photoTypes(null, 0)).toBeNull();
	});
});
