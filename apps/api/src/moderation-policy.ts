import type { PoolClient } from "pg";
import type { HideSource, UserRole } from "@map/shared/contracts";
import { canRestoreHiddenContent, strongestHideSource } from "@map/shared/contracts";
import { conflict, forbidden, notFound } from "./errors";

export type HideTarget = "feature" | "comment";

const TABLE_BY_TARGET: Record<HideTarget, string> = {
  feature: "map_features",
  comment: "comments"
};

const OWNER_COLUMN_BY_TARGET: Record<HideTarget, string> = {
  feature: "owner_id",
  comment: "author_id"
};

/** 审核员/管理员手动隐藏时对应的来源等级。 */
export function hideSourceForRole(role: UserRole): HideSource {
  return role === "admin" ? "admin" : "moderator";
}

type HiddenRow = {
  owner_id: string;
  status: string;
  hidden_source: HideSource | null;
};

async function lockTargetRow(client: PoolClient, target: HideTarget, id: string): Promise<HiddenRow> {
  const result = await client.query<HiddenRow>(
    `SELECT ${OWNER_COLUMN_BY_TARGET[target]} AS owner_id, status, hidden_source
     FROM ${TABLE_BY_TARGET[target]}
     WHERE id = $1 AND deleted_at IS NULL
     FOR UPDATE`,
    [id]
  );
  const row = result.rows[0];
  if (!row) throw notFound(target === "feature" ? "Feature not found" : "Comment not found");
  return row;
}

/** 要素恢复的前置条件：必须已有获批版本可作为公开版本。 */
async function assertFeatureRestorable(client: PoolClient, id: string): Promise<void> {
  const result = await client.query<{ current_revision_id: string | null }>(
    "SELECT current_revision_id FROM map_features WHERE id = $1",
    [id]
  );
  if (!result.rows[0]?.current_revision_id) throw conflict("Feature has no approved revision");
}

/**
 * 统一隐藏入口。所有把内容置为 hidden 的路径都必须经过这里，
 * 以保证隐藏来源只升不降（system < moderator < admin）：
 * 低等级来源的重复隐藏不会覆盖高等级来源的归属信息。
 */
export async function applyHide(
  client: PoolClient,
  input: {
    target: HideTarget;
    id: string;
    source: HideSource;
    actorId: string | null;
    reasonCode?: string | null;
  }
): Promise<{ ownerId: string; hiddenSource: HideSource }> {
  const row = await lockTargetRow(client, input.target, input.id);
  const hiddenSource = row.status === "hidden"
    ? strongestHideSource(row.hidden_source, input.source)
    : input.source;
  const keepExistingAttribution = row.status === "hidden" && hiddenSource !== input.source;
  await client.query(
    `UPDATE ${TABLE_BY_TARGET[input.target]}
     SET status = 'hidden',
         hidden_at = CASE WHEN $3::boolean THEN hidden_at ELSE now() END,
         hidden_by = CASE WHEN $3::boolean THEN hidden_by ELSE $4 END,
         hidden_source = $2,
         hidden_reason_code = CASE WHEN $3::boolean THEN hidden_reason_code ELSE $5 END,
         updated_at = now()
     WHERE id = $1`,
    [input.id, hiddenSource, keepExistingAttribution, input.actorId, input.reasonCode ?? null]
  );
  return { ownerId: row.owner_id, hiddenSource };
}

/**
 * 统一恢复入口。hidden -> published 的唯一合法通道：
 * 操作者角色等级必须不低于隐藏来源等级，管理员隐藏的内容只能由管理员恢复。
 */
export async function applyRestore(
  client: PoolClient,
  input: {
    target: HideTarget;
    id: string;
    actorRole: UserRole;
  }
): Promise<{ ownerId: string; hiddenSource: HideSource }> {
  const row = await lockTargetRow(client, input.target, input.id);
  if (row.status !== "hidden") throw conflict("Content is not hidden");
  if (!canRestoreHiddenContent(input.actorRole, row.hidden_source)) {
    throw forbidden("Content hidden by an administrator can only be restored by an administrator");
  }
  if (input.target === "feature") await assertFeatureRestorable(client, input.id);
  await client.query(
    `UPDATE ${TABLE_BY_TARGET[input.target]}
     SET status = 'published',
         hidden_at = NULL,
         hidden_by = NULL,
         hidden_source = NULL,
         hidden_reason_code = NULL,
         updated_at = now()
     WHERE id = $1`,
    [input.id]
  );
  return { ownerId: row.owner_id, hiddenSource: row.hidden_source ?? "system" };
}
