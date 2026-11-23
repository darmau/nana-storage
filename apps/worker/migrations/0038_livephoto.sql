-- 短视频转 Live Photo（src/livephoto.ts）：转换时用户选的那一帧的时间（毫秒）。
-- 一个视频条目同时最多有一个转换（asset_id 主键），重试时读同一份；成功后随处理一起删掉（handler 的收尾 batch）。
CREATE TABLE livephoto_specs (
  asset_id   TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
  at_ms      INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
