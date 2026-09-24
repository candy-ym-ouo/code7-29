-- 统一隐藏状态体系：记录隐藏来源、操作者、原因和时间，
-- 使角色权限、版本发布、恢复和审计共用同一套可判定的状态。
--
-- hidden_by_level 取值：
--   system    = 系统自动动作（如举报达到阈值），审核员及以上可逆转
--   moderator = 普通审核员手动隐藏，审核员及以上可逆转
--   admin     = 管理员隐藏，只有管理员可逆转
--
-- 普通审核员不能通过批准修订、举报处理等任何路径逆转 admin 级隐藏。

ALTER TABLE map_features
  ADD COLUMN hidden_by uuid REFERENCES users(id),
  ADD COLUMN hidden_by_level text,
  ADD COLUMN hidden_reason_code text,
  ADD COLUMN hidden_at timestamptz;

ALTER TABLE comments
  ADD COLUMN hidden_by uuid REFERENCES users(id),
  ADD COLUMN hidden_by_level text,
  ADD COLUMN hidden_reason_code text,
  ADD COLUMN hidden_at timestamptz;

-- 系统自动隐藏没有人工操作者；统一审计台账允许该列为空。
ALTER TABLE moderation_actions
  ALTER COLUMN moderator_id DROP NOT NULL;

-- 迁移前已存在的隐藏记录来源不可考，按最严格的 admin 级别兜底，
-- 默认 fail-closed：必须由管理员显式恢复，杜绝历史数据被审核员直接放开。
-- 遗留记录没有操作者，用 LEGACY_HIDDEN 原因码显式标记这一例外。
UPDATE map_features
SET hidden_by_level = 'admin',
    hidden_reason_code = 'LEGACY_HIDDEN',
    hidden_at = COALESCE(updated_at, now())
WHERE status = 'hidden' AND hidden_by_level IS NULL;

UPDATE comments
SET hidden_by_level = 'admin',
    hidden_reason_code = 'LEGACY_HIDDEN',
    hidden_at = COALESCE(updated_at, now())
WHERE status = 'hidden' AND hidden_by_level IS NULL;

ALTER TABLE map_features
  ADD CONSTRAINT map_features_hidden_state_chk CHECK (
    (status = 'hidden') = (hidden_by_level IS NOT NULL)
  ),
  ADD CONSTRAINT map_features_hidden_at_chk CHECK (
    status <> 'hidden' OR hidden_at IS NOT NULL
  ),
  ADD CONSTRAINT map_features_hidden_level_chk CHECK (
    hidden_by_level IS NULL OR hidden_by_level IN ('system', 'moderator', 'admin')
  ),
  ADD CONSTRAINT map_features_hidden_actor_chk CHECK (
    hidden_by_level IS NULL
    OR hidden_by IS NOT NULL
    OR hidden_by_level = 'system'
    OR hidden_reason_code = 'LEGACY_HIDDEN'
  );

ALTER TABLE comments
  ADD CONSTRAINT comments_hidden_state_chk CHECK (
    (status = 'hidden') = (hidden_by_level IS NOT NULL)
  ),
  ADD CONSTRAINT comments_hidden_at_chk CHECK (
    status <> 'hidden' OR hidden_at IS NOT NULL
  ),
  ADD CONSTRAINT comments_hidden_level_chk CHECK (
    hidden_by_level IS NULL OR hidden_by_level IN ('system', 'moderator', 'admin')
  ),
  ADD CONSTRAINT comments_hidden_actor_chk CHECK (
    hidden_by_level IS NULL
    OR hidden_by IS NOT NULL
    OR hidden_by_level = 'system'
    OR hidden_reason_code = 'LEGACY_HIDDEN'
  );
