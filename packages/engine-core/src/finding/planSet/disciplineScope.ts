/**
 * Per-discipline code-section scoping for specialist finding passes (WS1).
 */

import type { PlanReviewDiscipline } from "../../types/planReviewDiscipline.js";
import type { CodeSectionInput } from "../types";

/** Retrieval query suffix appended per discipline specialist pass. */
export const DISCIPLINE_RETRIEVAL_QUERY: Readonly<
  Record<PlanReviewDiscipline, string>
> = {
  building:
    "Building code compliance: setbacks, height, coverage, use, site plan, structural coordination, IBC.",
  electrical:
    "Electrical code compliance: NEC, panel schedules, circuits, lighting, power distribution.",
  mechanical:
    "Mechanical code compliance: HVAC, ventilation, ductwork, equipment schedules, IECC energy.",
  plumbing:
    "Plumbing code compliance: sanitary, domestic water, venting, fixture counts, IPC.",
  residential:
    "Residential code compliance: IRC dwelling provisions, sleeping areas, egress, smoke alarms.",
  "fire-life-safety":
    "Fire and life safety: IFC, NFPA, sprinklers, alarms, egress, fire separation, rated assemblies.",
  accessibility:
    "Accessibility compliance: ADA, A117.1, FHA design manual, accessible routes, clearances, grab bars.",
};

const DISCIPLINE_LABEL_PATTERNS: Readonly<
  Record<PlanReviewDiscipline, readonly RegExp[]>
> = {
  building: [
    /\bibc\b/i,
    /\bsetback\b/i,
    /\bheight\b/i,
    /\bcoverage\b/i,
    /\buse\b/i,
    /\bstructural\b/i,
    /\bsite\b/i,
    /\bzoning\b/i,
  ],
  electrical: [/\bnec\b/i, /\belectrical\b/i, /\blighting\b/i, /\bpower\b/i],
  mechanical: [/\biecc\b/i, /\bmechanical\b/i, /\bhvac\b/i, /\bvent/i],
  plumbing: [/\bipc\b/i, /\bplumb/i, /\bsanitary\b/i, /\bwater\b/i],
  residential: [/\birc\b/i, /\bresidential\b/i, /\bdwelling\b/i],
  "fire-life-safety": [
    /\bifc\b/i,
    /\bnfpa\b/i,
    /\bfire\b/i,
    /\bsprinkler\b/i,
    /\begress\b/i,
  ],
  accessibility: [
    /\bada\b/i,
    /\ba117/i,
    /\baccessib/i,
    /\bfha\b/i,
    /\bgrab bar\b/i,
  ],
};

/**
 * Filter the jurisdiction's retrieved code atoms down to those likely
 * relevant to a discipline specialist pass. When nothing matches, return
 * the original list so the specialist can still cite briefing sources.
 */
export function filterCodeSectionsForDiscipline(
  discipline: PlanReviewDiscipline,
  codeSections: ReadonlyArray<CodeSectionInput>,
): CodeSectionInput[] {
  if (codeSections.length === 0) return [];
  const patterns = DISCIPLINE_LABEL_PATTERNS[discipline];
  const filtered = codeSections.filter((c) => {
    const haystack = `${c.label} ${c.snippet ?? ""}`;
    return patterns.some((p) => p.test(haystack));
  });
  return filtered.length > 0 ? filtered : [...codeSections];
}

/** Build the specialist retrieval query for a discipline pass. */
export function disciplineRetrievalQuery(
  discipline: PlanReviewDiscipline,
  baseQuery: string,
): string {
  const suffix = DISCIPLINE_RETRIEVAL_QUERY[discipline];
  return `${baseQuery.trim()}\n\nDiscipline scope: ${suffix}`;
}
