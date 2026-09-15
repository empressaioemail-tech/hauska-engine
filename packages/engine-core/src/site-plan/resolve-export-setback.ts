/**
 * P-219 — the ONE setback authority for the document surfaces.
 *
 * Before this module, the site-plan / feasibility / dossier exports took their
 * setback truth from the persisted `setback-rule` property atom, whatever it
 * happened to say. For `48021:34049` (1109 Pecan St, Bastrop, SF-1, a CORNER
 * lot) that atom had been minted from the City of Bastrop One Click join
 * (`Parcels_One_Click/FeatureServer/23`), whose numeric shortcut columns were
 * never refreshed after Ordinance 2026-06 repealed the B3 Place Types on
 * 2026-04-14. Both PDF products therefore printed, live on 2026-09-15:
 *
 *     Setbacks  25 / 5 / 25 ft -- source: Setback rule for SF-1 cited to
 *     bastrop-per-parcel/34049/front, cited ... ORDINANCE NO. 2019-51 ...
 *
 * beside a site plan labelling the parcel's CORNER-side line "SIDE 5' (TYP.)",
 * while `setbackRulesFact` and the parcel_record rails served 30 / 10 / 30
 * with a 20 ft corner side, cited to Ordinance 2026-06.
 *
 * ## Precedence, and why it is this order
 *
 * 1. **The parcel_record rails, through the one reader** (OPS-23 §0: one
 *    reader in `hauska-engine/services/retrieval-api` and every surface
 *    consumes it). `setbackFrontFt`, `setbackSideFt`, `setbackRearFt` and
 *    `setbackCornerFt` are the exact rails `setbackRulesFact` is rendered
 *    from, so reading them is reading the same fact the facet reads, not a
 *    second derivation of it. Gated strictly on `serve === "record"` by
 *    `recordScalarNumber`.
 * 2. **The ruled corpus row**, resolved through `getSetbackTableForZoning`
 *    under R-1 (most-current source wins). This is not a second source: the
 *    rails' own values were composed from this same corpus row, which is why
 *    `setbackRulesFact.resolvedTableKey` reads `bastrop-development-code` and
 *    its `note` is that row's `note` verbatim. It exists because the reader is
 *    a network call that must never fail a report (`recordReaderFromEnv`
 *    returns undefined when unconfigured, and a fetch can fail), and because
 *    the citation, district name and effective date a sheet prints live on the
 *    corpus row rather than on the four scalar rails.
 * 3. **The persisted setback-rule atom**, and ONLY when its provenance is not
 *    retired (`isRetiredSetbackProvenance`). This is the pre-P-219 behaviour,
 *    kept for every jurisdiction that has no ruled table.
 * 4. **Honest absence.** No fabricated dimension, ever.
 *
 * When 1 and 2 are both available and DISAGREE on a value, the rails win (the
 * ledger is the serving path) and the divergence is carried on
 * `railCorpusDivergence` so a caller can surface it instead of rounding it
 * off. Two numbers that should agree and do not is a free finding
 * (DEV_PROCESS 1.4); this module refuses to discard one of them silently.
 *
 * ## Corner
 *
 * `cornerFt` is a first-class axis here. The old model carried front / side /
 * rear only, so a corner lot's corner-side line could only ever be drawn at
 * the interior-side value — which is exactly the defect P-214's customer saw
 * ("expected 5ft for role side" on edge 1, a `side_corner` edge). A district
 * with no corner value keeps `cornerFt: null`; nothing is invented for it.
 */

import {
  getSetbackTable,
  getSetbackTableForZoning,
  isRetiredSetbackProvenance,
  RETIRED_SETBACK_DECLINE_REASON,
  type SetbackDistrict,
  type SetbackSecondSourceConflict,
  type SetbackTable,
} from "@hauska-engine/adapters";
import type { SetbackRuleAtomInstance } from "@hauska-engine/atoms";

import {
  recordScalarNumber,
  type ParcelRecordResponse,
  type RecordReaderClient,
} from "./parcel-record-reader-client.js";
import type { NotSpecifiedAxes } from "./setback-display.js";

/** Where the values a sheet prints actually came from. Printed, not inferred. */
export type ExportSetbackProvenanceKind =
  | "parcel-record-rails"
  | "ruled-setback-table"
  | "setback-rule-atom"
  | "honest-absence";

