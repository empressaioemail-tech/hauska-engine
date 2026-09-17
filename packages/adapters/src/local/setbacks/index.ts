/**
 * Per-jurisdiction setback table loader.
 *
 * 2026-09-07: repointed to the published `@empressaio/setback-corpus`
 * package (item 4, setback-corpus consumer repointing) — the raw tables
 * this file used to vendor locally now live there as the single source of
 * truth shared with legacy-design-tools, proven equivalent by
 * `__tests__/corpus-divergence.test.ts` before this swap landed. The local
 * `<jurisdiction>.json` files stay on disk, untouched, ONLY as that test's
 * comparison baseline until they're formally retired — do not import them
 * from anywhere else in this package.
 *
 * This file keeps every jurisdiction-specific ROUTING/business rule that
 * was always engine-local (Bastrop per-parcel-record precedence, repealed
 * B3 Place Type filtering, BDC district classification, the elgin-tx
 * alias) — the corpus package is deliberately pure data and was never the
 * place for any of that.
 *
 * The briefing engine (DA-PI-3) calls {@link getSetbackTable} keyed by the
 * resolved jurisdiction key when it builds dimensional-rule prose.
 *
 * Adding a new jurisdiction: add it to `@empressaio/setback-corpus`
 * (see that package's own README), bump the dependency version here, and
 * add its key to `VENDORED_JURISDICTION_KEYS` below.
 *
 * 2026-09-13 (P-154 wave 4, share): `resolveMostCurrentSetback` and its
 * date-basis helpers repointed from this package's own (now-retired)
 * `./most-current-setback-resolver.js` to the published
 * `@empressaio/setback-corpus/resolve` subpath — see
 * `_decisions/2026-09-13_share_the_most_current_setback_resolver.md`. The
 * algorithm and its public names are unchanged; only the import path moved.
 */
import {
  SETBACK_JURISDICTION_KEYS as CORPUS_SETBACK_JURISDICTION_KEYS,
  getSetbackTable as getCorpusSetbackTable,
} from "@empressaio/setback-corpus";

export { CORPUS_SETBACK_JURISDICTION_KEYS };

export type {
  SetbackDistrict,
  SetbackTable,
  SetbackSecondSourceConflict,
  SetbackSecondSourceDisclosure,
} from "./table-types.js";
import type {
  SetbackDistrict,
  SetbackSecondSourceConflict,
  SetbackSecondSourceDisclosure,
  SetbackTable,
} from "./table-types.js";

import {
  setbackTableFromBastropPerParcelRecord,
} from "./bastrop-per-parcel-record.js";
import {
  BASTROP_CURRENT_SETBACK_ORDINANCE,
  BASTROP_CURRENT_SETBACK_ORDINANCE_EFFECTIVE_DATE,
  BASTROP_STALE_COLUMNS_CONFIRMATION,
} from "./bastrop-conflict-a148.js";
import { isRetiredSetbackProvenance } from "./retired-setback-provenance.js";
import {
  dateFromTableEffectiveDate,
  resolveMostCurrentSetback,

  type SetbackCandidate,
} from "@empressaio/setback-corpus/resolve";

/**
 * P-260 (2026-09-17) — the engine's jurisdiction set is READ FROM THE CORPUS,
 * not kept beside it.
 *
 * Before this, `VENDORED_JURISDICTION_KEYS` above was a hand-kept list of 15
 * keys that happened to be a subset of the corpus's own
 * `SETBACK_JURISDICTION_KEYS` (43 keys at `@empressaio/setback-corpus@1.4.0`),
 * and the two could drift in silence: the corpus could gain a jurisdiction and
 * the engine would neither serve it nor say why, and the engine could name a key
 * the corpus had dropped and only find out when the throw below fired at module
 * load. Neither side knew the other's universe.
 *
 * Now the corpus supplies the KEY UNIVERSE and this file supplies the POLICY,
 * and POLICY MUST BE TOTAL: every corpus key carries a row in
 * {@link SETBACK_ENGINE_REGISTRY} — served, with the routing arm that serves it,
 * or not served, with the reason. A corpus key with no row is a registry defect
 * (`__tests__/corpus-registry-divergence.test.ts` fails on it, which is what
 * makes one side edited alone fail the build rather than drift). The engine's
 * city routing rules are unchanged and stay here — the corpus is pure data and
 * was never the place for Bastrop's per-parcel precedence, the repealed B3 Place
 * Types, the BDC district classification, or the elgin alias resolution.
 */
/** How a jurisdiction the engine SERVES is reached by `getSetbackTableForZoning`. */
export type SetbackRegistryRouting =
  /** Bastrop city BDC districts: scalars require the layer-23 per-parcel record (R13); repealed B3 Place Types honest-decline. */
  | "bastrop-city-layer23"
  /** bastrop-tx: legacy county rows for non-BDC codes; the city arm owns BDC districts. */
  | "bastrop-county-legacy"
  /** elgin-tx (and its canonical key): the city's own development-code table. */
  | "elgin-development-code"
  /** No city routing policy: the keyed table is the answer (county and non-routing city tables). */
  | "keyed-table";

