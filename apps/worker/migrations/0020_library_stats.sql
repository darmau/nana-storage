-- 统计数据页（/stats）。只加表和索引，兼容线上旧代码。

-- 资料库统计的快照（拍摄时间分布、拍摄设备），每天的 Cron 重新统计一次（src/library-stats.ts），页面只读这一行。
CREATE TABLE library_stats (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  computed_at INTEGER NOT NULL,
  data        TEXT NOT NULL   -- JSON（LibraryStats 去掉 computedAt）
);

-- 最大的照片 / 视频（GET /api/stats/largest/:kind）：每种 kind 按原件大小倒序读前 50 行，不扫全表。
CREATE INDEX assets_size ON assets(kind, file_size DESC) WHERE deleted_at IS NULL AND status = 'ready';
