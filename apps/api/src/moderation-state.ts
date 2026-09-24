import type { PoolClient } from "pg";
import type { UserRole } from "@map/shared/contracts";
import { AppError, conflict, forbidden, notFound } from "./errors";
import { recordAudit } from "./audit";

/**
 * 统一的内容状态体系。
 *
 * 所有“公开 <-> 隐藏 <-> 删除”的状态变更都必须经过本模块，禁止在路由或
 * worker 中直接写 `status`。这样角色判定、隐藏来源、恢复权限和审计记录
 * 共享同一份事实来源，封堵一切旁路：
 *
 *  - 审核员不能借批准修订或处理举报逆转管理员的隐藏决定；
 *  - hidden 状态永远携带来源级别、操作者、原因和时间；
 *  - 每次转换同时写入 audit_logs 与 moderation_actions。
 */

export type HideLevel = "system" | "moderator" | "admin";
export type ModerationTargetType = "feature" | "comment";

const HIDE_LEVEL_RANK: Record<HideLevel, number> = {
  system: 0,
  moderator: 1,
  admin: 2
};

const ROLE_LEVEL: Record<UserRole, number> = {
  contributor: 0,
  moderator: 1,
  admin: 2
};

/** 操作者的角色级别是否足以逆转某一来源级别的隐藏。 */
export function canReverseHide(role: UserRole, hiddenByLevel: HideLevel | null | undefined): boolean {
  if (!hiddenByLevel) return true;
  // 任何强制隐藏都至少需要审核员身份，贡献者无权逆转（含系统阈值隐藏）。
  if (ROLE_LEVEL[role] < HIDE_LEVEL_RANK.moderator) return false;
  return ROLE_LEVEL[role] >= HIDE_LEVEL_RANK[hiddenByLevel];
}

/** 操作者角色对应的隐藏来源级别。 */
export function hideLevelForRole(role: UserRole): HideLevel {
  if (role === "admin") return "admin";
  return "moderator";
}

export type HiddenStateRow = {
  status: string;
  deleted_at: Date | null;
  hidden_by: string | null;
  hidden_by_level: HideLevel | null;
  hidden_reason_code: string | null;
};

export type HideInput = {
  /** 触发隐藏的操作者；系统自动隐藏传 null。 */
  actorId: string | null;
  actorRole: UserRole | "system";
  reasonCode: string;
  notes?: string | null | undefined;
  /** 举报阈值自动隐藏时关联的打开举报数等。 */
  metadata?: Record<string, unknown> | undefined;
};

type HideResult = {
  id: string;
  ownerId: string;
  previousStatus: string;
  previousHiddenByLevel: HideLevel | null;
  hiddenByLevel: HideLevel;
  /** false 表示目标未发布且没有更高权限的现存隐藏，调用方应据此拒绝。 */
  changed: boolean;
};

const TABLES: Record<ModerationTargetType, { table: string; ownerColumn: string }> = {
  feature: { table: "map_features", ownerColumn: "owner_id" },
  comment: { table: "comments", ownerColumn: "author_id" }
};

async function lockTarget(
  client: PoolClient,
  targetType: ModerationTargetType,
  targetId: string
): Promise<HiddenStateRow & { owner_id: string }> {
  const { table, ownerColumn } = TABLES[targetType];
  const result = await client.query<HiddenStateRow & { owner_id: string }>(
    `SELECT id, status, deleted_at, hidden_by, hidden_by_level, hidden_reason_code, ${ownerColumn} AS owner_id
     FROM ${table} WHERE id = $1 FOR UPDATE`,
    [targetId]
  );
  const row = result.rows[0];
  if (!row || row.deleted_at) throw notFound(targetType === "feature" ? "Feature not found" : "Comment not found");
  return row;
}

