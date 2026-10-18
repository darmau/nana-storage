-- 查看器“编辑”里的打码（毛玻璃，只影响缩略图和预览，原件不动）：涂抹的笔画（shared 的 encodeMask），NULL 表示没有打码。
-- faces.masked：这张脸被打码盖住了（shared 的 maskCoverage），不参与人物识别（state = 3、不属于任何人物、不在 Vectorize 里），
-- 信息面板也不列出；去掉打码后改回 0、重新识别。
-- 只加列，兼容线上旧代码（旧代码不读这两列，照片显示为没有打码的样子）。
ALTER TABLE assets ADD COLUMN mask TEXT;
ALTER TABLE faces ADD COLUMN masked INTEGER NOT NULL DEFAULT 0;
