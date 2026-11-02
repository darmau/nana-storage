-- 文件夹的自定义封面（src/library.ts）。只加列，兼容线上旧代码。
--
-- 设置了封面、而且那张照片可见（处理好、不在回收站、没有归档）时，文件夹卡片只显示这一张；
-- 否则照旧用整棵子树里最近拍的几张拼图。可以是任意一张照片，不要求在这个文件夹里。
-- 照片被永久删除时外键置空；cache_versions 的 folders 触发器会让 library 版本加一。
ALTER TABLE folders ADD COLUMN cover_asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL;
