-- 统一隐藏/恢复状态体系：记录隐藏来源（system < moderator < admin），
-- 恢复动作要求操作者角色等级不低于隐藏来源等级，管理员隐藏只能由管理员恢复。
CREATE TYPE hide_source AS ENUM ('system', 'moderator', 'admin');

ALTER TABLE map_features
  ADD COLUMN hidden_at timestamptz,
  ADD COLUMN hidden_by uuid REFERENCES users(id),
  ADD COLUMN hidden_source hide_source,
  ADD COLUMN hidden_reason_code text;

ALTER TABLE comments
  ADD COLUMN hidden_at timestamptz,
  ADD COLUMN hidden_by uuid REFERENCES users(id),
  ADD COLUMN hidden_source hide_source,
  ADD COLUMN hidden_reason_code text;

-- 存量隐藏数据无法确定来源，按最严格级别处理：仅管理员可恢复。
UPDATE map_features
SET hidden_source = 'admin', hidden_at = COALESCE(hidden_at, updated_at)
WHERE status = 'hidden' AND hidden_source IS NULL;

UPDATE comments
SET hidden_source = 'admin', hidden_at = COALESCE(hidden_at, updated_at)
WHERE status = 'hidden' AND hidden_source IS NULL;

-- 不变式：处于 hidden 状态的内容必须带有隐藏来源。
ALTER TABLE map_features
  ADD CONSTRAINT map_features_hidden_source_chk
  CHECK (status <> 'hidden' OR hidden_source IS NOT NULL);

ALTER TABLE comments
  ADD CONSTRAINT comments_hidden_source_chk
  CHECK (status <> 'hidden' OR hidden_source IS NOT NULL);
