-- 预览图生成时的长边上限。NULL 表示 3840 之前的旧预览（2048），设置页可以分批升级。
ALTER TABLE assets ADD COLUMN preview_edge INTEGER;
