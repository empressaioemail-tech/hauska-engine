/**
 * P-248 — the building-footprint LAYER, as every sheet models it.
 *
 * Before this module the footprint reached a document only as a fact string:
 * "Existing structures" in the feasibility study (`pdf/feasibility.ts`) and a
 * count in the X-ray dossier (`dossier-author.ts`). The geometry existed on the
 * atom (`building-footprint`'s `footprintGeometry`, ML-derived, mostly
 * `verificationStatus: "unsurveyed"`) and nowhere a renderer could reach it, so
 * the operator asked twice why the building on their parcel did not show up on
 * the PDFs.
 *
 * This module is the ONE place the atom becomes a layer:
 *
 *  - the atom → composer input mapping (`footprintsInputFromAtoms`),
 *  - the human wording (§11: no raw machine token on a sheet — `ml-derived`
 *    reads ML-derived, `unsurveyed` is a word and prints as one),
 *  - the legend sentence for each of the layer's three honest states
 *    (present / checked-and-clear / never-checked), including the pointer to
 *    P-159's contradiction treatment when the appraisal record disagrees with a
 *    checked-and-clear miss.
 *
 * `site-model.ts` projects the rings into the shared local-ENU frame and carries
 * them on the model; `pdf/layout.ts` projects them to the page; the renderers
 * draw what the model carries and derive nothing of their own (WDLL 5/6 — the
 * same reason no renderer may recompute a setback).
 */
import { dedupeClosingVertex, type LocalPoint } from "./ring-geometry.js";

/**
 * Structural view of the `building-footprint` atom fields this module reads.
 * Declared locally rather than imported from `@hauska-engine/atoms`, the same
 * idiom `EnvelopeOutcomeInput` uses in `site-model.ts`: the render path must not
 * take the atom contract on as a dependency just to read six fields, and a test
 * can build one of these by hand. Phone it in on the geometry shape and the
 * composer silently drops every MultiPolygon footprint, so both arms the
 * contract declares are modelled here.
 */
export interface FootprintAtomLike {
  entityType?: string;
  footprintId?: string;
  structureRole?: string;
  sourceTier?: string;
  verificationStatus?: string;
  /**
   * The contract's own geometry union: `footprintGeometry` is a GeoJSON Polygon
   * (`coordinates[0]` = exterior ring) OR a MultiPolygon (`coordinates` = one
   * entry per polygon, each holding its own rings). Both arms are modelled here,
   * because a mapper that reads only the Polygon arm drops every MultiPolygon
   * footprint without saying that it did.
   */
  footprintGeometry?:
    | {
        type?: "Polygon";
        coordinates?: ReadonlyArray<ReadonlyArray<readonly [number, number]>>;
      }
    | {
        type: "MultiPolygon";
        coordinates: ReadonlyArray<ReadonlyArray<ReadonlyArray<readonly [number, number]>>>;
      }
    | undefined;
  /** Present on an honest-absence atom (`no-structure`, coverage, etc.). */
  absence?: { kind?: string; reason?: string } | null;
  sourceCitation?: string;
  extractedAt?: string;
}

/** One mapped footprint, in the composer's own frame-agnostic input shape. */
export interface SitePlanFootprintInput {
  footprintId: string;
  structureRole?: string;
  sourceTier?: string;
  verificationStatus?: string;
  /** WGS84 `[lng, lat]` exterior ring, GeoJSON order (may repeat point 0). */
  ringWgs84: Array<[number, number]>;
  /** Interior rings (courtyards). Carried so a hole is never silently filled. */
  innerRingsWgs84?: Array<Array<[number, number]>>;
  sourceCitation?: string;
}

/**
 * The layer's three states, and they are three because "no structure mapped"
 * and "nobody looked" are different findings (D5/P-222's distinction, applied
 * here so the legend cannot read a gap as a vacancy).
 */
