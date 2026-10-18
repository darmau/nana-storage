-- 主题的范围：只在这些文件夹（含子文件夹）里计算建议、整理结果。JSON 数组（文件夹 id），NULL 表示整个资料库。
-- 只加列，兼容线上旧代码（旧代码不读这一列，照常扫描整个资料库）。
ALTER TABLE smart_sets ADD COLUMN folders TEXT;
