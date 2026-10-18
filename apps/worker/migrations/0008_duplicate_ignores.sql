-- “整理重复”里被标记为“不是重复”的照片对（a < b）。分组时这两张不再直接连在一起。
-- 条目被永久删除时随之删除。
CREATE TABLE duplicate_ignores (
  a           TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  b           TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (a, b),
  CHECK (a < b)
);
CREATE INDEX duplicate_ignores_b ON duplicate_ignores(b);