/** Registry row for one corpus jurisdiction. Served or not — never absent. */
export type SetbackEngineRegistryRow =
  | {
      readonly key: string;
      readonly served: true;
      readonly routing: SetbackRegistryRouting;
    }
  | {
      readonly key: string;
      readonly served: false;
      /** Why THIS engine does not serve a table the corpus carries. Never empty. */
      readonly reason: string;
    };

/** Not-served reasons, spelled once so every row that uses one means the same thing. */
export const SETBACK_NOT_SERVED_REASON = {
  /**
   * The corpus carries the table; this engine has no registry row, cohort, or
   * routing rule wired for the city yet (`setback-writer/city-binding.ts` says
   * the same thing to a writer as `tableLanded: false`, and
   * `resolveWiredCityRegistry` lists them per county).
   */
  notWired:
    "corpus table exists; no registry row, cohort, or setback routing rule is wired for this jurisdiction yet",
  /**
   * Deliberately withheld by standing ruling, not forgotten: these cities'
   * tables carry their own caveats recorded in doc_repo, and serving them is an
   * operator call (the pre-P-260 comment named Georgetown and San Marcos).
   */
  withheld:
    "corpus table exists; serving is withheld pending this city's own recorded caveats (operator call, see doc_repo)",
} as const;

/** The keys this engine SERVES, with the routing arm that serves each. */
const SERVED_JURISDICTION_ROUTING: Readonly<Record<string, SetbackRegistryRouting>> = {
  // Bastrop County + City (48021): city BDC districts need layer 23 (R13).
  "bastrop-tx": "bastrop-county-legacy",
  "bastrop-city-tx": "bastrop-city-layer23",
  "bastrop-development-code": "bastrop-city-layer23",
  // Elgin (48021, Bastrop-county side) — ratified 2026-08-04. The corpus key is
  // `elgin-development-code`; `elgin-tx` is this engine's alias for it (see
  // SERVED_JURISDICTION_ALIASES below) and is deliberately NOT a row here: the
  // registry is keyed on the corpus's own key universe, and the corpus does not
  // carry `elgin-tx`.
  "elgin-development-code": "elgin-development-code",
  // Wired city tables with no city-specific routing policy (OPS-19b).
  "austin-tx": "keyed-table",
  "pflugerville-tx": "keyed-table",
  "san-antonio-tx": "keyed-table",
  "waco-tx": "keyed-table",
  "round-rock-tx": "keyed-table",
  "kyle-tx": "keyed-table",
  // Non-Texas corpus jurisdictions the engine has served since before the merge.
  "grand-county-ut": "keyed-table",
  "lemhi-county-id": "keyed-table",
  "utah-unincorporated": "keyed-table",
  "idaho-unincorporated": "keyed-table",
};

/** Corpus keys deliberately withheld from serving, with the standing reason. */
const WITHHELD_JURISDICTION_KEYS: ReadonlySet<string> = new Set([
  "georgetown-tx",
  "san-marcos-tx",
]);

/**
 * The engine's total policy over the corpus's key universe. Built by mapping
 * the corpus's own key list, so a key the corpus adds appears here (as
 * `served: false`, `notWired`) instead of vanishing, and a key the corpus drops
 * stops appearing here at all. Both transitions fail the divergence test.
 */
export const SETBACK_ENGINE_REGISTRY: ReadonlyArray<SetbackEngineRegistryRow> =
  CORPUS_SETBACK_JURISDICTION_KEYS.map((key): SetbackEngineRegistryRow => {
    const routing = SERVED_JURISDICTION_ROUTING[key];
    if (routing) return { key, served: true, routing };
    return {
      key,
      served: false,
      reason: WITHHELD_JURISDICTION_KEYS.has(key)
        ? SETBACK_NOT_SERVED_REASON.withheld
        : SETBACK_NOT_SERVED_REASON.notWired,
    };
  });

/** The engine-served subset of {@link SETBACK_ENGINE_REGISTRY}. */
export const SERVED_JURISDICTION_KEYS: ReadonlyArray<string> =
  SETBACK_ENGINE_REGISTRY.filter((r) => r.served).map((r) => r.key);

/**
 * Alternate spellings that resolve to a served canonical key. An alias is a
 * second NAME for one jurisdiction, not a second jurisdiction, so it is
 * deliberately not a corpus registry key and gets no registry row — the corpus
 * package mirrors this same alias (`JURISDICTION_KEY_ALIASES`) so both sides
 * resolve `elgin-tx` identically.
 */
const SERVED_JURISDICTION_ALIASES: Readonly<Record<string, string>> = {
  "elgin-tx": "elgin-development-code",
};

/** Every key `getSetbackTable` answers to: the served set plus its aliases. */
export const SETBACK_LOOKUP_KEYS: ReadonlyArray<string> = [
  ...new Set([...SERVED_JURISDICTION_KEYS, ...Object.keys(SERVED_JURISDICTION_ALIASES)]),
];

/** Every corpus key this engine does NOT serve, with its reason. */
export function listNotServedSetbackJurisdictions(): ReadonlyArray<{
  key: string;
  reason: string;
}> {
  return SETBACK_ENGINE_REGISTRY.filter((r) => !r.served).map((r) => ({
    key: r.key,
    reason: r.reason,
  }));
}