export type SitePlanFootprintsInput =
  | {
      kind: "present";
      footprints: ReadonlyArray<SitePlanFootprintInput>;
      sourceCitation?: string;
      asOfIso?: string;
    }
  | { kind: "clear"; reason: string; sourceCitation?: string; asOfIso?: string }
  | { kind: "unchecked"; reason: string };

/** One mapped footprint in the shared local-ENU frame the sheet draws in. */
export interface SitePlanFootprintModel {
  footprintId: string;
  structureRole?: string;
  sourceTier?: string;
  verificationStatus?: string;
  /** Local-ENU metres, exterior ring, same frame as `SitePlanModel.ringLocal`. */
  ringLocal: LocalPoint[];
  innerRingsLocal: LocalPoint[][];
  /** Drawing label — humanised tier + verification status, uppercase (§11). */
  label: string;
  /** The same words for a fact table, sentence case. */
  factLabel: string;
  sourceCitation?: string;
}

export type SitePlanFootprintsModel =
  | {
      kind: "present";
      polygons: ReadonlyArray<SitePlanFootprintModel>;
      sourceCitation?: string;
      asOfIso?: string;
    }
  | { kind: "clear"; reason: string; sourceCitation?: string; asOfIso?: string }
  | { kind: "unchecked"; reason: string };

/** The legend row for a checked-and-clear layer and for a never-checked one.
 * Short by construction: the legend prints them inline on a fixed-width row. */
export const FOOTPRINT_LAYER_CLEAR =
  "none mapped · the footprint source was checked and maps no structure here";

export const FOOTPRINT_LAYER_UNCHECKED =
  "not checked · no footprint mapping has been run for this parcel";

/**
 * The drawing's pointer to P-159's contradiction treatment. The treatment itself
 * is NOT re-worded or re-derived here: `report-model.ts`'s
 * `footprintContradictionConsequence` owns that sentence and the feasibility
 * facts page and the narrative payload in the same document print it. This
 * legend row says only that it applies, so a checked-and-clear miss on an
 * improved parcel cannot read as a vacant lot off the drawing alone.
 */
export const FOOTPRINT_APPRAISAL_CONFLICT_POINTER =
  "contradicted by the appraisal record · see Existing structures";

/**
 * Source tier in words. The atom's tier token (`ml-derived`) is a machine token
 * and §11 keeps those off the sheet; the humanised form is not an
 * interpretation — it is the same tier, spelled for a reader.
 */
export function footprintTierLabel(sourceTier: string | undefined): string {
  switch (sourceTier) {
    case "ml-derived":
      return "ML-derived";
    case "cad-authoritative":
      return "CAD-attributed";
    case undefined:
    case "":
      return "source tier not stated";
    default:
      return sourceTier;
  }
}

/**
 * Verification status in words. `unsurveyed` is the dispatch's own word for what
 * an ML-derived footprint IS — a polygon no licensed surveyor has confirmed —
 * and it prints as itself rather than being softened or dropped, because a
 * reader making a demolition decision needs to know nobody measured it.
 */
export function footprintVerificationLabel(verificationStatus: string | undefined): string {
  switch (verificationStatus) {
    case "unsurveyed":
      return "unsurveyed";
    case "machine":
      return "machine-checked, not a survey";
    case "human":
      return "human-checked";
    case undefined:
    case "":
      return "verification status not stated";
    default:
      return verificationStatus;
  }
}

/** Role in words; absent role reads as a plain structure, never as a guess. */
export function footprintRoleLabel(structureRole: string | undefined): string {
  switch (structureRole) {
    case "primary":
    case undefined:
    case "":
      return "existing structure";
    case "accessory":
      return "existing structure (accessory)";
    case "unknown":
      return "existing structure (role not stated)";
    default:
      return `existing structure (${structureRole})`;
  }
}

/** Fact-table label: "Primary structure · ML-derived · unsurveyed". */
export function footprintFactLabel(footprint: {
  structureRole?: string;
  sourceTier?: string;
  verificationStatus?: string;
}): string {
  return [
    footprintRoleLabel(footprint.structureRole),
    footprintTierLabel(footprint.sourceTier),
    footprintVerificationLabel(footprint.verificationStatus),
  ].join(" · ");
}

