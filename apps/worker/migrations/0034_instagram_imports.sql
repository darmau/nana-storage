-- 从 Instagram 导入的图片：Instagram 的媒体 ID → 条目（src/instagram.ts）。
-- Instagram 的 CDN 每次给的字节不一定相同（重新编码），按 sha256 去重不可靠，所以按媒体 ID 去重。
-- 条目永久删除时一起删掉，之后可以重新导入。只加表，兼容旧代码。
CREATE TABLE instagram_imports (
  media_id    TEXT PRIMARY KEY,
  asset_id    TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL
);
CREATE INDEX instagram_imports_asset ON instagram_imports(asset_id);
