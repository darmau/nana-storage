-- 手动编辑过的字段不会被重新处理覆盖（位标志：1 时间，2 位置，4 描述）。
ALTER TABLE assets ADD COLUMN meta_locked INTEGER NOT NULL DEFAULT 0;

-- 搜索：按相机筛选
CREATE INDEX assets_camera ON assets(camera) WHERE camera IS NOT NULL;
