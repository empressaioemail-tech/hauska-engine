/**
 * Atoms writer lease v2 (OPS-19 F-02 / P-83).
 *
 * Scope is (entity_type, county_fips) for a bulk write, or one heavy-scan
 * scope per database. Holder is a minted token on HeldLease, never an env
 * var. v1 takeWriterLease / ATOMS_WRITER_LEASE_HOLDER is retired by refuse.
 */

import { randomUUID } from "node:crypto";

import type postgres from "postgres";

export const ATOMS_WRITER_LEASE_V1_RETIRED = "ATOMS_WRITER_LEASE_V1_RETIRED";
export const ATOMS_WRITER_LEASE_NOT_HELD = "ATOMS_WRITER_LEASE_NOT_HELD";
export const ATOMS_WRITER_LEASE_HELD_BY_OTHER = "ATOMS_WRITER_LEASE_HELD_BY_OTHER";
export const SCOPE_MISMATCH = "SCOPE_MISMATCH";
export const NO_GLOBAL = "NO_GLOBAL";
export const LEASE_EXPIRED = "LEASE_EXPIRED";
export const LEASE_REQUIRED = "LEASE_REQUIRED";

/** @deprecated v1 single-row lock id. Do not take. */
export const WRITER_LEASE_LOCK_ID = 1;
/** @deprecated v1 env holder. Reading it cannot satisfy a v2 write. */
export const WRITER_LEASE_HOLDER_ENV = "ATOMS_WRITER_LEASE_HOLDER";

export const DEFAULT_LEASE_TTL_MS = 15 * 60 * 1000;

export class AtomsWriterLeaseV1RetiredError extends Error {
  readonly code = ATOMS_WRITER_LEASE_V1_RETIRED;
  constructor() {
    super("v1 writer lease is retired");
    this.name = "AtomsWriterLeaseV1RetiredError";
  }
}

export class AtomsWriterLeaseNotHeldError extends Error {
  readonly code = ATOMS_WRITER_LEASE_NOT_HELD;
  constructor(detail: string) {
    super(`${ATOMS_WRITER_LEASE_NOT_HELD}: ${detail}`);
    this.name = "AtomsWriterLeaseNotHeldError";
  }
}

export class AtomsWriterLeaseHeldByOtherError extends Error {
  readonly code = ATOMS_WRITER_LEASE_HELD_BY_OTHER;
  constructor(detail: string) {
    super(`${ATOMS_WRITER_LEASE_HELD_BY_OTHER}: ${detail}`);
    this.name = "AtomsWriterLeaseHeldByOtherError";
  }
}

export class ScopeMismatchError extends Error {
  readonly code = SCOPE_MISMATCH;
  constructor(detail: string) {
    super(`${SCOPE_MISMATCH}: ${detail}`);
    this.name = "ScopeMismatchError";
  }
}

export class NoGlobalScopeError extends Error {
  readonly code = NO_GLOBAL;
  constructor() {
    super("GLOBAL scope refused");
    this.name = "NoGlobalScopeError";
  }
}

export class LeaseExpiredError extends Error {
  readonly code = LEASE_EXPIRED;
  constructor(detail: string) {
    super(`${LEASE_EXPIRED}: ${detail}`);
    this.name = "LeaseExpiredError";
  }
}

export class LeaseRequiredError extends Error {
  readonly code = LEASE_REQUIRED;
  constructor() {
    super("writePropertyAtomsBatch requires a HeldLease");
    this.name = "LeaseRequiredError";
  }
}

export type WriteLeaseScope = {
  scope_type: "write";
  entity_type: string;
  county_fips: string;
};

export type HeavyScanLeaseScope = {
  scope_type: "heavy-scan";
  database: string;
};

export type LeaseScope = WriteLeaseScope | HeavyScanLeaseScope;

export type HeldLease = {
  holder_token: string;
  holder_label: string;
  run_id: string;
  scope: LeaseScope;
  expires: string;
  stolen_from: string | null;
};

type LeaseV2Row = {
  scope_type: string;
  scope_id: string;
  holder_token: string;
  holder_label: string;
  run_id: string;
  taken_at: Date | string;
  heartbeat: Date | string;
  expires: Date | string;
  stolen_from: string | null;
};

const FIPS = /^\d{5}$/;