export interface ExportSetbackResolution {
  provenanceKind: ExportSetbackProvenanceKind;
  /** Honest absence: no axis is fabricated and every inset is zero. */
  honestAbsence: boolean;
  honestAbsenceReason?: string;
  front: number;
  side: number;
  rear: number;
  /** Corner-side yard, or null when the district publishes none. */
  cornerFt: number | null;
  /** Silent axes (the code is silent; build-to-line governs). */
  notSpecified?: NotSpecifiedAxes;
  /** The atom DID (or table id) the values rest on, for the sheet's citation. */
  sourceCodeAtomDid: string;
  sourceLabel: string | null;
  sourceCitation: string | null;
  sourceDate: string | null;
  dateBasis: string | null;
  districtCode: string | null;
  conflict?: SetbackSecondSourceConflict | null;
  /**
   * Present when the rails and the ruled corpus row disagreed on a scalar.
   * The rails are followed; this names what the corpus said, so the
   * disagreement is disclosed rather than discarded.
   */
  railCorpusDivergence?: {
    axis: Array<"front" | "side" | "rear" | "corner">;
    rails: { front: number; side: number; rear: number; corner: number | null };
    corpus: { front: number; side: number; rear: number; corner: number | null };
  };
  /**
   * Present when a persisted atom was REFUSED because its provenance is
   * retired. Carried so the close (and any surface that wants it) can prove
   * the retirement fired by decline rather than by documentation.
   */
  retiredAtomDeclined?: { atomDid: string; reason: string };
  /**
   * P-219 / D2 — present when a persisted setback-rule atom exists for this
   * parcel and the values this resolution followed DIFFER from the ones that
   * atom carries. Anything else derived from that atom — most importantly the
   * buildable-envelope atom and the area figure on both PDF covers — was baked
   * against setbacks this export no longer follows, and is stale by
   * construction rather than by arithmetic. Carries the axes, never a fresh
   * number to print.
   */
  supersededAtom?: {
    atomDid: string;
    axes: Array<"front" | "side" | "rear" | "corner">;
  };
}

function leadingDistrictToken(districtName: string): string {
  return (districtName.trim().split(/\s+/)[0] ?? "").toUpperCase();
}

/** Bastrop County parcels, the only ones the `bastrop-tx` routing key may serve. */
const BASTROP_COUNTY_FIPS = "48021";

/**
 * The ruled corpus row for this district, or null. Never throws.
 *
 * The `bastrop-tx` routing key is tried as a SECOND key because Bastrop city
 * parcels are stamped with it while their BDC rows live under
 * `bastrop-development-code` — the same two-key walk
 * `notSpecifiedAxesFromSetbackTable` already does. It is gated on the parcel
 * actually being in Bastrop County: without that gate, a parcel anywhere in
 * Texas stamped "SF-1" with no jurisdiction key would be handed Bastrop's
 * SF-1 numbers, which is a silent fallback of exactly the class this program
 * hunts. Caught by this lane's own test fixture rather than in the field.
 */
function ruledKeys(
  parcelNodeId: string,
  jurisdictionKey: string | null | undefined,
): string[] {
  const inBastropCounty = parcelNodeId.trim().startsWith(`${BASTROP_COUNTY_FIPS}:`);
  return [
    jurisdictionKey,
    inBastropCounty ? "bastrop-tx" : null,
    inBastropCounty ? "bastrop-development-code" : null,
  ].filter((k): k is string => typeof k === "string" && k.trim().length > 0);
}

function rowIn(
  table: SetbackTable | null | undefined,
  districtCode: string,
): SetbackDistrict | null {
  if (!table) return null;
  const wanted = leadingDistrictToken(districtCode);
  return table.districts.find((d) => leadingDistrictToken(d.district_name) === wanted) ?? null;
}

/**
 * The row whose SCALARS may be served, under every routing rule that governs
 * it — R13 (AMENDMENT 8) included, which returns null for a Bastrop city BDC
 * district when no layer-23 per-parcel record is in hand. Never throws.
 */
function ruledScalarRow(
  parcelNodeId: string,
  jurisdictionKey: string | null | undefined,
  districtCode: string | null | undefined,
) {
  if (!districtCode?.trim()) return null;
  for (const key of ruledKeys(parcelNodeId, jurisdictionKey)) {
    let resolution;
    try {
      resolution = getSetbackTableForZoning(key, districtCode);
    } catch {
      continue;
    }
    const table = resolution?.table;
    const district = rowIn(table, districtCode);
    if (!table || !district) continue;
    return { table, district, resolution };
  }
  return null;
}

