/**
 * Permits column — declared serve shape + parcel-record cell semantics.
 *
 * A field that does not exist cannot be honestly absent. Unsourced jurisdiction
 * (absent-verified + basis) must not render the same as sourced empty-set (value).
 */

import type { CompanionCellState, CompanionValueCell, ScalarAbsentVerifiedCell } from "./cell-state.js";

/** One permit row in the companion table and on the served wire. */
export interface ParcelPermitRow {
  permitNumber: string;
  permitType: string | null;
  status: string;
  /** ISO-8601 issue or status date when known. */
  issueDate: string | null;
  /** Adapter / dataset id (e.g. austin-soda). */
  sourceId: string;
  /** Public deeplink when present. */
  sourceUrl: string | null;
}

/** Declared serve-shape field — renderAs is explicit so UI cannot collapse states. */
export type PermitsServeField =
  | {
      field: "permits";
      renderAs: "unsourced";
      jurisdictionKey: string;
      basis: string;
      rows: readonly [];
    }
  | {
      field: "permits";
      renderAs: "empty-set";
      jurisdictionKey: string;
      source: string;
      vintage: string;
      rows: readonly [];
    }
  | {
      field: "permits";
      renderAs: "rows";
      jurisdictionKey: string;
      source: string;
      vintage: string;
      rows: readonly ParcelPermitRow[];
    };

export function unsourcedPermitsBasis(jurisdictionKey: string): string {
  return `permits unsourced for jurisdiction ${jurisdictionKey}`;
}

export function unresolvedPermitsBasis(): string {
  return "permits jurisdiction unresolved — permits unsourced";
}

/** Cell for a jurisdiction we have not acquired — NOT an empty permit set. */
export function unsourcedPermitsCell(jurisdictionKey: string): ScalarAbsentVerifiedCell {
  return {
    kind: "absent-verified",
    basis: unsourcedPermitsBasis(jurisdictionKey),
  };
}

/** Sourced jurisdiction, acquisition looked, zero permits on this parcel. */
export function sourcedEmptyPermitsCell(
  source: string,
  vintage: string,
): CompanionValueCell {
  return {
    kind: "value",
    disposition: "empty-set",
    rowCount: 0,
    source,
    vintage,
  };
}

/** Sourced jurisdiction with one or more companion rows. */
export function sourcedPermitsWithRowsCell(
  rowCount: number,
  source: string,
  vintage: string,
): CompanionValueCell {
  if (rowCount <= 0) {
    throw new Error("sourcedPermitsWithRowsCell requires rowCount > 0");
  }
  return {
    kind: "value",
    disposition: "rows",
    rowCount,
    source,
    vintage,
  };
}

export function isPermitsUnsourcedCell(
  cell: CompanionCellState,
): cell is ScalarAbsentVerifiedCell {
  return cell.kind === "absent-verified";
}

export function isPermitsSourcedEmptyCell(
  cell: CompanionCellState,
): cell is CompanionValueCell & { disposition: "empty-set" } {
  return cell.kind === "value" && cell.disposition === "empty-set";
}

export function isPermitsSourcedWithRowsCell(
  cell: CompanionCellState,
): cell is CompanionValueCell & { disposition: "rows" } {
  return cell.kind === "value" && cell.disposition === "rows";
}

/** Type-level contract: unsourced absent-verified ≠ sourced empty-set. */
export function permitsServeStatesAreDistinct(
  a: PermitsServeField,
  b: PermitsServeField,
): boolean {
  return a.renderAs !== b.renderAs;
}

export function projectPermitsServeField(args: {
  jurisdictionKey: string;
  permitsCell: CompanionCellState;
  companionRows: readonly ParcelPermitRow[];
}): PermitsServeField {
  const { jurisdictionKey, permitsCell, companionRows } = args;

  if (isPermitsUnsourcedCell(permitsCell)) {
    return {
      field: "permits",
      renderAs: "unsourced",
      jurisdictionKey,
      basis: permitsCell.basis,
      rows: [],
    };
  }

  if (permitsCell.kind !== "value") {
    throw new Error(
      `permits serve projection requires value or absent-verified; got ${permitsCell.kind}`,
    );
  }

  if (permitsCell.disposition === "empty-set") {
    return {
      field: "permits",
      renderAs: "empty-set",
      jurisdictionKey,
      source: permitsCell.source,
      vintage: permitsCell.vintage,
      rows: [],
    };
  }

  return {
    field: "permits",
    renderAs: "rows",
    jurisdictionKey,
    source: permitsCell.source,
    vintage: permitsCell.vintage,
    rows: companionRows,
  };
}
