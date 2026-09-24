import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../migrations/0001_init.sql"),
  "utf8"
);

describe("initial migration", () => {
  it("contains the core audited entities", () => {
    for (const table of [
      "users", "sessions", "auth_tokens", "categories", "map_features",
      "feature_revisions", "media_assets", "comments", "reports",
      "moderation_actions", "outbox_events", "audit_logs", "notifications"
    ]) {
      expect(migration).toContain(`CREATE TABLE ${table}`);
    }
  });

  it("adds public thumbnail and outbox recovery fields in migration 0002", () => {
    const followup = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../migrations/0002_media_public_thumb.sql"),
      "utf8"
    );
    expect(followup).toContain("public_thumbnail_object_key");
    expect(followup).toContain("updated_at timestamptz");
  });

  it("records hide attribution and enforces it for hidden content in migration 0003", () => {
    const followup = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../migrations/0003_hide_attribution.sql"),
      "utf8"
    );
    expect(followup).toContain("CREATE TYPE hide_source AS ENUM ('system', 'moderator', 'admin')");
    expect(followup).toContain("hidden_source hide_source");
    expect(followup).toContain("hidden_by uuid REFERENCES users(id)");
    expect(followup).toContain("CHECK (status <> 'hidden' OR hidden_source IS NOT NULL)");
    // 存量隐藏数据按最严格级别回填，仅管理员可恢复。
    expect(followup).toContain("SET hidden_source = 'admin'");
  });

  it("uses PostGIS geography points and spatial indexes", () => {
    expect(migration).toContain("geography(Point, 4326)");
    expect(migration).toContain("USING gist (geom)");
  });
});
