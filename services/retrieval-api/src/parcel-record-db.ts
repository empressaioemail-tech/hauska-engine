/**
 * Read-only client for the Factory's parcel_record store (P-152 step 1/2/3).
 *
 * Structurally read-only, two layers deep, mirroring cortex's own
 * `parcelRecordCellRead.ts` (legacy-design-tools, PARCEL-RO-ROLE): the
 * connection authenticates as Postgres role `parcel_record_ro` (SELECT
 * only on parcel_record / parcel_record_cell / parcel_record_companion_row
 * / parcel_gate_verdict — verified by violation, an INSERT through this
 * credential fails with "permission denied" at the database), credential
 * `FACTORY_DATABASE_URL_RO` (never `FACTORY_DATABASE_URL`, the writer
 * credential). Every connection additionally requests
 * `default_transaction_read_only` as a session parameter at connect time
 * (postgres.js `connection` option — sent in the startup packet, applied
 * before this module's first query), so a write is refused twice over —
 * role grant first, protocol-level session flag second — even though the
 * role grant alone is the real enforcement boundary.
 *
 * This module never issues a county-scoped scan. `parcel_record_cell` has
 * no index that would make one cheap (confirmed 2026-09-11: PK is
 * `place_key` only, `parcel_record` also carries only a `county_fips`
 * btree, no `prop_id` index) — the sibling cortex reader's own module doc
 * measured a full county materialization at 101.5s for the smallest
 * program county. Every query here is a point lookup on an exact
 * `place_key`, or a small bounded `= ANY(...)` over a handful of literal
 * candidate keys (see `resolvePlaceKey`), never a scan.
 */

import postgres from "postgres";

export interface ParcelRecordCell {
  /** The decoded cell_state JSONB object, verbatim, including 'kind'. */
  raw: Record<string, unknown> | null;
}

export interface ParcelRecordCompanionRow {
  rowIndex: number;
  payload: unknown;
  source: string;
  vintage: string;
}

export type ParcelGateVerdictKind = "pass" | "refuse" | "excluded";

export interface ParcelGateVerdict {
  verdict: ParcelGateVerdictKind;
  evaluatedAt: string;
}

export type PlaceKeyResolution =
  | { state: "resolved"; placeKey: string }
  | { state: "not-found" }
  | { state: "ambiguous"; candidates: string[] };

export interface ParcelFactoryStore {
  loadCell(placeKey: string, railKey: string): Promise<ParcelRecordCell>;
  loadCompanionRows(
    placeKey: string,
    railKey: string,
  ): Promise<ParcelRecordCompanionRow[]>;
  loadGateVerdict(
    countyFips: string,
    railKey: string,
  ): Promise<ParcelGateVerdict | null>;
  /**
   * Raw/normalized prop_id crosswalk (dispatch fact: place_key is raw,
   * parcelNodeId's prop_id token is normalizeForJoin'd — the two coincide
   * except where a raw prop_id carries leading zeros). Checks the direct
   * (already-normalized) key plus a small bounded set of zero-padded
   * candidates as exact PK lookups (`= ANY`), never a scan. `ambiguous`
   * means two or more distinct candidate keys are BOTH real parcel_record
   * rows — refuse rather than guess, per P-161 being unbuilt.
   */
  resolvePlaceKey(
    countyFips: string,
    normalizedPropId: string,
  ): Promise<PlaceKeyResolution>;
  close(): Promise<void>;
}

export function resolveFactoryDatabaseUrl(explicit?: string): string | undefined {
  const url = explicit ?? process.env.FACTORY_DATABASE_URL_RO;
  return url && url.trim().length > 0 ? url.trim() : undefined;
}

/** Max extra leading zeros tried when the direct (normalized) key misses. Bounded, never a scan. */
const MAX_ZERO_PAD_ATTEMPTS = 6;

function zeroPaddedCandidates(countyFips: string, normalizedPropId: string): string[] {
  if (!/^\d+$/.test(normalizedPropId)) return [];
  const out: string[] = [];
  for (let pad = 1; pad <= MAX_ZERO_PAD_ATTEMPTS; pad++) {
    out.push(`${countyFips}:${"0".repeat(pad)}${normalizedPropId}`);
  }
  return out;
}

