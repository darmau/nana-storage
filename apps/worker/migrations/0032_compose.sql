-- 拼接 / 切割（src/compose.ts）。只加表和索引，兼容线上旧代码。
--
-- 每个拼接 / 切割生成的新条目一行：asset_id 是新条目，spec 是生成它的方法（JSON：mode、direction、sources，切割还有 from / to / index）。
-- 同一次操作生成的条目 group_id 相同（拼接 1 个，切割每块 1 个）；全部处理好之后由最后完成的那个任务把原照片移进回收站，
-- 并把 finished_at 记上（只做一次）。
CREATE TABLE compose_specs (
  asset_id     TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
  group_id     TEXT NOT NULL,
  spec         TEXT NOT NULL,
  finished_at  INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE INDEX compose_specs_group ON compose_specs(group_id);
