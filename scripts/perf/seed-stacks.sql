-- 相似照片折叠的界面测试数据（scripts/perf/stacks-ui.mjs），在 seed-50k.sql 之后运行：
--   npx wrangler d1 execute nana-db --local --file ../../scripts/perf/seed-stacks.sql
-- 把 60 张合成照片挪到最新的一天（2026-11-01，时间线最顶上），给它们两组指纹：
-- 前 40 张是同一系列（phash 距离 ≤ 2、余弦 ≈ 0.99），后 20 张是另一系列（余弦 ≈ 0.7，分开成组）。
DELETE FROM asset_fp WHERE asset_id LIKE 'SYN%';
DELETE FROM stack_dismissed WHERE asset_id LIKE 'SYN%';
DELETE FROM stacks_state;

WITH pick AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS rn
  FROM assets WHERE id LIKE 'SYN%' AND kind = 'photo' LIMIT 60
)
UPDATE assets SET
  taken_at = 1793491200000 + (rn - 1) * 60000,
  tz_offset_min = 480,
  local_day = '2026-11-01',
  local_month = '2026-11',
  stack_id = NULL
FROM pick WHERE assets.id = pick.id;

WITH RECURSIVE
full64(x) AS (SELECT X'64' UNION ALL SELECT x || X'64' FROM full64 WHERE length(x) < 512),
pick AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY taken_at, id) AS rn
  FROM assets WHERE local_day = '2026-11-01' AND id LIKE 'SYN%'
)
INSERT OR REPLACE INTO asset_fp (asset_id, model, phash, b0, b1, b2, b3, b4, embedding, updated_at)
SELECT p.id, 'clip-b32-q8',
  CASE WHEN p.rn <= 40 THEN '000000000000000' || substr('0123', (p.rn % 4) + 1, 1) ELSE 'ffffffffffffffff' END,
  CASE WHEN p.rn <= 40 THEN 0 ELSE 8191 END,
  CASE WHEN p.rn <= 40 THEN 0 ELSE 8191 END,
  CASE WHEN p.rn <= 40 THEN 0 ELSE 8191 END,
  CASE WHEN p.rn <= 40 THEN 0 ELSE 8191 END,
  CASE WHEN p.rn <= 40 THEN p.rn % 4 ELSE 4095 END,
  CASE WHEN p.rn <= 40
    THEN CAST(substr(X'50505050505050505050', 1, p.rn % 10) || substr((SELECT x FROM full64 ORDER BY length(x) DESC LIMIT 1), 1, 512 - (p.rn % 10)) AS BLOB)
    ELSE CAST(substr((SELECT x FROM full64 ORDER BY length(x) DESC LIMIT 1), 1, 256) || zeroblob(256) AS BLOB) END,
  0
FROM pick p;
