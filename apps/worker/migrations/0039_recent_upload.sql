-- “最近上传”（src/library.ts 的 GET /recent/assets）：按上传时间（created_at）倒序浏览整个资料库。
-- 没有统计信息时，SQLite 遇到 ORDER BY created_at DESC, id DESC 会选 assets_timeline 再排序：读完整个资料库还要额外排序。
-- 这个部分索引的 WHERE 和排序键与查询完全一致（deleted_at / status / archived 都在部分索引条件里），
-- 查询写明 INDEXED BY 后直接按序读，不扫 assets_timeline、不临时排序。
CREATE INDEX assets_recent_upload ON assets(created_at DESC, id DESC)
  WHERE deleted_at IS NULL AND status = 'ready' AND archived = 0;