const SETBACK_TABLES: Readonly<Record<string, SetbackTable>> = Object.fromEntries(
  SETBACK_LOOKUP_KEYS.map((key) => {
    const table = getCorpusSetbackTable(key);
    if (!table) {
      throw new Error(
        `@empressaio/setback-corpus does not carry "${key}", which this engine's registry serves — repoint regressed.`,
      );
    }
    return [key, table as SetbackTable];
  }),
);

export const SETBACK_JURISDICTION_KEYS = Object.keys(SETBACK_TABLES);

function normalizeJurisdictionKey(key: string): string {
  return key.toLowerCase().replace(/_/g, "-");
}

function leadingDistrictToken(districtName: string): string {
  return (districtName.trim().split(/\s+/)[0] ?? "").toUpperCase();
}

/** Repealed B3 Place Types — must not be served as current setback law. */
function isRepealedB3PlaceType(code: string): boolean {
  return (
    /^P-[1-5](?:$|[-_\s])/.test(code) ||
    /^P-(?:CS|EC)(?:$|[-_\s])/.test(code)
  );
}

/** BDC districts whose scalars live on layer 23 only (not ordinance chart). */
export function isBdcPerParcelDistrictCode(code: string): boolean {
  return /^(MU|GC|PDD|PI|IND|OS)(?:$|[-_\s])/.test(code) ||
    /^P\/OS(?:$|[-_\s])/.test(code) ||
    /^P-OS(?:$|[-_\s])/.test(code);
}

/** BDC Euclidean districts with ordinance-text scalar rows in bastrop-development-code. */
function isBdcEuclideanCode(code: string): boolean {
  return /^(SF-[123]|RR)(?:$|[-_\s])/.test(code);
}

/**
 * Any known BDC Chapter 14 district stamp (Euclidean + conditional).
 * Conditional codes (MU/GC/…) still route to the BDC table so callers
 * honest-decline on the missing row (CORRECTION C) instead of falling
 * through to the legacy bastrop-tx county table.
 */
function isKnownBdcDistrictCode(code: string): boolean {
  return isBdcEuclideanCode(code) || isBdcPerParcelDistrictCode(code);
}

function isBastropCityJurisdiction(normalizedKey: string): boolean {
  return (
    normalizedKey === "bastrop-tx" ||
    normalizedKey === "bastrop-city-tx" ||
    normalizedKey === "bastrop-development-code" ||
    normalizedKey === "bastrop-per-parcel-record"
  );
}

export type SetbackTableResolveOptions = {
  /**
   * Pre-fetched Bastrop layer-23 record (AMENDMENT 2+3). When set for a
   * Bastrop city jurisdiction, NUMBERS come from here — not
   * bastrop-development-code.json chart rows.
   */
  bastropPerParcelRecord?: import("./bastrop-per-parcel-record.js").BastropPerParcelSetbackParsed;
  /** District code for per-parcel row labeling (defaults to zoningCode arg). */
  districtCode?: string;
};

function tableHasDistrict(table: SetbackTable, code: string): boolean {
  const wanted = leadingDistrictToken(code);
  if (!wanted) return false;
  return table.districts.some(
    (d) => leadingDistrictToken(d.district_name) === wanted,
  );
}

/**
 * Returns the setback table for a jurisdiction key, or null if no table
 * exists. The briefing engine should treat null as "no codified
 * dimensional rules available — fall back to base IBC/IRC".
 */
export function getSetbackTable(jurisdictionKey: string): SetbackTable | null {
  return SETBACK_TABLES[normalizeJurisdictionKey(jurisdictionKey)] ?? null;
}

/**
 * Resolve the table for a parcel's stamped zoning code.
 *
 * City of Bastrop (current law = per-parcel layer 23, AMENDMENT 2+3):
 *   - When `options.bastropPerParcelRecord` is supplied, NUMBERS come from
 *     that record (cited to Ordinance_Link). Chart table is verification only.
 *   - Without a per-parcel record, returns bastrop-development-code for
 *     edition/citation lookup only — callers MUST NOT use chart scalars as
 *     warm authors for Bastrop city (fetch layer 23 first).
 *   - Repealed B3 Place Types (P-1..P-5, P-CS, P-EC) → null
 *     (honest-decline). Do NOT silently serve bastrop-city-tx as current.
 *   - MU / GC / PDD (layer 23 only): without `bastropPerParcelRecord` → null
 *     so callers fetch layer 23 instead of honest-decline on missing chart rows.
 *
 * County / other jurisdictions: fall through to the keyed table
 * (e.g. bastrop-tx legacy R-MD rows for non-city codes).
 */
/**
 * P-154 (OPS-23 wave 6, R-1 CONFLICT ROW) — what a setback-table lookup
 * resolves to.
 *
 * The 2026-09-11 ruling (`_decisions/2026-09-11_setback_source_most_current_wins.md`)
 * makes a disagreement between two readable-dated sources a CONFLICT ROW: both
 * values, both citations, both dates, and which one this operation follows and
 * why. Before wave 6 this function collapsed that case into a value and hid
 * the disagreement in `display_meta.second_source`, which no surface printed.
 *
 * Both arms carry the table, because R-1 still names the source we follow —
 * the followed values stay printable; only the DISCLOSURE differs. That is
 * why the discriminant is a separate `table` field rather than a flag on the
 * table itself: every caller has to say which arm it means, so the compiler
 * finds each one and no caller can silently drop a conflict (`kind: "table"`
 * on the table would compile fine and hide it).
 */
