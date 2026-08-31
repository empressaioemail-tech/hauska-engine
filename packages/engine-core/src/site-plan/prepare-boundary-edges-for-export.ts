/**
 * Prepare boundary edges for site-plan export (2026-08-05 edge-role defect
 * fix). `composeSitePlanModelForParcel` loaded stored property-boundary-edge
 * atoms and mapped them by `edgeIndex` WITHOUT the two freshness gates the
 * cert-grade path already runs (`registry/cert-grade-core.ts` lines ~596-627):
 *
 * - R28 (`primitiveNormalsAgreeWithRing` + `recomputeBoundaryEdgesForRing`):
 *   a stored primitive built against one ring winding, applied blindly by
 *   `edgeIndex` to a differently-wound ring, lands each role on the WRONG
 *   physical edge (front on the back of the lot, etc.).
 * - R30 (`labelEdgesFromRoads` + `relabelBoundaryEdgesFromRoadLabels`): a
 *   stored role can predate a later road-labeling improvement (situs-street
 *   match); re-warm must re-derive roles from FRESH labeling, never reuse a
 *   stale role.
 *
 * Live-caught regression (2026-07-29): boundary edges baked from a repealed
 * `descriptor-fixture` source carried 15/0/0 setback feet on a Bastrop SF-1
 * parcel whose card is F25/S5/R25 — the export served the stale scalar
 * because it never re-checked the edges' own source currency. This module
 * adds that check: when the stored edges' `sourceAdapter` is a stale Bastrop
 * city source (`isStaleBastropCitySetbackRule`) or the parcel's jurisdiction
 * only accepts a per-parcel setback record (`requiresPerParcelSetbackRecord`),
 * the per-edge setback VALUE is replaced from the authoritative setback-rule
 * atom, mapped by role — front/rear/side/side_corner (side_corner prefers
 * `sideCornerFt`, side prefers `sideInteriorFt`) — honoring `notSpecified`
 * axes as an honest absence, never a fabricated 0.
 *
 * This module never touches storage itself: the caller loads `storedEdges`,
 * `roads`, and the setback-rule atom exactly as it already does; this is
 * pure re-derivation over those inputs, mirroring cert-grade-core.ts.
 */

import type {
  BoundaryEdgeAtomInstance,
  BoundaryResolvedSetback,
  BoundarySetbackAbsence,
  SetbackRuleAtomInstance,
} from "@hauska-engine/atoms";
import {
  classifySetbackRuleAtom,
  classifyBoundaryEdgeSetback,
  isStaleBastropCitySetbackRule,
  requiresPerParcelSetbackRecord,
} from "@hauska-engine/adapters";

import { openRing, type Ring } from "../depth-warm/geometry.js";
import { labelEdgesFromRoads } from "../depth-warm/edgeLabeling.js";
import type { WarmRoadSource } from "../depth-warm/types.js";
import {
  primitiveNormalsAgreeWithRing,
  recomputeBoundaryEdgesForRing,
} from "../boundary-primitive/recompute-for-ring.js";
import { relabelBoundaryEdgesFromRoadLabels } from "../boundary-primitive/relabel-from-roads.js";
import {
  MixedGenerationBoundaryPrimitiveError,
  selectLiveGeneration,
} from "../boundary-primitive/read.js";
import type { NotSpecifiedAxes } from "./setback-display.js";

export interface PrepareBoundaryEdgesForExportInput {
  parcelNodeId: string;
  /** Stored property-boundary-edge atoms, unsorted/as-loaded. */
  storedEdges: ReadonlyArray<BoundaryEdgeAtomInstance>;
  ringWgs84: Ring;
  /** Attaching road-nodes (as `WarmRoadSource`) for R28 recompute + R30 relabel. */
  roads?: ReadonlyArray<WarmRoadSource>;
  /** Parcel situs address, for R30's situs-street-match front basis. */
  situsAddress?: string | null;
  /** The parcel's setback-rule atom, when one exists — feeds the stale-value refresh. */
  setback?: (SetbackRuleAtomInstance & { sourceCodeAtomRef?: { atomDid?: string } }) | null;
  /** Silent-axis flags (front/side/rear) — never fabricate a value on an axis the code is silent on. */
  notSpecified?: NotSpecifiedAxes | null;
}

export type PrepareBoundaryEdgesDeclineReason =
  | "no-stored-boundary-edges"
  | "boundary-edge-count-below-ring-vertex-count"
  | "boundary-primitive-normals-disagree-after-recompute"
  | "mixed-generation-boundary-edges";

