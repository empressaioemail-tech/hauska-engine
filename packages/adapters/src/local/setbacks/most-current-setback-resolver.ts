/**
 * P-154 (OPS-23 wave 3) — the one setback resolver: MOST-CURRENT SOURCE WINS.
 *
 * Decision: `_decisions/2026-09-11_setback_source_most_current_wins.md` (R-1).
 * "For setbacks and every other dimensional rule, in every city and county:
 * the source with the most recent effective date supplies the value.
 * Authority tier ... breaks ties only when the dates are equal or cannot be
 * read. ... When no date can be read, the row shows both values with both
 * sources and says the conflict is unresolved. A silent pick is prohibited."
 *
 * This module is pure (no I/O, no fetch, no fs). Callers gather candidates —
 * a codified-ordinance table row, a per-parcel GIS record, an atom-chain
 * setback-rule — each already carrying a `sourceDate` READ AT SOURCE and a
 * `dateBasis` naming how that date was read, and hand them to
 * {@link resolveMostCurrentSetback}. The function never infers a date from
 * source kind; a candidate whose date could not be read at source carries
 * `sourceDate: null` and `dateBasis: "unreadable"`.
 *
 * HOME OF THIS MODULE (leave_behind, P-154 close): the mission's stated
 * preference is `@empressaio/setback-corpus` (substrate seat), as a
 * `resolve` subpath beside the tables — the one package all three
 * producers below could, in principle, all import. That worktree was not
 * granted this wave (no substrate seat checkout was available to this lane;
 * `hauska-setback-corpus` has no P:/ checkout at all per the wave-3 verify
 * snapshot), so this module lives here instead, per the mission's own
 * fallback instruction ("put the module in hauska-engine packages/adapters
 * ... and say so").
 *
 * IMPORTANT, verified 2026-09-12 (see close `contradicted`): this package
 * (`@hauska-engine/adapters`) is `private: true` and unpublished (404 on
 * the npm registry). `hauska-factory/src/lib/setback-writer/
 * setback-table-router.mjs` and `hauska-factory/src/jobs/
 * parcel-setback-cells.mjs` already carry their own 2026-09-10 correction
 * recording that this exact package is "a separate, already-diverged fork
 * nothing live calls" for their purposes, and that neither this package nor
 * legacy-design-tools' `@workspace/adapters` is importable from the factory
 * repo — only `@empressaio/setback-corpus` is. So placing the resolver here
 * reaches this repo's OWN Bastrop per-parcel adapter (a real, live producer
 * — the feasibility PDF path) but does NOT reach legacy-design-tools or
 * hauska-factory without either publishing this package or landing the
 * corpus `resolve` subpath. Both are true at once; neither cancels the
 * other out. Do not "fix" this by duplicating the algorithm a third place —
 * that is exactly what the mission forbids ("never a third copy").
 */

export type SetbackScalars = {
  front_ft: number;
  side_ft: number;
  rear_ft: number;
  side_corner_ft?: number;
};

/** Authority tier — breaks ties ONLY when dates are equal or unreadable (R-1). Never ranks alone. */
export type SetbackSourceTier =
  | "codified-ordinance"
  | "gis-per-parcel"
  | "atom-chain";

export const SETBACK_SOURCE_TIER_RANK: Readonly<Record<SetbackSourceTier, number>> = {
  "codified-ordinance": 3,
  "gis-per-parcel": 2,
  "atom-chain": 1,
};

/**
 * How a candidate's `sourceDate` was established. Per the mission: an
 * ordinance/corpus table by its `effectiveDate`; a per-parcel GIS row by the
 * effective date of the ordinance the row cites (when that citation
 * resolves), else by the layer's `dataLastEditDate` (never
 * `editingInfo.lastEditDate`, which stamps schema edits too); an atom by its
 * `sourceVintage`, never `extractedAt`. "unreadable" is a first-class value,
 * not an absence of one — a candidate with no readable date MUST carry this
 * literal string, never a placeholder date like "1970-01-01".
 */
export type SetbackDateBasis =
  | "ordinance-effective-date"
  | "corpus-table-effective-date"
  | "gis-row-citation-ordinance"
  | "gis-row-edit-date"
  | "gis-layer-data-last-edit-unattributed"
  | "atom-source-vintage"
  | "unreadable";

/** A dateBasis whose date cannot be pinned to the SPECIFIC row/candidate — layer-wide, not row-level. */
const ROW_UNATTRIBUTED_DATE_BASES: ReadonlySet<SetbackDateBasis> = new Set([
  "gis-layer-data-last-edit-unattributed",
]);

export type SetbackCandidate = {
  /** Stable id for disclosure/log lines; not used in comparison. */
  id: string;
  sourceKind: SetbackSourceTier;
  sourceLabel: string;
  scalars: SetbackScalars;
  /** ISO yyyy-mm-dd, read at source. `null` means unreadable — never a placeholder date. */
  sourceDate: string | null;
  dateBasis: SetbackDateBasis;
  /** Precision the sourceDate was actually established to (e.g. a citation that only names a year). */
  datePrecision?: "day" | "year";
  citationUrl: string | null;
  /** Free-form provenance a caller wants echoed back verbatim in a conflict row. */
  raw?: unknown;
};