export function isHeldLease(value: unknown): value is HeldLease {
  if (value == null || typeof value !== "object") return false;
  const v = value as HeldLease;
  return (
    typeof v.holder_token === "string" &&
    v.holder_token.length > 0 &&
    typeof v.holder_label === "string" &&
    typeof v.run_id === "string" &&
    v.run_id.length > 0 &&
    v.scope != null &&
    typeof v.scope === "object" &&
    (v.scope.scope_type === "write" || v.scope.scope_type === "heavy-scan")
  );
}

export function scopeIdOf(scope: LeaseScope): string {
  if (scope.scope_type === "write") {
    return `${scope.entity_type}:${scope.county_fips}`;
  }
  return scope.database;
}

function refuseGlobal(scope: LeaseScope): void {
  if (scope.scope_type === "write") {
    if (
      scope.entity_type === "GLOBAL" ||
      scope.county_fips === "GLOBAL" ||
      !scope.entity_type ||
      !FIPS.test(scope.county_fips)
    ) {
      throw new NoGlobalScopeError();
    }
    return;
  }
  if (!scope.database || scope.database === "GLOBAL") {
    throw new NoGlobalScopeError();
  }
}

function ttlMsOrDefault(ttlMs?: number): number {
  if (ttlMs == null || !Number.isFinite(ttlMs) || ttlMs <= 0) {
    return DEFAULT_LEASE_TTL_MS;
  }
  return ttlMs;
}

function toIso(value: Date | string): string {
  return typeof value === "string" ? value : value.toISOString();
}

function rowToHeldLease(row: LeaseV2Row, scope: LeaseScope): HeldLease {
  return {
    holder_token: String(row.holder_token),
    holder_label: row.holder_label,
    run_id: row.run_id,
    scope,
    expires: toIso(row.expires),
    stolen_from: row.stolen_from,
  };
}

/** v1 take. Retired. A successful return cannot satisfy a v2 write. */
export async function takeWriterLease(): Promise<never> {
  throw new AtomsWriterLeaseV1RetiredError();
}

/** v1 heartbeat / env holder. Retired. */
export async function assertAndHeartbeatWriterLease(): Promise<never> {
  throw new AtomsWriterLeaseV1RetiredError();
}

/** v1 release. Retired. */
export async function releaseWriterLease(): Promise<never> {
  throw new AtomsWriterLeaseV1RetiredError();
}

export async function takeScopedLease(
  sql: postgres.Sql,
  options: {
    scope: LeaseScope;
    holder_label: string;
    run_id: string;
    now?: Date;
    ttlMs?: number;
  },
): Promise<HeldLease> {
  refuseGlobal(options.scope);
  const run_id = options.run_id.trim();
  const holder_label = options.holder_label.trim();
  if (!run_id) {
    throw new AtomsWriterLeaseNotHeldError("take requires a run_id");
  }
  if (!holder_label) {
    throw new AtomsWriterLeaseNotHeldError("take requires a holder_label");
  }
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const expiresIso = new Date(now.getTime() + ttlMsOrDefault(options.ttlMs)).toISOString();
  const holder_token = randomUUID();
  const scope_id = scopeIdOf(options.scope);
  const scope_type = options.scope.scope_type;

  const rows = await sql<LeaseV2Row[]>`
    INSERT INTO atoms_writer_lease_v2 (
      scope_type, scope_id, holder_token, holder_label, run_id,
      taken_at, heartbeat, expires, stolen_from
    ) VALUES (
      ${scope_type},
      ${scope_id},
      ${holder_token}::uuid,
      ${holder_label},
      ${run_id},
      ${nowIso}::timestamptz,
      ${nowIso}::timestamptz,
      ${expiresIso}::timestamptz,
      NULL
    )
    ON CONFLICT (scope_type, scope_id) DO UPDATE SET
      holder_token = EXCLUDED.holder_token,
      holder_label = EXCLUDED.holder_label,
      run_id = EXCLUDED.run_id,
      taken_at = EXCLUDED.taken_at,
      heartbeat = EXCLUDED.heartbeat,
      expires = EXCLUDED.expires,
      stolen_from = atoms_writer_lease_v2.holder_label
    WHERE atoms_writer_lease_v2.expires <= ${nowIso}::timestamptz
    RETURNING
      scope_type, scope_id, holder_token, holder_label, run_id,
      taken_at, heartbeat, expires, stolen_from
  `;
  if (rows.length === 0) {
    const current = await sql<LeaseV2Row[]>`
      SELECT scope_type, scope_id, holder_token, holder_label, run_id,
             taken_at, heartbeat, expires, stolen_from
        FROM atoms_writer_lease_v2
       WHERE scope_type = ${scope_type}
         AND scope_id = ${scope_id}
    `;
    const held = current[0];
    throw new AtomsWriterLeaseHeldByOtherError(
      `live lease held by ${held?.holder_label ?? "unknown"} until ${held?.expires ?? "unknown"}`,
    );
  }
  return rowToHeldLease(rows[0]!, options.scope);
}

