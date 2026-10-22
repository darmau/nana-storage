-- 归档：归档的照片不出现在时间线（首页）、文件夹和相册里（文件夹 / 相册页勾选“显示归档照片”时才列出），
-- 只在“归档”页集中查看。搜索、地图、人物、主题、收藏照常显示。
-- 只加列和索引，兼容线上旧代码（旧代码不读这一列，照常显示全部照片）。
ALTER TABLE assets ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;

-- 归档页（GET /api/archive/assets）。和 assets_favorite_visible 同样的形状：等值条件 + 排序，没有统计信息时也会被选中。
CREATE INDEX assets_archived_visible ON assets(archived, deleted_at, taken_at DESC, id DESC)
  WHERE archived = 1 AND deleted_at IS NULL AND status = 'ready';