/** Drawing label: the fact label, uppercase — the sheet's own register for
 * annotation (§4/§11), never a second wording. */
export function footprintSheetLabel(footprint: {
  structureRole?: string;
  sourceTier?: string;
  verificationStatus?: string;
}): string {
  return footprintFactLabel(footprint).toUpperCase();
}

function isUsableRing(ring: ReadonlyArray<readonly [number, number]> | undefined): boolean {
  if (!ring || ring.length < 3) return false;
  // Three distinct vertices is the minimum an area can be drawn from, whether or
  // not the ring carries GeoJSON's repeated closing point.
  const distinct = new Set(ring.map(([lng, lat]) => `${lng},${lat}`));
  return distinct.size >= 3;
}

/**
 * Every drawable polygon on one atom — one for a Polygon, one per member for a
 * MultiPolygon. Ids stay stable and unique: the atom's `footprintId` for the
 * first, a `#n` suffix for the rest (the label prints the ROLE and the tier, so
 * the suffix never reaches a sheet — it exists so two polygons of one atom are
 * two marks, not one drawn twice).
 */
function atomPolygons(atom: FootprintAtomLike): Array<{
  footprintId: string;
  ringWgs84: Array<[number, number]>;
  innerRingsWgs84: Array<Array<[number, number]>>;
}> {
  const geometry = atom.footprintGeometry;
  if (!geometry) return [];
  const baseId = atom.footprintId ?? "footprint";

  const ringOf = (ring: ReadonlyArray<readonly [number, number]>): Array<[number, number]> =>
    ring.map(([lng, lat]) => [lng, lat] as [number, number]);

  const polygons: ReadonlyArray<ReadonlyArray<ReadonlyArray<readonly [number, number]>>> =
    geometry.type === "MultiPolygon" ? geometry.coordinates : [geometry.coordinates ?? []];

  return polygons
    .map((rings, index) => {
      const exterior = rings[0];
      if (!isUsableRing(exterior)) return null;
      const holes = rings.slice(1).filter((ring) => isUsableRing(ring));
      return {
        footprintId: index === 0 ? baseId : `${baseId}#${index + 1}`,
        ringWgs84: ringOf(exterior!),
        innerRingsWgs84: holes.map(ringOf),
      };
    })
    .filter((polygon): polygon is NonNullable<typeof polygon> => polygon !== null);
}

/**
 * The parcel's building-footprint atoms → the composer's input.
 *
 * Present atoms win. With none, an honest-absence atom on the parcel means the
 * source WAS checked and maps nothing here; no absence atom at all means nobody
 * has run the footprint mapping for this parcel. Those two never collapse into
 * one state — that collapse is the defect D5 fixed in the fact composer, and the
 * drawing is not allowed to reintroduce it on its own legend.
 *
 * Geometry that cannot be drawn (fewer than three distinct vertices, a
 * degenerate ring) is skipped rather than approximated: a footprint the sheet
 * cannot draw must not become a footprint the sheet claims.
 */
