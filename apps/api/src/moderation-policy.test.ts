import { describe, expect, it } from "vitest";
import { hideSourceForRole } from "./moderation-policy";

describe("hideSourceForRole", () => {
  it("maps actor roles to hide source ranks", () => {
    expect(hideSourceForRole("admin")).toBe("admin");
    expect(hideSourceForRole("moderator")).toBe("moderator");
    expect(hideSourceForRole("contributor")).toBe("moderator");
  });
});
