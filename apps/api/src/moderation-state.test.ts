import { describe, expect, it } from "vitest";
import { assertCanPublish, canReverseHide, hideLevelForRole } from "./moderation-state";

describe("moderation hide provenance authority", () => {
  it("moderators can reverse system and moderator hides but never admin hides", () => {
    expect(canReverseHide("moderator", "system")).toBe(true);
    expect(canReverseHide("moderator", "moderator")).toBe(true);
    expect(canReverseHide("moderator", "admin")).toBe(false);
    expect(canReverseHide("moderator", null)).toBe(true);
  });

  it("admins can reverse every hide level", () => {
    for (const level of ["system", "moderator", "admin"] as const) {
      expect(canReverseHide("admin", level)).toBe(true);
    }
  });

  it("contributors cannot reverse any enforced hide", () => {
    expect(canReverseHide("contributor", "system")).toBe(false);
    expect(canReverseHide("contributor", "moderator")).toBe(false);
    expect(canReverseHide("contributor", "admin")).toBe(false);
  });

  it("maps acting roles to the recorded hide level", () => {
    expect(hideLevelForRole("moderator")).toBe("moderator");
    expect(hideLevelForRole("admin")).toBe("admin");
  });
});

describe("assertCanPublish — the revision-approval gate", () => {
  const live = { status: "published", deleted_at: null, hidden_by_level: null } as const;
  const pending = { status: "pending", deleted_at: null, hidden_by_level: null } as const;
  const moderatorHidden = { status: "hidden", deleted_at: null, hidden_by_level: "moderator" } as const;
  const systemHidden = { status: "hidden", deleted_at: null, hidden_by_level: "system" } as const;
  const adminHidden = { status: "hidden", deleted_at: null, hidden_by_level: "admin" } as const;

  it("treats already published content as a plain approval", () => {
    expect(assertCanPublish("feature", live, "moderator")).toEqual({
      restoringFromHidden: false,
      hiddenByLevel: null
    });
  });

  it("allows first-time publishing of pending content", () => {
    expect(assertCanPublish("feature", pending, "moderator").restoringFromHidden).toBe(false);
  });

  it("flags system/moderator hidden content approved by a moderator as an explicit restore", () => {
    expect(assertCanPublish("feature", systemHidden, "moderator").restoringFromHidden).toBe(true);
    expect(assertCanPublish("feature", moderatorHidden, "moderator").restoringFromHidden).toBe(true);
  });

  it("blocks a moderator from republishing admin-hidden content by approving a revision", () => {
    expect(() => assertCanPublish("feature", adminHidden, "moderator")).toThrowError(/administrator/i);
  });

  it("allows an admin to republish admin-hidden content", () => {
    expect(assertCanPublish("feature", adminHidden, "admin")).toEqual({
      restoringFromHidden: true,
      hiddenByLevel: "admin"
    });
  });
});
