-- 列表接口的条件请求（ETag / 304）用的数据版本号。
-- 时间线、地图、文件夹 / 相册 / 收藏 / 回收站 / 搜索的列表只取决于这几张表，任何一行变化都让版本号 +1，
-- 客户端带着旧 ETag 来时只读这一行就能回 304，不用重跑整条查询。用触发器维护，任何写入路径都不会漏掉。
-- 每改一行条目多写一行（批量操作 1000 个就多 1000 行写入），在 D1 每月 5000 万行的免费写入额度里可以忽略。
CREATE TABLE data_version (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  v  INTEGER NOT NULL
);
INSERT INTO data_version (id, v) VALUES (1, 0);

CREATE TRIGGER data_version_assets_ins AFTER INSERT ON assets BEGIN UPDATE data_version SET v = v + 1 WHERE id = 1; END;
CREATE TRIGGER data_version_assets_upd AFTER UPDATE ON assets BEGIN UPDATE data_version SET v = v + 1 WHERE id = 1; END;
CREATE TRIGGER data_version_assets_del AFTER DELETE ON assets BEGIN UPDATE data_version SET v = v + 1 WHERE id = 1; END;
CREATE TRIGGER data_version_albums_ins AFTER INSERT ON albums BEGIN UPDATE data_version SET v = v + 1 WHERE id = 1; END;
CREATE TRIGGER data_version_albums_upd AFTER UPDATE ON albums BEGIN UPDATE data_version SET v = v + 1 WHERE id = 1; END;
CREATE TRIGGER data_version_albums_del AFTER DELETE ON albums BEGIN UPDATE data_version SET v = v + 1 WHERE id = 1; END;
CREATE TRIGGER data_version_album_assets_ins AFTER INSERT ON album_assets BEGIN UPDATE data_version SET v = v + 1 WHERE id = 1; END;
CREATE TRIGGER data_version_album_assets_upd AFTER UPDATE ON album_assets BEGIN UPDATE data_version SET v = v + 1 WHERE id = 1; END;
CREATE TRIGGER data_version_album_assets_del AFTER DELETE ON album_assets BEGIN UPDATE data_version SET v = v + 1 WHERE id = 1; END;
