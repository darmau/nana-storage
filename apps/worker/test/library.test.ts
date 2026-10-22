import { SELF, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authHeaders, mockAccessJwks } from "./helpers";

beforeAll(() => mockAccessJwks());

const id = (n: number) => `LIB${String(n).padStart(23, "0")}`;
async function seed(n: number, extra: { folder?: string | null; deleted?: number | null } = {}) {
	await env.DB.prepare(
		`INSERT INTO assets (id, kind, status, local_month, local_day, taken_at, width, height, folder_id, deleted_at, created_at, updated_at)
		 VALUES (?, 'photo', 'ready', '2024-05', '2024-05-01', ?, 4, 3, ?, ?, 0, 0)`,
	)
		.bind(id(n), 1714500000000 + n, extra.folder ?? null, extra.deleted ?? null)
		.run();
	await env.DB.prepare(
		"INSERT INTO asset_files (id, asset_id, role, r2_key, mime, size, created_at) VALUES (?, ?, 'original', ?, 'image/jpeg', 3, 0)",
	)
		.bind(`F${n}`, id(n), `o/${id(n)}/F${n}`)
		.run();
	await env.PHOTOS.put(`o/${id(n)}/F${n}`, "abc");
}

async function call<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
	const res = await SELF.fetch(`http://example.com/api${path}`, {
		method,
		headers: await authHeaders(
			method === "GET" ? {} : { Origin: "http://example.com", "X-Requested-With": "nana", "Content-Type": "application/json" },
		),
		body: body ? JSON.stringify(body) : undefined,
	});
	return { status: res.status, json: (await res.json()) as T };
}

beforeEach(async () => {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM album_assets"),
		env.DB.prepare("DELETE FROM albums"),
		env.DB.prepare("DELETE FROM asset_files"),
		env.DB.prepare("DELETE FROM assets"),
	]);
	// 文件夹的父子引用是 RESTRICT，从叶子开始逐层删除
	for (let i = 0; i < 50; i++) {
		const res = await env.DB.prepare(
			"DELETE FROM folders WHERE id NOT IN (SELECT parent_id FROM folders WHERE parent_id IS NOT NULL)",
		).run();
		if (!res.meta.changes) break;
	}
});

