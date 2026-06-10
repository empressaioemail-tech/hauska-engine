/**
 * Track 1 — PlanReviewDiscipline enum (lifted from @workspace/api-zod).
 */

export const PLAN_REVIEW_DISCIPLINE_VALUES = [
  "building",
  "electrical",
  "mechanical",
  "plumbing",
  "residential",
  "fire-life-safety",
  "accessibility",
] as const;

export type PlanReviewDiscipline =
  (typeof PLAN_REVIEW_DISCIPLINE_VALUES)[number];

export function isPlanReviewDiscipline(
  v: unknown,
): v is PlanReviewDiscipline {
  return (
    typeof v === "string" &&
    (PLAN_REVIEW_DISCIPLINE_VALUES as readonly string[]).includes(v)
  );
}
