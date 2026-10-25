-- 相似照片：查近邻时没带 returnValues，Vectorize 返回的是量化后的近似分数（CLIP 向量上整体压低很多，
-- 照片和自己只有约 0.77），够不到 SIMILAR_GROUP_MIN_COSINE，查过的照片几乎都没找到近邻。
-- 新代码改成精确分数后，所有照片重新排队查一次（scanSimilar：每小时 Cron + 打开“相似照片”页时分批）。
-- 已经有的照片对保留（INSERT OR IGNORE，重新计数时一起算）。只改数据，兼容线上旧代码。
UPDATE asset_fp SET similar_at = NULL WHERE similar_at IS NOT NULL;