export function footprintsInputFromAtoms(
  atoms: ReadonlyArray<FootprintAtomLike>,
): SitePlanFootprintsInput {
  const present = atoms
    .filter((atom) => atom.entityType === "building-footprint" && !atom.absence)
    .flatMap((atom) =>
      atomPolygons(atom).map((polygon) => ({ atom, polygon })),
    );

  if (present.length > 0) {
    return {
      kind: "present",
      footprints: present.map(({ atom, polygon }) => ({
        footprintId: polygon.footprintId,
        ...(atom.structureRole ? { structureRole: atom.structureRole } : {}),
        ...(atom.sourceTier ? { sourceTier: atom.sourceTier } : {}),
        ...(atom.verificationStatus ? { verificationStatus: atom.verificationStatus } : {}),
        ringWgs84: polygon.ringWgs84,
        ...(polygon.innerRingsWgs84.length > 0
          ? { innerRingsWgs84: polygon.innerRingsWgs84 }
          : {}),
        ...(atom.sourceCitation ? { sourceCitation: atom.sourceCitation } : {}),
      })),
      ...(present[0]!.atom.sourceCitation ? { sourceCitation: present[0]!.atom.sourceCitation } : {}),
      ...(present[0]!.atom.extractedAt ? { asOfIso: present[0]!.atom.extractedAt } : {}),
    };
  }

  const checked = atoms.find(
    (atom) => atom.entityType === "building-footprint" && atom.absence != null,
  );
  return checked
    ? {
        kind: "clear",
        reason: FOOTPRINT_LAYER_CLEAR,
        ...(checked.sourceCitation ? { sourceCitation: checked.sourceCitation } : {}),
        ...(checked.extractedAt ? { asOfIso: checked.extractedAt } : {}),
      }
    : { kind: "unchecked", reason: FOOTPRINT_LAYER_UNCHECKED };
}

/**
 * The layer's ONE legend sentence. Read by the drawing sheet's legend and by the
 * aerial sheet's — two legends, one wording, so the two sheets of one document
 * cannot describe the same layer differently.
 */
export function footprintLayerLegendLabel(
  layer: SitePlanFootprintsModel,
  contradictsAppraisal = false,
): { label: string; empty: boolean } {
  if (layer.kind === "present") {
    const phrases = [
      ...new Set(
        layer.polygons.map(
          (p) => `${footprintTierLabel(p.sourceTier)}, ${footprintVerificationLabel(p.verificationStatus)}`,
        ),
      ),
    ];
    const count = layer.polygons.length;
    return {
      label: `${count === 1 ? "Existing structure" : `Existing structures · ${count} mapped`} · ${phrases.join("; ")}`,
      empty: false,
    };
  }
  const conflict = layer.kind === "clear" && contradictsAppraisal;
  return {
    label: `Existing structure — ${layer.reason}${conflict ? ` · ${FOOTPRINT_APPRAISAL_CONFLICT_POINTER}` : ""}`,
    empty: true,
  };
}

/**
 * Atom → model. `project` is the composer's own WGS84→local-ENU projection, so
 * the footprint rings land in the exact frame the parcel ring does and the
 * drawing needs no second transform.
 */
export function composeFootprintsModel(
  input: SitePlanFootprintsInput | undefined,
  project: (lng: number, lat: number) => LocalPoint,
): SitePlanFootprintsModel {
  if (!input) {
    // The caller never looked: never claimed as checked, never drawn.
    return { kind: "unchecked", reason: FOOTPRINT_LAYER_UNCHECKED };
  }
  if (input.kind !== "present") return input;

  const polygons = input.footprints
    .map((footprint) => ({
      footprintId: footprint.footprintId,
      ...(footprint.structureRole ? { structureRole: footprint.structureRole } : {}),
      ...(footprint.sourceTier ? { sourceTier: footprint.sourceTier } : {}),
      ...(footprint.verificationStatus ? { verificationStatus: footprint.verificationStatus } : {}),
      ringLocal: dedupeClosingVertex(
        footprint.ringWgs84.map(([lng, lat]) => project(lng, lat)),
      ),
      innerRingsLocal: (footprint.innerRingsWgs84 ?? []).map((ring) =>
        dedupeClosingVertex(ring.map(([lng, lat]) => project(lng, lat))),
      ),
      label: footprintSheetLabel(footprint),
      factLabel: footprintFactLabel(footprint),
      ...(footprint.sourceCitation ? { sourceCitation: footprint.sourceCitation } : {}),
    }))
    .filter((polygon) => polygon.ringLocal.length >= 3);

  return polygons.length > 0
    ? {
        kind: "present",
        polygons,
        ...(input.sourceCitation ? { sourceCitation: input.sourceCitation } : {}),
        ...(input.asOfIso ? { asOfIso: input.asOfIso } : {}),
      }
    : { kind: "clear", reason: FOOTPRINT_LAYER_CLEAR };
}
