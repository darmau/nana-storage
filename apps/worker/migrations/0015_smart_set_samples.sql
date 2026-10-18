-- 主题改成“样本维护”：分类器只给建议，照片放进哪个相册由用户手动挑。只加列，兼容线上旧代码。
--   smart_set_examples.score         上次训练时这张样本的分数：样本够多时是交叉验证里没见过它的模型打的分，
--                                    否则是整个模型的分数；手动加入时先用当时的模型打一次。用来标出“标签和分类器矛盾”的样本。
--   smart_set_examples.review_score  标记时它正好在建议里的话，记下当时的建议分数（之后不变），用来算“实测准确率”。
--   smart_sets.metrics               上次训练的质量指标（JSON，见 src/similar.ts 的 SmartSetMetrics）。
-- 不再有“只收录、不用于训练”：train 列保留（旧代码还在读），新写入的都是 1。
ALTER TABLE smart_set_examples ADD COLUMN score REAL;
ALTER TABLE smart_set_examples ADD COLUMN review_score REAL;
ALTER TABLE smart_sets ADD COLUMN metrics TEXT;

-- 旧的主题按新的交互全部重新创建（主人的决定），这里清空。照片、相册不受影响；空表对旧代码也没有问题。
DELETE FROM smart_set_suggestions;
DELETE FROM smart_set_examples;
DELETE FROM smart_sets;
