-- PIN 锁（单行）。没有这一行就是没有设置 PIN。
-- cookie_key 每次设置 / 修改 PIN 时重新生成，旧的解锁 cookie 随之失效。
CREATE TABLE pin_lock (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  pin_hash      TEXT NOT NULL,
  salt          TEXT NOT NULL,
  cookie_key    TEXT NOT NULL,
  failures      INTEGER NOT NULL DEFAULT 0,
  locked_until  INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL
);