export type ResolvedSetback = {
  status: "resolved";
  winner: SetbackCandidate;
  /** Every other candidate, each with why it lost. */
  superseded: ReadonlyArray<{ candidate: SetbackCandidate; reason: string }>;
};

export type ConflictSetback = {
  status: "conflict";
  /** Every candidate, unmodified — the row shows all of them, per R-1. No single value. */
  candidates: ReadonlyArray<SetbackCandidate>;
  reason: string;
};

export type SetbackResolution = ResolvedSetback | ConflictSetback;

function scalarsEqual(a: SetbackScalars, b: SetbackScalars): boolean {
  return (
    a.front_ft === b.front_ft &&
    a.side_ft === b.side_ft &&
    a.rear_ft === b.rear_ft &&
    (a.side_corner_ft ?? null) === (b.side_corner_ft ?? null)
  );
}

function isRowAttributed(c: SetbackCandidate): boolean {
  return !ROW_UNATTRIBUTED_DATE_BASES.has(c.dateBasis);
}

function byTierDesc(a: SetbackCandidate, b: SetbackCandidate): number {
  return SETBACK_SOURCE_TIER_RANK[b.sourceKind] - SETBACK_SOURCE_TIER_RANK[a.sourceKind];
}

/**
 * Resolve one district/parcel's setback scalars from every eligible
 * candidate under R-1 (most-current source wins; tier breaks a tie only on
 * equal or unreadable dates; disagreement against an unreadable date is a
 * conflict, never a silent pick).
 *
 * Requires at least one candidate — this function resolves BETWEEN
 * candidates; whether a candidate exists at all (e.g. no codified table,
 * no per-parcel record) is the caller's absence/decline logic, not this
 * function's.
 */
export function resolveMostCurrentSetback(
  candidates: ReadonlyArray<SetbackCandidate>,
): SetbackResolution {
  if (candidates.length === 0) {
    throw new Error(
      "resolveMostCurrentSetback requires at least one candidate; absence is the caller's concern, not this resolver's.",
    );
  }
  if (candidates.length === 1) {
    return { status: "resolved", winner: candidates[0]!, superseded: [] };
  }

  const readable = candidates.filter((c) => c.sourceDate != null);
  const unreadable = candidates.filter((c) => c.sourceDate == null);

  // --- No candidate carries a readable date at all: tier breaks the tie,
  // but ONLY if every candidate agrees on the value. Disagreement with no
  // date evidence anywhere is exactly the "silent pick" case R-1 forbids.
  if (readable.length === 0) {
    const byTier = [...candidates].sort(byTierDesc);
    const proposed = byTier[0]!;
    const disagreeing = candidates.filter((c) => !scalarsEqual(c.scalars, proposed.scalars));
    if (disagreeing.length > 0) {
      return {
        status: "conflict",
        candidates,
        reason:
          "no candidate carries a readable source date, and candidates disagree on the scalar value; " +
          "tier cannot break this tie without a silent pick.",
      };
    }
    return {
      status: "resolved",
      winner: proposed,
      superseded: candidates
        .filter((c) => c !== proposed)
        .map((candidate) => ({
          candidate,
          reason: "no readable date on any candidate; tier tie-break, values agree.",
        })),
    };
  }

  // --- Rank readable candidates by date. Row-attributed dates are preferred
  // over layer-wide/unattributed ones when both exist, since an unattributed
  // date cannot be pinned to THIS row (see ROW_UNATTRIBUTED_DATE_BASES).
  const attributed = readable.filter(isRowAttributed);
  const pool = attributed.length > 0 ? attributed : readable;

  const maxDate = pool.reduce((m, c) => (c.sourceDate! > m ? c.sourceDate! : m), pool[0]!.sourceDate!);
  let top = pool.filter((c) => c.sourceDate === maxDate);
  if (top.length > 1) {
    top = [[...top].sort(byTierDesc)[0]!];
  }
  const winner = top[0]!;

  // --- Conflict check 1: an unreadable-date candidate whose VALUE disagrees
  // with the winner. R-1: "an unreadable date produces a conflict row with
  // both values, never a silent pick" — but only when there IS a
  // disagreement to paper over; an unreadable date that happens to agree in
  // value is not a conflict.
  const disagreeingUnreadable = unreadable.filter((c) => !scalarsEqual(c.scalars, winner.scalars));
  if (disagreeingUnreadable.length > 0) {
    return {
      status: "conflict",
      candidates,
      reason:
        `winner "${winner.sourceLabel}" (${winner.sourceDate}, ${winner.dateBasis}) disagrees on value with ` +
        `unreadable-date candidate(s): ${disagreeingUnreadable.map((c) => c.sourceLabel).join(", ")}.`,
    };
  }

  // --- Conflict check 2: two or more row-unattributed candidates that
  // disagree with each other on date or value — "two candidates within the
  // same dateBasis class disagree on dates the service cannot attribute to
  // the row" (mission item 2).
  const unattributedByBasis = new Map<SetbackDateBasis, SetbackCandidate[]>();
  for (const c of candidates) {
    if (isRowAttributed(c)) continue;
    const list = unattributedByBasis.get(c.dateBasis) ?? [];
    list.push(c);
    unattributedByBasis.set(c.dateBasis, list);
  }
  for (const group of unattributedByBasis.values()) {
    if (group.length < 2) continue;
    const first = group[0]!;
    const disagree = group.some(
      (c) => c.sourceDate !== first.sourceDate || !scalarsEqual(c.scalars, first.scalars),
    );
    if (disagree) {
      return {
        status: "conflict",
        candidates,
        reason:
          `multiple "${first.dateBasis}" candidates disagree on a date the service cannot attribute to the row: ` +
          group.map((c) => `${c.sourceLabel}=${c.sourceDate ?? "null"}`).join(", "),
      };
    }
  }

  return {
    status: "resolved",
    winner,
    superseded: candidates
      .filter((c) => c !== winner)
      .map((candidate) => ({
        candidate,
        reason:
          candidate.sourceDate == null
            ? "unreadable date; value agrees with the dated winner."
            : `sourceDate ${candidate.sourceDate} (${candidate.dateBasis}) is not more recent than the winner's ${winner.sourceDate}.`,
      })),
  };
}

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parse a strict ISO yyyy-mm-dd date, or null. Never truncates a longer timestamp silently — callers that hold a full timestamp should slice deliberately and say why (see `atomSourceVintageToDate`). */
export function parseStrictIsoDate(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== "string") return null;
  const t = raw.trim();
  return ISO_DATE_RE.test(t) ? t : null;
}

