-- 原图压缩（整理 › 原图压缩，src/compress.ts）。只加列和索引，兼容线上旧代码。
--
-- asset_files 上的三列只用在原件（role = 'original'）上：
--   compress_state  NULL 没处理过；1 已压缩（r2_key / size / sha256 / crc32 已经换成压缩后的）；
--                   2 不压缩（不值得、带附图、不是普通 JPEG……），以后不再列出
--   source_sha256   压缩前的 sha256：重新上传同一个原始文件时仍然算重复（uploads.ts 的 existingAsset）
--   source_size     压缩前的字节数（显示省了多少）
ALTER TABLE asset_files ADD COLUMN compress_state INTEGER;
ALTER TABLE asset_files ADD COLUMN source_sha256 TEXT;
ALTER TABLE asset_files ADD COLUMN source_size INTEGER;

-- 候选列表（GET /api/compress/candidates）：没处理过的 JPEG 原件按大小倒序，指定了下限时读到下限就停。
CREATE INDEX asset_files_compress ON asset_files(size DESC, id)
  WHERE role = 'original' AND mime = 'image/jpeg' AND compress_state IS NULL;
-- 已压缩的张数和省下的空间（GET /api/compress/summary）：只扫处理过的行。
CREATE INDEX asset_files_compressed ON asset_files(compress_state) WHERE compress_state IS NOT NULL;
-- 去重时按压缩前的 sha256 查。
CREATE INDEX asset_files_source_sha ON asset_files(source_sha256) WHERE source_sha256 IS NOT NULL;
