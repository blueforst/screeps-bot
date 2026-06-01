/**
 * Shared config normalization helpers.
 * Extracted from synthesisControl, resourceControl, and synthesisCompatibilityPlanning
 * to avoid triple duplication while preserving identical semantics.
 */

export function normalizeNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  const normalized = Math.floor(value);
  return Math.max(min, Math.min(max, normalized));
}

export function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function normalizeRoomNameList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}
