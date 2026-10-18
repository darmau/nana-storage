-- “加载原图”要的预览长边（按原图尺寸算，见 shared 的 fullPreviewEdge）。NULL 表示默认的 PREVIEW_LONG_EDGE。
-- 旋转、重新处理时都按它生成预览，所以换成全尺寸的预览之后不会退回普通预览。
ALTER TABLE assets ADD COLUMN preview_target INTEGER;