/**
 * An atom's `sourceVintage` — never `extractedAt` (extractedAt is EMIT time,
 * per engine's own `emit-setback-rule.ts:141`: `new Date().toISOString()`).
 * Returns a date candidate fragment; caller supplies scalars/label/tier.
 */
export function dateFromAtomSourceVintage(
  sourceVintage: string | null | undefined,
): { sourceDate: string | null; dateBasis: SetbackDateBasis; datePrecision?: "day" } {
  const iso = parseStrictIsoDate(sourceVintage?.slice(0, 10));
  if (iso) return { sourceDate: iso, dateBasis: "atom-source-vintage", datePrecision: "day" };
  return { sourceDate: null, dateBasis: "unreadable" };
}

/** A codified table's own `effectiveDate` field. An "accessed ..." note in `table.note` is NOT an effective date — it says when someone looked, not when the law took effect — and is deliberately not treated as one here (see mission item 3: those tables "gain per-source date fields", they don't get a borrowed accessed-date). */
export function dateFromTableEffectiveDate(
  effectiveDate: string | null | undefined,
): { sourceDate: string | null; dateBasis: SetbackDateBasis; datePrecision?: "day" } {
  const iso = parseStrictIsoDate(effectiveDate);
  if (iso) return { sourceDate: iso, dateBasis: "ordinance-effective-date", datePrecision: "day" };
  return { sourceDate: null, dateBasis: "unreadable" };
}

/**
 * Bastrop's own ordinance-numbering convention is `<adoption-year>-<sequence>`
 * (this table's own winning row is "Ord. 2026-06"). A per-parcel GIS row's
 * citation field (e.g. `Ordinance_`) frequently names an ordinance this way
 * without the corpus carrying that specific ordinance's exact effective
 * day. Reading the citation's OWN year token is a date read AT THE SOURCE
 * (the row's own citation text), not an assumption from source kind — it is
 * the same category of read as trusting "Ord. 2026-06" to mean 2026. The
 * result is deliberately coarse (Jan 1 of that year) and carries
 * `datePrecision: "year"` so a caller never mistakes it for a day-precise
 * date; it is a safe LOWER bound for cross-year ordering (an ordinance
 * numbered for year Y was never effective before Y).
 *
 * Returns null when the citation does not match this convention — callers
 * must then fall through to a row edit-date or the layer's
 * `dataLastEditDate`, per the mission, not silently accept an unresolved
 * citation as this year-convention read.
 */
export function parseYearSequenceOrdinanceCitation(
  citation: string | null | undefined,
): { sourceDate: string; datePrecision: "year"; year: number } | null {
  if (!citation) return null;
  const m = /^\s*(\d{4})-(\d{1,3})\s*$/.exec(citation);
  if (!m) return null;
  const year = Number(m[1]);
  if (!Number.isFinite(year) || year < 1900 || year > 2100) return null;
  return { sourceDate: `${m[1]}-01-01`, datePrecision: "year", year };
}
