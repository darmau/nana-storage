import { SELF, env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { guardStub } from "../src/guard";
import { baseName, isCdnUrl, parseEmbed, parsePostUrl, postTime } from "../src/instagram";
import { authHeaders, mockAccessJwks } from "./helpers";

let jwks: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
beforeAll(() => {
	mockAccessJwks();
	jwks = (globalThis.fetch as unknown as MockInstance<typeof fetch>).getMockImplementation()!;
});

beforeEach(async () => {
	await guardStub(env).reset();
	await env.DB.batch([
		env.DB.prepare("DELETE FROM jobs"),
		env.DB.prepare("DELETE FROM instagram_imports"),
		env.DB.prepare("DELETE FROM asset_files"),
		env.DB.prepare("DELETE FROM assets"),
		env.DB.prepare("DELETE FROM folders"),
	]);
});

/** 外部请求：嵌入页和 CDN 由各个测试给出，其余照常交给 Access 的 JWKS mock（它会拒绝任何其他地址）。 */
function mockOutbound(routes: Record<string, () => Response>) {
	const calls: string[] = [];
	(globalThis.fetch as unknown as MockInstance<typeof fetch>).mockImplementation(async (input, init) => {
		const url = input instanceof Request ? input.url : String(input);
		const route = routes[url];
		if (route) {
			calls.push(url);
			return route();
		}
		return jwks(input, init);
	});
	return calls;
}
afterEach(() => (globalThis.fetch as unknown as MockInstance<typeof fetch>).mockImplementation(jwks));

const MEDIA_ID = "4022541419406238081"; // 2026-11-03T22:18:46.517Z
const CDN = (n: number) => `https://scontent-ord5-1.cdninstagram.com/v/t39/${n}_n.jpg?stp=x&_nc_sid=1`;
const jpeg = (fill: number) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(60).fill(fill)]);

function embedHtml(ctx: unknown) {
	// 和真实页面一样：contextJSON 的值是一个 JSON 字符串，里面又是转义过的 JSON
	return `<html><script>s.handle({"require":[["X",null,{"contextJSON":${JSON.stringify(JSON.stringify(ctx))}}]]});</script></html>`;
}

const sidecar = (children: { url: string; video?: boolean }[]) => ({
	context: { type: "GraphSidecar", shortcode: "DfS8BvOASGB" },
	gql_data: {
		shortcode_media: {
			__typename: "GraphSidecar",
			id: MEDIA_ID,
			shortcode: "DfS8BvOASGB",
			is_video: false,
			display_url: children[0]!.url,
			owner: { id: "1", username: "some.user_1" },
			edge_sidecar_to_children: {
				edges: children.map((c, i) => ({
					node: {
						id: String(i),
						is_video: !!c.video,
						display_url: c.url,
						display_resources: [{ src: c.url, config_width: 8192, config_height: 6144 }],
					},
				})),
			},
		},
	},
});

async function call<T = any>(path: string, body: unknown): Promise<{ status: number; json: T }> {
	const res = await SELF.fetch(`http://example.com/api/imports/instagram${path}`, {
		method: "POST",
		headers: await authHeaders({ Origin: "http://example.com", "X-Requested-With": "nana", "Content-Type": "application/json" }),
		body: JSON.stringify(body),
	});
	return { status: res.status, json: (await res.json()) as T };
}

