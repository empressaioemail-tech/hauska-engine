// packages/engine-core/src/site-plan/etj-determination.ts
//
// P-358 (OPS-24): the engine's mirror of the ETJ determination vocabulary that
// hauska-map's Property Explorer panel owns at
// `apps/property-explorer/api/_lib/pe-etj-determination.ts` (P-332, hauska-map
// #419, live 2026-09-18). The panel serves four states; before this module the
// engine wrote the answer as a literal, so the PDF said `unresolved` for every
// parcel in every county while the panel named the determination.
//
// WHY A MIRROR AND NOT AN IMPORT. These are two repositories; there is no
// package boundary between them. The alternative to a copy is a second
// independent derivation of the same rule, which is worse than a documented
// duplicate: this file names its source symbol by symbol, and every shared
// literal is exported so the cross-repo drift check (P-331) can hold the two
// spellings together. The duplication precedent is already in this tree --
// `pdf/feasibility.ts` copies `countyDisplayName` from `pdf/format.ts` and says
// why (the composition layer must not depend on the presentation layer). Here
// the reason is a repo boundary.
//
// FOUR STATES, NOT A BOOLEAN. `etjStatus` is
// "present" | "absent" | "unresolved" | "conflicting". `conflicting` is
// emitted ONLY when city limits say `incorporated` AND the ETJ read says
// `present`: a Texas extraterritorial jurisdiction is by definition
// unincorporated land outside a city's limits, so those two independently
// derived reads disagree, and the report declares the disagreement rather than
// printing `present` as a clean fact beside `incorporated`, and rather than
// dropping either side.
//
// NEVER DERIVE (P-332's rule 3). ETJ is never derived from city limits and city
// limits is never derived from ETJ. If no determination is in hand the state is
// `unresolved` with a reason saying why.
//
// WHAT IS NOT SETTLED HERE. WHICH of the two reads is wrong for a live conflict
// (48453:134392) is a store question, deliberately not decided in code. This
// module's job is to stop the report from hiding the disagreement, not to
// adjudicate it.

/** The four served states. `conflicting` is derived; the other three are read.
 * VERBATIM mirror of hauska-map `pe-etj-determination.ts`'s `ETJ_STATUSES`. */
export const ETJ_STATUSES = ["present", "absent", "unresolved", "conflicting"] as const;
export type EtjStatus = (typeof ETJ_STATUSES)[number];

/** The states a determination itself can carry (no `conflicting` at source).
 * Mirror of hauska-map's `RawEtjStatus`. */
export type RawEtjStatus = "present" | "absent" | "unresolved";

export type EtjQueryPoint = { longitude: number; latitude: number };

/**
 * The ETJ determination as it is carried. Mirror of hauska-map's `EtjFactWire`,
 * which in turn mirrors what cortex serves inside `cityLimitsFact.etjFact`
 * (P-296) and what P-336's ledger cells carry. A determination with no `basis`
 * is not a determination -- it is an assertion nothing can state a reason for --
 * so `readEtjFact` refuses one rather than serving it bare.
 */
export interface EtjFactWire {
  status: RawEtjStatus;
  source: string;
  basis: string;
  cityKey?: string;
  cityName?: string;
  ringLabel?: string;
  etjId?: string;
  sourceCitation?: string;
  coveredBy?: ReadonlyArray<string>;
  ringsConsulted?: number;
  queryPoint?: EtjQueryPoint | null;
}

/**
 * The declared conflict. Both sides are named, with their own sources and their
 * own bases. Mirror of hauska-map's `EtjConflictWire`; the `note` text is the
 * same sentence the panel prints, built from the same parts.
 */
export interface EtjConflictWire {
  state: "conflicting";
  cityLimits: {
    state: "incorporated";
    source: string;
    basis: string;
    cityName: string | null;
  };
  etj: {
    state: "present";
    source: string;
    basis: string;
    ringLabel: string | null;
    etjId: string | null;
  };
  note: string;
}

/** What the report carries: the state, the determination behind it, the
 * declared conflict when there is one, and why there is not. Mirror of
 * hauska-map's `EtjDetermination`. */
export interface EtjDetermination {
  etjStatus: EtjStatus;
  /** The raw determination carried through, or null when there was none. */
  etjFact: EtjFactWire | null;
  /** Set only when `etjStatus === "conflicting"`. */
  etjConflict: EtjConflictWire | null;
  /** Set only when `etjStatus === "unresolved"`: why no determination is served. */
  etjReason: string | null;
}

