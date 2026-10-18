-- 主题改成分类器（src/smartset-model.ts）。只加列：旧代码继续读写 centroid，新代码不再使用它。
--   weights：513 个 float32（512 维权重 + 偏置），用户点“更新建议”时重新训练。
--   trained_at / labels_changed_at：后者更新（或者从没训练过）时，界面提示“更新建议”。
--   refreshing_until：更新建议的锁，同一个主题同时只跑一次，过期自动失效。
--   smart_set_examples.train：0 表示只收录、不用于训练（分类器认不出来的照片，比如竖图边缘的内容）。
ALTER TABLE smart_sets ADD COLUMN weights BLOB;
ALTER TABLE smart_sets ADD COLUMN trained_at INTEGER;
ALTER TABLE smart_sets ADD COLUMN labels_changed_at INTEGER;
ALTER TABLE smart_sets ADD COLUMN refreshing_until INTEGER;
ALTER TABLE smart_set_examples ADD COLUMN train INTEGER NOT NULL DEFAULT 1;
