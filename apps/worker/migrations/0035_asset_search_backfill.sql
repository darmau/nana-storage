-- 补齐 0026 留下的缺口：迁移先于新代码执行，迁移和部署之间旧代码处理的照片只写进了旧表 assets_fts，
-- 新表 asset_search 里没有它们，这几张照片按文件名搜不到。
-- 只补 asset_search 里还没有的（之后重新处理过的已经有新行，不动），描述取 assets 里现在的（之后编辑过的不丢）。
-- 可以重复执行；只加数据，不删旧表（旧表之后的版本再删，见 CHANGELOG）。
INSERT OR IGNORE INTO asset_search_ids (asset_id)
  SELECT DISTINCT f.asset_id FROM assets_fts f
  WHERE EXISTS (SELECT 1 FROM assets a WHERE a.id = f.asset_id);

INSERT INTO asset_search (rowid, names, description)
  SELECT i.id, f.names, COALESCE(a.description, '')
  FROM (SELECT asset_id, MAX(names) AS names FROM assets_fts GROUP BY asset_id) f
  CROSS JOIN asset_search_ids i ON i.asset_id = f.asset_id
  JOIN assets a ON a.id = f.asset_id
  WHERE NOT EXISTS (SELECT 1 FROM asset_search s WHERE s.rowid = i.id);
