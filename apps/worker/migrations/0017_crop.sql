-- 查看器“编辑”里的裁切（只影响缩略图和预览，原件不动）。0–1 的比例，相对于用户旋转之后的整张图；
-- 四列都为 NULL 表示没有裁切。width / height 仍然是裁切之前的尺寸，列表接口返回裁切后的尺寸（timeline.ts 的 ITEM_COLUMNS）。
-- 只加列，兼容线上旧代码（旧代码不读这几列，照片显示为没有裁切的样子）。
ALTER TABLE assets ADD COLUMN crop_x REAL;
ALTER TABLE assets ADD COLUMN crop_y REAL;
ALTER TABLE assets ADD COLUMN crop_w REAL;
ALTER TABLE assets ADD COLUMN crop_h REAL;
