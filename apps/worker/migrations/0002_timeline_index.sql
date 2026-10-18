-- 按月取时间线：一次索引扫描就按拍摄时间排好序。
DROP INDEX IF EXISTS assets_month;
CREATE INDEX assets_month ON assets(local_month, taken_at DESC, id DESC)
  WHERE deleted_at IS NULL AND status = 'ready';