export type SetbackTableResolution =
  | {
      /** One source, or several that agree on the value: nothing to disclose. */
      kind: "table";
      table: SetbackTable;
    }
  | {
      /** Two sources whose values differ. `table` is the source we follow. */
      kind: "conflict";
      table: SetbackTable;
      /** The candidate we follow, with its own date and citation. */
      followed: SetbackCandidate;
      /** The candidate we do not follow — named, never characterised as wrong. */
      secondSource: SetbackCandidate;
      /** Why we follow `followed` (R-1: most current by effective date). */
      reason: string;
      /** Ready-to-serialize payload for the one vocabulary sentence every surface prints. */
      note: SetbackSecondSourceConflict;
    };

function scalarsOf(candidate: SetbackCandidate) {
  return {
    front_ft: candidate.scalars.front_ft,
    side_ft: candidate.scalars.side_ft,
    rear_ft: candidate.scalars.rear_ft,
    side_corner_ft: candidate.scalars.side_corner_ft ?? null,
  };
}

function candidatesDisagree(a: SetbackCandidate, b: SetbackCandidate): boolean {
  const x = scalarsOf(a);
  const y = scalarsOf(b);
  return (
    x.front_ft !== y.front_ft ||
    x.side_ft !== y.side_ft ||
    x.rear_ft !== y.rear_ft ||
    x.side_corner_ft !== y.side_corner_ft
  );
}

/**
 * How a customer would name the OTHER source's own card. Read off the
 * source's own published name rather than invented: Bastrop's per-parcel
 * layer is the city's "Parcels_One_Click" service, whose customer-facing name
 * in the city's own tool is the One Click card. Falls back to the source's
 * own display name, never to a guess.
 */
function secondSourceCardLabel(candidate: SetbackCandidate): string {
  const name = `${candidate.sourceLabel} ${candidate.id}`;
  if (/one[_\s-]?click/i.test(name)) return "One Click card";
  // Otherwise trim the source's own published name down to the part a
  // customer would recognize: drop a "City of X, TX" prefix and unwrap a
  // single parenthetical (the corpus names its tables that way).
  const stripped = candidate.sourceLabel
    .replace(/^City of [^,]+, [A-Z]{2}\s*/, "")
    .trim();
  const unwrapped = /^\(([^)]+)\)$/.exec(stripped)?.[1]?.trim();
  return unwrapped || stripped || candidate.sourceLabel;
}

/**
 * The ordinance a candidate's own row cites, verbatim, or null. A citation
 * slot holding a layer URL cites no ordinance — say so instead of printing a
 * URL in a sentence that promises an ordinance number.
 */
function citedOrdinance(candidate: SetbackCandidate): string | null {
  const raw = candidate.citationUrl?.trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return null;
  return raw;
}

/**
 * P-154 (R-1, most-current-source-wins) — Bastrop's own two-candidate case:
 * a codified Euclidean chart row (SF-1/SF-2/SF-3/RR) versus the live
 * per-parcel layer-23 record for that same district. Returns the per-parcel
 * table alone (kind `table`) when there is no codified chart row to compare
 * against (MU/GC/PDD/PI/IND/OS — per-parcel-record-only districts, R13):
 * there is nothing to resolve BETWEEN.
 *
 * R-1 — the two readable-dated sources that disagree are a CONFLICT ROW. This
 * returns `kind: "conflict"` with the followed values still printable, the
 * other source named with its own values, date and citation, and the
 * structured `note` payload every surface formats through
 * `@empressaio/atom-contract`'s one conflict sentence.
 *
 * A-148 (overseer, 2026-09-14) resolved that finding AT SOURCE, and it is not
 * what wave 6 first read: this is NOT two layers citing two ordinances. For
 * `48021:34049` (1109 Pecan St, SF-1) the City of Bastrop's CURRENT,
 * authoritative zoning layer (`Zone_Types/FeatureServer/25`, edited
 * 2026-07-09) publishes 30/10/30/20 in its TEXT fields, and the numeric
 * shortcut columns its own One Click join reads (`FrontSetback_`,
 * `SideSetback_`, `RearSetback_` — there is no numeric corner column) were
 * NEVER REFRESHED and still say 25/5/25. A customer opening the city's own One
 * Click card therefore sees 25/5/25 while our card prints the layer's text
 * values 30/10/30/20, which Ordinance 2026-06 also carries. The two claims on
 * the row are the same layer's TEXT fields and the unrefreshed numeric columns
 * its join reads, so this is the same-layer shape
 * (`shape: "stale-numeric-columns"`) and the sentence says so — the
 * two-instrument shape is the other arm and is not this case. The values this
 * operation serves are the TEXT values (read at source by
 * `./bastrop-per-parcel-record.js`, which carries the disagreement on the
 * record) and the numeric column is named as the second source, never
 * characterised as wrong: which of the two the city honours is the city's
 * ruling, not this lane's.
 */