describe("folders", () => {
	it("creates nested folders, lists children with counts and breadcrumbs", async () => {
		const a = await call("POST", "/folders", { name: "2024" });
		expect(a.status).toBe(201);
		const b = await call("POST", "/folders", { name: "东京", parentId: a.json.id });
		await seed(1, { folder: b.json.id });
		await seed(2, { folder: b.json.id });
		await seed(3, { folder: b.json.id, deleted: Date.now() }); // 回收站里的不计数

		const root = await call("GET", "/folders/root");
		// 张数和封面包括子文件夹里的
		expect(root.json.children).toMatchObject([{ name: "2024", count: 2, subfolders: 1, covers: [`${id(2)}:0`, `${id(1)}:0`] }]);
		const inner = await call("GET", `/folders/${a.json.id}`);
		expect(inner.json.path.map((f: { name: string }) => f.name)).toEqual(["2024"]);
		expect(inner.json.children[0]).toMatchObject({ name: "东京", count: 2, subfolders: 0, size: 6 });
		expect(inner.json.children[0].modified).toBeGreaterThan(0);
		expect(inner.json.children[0].covers).toEqual([`${id(2)}:0`, `${id(1)}:0`]);

		const assets = await call("GET", `/folders/${b.json.id}/assets`);
		expect(assets.json.items.map((i: unknown[]) => i[0])).toEqual([id(2), id(1)]);
		expect(assets.json.next).toBeNull();
		expect(assets.json.details).toBeUndefined();
		// 列表视图：每条目带文件名、原件大小、拍摄时间
		const list = await call("GET", `/folders/${b.json.id}/assets?view=list`);
		expect(list.json.items).toEqual(assets.json.items);
		expect(list.json.details).toHaveLength(2);
		expect(list.json.details[0][1]).toBe(3);
	});

	it("counts assets in all nested subfolders without mixing up siblings", async () => {
		const a = await call("POST", "/folders", { name: "A" });
		const b = await call("POST", "/folders", { name: "B" });
		const a1 = await call("POST", "/folders", { name: "A1", parentId: a.json.id });
		const a11 = await call("POST", "/folders", { name: "A11", parentId: a1.json.id });
		await seed(1, { folder: a.json.id });
		await seed(2, { folder: a1.json.id });
		await seed(3, { folder: a11.json.id });
		await seed(4, { folder: a11.json.id, deleted: Date.now() });
		await seed(5, { folder: b.json.id });
		await seed(6); // 根目录下的不算进任何文件夹

		const root = await call("GET", "/folders/root");
		expect(root.json.children).toMatchObject([
			{ name: "A", count: 3, subfolders: 1, covers: [`${id(3)}:0`, `${id(2)}:0`, `${id(1)}:0`] },
			{ name: "B", count: 1, subfolders: 0 },
		]);
		expect((await call("GET", `/folders/${a.json.id}`)).json.children).toMatchObject([{ name: "A1", count: 2 }]);
		expect((await call("GET", `/folders/${a11.json.id}`)).json.children).toEqual([]);
	});

	it("returns at most 9 covers, newest first", async () => {
		const a = await call("POST", "/folders", { name: "A" });
		for (let n = 1; n <= 11; n++) await seed(n, { folder: a.json.id });
		await call("POST", "/folders", { name: "B" }); // 空文件夹没有封面
		const root = await call("GET", "/folders/root");
		expect(root.json.children[0].covers).toEqual([11, 10, 9, 8, 7, 6, 5, 4, 3].map((n) => `${id(n)}:0`));
		expect(root.json.children[1].covers).toEqual([]);
	});

	it("rejects duplicate names and moving a folder into its own subtree", async () => {
		const a = await call("POST", "/folders", { name: "A" });
		expect((await call("POST", "/folders", { name: "A" })).status).toBe(409);
		const b = await call("POST", "/folders", { name: "B", parentId: a.json.id });
		const c = await call("POST", "/folders", { name: "C", parentId: b.json.id });
		expect((await call("PATCH", `/folders/${a.json.id}`, { parentId: c.json.id })).status).toBe(400);
		expect((await call("PATCH", `/folders/${a.json.id}`, { parentId: a.json.id })).status).toBe(400);
		expect((await call("PATCH", `/folders/${c.json.id}`, { parentId: null, name: "C2" })).status).toBe(200);
		expect((await call("GET", "/folders/root")).json.children.map((f: { name: string }) => f.name)).toEqual(["A", "C2"]);
	});

	it("only deletes empty folders", async () => {
		const a = await call("POST", "/folders", { name: "A" });
		await seed(1, { folder: a.json.id });
		expect((await call("DELETE", `/folders/${a.json.id}`)).status).toBe(409);
		await call("POST", "/assets/batch", { action: "move", ids: [id(1)], folderId: null });
		expect((await call("DELETE", `/folders/${a.json.id}`)).status).toBe(200);
	});

	it("reports unfinished assets that the list hides but still block deletion", async () => {
		const a = await call("POST", "/folders", { name: "A" });
		const now = Date.now();
		const insert = (n: number, status: string, updatedAt: number) =>
			env.DB.prepare(
				`INSERT INTO assets (id, kind, status, folder_id, created_at, updated_at) VALUES (?, 'photo', ?, ?, ?, ?)`,
			)
				.bind(id(n), status, a.json.id, updatedAt, updatedAt)
				.run();
		await insert(1, "failed", now);
		await insert(2, "pending", now);
		await insert(3, "uploading", now - 2 * 3600_000); // 很久没动
		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO asset_files (id, asset_id, role, r2_key, mime, size, original_name, created_at)
				 VALUES ('F3', ?, 'original', 'o/x/F3', 'image/heic', 3, 'IMG_0003.HEIC', 0)`,
			).bind(id(3)),
			env.DB.prepare(
				`INSERT INTO uploads (id, asset_id, file_id, role, r2_key, r2_upload_id, mime, size, sha256, original_name, created_at)
				 VALUES ('U3', ?, 'F3v', 'live_video', 'o/x/F3v', 'mpu', 'video/quicktime', 9, ?, 'IMG_0003.MOV', 0)`,
			).bind(id(3), "a".repeat(64)),
		]);
		await seed(4, { folder: a.json.id });

		// 子文件夹里的未完成条目也算进整棵子树
		const sub = await call("POST", "/folders", { name: "B", parentId: a.json.id });
		await env.DB.prepare(`INSERT INTO assets (id, kind, status, folder_id, created_at, updated_at) VALUES (?, 'photo', 'pending', ?, 0, 0)`)
			.bind(id(5), sub.json.id)
			.run();

		expect((await call("GET", `/folders/${a.json.id}/assets`)).json.items).toHaveLength(1);
		const root = await call("GET", "/folders/root");
		expect(root.json.children[0]).toMatchObject({ count: 1, subfolders: 1 });
		expect(root.json.children[0].unfinished).toBeUndefined(); // 文件夹详情带 ETag，不含和时间有关的部分
		expect((await call("GET", "/folders/root/unfinished")).json).toEqual({ items: [], children: { [a.json.id]: 4 } });
		const info = await call("GET", `/folders/${a.json.id}/unfinished`);
		expect(info.json.children).toEqual({ [sub.json.id]: 1 });
		expect(info.json.items).toEqual([
			{ id: id(1), state: "failed", names: [] },
			{ id: id(2), state: "processing", names: [] },
			// 已经传完的和没传完的文件名都列出来，方便找到原文件重新上传
			{ id: id(3), state: "abandoned", names: ["IMG_0003.HEIC", "IMG_0003.MOV"] },
		]);
		expect((await call("GET", "/folders/nope/unfinished")).status).toBe(404);

		await call("POST", "/assets/batch", { action: "trash", ids: [id(1), id(2), id(3), id(4), id(5)] });
		expect((await call("GET", `/folders/${a.json.id}/unfinished`)).json).toEqual({ items: [], children: {} });
		expect((await call("DELETE", `/folders/${sub.json.id}`)).status).toBe(200);
		expect((await call("DELETE", `/folders/${a.json.id}`)).status).toBe(200);
	});

	it("rejects bad folder names", async () => {
		for (const name of ["..", "a/b", " "]) expect((await call("POST", "/folders", { name })).status).toBe(400);
	});
});

describe("albums", () => {
	it("adds, lists and removes assets without deleting photos", async () => {
		await seed(1);
		await seed(2);
		const al = await call("POST", "/albums", { name: "旅行", assetIds: [id(1)] });
		expect((await call("POST", `/albums/${al.json.id}/assets`, { assetIds: [id(1), id(2)] })).json.added).toBe(1);
		expect((await call("GET", "/albums")).json[0]).toMatchObject({ name: "旅行", count: 2 });
		expect((await call("GET", `/albums/${al.json.id}/assets`)).json.items).toHaveLength(2);
		expect((await call("POST", `/albums/${al.json.id}/remove`, { assetIds: [id(2)] })).json.removed).toBe(1);
		await call("DELETE", `/albums/${al.json.id}`);
		expect((await call("GET", "/albums")).json).toEqual([]);
		expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM assets").first("n")).toBe(2);
	});
});

describe("favorites, trash and batch", () => {
	it("favorites and unfavorites in batch", async () => {
		await seed(1);
		await seed(2);
		await call("POST", "/assets/batch", { action: "favorite", ids: [id(1), id(2)], value: true });
		expect((await call("GET", "/favorites/assets")).json.items).toHaveLength(2);
		await call("POST", "/assets/batch", { action: "favorite", ids: [id(2)], value: false });
		expect((await call("GET", "/favorites/assets")).json.items.map((i: unknown[]) => i[0])).toEqual([id(1)]);
	});

	it("archive hides from the timeline, folders and albums unless asked; unarchive brings it back", async () => {
		const f = await call("POST", "/folders", { name: "A" });
		await seed(1, { folder: f.json.id });
		await seed(2, { folder: f.json.id });
		const al = await call("POST", "/albums", { name: "旅行", assetIds: [id(1), id(2)] });
		const r = await call("POST", "/assets/batch", { action: "archive", ids: [id(1)], value: true });
		expect(r.json.changed).toBe(1);
		const ids = (items: unknown[][]) => items.map((i) => i[0]);

		expect(await call("GET", "/timeline/buckets").then((x) => x.json)).toEqual([{ month: "2024-05", count: 1 }]);
		expect(ids((await call("GET", "/timeline/month/2024-05")).json)).toEqual([id(2)]);
		expect(ids((await call("GET", `/folders/${f.json.id}/assets`)).json.items)).toEqual([id(2)]);
		expect(ids((await call("GET", `/folders/${f.json.id}/assets?archived=1`)).json.items)).toEqual([id(2), id(1)]);
		expect(ids((await call("GET", `/albums/${al.json.id}/assets`)).json.items)).toEqual([id(2)]);
		expect(ids((await call("GET", `/albums/${al.json.id}/assets?archived=1`)).json.items)).toEqual([id(2), id(1)]);
		// 卡片的张数和封面也不算归档的
		expect((await call("GET", "/folders/root")).json.children[0]).toMatchObject({ count: 1, covers: [`${id(2)}:0`] });
		expect((await call("GET", "/albums")).json[0]).toMatchObject({ count: 1, cover: `${id(2)}:0` });
		expect(ids((await call("GET", "/archive/assets")).json.items)).toEqual([id(1)]);

		await call("POST", "/assets/batch", { action: "archive", ids: [id(1)], value: false });
		expect((await call("GET", "/archive/assets")).json.items).toEqual([]);
		expect((await call("GET", "/timeline/month/2024-05")).json).toHaveLength(2);
	});

	it("trash hides from the timeline; restore brings it back", async () => {
		await seed(1);
		await call("POST", "/assets/batch", { action: "trash", ids: [id(1)] });
		expect((await call("GET", "/timeline/month/2024-05")).json).toEqual([]);
		expect((await call("GET", "/trash/assets")).json.items).toHaveLength(1);
		await call("POST", "/assets/batch", { action: "restore", ids: [id(1)] });
		expect((await call("GET", "/timeline/month/2024-05")).json).toHaveLength(1);
	});

	it("delete-forever only affects trashed assets and removes R2 objects", async () => {
		await seed(1);
		await seed(2, { deleted: Date.now() });
		const r = await call("POST", "/assets/batch", { action: "delete-forever", ids: [id(1), id(2)] });
		expect(r.json.changed).toBe(1);
		expect(await env.PHOTOS.head(`o/${id(1)}/F1`)).not.toBeNull(); // 不在回收站里，不能永久删除
		expect(await env.PHOTOS.head(`o/${id(2)}/F2`)).toBeNull();
		expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM asset_files").first("n")).toBe(1);
	});

	it("delete-forever also removes derived files that never got an asset_files row", async () => {
		// 处理任务写了缩略图和预览，随后失败（比如完整性校验不通过），D1 里没有这两个文件的记录
		await seed(1, { deleted: Date.now() });
		await env.DB.prepare("UPDATE assets SET derived_rev = 2 WHERE id = ?").bind(id(1)).run();
		await env.PHOTOS.put(`d/${id(1)}/thumb-2.webp`, "t");
		await env.PHOTOS.put(`d/${id(1)}/preview-2.webp`, "p");
		await call("POST", "/assets/batch", { action: "delete-forever", ids: [id(1)] });
		expect(await env.PHOTOS.head(`d/${id(1)}/thumb-2.webp`)).toBeNull();
		expect(await env.PHOTOS.head(`d/${id(1)}/preview-2.webp`)).toBeNull();
	});

	it("empties the trash", async () => {
		await seed(1, { deleted: Date.now() });
		await seed(2, { deleted: Date.now() });
		await seed(3);
		expect((await call("POST", "/trash/empty")).json).toEqual({ deleted: 2, remaining: 0 });
		expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM assets").first("n")).toBe(1);
	});

	it("replaces an abandoned upload when the same files are uploaded again", async () => {
		const sha = (c: string) => c.repeat(64);
		const live = {
			kind: "live",
			files: [
				{ role: "original", name: "IMG_0001.HEIC", size: 3, sha256: sha("1") },
				{ role: "live_video", name: "IMG_0001.MOV", size: 3, sha256: sha("2") },
			],
		};
		// 图片传完了、视频没传完的 Live Photo
		const leftover = async (updatedAt: number) => {
			await seed(1);
			await env.DB.batch([
				env.DB.prepare("UPDATE assets SET kind = 'live', status = 'uploading', updated_at = ? WHERE id = ?").bind(updatedAt, id(1)),
				env.DB.prepare("UPDATE asset_files SET sha256 = ? WHERE asset_id = ?").bind(sha("1"), id(1)),
			]);
		};

		// 还在上传（不到一小时）：仍然算重复
		await leftover(Date.now());
		expect((await call("POST", "/uploads", live)).status).toBe(409);

		// 中断了：删掉旧条目和它已经传完的文件，正常创建新条目
		await env.DB.prepare("UPDATE assets SET updated_at = ? WHERE id = ?").bind(Date.now() - 2 * 3600_000, id(1)).run();
		const res = await call("POST", "/uploads", live);
		expect(res.status).toBe(201);
		expect(await env.DB.prepare("SELECT 1 FROM assets WHERE id = ?").bind(id(1)).first()).toBeNull();
		expect(await env.PHOTOS.get(`o/${id(1)}/F1`)).toBeNull();
		await call("DELETE", `/uploads/${res.json.uploads[0].uploadId}`);
		await call("DELETE", `/uploads/${res.json.uploads[1].uploadId}`);
	});

	it("filters folder and album lists by type", async () => {
		const folder = (await call("POST", "/folders", { name: "筛选" })).json.id;
		const album = (await call("POST", "/albums", { name: "筛选" })).json.id;
		for (let n = 1; n <= 5; n++) await seed(n, { folder });
		await env.DB.batch([
			env.DB.prepare("UPDATE assets SET kind = 'video' WHERE id = ?").bind(id(2)),
			env.DB.prepare("UPDATE assets SET kind = 'live' WHERE id = ?").bind(id(3)),
			env.DB.prepare("UPDATE assets SET traits = 1 | 8 WHERE id = ?").bind(id(4)),
			env.DB.prepare("UPDATE assets SET burst_id = 't:x' WHERE id = ?").bind(id(5)),
		]);
		await call("POST", `/albums/${album}/assets`, { assetIds: [id(1), id(2), id(3), id(4), id(5)] });
		const ids = async (path: string) => (await call("GET", path)).json.items.map((it: unknown[]) => it[0]).sort();
		for (const base of [`/folders/${folder}/assets`, `/albums/${album}/assets`]) {
			expect(await ids(base)).toHaveLength(5);
			expect(await ids(`${base}?type=photo`)).toEqual([id(1), id(4), id(5)]);
			expect(await ids(`${base}?type=video`)).toEqual([id(2)]);
			expect(await ids(`${base}?type=live`)).toEqual([id(3)]);
			expect(await ids(`${base}?type=panorama`)).toEqual([id(4)]);
			expect(await ids(`${base}?type=raw`)).toEqual([id(4)]);
			expect(await ids(`${base}?type=portrait`)).toEqual([]);
			expect(await ids(`${base}?type=burst`)).toEqual([id(5)]);
			// 不认识的值当作没有筛选
			expect(await ids(`${base}?type=bogus`)).toHaveLength(5);
		}
	});

	it("paginates", async () => {
		// 一条一条插要 1500 次往返，CI 上会超时；分页只看 assets 表，批量插入
		const insert = env.DB.prepare(
			`INSERT INTO assets (id, kind, status, local_month, local_day, taken_at, width, height, created_at, updated_at)
			 VALUES (?, 'photo', 'ready', '2024-05', '2024-05-01', ?, 4, 3, 0, 0)`,
		);
		await env.DB.batch(Array.from({ length: 501 }, (_, i) => insert.bind(id(i + 1), 1714500000000 + i + 1)));
		const p1 = await call("GET", "/folders/root/assets");
		expect(p1.json.items).toHaveLength(500);
		expect(p1.json.next).toBe(500);
		// 不止一页时，第一页带上整个列表的每月张数（拖动条用）；没有拍摄日期的排在最后
		await env.DB.prepare(
			`INSERT INTO assets (id, kind, status, width, height, created_at, updated_at) VALUES (?, 'photo', 'ready', 4, 3, 0, 0)`,
		)
			.bind(id(9999))
			.run();
		await env.DB.prepare("UPDATE assets SET local_day = '2023-01-02' WHERE id = ?").bind(id(1)).run();
		expect((await call("GET", "/folders/root/assets")).json.months).toEqual([
			{ month: "2024-05", count: 500 },
			{ month: "2023-01", count: 1 },
			{ month: "unknown", count: 1 },
		]);
		const p2 = await call("GET", "/folders/root/assets?offset=500");
		expect(p2.json.items).toHaveLength(2);
		expect(p2.json.next).toBeNull();
		expect(p2.json.months).toBeUndefined();
	});

	it("validates batch input", async () => {
		expect((await call("POST", "/assets/batch", { action: "trash", ids: [] })).status).toBe(400);
		expect((await call("POST", "/assets/batch", { action: "nope", ids: [id(1)] })).status).toBe(400);
		expect((await call("POST", "/assets/batch", { action: "move", ids: [id(1)], folderId: id(99) })).status).toBe(404);
	});
});
