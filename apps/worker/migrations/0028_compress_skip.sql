-- 原图压缩：记下不压缩的原因和缩小分辨率的目标（整理 › 原图压缩，src/compress.ts）。只加列和索引，兼容线上旧代码。
--
--   compress_skip    compress_state = 2 时不压缩的原因（shared 的 COMPRESS_SKIP_REASONS）；之前跳过的是 NULL（原因未知）
--   compress_target  最近一次请求压缩时选的像素上限（0 是不缩小），compress 任务运行时读它
ALTER TABLE asset_files ADD COLUMN compress_skip TEXT;
ALTER TABLE asset_files ADD COLUMN compress_target INTEGER;

-- 已压缩 / 不压缩的列表（GET /api/compress/done?state=）：按状态、原图大小倒序
CREATE INDEX asset_files_compress_done ON asset_files(compress_state, size DESC, id) WHERE compress_state IS NOT NULL;