export interface PrepareBoundaryEdgesForExportResult {
  /** Refreshed boundary edges, ready for `boundaryEdgesToGeometryInput`. Null
   * is an honest decline — the caller falls back to its existing no-primitive
   * treatment (front-edge hint or unresolved-front-edge); never a guess. */
  edges: BoundaryEdgeAtomInstance[] | null;
  /** True when R28 rebuilt the primitive against a ring-winding mismatch. */
  recomputedForRingWinding: boolean;
  /** True when R30 re-derived role/facingRoad from fresh road labeling. */
  relabeledFromRoads: boolean;
  /** True when the per-edge setback VALUE was replaced from the authoritative
   * setback-rule atom because the stored edges' own source was stale. */
  setbackValuesRefreshed: boolean;
  reason?: PrepareBoundaryEdgesDeclineReason;
}

function silentAxisReason(axis: "front" | "side" | "rear"): BoundarySetbackAbsence {
  return {
    kind: "no-setback-row",
    reason: `${axis} setback not specified by code (build-to-line governs) — refreshed from setback-rule atom`,
  };
}

/**
 * Resolve the authoritative per-edge setback for `role` from the setback-rule
 * atom. `side_corner` prefers `sideCornerFt`; interior `side` prefers
 * `sideInteriorFt`; both fall back to the flat `side` scalar when the
 * AMENDMENT-2 split fields are absent. Never fabricates a value on a
 * `notSpecified` axis — that axis stays an honest absence.
 */
function resolvedSetbackForRole(
  role: BoundaryEdgeAtomInstance["role"],
  setback: SetbackRuleAtomInstance & { sourceCodeAtomRef?: { atomDid?: string } },
  notSpecified?: NotSpecifiedAxes | null,
): BoundaryResolvedSetback | BoundarySetbackAbsence {
  if (role === "front") {
    if (notSpecified?.front) return silentAxisReason("front");
    return {
      feet: setback.front,
      provenance: "setback-rule-atom-role-refresh",
      atomCitation: setback.sourceCodeAtomRef?.atomDid ?? setback.districtCode,
    };
  }
  if (role === "rear") {
    if (notSpecified?.rear) return silentAxisReason("rear");
    return {
      feet: setback.rear,
      provenance: "setback-rule-atom-role-refresh",
      atomCitation: setback.sourceCodeAtomRef?.atomDid ?? setback.districtCode,
    };
  }
  // side + side_corner share the "side" not-specified axis (SetbackDisplay
  // NotSpecifiedAxes carries no separate corner flag).
  if (notSpecified?.side) return silentAxisReason("side");
  const feet =
    role === "side_corner"
      ? (setback.sideCornerFt ?? setback.side)
      : (setback.sideInteriorFt ?? setback.side);
  return {
    feet,
    provenance: "setback-rule-atom-role-refresh",
    atomCitation: setback.sourceCodeAtomRef?.atomDid ?? setback.districtCode,
  };
}

/**
 * Refresh stored boundary edges for site-plan export consumption. Mirrors
 * cert-grade-core.ts's R28/R30 gates, then (new to this fix) refreshes stale
 * per-edge setback VALUES from the authoritative setback-rule atom when the
 * stored edges' own source is stale for the jurisdiction.
 *
 * Every decline path returns `edges: null` — the honest-absence contract the
 * export already has for a missing primitive (never a per-edge guess).
 */
