import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import { anchorStack, collapseStack, expandStack, isExpanded, tileStackCode } from "./expand";
import { effectiveMonthItems, findEffectiveItem } from "./effective";
import { monthQuery, stackQuery } from "./queries";
import type { TimelineItem } from "./types";

/** 相似照片原地展开：展开状态、格子的三种状态、月份的“有效列表”（查看器导航和范围选择共用）。 */

const SID = "s:TESTSTACK00000000000000000";
const item = (id: string, extra: (string[] | string)[] = []): TimelineItem => {
	const base: TimelineItem = [id, 400, 300, 0, "2024-05-01", null, 0, 0];
	return [...base, ...extra] as TimelineItem;
};
const cover = item("c1", [["c1", "m1", "m2"], SID]);
const plain = item("p1");
const members = { items: [item("c1"), item("m1"), item("m2")], next: null };

afterEach(() => collapseStack(SID));

describe("expansion store", () => {
	it("marks the cover as a stack tile and the anchor as collapsible", () => {
		expect(tileStackCode(cover)).toBe(1);
		expect(tileStackCode(plain)).toBe(0);
		expandStack(SID, "c1");
		expect(isExpanded(SID)).toBe(true);
		expect(anchorStack("c1")).toBe(SID);
		expect(tileStackCode(item("c1"))).toBe(2); // 展开后封面成了成员，挂“收起”
		expect(tileStackCode(cover)).toBe(1);
		collapseStack(SID);
		expect(tileStackCode(item("c1"))).toBe(0);
		expect(anchorStack("c1")).toBeUndefined();
	});

	it("ignores single-member groups and bursts", () => {
		expect(tileStackCode(item("x", [["x"], SID]))).toBe(0); // 只剩一张不折叠
		expect(tileStackCode(item("b", [["b", "b2"]]))).toBe(0); // 连拍不是 stack
	});
});

describe("effective month items", () => {
	const qc = () => {
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		client.setQueryData(monthQuery("2024-05").queryKey, [cover, plain]);
		client.setQueryData(stackQuery(SID, "2024-05-01").queryKey, members);
		return client;
	};

	it("replaces an expanded cover with its members, newest first", async () => {
		const client = qc();
		expect(await effectiveMonthItems(client, "2024-05")).toEqual([cover, plain]);
		expandStack(SID, "c1");
		expect((await effectiveMonthItems(client, "2024-05")).map((i) => i[0])).toEqual(["m2", "m1", "c1", "p1"]);
		expect(findEffectiveItem(client, "m1", "2024-05")?.[0]).toBe("m1");
		collapseStack(SID);
		expect(await effectiveMonthItems(client, "2024-05")).toEqual([cover, plain]);
	});

	it("keeps the cover when member data is missing or empty", async () => {
		const client = qc();
		client.setQueryData(stackQuery(SID, "2024-05-01").queryKey, { items: [], next: null });
		expandStack(SID, "c1");
		expect((await effectiveMonthItems(client, "2024-05")).map((i) => i[0])).toEqual(["c1", "p1"]);
		expect(findEffectiveItem(client, "c1", "2024-05")?.[0]).toBe("c1");
	});
});