/**
 * The row a sheet may CITE: its jurisdiction display name, its ordinance
 * citation and its effective date. Read through `getSetbackTable`, the direct
 * key lookup R13 explicitly leaves open for "edition/citation lookup" even
 * where it forbids serving that row's scalars. This is what lets a sheet whose
 * NUMBERS came from the parcel_record rails still print the ordinance those
 * numbers rest on, instead of a bare parcel id — without borrowing a scalar it
 * is not allowed to serve.
 */
function citationRow(
  parcelNodeId: string,
  jurisdictionKey: string | null | undefined,
  districtCode: string | null | undefined,
) {
  if (!districtCode?.trim()) return null;
  for (const key of ruledKeys(parcelNodeId, jurisdictionKey)) {
    let table;
    try {
      table = getSetbackTable(key);
    } catch {
      continue;
    }
    const district = rowIn(table, districtCode);
    if (!table || !district) continue;
    return { table, district };
  }
  return null;
}

/** not_specified axes read off a ruled row's own per-field provenance. */
function notSpecifiedFromRow(
  district: { provenance?: Record<string, unknown> } | undefined,
): NotSpecifiedAxes | undefined {
  const p = district?.provenance as
    | Record<string, { not_specified?: boolean } | undefined>
    | undefined;
  if (!p) return undefined;
  const axes: NotSpecifiedAxes = {};
  if (p.front_ft?.not_specified === true) axes.front = true;
  if (p.side_ft?.not_specified === true) axes.side = true;
  if (p.rear_ft?.not_specified === true) axes.rear = true;
  if (p.side_corner_ft?.not_specified === true) axes.sideCorner = true;
  return Object.keys(axes).length > 0 ? axes : undefined;
}

export interface ResolveExportSetbackInput {
  parcelNodeId: string;
  /** Zoning district stamp for the parcel (e.g. "SF-1"). */
  districtCode: string | null | undefined;
  jurisdictionKey?: string | null;
  /** The persisted setback-rule atom, when the caller loaded one. */
  atom?: (SetbackRuleAtomInstance & {
    districtCode?: string;
    displayMeta?: {
      citationUrl?: string;
      sourceDate?: string | null;
      dateBasis?: string;
      secondSource?: { conflict?: SetbackSecondSourceConflict };
    };
    fieldProvenance?: unknown;
  }) | null;
  /**
   * The one reader. Optional: when absent or failing, resolution falls to the
   * ruled corpus row, which is the same row the rails were composed from. A
   * reader failure NEVER fails the report.
   */
  recordReader?: RecordReaderClient;
  /** Pre-fetched record, when the caller already read it for other rails. */
  record?: ParcelRecordResponse | null;
}

/**
 * Resolve the setback a document surface prints and draws. Never throws;
 * every failure degrades to the next precedence step and, at the end, to an
 * honest absence.
 */
