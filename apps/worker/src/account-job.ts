import { config } from "./config";
import { pool } from "./db";
import { deleteObject } from "./storage";
import { randomToken } from "@map/shared/server";

type DeletableAccount = { id: string };

export async function purgeDeletedAccounts(): Promise<void> {
  const accounts = await pool.query<DeletableAccount>(
    `SELECT id FROM users
     WHERE status = 'deletion_pending'
       AND deleted_at < now() - interval '30 days'
     LIMIT 10`
  );

  for (const account of accounts.rows) {
    const media = await pool.query<{
      quarantine_object_key: string;
      processed_object_key: string | null;
      thumbnail_object_key: string | null;
      public_object_key: string | null;
      public_thumbnail_object_key: string | null;
    }>(
      `SELECT quarantine_object_key, processed_object_key, thumbnail_object_key,
              public_object_key, public_thumbnail_object_key
       FROM media_assets WHERE owner_id = $1`,
      [account.id]
    );

    try {
      for (const item of media.rows) {
        const removals = [
          deleteObject(config.S3_QUARANTINE_BUCKET, item.quarantine_object_key),
          item.processed_object_key ? deleteObject(config.S3_QUARANTINE_BUCKET, item.processed_object_key) : Promise.resolve(),
          item.thumbnail_object_key ? deleteObject(config.S3_QUARANTINE_BUCKET, item.thumbnail_object_key) : Promise.resolve(),
          item.public_object_key ? deleteObject(config.S3_PUBLIC_BUCKET, item.public_object_key) : Promise.resolve(),
          item.public_thumbnail_object_key ? deleteObject(config.S3_PUBLIC_BUCKET, item.public_thumbnail_object_key) : Promise.resolve()
        ];
        await Promise.all(removals);
      }
    } catch (error) {
      console.error({ userId: account.id, error }, "account purge object deletion failed; will retry");
      continue;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE media_assets SET privacy_status = 'deleted', deleted_at = now(), updated_at = now()
         WHERE owner_id = $1`,
        [account.id]
      );
      await client.query(
        `UPDATE comments
         SET status = 'deleted', deleted_at = now(), updated_at = now(),
             hidden_by = NULL, hidden_by_level = NULL, hidden_reason_code = NULL, hidden_at = NULL
         WHERE author_id = $1 AND deleted_at IS NULL`,
        [account.id]
      );
      await client.query(
        `UPDATE map_features
         SET status = 'deleted', deleted_at = now(), updated_at = now(),
             hidden_by = NULL, hidden_by_level = NULL, hidden_reason_code = NULL, hidden_at = NULL
         WHERE owner_id = $1 AND deleted_at IS NULL`,
        [account.id]
      );
      await client.query(
        `UPDATE users
         SET email = $2,
             email_normalized = $3,
             display_name = '已删除用户',
             password_hash = $4,
             status = 'deleted',
             updated_at = now()
         WHERE id = $1`,
        [account.id, `deleted+${account.id}@invalid.local`, `deleted+${account.id}@invalid.local`, `!unusable:${randomToken(24)}`]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
