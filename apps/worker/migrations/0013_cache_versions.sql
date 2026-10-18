-- 条件请求按数据分组的版本号、存储空间计数、未完成条目的索引。只加表、触发器和索引，兼容线上旧代码
-- （0011 的 data_version 和它的触发器保持不变：旧代码的 ETag 和资料库同步 /api/sync 还在用它）。
--
-- 1. cache_versions：每组列表接口只看自己依赖的版本号（src/dbcache.ts），无关的写入不会让它们的 ETag 失效。
--    library    时间线、地图、文件夹、相册、收藏、回收站、搜索。只看“可见”的条目：处理完的（ready）或者在回收站里的。
--               上传和处理过程中的 uploading → pending → processing 不改它，处理完（变成 ready）才加一。
--               folders 也算进来（文件夹详情的面包屑和子文件夹）。
--    people     人物列表 / 详情 / 照片：people、faces（只看会影响结果的列，indexed 这类内部状态不算）、face_scans。
--    smart_sets 主题列表 / 详情 / 照片 / 建议：smart_sets、smart_set_examples、smart_set_suggestions。
--    人物和主题的结果还取决于条目是否可见，所以它们的 ETag 同时带上 library。
--    触发器是逐行的：每改一行多写一行（主题更新一次替换最多 3000 条建议 ≈ 6000 行写入），在免费写入额度里可以忽略。
CREATE TABLE cache_versions (
  name TEXT PRIMARY KEY,
  v    INTEGER NOT NULL
);
INSERT INTO cache_versions (name, v) VALUES ('library', 0), ('people', 0), ('smart_sets', 0);

CREATE TRIGGER cv_library_assets_ins AFTER INSERT ON assets
  WHEN NEW.status = 'ready' OR NEW.deleted_at IS NOT NULL
  BEGIN UPDATE cache_versions SET v = v + 1 WHERE name = 'library'; END;
CREATE TRIGGER cv_library_assets_upd AFTER UPDATE ON assets
  WHEN OLD.status = 'ready' OR NEW.status = 'ready' OR OLD.deleted_at IS NOT NULL OR NEW.deleted_at IS NOT NULL
  BEGIN UPDATE cache_versions SET v = v + 1 WHERE name = 'library'; END;
CREATE TRIGGER cv_library_assets_del AFTER DELETE ON assets
  WHEN OLD.status = 'ready' OR OLD.deleted_at IS NOT NULL
  BEGIN UPDATE cache_versions SET v = v + 1 WHERE name = 'library'; END;
CREATE TRIGGER cv_library_albums_ins AFTER INSERT ON albums BEGIN UPDATE cache_versions SET v = v + 1 WHERE name = 'library'; END;
CREATE TRIGGER cv_library_albums_upd AFTER UPDATE ON albums BEGIN UPDATE cache_versions SET v = v + 1 WHERE name = 'library'; END;
CREATE TRIGGER cv_library_albums_del AFTER DELETE ON albums BEGIN UPDATE cache_versions SET v = v + 1 WHERE name = 'library'; END;
CREATE TRIGGER cv_library_album_assets_ins AFTER INSERT ON album_assets BEGIN UPDATE cache_versions SET v = v + 1 WHERE name = 'library'; END;
CREATE TRIGGER cv_library_album_assets_upd AFTER UPDATE ON album_assets BEGIN UPDATE cache_versions SET v = v + 1 WHERE name = 'library'; END;
CREATE TRIGGER cv_library_album_assets_del AFTER DELETE ON album_assets BEGIN UPDATE cache_versions SET v = v + 1 WHERE name = 'library'; END;
CREATE TRIGGER cv_library_folders_ins AFTER INSERT ON folders BEGIN UPDATE cache_versions SET v = v + 1 WHERE name = 'library'; END;
CREATE TRIGGER cv_library_folders_upd AFTER UPDATE ON folders BEGIN UPDATE cache_versions SET v = v + 1 WHERE name = 'library'; END;
CREATE TRIGGER cv_library_folders_del AFTER DELETE ON folders BEGIN UPDATE cache_versions SET v = v + 1 WHERE name = 'library'; END;

CREATE TRIGGER cv_people_people_ins AFTER INSERT ON people BEGIN UPDATE cache_versions SET v = v + 1 WHERE name = 'people'; END;
CREATE TRIGGER cv_people_people_upd AFTER UPDATE ON people BEGIN UPDATE cache_versions SET v = v + 1 WHERE name = 'people'; END;
CREATE TRIGGER cv_people_people_del AFTER DELETE ON people BEGIN UPDATE cache_versions SET v = v + 1 WHERE name = 'people'; END;
CREATE TRIGGER cv_people_faces_ins AFTER INSERT ON faces BEGIN UPDATE cache_versions SET v = v + 1 WHERE name = 'people'; END;
CREATE TRIGGER cv_people_faces_upd AFTER UPDATE OF asset_id, idx, x, y, w, h, px, score, sharpness, person_id, assigned, state ON faces
  BEGIN UPDATE cache_versions SET v = v + 1 WHERE name = 'people'; END;
CREATE TRIGGER cv_people_faces_del AFTER DELETE ON faces BEGIN UPDATE cache_versions SET v = v + 1 WHERE name = 'people'; END;
CREATE TRIGGER cv_people_face_scans_ins AFTER INSERT ON face_scans BEGIN UPDATE cache_versions SET v = v + 1 WHERE name = 'people'; END;
CREATE TRIGGER cv_people_face_scans_upd AFTER UPDATE ON face_scans BEGIN UPDATE cache_versions SET v = v + 1 WHERE name = 'people'; END;
CREATE TRIGGER cv_people_face_scans_del AFTER DELETE ON face_scans BEGIN UPDATE cache_versions SET v = v + 1 WHERE name = 'people'; END;