export async function lockAndHeartbeatLease(
  sql: postgres.Sql,
  lease: HeldLease,
  options?: { now?: Date; ttlMs?: number },
): Promise<HeldLease> {
  if (!isHeldLease(lease)) {
    throw new LeaseRequiredError();
  }
  refuseGlobal(lease.scope);
  const now = options?.now ?? new Date();
  const nowIso = now.toISOString();
  const expiresIso = new Date(now.getTime() + ttlMsOrDefault(options?.ttlMs)).toISOString();
  const scope_id = scopeIdOf(lease.scope);

  const rows = await sql<LeaseV2Row[]>`
    SELECT scope_type, scope_id, holder_token, holder_label, run_id,
           taken_at, heartbeat, expires, stolen_from
      FROM atoms_writer_lease_v2
     WHERE holder_token = ${lease.holder_token}::uuid
       AND expires > ${nowIso}::timestamptz
     FOR UPDATE
  `;
  if (rows.length === 0) {
    throw new LeaseExpiredError(
      `no live row for token scope ${lease.scope.scope_type}:${scope_id}`,
    );
  }
  const row = rows[0]!;
  if (row.scope_type !== lease.scope.scope_type || row.scope_id !== scope_id) {
    throw new ScopeMismatchError(
      `locked row ${row.scope_type}:${row.scope_id} != ${lease.scope.scope_type}:${scope_id}`,
    );
  }
  const updated = await sql<LeaseV2Row[]>`
    UPDATE atoms_writer_lease_v2
       SET heartbeat = ${nowIso}::timestamptz,
           expires = ${expiresIso}::timestamptz
     WHERE holder_token = ${lease.holder_token}::uuid
    RETURNING
      scope_type, scope_id, holder_token, holder_label, run_id,
      taken_at, heartbeat, expires, stolen_from
  `;
  return rowToHeldLease(updated[0]!, lease.scope);
}

export function assertScopeOnAtoms(
  lease: HeldLease,
  atoms: ReadonlyArray<{ entityType: string; entityId: string; parcelNodeId?: string }>,
): void {
  if (lease.scope.scope_type !== "write") {
    throw new ScopeMismatchError("bulk write requires a write scope, not heavy-scan");
  }
  const { entity_type, county_fips } = lease.scope;
  for (const atom of atoms) {
    if (atom.entityType !== entity_type) {
      throw new ScopeMismatchError(
        `atom entityType ${atom.entityType} != lease ${entity_type}`,
      );
    }
    const atomFips = atom.entityId.split(":")[0] ?? "";
    if (atomFips !== county_fips) {
      throw new ScopeMismatchError(
        `atom entityId fips ${atomFips} != lease ${county_fips}`,
      );
    }
    if (atom.parcelNodeId) {
      const parcelFips = atom.parcelNodeId.split(":")[0] ?? "";
      if (parcelFips !== county_fips) {
        throw new ScopeMismatchError(
          `atom parcelNodeId fips ${parcelFips} != lease ${county_fips}`,
        );
      }
    }
  }
}

export async function releaseScopedLease(
  sql: postgres.Sql,
  lease: HeldLease,
): Promise<void> {
  const rows = await sql<LeaseV2Row[]>`
    DELETE FROM atoms_writer_lease_v2
     WHERE holder_token = ${lease.holder_token}::uuid
    RETURNING
      scope_type, scope_id, holder_token, holder_label, run_id,
      taken_at, heartbeat, expires, stolen_from
  `;
  if (rows.length === 0) {
    throw new AtomsWriterLeaseNotHeldError(
      `release failed — no lease row for token`,
    );
  }
}

/** v1 status read. Retired with the env holder. */
export async function readWriterLease(): Promise<never> {
  throw new AtomsWriterLeaseV1RetiredError();
}
