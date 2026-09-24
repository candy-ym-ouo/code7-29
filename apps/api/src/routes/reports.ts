import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { reportCreateSchema } from "@map/shared/contracts";
import { query, transaction } from "../db";
import { conflict, notFound } from "../errors";
import { requireAuth } from "../auth";
import { recordAudit } from "../audit";
import { notifyUser } from "../notifications";
import { applyHide } from "../moderation-policy";

export async function reportRoutes(app: FastifyInstance) {
  app.post("/reports", { preHandler: requireAuth }, async (request, reply) => {
    const input = reportCreateSchema.parse(request.body);
    const reportId = await transaction(async (client) => {
      let ownerId: string | null = null;
      if (input.targetType === "feature") {
        const target = await client.query<{ owner_id: string; status: string }>(
          "SELECT owner_id, status FROM map_features WHERE id = $1 AND deleted_at IS NULL",
          [input.targetId]
        );
        if (!target.rows[0] || target.rows[0].status !== "published") throw notFound("Feature not found");
        ownerId = target.rows[0].owner_id;
      } else {
        const target = await client.query<{ author_id: string; status: string }>(
          "SELECT author_id, status FROM comments WHERE id = $1 AND deleted_at IS NULL",
          [input.targetId]
        );
        if (!target.rows[0] || target.rows[0].status !== "published") throw notFound("Comment not found");
        ownerId = target.rows[0].author_id;
      }

      const inserted = await client.query<{ id: string }>(
        `INSERT INTO reports(reporter_id, target_type, target_id, reason_code, notes)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [request.user!.id, input.targetType, input.targetId, input.reasonCode, input.notes ?? null]
      ).catch((error: unknown) => {
        if (typeof error === "object" && error && "code" in error && error.code === "23505") {
          throw conflict("You already have an open report for this item");
        }
        throw error;
      });

      const count = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM reports
         WHERE target_type = $1 AND target_id = $2 AND status = 'open'`,
        [input.targetType, input.targetId]
      );
      if (count.rows[0]!.count >= 3) {
        await applyHide(client, {
          target: input.targetType,
          id: input.targetId,
          source: "system",
          actorId: null,
          reasonCode: "REPORT_THRESHOLD"
        });
        await recordAudit(client, {
          actorId: null,
          action: "report.threshold_hidden",
          resourceType: input.targetType,
          resourceId: input.targetId,
          metadata: { openReports: count.rows[0]!.count, hiddenSource: "system" }
        });
      }
      if (ownerId && ownerId !== request.user!.id) {
        await notifyUser(client, {
          userId: ownerId,
          type: "content_reported",
          title: "你的内容收到举报",
          body: "内容已进入审核流程，审核员会结合举报理由进行判断。",
          link: input.targetType === "feature" ? `/features/${input.targetId}` : "/me/comments"
        });
      }
      return inserted.rows[0]!.id;
    });
    return reply.code(201).send({ id: reportId, status: "open" });
  });

  app.get("/me/notifications", { preHandler: requireAuth }, async (request) => {
    const result = await query(
      `SELECT id, type, title, body, link, read_at, created_at
       FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [request.user!.id]
    );
    return result.rows;
  });

  app.post("/me/notifications/:id/read", { preHandler: requireAuth }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const result = await query(
      "UPDATE notifications SET read_at = COALESCE(read_at, now()) WHERE id = $1 AND user_id = $2 RETURNING id",
      [params.id, request.user!.id]
    );
    if (!result.rowCount) throw notFound("Notification not found");
    return { status: "read" };
  });
}
