-- 文件夹树。根目录的 parent_id 为 NULL。
CREATE TABLE folders (
  id          TEXT PRIMARY KEY,
  parent_id   TEXT REFERENCES folders(id) ON DELETE RESTRICT,
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
-- SQLite 的 UNIQUE 不把 NULL 视为相等，所以根目录单独用表达式索引。
CREATE UNIQUE INDEX folders_parent_name ON folders(COALESCE(parent_id, ''), name);

-- 一个“条目”：照片 / 视频 / Live Photo（可能带 RAW 附件）。
CREATE TABLE assets (
  id                  TEXT PRIMARY KEY,           -- ULID
  kind                TEXT NOT NULL CHECK (kind IN ('photo','video','live')),
  status              TEXT NOT NULL DEFAULT 'uploading'
                        CHECK (status IN ('uploading','pending','processing','ready','failed')),
  taken_at            INTEGER,                    -- UTC 毫秒
  tz_offset_min       INTEGER,                    -- 拍摄地时区偏移
  local_day           TEXT,                       -- YYYY-MM-DD（拍摄地本地日期，用于分组）
  local_month         TEXT,                       -- YYYY-MM
  width               INTEGER,
  height              INTEGER,
  rotation            INTEGER NOT NULL DEFAULT 0 CHECK (rotation IN (0,90,180,270)),
  duration_ms         INTEGER,
  lat                 REAL,
  lon                 REAL,
  camera              TEXT,
  lens                TEXT,
  description         TEXT,
  favorite            INTEGER NOT NULL DEFAULT 0,
  folder_id           TEXT REFERENCES folders(id) ON DELETE SET NULL,
  content_identifier  TEXT,                       -- Apple Live Photo 配对 ID
  derived_rev         INTEGER NOT NULL DEFAULT 0, -- 派生文件版本（旋转后 +1）
  client_mtime        INTEGER,                    -- 没有 EXIF 时间时的兜底
  deleted_at          INTEGER,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
CREATE INDEX assets_timeline ON assets(deleted_at, taken_at DESC, id DESC) WHERE status = 'ready';
CREATE INDEX assets_month    ON assets(local_month) WHERE deleted_at IS NULL AND status = 'ready';
CREATE INDEX assets_folder   ON assets(folder_id, taken_at DESC);
CREATE INDEX assets_favorite ON assets(favorite, taken_at DESC) WHERE favorite = 1;
CREATE INDEX assets_geo      ON assets(lat, lon) WHERE lat IS NOT NULL;
CREATE INDEX assets_cid      ON assets(content_identifier) WHERE content_identifier IS NOT NULL;
CREATE INDEX assets_deleted  ON assets(deleted_at) WHERE deleted_at IS NOT NULL;

-- 条目下的所有文件（原件和派生文件）。
CREATE TABLE asset_files (
  id             TEXT PRIMARY KEY,
  asset_id       TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  role           TEXT NOT NULL CHECK (role IN
                   ('original','raw','live_video','thumb','preview','poster','video_preview')),
  r2_key         TEXT NOT NULL UNIQUE,
  mime           TEXT NOT NULL,
  size           INTEGER NOT NULL,
  sha256         TEXT,
  original_name  TEXT,
  created_at     INTEGER NOT NULL
);
CREATE INDEX asset_files_asset ON asset_files(asset_id, role);
-- 按内容去重：同一份原始字节只存一次。
CREATE UNIQUE INDEX asset_files_dedupe ON asset_files(sha256)
  WHERE role IN ('original','raw','live_video') AND sha256 IS NOT NULL;

-- 进行中的分块上传。
CREATE TABLE uploads (
  id           TEXT PRIMARY KEY,
  asset_id     TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  file_id      TEXT NOT NULL,
  role         TEXT NOT NULL,
  r2_key       TEXT NOT NULL,
  r2_upload_id TEXT NOT NULL,
  mime         TEXT NOT NULL,
  size         INTEGER NOT NULL,
  sha256       TEXT NOT NULL,
  original_name TEXT,
  created_at   INTEGER NOT NULL
);

CREATE TABLE albums (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  cover_asset_id  TEXT REFERENCES assets(id) ON DELETE SET NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE TABLE album_assets (
  album_id  TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  asset_id  TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  added_at  INTEGER NOT NULL,
  PRIMARY KEY (album_id, asset_id)
);
CREATE INDEX album_assets_asset ON album_assets(asset_id);

-- 后台任务的真实状态。队列消息只是“去看一下这个任务”的通知。
CREATE TABLE jobs (
  id          TEXT PRIMARY KEY,
  asset_id    TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,                     -- process | rotate | ...（第二版扩展）
  status      TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','running','done','failed')),
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  started_at  INTEGER,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX jobs_status ON jobs(status, updated_at);
CREATE INDEX jobs_asset  ON jobs(asset_id, kind);

-- 全文搜索：文件名 + 描述。
CREATE VIRTUAL TABLE assets_fts USING fts5(asset_id UNINDEXED, names, description, tokenize = 'trigram');
