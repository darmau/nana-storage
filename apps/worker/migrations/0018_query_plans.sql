-- 让常用的列表查询不依赖统计信息也能走对索引。只加 / 删索引和触发器，兼容线上旧代码。
--
-- 没有 sqlite_stat1 时（全新部署、从没跑过 ANALYZE），SQLite 遇到 ORDER BY taken_at DESC, id DESC 总是选
-- assets_timeline（省掉排序），再逐行过滤：打开一个只有几十张照片的文件夹，每页都要读完整个资料库。
-- 下面两个部分索引和查询的形状完全一致（等值条件 + 排序），没有统计信息也会被选中。
-- 连拍、人物、地图的查询改了写法（CROSS JOIN 固定连接顺序 / INDEXED BY），见 src/library.ts、src/people.ts、src/map.ts。
-- test/query-plans.test.ts 断言这些查询不走 assets_timeline（测试库同样没有统计信息）。

-- 文件夹里的照片（folder_id = ? / IS NULL）、文件夹页的人物条、封面。原来的 assets_folder 留着：外键 ON DELETE SET NULL 和删除文件夹时的检查要用。
CREATE INDEX assets_folder_visible ON assets(folder_id, taken_at DESC, id DESC) WHERE deleted_at IS NULL AND status = 'ready';

-- 收藏。favorite、deleted_at 都是等值条件，比 assets_timeline 多一列等值，没有统计信息时也优先选它。
-- 它完全覆盖了 assets_favorite 的用途，删掉旧的，收藏的写入少一次索引更新。
CREATE INDEX assets_favorite_visible ON assets(favorite, deleted_at, taken_at DESC, id DESC)
  WHERE favorite = 1 AND deleted_at IS NULL AND status = 'ready';
DROP INDEX IF EXISTS assets_favorite;

-- 0011 的 data_version 只剩 GET /api/sync 在读（列表的 ETag 早已改用 cache_versions）。同步只关心条目在上传、处理中的变化，
-- 相册的修改都是用户自己在页面上做的（前端自己刷新），这几个触发器每加一张照片进相册就白写一行。
DROP TRIGGER IF EXISTS data_version_albums_ins;
DROP TRIGGER IF EXISTS data_version_albums_upd;
DROP TRIGGER IF EXISTS data_version_albums_del;
DROP TRIGGER IF EXISTS data_version_album_assets_ins;
DROP TRIGGER IF EXISTS data_version_album_assets_upd;
DROP TRIGGER IF EXISTS data_version_album_assets_del;

-- 收集统计信息（D1 推荐改完表结构后运行；之后每天的 Cron 再跑一次，见 src/index.ts 的 optimizeDb）。
PRAGMA optimize;