export async function resolveExportSetback(
  input: ResolveExportSetbackInput,
): Promise<ExportSetbackResolution> {
  const districtCode =
    input.atom?.districtCode?.trim() || input.districtCode?.trim() || null;

  const ruled = ruledScalarRow(input.parcelNodeId, input.jurisdictionKey, districtCode);
  const cite = ruled ?? citationRow(input.parcelNodeId, input.jurisdictionKey, districtCode);
  const corpus = ruled
    ? {
        front: ruled.district.front_ft,
        side: ruled.district.side_ft,
        rear: ruled.district.rear_ft,
        corner: ruled.district.side_corner_ft ?? null,
      }
    : null;

  // Step 1 — the rails, through the one reader.
  let record = input.record ?? null;
  if (!record && input.recordReader) {
    try {
      const read = await input.recordReader.fetchRecord(input.parcelNodeId);
      record = read.ok ? read.record : null;
    } catch {
      record = null;
    }
  }
  const railFront = recordScalarNumber(record?.rails.setbackFrontFt);
  const railSide = recordScalarNumber(record?.rails.setbackSideFt);
  const railRear = recordScalarNumber(record?.rails.setbackRearFt);
  const railCorner = recordScalarNumber(record?.rails.setbackCornerFt);

  const atomDid = input.atom?.sourceCodeAtomRef?.atomDid ?? null;
  const atomRetired = isRetiredSetbackProvenance(atomDid);

  /**
   * Which axes the followed values move relative to the persisted atom. Used
   * to mark anything derived from that atom (the buildable envelope) stale.
   * The comparison is against the atom's own numbers, not against a tolerance:
   * a value that changed is a value that changed.
   */
  const supersededAxesAgainstAtom = (followed: {
    front: number;
    side: number;
    rear: number;
    cornerFt: number | null;
  }): Array<"front" | "side" | "rear" | "corner"> => {
    const atom = input.atom;
    if (!atom) return [];
    const axes: Array<"front" | "side" | "rear" | "corner"> = [];
    if (atom.front !== followed.front) axes.push("front");
    if (atom.side !== followed.side) axes.push("side");
    if (atom.rear !== followed.rear) axes.push("rear");
    if ((atom.sideCornerFt ?? null) !== followed.cornerFt) axes.push("corner");
    return axes;
  };
  const retiredAtomDeclined =
    atomRetired && atomDid
      ? { atomDid, reason: RETIRED_SETBACK_DECLINE_REASON }
      : undefined;

  const citeDistrict: SetbackDistrict | undefined = cite?.district;
  const ruledCitation = citeDistrict?.citation_url ?? null;
  const ruledLabel = cite?.table.jurisdictionDisplayName ?? null;
  const ruledDate =
    citeDistrict?.display_meta?.source_date ??
    (cite?.table as { effectiveDate?: string } | undefined)?.effectiveDate ??
    null;
  const ruledDateBasis =
    citeDistrict?.display_meta?.date_basis ?? (ruledDate ? "ordinance-effective-date" : null);
  const ruledConflict = citeDistrict?.display_meta?.second_source?.conflict ?? null;
  const ruledAtomDid =
    (citeDistrict?.provenance as Record<string, { atom_did?: string } | undefined> | undefined)
      ?.front_ft?.atom_did ??
    cite?.table.jurisdictionKey ??
    null;

  if (railFront != null && railSide != null && railRear != null) {
    const rails = {
      front: railFront,
      side: railSide,
      rear: railRear,
      corner: railCorner ?? null,
    };
    /**
     * The instrument this sheet is about to CITE, compared against the numbers
     * it is about to print. The comparison runs against the citation row (not
     * the R13-gated scalar row) because the citation row is what the sentence
     * names: for a Bastrop city parcel the rails ARE composed from that row,
     * and R13 only forbids serving its scalars, not reading them to check.
     *
     * If they disagree, the citation is NOT attached. Printing "Ordinance
     * 2026-06" beside numbers that are not that ordinance's is how this row's
     * original defect read to a buyer, and doing it in the other direction
     * would be the same lie with a fresher date on it.
     */
    const citeScalars = citeDistrict
      ? {
          front: citeDistrict.front_ft,
          side: citeDistrict.side_ft,
          rear: citeDistrict.rear_ft,
          corner: citeDistrict.side_corner_ft ?? null,
        }
      : null;
    const divergentAxes: Array<"front" | "side" | "rear" | "corner"> = [];
    if (citeScalars) {
      if (citeScalars.front !== rails.front) divergentAxes.push("front");
      if (citeScalars.side !== rails.side) divergentAxes.push("side");
      if (citeScalars.rear !== rails.rear) divergentAxes.push("rear");
      if (citeScalars.corner !== rails.corner) divergentAxes.push("corner");
    }
    const citable = citeScalars != null && divergentAxes.length === 0;
    const superseded = supersededAxesAgainstAtom({
      front: rails.front,
      side: rails.side,
      rear: rails.rear,
      cornerFt: rails.corner,
    });
    return {
      provenanceKind: "parcel-record-rails",
      honestAbsence: false,
      front: rails.front,
      side: rails.side,
      rear: rails.rear,
      cornerFt: rails.corner,
      notSpecified: notSpecifiedFromRow(citeDistrict),
      // The rails carry the values; the citation a sheet prints lives on the
      // ruled row they were composed from. When there is no ruled row to
      // name, the record itself is named rather than a blank.
      sourceCodeAtomDid: citable
        ? (ruledAtomDid ?? `parcel_record/${input.parcelNodeId}/setback`)
        : `parcel_record/${input.parcelNodeId}/setback`,
      sourceLabel: citable ? ruledLabel : "Parcel record (ledger rails)",
      sourceCitation: citable ? ruledCitation : null,
      sourceDate: citable ? ruledDate : null,
      dateBasis: citable ? ruledDateBasis : null,
      districtCode,
      conflict: citable ? ruledConflict : null,
      ...(divergentAxes.length > 0 && citeScalars
        ? { railCorpusDivergence: { axis: divergentAxes, rails, corpus: citeScalars } }
        : {}),
      ...(retiredAtomDeclined ? { retiredAtomDeclined } : {}),
      ...(superseded.length > 0 && input.atom
        ? { supersededAtom: { atomDid: input.atom.atomDid, axes: superseded } }
        : {}),
    };
  }

  // Step 2 — the ruled corpus row.
  if (ruled && corpus) {
    const superseded = supersededAxesAgainstAtom({
      front: corpus.front,
      side: corpus.side,
      rear: corpus.rear,
      cornerFt: corpus.corner,
    });
    return {
      provenanceKind: "ruled-setback-table",
      honestAbsence: false,
      front: corpus.front,
      side: corpus.side,
      rear: corpus.rear,
      cornerFt: corpus.corner,
      notSpecified: notSpecifiedFromRow(ruled.district),
      sourceCodeAtomDid: ruledAtomDid ?? ruled.table.jurisdictionKey,
      sourceLabel: ruledLabel,
      sourceCitation: ruledCitation,
      sourceDate: ruledDate,
      dateBasis: ruledDateBasis,
      districtCode,
      conflict: ruledConflict,
      ...(retiredAtomDeclined ? { retiredAtomDeclined } : {}),
      ...(superseded.length > 0 && input.atom
        ? { supersededAtom: { atomDid: input.atom.atomDid, axes: superseded } }
        : {}),
    };
  }

  // Step 3 — the persisted atom, only when its provenance is not retired.
  if (input.atom && !atomRetired) {
    const fp = input.atom.fieldProvenance as
      | Record<string, { notSpecified?: boolean } | undefined>
      | undefined;
    const axes: NotSpecifiedAxes = {};
    if (fp?.front?.notSpecified) axes.front = true;
    if (fp?.side?.notSpecified) axes.side = true;
    if (fp?.rear?.notSpecified) axes.rear = true;
    return {
      provenanceKind: "setback-rule-atom",
      honestAbsence: false,
      front: input.atom.front,
      side: input.atom.side,
      rear: input.atom.rear,
      cornerFt: input.atom.sideCornerFt ?? null,
      notSpecified: Object.keys(axes).length > 0 ? axes : undefined,
      sourceCodeAtomDid: atomDid ?? input.atom.atomDid,
      sourceLabel: input.atom.sourceCitation ?? null,
      sourceCitation: input.atom.displayMeta?.citationUrl ?? input.atom.sourceUrl ?? null,
      sourceDate: input.atom.displayMeta?.sourceDate ?? null,
      dateBasis: input.atom.displayMeta?.dateBasis ?? null,
      districtCode,
      conflict: input.atom.displayMeta?.secondSource?.conflict ?? null,
    };
  }

  // Step 4 — honest absence. Nothing is fabricated; every inset is zero and
  // the legend says the layer is unverified.
  return {
    provenanceKind: "honest-absence",
    honestAbsence: true,
    honestAbsenceReason: atomRetired
      ? `${RETIRED_SETBACK_DECLINE_REASON} No ruled table carries this district, so no setback is drawn for this parcel.`
      : undefined,
    front: 0,
    side: 0,
    rear: 0,
    cornerFt: null,
    sourceCodeAtomDid: "no-setback-rule-atom",
    sourceLabel: null,
    sourceCitation: null,
    sourceDate: null,
    dateBasis: null,
    districtCode,
    ...(retiredAtomDeclined ? { retiredAtomDeclined } : {}),
  };
}