function resolveBastropEuclideanCandidate(
  normalized: string,
  district: string,
  perParcelRecord: NonNullable<SetbackTableResolveOptions["bastropPerParcelRecord"]>,
): SetbackTableResolution {
  const perParcelTable = setbackTableFromBastropPerParcelRecord(perParcelRecord, district);
  const perParcelDistrict = perParcelTable.districts[0]!;

  const chartTable =
    normalized === "bastrop-development-code" || normalized === "bastrop-tx" || normalized === "bastrop-city-tx"
      ? SETBACK_TABLES["bastrop-development-code"]
      : undefined;
  const wanted = leadingDistrictToken(district);
  const chartDistrict = chartTable?.districts.find(
    (d) => leadingDistrictToken(d.district_name) === wanted,
  );
  if (!chartTable || !chartDistrict) {
    // No codified row to resolve against (e.g. MU/GC/PDD/PI/IND/OS) —
    // per-parcel record is the only candidate; nothing to compare.
    return { kind: "table", table: perParcelTable };
  }

  const chartCandidate: SetbackCandidate = {
    id: "bastrop-development-code",
    sourceKind: "codified-ordinance",
    sourceLabel: chartTable.jurisdictionDisplayName,
    scalars: {
      front_ft: chartDistrict.front_ft,
      side_ft: chartDistrict.side_ft,
      rear_ft: chartDistrict.rear_ft,
      side_corner_ft: chartDistrict.side_corner_ft,
    },
    citationUrl: chartDistrict.citation_url ?? null,
    ...dateFromTableEffectiveDate(chartTable.effectiveDate),
  };
  const perParcelCandidate: SetbackCandidate = {
    id: "bastrop-per-parcel-record",
    sourceKind: "gis-per-parcel",
    sourceLabel: perParcelTable.jurisdictionDisplayName,
    scalars: {
      front_ft: perParcelDistrict.front_ft,
      side_ft: perParcelDistrict.side_ft,
      rear_ft: perParcelDistrict.rear_ft,
      side_corner_ft: perParcelDistrict.side_corner_ft,
    },
    citationUrl: perParcelDistrict.citation_url ?? null,
    sourceDate: perParcelRecord.sourceDate,
    dateBasis: perParcelRecord.dateBasis,
    ...(perParcelRecord.datePrecision ? { datePrecision: perParcelRecord.datePrecision } : {}),
  };

  const resolution = resolveMostCurrentSetback([chartCandidate, perParcelCandidate]);
  /**
   * Which candidate the row follows.
   *
   * - The resolver ordered them (two readable dates): R-1 names the most
   *   current one, which is the whole point of the rule.
   * - The resolver could NOT order them (an unreadable or unattributable
   *   date on a side that disagrees): wave 6 did not re-decide that case and
   *   served the city's layer-23 per-parcel record, the AMENDMENT 2+3 number
   *   author.
   *
   * P-219 amends BOTH arms in one direction only: `bastrop-per-parcel/*` is
   * RETIRED as a value author (`./retired-setback-provenance.ts`), so it can
   * no longer be the FOLLOWED row here — a ruled chart row exists by the time
   * control reaches this line (the no-chart case returned above), so there is
   * always something to take over. This is deliberately NOT a silent pick:
   * the retired source stays named as the second source with its own values,
   * date and citation, and `reason` below says the retirement is why. Without
   * this, the unordered arm kept minting setback-rule atoms whose provenance
   * was `bastrop-per-parcel/<propId>/front` and whose citation was an
   * ordinance the city repealed on 2026-04-14, which is what both PDF
   * products printed until P-219.
   */
  const perParcelProvenance = perParcelDistrict.provenance as
    | Record<string, { atom_did?: string } | undefined>
    | undefined;
  const perParcelIsRetiredAuthor = isRetiredSetbackProvenance(
    perParcelProvenance?.front_ft?.atom_did,
  );
  const resolverFollowed =
    resolution.status === "resolved" ? resolution.winner : perParcelCandidate;
  const retirementForcedChart =
    perParcelIsRetiredAuthor && resolverFollowed === perParcelCandidate;
  const followed = retirementForcedChart ? chartCandidate : resolverFollowed;
  const secondSource =
    followed === chartCandidate ? perParcelCandidate : chartCandidate;

  const followedMeta = {
    source_date: followed.sourceDate,
    date_basis: followed.dateBasis,
    ...(followed.datePrecision ? { date_precision: followed.datePrecision } : {}),
  };

  /** The followed table, with its own date on the exact district row. */
  const followedTable =
    followed === chartCandidate
      ? {
          ...chartTable,
          districts: chartTable.districts.map((d) =>
            d === chartDistrict ? { ...d, display_meta: { ...(d.display_meta ?? {}), ...followedMeta } } : d,
          ),
        }
      : perParcelTable;

  // P-154 / A-148 — the SAME-LAYER shape of the conflict, checked FIRST. The
  // per-parcel record's own TEXT fields and the numeric shortcut columns its
  // One Click join reads disagree (detected at source while parsing the record,
  // `textNumericDisagreement`). The value this operation follows is the TEXT
  // value (A-148), so the served scalars above are already the text ones. This
  // cannot fall through to the two-candidate comparison: for `48021:34049` the
  // chart and the layer's text fields AGREE (30/10/30/20), so the disagree
  // check below would return `kind: "table"` and the row would print no
  // conflict at all while the customer's own One Click card shows 25/5/25.
  const staleNumericColumns = perParcelRecord.textNumericDisagreement;
  if (staleNumericColumns) {
    const { numeric, text } = staleNumericColumns;
    const note: SetbackSecondSourceConflict = {
      shape: "stale-numeric-columns",
      secondSourceLabel: "One Click card",
      numeric: { front: numeric.front, side: numeric.side, rear: numeric.rear },
      text: { front: text.front, side: text.side, rear: text.rear, corner: text.corner },
      ordinance: BASTROP_CURRENT_SETBACK_ORDINANCE,
      confirmedWith: BASTROP_STALE_COLUMNS_CONFIRMATION.with,
      confirmedOn: BASTROP_STALE_COLUMNS_CONFIRMATION.on,
      // The layer's OWN `Ordinance_` field is itself unrefreshed (it reads
      // "2019-51" live), so it cannot date the TEXT values this row serves.
      // The followed row and the note both name the current ordinance the text
      // fields reflect, deliberately (A-148).
      source_date: BASTROP_CURRENT_SETBACK_ORDINANCE_EFFECTIVE_DATE,
      date_basis: "ordinance-effective-date",
    };
    // The followed table is the layer's own table (its TEXT values), dated by
    // the current ordinance rather than by the stale citation field.
    //
    // P-219 — except that the per-parcel table's scalars carry a RETIRED
    // provenance (`bastrop-per-parcel/*`). Control only reaches here with a
    // ruled chart row in hand (the no-chart case returned above), and for the
    // district this fires on the chart row and the layer's TEXT fields carry
    // the same ordinance's numbers, so the followed SCALARS and their
    // provenance come from the chart while the per-parcel row's non-value
    // display meta (min lot size, resolved district, split-zone minors) is
    // preserved. The A-148 conflict sentence is unchanged: it is what names
    // the unrefreshed numeric columns the customer's own One Click card shows.
    const followedStaleTable: SetbackTable = {
      ...chartTable,
      districts: [
        {
          ...chartDistrict,
          display_meta: {
            // Non-value meta from the per-parcel row (min lot size, resolved
            // district, split-zone minors, the R25 layer-83 note) is kept; the
            // chart row's own meta wins on any key they share.
            ...(perParcelDistrict.display_meta ?? {}),
            ...(chartDistrict.display_meta ?? {}),
            source_date: BASTROP_CURRENT_SETBACK_ORDINANCE_EFFECTIVE_DATE,
            date_basis: "ordinance-effective-date",
            date_precision: "day",
          },
          // The layer's own citation field is unrefreshed (it reads the
          // earlier ordinance live); printing it beside the current values
          // would state the wrong instrument. The chart row's own
          // `citation_url` already points at Ordinance 2026-06 itself, which
          // is a stronger citation than the bare ordinance number this used
          // to stuff into display meta, so it is kept as-is.
          citation_url: chartDistrict.citation_url,
        },
      ],
    };
    const numericReadsText = `${numeric.front}/${numeric.side}/${numeric.rear}`;
    const textReads = `${text.front}/${text.side}/${text.rear}${text.corner != null ? `/${text.corner}` : ""}`;
    const reason =
      `the City of Bastrop's authoritative zoning layer disagrees with itself: its own text fields (${textReads}) match Ordinance ` +
      `${BASTROP_CURRENT_SETBACK_ORDINANCE}, while the unrefreshed numeric shortcut columns its One Click join reads ` +
      `(${numericReadsText}) were never refreshed. The text value is followed; the numeric column is named as the second source.`;
    const disclosure: SetbackSecondSourceDisclosure = {
      source: "unrefreshed numeric shortcut columns of the authoritative zoning layer",
      note: `CONFLICT under R-1 (most-current source wins): ${reason}`,
      citation_url: BASTROP_CURRENT_SETBACK_ORDINANCE,
      conflict: note,
    };
    return {
      kind: "conflict",
      // The disagreement this arm names is WITHIN one layer (its numeric
      // columns versus its text fields), and the sentence, not a second
      // candidate, is what names it — which is why the second-source slot
      // carries the per-parcel candidate. P-219: the FOLLOWED slot is now the
      // ruled chart candidate, matching the table above, because the
      // per-parcel row is retired as a value author. The chart and the
      // layer's text fields carry the same ordinance's numbers, so nothing
      // about what the customer reads changes except the provenance it cites.
      table: withSecondSourceDisclosure(followedStaleTable, disclosure),
      followed: chartCandidate,
      secondSource: perParcelCandidate,
      reason,
      note,
    };
  }

  if (!candidatesDisagree(followed, secondSource)) {
    // The two sources agree on every scalar: one claim, nothing to disclose,
    // and no conflict sentence anywhere (the detector must not fire here).
    return { kind: "table", table: followedTable };
  }

  const reason = retirementForcedChart
    ? `${resolution.status === "resolved" ? `R-1 ordered ${secondSource.sourceLabel} (${secondSource.sourceDate ?? "unreadable"}, ${secondSource.dateBasis}) first, but` : `${resolution.reason} In addition,`} that source is RETIRED as a setback value author (P-219): its scalars carry a \`bastrop-per-parcel/*\` provenance, the city's unrefreshed numeric shortcut columns. The row serves the ruled ${followed.sourceLabel} (${followed.sourceDate ?? "unreadable"}, ${followed.dateBasis}) and names the retired source with its own values, date and citation rather than picking in silence.`
    : resolution.status === "resolved"
      ? `${followed.sourceLabel} (${followed.sourceDate ?? "unreadable"}, ${followed.dateBasis}) is the most current source under R-1 and disagrees with ${secondSource.sourceLabel} (${secondSource.sourceDate ?? "unreadable"}, ${secondSource.dateBasis}).`
      : `${resolution.reason} The row serves the city's per-parcel record (the AMENDMENT 2+3 number author, unchanged by wave 6) and names ${secondSource.sourceLabel} as the second source rather than picking in silence.`;

  const note: SetbackSecondSourceConflict = {
    shape: "second-source",
    secondSourceLabel: secondSourceCardLabel(secondSource),
    front: secondSource.scalars.front_ft,
    side: secondSource.scalars.side_ft,
    rear: secondSource.scalars.rear_ft,
    corner: secondSource.scalars.side_corner_ft ?? null,
    citation: citedOrdinance(secondSource),
    source_date: secondSource.sourceDate,
    date_basis: secondSource.dateBasis,
    // "repealed <date>": only when the instrument WE follow is dated by its
    // own ordinance effective date and the other source's date IS the year of
    // the ordinance it cites — i.e. our instrument post-dates and supersedes
    // that cited ordinance (Ord. 2026-06 is the city's repeal-and-adopt
    // ordinance; its own note names it as such). Never inferred from ordering
    // alone, and never asserted when either side's date is unreadable.
    repealedByEffectiveDate:
      followed.dateBasis === "ordinance-effective-date" &&
      secondSource.dateBasis === "gis-row-citation-ordinance" &&
      followed.sourceDate != null &&
      secondSource.sourceDate != null &&
      followed.sourceDate > secondSource.sourceDate
        ? followed.sourceDate
        : null,
  };

  const secondScalars = scalarsOf(secondSource);
  const disclosure: SetbackSecondSourceDisclosure = {
    source: secondSource.sourceLabel,
    note: `CONFLICT under R-1 (most-current source wins): ${reason} ${note.secondSourceLabel} reads ${secondScalars.front_ft}/${secondScalars.side_ft}/${secondScalars.rear_ft}${secondScalars.side_corner_ft != null ? `/${secondScalars.side_corner_ft}` : ""} (front/side/rear${secondScalars.side_corner_ft != null ? "/corner" : ""}), dated ${note.source_date ?? "unreadable"} (${note.date_basis}).`,
    citation_url: secondSource.citationUrl ?? undefined,
    conflict: note,
  };

  return {
    kind: "conflict",
    table: withSecondSourceDisclosure(followedTable, disclosure),
    followed,
    secondSource,
    reason,
    note,
  };
}

