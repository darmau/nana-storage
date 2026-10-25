-- 去掉“相似照片”（查看器信息面板的相似照片、整理 › 相似照片）。asset_fp 的向量只留给重复照片复核和主题，
-- 不再写 Vectorize 的 nana-embed 索引，所以 indexed 也一起去掉。
-- 删表、删列：部署窗口里旧代码写指纹会失败（任务按 MAX_JOB_ATTEMPTS 重试），见 CHANGELOG。
DROP TABLE IF EXISTS similar_pairs;
DROP TABLE IF EXISTS similar_state;
DROP TABLE IF EXISTS similar_snoozes;

DROP INDEX IF EXISTS asset_fp_similar_pending;
DROP INDEX IF EXISTS asset_fp_similar_queue;
DROP INDEX IF EXISTS asset_fp_similar_parked;
DROP INDEX IF EXISTS asset_fp_unindexed;
ALTER TABLE asset_fp DROP COLUMN similar_at;
ALTER TABLE asset_fp DROP COLUMN similar_n;
ALTER TABLE asset_fp DROP COLUMN indexed;
