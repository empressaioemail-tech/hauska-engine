/**
 * Honest setback display for site-plan sheets.
 *
 * `not_specified` means the code is silent (build-to-line governs) — never
 * invent a number, and never treat silence as "missing setback data" that
 * refuses the whole export.
 */

import { getSetbackTableForZoning } from "@hauska-engine/adapters";
import type { SetbackSecondSourceConflict } from "@hauska-engine/adapters";
import {
  CITATION_DEGRADED,
  setbackConflictNote,
} from "@empressaio/atom-contract/display";

export type NotSpecifiedAxes = {
  front?: boolean;
  side?: boolean;
  rear?: boolean;
};

export function anyNotSpecified(ns: NotSpecifiedAxes | null | undefined): boolean {
  return !!(ns?.front || ns?.side || ns?.rear);
}

/** Feet used for inward offset — silent axes inset 0 (no fabricated dimension). */
export function insetFeetForAxis(
  value: number,
  silent: boolean | undefined,
): number {
  return silent ? 0 : value;
}

/**
 * Summary / sheet legend line. Never renders a silent axis as a real "0 ft".
 */
export function formatSetbackSummaryLine(input: {
  front: number;
  side: number;
  rear: number;
  notSpecified?: NotSpecifiedAxes | null;
}): string {
  const ns = input.notSpecified ?? {};
  if (!anyNotSpecified(ns)) {
    return `${input.front} / ${input.side} / ${input.rear} ft`;
  }
  const axis = (label: string, ft: number, silent?: boolean) =>
    silent ? `${label} not specified` : `${label} ${ft}'`;
  return (
    `${axis("F", input.front, ns.front)} · ${axis("S", input.side, ns.side)} · ` +
    `${axis("R", input.rear, ns.rear)} — build-to-line governs`
  );
}

/** Edge label on the sheet: "F 15'" or "S not specified — build-to-line governs". */
export function formatSetbackEdgeLabel(
  role: string,
  distanceFt: number,
  silent?: boolean,
): string {
  const r = role.toUpperCase();
  if (silent) return `${r} not specified — build-to-line governs`;
  return `${r} ${distanceFt}'`;
}

/**
 * Map a {@link SetbackSecondSourceConflict} (the field names the engine's rows
 * and atoms carry, snake_case like the rest of `display_meta`) onto the input
 * of `setbackConflictNote` (the vocabulary module's camelCase input). One
 * mapping, in one place, so no surface can hand the formatter a field-swapped
 * sentence.
 */
/**
 * The 1.36.0 (`A-148`) input shape of `setbackConflictNote`, spelled out here
 * because the INSTALLED `@empressaio/atom-contract` may predate it: the
 * amendment landed on the vocabulary package's own PR and the npm publish is a
 * separate, gated step (1.35.x installs carry only the two-instrument arm, with
 * no `shape` discriminator). Writing the shape down keeps this module honest
 * about what it hands over, and `conflictNote` below is the ONE place that
 * casts to the published signature.
 */
type ConflictNoteInputV136 =
  | {
      shape: "second-source";
      secondSourceLabel: string;
      front: number;
      side: number;
      rear: number;
      corner?: number | null;
      citation: string | null;
      repealedByEffectiveDate: string | null;
    }
  | {
      shape: "stale-numeric-columns";
      secondSourceLabel: string;
      numeric: { front: number; side: number; rear: number };
      text: { front: number; side: number; rear: number; corner?: number | null };
      ordinance: string;
      confirmedWith?: string | null;
      confirmedOn?: string | null;
    };

/**
 * The published function's own parameter type. With a 1.36.0 install this is
 * exactly {@link ConflictNoteInputV136}; with a 1.35.x install it is the older,
 * discriminator-less shape.
 */
type PublishedConflictNoteInput = Parameters<typeof setbackConflictNote>[0];