/**
 * Attach a second-source disclosure to a table's governing row, preserving any
 * disclosure the row already carries (Bastrop's R25 layer-83 revisions note on
 * a per-parcel table) by keeping its prose in the note rather than dropping it.
 */
function withSecondSourceDisclosure(
  table: SetbackTable,
  disclosure: SetbackSecondSourceDisclosure,
): SetbackTable {
  const merging = table.districts.find((d) => d.display_meta?.second_source)?.display_meta
    ?.second_source;
  const merged: SetbackSecondSourceDisclosure = merging
    ? { ...disclosure, note: `${disclosure.note} (Also disclosed: ${merging.note})` }
    : disclosure;
  return {
    ...table,
    districts: table.districts.map((d, i) =>
      i === 0 ? { ...d, display_meta: { ...(d.display_meta ?? {}), second_source: merged } } : d,
    ),
  };
}


/**
 * Resolve the table for a parcel's stamped zoning code, under R-1.
 *
 * Returns `null` when there is no table at all (absence). Otherwise a
 * {@link SetbackTableResolution}: `kind: "table"` for a single source or
 * sources that agree, `kind: "conflict"` when two readable-dated sources
 * disagree on a value — the followed values are on `table` in BOTH arms, and
 * the disagreement is named on the conflict arm (see its docstring; wave 6
 * changed this from `SetbackTable | null`, which collapsed the conflict).
 *
 * City of Bastrop (per-parcel layer 23 + ordinance text):
 *   - When `options.bastropPerParcelRecord` is supplied, the two candidates
 *     are resolved under R-1 (see `resolveBastropEuclideanCandidate`).
 *   - Without a per-parcel record, this returns null for city BDC districts
 *     — callers MUST NOT use chart scalars as warm authors for Bastrop city
 *     (fetch layer 23 first). The chart table is reachable directly through
 *     {@link getSetbackTable} for edition/citation lookup.
 *   - Repealed B3 Place Types (P-1..P-5, P-CS, P-EC) → null
 *     (honest-decline). Do NOT silently serve bastrop-city-tx as current.
 *
 * County / other jurisdictions: the keyed table, always `kind: "table"`
 * (one source; nothing to resolve between).
 */
