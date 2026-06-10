import { canonicalOverlayAtomKey } from "./overlayAtomKey.js";
import type { CalibrationRepositoryPort } from "./ports.js";
import type { AttributionCoverageHealth } from "./types.js";

function isCodeSectionCitation(
  c: unknown,
): c is { kind: "code-section"; atomId: string } {
  return (
    typeof c === "object" &&
    c !== null &&
    (c as { kind?: unknown }).kind === "code-section" &&
    typeof (c as { atomId?: unknown }).atomId === "string" &&
    (c as { atomId: string }).atomId.length > 0
  );
}

export async function computeAttributionCoverage(
  repo: CalibrationRepositoryPort,
  options?: {
    jurisdictionTenant?: string | null;
  },
): Promise<AttributionCoverageHealth> {
  const tenantFilter = (options?.jurisdictionTenant ?? "").trim() || null;
  const findingRows = await repo.loadFindingCitations();

  const overlayRows = await repo.listOverlayRows();

  const overlayKeys = new Set(
    overlayRows.map((r) => `${r.jurisdictionTenant}\0${r.atomId}`),
  );

  let citationsResolved = 0;
  let overlayHits = 0;
  const misses: Array<{ atomId: string; jurisdictionTenant: string }> = [];

  for (const row of findingRows) {
    if (!Array.isArray(row.citations)) continue;
    for (const c of row.citations) {
      if (!isCodeSectionCitation(c)) continue;
      citationsResolved += 1;
      const atomId = canonicalOverlayAtomKey(c.atomId);
      const tenantsToCheck = tenantFilter
        ? [tenantFilter, "__public__"]
        : [...new Set(overlayRows.map((r) => r.jurisdictionTenant))];
      let hit = false;
      for (const tenant of tenantsToCheck) {
        if (overlayKeys.has(`${tenant}\0${atomId}`)) {
          hit = true;
          break;
        }
      }
      if (hit) {
        overlayHits += 1;
      } else {
        misses.push({
          atomId,
          jurisdictionTenant: tenantFilter ?? "__unknown__",
        });
      }
    }
  }

  return {
    citationsResolved,
    overlayHits,
    attributionCoverageRate:
      citationsResolved > 0 ? overlayHits / citationsResolved : null,
    misses: misses.slice(0, 50),
  };
}
