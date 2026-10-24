import { PURGE_BATCH, TRASH_RETENTION_MS } from "@nana/shared";
import { DERIVED_FILES, derivedKey } from "./derived";
import { deleteFaceVectors } from "./people";
import { deleteSearchRows } from "./search";
import { deleteVectors } from "./similar";

/**
 * 永久删除条目：先删 R2 里的所有文件（包括人脸头像拼图）和 Vectorize 里的向量（照片的和人脸的），
 * 再删 D1 行（asset_files / album_assets / jobs / asset_fp / faces 等级联删除）。
 * 向量删除失败不要紧：查询结果都会再用 D1 过滤。
 */
export async function deleteAssetsPermanently(env: Env, ids: string[]): Promise<number> {
	let deleted = 0;
	for (let i = 0; i < ids.length; i += 50) {
		const chunk = ids.slice(i, i + 50);
		const marks = chunk.map(() => "?").join(",");
		const { results: files } = await env.DB.prepare(`SELECT r2_key FROM asset_files WHERE asset_id IN (${marks})`)
			.bind(...chunk)
			.all<{ r2_key: string }>();
		// D1 的 meta.changes 会把级联删除的行也算进去，所以先查出实际存在的条目
		const { results: assets } = await env.DB.prepare(`SELECT id, derived_rev FROM assets WHERE id IN (${marks})`)
			.bind(...chunk)
			.all<{ id: string; derived_rev: number }>();
		// 任务写了派生文件、随后失败（比如完整性校验不通过）时，这些文件没有 asset_files 行，按当前版本号的 key 一起删掉。
		// R2 的删除不收费，不存在的 key 也不报错。
		const { results: scans } = await env.DB.prepare(
			`SELECT sprite_key FROM face_scans WHERE asset_id IN (${marks}) AND sprite_key IS NOT NULL`,
		)
			.bind(...chunk)
			.all<{ sprite_key: string }>();
		const { results: faces } = await env.DB.prepare(`SELECT id FROM faces WHERE asset_id IN (${marks})`)
			.bind(...chunk)
			.all<{ id: string }>();
		const keys = new Set([...files.map((f) => f.r2_key), ...scans.map((s) => s.sprite_key)]);
		for (const a of assets) {
			for (const [role, { ext }] of Object.entries(DERIVED_FILES)) keys.add(derivedKey(a.id, role, a.derived_rev, ext));
		}
		const list = [...keys];
		for (let j = 0; j < list.length; j += 1000) await env.PHOTOS.delete(list.slice(j, j + 1000));
		await deleteVectors(env, chunk);
		await deleteFaceVectors(env, faces.map((f) => f.id));
		await env.DB.batch([
			...deleteSearchRows(env, chunk),
			env.DB.prepare(`DELETE FROM assets WHERE id IN (${marks})`).bind(...chunk),
		]);
		deleted += assets.length;
	}
	return deleted;
}

/**
 * 每天一次：永久删除在回收站里超过 30 天的条目。
 * 每次最多处理 PURGE_BATCH 个，剩下的留到第二天；不会自我触发。
 */
export async function purgeTrash(env: Env): Promise<void> {
	const { results } = await env.DB.prepare(
		"SELECT id FROM assets WHERE deleted_at IS NOT NULL AND deleted_at < ? LIMIT ?",
	)
		.bind(Date.now() - TRASH_RETENTION_MS, PURGE_BATCH)
		.all<{ id: string }>();
	if (!results.length) return;
	const count = await deleteAssetsPermanently(env, results.map((r) => r.id));
	console.log(JSON.stringify({ event: "trash_purged", count }));
}
