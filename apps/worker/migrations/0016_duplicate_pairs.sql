-- “整理重复”的候选照片对（a < b）：哈希距离以内、照片 / 视频一致、CLIP 向量也几乎一样（都是写入后不会变的条件）。
-- 写指纹时（saveFingerprint）按 5 段哈希的索引查近邻，增量维护；打开页面时只读这张表，不再扫描全库的 asset_fp。
-- 连拍、拍摄时间、回收站、“不是重复”会变，读取时再过滤。条目被永久删除时随之删除。
CREATE TABLE duplicate_pairs (
  a  TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  b  TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  PRIMARY KEY (a, b),
  CHECK (a < b)
);
CREATE INDEX duplicate_pairs_b ON duplicate_pairs(b);

-- 有这一行表示 duplicate_pairs 已经按全库建好。部署前写入的指纹没有候选对：第一次打开“整理重复”时全量扫描一次补上
-- （rebuildDuplicatePairs），增量维护失败时也删掉这一行，下次打开时再补。
CREATE TABLE duplicate_pairs_state (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  built_at   INTEGER NOT NULL,
  truncated  INTEGER NOT NULL DEFAULT 0
);
