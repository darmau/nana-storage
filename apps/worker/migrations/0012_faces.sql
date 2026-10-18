-- 人物（人脸识别，见 src/people.ts）。只加表，兼容线上旧代码。
--
-- people：一个人物就是一组同一个人的脸。name 为 NULL 表示还没命名（界面上显示为“添加名字”）。
--   cover_face_id 是用户选的封面，NULL 时自动挑一张。hidden：隐藏（路人）；favorite：个人收藏，排在最前面。
CREATE TABLE people (
  id             TEXT PRIMARY KEY,
  name           TEXT,
  cover_face_id  TEXT,
  hidden         INTEGER NOT NULL DEFAULT 0,
  favorite       INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX people_name ON people(name) WHERE name IS NOT NULL;

-- 每张照片的人脸扫描记录（没有脸也有一行，表示已经扫描过）。
--   model：人脸模型版本（FACE_MODEL_VER），换模型时据此补算。
--   sprite_key：所有头像横向拼成的一张 WebP（R2，第 idx 张脸在第 idx 格），没有脸时为 NULL。永久删除时一起删。
CREATE TABLE face_scans (
  asset_id    TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
  model       TEXT NOT NULL,
  count       INTEGER NOT NULL,
  sprite_key  TEXT,
  updated_at  INTEGER NOT NULL
);

-- 人脸。x / y / w / h 是归一化到 0–1 的人脸框，按用户旋转之前的方向（和指纹一样，旋转不重算）。
--   px：人脸框短边在分析图（长边 1920）里的像素数；score：检测置信度；sharpness：清晰度。
--   embedding：ArcFace 向量，512 个 int8。Vectorize（FACE_INDEX）里的向量只是它的副本，indexed = 0 表示还没写进去。
--   assigned：0 没有人工确认 / 1 自动归入 / 2 用户手动指定（person_id 为 NULL 时表示用户把它移出了人物，不再自动归入）。
--   state：识别进度。0 待识别 / 1 推迟（附近的脸还不够多，等 Cron 再看一次）/ 2 完成 / 3 不参与（太小、太模糊、置信度低）。
CREATE TABLE faces (
  id          TEXT PRIMARY KEY,
  asset_id    TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  idx         INTEGER NOT NULL,
  x           REAL NOT NULL,
  y           REAL NOT NULL,
  w           REAL NOT NULL,
  h           REAL NOT NULL,
  px          INTEGER NOT NULL,
  score       REAL NOT NULL,
  sharpness   REAL NOT NULL,
  embedding   BLOB NOT NULL,
  person_id   TEXT REFERENCES people(id) ON DELETE SET NULL,
  assigned    INTEGER NOT NULL DEFAULT 0,
  state       INTEGER NOT NULL DEFAULT 0,
  indexed     INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX faces_asset ON faces(asset_id);
CREATE INDEX faces_person ON faces(person_id, asset_id);
CREATE INDEX faces_pending ON faces(state, created_at) WHERE state IN (0, 1);
CREATE INDEX faces_unindexed ON faces(created_at) WHERE indexed = 0;

-- “这不是 X”：用户否认过的（人脸，人物）对，自动归入和“确认更多照片”都不会再把这张脸推给这个人。
CREATE TABLE face_rejects (
  face_id    TEXT NOT NULL REFERENCES faces(id) ON DELETE CASCADE,
  person_id  TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  PRIMARY KEY (face_id, person_id)
);
CREATE INDEX face_rejects_person ON face_rejects(person_id);