export function getSetbackTableForZoning(
  jurisdictionKey: string,
  zoningCode: string | null | undefined,
  options?: SetbackTableResolveOptions,
): SetbackTableResolution | null {
  const normalized = normalizeJurisdictionKey(jurisdictionKey);
  const code = (zoningCode ?? "").trim().toUpperCase();

  if (options?.bastropPerParcelRecord && isBastropCityJurisdiction(normalized)) {
    const district = (options.districtCode ?? code).trim();
    if (!district) return null;
    return resolveBastropEuclideanCandidate(normalized, district, options.bastropPerParcelRecord);
  }

  if (isBastropCityJurisdiction(normalized)) {
    if (code && isRepealedB3PlaceType(code)) {
      return null;
    }

    // County-only legacy codes (R-MD, etc.) on bastrop-tx key — not city BDC.
    if (
      normalized === "bastrop-tx" &&
      code &&
      !isKnownBdcDistrictCode(code)
    ) {
      const legacy = SETBACK_TABLES["bastrop-tx"];
      return legacy ? { kind: "table", table: legacy } : null;
    }

    /**
     * R13 (AMENDMENT 8): city BDC districts require a layer-23 per-parcel
     * record, so this returns null without one and the chart's SCALARS are
     * never served alone. The chart stays reachable through
     * {@link getSetbackTable} for edition and citation lookup, which is what
     * this docstring has always said and what P-219's export path uses.
     *
     * P-219 considered amending this for the Euclidean districts and did NOT,
     * deliberately. A-148 (2026-09-14) plus this lane's own live re-read
     * (2026-09-15: all 175 `ZoneTypeClass = 3` rows on
     * `Zone_Types/FeatureServer/25` read text 30/10/30 with a 20 ft corner
     * side against numeric 25/5/25, and the BDC corpus row reads the same
     * 30/10/30/20) is a strong argument that the chart alone is now safe to
     * author scalars for SF-1/SF-2/SF-3/RR. But AMENDMENT 8 is a standing
     * ruling that P-154 explicitly left alone ("deliberately unchanged by
     * P-154"), and three controls assert it. Overturning it is an operator
     * call, not a lane's. It is proposed in the P-219 close with this evidence
     * attached; until then the rule stands as written.
     */
    return null;
  }

  if (normalized === "elgin-tx" || normalized === "elgin-development-code") {
    const elgin = SETBACK_TABLES["elgin-development-code"];
    return elgin ? { kind: "table", table: elgin } : null;
  }

  const keyed = SETBACK_TABLES[normalized];
  return keyed ? { kind: "table", table: keyed } : null;
}

