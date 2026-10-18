-- 连拍分组：Apple 的 BurstUUID，或者按拍摄间隔推断出来的组（以 "t:" 开头）。
ALTER TABLE assets ADD COLUMN burst_id TEXT;
CREATE INDEX assets_burst ON assets(burst_id) WHERE burst_id IS NOT NULL;
-- 照片类型的位标志（见 packages/shared 的 TRAIT）：1 全景，2 长曝光，4 人像，8 RAW。
ALTER TABLE assets ADD COLUMN traits INTEGER NOT NULL DEFAULT 0;