export function createFactoryRoStore(options: {
  databaseUrl: string;
  maxConnections?: number;
}): ParcelFactoryStore {
  const ssl =
    options.databaseUrl.includes("sslmode=require") ||
    options.databaseUrl.includes("neon.tech")
      ? ("require" as const)
      : false;
  const sql = postgres(options.databaseUrl, {
    ssl,
    max: options.maxConnections ?? 2,
    connection: {
      // Session-level defense in depth, second to the role grant itself.
      default_transaction_read_only: true,
    },
  });

  return {
    async loadCell(placeKey, railKey) {
      const rows = await sql<Array<{ cell_state: unknown }>>`
        SELECT cell_state
          FROM parcel_record_cell
         WHERE place_key = ${placeKey}
           AND rail_key = ${railKey}
      `;
      const row = rows[0];
      if (!row) return { raw: null };
      const rec = row.cell_state;
      if (!rec || typeof rec !== "object" || Array.isArray(rec)) return { raw: null };
      return { raw: rec as Record<string, unknown> };
    },

    async loadCompanionRows(placeKey, railKey) {
      const rows = await sql<
        Array<{ row_index: number; payload: unknown; source: string; vintage: string }>
      >`
        SELECT row_index, payload, source, vintage
          FROM parcel_record_companion_row
         WHERE place_key = ${placeKey}
           AND rail_key = ${railKey}
         ORDER BY row_index
      `;
      return rows.map((r) => ({
        rowIndex: r.row_index,
        payload: r.payload,
        source: r.source,
        vintage: r.vintage,
      }));
    },

    async loadGateVerdict(countyFips, railKey) {
      try {
        const rows = await sql<
          Array<{ verdict: string; evaluated_at: string }>
        >`
          SELECT verdict, evaluated_at
            FROM parcel_gate_verdict
           WHERE county_fips = ${countyFips}
             AND rail_key = ${railKey}
        `;
        const row = rows[0];
        if (!row) return null;
        if (row.verdict !== "pass" && row.verdict !== "refuse" && row.verdict !== "excluded") {
          return null;
        }
        return { verdict: row.verdict, evaluatedAt: row.evaluated_at };
      } catch {
        // Table not yet visible to this role/connection, or any other read
        // failure: "no usable verdict", matching cortex's own
        // loadParcelGateVerdict fail-closed contract.
        return null;
      }
    },

    async resolvePlaceKey(countyFips, normalizedPropId) {
      const directKey = `${countyFips}:${normalizedPropId}`;
      const candidates = [directKey, ...zeroPaddedCandidates(countyFips, normalizedPropId)];
      // Live-verified 2026-09-11 against FACTORY_DATABASE_URL_RO: this
      // postgres.js version's `= ANY(${sql.array(...)})` fails at the
      // database with "op ANY/ALL (array) requires array on right side";
      // `IN ${sql(candidates)}` is the form that actually binds as a list
      // of literal params (still a small bounded set of PK lookups, not a
      // scan).
      const rows = await sql<Array<{ place_key: string }>>`
        SELECT place_key
          FROM parcel_record
         WHERE place_key IN ${sql(candidates)}
      `;
      const found = rows.map((r) => r.place_key);
      if (found.length === 0) return { state: "not-found" };
      if (found.length === 1) return { state: "resolved", placeKey: found[0]! };
      return { state: "ambiguous", candidates: found };
    },

    async close() {
      await sql.end({ timeout: 5 });
    },
  };
}

/** In-memory store for tests. Refuses any shape it does not recognize. */
export function memoryFactoryStore(fixture: {
  cells?: ReadonlyArray<{ placeKey: string; railKey: string; cellState: Record<string, unknown> }>;
  companionRows?: ReadonlyArray<{
    placeKey: string;
    railKey: string;
    rowIndex: number;
    payload: unknown;
    source: string;
    vintage: string;
  }>;
  verdicts?: ReadonlyArray<{ countyFips: string; railKey: string; verdict: ParcelGateVerdictKind; evaluatedAt: string }>;
  /** Raw parcel_record place_key rows, for resolvePlaceKey. */
  places?: ReadonlyArray<string>;
  /** Force loadCell/loadCompanionRows/loadGateVerdict to reject, to test the unreadable-store path. */
  failReads?: boolean;
}): ParcelFactoryStore {
  const cells = fixture.cells ?? [];
  const companionRows = fixture.companionRows ?? [];
  const verdicts = fixture.verdicts ?? [];
  const places = fixture.places ?? [];

  return {
    async loadCell(placeKey, railKey) {
      if (fixture.failReads) throw new Error("simulated factory store read failure");
      const row = cells.find((c) => c.placeKey === placeKey && c.railKey === railKey);
      return { raw: row ? row.cellState : null };
    },
    async loadCompanionRows(placeKey, railKey) {
      if (fixture.failReads) throw new Error("simulated factory store read failure");
      return companionRows
        .filter((r) => r.placeKey === placeKey && r.railKey === railKey)
        .sort((a, b) => a.rowIndex - b.rowIndex)
        .map((r) => ({ rowIndex: r.rowIndex, payload: r.payload, source: r.source, vintage: r.vintage }));
    },
    async loadGateVerdict(countyFips, railKey) {
      if (fixture.failReads) return null;
      const match = verdicts.find((v) => v.countyFips === countyFips && v.railKey === railKey);
      return match ? { verdict: match.verdict, evaluatedAt: match.evaluatedAt } : null;
    },
    async resolvePlaceKey(countyFips, normalizedPropId) {
      if (fixture.failReads) throw new Error("simulated factory store read failure");
      const directKey = `${countyFips}:${normalizedPropId}`;
      const candidates = new Set([directKey, ...zeroPaddedCandidates(countyFips, normalizedPropId)]);
      const found = places.filter((p) => candidates.has(p));
      if (found.length === 0) return { state: "not-found" };
      if (found.length === 1) return { state: "resolved", placeKey: found[0]! };
      return { state: "ambiguous", candidates: found };
    },
    async close() {},
  };
}
