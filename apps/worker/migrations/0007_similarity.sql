-- 相同 / 相似照片的指纹（容器在 derive 时算好，见 apps/processor/server.mjs 和 src/similar.ts）。
--   phash：64 位感知哈希（16 个十六进制字符）。b0..b4 是拆出来的 5 段（13+13+13+13+12 位）：
--          汉明距离不超过 4 的两张图至少有一段完全相同，所以按段查就不会漏掉。
--   embedding：CLIP 图像向量，512 个 int8。Vectorize 里的向量只是它的副本，indexed = 0 表示还没写进去。
CREATE TABLE asset_fp (
  asset_id    TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
  model       TEXT NOT NULL,
  phash       TEXT NOT NULL,
  b0          INTEGER NOT NULL,
  b1          INTEGER NOT NULL,
  b2          INTEGER NOT NULL,
  b3          INTEGER NOT NULL,
  b4          INTEGER NOT NULL,
  embedding   BLOB NOT NULL,
  indexed     INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX asset_fp_b0 ON asset_fp(b0);
CREATE INDEX asset_fp_b1 ON asset_fp(b1);
CREATE INDEX asset_fp_b2 ON asset_fp(b2);
CREATE INDEX asset_fp_b3 ON asset_fp(b3);
CREATE INDEX asset_fp_b4 ON asset_fp(b4);
CREATE INDEX asset_fp_unindexed ON asset_fp(updated_at) WHERE indexed = 0;

-- 自定义相似集：用户选几张照片（正例）命名，再对建议点“是 / 不是”（负例）。
-- centroid 由正负例算出（512 个 float32），用来找候选和给新照片打分。
CREATE TABLE smart_sets (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  centroid    BLOB,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE TABLE smart_set_examples (
  set_id      TEXT NOT NULL REFERENCES smart_sets(id) ON DELETE CASCADE,
  asset_id    TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  label       INTEGER NOT NULL CHECK (label IN (1, -1)),
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (set_id, asset_id)
);
CREATE INDEX smart_set_examples_asset ON smart_set_examples(asset_id);
CREATE TABLE smart_set_suggestions (
  set_id      TEXT NOT NULL REFERENCES smart_sets(id) ON DELETE CASCADE,
  asset_id    TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  score       REAL NOT NULL,
  PRIMARY KEY (set_id, asset_id)
);
CREATE INDEX smart_set_suggestions_score ON smart_set_suggestions(set_id, score DESC);
CREATE INDEX smart_set_suggestions_asset ON smart_set_suggestions(asset_id);
