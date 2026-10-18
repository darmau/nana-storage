-- 以前“这不是 X”把移出来的脸记成手动指定、不属于任何人物（assigned = 2、state = 2），之后再也不识别。
-- 现在改成移出来后重新识别（face_rejects 保证不会归回 X），这里把以前移出来的脸改回待识别，由每小时的 Cron 分批处理（FACE_CRON_BATCH）。
-- 只改数据，兼容线上旧代码（旧代码的 recognizeFace 同样遵守 face_rejects）。
UPDATE faces SET assigned = 0, state = 0
WHERE person_id IS NULL AND assigned = 2 AND masked = 0 AND score >= 0.7 AND px >= 36
  AND EXISTS (SELECT 1 FROM face_rejects r WHERE r.face_id = faces.id);
