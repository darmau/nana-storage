import { ulid } from "./ulid";

export function cleanFolderName(name: string): string | null {
	const n = name.normalize("NFC").replace(/[\u0000-\u001f\u007f]/g, "").trim();
	if (!n || n === "." || n === ".." || n.includes("/") || n.length > 255) return null;
	return n;
}

/**
 * 按相对路径（"2024/旅行/东京"）逐级查找或创建文件夹，返回最深一级的 ID。
 * 路径层级最多 32 级。
 */
export async function ensureFolderPath(env: Env, parentId: string | null, path: string): Promise<string | null> {
	const segments = path.split("/").map((s) => s.trim()).filter(Boolean);
	if (segments.length > 32) throw new Error("folder path too deep");
	let current = parentId;
	for (const raw of segments) {
		const name = cleanFolderName(raw);
		if (!name) throw new Error("bad folder name");
		const existing = await env.DB.prepare(
			"SELECT id FROM folders WHERE COALESCE(parent_id, '') = ? AND name = ?",
		)
			.bind(current ?? "", name)
			.first<{ id: string }>();
		if (existing) {
			current = existing.id;
			continue;
		}
		const id = ulid();
		// 并发创建同名文件夹时，唯一索引会让其中一个失败，然后重新查一次。
		const res = await env.DB.prepare(
			"INSERT OR IGNORE INTO folders (id, parent_id, name, created_at) VALUES (?, ?, ?, ?)",
		)
			.bind(id, current, name, Date.now())
			.run();
		if (res.meta.changes) current = id;
		else {
			const row = await env.DB.prepare("SELECT id FROM folders WHERE COALESCE(parent_id, '') = ? AND name = ?")
				.bind(current ?? "", name)
				.first<{ id: string }>();
			current = row!.id;
		}
	}
	return current;
}