/**
 * Narrow an already-loaded setback-rule atom into the per-edge refresh's
 * authority shape, or null when there is nothing servable on it. A RETIRED
 * provenance yields null — the retirement holds on every path that reaches
 * the refresh, not only the document composer's.
 *
 * For callers that only compare edge ROLES (the warden's cert-vs-serve
 * sweep), the values here are immaterial; the null case is what keeps a
 * retired atom from quietly authoring a value if that ever changes.
 */
export function exportSetbackAuthorityFromAtom(
  atom:
    | (SetbackRuleAtomInstance & { districtCode?: string })
    | null
    | undefined,
): {
  front: number;
  side: number;
  rear: number;
  cornerFt: number | null;
  provenance: ExportSetbackProvenanceKind;
  sourceCodeAtomDid?: string | null;
  districtCode?: string | null;
} | null {
  if (!atom) return null;
  const atomDid = atom.sourceCodeAtomRef?.atomDid ?? null;
  if (isRetiredSetbackProvenance(atomDid)) return null;
  return {
    front: atom.front,
    side: atom.side,
    rear: atom.rear,
    cornerFt: atom.sideCornerFt ?? null,
    provenance: "setback-rule-atom",
    sourceCodeAtomDid: atomDid ?? atom.atomDid,
    districtCode: atom.districtCode ?? null,
  };
}
