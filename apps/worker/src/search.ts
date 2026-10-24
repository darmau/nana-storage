/**
 * 全文索引（文件名 + 描述，迁移 0026）：asset_search 的 rowid 是 asset_search_ids 给条目分配的整数 id。
 * 删改一律按 rowid 定位（WHERE rowid = (SELECT id FROM asset_search_ids WHERE asset_id = ?)），只读几行；
 * 不要写成按条目 id 过滤 FTS 表本身：FTS5 的非全文列没有索引，那样每次都扫描整个索引。
 */

const ROWID_OF = "(SELECT id FROM asset_search_ids WHERE asset_id = ?)";

/** 处理完成时重写一个条目的索引行（描述取 assets 里现有的，用户编辑过的不丢）。放进调用方的 batch。 */
export function replaceSearchRow(env: Env, assetId: string, names: string): D1PreparedStatement[] {
	return [
		env.DB.prepare("INSERT OR IGNORE INTO asset_search_ids (asset_id) VALUES (?)").bind(assetId),
		env.DB.prepare(`DELETE FROM asset_search WHERE rowid = ${ROWID_OF}`).bind(assetId),
		env.DB.prepare(
			`INSERT INTO asset_search (rowid, names, description) SELECT ${ROWID_OF}, ?, COALESCE(description, '') FROM assets WHERE id = ?`,
		).bind(assetId, names, assetId),
	];
}

/** 编辑描述。条目还没有索引行（没处理完）时什么也不做，处理完成时会带上描述。 */
export function updateSearchDescription(env: Env, assetId: string, description: string): D1PreparedStatement {
	return env.DB.prepare(`UPDATE asset_search SET description = ? WHERE rowid = ${ROWID_OF}`).bind(description, assetId);
}

/** 删除条目之前调用（最多 50 个 id）：先删索引行，再删 id。放进删除条目的同一个 batch。 */
export function deleteSearchRows(env: Env, assetIds: string[]): D1PreparedStatement[] {
	const marks = assetIds.map(() => "?").join(",");
	return [
		env.DB.prepare(`DELETE FROM asset_search WHERE rowid IN (SELECT id FROM asset_search_ids WHERE asset_id IN (${marks}))`).bind(...assetIds),
		env.DB.prepare(`DELETE FROM asset_search_ids WHERE asset_id IN (${marks})`).bind(...assetIds),
	];
}

/**
 * 搜索：返回 FROM 子句（别名 s，只有一列 asset_id）和参数。查询词 ≥3 个字符走 trigram 索引，整体作为短语传给 MATCH，
 * 避免 FTS 语法注入；1–2 个字符退回 LIKE（已转义 % 和 _）。
 */
export function searchSource(q: string): { sql: string; binds: string[] } {
	if ([...q].length >= 3)
		return {
			sql: "(SELECT DISTINCT i.asset_id FROM asset_search f CROSS JOIN asset_search_ids i ON i.id = f.rowid WHERE asset_search MATCH ?) s",
			binds: [`"${q.replace(/"/g, '""')}"`],
		};
	const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
	return {
		sql:
			"(SELECT DISTINCT i.asset_id FROM asset_search f CROSS JOIN asset_search_ids i ON i.id = f.rowid " +
			"WHERE f.names LIKE ? ESCAPE '\\' OR f.description LIKE ? ESCAPE '\\') s",
		binds: [like, like],
	};
}
