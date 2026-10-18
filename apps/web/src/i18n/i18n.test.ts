import { describe, expect, it } from "vitest";
import { en } from "./en";
import { zhCN } from "./zh-CN";

const day = (s: string) => new Date(`${s}T00:00:00Z`);

describe("日期", () => {
	it("中文", () => {
		expect(zhCN.date.month(day("2026-10-01"))).toBe("2026年10月");
		expect(zhCN.date.day(day("2026-10-12"), false)).toBe("10月12日 周一");
		expect(zhCN.date.day(day("1999-12-31"), true)).toBe("1999年12月31日 周五");
	});
	it("英文", () => {
		expect(en.date.month(day("2026-10-01"))).toBe("October 2026");
		expect(en.date.day(day("2026-10-12"), false)).toBe("Mon, Oct 12");
		expect(en.date.day(day("1999-12-31"), true)).toBe("Fri, Dec 31, 1999");
		expect(en.date.withOffset("x", "+08:00")).toBe("x (UTC+08:00)");
	});
});

describe("英文单复数", () => {
	it("按数量选单数或复数", () => {
		expect(en.upload.uploading(1)).toBe("Uploading 1 item");
		expect(en.upload.uploading(1200)).toBe("Uploading 1,200 items");
		expect(en.actions.trashTitle(1)).toBe("Delete this photo?");
		expect(en.actions.trashTitle(3)).toBe("Delete these 3 items?");
		expect(en.library.storageCounts(1, 2)).toBe("1 photo · 2 videos");
	});
});