export function conflictNoteInput(
  conflict: SetbackSecondSourceConflict,
): ConflictNoteInputV136 {
  if (conflict.shape === "stale-numeric-columns") {
    // A-148 shape: ONE layer whose numeric shortcut columns were never
    // refreshed, versus its own text fields. Three axes for the second source
    // and no corner (there is no numeric corner column), the ordinance is
    // required, and the confirmation travels when the record carries one.
    return {
      shape: "stale-numeric-columns",
      secondSourceLabel: conflict.secondSourceLabel,
      numeric: {
        front: conflict.numeric.front,
        side: conflict.numeric.side,
        rear: conflict.numeric.rear,
      },
      text: {
        front: conflict.text.front,
        side: conflict.text.side,
        rear: conflict.text.rear,
        corner: conflict.text.corner ?? null,
      },
      ordinance: conflict.ordinance,
      confirmedWith: conflict.confirmedWith ?? null,
      confirmedOn: conflict.confirmedOn ?? null,
    };
  }
  return {
    shape: "second-source",
    secondSourceLabel: conflict.secondSourceLabel,
    front: conflict.front,
    side: conflict.side,
    rear: conflict.rear,
    corner: conflict.corner ?? null,
    citation: conflict.citation,
    repealedByEffectiveDate: conflict.repealedByEffectiveDate,
  };
}

/**
 * The ONE sentence every surface prints, from the ONE vocabulary module. Keep
 * calling this, never `setbackConflictNote` directly: the cast is the single,
 * documented seam between `ConflictNoteInputV136` (the A-148 shape this module
 * builds) and whatever `@empressaio/atom-contract` version is installed. A
 * 1.35.x install cannot print the stale-columns arm — install 1.36.0 before
 * deploying a surface that can show a conflict row (see the note above).
 */
export function conflictNote(conflict: SetbackSecondSourceConflict): string {
  const sentence = setbackConflictNote(
    conflictNoteInput(conflict) as unknown as PublishedConflictNoteInput,
  );
  // FAIL CLOSED. A 1.35.x install has no A-148 arm, so handing it the
  // stale-columns shape would print a sentence that does not name the values
  // ("...shows undefined/undefined/undefined..."). A conflict row's whole job is
  // to state both claims out loud, so a sentence that fails to name them must
  // not reach a surface at all. Value-anchored, not wording-anchored: the
  // readings the payload carries must appear in the string that came back.
  if (conflict.shape === "stale-numeric-columns") {
    const numeric = `${conflict.numeric.front}/${conflict.numeric.side}/${conflict.numeric.rear}`;
    const text = `${conflict.text.front}/${conflict.text.side}/${conflict.text.rear}`;
    if (!sentence.includes(numeric) || !sentence.includes(text)) {
      throw new Error(
        `@empressaio/atom-contract cannot render the stale-numeric-columns conflict shape (needs >=1.36.0): the sentence it produced (${JSON.stringify(sentence)}) does not name the values (${numeric} vs ${text}). Refusing to print a conflict claim that does not state its numbers.`,
      );
    }
  }
  return sentence;
}

/**
 * P-154 (OPS-23 wave 6, R-1 CONFLICT ROW) — the sentence(s) that travel with
 * the followed setback values: the source we follow with its own citation and
 * effective date, and, when two sources disagree, the ONE conflict sentence
 * from `@empressaio/atom-contract` (`setbackConflictNote`).
 *
 * This is the PDF's half of the cross-surface contract: the panel and
 * `get_smart_site` print the same sentence, from the same vocabulary module,
 * so a customer comparing surfaces reads one claim. The clause is a no-op
 * (empty string) when the caller has nothing read at source to say — it never
 * invents a citation, and it never asserts a source date the atom did not
 * carry (a pre-wave-6 atom prints exactly what it printed before).
 */
