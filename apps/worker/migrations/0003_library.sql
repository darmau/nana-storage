-- 批量下载时写 zip 头要用（由容器在处理时算好）。
ALTER TABLE asset_files ADD COLUMN crc32 INTEGER;

CREATE INDEX folders_parent ON folders(parent_id, name);
CREATE INDEX albums_updated ON albums(updated_at DESC);
CREATE INDEX album_assets_album ON album_assets(album_id, added_at DESC);
