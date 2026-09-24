import { z } from "zod";

export const USER_ROLES = ["contributor", "moderator", "admin"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const USER_STATUSES = [
  "pending_verification",
  "active",
  "suspended",
  "deletion_pending",
  "deleted"
] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const CONTENT_STATUSES = [
  "draft",
  "pending",
  "published",
  "rejected",
  "changes_requested",
  "hidden",
  "deleted"
] as const;
export type ContentStatus = (typeof CONTENT_STATUSES)[number];

export const COMMENT_STATUSES = ["pending", "published", "rejected", "hidden", "deleted"] as const;
export type CommentStatus = (typeof COMMENT_STATUSES)[number];

export const HIDE_SOURCES = ["system", "moderator", "admin"] as const;
export type HideSource = (typeof HIDE_SOURCES)[number];

const HIDE_SOURCE_RANK: Record<HideSource, number> = { system: 1, moderator: 2, admin: 3 };
const ROLE_RANK: Record<UserRole, number> = { contributor: 0, moderator: 2, admin: 3 };

/** 隐藏来源等级只升不降：更高等级来源覆盖更低等级来源。 */
export function strongestHideSource(current: HideSource | null, next: HideSource): HideSource {
  if (!current) return next;
  return HIDE_SOURCE_RANK[next] >= HIDE_SOURCE_RANK[current] ? next : current;
}

/** 统一恢复规则：操作者角色等级必须不低于隐藏来源等级。 */
export function canRestoreHiddenContent(role: UserRole, source: HideSource | null): boolean {
  if (!source) return true;
  return ROLE_RANK[role] >= HIDE_SOURCE_RANK[source];
}

export const MEDIA_STATUSES = [
  "quarantined",
  "scanning",
  "processing",
  "manual_review",
  "ready",
  "rejected",
  "failed",
  "deleted"
] as const;
export type MediaStatus = (typeof MEDIA_STATUSES)[number];

export const CONDITION_VALUES = ["good", "fair", "poor", "unknown"] as const;
export const categoryKeys = [
  "bench",
  "drinking_water",
  "rain_shelter",
  "quiet_corner",
  "night_lighting"
] as const;
export type CategoryKey = (typeof categoryKeys)[number];

const optionalBoolean = z.boolean().nullable().optional();
const optionalText = z.string().trim().max(160).nullable().optional();

export const benchDetailsSchema = z.object({
  seatCount: z.number().int().min(1).max(100).nullable().optional(),
  hasBackrest: optionalBoolean,
  covered: optionalBoolean,
  shaded: optionalBoolean,
  hasArmrests: optionalBoolean,
  wheelchairSpace: optionalBoolean,
  material: optionalText,
  damageNotes: optionalText
}).strict();

export const drinkingWaterDetailsSchema = z.object({
  potable: z.enum(["yes", "no", "unknown"]).default("unknown"),
  waterType: z.enum(["fountain", "bottle_filler", "tap", "unknown"]).default("unknown"),
  bottleFiller: optionalBoolean,
  working: z.enum(["yes", "no", "unknown"]).default("unknown"),
  seasonal: optionalBoolean,
  pressure: z.enum(["low", "normal", "high", "unknown"]).default("unknown")
}).strict();

export const rainShelterDetailsSchema = z.object({
  capacity: z.number().int().min(1).max(500).nullable().optional(),
  windProtection: z.enum(["none", "partial", "strong", "unknown"]).default("unknown"),
  seating: optionalBoolean,
  flooding: z.enum(["yes", "no", "unknown"]).default("unknown"),
  structureNotes: optionalText
}).strict();

export const quietCornerDetailsSchema = z.object({
  seating: optionalBoolean,
  powerOutlet: optionalBoolean,
  wifi: optionalBoolean,
  crowdLevel: z.enum(["empty", "low", "medium", "high", "unknown"]).default("unknown"),
  bestTimes: z.string().trim().max(240).nullable().optional(),
  suitableFor: z.string().trim().max(240).nullable().optional()
}).strict();

export const nightLightingDetailsSchema = z.object({
  brightness: z.number().int().min(1).max(5).nullable().optional(),
  coverage: z.enum(["tiny", "partial", "wide", "unknown"]).default("unknown"),
  colorTemperature: z.enum(["warm", "neutral", "cold", "unknown"]).default("unknown"),
  lightType: z.string().trim().max(80).nullable().optional(),
  operatingHours: z.string().trim().max(120).nullable().optional(),
  brokenLights: z.number().int().min(0).max(100).nullable().optional(),
  safetyFeeling: z.number().int().min(1).max(5).nullable().optional()
}).strict();

export const detailSchemas = {
  bench: benchDetailsSchema,
  drinking_water: drinkingWaterDetailsSchema,
  rain_shelter: rainShelterDetailsSchema,
  quiet_corner: quietCornerDetailsSchema,
  night_lighting: nightLightingDetailsSchema
} satisfies Record<CategoryKey, z.ZodTypeAny>;

export const privacyRegionSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().positive().max(1),
  height: z.number().positive().max(1)
}).refine((value) => value.x + value.width <= 1.000001 && value.y + value.height <= 1.000001, {
  message: "Privacy region must stay within the image"
});

