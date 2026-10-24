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
-- 部署前的照片都是 NULL：由 scanSimilar 逐批补查（同时补上它们的重复照片候选对）。
ALTER TABLE asset_fp ADD COLUMN similar_at INTEGER;
CREATE INDEX asset_fp_similar_pending ON asset_fp(updated_at) WHERE similar_at IS NULL AND indexed = 1;

-- 待整理队列：similar_n 是这张照片的相似照片数（查近邻时更新），打开页面时按它从大到小逐页取中心，读取量和资料库大小无关。
-- 0 表示不当组的中心（没有能参与整理的相似照片了、处理过、暂不处理过）；
-- -1 表示相似的照片都是别的人物：人物有变化（cache_versions 的 people 版本变了）时重新计数（similar_state.people_v）。
ALTER TABLE asset_fp ADD COLUMN similar_n INTEGER NOT NULL DEFAULT 0;
CREATE INDEX asset_fp_similar_queue ON asset_fp(similar_n DESC, asset_id) WHERE similar_n > 0;
CREATE INDEX asset_fp_similar_parked ON asset_fp(asset_id) WHERE similar_n < 0;
CREATE TABLE similar_state (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  people_v  INTEGER NOT NULL
);

-- “暂不处理”：组里的照片记下时间，这些组排到队列末尾（按时间从早到晚轮流出现），不会从列表里消失。
CREATE TABLE similar_snoozes (
  asset_id    TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
  snoozed_at  INTEGER NOT NULL
);
CREATE INDEX similar_snoozes_queue ON similar_snoozes(snoozed_at, asset_id);
