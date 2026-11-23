-- 相似照片折叠（src/stacks.ts）：同一天里 phash + CLIP 向量都相似的一系列照片折叠成一张封面（右下角 +N）。
-- stack_id 由写指纹时的增量分组和设置页触发的分批补建写入；时间线按 COALESCE(stack_id, burst_id, id) 折叠，
-- 封面 / 可见性过滤和连拍一样在读取时算，删除 / 归档 / 恢复不用维护。
ALTER TABLE assets ADD COLUMN stack_id TEXT;

-- 组成员列表（/api/stacks/:id/assets）和“不折叠这组”按 stack_id 找成员。
CREATE INDEX assets_stack ON assets(stack_id) WHERE stack_id IS NOT NULL;

-- 增量分组读“当天”的候选、补建按天枚举和读取：local_day 等值 / 范围都走这个窄索引，不扫全库。
CREATE INDEX assets_day ON assets(local_day, taken_at, id)
  WHERE deleted_at IS NULL AND status = 'ready' AND archived = 0;

-- “不折叠这组”：整组成员记进来，以后不再参与分组（增量和补建都跳过），随条目级联删除。
CREATE TABLE stack_dismissed (
  asset_id TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE
);

-- 补建进度：cursor 是处理到的最后一天（local_day 升序），done = 1 表示全库处理完。
-- lock_until 防止两个 chunk 同时跑。只由用户点击推进，没有 Cron。
CREATE TABLE stacks_state (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  cursor     TEXT NOT NULL DEFAULT '',
  done       INTEGER NOT NULL DEFAULT 0,
  processed  INTEGER NOT NULL DEFAULT 0,
  lock_until INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
