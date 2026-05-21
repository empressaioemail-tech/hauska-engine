/**
 * Effective-rule composition — ADR-019 Layer 1 + Layer 2.
 *
 * The effective rule for a jurisdiction is the shared Layer 1 model-code
 * base section composed with that jurisdiction's Layer 2 overlay
 * amendments. Per the ADR-019 §Open decision 4 resolution, composition
 * is a query-time merge: a pure function over atoms already in storage,
 * not a materialized per-jurisdiction effective-section atom. This
 * avoids staleness and per-jurisdiction atom-count multiplication; the
 * ADR-019 reversal criterion (materialize if retrieval finds the merge
 * unworkable) stands.
 *
 * `composeEffectiveSection` is the pure algorithm. `resolveEffectiveRule`
 * is the storage-backed wrapper that fetches the base section and the
 * jurisdiction's overlays, then composes.
 */

import type {
  CodeSectionAtomInstance,
  JurisdictionalOverlayAmendmentInstance,
  OverlayOperation,
} from "@hauska-engine/atoms";
import type { StoragePort } from "@hauska-engine/storage";

/** How a section resolves for a jurisdiction once overlays are applied. */
export type EffectiveSectionResolution =
  | "base-only" // adopted unmodified
  | "modified" // base section plus local modifications
  | "replaced" // base section wholly superseded by local text
  | "added" // local section with no model-code parent
  | "deleted"; // base section struck (not adopted)

/** Maps an overlay operation to the resolution it produces. */
const OPERATION_RESOLUTION: Record<OverlayOperation, EffectiveSectionResolution> =
  {
    modify: "modified",
    replace: "replaced",
    add: "added",
    delete: "deleted",
  };

/**
 * The composed effective rule for one section in one jurisdiction. On
 * the ADR-019 interim deep-link footing, the base verbatim text is
 * deep-linked, not hosted; `baseTextGoverns` tells a consumer whether
 * that deep-linked text is still authoritative or has been superseded.
 */
export interface EffectiveSection {
  jurisdictionTenant: string;
  /**
   * The Layer 1 base section. Null for a pure local addition, or when
   * the base section could not be resolved from storage.
   */
  baseSection: CodeSectionAtomInstance | null;
  /** The Layer 1 base `code-edition` entityId the rule resolves against. */
  baseEditionId: string | null;
  /** Overlays applied, ascending by `effectiveDate`. */
  overlays: ReadonlyArray<JurisdictionalOverlayAmendmentInstance>;
  resolution: EffectiveSectionResolution;
  /**
   * True when the Layer 1 base verbatim text still governs (the
   * deep-link target remains authoritative). False once any overlay
   * replaces or deletes the section, and for a pure local addition.
   */
  baseTextGoverns: boolean;
  /** One-line human-readable composition summary. */
  compositionNote: string;
}

function describeBase(section: CodeSectionAtomInstance | null): string {
  if (!section) return "(no base section)";
  return `§${section.sectionNumber} ${section.title}`.trim();
}

function buildNote(
  jurisdictionTenant: string,
  baseSection: CodeSectionAtomInstance | null,
  overlays: ReadonlyArray<JurisdictionalOverlayAmendmentInstance>,
  resolution: EffectiveSectionResolution,
): string {
  const base = describeBase(baseSection);
  if (overlays.length === 0) {
    return `${base} adopted by ${jurisdictionTenant} without local amendment.`;
  }
  const latest = overlays[overlays.length - 1]!;
  const count =
    overlays.length === 1 ? "1 overlay" : `${overlays.length} overlays`;
  return (
    `${base}: ${resolution} for ${jurisdictionTenant} by ${count} ` +
    `(latest: ordinance ${latest.ordinanceId}, ${latest.overlayOperation}, ` +
    `effective ${latest.effectiveDate}).`
  );
}

/**
 * Compose a Layer 1 base section with a jurisdiction's Layer 2 overlays
 * into the effective rule. Pure: deterministic over its inputs, no I/O.
 *
 * Composition model (v1): overlays apply in `effectiveDate` order. The
 * latest overlay's operation drives `resolution`. The base verbatim
 * text stops governing once any overlay in the chain replaces or
 * deletes the section.
 */
export function composeEffectiveSection(input: {
  jurisdictionTenant: string;
  baseSection: CodeSectionAtomInstance | null;
  baseEditionId?: string | null;
  overlays: ReadonlyArray<JurisdictionalOverlayAmendmentInstance>;
}): EffectiveSection {
  const overlays = [...input.overlays].sort((a, b) =>
    a.effectiveDate.localeCompare(b.effectiveDate),
  );
  const baseEditionId =
    input.baseEditionId ?? input.baseSection?.codeEditionId ?? null;

  if (overlays.length === 0) {
    return {
      jurisdictionTenant: input.jurisdictionTenant,
      baseSection: input.baseSection,
      baseEditionId,
      overlays: [],
      resolution: "base-only",
      baseTextGoverns: input.baseSection !== null,
      compositionNote: buildNote(
        input.jurisdictionTenant,
        input.baseSection,
        [],
        "base-only",
      ),
    };
  }

  const latest = overlays[overlays.length - 1]!;
  const resolution = OPERATION_RESOLUTION[latest.overlayOperation];
  const hasReplaceOrDelete = overlays.some(
    (o) => o.overlayOperation === "replace" || o.overlayOperation === "delete",
  );
  const baseTextGoverns =
    input.baseSection !== null &&
    !hasReplaceOrDelete &&
    resolution !== "added";

  return {
    jurisdictionTenant: input.jurisdictionTenant,
    baseSection: input.baseSection,
    baseEditionId,
    overlays,
    resolution,
    baseTextGoverns,
    compositionNote: buildNote(
      input.jurisdictionTenant,
      input.baseSection,
      overlays,
      resolution,
    ),
  };
}

/**
 * Storage-backed effective-rule resolution. Fetches the Layer 1 base
 * section and the jurisdiction's overlays targeting it, then composes.
 * This is the entry point a "what does the IRC require for X in
 * jurisdiction Y" query resolves through.
 */
export async function resolveEffectiveRule(
  storage: StoragePort,
  input: { jurisdictionTenant: string; baseSectionId: string },
): Promise<EffectiveSection> {
  const baseSection = await storage.getAtom(
    "code-section",
    input.baseSectionId,
  );
  const overlays = await storage.getJurisdictionalOverlays(
    input.jurisdictionTenant,
    input.baseSectionId,
  );
  return composeEffectiveSection({
    jurisdictionTenant: input.jurisdictionTenant,
    baseSection,
    overlays,
  });
}