async function writeModerationLedger(
  client: PoolClient,
  input: {
    targetType: ModerationTargetType;
    targetId: string;
    actorId: string | null;
    action: string;
    reasonCode?: string | null | undefined;
    notes?: string | null | undefined;
    beforeState: Record<string, unknown>;
    afterState: Record<string, unknown>;
  }
) {
  await client.query(
    `INSERT INTO moderation_actions(
       target_type, target_id, moderator_id, action, reason_code, notes, before_state, after_state
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)`,
    [
      input.targetType,
      input.targetId,
      input.actorId,
      input.action,
      input.reasonCode ?? null,
      input.notes ?? null,
      JSON.stringify(input.beforeState),
      JSON.stringify(input.afterState)
    ]
  );
}

function auditActionName(targetType: ModerationTargetType, action: string) {
  return `${targetType}.${action}`;
}

/**
 * 统一隐藏入口。
 *
 * - 只有当前已发布的内容可隐藏；
 * - 已隐藏内容只允许更高级别操作者“升级隐藏”（例如管理员覆盖审核员的隐藏），
 *   同级重复隐藏或系统对人工隐藏的覆盖一律拒绝，避免弱化隐藏来源；
 * - 系统自动隐藏（举报阈值）不会覆盖任何人工隐藏。
 */
export async function hideContent(
  client: PoolClient,
  targetType: ModerationTargetType,
  targetId: string,
  input: HideInput
): Promise<HideResult> {
  const row = await lockTarget(client, targetType, targetId);
  const requestedLevel: HideLevel = input.actorRole === "system" ? "system" : hideLevelForRole(input.actorRole);
  const result: HideResult = {
    id: targetId,
    ownerId: row.owner_id,
    previousStatus: row.status,
    previousHiddenByLevel: row.hidden_by_level,
    hiddenByLevel: requestedLevel,
    changed: false
  };

  if (row.status !== "published" && row.status !== "hidden") {
    throw conflict("Only published content can be hidden");
  }
  if (row.status === "hidden") {
    if (HIDE_LEVEL_RANK[requestedLevel] <= HIDE_LEVEL_RANK[row.hidden_by_level!]) {
      throw conflict("Content is already hidden at the same or higher protection level");
    }
    if (input.actorRole !== "admin") {
      // 只有管理员能升级隐藏；到达这里理论上只能是 admin 覆盖 moderator。
      throw forbidden("Only an administrator can override an existing hide decision");
    }
  }

  const { table } = TABLES[targetType];
  await client.query(
    `UPDATE ${table}
     SET status = 'hidden', hidden_by = $2, hidden_by_level = $3,
         hidden_reason_code = $4, hidden_at = now(), updated_at = now()
     WHERE id = $1`,
    [targetId, input.actorId, requestedLevel, input.reasonCode]
  );

  await recordAudit(client, {
    actorId: input.actorId,
    action: auditActionName(targetType, "hidden"),
    resourceType: targetType,
    resourceId: targetId,
    metadata: {
      reasonCode: input.reasonCode,
      notes: input.notes ?? null,
      level: requestedLevel,
      previousStatus: row.status,
      previousHiddenByLevel: row.hidden_by_level,
      ...input.metadata
    }
  });
  await writeModerationLedger(client, {
    targetType,
    targetId,
    actorId: input.actorId,
    action: "hidden",
    reasonCode: input.reasonCode,
    notes: input.notes,
    beforeState: { status: row.status, hiddenByLevel: row.hidden_by_level },
    afterState: { status: "hidden", hiddenByLevel: requestedLevel, reasonCode: input.reasonCode }
  });

  result.changed = true;
  return result;
}

export type RestoreInput = {
  actorId: string;
  actorRole: UserRole;
  /** 管理员恢复时可附带备注；举报处理恢复由调用方提供原因码。 */
  reasonCode?: string | null | undefined;
  notes?: string | null | undefined;
  metadata?: Record<string, unknown> | undefined;
};

type RestoreResult = {
  id: string;
  ownerId: string;
  hiddenByLevel: HideLevel;
  hiddenReasonCode: string | null;
};

