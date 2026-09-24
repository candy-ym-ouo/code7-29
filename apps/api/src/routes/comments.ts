import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createCommentSchema, updateCommentSchema } from "@map/shared/contracts";
import { query, transaction } from "../db";
import { conflict, forbidden, notFound } from "../errors";
import { requireAuth, requireVerifiedContributor } from "../auth";
import { recordAudit } from "../audit";

export async function commentRoutes(app: FastifyInstance) {
  app.get("/features/:id/comments", async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const result = await query(
      `SELECT c.id, c.parent_id, c.body, c.created_at, c.edited_at,
              u.display_name AS author_name
       FROM comments c
       JOIN users u ON u.id = c.author_id
       JOIN map_features mf ON mf.id = c.feature_id
       WHERE c.feature_id = $1 AND c.status = 'published' AND c.deleted_at IS NULL
         AND mf.status = 'published' AND mf.deleted_at IS NULL
       ORDER BY c.created_at ASC`,
      [params.id]
    );
    return result.rows.map((row) => ({
      id: row.id,
      parentId: row.parent_id,
      body: row.body,
      createdAt: row.created_at,
      editedAt: row.edited_at,
      authorName: row.author_name
    }));
  });

  app.post("/features/:id/comments", { preHandler: requireVerifiedContributor }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = createCommentSchema.parse(request.body);
    const commentId = await transaction(async (client) => {
      const feature = await client.query<{ status: string }>(
        "SELECT status FROM map_features WHERE id = $1 AND deleted_at IS NULL",
        [params.id]
      );
      if (feature.rows[0]?.status !== "published") throw notFound("Published feature not found");
      if (input.parentId) {
        const parent = await client.query<{ feature_id: string; parent_id: string | null; status: string }>(
          "SELECT feature_id, parent_id, status FROM comments WHERE id = $1 AND deleted_at IS NULL",
          [input.parentId]
        );
        const parentRow = parent.rows[0];
        if (!parentRow || parentRow.feature_id !== params.id || parentRow.status !== "published") {
          throw conflict("Reply target is unavailable");
        }
        if (parentRow.parent_id) throw conflict("Only two comment levels are supported");
      }
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO comments(feature_id, author_id, parent_id, body, status)
         VALUES ($1, $2, $3, $4, 'pending') RETURNING id`,
        [params.id, request.user!.id, input.parentId ?? null, input.body]
      );
      await recordAudit(client, {
        actorId: request.user!.id,
        action: "comment.submitted",
        resourceType: "comment",
        resourceId: inserted.rows[0]!.id,
        metadata: { featureId: params.id }
      });
      return inserted.rows[0]!.id;
    });
    return reply.code(201).send({ id: commentId, status: "pending" });
  });

  app.get("/me/comments", { preHandler: requireAuth }, async (request) => {
    const result = await query(
      `SELECT c.id, c.feature_id, c.body, c.status, c.rejection_reason_code,
              c.created_at, c.updated_at, c.edited_at, mf.status AS feature_status,
              fr.payload->>'title' AS feature_title
       FROM comments c
       JOIN map_features mf ON mf.id = c.feature_id
       LEFT JOIN feature_revisions fr ON fr.id = mf.current_revision_id
       WHERE c.author_id = $1 AND c.deleted_at IS NULL
       ORDER BY c.created_at DESC`,
      [request.user!.id]
    );
    return result.rows;
  });

  app.patch("/comments/:id", { preHandler: requireAuth }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = updateCommentSchema.parse(request.body);
    await transaction(async (client) => {
      const result = await client.query<{
        author_id: string;
        created_at: Date;
        edited_at: Date | null;
        status: string;
      }>(
        `SELECT author_id, created_at, edited_at, status FROM comments
         WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
        [params.id]
      );
      const row = result.rows[0];
      if (!row) throw notFound("Comment not found");
      if (row.author_id !== request.user!.id) throw forbidden();
      if (row.edited_at || Date.now() - row.created_at.getTime() > 15 * 60 * 1000) {
        throw conflict("Comment edit window has expired");
      }
      if (!["pending", "published"].includes(row.status)) throw conflict("Comment cannot be edited");
      await client.query(
        `UPDATE comments SET body = $2, status = 'pending', edited_at = now(), updated_at = now() WHERE id = $1`,
        [params.id, input.body]
      );
      await recordAudit(client, {
        actorId: request.user!.id,
        action: "comment.edited",
        resourceType: "comment",
        resourceId: params.id
      });
    });
    return { status: "pending" };
  });

  app.delete("/comments/:id", { preHandler: requireAuth }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    await transaction(async (client) => {
      const result = await client.query<{ author_id: string }>(
        "SELECT author_id FROM comments WHERE id = $1 AND deleted_at IS NULL FOR UPDATE",
        [params.id]
      );
      const row = result.rows[0];
      if (!row) throw notFound("Comment not found");
      if (row.author_id !== request.user!.id && !["moderator", "admin"].includes(request.user!.role)) throw forbidden();
      await client.query(
        `UPDATE comments
         SET status = 'deleted', deleted_at = now(), updated_at = now(),
             hidden_by = NULL, hidden_by_level = NULL, hidden_reason_code = NULL, hidden_at = NULL
         WHERE id = $1`,
        [params.id]
      );
      await recordAudit(client, {
        actorId: request.user!.id,
        action: "comment.deleted",
        resourceType: "comment",
        resourceId: params.id
      });
    });
    return { status: "deleted" };
  });
}
