-- 全文索引改成按 rowid 定位。
-- 旧的 assets_fts 把 asset_id 存成 FTS5 的 UNINDEXED 列，DELETE / UPDATE ... WHERE asset_id = ? 只能全表扫描：
-- 每处理一张照片扫一遍整个索引（线上 24 万行），导入时是平方级（7 天 334 亿行读取，占全部读取的 88%）。
--
-- asset_search_ids 给每个条目分配一个整数 id（INTEGER PRIMARY KEY，VACUUM 也不会变），asset_search 的 rowid 就是它，
-- 删改都写成 WHERE rowid = (SELECT id FROM asset_search_ids WHERE asset_id = ?)，只读几行。
-- 不用 assets 的隐式 rowid：assets 的主键是 TEXT，隐式 rowid 在 VACUUM 之后可能变化。
-- 不加外键：删除条目时先显式删掉 asset_search 的那一行（purge.ts、Live Photo 合并），级联删掉 id 会留下找不回的索引行。
--
-- 旧表这一版先保留（迁移先于新代码执行，这期间旧代码还在写它），下一个版本补齐期间新增的几行、再删掉。
CREATE TABLE asset_search_ids (
  id        INTEGER PRIMARY KEY,
  asset_id  TEXT NOT NULL UNIQUE
);
CREATE VIRTUAL TABLE asset_search USING fts5(names, description, tokenize = 'trigram');

INSERT INTO asset_search_ids (asset_id) SELECT DISTINCT asset_id FROM assets_fts;
-- 旧表理论上每个条目只有一行，按条目合并一次，避免重复的 rowid 让迁移失败
INSERT INTO asset_search (rowid, names, description)
  SELECT i.id, f.names, f.description
  FROM (SELECT asset_id, MAX(names) AS names, MAX(description) AS description FROM assets_fts GROUP BY asset_id) f
  CROSS JOIN asset_search_ids i ON i.asset_id = f.asset_id;