/**
 * 统一恢复入口。恢复权限由隐藏来源级别决定：
 * 审核员只能逆转 system/moderator 级隐藏，admin 级隐藏必须管理员恢复。
 */
export async function restoreContent(
  client: PoolClient,
  targetType: ModerationTargetType,
  targetId: string,
  input: RestoreInput
): Promise<RestoreResult> {
  const row = await lockTarget(client, targetType, targetId);
  if (row.status !== "hidden") {
    throw conflict("Only hidden content can be restored");
  }
  if (!canReverseHide(input.actorRole, row.hidden_by_level)) {
    throw forbidden("Content hidden by an administrator can only be restored by an administrator");
  }

  const { table } = TABLES[targetType];
  await client.query(
    `UPDATE ${table}
     SET status = 'published', hidden_by = NULL, hidden_by_level = NULL,
         hidden_reason_code = NULL, hidden_at = NULL, updated_at = now()
     WHERE id = $1`,
    [targetId]
  );

  await recordAudit(client, {
    actorId: input.actorId,
    action: auditActionName(targetType, "restored"),
    resourceType: targetType,
    resourceId: targetId,
    metadata: {
      reasonCode: input.reasonCode ?? null,
      notes: input.notes ?? null,
      previousHiddenByLevel: row.hidden_by_level,
      previousReasonCode: row.hidden_reason_code,
      ...input.metadata
    }
  });
  await writeModerationLedger(client, {
    targetType,
    targetId,
    actorId: input.actorId,
    action: "restored",
    reasonCode: input.reasonCode,
    notes: input.notes,
    beforeState: { status: "hidden", hiddenByLevel: row.hidden_by_level, reasonCode: row.hidden_reason_code },
    afterState: { status: "published", hiddenByLevel: null }
  });

  return {
    id: targetId,
    ownerId: row.owner_id,
    hiddenByLevel: row.hidden_by_level!,
    hiddenReasonCode: row.hidden_reason_code
  };
}

/**
 * 版本发布守卫：批准修订会把内容重新公开，因此必须通过与恢复相同的
 * 权限判定。任何会让内容变 published 的操作都应先调用本函数。
 *
 * 返回 true 表示当前已发布（普通批准）；返回 false 表示内容原为隐藏，
 * 本次批准同时构成一次受控恢复，调用方必须在审计中记录 restoredFromHidden。
 */
export function assertCanPublish(
  targetType: ModerationTargetType,
  row: Pick<HiddenStateRow, "status" | "deleted_at" | "hidden_by_level">,
  actorRole: UserRole
): { restoringFromHidden: boolean; hiddenByLevel: HideLevel | null } {
  if (row.deleted_at) throw notFound(targetType === "feature" ? "Feature not found" : "Comment not found");
  if (row.status === "published") return { restoringFromHidden: false, hiddenByLevel: null };
  if (row.status === "hidden") {
    if (!canReverseHide(actorRole, row.hidden_by_level)) {
      throw new AppError(
        403,
        "FORBIDDEN",
        "Content hidden by an administrator cannot be republished via revision approval; an administrator must restore it first"
      );
    }
    return { restoringFromHidden: true, hiddenByLevel: row.hidden_by_level };
  }
  // draft / pending / rejected / changes_requested 由各自批准逻辑处理。
  return { restoringFromHidden: false, hiddenByLevel: null };
}

/** 清理隐藏状态字段（删除时调用），保证 CHECK 约束始终成立。 */
export async function clearHiddenState(
  client: PoolClient,
  targetType: ModerationTargetType,
  targetId: string
): Promise<void> {
  const { table } = TABLES[targetType];
  await client.query(
    `UPDATE ${table}
     SET hidden_by = NULL, hidden_by_level = NULL, hidden_reason_code = NULL,
         hidden_at = NULL, updated_at = now()
     WHERE id = $1`,
    [targetId]
  );
}