describe("instagram parsing", () => {
	it("accepts post links in their usual shapes and nothing else", () => {
		expect(parsePostUrl("https://www.instagram.com/p/DfS8BvOASGB/?xtok=MW9q")).toBe("DfS8BvOASGB");
		expect(parsePostUrl("https://instagram.com/p/DfS8BvOASGB")).toBe("DfS8BvOASGB");
		expect(parsePostUrl("https://www.instagram.com/some.user/p/DfS8BvOASGB/")).toBe("DfS8BvOASGB");
		expect(parsePostUrl("https://www.instagram.com/reel/DfS8BvOASGB/")).toBe("DfS8BvOASGB");
		expect(parsePostUrl("http://www.instagram.com/p/DfS8BvOASGB/")).toBeNull();
		expect(parsePostUrl("https://www.instagram.com/some.user/")).toBeNull();
		expect(parsePostUrl("https://evil.example/p/DfS8BvOASGB/")).toBeNull();
		expect(parsePostUrl("https://instagram.com.evil.example/p/DfS8BvOASGB/")).toBeNull();
		expect(parsePostUrl("not a url")).toBeNull();
	});

	it("only downloads from Instagram's CDN over https", () => {
		expect(isCdnUrl(CDN(1))).toBe(true);
		expect(isCdnUrl("https://scontent.xx.fbcdn.net/v/a.jpg")).toBe(true);
		expect(isCdnUrl("http://scontent.cdninstagram.com/a.jpg")).toBe(false);
		expect(isCdnUrl("https://cdninstagram.com.evil.example/a.jpg")).toBe(false);
		expect(isCdnUrl("https://scontent.cdninstagram.com:8443/a.jpg")).toBe(false);
		expect(isCdnUrl("https://user@scontent.cdninstagram.com/a.jpg")).toBe(false);
		expect(isCdnUrl("https://example.com/a.jpg")).toBe(false);
	});

	it("derives the post time from the media id and names files account-date-number", () => {
		expect(postTime(MEDIA_ID)).toBe(Date.UTC(2026, 10, 3, 22, 18, 46, 517));
		expect(postTime("1")).toBeNull();
		expect(postTime("abc")).toBeNull();
		const t = postTime(MEDIA_ID)!;
		expect(baseName("jennie", t, 0, 1)).toBe("jennie-20261103-01");
		// 东八区已经是 11 月 4 日
		expect(baseName("jennie", t, 480, 12)).toBe("jennie-20261104-12");
	});

	it("reads every image of a carousel in order and skips videos", () => {
		const post = parseEmbed(embedHtml(sidecar([{ url: CDN(1) }, { url: CDN(2), video: true }, { url: CDN(3) }])), "DfS8BvOASGB");
		expect(post).toEqual({ username: "some.user_1", mediaId: MEDIA_ID, images: [{ id: "0", src: CDN(1) }, { id: "2", src: CDN(3) }], videos: 1 });
	});

	it("reads a single-image post", () => {
		const ctx = sidecar([{ url: CDN(1) }]);
		delete (ctx.gql_data.shortcode_media as any).edge_sidecar_to_children;
		expect(parseEmbed(embedHtml(ctx), "DfS8BvOASGB")?.images).toEqual([{ id: MEDIA_ID, src: CDN(1) }]);
	});

	it("rejects pages without the post, for another post, or with non-CDN image urls", () => {
		expect(parseEmbed("<html>login</html>", "DfS8BvOASGB")).toBeNull();
		expect(parseEmbed(embedHtml(sidecar([{ url: CDN(1) }])), "Other12345")).toBeNull();
		expect(parseEmbed(embedHtml(sidecar([{ url: "https://evil.example/a.jpg" }])), "DfS8BvOASGB")?.images).toEqual([]);
	});
});

