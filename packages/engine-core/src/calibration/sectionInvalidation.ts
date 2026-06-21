/**
 * F7 — section-plus-dependents calibration invalidation.
 *
 * When a code section changes, invalidate calibration for the section
 * and all sections that depend on it via cross-reference graph edges
 * (inbound cites / subject-to / see-also / as-defined-in).
 */

import type { AtomLink } from "@hauska-engine/atoms";

import { canonicalOverlayAtomKey } from "./overlayAtomKey.js";
import type { CalibrationRepositoryPort } from "./ports.js";

/** Link types that propagate invalidation to citing sections. */
const DEPENDENCY_LINK_TYPES = new Set<AtomLink["linkType"]>([
  "cites",
  "see-also",
  "subject-to",
  "as-defined-in",
  "amends",
]);

/**
 * Compute the section entityId closure: seeds plus all sections that
 * reference (depend on) a seed section through inbound graph edges.
 */
export function computeSectionDependentsClosure(
  seedSectionEntityIds: ReadonlyArray<string>,
  links: ReadonlyArray<AtomLink>,
): ReadonlyArray<string> {
  const closure = new Set(seedSectionEntityIds);
  let expanded = true;

  while (expanded) {
    expanded = false;
    for (const link of links) {
      if (link.toEntityType !== "code-section") continue;
      if (!closure.has(link.toEntityId)) continue;
      if (link.fromEntityType !== "code-section") continue;
      if (!DEPENDENCY_LINK_TYPES.has(link.linkType)) continue;
      if (!closure.has(link.fromEntityId)) {
        closure.add(link.fromEntityId);
        expanded = true;
      }
    }
  }

  return [...closure];
}

export interface SectionInvalidationResult {
  closureSectionEntityIds: ReadonlyArray<string>;
  invalidatedOverlayAtomIds: ReadonlyArray<string>;
}

/**
 * Invalidate calibrated overlay rows for changed sections and their
 * dependents. Moves actuation grain toward section-plus-dependents
 * rather than whole source-set stamp only.
 */
export async function invalidateStaleCalibrationForSectionChange(
  repo: CalibrationRepositoryPort,
  args: {
    edition: string;
    changedSectionEntityIds: ReadonlyArray<string>;
    sectionNumberByEntityId: ReadonlyMap<string, string>;
    links: ReadonlyArray<AtomLink>;
    sourceSetVersion: number;
  },
): Promise<SectionInvalidationResult> {
  const closureSectionEntityIds = computeSectionDependentsClosure(
    args.changedSectionEntityIds,
    args.links,
  );
  const sectionNumbers = new Set<string>();
  for (const entityId of closureSectionEntityIds) {
    const num = args.sectionNumberByEntityId.get(entityId);
    if (num) sectionNumbers.add(num);
  }

  const invalidated = new Set<string>();
  const rows = await repo.listOverlayRows();

  for (const row of rows) {
    if (row.calibratedConfidence == null) continue;
    if (row.edition !== args.edition) continue;

    const matchesSection =
      (row.codeRef != null && sectionNumbers.has(row.codeRef)) ||
      [...closureSectionEntityIds].some(
        (entityId) =>
          canonicalOverlayAtomKey(row.atomId) ===
            canonicalOverlayAtomKey(entityId) ||
          canonicalOverlayAtomKey(row.atomId) ===
            canonicalOverlayAtomKey(
              `did:hauska:code-section:${entityId}`,
            ),
      );

    if (!matchesSection) continue;

    await repo.updateOverlayRowsForAtom(row.atomId, {
      jurisdictionTenant: row.jurisdictionTenant,
      calibrationStale: true,
      calibratedConfidence: null,
      sourceSetVersion: args.sourceSetVersion,
      updatedAt: new Date(),
    });
    invalidated.add(row.atomId);
  }

  return {
    closureSectionEntityIds,
    invalidatedOverlayAtomIds: [...invalidated],
  };
}
