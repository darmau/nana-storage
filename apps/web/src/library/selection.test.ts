import { describe, expect, it } from "vitest";
import { sliceBetween } from "./selection";

describe("sliceBetween", () => {
	const ids = ["a", "b", "c", "d", "e"];
	it("works in both directions, starting from the anchor", () => {
		expect(sliceBetween(ids, "b", "d", 10)).toEqual(["b", "c", "d"]);
		expect(sliceBetween(ids, "d", "b", 10)).toEqual(["d", "c", "b"]);
	});
	it("keeps the items nearest the anchor when over the limit", () => {
		expect(sliceBetween(ids, "e", "a", 2)).toEqual(["e", "d"]);
	});
	it("returns null when either end is missing", () => {
		expect(sliceBetween(ids, "x", "a", 10)).toBeNull();
	});
});
