-- “相似照片”整理：看起来差不多的照片（同一张图的各种版本、同一次拍摄里姿势略有不同的几张），只按 CLIP 向量判断，不看时间。
-- 每张照片的向量进 Vectorize 一段时间后（SIMILAR_SCAN_SETTLE_MS）查一次近邻（scanSimilar），余弦达到
-- SIMILAR_GROUP_MIN_COSINE 的照片对存在这里（a < b）。回收站、归档、视频、人物在读取时过滤。条目被永久删除时随之删除。
-- 只加表、列和索引，兼容线上旧代码。
CREATE TABLE similar_pairs (
  a      TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  b      TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  score  REAL NOT NULL,
  PRIMARY KEY (a, b),
  CHECK (a < b)
);
CREATE INDEX similar_pairs_b ON similar_pairs(b);

-- 查过近邻的时间；NULL 表示还没查。saveFingerprint 用 INSERT OR REPLACE 重写整行，指纹变了自然回到 NULL。
ALTER TABLE asset_fp ADD COLUMN similar_at INTEGER;
CREATE INDEX asset_fp_similar_pending ON asset_fp(updated_at) WHERE similar_at IS NULL AND indexed = 1;

-- “暂不处理”：组里的照片记下时间，这些组排到队列末尾（按时间从早到晚轮流出现），不会从列表里消失。
CREATE TABLE similar_snoozes (
  asset_id    TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
  snoozed_at  INTEGER NOT NULL
);
