import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { moderationDecisionSchema } from "@map/shared/contracts";
import { query, transaction } from "../db";
import { conflict, notFound } from "../errors";
import { requireAdmin, requireModerator } from "../auth";
import { recordAudit } from "../audit";
import { notifyUser } from "../notifications";
import {
  assertCanPublish,
  hideContent,
  restoreContent,
  type HideLevel
} from "../moderation-state";

export async function moderationRoutes(app: FastifyInstance) {
  app.get("/moderation/queue", { preHandler: requireModerator }, async () => {
    const [features, comments, media, reports] = await Promise.all([
      query(
        `SELECT fr.id AS revision_id, fr.feature_id, fr.revision_no, fr.payload, fr.submitted_at,
                mf.category_key, mf.status AS feature_status,
                mf.hidden_by_level AS feature_hidden_by_level, u.display_name AS author_name
         FROM feature_revisions fr
         JOIN map_features mf ON mf.id = fr.feature_id
         JOIN users u ON u.id = fr.author_id
         WHERE fr.status = 'pending' AND mf.deleted_at IS NULL
         ORDER BY fr.submitted_at ASC
         LIMIT 100`
      ),
      query(
        `SELECT c.id, c.feature_id, c.body, c.status, c.created_at,
                c.hidden_by_level, u.display_name AS author_name
         FROM comments c JOIN users u ON u.id = c.author_id
         WHERE c.status = 'pending' AND c.deleted_at IS NULL
         ORDER BY c.created_at ASC LIMIT 100`
      ),
      query(
        `SELECT ma.id, ma.original_filename, ma.privacy_status, ma.privacy_report,
                ma.processed_object_key, ma.created_at, u.display_name AS owner_name
         FROM media_assets ma JOIN users u ON u.id = ma.owner_id
         WHERE ma.privacy_status = 'manual_review' AND ma.deleted_at IS NULL
         ORDER BY ma.created_at ASC LIMIT 100`
      ),
      query(
        `SELECT r.id, r.target_type, r.target_id, r.reason_code, r.notes, r.created_at,
                u.display_name AS reporter_name
         FROM reports r JOIN users u ON u.id = r.reporter_id
         WHERE r.status = 'open'
         ORDER BY r.created_at ASC LIMIT 100`
      )
    ]);

    return {
      counts: {
        features: features.rowCount,
        comments: comments.rowCount,
        media: media.rowCount,
        reports: reports.rowCount
      },
      features: features.rows,
      comments: comments.rows,
      media: media.rows,
      reports: reports.rows
    };
  });

  app.post("/moderation/features/:id/approve", { preHandler: requireModerator }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    await transaction(async (client) => {
      const revisionResult = await client.query<{
        id: string;
        payload: { categoryKey: string; longitude: number; latitude: number; locationAccuracyM: number; mediaIds?: string[] };
        author_id: string;
      }>(
        `SELECT fr.id, fr.payload, fr.author_id
         FROM feature_revisions fr
         JOIN map_features mf ON mf.id = fr.feature_id
         WHERE fr.feature_id = $1 AND fr.status = 'pending' AND mf.deleted_at IS NULL
         ORDER BY fr.revision_no DESC LIMIT 1 FOR UPDATE OF fr`,
        [params.id]
      );
      const revision = revisionResult.rows[0];
      if (!revision) throw notFound("Pending revision not found");

      // 锁定 feature 行，批准修订会重新公开内容，必须通过统一发布守卫：
      // 管理员隐藏的内容不能由审核员借批准修订重新公开。
      const featureResult = await client.query<{
        status: string;
        deleted_at: Date | null;
        hidden_by_level: HideLevel | null;
        hidden_reason_code: string | null;
      }>(
        `SELECT status, deleted_at, hidden_by_level, hidden_reason_code
         FROM map_features WHERE id = $1 FOR UPDATE`,
        [params.id]
      );
      const feature = featureResult.rows[0];
      if (!feature || feature.deleted_at) throw notFound("Feature not found");
      const publishGuard = assertCanPublish("feature", feature, request.user!.role);

      const mediaIds = revision.payload.mediaIds ?? [];
      if (mediaIds.length) {
        const media = await client.query<{ id: string; privacy_status: string }>(
          "SELECT id, privacy_status FROM media_assets WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL",
          [mediaIds]
        );
        if (media.rowCount !== mediaIds.length || media.rows.some((row) => row.privacy_status !== "ready")) {
          throw conflict("All attached media must pass privacy review before content approval");
        }
      }

      await client.query(
        `UPDATE feature_revisions
         SET status = 'published', reviewed_at = now(), reviewer_id = $2,
             rejection_reason_code = NULL, updated_at = now()
         WHERE id = $1`,
        [revision.id, request.user!.id]
      );
      await client.query(
        `UPDATE map_features
         SET current_revision_id = $2,
             status = 'published',
             hidden_by = NULL,
             hidden_by_level = NULL,
             hidden_reason_code = NULL,
             hidden_at = NULL,
             category_key = $3,
             geom = ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography,
             location_accuracy_m = $6,
             first_published_at = COALESCE(first_published_at, now()),
             freshness_expires_at = now() + interval '180 days',
             needs_review_at = NULL,
             updated_at = now()
         WHERE id = $1`,
        [
          params.id,
          revision.id,
          revision.payload.categoryKey,
          revision.payload.longitude,
          revision.payload.latitude,
          revision.payload.locationAccuracyM
        ]
      );
      await recordAudit(client, {
        actorId: request.user!.id,
        action: "feature.approved",
        resourceType: "feature",
        resourceId: params.id,
        metadata: {
          revisionId: revision.id,
          restoredFromHidden: publishGuard.restoringFromHidden,
          previousHiddenByLevel: publishGuard.hiddenByLevel
        }
      });
      await client.query(
        `INSERT INTO moderation_actions(target_type, target_id, moderator_id, action, before_state, after_state)
         VALUES ('feature', $1, $2, 'revision_approved', $3::jsonb, $4::jsonb)`,
        [
          params.id,
          request.user!.id,
          JSON.stringify({ status: feature.status, hiddenByLevel: feature.hidden_by_level }),
          JSON.stringify({ status: "published", hiddenByLevel: null, revisionId: revision.id })
        ]
      );
      await notifyUser(client, {
        userId: revision.author_id,
        type: "feature_approved",
        title: "你的地点细节已通过审核",
        body: "内容已发布到公共地图。",
        link: `/features/${params.id}`
      });
    });
    return { status: "published" };
  });

  app.post("/moderation/features/:id/reject", { preHandler: requireModerator }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = moderationDecisionSchema.parse(request.body);
    await transaction(async (client) => {
      const revision = await activePendingRevision(client, params.id);
      await client.query(
        `UPDATE feature_revisions
         SET status = 'rejected', reviewed_at = now(), reviewer_id = $2,
             rejection_reason_code = $3, moderation_notes = $4, updated_at = now()
         WHERE id = $1`,
        [revision.id, request.user!.id, input.reasonCode, input.notes ?? null]
      );
      await client.query(
        `UPDATE map_features
         SET status = CASE WHEN current_revision_id IS NULL THEN 'rejected'::content_status ELSE status END,
             updated_at = now()
         WHERE id = $1`,
        [params.id]
      );
      await recordAudit(client, {
        actorId: request.user!.id,
        action: "feature.rejected",
        resourceType: "feature",
        resourceId: params.id,
        metadata: { revisionId: revision.id, reasonCode: input.reasonCode, notes: input.notes }
      });
      await notifyUser(client, {
        userId: revision.author_id,
        type: "feature_rejected",
        title: "你的地点细节未通过审核",
        body: `拒绝原因：${input.reasonCode}${input.notes ? `。${input.notes}` : ""}`,
        link: "/me/contributions"
      });
    });
    return { status: "rejected" };
  });

  app.post("/moderation/features/:id/request-changes", { preHandler: requireModerator }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = moderationDecisionSchema.parse(request.body);
    await transaction(async (client) => {
      const revision = await activePendingRevision(client, params.id);
      await client.query(
        `UPDATE feature_revisions
         SET status = 'changes_requested', reviewed_at = now(), reviewer_id = $2,
             rejection_reason_code = $3, moderation_notes = $4, updated_at = now()
         WHERE id = $1`,
        [revision.id, request.user!.id, input.reasonCode, input.notes ?? null]
      );
      await client.query(
        `UPDATE map_features
         SET status = CASE WHEN current_revision_id IS NULL THEN 'changes_requested'::content_status ELSE status END,
             updated_at = now()
         WHERE id = $1`,
        [params.id]
      );
      await recordAudit(client, {
        actorId: request.user!.id,
        action: "feature.changes_requested",
        resourceType: "feature",
        resourceId: params.id,
        metadata: { revisionId: revision.id, reasonCode: input.reasonCode }
      });
      await notifyUser(client, {
        userId: revision.author_id,
        type: "feature_changes_requested",
        title: "你的地点细节需要修改",
        body: `${input.reasonCode}${input.notes ? `：${input.notes}` : ""}`,
        link: "/me/contributions"
      });
    });
    return { status: "changes_requested" };
  });

  app.post("/moderation/features/:id/hide", { preHandler: requireModerator }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = moderationDecisionSchema.parse(request.body);
    await transaction(async (client) => {
      const result = await hideContent(client, "feature", params.id, {
        actorId: request.user!.id,
        actorRole: request.user!.role,
        reasonCode: input.reasonCode,
        notes: input.notes
      });
      await notifyUser(client, {
        userId: result.ownerId,
        type: "feature_hidden",
        title: "你的地点细节已被隐藏",
        body: `${input.reasonCode}${input.notes ? `：${input.notes}` : ""}`,
        link: "/me/contributions"
      });
    });
    return { status: "hidden" };
  });

  app.post("/moderation/features/:id/restore", { preHandler: requireAdmin }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    await transaction(async (client) => {
      const result = await restoreContent(client, "feature", params.id, {
        actorId: request.user!.id,
        actorRole: request.user!.role,
        reasonCode: "MANUAL_RESTORE"
      });
      await notifyUser(client, {
        userId: result.ownerId,
        type: "feature_restored",
        title: "你的地点细节已恢复公开",
        body: "管理员复核后已恢复该内容。",
        link: `/features/${params.id}`
      });
    });
    return { status: "published" };
  });

  app.post("/moderation/comments/:id/approve", { preHandler: requireModerator }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    await transaction(async (client) => {
      const result = await client.query<{ author_id: string }>(
        `UPDATE comments SET status = 'published', reviewed_at = now(), reviewer_id = $2,
             rejection_reason_code = NULL, updated_at = now()
         WHERE id = $1 AND status = 'pending' AND deleted_at IS NULL RETURNING author_id`,
        [params.id, request.user!.id]
      );
      const comment = result.rows[0];
      if (!comment) throw notFound("Pending comment not found");
      await recordAudit(client, {
        actorId: request.user!.id,
        action: "comment.approved",
        resourceType: "comment",
        resourceId: params.id
      });
      await notifyUser(client, {
        userId: comment.author_id,
        type: "comment_approved",
        title: "你的评论已通过审核",
        body: "评论已公开显示。",
        link: "/me/comments"
      });
    });
    return { status: "published" };
  });

  app.post("/moderation/comments/:id/reject", { preHandler: requireModerator }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = moderationDecisionSchema.parse(request.body);
    await transaction(async (client) => {
      const result = await client.query<{ author_id: string }>(
        `UPDATE comments SET status = 'rejected', reviewed_at = now(), reviewer_id = $2,
             rejection_reason_code = $3, updated_at = now()
         WHERE id = $1 AND status IN ('pending', 'published') AND deleted_at IS NULL RETURNING author_id`,
        [params.id, request.user!.id, input.reasonCode]
      );
      const comment = result.rows[0];
      if (!comment) throw notFound("Comment not found");
      await recordAudit(client, {
        actorId: request.user!.id,
        action: "comment.rejected",
        resourceType: "comment",
        resourceId: params.id,
        metadata: { reasonCode: input.reasonCode, notes: input.notes }
      });
      await notifyUser(client, {
        userId: comment.author_id,
        type: "comment_rejected",
        title: "你的评论未通过审核",
        body: `${input.reasonCode}${input.notes ? `：${input.notes}` : ""}`,
        link: "/me/comments"
      });
    });
    return { status: "rejected" };
  });

  app.post("/moderation/comments/:id/hide", { preHandler: requireModerator }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = moderationDecisionSchema.parse(request.body);
    await transaction(async (client) => {
      await hideContent(client, "comment", params.id, {
        actorId: request.user!.id,
        actorRole: request.user!.role,
        reasonCode: input.reasonCode,
        notes: input.notes
      });
    });
    return { status: "hidden" };
  });

  // 评论恢复同样受统一隐藏来源守卫；端点限管理员，审核员仅可在处理举报时
  // 恢复 system/moderator 级隐藏（见 reports/:id/resolve）。
  app.post("/moderation/comments/:id/restore", { preHandler: requireAdmin }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    await transaction(async (client) => {
      await restoreContent(client, "comment", params.id, {
        actorId: request.user!.id,
        actorRole: request.user!.role,
        reasonCode: "MANUAL_RESTORE"
      });
    });
    return { status: "published" };
  });

  app.post("/moderation/reports/:id/resolve", { preHandler: requireModerator }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = z.object({
      status: z.enum(["resolved", "dismissed"]),
      action: z.enum(["none", "hide", "restore"]).default("none"),
      notes: z.string().trim().max(1000).optional()
    }).parse(request.body);

    await transaction(async (client) => {
      const reportResult = await client.query<{ target_type: "feature" | "comment"; target_id: string; reporter_id: string; reason_code: string }>(
        "SELECT target_type, target_id, reporter_id, reason_code FROM reports WHERE id = $1 AND status = 'open' FOR UPDATE",
        [params.id]
      );
      const report = reportResult.rows[0];
      if (!report) throw notFound("Open report not found");

      if (input.action === "hide") {
        // 复用统一隐藏入口：只有已发布内容可隐藏，隐藏级别取自操作者角色。
        await hideContent(client, report.target_type, report.target_id, {
          actorId: request.user!.id,
          actorRole: request.user!.role,
          reasonCode: `REPORT:${report.reason_code}`.slice(0, 64),
          notes: input.notes,
          metadata: { reportId: params.id }
        });
      }
      if (input.action === "restore") {
        // 统一恢复守卫：管理员隐藏的目标在此对审核员返回 403，
        // 举报处理不能成为绕过 /restore 端点角色限制的旁路。
        const restored = await restoreContent(client, report.target_type, report.target_id, {
          actorId: request.user!.id,
          actorRole: request.user!.role,
          reasonCode: `REPORT_REVIEW:${report.reason_code}`.slice(0, 64),
          notes: input.notes,
          metadata: { reportId: params.id }
        });
        if (restored.hiddenByLevel === "system") {
          // 系统因举报阈值隐藏后经举报复核恢复，通知被误隐藏的作者。
          await notifyUser(client, {
            userId: restored.ownerId,
            type: report.target_type === "feature" ? "feature_restored" : "comment_restored",
            title: report.target_type === "feature" ? "你的地点细节已恢复公开" : "你的评论已恢复显示",
            body: "举报复核完成，内容已恢复。",
            link: report.target_type === "feature" ? `/features/${restored.id}` : "/me/comments"
          });
        }
      }

      await client.query(
        `UPDATE reports SET status = $2, resolved_by = $3, resolved_at = now() WHERE id = $1`,
        [params.id, input.status, request.user!.id]
      );
      await recordAudit(client, {
        actorId: request.user!.id,
        action: "report.resolved",
        resourceType: "report",
        resourceId: params.id,
        metadata: { status: input.status, action: input.action, notes: input.notes, targetType: report.target_type, targetId: report.target_id }
      });
      await notifyUser(client, {
        userId: report.reporter_id,
        type: "report_resolved",
        title: "你的举报已处理",
        body: input.status === "resolved" ? "审核员已完成处理。" : "审核员已完成核查，本次举报被驳回。",
        link: "/me/notifications"
      });
    });
    return { status: input.status };
  });

  app.get("/moderation/audit", { preHandler: requireAdmin }, async (request) => {
    const input = z.object({
      limit: z.coerce.number().int().min(1).max(200).default(100),
      resourceType: z.string().optional()
    }).parse(request.query);
    const values: unknown[] = [input.limit];
    const where = input.resourceType ? "WHERE resource_type = $2" : "";
    if (input.resourceType) values.push(input.resourceType);
    const result = await query(
      `SELECT al.id, al.actor_id, u.display_name AS actor_name, al.action,
              al.resource_type, al.resource_id, al.metadata, al.created_at
       FROM audit_logs al LEFT JOIN users u ON u.id = al.actor_id
       ${where}
       ORDER BY al.created_at DESC LIMIT $1`,
      values
    );
    return result.rows;
  });
}

async function activePendingRevision(client: Parameters<Parameters<typeof transaction>[0]>[0], featureId: string) {
  const result = await client.query<{ id: string; author_id: string }>(
    `SELECT id, author_id FROM feature_revisions
     WHERE feature_id = $1 AND status = 'pending'
     ORDER BY revision_no DESC LIMIT 1 FOR UPDATE`,
    [featureId]
  );
  const revision = result.rows[0];
  if (!revision) throw notFound("Pending revision not found");
  return revision;
}
