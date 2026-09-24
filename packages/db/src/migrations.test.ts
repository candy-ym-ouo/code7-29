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

  it("records hide provenance and enforces state consistency in migration 0003", () => {
    const followup = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../migrations/0003_hidden_provenance.sql"),
      "utf8"
    );
    expect(followup).toContain("ADD COLUMN hidden_by_level text");
    expect(followup).toContain("map_features_hidden_state_chk");
    expect(followup).toContain("comments_hidden_state_chk");
    // 遗留隐藏数据必须 fail-closed 为 admin 级，不能被普通审核员直接恢复。
    expect(followup).toMatch(/UPDATE map_features[\s\S]*'LEGACY_HIDDEN'/);
  });

  it("uses PostGIS geography points and spatial indexes", () => {
    expect(migration).toContain("geography(Point, 4326)");
    expect(migration).toContain("USING gist (geom)");
  });
});
