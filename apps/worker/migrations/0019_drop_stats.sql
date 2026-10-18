-- 删掉 0018 的 PRAGMA optimize 收集的统计信息（sqlite_stat1），回到没有统计信息时的执行计划。
--
-- assets.deleted_at 绝大多数是 NULL，回收站里的每条各有一个时间戳；ANALYZE 按“行数 / 不同值的个数”估算，
-- 得出 deleted_at = ? 平均只有约 34 行，于是规划器认为 assets_timeline（deleted_at, ...）比按文件夹的索引更窄，
-- 打开文件夹列表时每个子文件夹都顺着它扫一遍整个资料库（15 万张、314 个文件夹时读 4800 万行、26 秒，接口 500、D1 过载）。
-- 常用的列表查询本来就不依赖统计信息（0018 的部分索引、INDEXED BY、CROSS JOIN，test/query-plans.test.ts 两种情况都测），
-- 所以不再收集统计信息：不运行 ANALYZE / PRAGMA optimize。
--
-- ANALYZE sqlite_schema 只在 sqlite_stat1 不存在时建一张空表（不扫任何数据表），保证下面的 DELETE 在全新部署上也能执行。
ANALYZE sqlite_schema;
DELETE FROM sqlite_stat1;
