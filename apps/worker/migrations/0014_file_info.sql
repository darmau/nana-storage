-- 文件夹列表视图要显示的文件名和原件大小，直接冗余在 assets 上：列表一页 500 条只读 assets 的行，
-- 文件夹的体积和 COUNT(*) 在同一次扫描里 SUM，不用再按条目去查 asset_files。只加列和触发器，兼容线上旧代码。
--   file_name  原件的原始文件名（original 优先，没有就取 raw / live_video 里的一个）
--   file_size  原件的总字节数（original + raw + live_video，不含缩略图、预览）
-- 由 asset_files 上的触发器维护（只在原件行变化时触发，上传完成、Live Photo 合并、永久删除都覆盖），
-- 每次多写一行 assets（以及它带出来的 data_version / cache_versions 计数），量和上传次数相同。
ALTER TABLE assets ADD COLUMN file_name TEXT;
ALTER TABLE assets ADD COLUMN file_size INTEGER NOT NULL DEFAULT 0;

CREATE TRIGGER fi_files_ins AFTER INSERT ON asset_files
  WHEN NEW.role IN ('original', 'raw', 'live_video')
  BEGIN
    UPDATE assets SET
      file_size = (SELECT COALESCE(SUM(size), 0) FROM asset_files WHERE asset_id = NEW.asset_id AND role IN ('original', 'raw', 'live_video')),
      file_name = (SELECT original_name FROM asset_files WHERE asset_id = NEW.asset_id AND role IN ('original', 'raw', 'live_video')
                   AND original_name IS NOT NULL ORDER BY role != 'original', role LIMIT 1)
    WHERE id = NEW.asset_id;
  END;

CREATE TRIGGER fi_files_del AFTER DELETE ON asset_files
  WHEN OLD.role IN ('original', 'raw', 'live_video')
  BEGIN
    UPDATE assets SET
      file_size = (SELECT COALESCE(SUM(size), 0) FROM asset_files WHERE asset_id = OLD.asset_id AND role IN ('original', 'raw', 'live_video')),
      file_name = (SELECT original_name FROM asset_files WHERE asset_id = OLD.asset_id AND role IN ('original', 'raw', 'live_video')
                   AND original_name IS NOT NULL ORDER BY role != 'original', role LIMIT 1)
    WHERE id = OLD.asset_id;
  END;

-- Live Photo 合并时视频文件改挂到照片条目上（asset_id 和 role 都会变），两边都重算。
CREATE TRIGGER fi_files_upd AFTER UPDATE OF asset_id, role, size, original_name ON asset_files
  WHEN OLD.role IN ('original', 'raw', 'live_video') OR NEW.role IN ('original', 'raw', 'live_video')
  BEGIN
    UPDATE assets SET
      file_size = (SELECT COALESCE(SUM(size), 0) FROM asset_files WHERE asset_id = assets.id AND role IN ('original', 'raw', 'live_video')),
      file_name = (SELECT original_name FROM asset_files WHERE asset_id = assets.id AND role IN ('original', 'raw', 'live_video')
                   AND original_name IS NOT NULL ORDER BY role != 'original', role LIMIT 1)
    WHERE id IN (OLD.asset_id, NEW.asset_id);
  END;

-- 已有的条目一次补齐
UPDATE assets SET
  file_size = (SELECT COALESCE(SUM(size), 0) FROM asset_files WHERE asset_id = assets.id AND role IN ('original', 'raw', 'live_video')),
  file_name = (SELECT original_name FROM asset_files WHERE asset_id = assets.id AND role IN ('original', 'raw', 'live_video')
               AND original_name IS NOT NULL ORDER BY role != 'original', role LIMIT 1);