/**
 * Why the report serves `unresolved` when it has no determination: it has none,
 * and it will not invent one. VERBATIM mirror of hauska-map's
 * `NO_DETERMINATION_REASON` (including its P-332 provenance), deliberately
 * byte-identical so P-331's drift table sees one literal and not two variants.
 */
export const NO_DETERMINATION_REASON =
  "no ETJ determination was served for this point; P-332: ETJ is never derived from city limits, nor city limits from ETJ.";

/**
 * The engine-only honest default for a rail that is not slated `record` for this
 * county, for a caller that supplied no reader, and for a failed fetch. This is
 * byte-identical to the sentence the PDF prints for every parcel today, so an
 * unslated county's document is UNCHANGED by P-358 -- which is the state every
 * county is in until P-336's cells apply.
 */
export const UNSLATED_ETJ_REASON =
  "No ETJ boundary source is wired for this county yet, so extraterritorial-jurisdiction status is unverified.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function isEtjStatus(value: unknown): value is EtjStatus {
  return typeof value === "string" && (ETJ_STATUSES as readonly string[]).includes(value);
}

function isRawEtjStatus(value: unknown): value is RawEtjStatus {
  return value === "present" || value === "absent" || value === "unresolved";
}

function strArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((v): v is string => typeof v === "string");
  return out.length ? out : undefined;
}

function queryPoint(value: unknown): EtjQueryPoint | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const lon = value.longitude;
  const lat = value.latitude;
  if (typeof lon !== "number" || typeof lat !== "number") return undefined;
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return undefined;
  return { longitude: lon, latitude: lat };
}

/**
 * Validate a determination. A determination with no basis is not one, so it is
 * refused here rather than served bare -- an unfounded block is not an absence
 * and nothing may state a reason for it. Mirror of hauska-map's `readEtjFact`,
 * field for field, so a payload the panel accepts the report also accepts.
 */
export function readEtjFact(value: unknown): EtjFactWire | null {
  if (!isRecord(value)) return null;
  if (!isRawEtjStatus(value.status)) return null;
  const source = str(value.source);
  const basis = str(value.basis);
  if (!source || !basis) return null;
  const out: EtjFactWire = { status: value.status, source, basis };
  const cityKey = str(value.cityKey);
  if (cityKey) out.cityKey = cityKey;
  const cityName = str(value.cityName);
  if (cityName) out.cityName = cityName;
  const ringLabel = str(value.ringLabel);
  if (ringLabel) out.ringLabel = ringLabel;
  const etjId = str(value.etjId);
  if (etjId) out.etjId = etjId;
  const sourceCitation = str(value.sourceCitation);
  if (sourceCitation) out.sourceCitation = sourceCitation;
  const coveredBy = strArray(value.coveredBy);
  if (coveredBy) out.coveredBy = coveredBy;
  if (typeof value.ringsConsulted === "number" && Number.isFinite(value.ringsConsulted)) {
    out.ringsConsulted = value.ringsConsulted;
  }
  const qp = queryPoint(value.queryPoint);
  if (qp !== undefined) out.queryPoint = qp;
  return out;
}

/**
 * Validate a DECLARED conflict -- the shape P-336 writes when the ledger itself
 * records that the two reads disagree. Both sides must be present with their own
 * sources and bases; a `conflicting` state with no readings behind it would be a
 * declaration nothing on the page could substantiate, so it is refused and the
 * composer falls back to applying the shared rule to what it does have.
 */
export function readEtjConflict(value: unknown): EtjConflictWire | null {
  if (!isRecord(value)) return null;
  if (value.state !== "conflicting" && value.status !== "conflicting") return null;
  const cl = isRecord(value.cityLimits) ? value.cityLimits : null;
  const etj = isRecord(value.etj) ? value.etj : null;
  if (!cl || !etj) return null;
  const clSource = str(cl.source);
  const clBasis = str(cl.basis);
  const etjSource = str(etj.source);
  const etjBasis = str(etj.basis);
  if (!clSource || !clBasis || !etjSource || !etjBasis) return null;
  return {
    state: "conflicting",
    cityLimits: {
      state: "incorporated",
      source: clSource,
      basis: clBasis,
      cityName: str(cl.cityName),
    },
    etj: {
      state: "present",
      source: etjSource,
      basis: etjBasis,
      ringLabel: str(etj.ringLabel),
      etjId: str(etj.etjId),
    },
    note: str(value.note) ?? conflictNote({ cityLimitsSource: clSource, etjSource, ringLabel: str(etj.ringLabel) }),
  };
}