CREATE TRIGGER cv_smart_sets_ins AFTER INSERT ON smart_sets BEGIN UPDATE cache_versions SET v = v + 1 WHERE name = 'smart_sets'; END;
CREATE TRIGGER cv_smart_sets_upd AFTER UPDATE ON smart_sets BEGIN UPDATE cache_versions SET v = v + 1 WHERE name = 'smart_sets'; END;
CREATE TRIGGER cv_smart_sets_del AFTER DELETE ON smart_sets BEGIN UPDATE cache_versions SET v = v + 1 WHERE name = 'smart_sets'; END;
CREATE TRIGGER cv_smart_set_examples_ins AFTER INSERT ON smart_set_examples BEGIN UPDATE cache_versions SET v = v + 1 WHERE name = 'smart_sets'; END;
CREATE TRIGGER cv_smart_set_examples_upd AFTER UPDATE ON smart_set_examples BEGIN UPDATE cache_versions SET v = v + 1 WHERE name = 'smart_sets'; END;
CREATE TRIGGER cv_smart_set_examples_del AFTER DELETE ON smart_set_examples BEGIN UPDATE cache_versions SET v = v + 1 WHERE name = 'smart_sets'; END;
CREATE TRIGGER cv_smart_set_suggestions_ins AFTER INSERT ON smart_set_suggestions BEGIN UPDATE cache_versions SET v = v + 1 WHERE name = 'smart_sets'; END;
CREATE TRIGGER cv_smart_set_suggestions_upd AFTER UPDATE ON smart_set_suggestions BEGIN UPDATE cache_versions SET v = v + 1 WHERE name = 'smart_sets'; END;
CREATE TRIGGER cv_smart_set_suggestions_del AFTER DELETE ON smart_set_suggestions BEGIN UPDATE cache_versions SET v = v + 1 WHERE name = 'smart_sets'; END;

-- 2. storage_totals：侧边栏的存储空间（GET /api/stats/summary）只读这一行，不再每次扫两张表。
--    bytes  = asset_files 全部文件的字节数（包括缩略图、预览、回收站）
--    photos / videos = 处理好的、不在回收站里的条目（photos 包括 Live Photo）
--    由触发器维护（级联删除也会触发）。/api/stats 每次打开都会全量统计，发现对不上时顺手校正（src/stats.ts）。
--    先建触发器、再写初始值：D1 的写入是串行的，中间发生的写入要么被初始值统计到，要么被触发器加上，不会漏也不会重复。
CREATE TABLE storage_totals (
  id     INTEGER PRIMARY KEY CHECK (id = 1),
  bytes  INTEGER NOT NULL,
  photos INTEGER NOT NULL,
  videos INTEGER NOT NULL
);

CREATE TRIGGER st_files_ins AFTER INSERT ON asset_files
  BEGIN UPDATE storage_totals SET bytes = bytes + NEW.size WHERE id = 1; END;
CREATE TRIGGER st_files_del AFTER DELETE ON asset_files
  BEGIN UPDATE storage_totals SET bytes = bytes - OLD.size WHERE id = 1; END;
CREATE TRIGGER st_files_upd AFTER UPDATE OF size ON asset_files
  BEGIN UPDATE storage_totals SET bytes = bytes + NEW.size - OLD.size WHERE id = 1; END;

CREATE TRIGGER st_assets_ins AFTER INSERT ON assets
  WHEN NEW.status = 'ready' AND NEW.deleted_at IS NULL
  BEGIN UPDATE storage_totals SET photos = photos + (NEW.kind != 'video'), videos = videos + (NEW.kind = 'video') WHERE id = 1; END;
CREATE TRIGGER st_assets_del AFTER DELETE ON assets
  WHEN OLD.status = 'ready' AND OLD.deleted_at IS NULL
  BEGIN UPDATE storage_totals SET photos = photos - (OLD.kind != 'video'), videos = videos - (OLD.kind = 'video') WHERE id = 1; END;
CREATE TRIGGER st_assets_upd AFTER UPDATE OF status, deleted_at, kind ON assets
  WHEN (OLD.status = 'ready' AND OLD.deleted_at IS NULL) OR (NEW.status = 'ready' AND NEW.deleted_at IS NULL)
  BEGIN UPDATE storage_totals SET
    photos = photos + (NEW.status = 'ready' AND NEW.deleted_at IS NULL AND NEW.kind != 'video')
                    - (OLD.status = 'ready' AND OLD.deleted_at IS NULL AND OLD.kind != 'video'),
    videos = videos + (NEW.status = 'ready' AND NEW.deleted_at IS NULL AND NEW.kind = 'video')
                    - (OLD.status = 'ready' AND OLD.deleted_at IS NULL AND OLD.kind = 'video')
  WHERE id = 1; END;

INSERT INTO storage_totals (id, bytes, photos, videos)
  SELECT 1,
    (SELECT COALESCE(SUM(size), 0) FROM asset_files),
    COALESCE(SUM(kind != 'video'), 0),
    COALESCE(SUM(kind = 'video'), 0)
  FROM assets WHERE status = 'ready' AND deleted_at IS NULL;

-- 3. 文件夹里还没处理完的条目（GET /api/folders/:id/unfinished）：只扫这些行，不扫整棵子树的照片。
CREATE INDEX assets_unfinished ON assets(folder_id) WHERE deleted_at IS NULL AND status != 'ready';