export async function prepareBoundaryEdgesForExport(
  input: PrepareBoundaryEdgesForExportInput,
): Promise<PrepareBoundaryEdgesForExportResult> {
  if (!input.storedEdges.length) {
    return {
      edges: null,
      recomputedForRingWinding: false,
      relabeledFromRoads: false,
      setbackValuesRefreshed: false,
      reason: "no-stored-boundary-edges",
    };
  }

  // FIX 2 (D2 audit): refuse to serve a blended edge set when the caller's
  // storedEdges span more than one generation (versionStamp). The primary
  // defense is retireStaleBoundaryEdgesAfterPromote at write time (persist.ts);
  // this is the read-side fail-closed backstop so export never silently
  // composes roles/insets from two different promote runs.
  let liveGeneration: ReadonlyArray<BoundaryEdgeAtomInstance>;
  try {
    liveGeneration = selectLiveGeneration(input.storedEdges);
  } catch (err) {
    if (err instanceof MixedGenerationBoundaryPrimitiveError) {
      return {
        edges: null,
        recomputedForRingWinding: false,
        relabeledFromRoads: false,
        setbackValuesRefreshed: false,
        reason: "mixed-generation-boundary-edges",
      };
    }
    throw err;
  }

  let edges: BoundaryEdgeAtomInstance[] | null = [...liveGeneration].sort(
    (a, b) => a.edgeIndex - b.edgeIndex,
  );

  const ringVerts = openRing(input.ringWgs84).length;
  if (edges.length > ringVerts) {
    edges = edges.filter((e) => e.edgeIndex < ringVerts);
  } else if (edges.length < ringVerts) {
    return {
      edges: null,
      recomputedForRingWinding: false,
      relabeledFromRoads: false,
      setbackValuesRefreshed: false,
      reason: "boundary-edge-count-below-ring-vertex-count",
    };
  }

  const roads = input.roads ?? [];

  // R28 — recompute primitive when stored normals disagree with the ring
  // (winding/vintage mismatch would otherwise land roles on the wrong edge).
  let recomputedForRingWinding = false;
  if (edges.length === ringVerts) {
    const agree = primitiveNormalsAgreeWithRing(edges, input.ringWgs84);
    if (!agree.ok) {
      const rebuilt = recomputeBoundaryEdgesForRing({
        storedEdges: edges,
        ring: input.ringWgs84,
        roads,
      });
      const rebuiltAgree = primitiveNormalsAgreeWithRing(rebuilt, input.ringWgs84);
      if (!rebuiltAgree.ok) {
        return {
          edges: null,
          recomputedForRingWinding: false,
          relabeledFromRoads: false,
          setbackValuesRefreshed: false,
          reason: "boundary-primitive-normals-disagree-after-recompute",
        };
      }
      edges = rebuilt;
      recomputedForRingWinding = true;
    }
  }

  // R30 — re-derive role/facingRoad from FRESH road labeling; never reuse a
  // stale stored role. Decline (no roads / no adjacency / unresolved front)
  // leaves the roles as-is (best-available, unchanged).
  let relabeledFromRoads = false;
  const labelResult = labelEdgesFromRoads({
    parcelRing: input.ringWgs84,
    roads,
    situsAddress: input.situsAddress,
  });
  if (labelResult.ok) {
    edges = relabelBoundaryEdgesFromRoadLabels({
      storedEdges: edges,
      edgeLabels: labelResult.edgeLabels,
      roads,
      countyFips: edges[0]!.countyFips,
    });
    relabeledFromRoads = true;
  }

  // Setback VALUE refresh: stored per-edge setback feet can be stale (baked
  // from a repealed/fixture source) independent of the geometry gates above.
  // F-11: a dimensional setback-rule may replace a retired edge stamp.
  // A placeholder rule must not. A road-class-only edge with no dimensional
  // rule refuses — never a road-class substitute.
  let setbackValuesRefreshed = false;
  const ruleVerdict = input.setback
    ? classifySetbackRuleAtom(input.setback)
    : null;
  if (input.setback && ruleVerdict?.disposition === "value") {
    const stale = isStaleBastropCitySetbackRule({
      parcelNodeId: input.parcelNodeId,
      sourceAdapter: edges[0]!.sourceAdapter,
    });
    const perParcelOnly = requiresPerParcelSetbackRecord(edges[0]!.jurisdictionTenant);
    const anyRetiredEdge = edges.some((edge) => {
      const v = classifyBoundaryEdgeSetback(edge.setback);
      return v.disposition === "refused" || v.disposition === "unknown";
    });
    if (stale || perParcelOnly || anyRetiredEdge) {
      const setbackAtom = input.setback;
      edges = edges.map((edge) => ({
        ...edge,
        setback: resolvedSetbackForRole(edge.role, setbackAtom, input.notSpecified),
      }));
      setbackValuesRefreshed = true;
    }
  }

  edges = edges.map((edge) => {
    const edgeVerdict = classifyBoundaryEdgeSetback(edge.setback);
    if (edgeVerdict.disposition === "refused") {
      return {
        ...edge,
        setback: { kind: "no-setback-row" as const, reason: edgeVerdict.basis },
      };
    }
    if (edgeVerdict.disposition === "unknown") {
      return {
        ...edge,
        setback: { kind: "no-setback-row" as const, reason: edgeVerdict.basis },
      };
    }
    return edge;
  });

  return {
    edges,
    recomputedForRingWinding,
    relabeledFromRoads,
    setbackValuesRefreshed,
  };
}