export function formatSetbackSourceClause(input: {
  /** The followed source's own published name. */
  sourceLabel?: string | null;
  /** The followed row's own citation — an ordinance URL or an ordinance number. */
  citation?: string | null;
  /** The followed row's own date, read at source; null/unreadable prints honestly. */
  sourceDate?: string | null;
  /** How that date was read (SetbackDateBasis); not printed, kept for callers. */
  dateBasis?: string | null;
  /** Two sources disagree — the structured payload of the one conflict sentence. */
  conflict?: SetbackSecondSourceConflict | null;
}): string {
  const bits: string[] = [];
  const label = input.sourceLabel?.trim();
  if (label) bits.push(`source: ${label}`);
  const date = input.sourceDate?.trim();
  if (date) bits.push(`effective ${date}`);
  const citation = input.citation?.trim();
  if (citation) {
    bits.push(
      /^https?:\/\//i.test(citation)
        ? `cited ${citation}`
        : /^ord\.?\s/i.test(citation)
          ? `citing ${citation}`
          : `citing Ord. ${citation}`,
    );
  } else if (date || label) {
    // A value with no citation must say so out loud (falsifier: any surface
    // printing a value with no citation after this change means the
    // disclosure is missing). The word is the vocabulary's own.
    bits.push(CITATION_DEGRADED);
  }
  const clause = bits.length > 0 ? ` — ${bits.join(", ")}.` : "";
  const conflict = input.conflict ? ` ${conflictNote(input.conflict)}` : "";
  return `${clause}${conflict}`;
}

/**
 * Resolve not_specified flags from setback-rule fieldProvenance and/or a
 * district table lookup (B3 place types). Provenance wins; table fills gaps.
 */
export function resolveNotSpecifiedAxes(input: {
  fieldProvenance?: {
    front?: { notSpecified?: boolean };
    side?: { notSpecified?: boolean };
    rear?: { notSpecified?: boolean };
  } | null;
  tableAxes?: NotSpecifiedAxes | null;
}): NotSpecifiedAxes | undefined {
  const fromWire: NotSpecifiedAxes = {};
  if (input.fieldProvenance?.front?.notSpecified) fromWire.front = true;
  if (input.fieldProvenance?.side?.notSpecified) fromWire.side = true;
  if (input.fieldProvenance?.rear?.notSpecified) fromWire.rear = true;
  const merged: NotSpecifiedAxes = {
    ...(input.tableAxes ?? {}),
    ...fromWire,
  };
  return anyNotSpecified(merged) ? merged : undefined;
}

function leadingDistrictToken(districtName: string): string {
  return (districtName.trim().split(/\s+/)[0] ?? "").toUpperCase();
}

/** Read not_specified axes from a jurisdiction setback table row. */
export function notSpecifiedAxesFromSetbackTable(
  jurisdictionKey: string | null | undefined,
  districtCode: string | null | undefined,
): NotSpecifiedAxes | undefined {
  if (!districtCode?.trim()) return undefined;
  const code = districtCode.trim();
  const keys = [
    jurisdictionKey,
    // BDC Euclidean districts live under bastrop-development-code via
    // getSetbackTableForZoning(bastrop-tx, SF-*). Repealed P-* returns null.
    "bastrop-tx",
  ].filter((k): k is string => typeof k === "string" && k.trim().length > 0);

  for (const key of keys) {
    // Wave 6: `.table` — for the Bastrop city path with a supplied record the
    // resolution may be `kind: "conflict"`, and its `table` is still the source
    // R-1 follows, so the axis read is over a table either way (the conflict is
    // disclosed on that table's display_meta, not refused here).
    const table = getSetbackTableForZoning(key, code)?.table;
    if (!table) continue;
    const wanted = leadingDistrictToken(code);
    const district = table.districts.find((d) => leadingDistrictToken(d.district_name) === wanted);
    if (!district?.provenance || typeof district.provenance !== "object") continue;
    const p = district.provenance as Record<string, { not_specified?: boolean } | undefined>;
    const tableAxes: NotSpecifiedAxes = {};
    if (p.front_ft?.not_specified === true) tableAxes.front = true;
    if (p.side_ft?.not_specified === true) tableAxes.side = true;
    if (p.rear_ft?.not_specified === true) tableAxes.rear = true;
    const axes = resolveNotSpecifiedAxes({ tableAxes });
    if (axes) return axes;
  }
  return undefined;
}
