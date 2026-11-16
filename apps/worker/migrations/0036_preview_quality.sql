-- 整理 › 细节不足（src/quality.ts）：按预览 WebP 体积从小到大找出“分辨率大但实际细节少”的照片。
-- 预览长边统一 3840（点过“加载原图”换成全尺寸预览的除外），同一个长边下 WebP 越小说明细节越少
-- （被强行放大的、虚焦、过曝的照片压出来的 WebP 明显更小）。列表顺着这个索引从小到大读，到 LIMIT 就停。
-- 预览大小本来就在 asset_files（role = 'preview'，process.ts 写入），只加索引、不改表、不读 R2。
CREATE INDEX asset_files_preview_small ON asset_files(size ASC, id)
  WHERE role = 'preview';