export const featurePayloadSchema = z.object({
  categoryKey: z.enum(categoryKeys),
  title: z.string().trim().min(3).max(80),
  description: z.string().trim().min(10).max(2000),
  longitude: z.number().min(-180).max(180),
  latitude: z.number().min(-90).max(90),
  locationAccuracyM: z.number().int().min(3).max(100),
  observedAt: z.coerce.date(),
  condition: z.enum(CONDITION_VALUES),
  stepFree: optionalBoolean,
  wheelchairAccessible: optionalBoolean,
  noiseLevel: z.number().int().min(1).max(5).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(24)).max(8).default([]),
  details: z.record(z.string(), z.unknown()).default({}),
  mediaIds: z.array(z.string().uuid()).max(6).default([])
}).superRefine((value, context) => {
  if (new Set(value.mediaIds).size !== value.mediaIds.length) {
    context.addIssue({
      code: "custom",
      path: ["mediaIds"],
      message: "Media IDs must be unique"
    });
  }
  const parsed = detailSchemas[value.categoryKey].safeParse(value.details);
  if (!parsed.success) {
    context.addIssue({
      code: "custom",
      path: ["details"],
      message: `Invalid details for ${value.categoryKey}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`
    });
  }
});

export const createFeatureSchema = featurePayloadSchema;

export const createCommentSchema = z.object({
  body: z.string().trim().min(1).max(1000),
  parentId: z.string().uuid().nullable().optional()
});

export const updateCommentSchema = z.object({
  body: z.string().trim().min(1).max(1000)
});

export const registerSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(10).max(128),
  displayName: z.string().trim().min(2).max(40)
});

export const loginSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(128)
});

export const forgotPasswordSchema = z.object({
  email: z.string().trim().email().max(254)
});

export const resetPasswordSchema = z.object({
  token: z.string().min(20).max(300),
  password: z.string().min(10).max(128)
});

export const verifyEmailSchema = z.object({
  token: z.string().min(20).max(300)
});

export const mediaUploadInitSchema = z.object({
  filename: z.string().trim().min(1).max(255),
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  byteSize: z.number().int().positive()
});

export const mediaUploadCompleteSchema = z.object({
  privacyRegions: z.array(privacyRegionSchema).max(50).default([]),
  containsPeopleOrPlates: z.boolean().default(false),
  rightsConfirmed: z.literal(true)
});

export const moderationDecisionSchema = z.object({
  reasonCode: z.string().trim().min(2).max(64),
  notes: z.string().trim().max(1000).optional()
});

export const reportCreateSchema = z.object({
  targetType: z.enum(["feature", "comment"]),
  targetId: z.string().uuid(),
  reasonCode: z.string().trim().min(2).max(64),
  notes: z.string().trim().max(1000).optional()
});

export const confirmationSchema = z.object({
  result: z.enum(["still_accurate", "changed", "closed"]),
  note: z.string().trim().max(500).optional()
});

export const categoryDefinitions = [
  {
    key: "bench",
    name: "长椅",
    icon: "bench",
    sortOrder: 10,
    detailSchema: {
      seatCount: "number|null",
      hasBackrest: "boolean|null",
      covered: "boolean|null",
      shaded: "boolean|null",
      hasArmrests: "boolean|null",
      wheelchairSpace: "boolean|null",
      material: "string|null",
      damageNotes: "string|null"
    }
  },
  {
    key: "drinking_water",
    name: "饮水处",
    icon: "water",
    sortOrder: 20,
    detailSchema: {
      potable: "yes|no|unknown",
      waterType: "fountain|bottle_filler|tap|unknown",
      bottleFiller: "boolean|null",
      working: "yes|no|unknown",
      seasonal: "boolean|null",
      pressure: "low|normal|high|unknown"
    }
  },
  {
    key: "rain_shelter",
    name: "遮雨棚",
    icon: "shelter",
    sortOrder: 30,
    detailSchema: {
      capacity: "number|null",
      windProtection: "none|partial|strong|unknown",
      seating: "boolean|null",
      flooding: "yes|no|unknown",
      structureNotes: "string|null"
    }
  },
  {
    key: "quiet_corner",
    name: "安静角落",
    icon: "quiet",
    sortOrder: 40,
    detailSchema: {
      seating: "boolean|null",
      powerOutlet: "boolean|null",
      wifi: "boolean|null",
      crowdLevel: "empty|low|medium|high|unknown",
      bestTimes: "string|null",
      suitableFor: "string|null"
    }
  },
  {
    key: "night_lighting",
    name: "夜间照明",
    icon: "light",
    sortOrder: 50,
    detailSchema: {
      brightness: "number|null",
      coverage: "tiny|partial|wide|unknown",
      colorTemperature: "warm|neutral|cold|unknown",
      lightType: "string|null",
      operatingHours: "string|null",
      brokenLights: "number|null",
      safetyFeeling: "number|null"
    }
  }
] as const;

export type FeaturePayload = z.infer<typeof featurePayloadSchema>;
export type PrivacyRegion = z.infer<typeof privacyRegionSchema>;

export function categoryName(key: CategoryKey): string {
  return categoryDefinitions.find((item) => item.key === key)?.name ?? key;
}