/**
 * The declared-disagreement sentence. Built from the same parts and with the
 * same wording as hauska-map's conflict `note`, so the PDF and the panel state
 * the disagreement the same way.
 */
function conflictNote(input: { cityLimitsSource: string; etjSource: string; ringLabel: string | null }): string {
  return (
    `City limits say this point is incorporated (${input.cityLimitsSource}) while the ETJ read says it is ` +
    `inside a published ETJ ring (${input.etjSource}${input.ringLabel ? `: "${input.ringLabel}"` : ""}). ` +
    "An extraterritorial jurisdiction is unincorporated land outside a city's limits, so the two independently " +
    "derived answers disagree. Both are served and neither is dropped; the disagreement is not resolved here."
  );
}

/**
 * VERBATIM mirror of hauska-map's `etjBasisFromCityLimitsBasis`. Cortex stamps
 * its ETJ read onto the city-limits `basis` as a trailing `ETJ:` segment, so
 * when a `present` read arrives as a top-level state WITHOUT a well-formed fact
 * block, that segment is the only real basis in hand for the ETJ side of a
 * conflict -- recover it rather than substituting a generic sentence.
 */
function etjBasisFromCityLimitsBasis(basis: string): string | null {
  const marker = basis.indexOf("ETJ:");
  if (marker < 0) return null;
  const segment = basis.slice(marker + 4).trim();
  return segment || null;
}

/**
 * One rail answer, read into the engine's own terms.
 *
 * `value` is present exactly when the cell carried a usable answer; the composer
 * turns a `refusal` or an `absence` into `unresolved` with the ledger's own
 * words, and `current-path` (an unslated rail) into the engine's honest default.
 */
export interface EtjRailReading {
  /** The state the cell declared, one of the four. */
  status: EtjStatus;
  /**
   * The RAW determination in hand — the engine's mirror of hauska-map's
   * `rawEtjStatusInHand`, so the same five-cell (city-limits x raw) matrix comes
   * out of both implementations and P-331's behaviour matrix can compare them
   * cell for cell.
   *
   * A declared `conflicting` maps back to raw `present`, because `present` is
   * the only raw that can produce it. That is what makes a cell which declares a
   * disagreement WITHOUT carrying the declaration block safe: the shared rule
   * normalises it against the engine's own city-limits read instead of the
   * report printing a conflict the rule cannot produce (e.g. beside
   * `unincorporated` city limits, where `present` is the coherent answer).
   * A cell that DOES carry the declaration block is carried through verbatim and
   * never reaches the rule (see `resolveEtjDetermination`).
   */
  raw: RawEtjStatus;
  fact: EtjFactWire | null;
  conflict: EtjConflictWire | null;
  /** Set only when `status === "unresolved"`. */
  reason: string | null;
}

/**
 * Read a `value` cell into a rail answer, or `undefined` when this reader cannot
 * use the payload at all (which the caller reports as a declared refusal rather
 * than as silence -- the P-302 rule).
 *
 * THREE SHAPES ARE ACCEPTED, and they are enumerated rather than inferred:
 *   1. a bare state string ("present" / "absent" / "unresolved" / "conflicting"),
 *      which carries no basis -- `unresolved` then carries the shared
 *      `NO_DETERMINATION_REASON`, and `conflicting` is normalised to raw
 *      `present` so the shared rule decides the served state;
 *   2. a determination object (the `EtjFactWire` shape: `status` + `source` +
 *      `basis`), carried through with its optional fields;
 *   3. a declared conflict object (the `EtjConflictWire` shape), carried through
 *      verbatim with BOTH readings and BOTH sources.
 * Anything else is `undefined`: an unrecognised payload is not evidence about
 * the parcel.
 */
export function readEtjReading(value: unknown): EtjRailReading | undefined {
  if (typeof value === "string") {
    if (!isEtjStatus(value)) return undefined;
    return {
      status: value,
      // Mirror of the panel's `etjStatusInHand === "conflicting"` branch: the
      // declared disagreement is re-normalised, not trusted as a raw state.
      raw: value === "conflicting" ? "present" : value,
      fact: null,
      conflict: null,
      reason: value === "unresolved" ? NO_DETERMINATION_REASON : null,
    };
  }
  if (!isRecord(value)) return undefined;

  const declaredConflict = readEtjConflict(value);
  const fact = readEtjFact(value);
  if (value.status === "conflicting" || value.state === "conflicting") {
    if (!declaredConflict) {
      // A declared `conflicting` with no readings behind it cannot substantiate
      // itself, so it is not carried as a conflict; see the doc comment on
      // `EtjRailReading.raw` for why this is a normalisation and not a refusal.
      return {
        status: "conflicting",
        raw: "present",
        fact,
        conflict: null,
        reason: null,
      };
    }
    return { status: "conflicting", raw: "present", fact, conflict: declaredConflict, reason: null };
  }
  if (!fact) return undefined;
  return {
    status: fact.status,
    raw: fact.status,
    fact,
    conflict: null,
    reason: fact.status === "unresolved" ? fact.basis : null,
  };
}

