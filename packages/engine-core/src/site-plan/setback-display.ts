/**
 * Honest setback display for site-plan sheets.
 *
 * `not_specified` means the code is silent (build-to-line governs) — never
 * invent a number, and never treat silence as "missing setback data" that
 * refuses the whole export.
 */

import { getSetbackTableForZoning } from "@hauska-engine/adapters";

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
    // B3 PlaceTypes live under bastrop-city-tx via getSetbackTableForZoning(bastrop-tx, P-*).
    "bastrop-tx",
  ].filter((k): k is string => typeof k === "string" && k.trim().length > 0);

  for (const key of keys) {
    const table = getSetbackTableForZoning(key, code);
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
