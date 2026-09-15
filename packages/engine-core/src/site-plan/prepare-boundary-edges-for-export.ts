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
} from "@hauska-engine/atoms";
import {
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
  /**
   * P-219 — the RESOLVED setback authority for this parcel, not the raw
   * persisted atom. The caller resolves it once (`resolveExportSetback`) so
   * the per-edge values and the values the sheet prints cannot diverge, and so
   * a retired provenance is declined in one place rather than at every
   * consumer. Omitted/null means there is nothing to refresh from and the
   * stored per-edge values stand.
   */
  setback?: ExportSetbackAuthority | null;
  /** Silent-axis flags (front/side/rear/corner) — never fabricate a value on an axis the code is silent on. */
  notSpecified?: NotSpecifiedAxes | null;
}

/**
 * The narrow shape this module needs from a resolved setback authority. Kept
 * structural (rather than importing `ExportSetbackResolution`) so the refresh
 * stays testable with a literal and does not pull the resolver's dependency
 * graph into the geometry path.
 */
export interface ExportSetbackAuthority {
  front: number;
  side: number;
  rear: number;
  /** Corner-side yard, or null when the district publishes none. */
  cornerFt: number | null;
  /** What the per-edge `provenance` stamp reads, e.g. "parcel-record-rails". */
  provenance: string;
  /** The DID or table id the values rest on, stamped as each edge's citation. */
  sourceCodeAtomDid?: string | null;
  districtCode?: string | null;
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

function silentAxisReason(
  axis: "front" | "side" | "rear" | "corner side",
): BoundarySetbackAbsence {
  return {
    kind: "no-setback-row",
    reason: `${axis} setback not specified by code (build-to-line governs) — refreshed from the resolved setback authority`,
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
  setback: ExportSetbackAuthority,
  notSpecified?: NotSpecifiedAxes | null,
): BoundaryResolvedSetback | BoundarySetbackAbsence {
  const citation = setback.sourceCodeAtomDid ?? setback.districtCode ?? "";
  const provenance = setback.provenance;
  if (role === "front") {
    if (notSpecified?.front) return silentAxisReason("front");
    return { feet: setback.front, provenance, atomCitation: citation };
  }
  if (role === "rear") {
    if (notSpecified?.rear) return silentAxisReason("rear");
    return { feet: setback.rear, provenance, atomCitation: citation };
  }
  if (role === "side_corner") {
    // P-219 — the corner-side axis is resolved and silenced on its OWN flag.
    // It used to share the interior-side flag and fall back to the interior
    // value whenever no corner number was on hand, which is how 48021:34049's
    // corner line was drawn and labelled at 5 ft for months while the ruled
    // table published 20. A district with no corner value is an ABSENCE here,
    // never the side number wearing a corner label.
    if (notSpecified?.sideCorner) return silentAxisReason("corner side");
    if (setback.cornerFt == null) {
      return {
        kind: "no-setback-row",
        reason:
          "corner-side setback not published for this district — the interior-side value is not a corner-side value and is not substituted",
      };
    }
    return { feet: setback.cornerFt, provenance, atomCitation: citation };
  }
  if (notSpecified?.side) return silentAxisReason("side");
  return { feet: setback.side, provenance, atomCitation: citation };
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
  //
  // P-219 — what this refreshes FROM changed, and that is the whole fix. It
  // used to take the persisted setback-rule atom verbatim, which on
  // 48021:34049 meant overwriting correct stored edges (rear 30, side_corner
  // 20, front 30, side 10, provenance "district-setback-table") with the
  // atom's 25/5/25 minted off the city's unrefreshed numeric columns. The
  // freshness gate built in 2026-08-05 to STOP a stale value was, by then, the
  // component injecting one. It now refreshes from the caller's single
  // resolved authority, which declines a retired provenance before it ever
  // reaches this line. The F-11 placeholder check moved with it: the resolver
  // classifies the atom, so a placeholder never becomes an authority.
  let setbackValuesRefreshed = false;
  if (input.setback) {
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
      const authority = input.setback;
      edges = edges.map((edge) => ({
        ...edge,
        setback: resolvedSetbackForRole(edge.role, authority, input.notSpecified),
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