/**
 * Look up a single zoning district within a jurisdiction. Case-
 * insensitive on the district name to absorb the small spelling
 * differences between the GIS layer and the ordinance PDF.
 */
export function getSetbackDistrict(
  jurisdictionKey: string,
  districtName: string,
): SetbackDistrict | null {
  const table = getSetbackTable(jurisdictionKey);
  if (!table) return null;
  const wanted = districtName.trim().toLowerCase();
  return (
    table.districts.find(
      (d) => d.district_name.toLowerCase() === wanted,
    ) ?? null
  );
}

export function listSetbackTables(): SetbackTable[] {
  return Object.values(SETBACK_TABLES);
}

/** P-219 — setback provenances retired as value authors, and their decline. */
export {
  RETIRED_SETBACK_DECLINE_REASON,
  RETIRED_SETBACK_PROVENANCE_PREFIXES,
  RETIRED_WHEN_RULED_TABLE_EXISTS,
  isRetiredSetbackProvenance,
  retiredSetbackDecline,
  type RetiredSetbackDecline,
} from "./retired-setback-provenance.js";

export {
  BASTROP_PARCELS_ONE_CLICK_LAYER_23,
  BASTROP_ZONE_TYPE_CLASS,
  fetchBastropPerParcelSetbackRecord,
  flagBastropChartDisagreement,
  parseBastropPerParcelAttributes,
  parseScalarSetbackFeet,
  parseSideSetbackText,
  resolveBastropLayer23DominantRow,
  selectBastropLayer23Attributes,
  setbackTableFromBastropPerParcelRecord,
  type BastropChartDisagreement,
  type BastropPerParcelHonestDecline,
  type BastropPerParcelSetbackParsed,
  type FetchBastropPerParcelOptions,
  type ParsedSideSetback,
} from "./bastrop-per-parcel-record.js";
export {
  BASTROP_AUTHORITATIVE_SETBACK_ADAPTER,
  bastropSetbackPendingRewarmReason,
  isAuthoritativeBastropCitySetbackSource,
  isBastropCountyParcelNodeId,
  isStaleBastropCitySetbackRule,
  requiresPerParcelSetbackRecord,
} from "./bastrop-setback-currency.js";
export {
  NO_SETBACK_RULE_ENVELOPE_BASIS,
  PLACEHOLDER_SETBACK_PROVENANCE,
  PLACEHOLDER_SETBACK_UNKNOWN_BASIS,
  RETIRED_ROAD_CLASS_SETBACK_BASIS,
  ROAD_CLASS_SETBACK_PROVENANCE,
  classifyBoundaryEdgeSetback,
  classifyEnvelopeServe,
  classifySetbackRuleAtom,
  type BoundarySetbackBody,
  type EnvelopeServeVerdict,
  type SetbackRuleProvenanceInput,
  type SetbackServeDisposition,
  type SetbackServeVerdict,
} from "./setback-provenance-disposition.js";