describe("instagram import", () => {
	it("imports every image into /Instagram with account-date-number names and process jobs", async () => {
		const calls = mockOutbound({
			"https://www.instagram.com/p/DfS8BvOASGB/embed/captioned/": () =>
				new Response(embedHtml(sidecar([{ url: CDN(1) }, { url: CDN(2), video: true }, { url: CDN(3) }])), { headers: { "content-type": "text/html" } }),
			// 每次下载的字节都不同（CDN 会重新编码）
			[CDN(1)]: () => new Response(jpeg(10 + calls.length)),
			[CDN(3)]: () => new Response(jpeg(30 + calls.length)),
		});

		const resolved = await call("/resolve", { url: "https://www.instagram.com/p/DfS8BvOASGB/?xtok=abc", tzOffsetMin: 480 });
		expect(resolved.status).toBe(200);
		expect(resolved.json.videos).toBe(1);
		expect(resolved.json.items.map((i: any) => i.name)).toEqual(["some.user_1-20261104-01", "some.user_1-20261104-02"]);
		const folder = await env.DB.prepare("SELECT id, parent_id, name FROM folders").first();
		expect(folder).toEqual({ id: resolved.json.folderId, parent_id: null, name: "Instagram" });

		for (const item of resolved.json.items) {
			const r = await call("/item", { ...item, folderId: resolved.json.folderId, takenAt: resolved.json.takenAt, tzOffsetMin: 480 });
			expect(r.json.status).toBe("imported");
		}
		const rows = await env.DB.prepare(
			`SELECT a.status, a.folder_id, a.client_mtime, f.original_name, f.mime, j.kind, j.status AS job
			 FROM assets a JOIN asset_files f ON f.asset_id = a.id JOIN jobs j ON j.asset_id = a.id ORDER BY f.original_name`,
		).all();
		expect(rows.results).toEqual(
			["01", "02"].map((n) => ({
				status: "pending",
				folder_id: resolved.json.folderId,
				client_mtime: resolved.json.takenAt,
				original_name: `some.user_1-20261104-${n}.jpg`,
				mime: "image/jpeg",
				kind: "process",
				job: "pending",
			})),
		);
		expect(calls).toHaveLength(3);

		// 再导入一次：CDN 这次给的字节不一样（重新编码），按媒体 ID 仍然认出是导入过的，也不再下载
		const before = calls.length;
		const again = await call("/resolve", { url: "https://www.instagram.com/p/DfS8BvOASGB/", tzOffsetMin: 480 });
		expect(again.json.items.every((i: any) => typeof i.existing === "string")).toBe(true);
		const item = await call("/item", { ...again.json.items[0], folderId: again.json.folderId, takenAt: again.json.takenAt, tzOffsetMin: 480 });
		expect(item.json.status).toBe("duplicate");
		expect(calls.length).toBe(before + 1); // 只有嵌入页
		expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM assets").first("n")).toBe(2);
		expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM instagram_imports").first("n")).toBe(2);
	});

	it("reports a login redirect as unavailable without following it", async () => {
		mockOutbound({
			"https://www.instagram.com/p/DfS8BvOASGB/embed/captioned/": () =>
				new Response(null, { status: 302, headers: { location: "https://www.instagram.com/accounts/login/" } }),
		});
		const r = await call("/resolve", { url: "https://www.instagram.com/p/DfS8BvOASGB/", tzOffsetMin: 0 });
		expect(r).toEqual({ status: 502, json: { error: "instagram unavailable" } });
		expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM folders").first("n")).toBe(0);
	});

	it("refuses non-instagram links and non-CDN download urls without any outbound request", async () => {
		const calls = mockOutbound({});
		expect((await call("/resolve", { url: "https://example.com/p/DfS8BvOASGB/", tzOffsetMin: 0 })).status).toBe(400);
		const folderId = (await call("/resolve", { url: "x", tzOffsetMin: 0 })).status; // 400，不建文件夹
		expect(folderId).toBe(400);
		const r = await call("/item", { mediaId: "1", url: "https://example.com/a.jpg", name: "a-20261103-01", folderId: "f", takenAt: 0, tzOffsetMin: 0 });
		expect(r.status).toBe(400);
		expect(calls).toEqual([]);
	});

	it("rejects downloads that are not images", async () => {
		mockOutbound({ [CDN(9)]: () => new Response("<svg onload=alert(1)>".padEnd(64, " ")) });
		await env.DB.prepare("INSERT INTO folders (id, parent_id, name, created_at) VALUES ('f1', NULL, 'Instagram', 0)").run();
		const r = await call("/item", { mediaId: "9", url: CDN(9), name: "a-20261103-01", folderId: "f1", takenAt: 0, tzOffsetMin: 0 });
		expect(r.status).toBe(415);
		expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM assets").first("n")).toBe(0);
	});

	it("stops when the cost guard has tripped", async () => {
		mockOutbound({ [CDN(1)]: () => new Response(jpeg(7)) });
		await env.DB.prepare("INSERT INTO folders (id, parent_id, name, created_at) VALUES ('f1', NULL, 'Instagram', 0)").run();
		await guardStub(env).trip("test");
		const r = await call("/item", { mediaId: "1", url: CDN(1), name: "a-20261103-01", folderId: "f1", takenAt: 0, tzOffsetMin: 0 });
		expect(r.status).toBe(503);
		expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM assets").first("n")).toBe(0);
	});
});
