-- 原图压缩：只带 MPF 预览图（尼康等相机的 Large Thumbnail）的 JPEG 现在可以压缩（apps/processor 的 onlyPreviewsAfter）。
-- 之前按“带附图”（extra-data）跳过的，以及 0028 之前跳过、没记原因的，重新变回候选（compress_state = NULL），
-- 用户选中后再判断一次；真正带附图的照样跳过并记下原因，所以每张最多多处理一次。只改数据，兼容线上旧代码。
UPDATE asset_files SET compress_state = NULL, compress_skip = NULL
WHERE compress_state = 2 AND (compress_skip IS NULL OR compress_skip = 'extra-data');
