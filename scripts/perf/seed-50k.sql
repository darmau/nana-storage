-- 5 万张合成条目，分布在 2021-01 到 2025-12。时间由 i 确定性地算出（避免 random() 被多次求值）。
DELETE FROM assets WHERE id LIKE 'SYN%';
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 50000),
syn AS (SELECT i, 1609459200000 + ((i * 2654435761) % 157766400) * 1000 AS t FROM n)
INSERT INTO assets (id, kind, status, taken_at, tz_offset_min, local_day, local_month, width, height, duration_ms, favorite, derived_rev, created_at, updated_at)
SELECT
  printf('SYN%023d', i),
  CASE WHEN i % 23 = 0 THEN 'video' WHEN i % 7 = 0 THEN 'live' ELSE 'photo' END,
  'ready', t, 480,
  strftime('%Y-%m-%d', t / 1000 + 8 * 3600, 'unixepoch'),
  strftime('%Y-%m', t / 1000 + 8 * 3600, 'unixepoch'),
  CASE WHEN i % 3 = 0 THEN 3024 WHEN i % 11 = 0 THEN 8000 ELSE 4032 END,
  CASE WHEN i % 3 = 0 THEN 4032 ELSE 3024 END,
  CASE WHEN i % 23 = 0 THEN (i % 300) * 1000 ELSE NULL END,
  CASE WHEN i % 31 = 0 THEN 1 ELSE 0 END,
  0, 0, 0
FROM syn;