/** The engine's own reading of city limits, as the conflict rule needs it. */
export interface EtjCityLimitsReading {
  status: "incorporated" | "unincorporated" | "unresolved";
  cityName: string | null;
  /** The city-limits source, e.g. `parcel_record (landing_parcel_jurisdiction)`. */
  source: string;
  /** The city-limits basis sentence, from the rail's own words when it has them. */
  basis: string;
}

/**
 * THE RULE, once. Mirror of hauska-map's `resolveEtjDetermination`, evaluated on
 * the RAW determination so both implementations answer the same five-cell
 * (city-limits x raw) matrix:
 *
 *   incorporated   + present -> conflicting (the declared disagreement)
 *   incorporated   + absent  -> absent
 *   unincorporated + present -> present (coherent: a city's ETJ is OUTSIDE its
 *                                        limits, so present land is unincorporated)
 *   unincorporated + absent  -> absent
 *   anything       + unresolved -> unresolved, keeping its own reason
 *
 * A determination that is itself `unresolved` keeps its own reason. Nothing in
 * hand serves `unresolved` with `fallbackReason`, which is the caller's honest
 * sentence for "the rail is not slated here" (or the caller supplied no reader,
 * or the fetch failed).
 *
 * ONE DELIBERATE ADDITION over the panel: when the cell carried a DECLARATION
 * BLOCK (`EtjConflictWire` — both readings with both sources, which the panel
 * never receives because it reads cortex's fact rather than a ledger cell), the
 * declaration is carried through verbatim and the rule is not re-derived. There
 * is nothing to derive: the ledger already named both sides. Re-deriving would
 * replace the ledger's own reading with the engine's copy of it, and forwarding
 * what the panel says is this lane's whole point.
 */
export function resolveEtjDetermination(input: {
  cityLimits: EtjCityLimitsReading;
  reading: EtjRailReading | null;
  fallbackReason: string;
}): EtjDetermination {
  const { cityLimits, reading } = input;

  if (!reading) {
    return { etjStatus: "unresolved", etjFact: null, etjConflict: null, etjReason: input.fallbackReason };
  }

  if (reading.status === "unresolved") {
    return {
      etjStatus: "unresolved",
      etjFact: reading.fact,
      etjConflict: null,
      etjReason: reading.reason ?? NO_DETERMINATION_REASON,
    };
  }

  if (reading.status === "conflicting" && reading.conflict) {
    return { etjStatus: "conflicting", etjFact: reading.fact, etjConflict: reading.conflict, etjReason: null };
  }

  if (reading.raw === "present" && cityLimits.status === "incorporated") {
    return {
      etjStatus: "conflicting",
      etjFact: reading.fact,
      etjConflict: composeConflict(cityLimits, reading.fact),
      etjReason: null,
    };
  }

  // present on unincorporated or unresolved city limits (coherent), or a checked
  // absence. The raw state is the served state.
  return { etjStatus: reading.raw, etjFact: reading.fact, etjConflict: null, etjReason: null };
}

function composeConflict(cityLimits: EtjCityLimitsReading, etjFact: EtjFactWire | null): EtjConflictWire {
  const etjSource = etjFact?.source ?? "tx_etj_boundary";
  const ringLabel = etjFact?.ringLabel ?? null;
  return {
    state: "conflicting",
    cityLimits: {
      state: "incorporated",
      source: cityLimits.source,
      basis: cityLimits.basis,
      cityName: cityLimits.cityName,
    },
    etj: {
      state: "present",
      source: etjSource,
      basis:
        etjFact?.basis ??
        etjBasisFromCityLimitsBasis(cityLimits.basis) ??
        "the ETJ read returned present with no basis served alongside it.",
      ringLabel,
      etjId: etjFact?.etjId ?? null,
    },
    note: conflictNote({ cityLimitsSource: cityLimits.source, etjSource, ringLabel }),
  };
}
