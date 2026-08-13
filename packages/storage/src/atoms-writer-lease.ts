/**
 * Database-enforced atoms bulk-writer lease (OPS-16 A-012 ruling 0).
 *
 * PgStorage.writePropertyAtomsBatch validates + heartbeats this row and
 * FAILS CLOSED with ATOMS_WRITER_LEASE_NOT_HELD without a live match.
 * Take / release live in the CLI; the batch path never creates a lease.
 */

import type postgres from "postgres";

export const ATOMS_WRITER_LEASE_NOT_HELD = "ATOMS_WRITER_LEASE_NOT_HELD";
export const ATOMS_WRITER_LEASE_HELD_BY_OTHER = "ATOMS_WRITER_LEASE_HELD_BY_OTHER";
export const WRITER_LEASE_LOCK_ID = 1;
export const DEFAULT_LEASE_TTL_MS = 60 * 60 * 1000;
export const WRITER_LEASE_HOLDER_ENV = "ATOMS_WRITER_LEASE_HOLDER";

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

export interface WriterLeaseRow {
  holder: string;
  taken_at: Date | string;
  heartbeat: Date | string;
  expires: Date | string;
}

export interface WriterLeaseView {
  holder: string;
  takenAt: string;
  heartbeat: string;
  expires: string;
}

function toIso(value: Date | string): string {
  return typeof value === "string" ? value : value.toISOString();
}

export function resolveWriterLeaseHolder(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const raw = env[WRITER_LEASE_HOLDER_ENV]?.trim();
  return raw ? raw : undefined;
}

function ttlMsOrDefault(ttlMs?: number): number {
  if (ttlMs == null || !Number.isFinite(ttlMs) || ttlMs <= 0) {
    return DEFAULT_LEASE_TTL_MS;
  }
  return ttlMs;
}

export async function assertAndHeartbeatWriterLease(
  sql: postgres.Sql,
  options?: { holder?: string; now?: Date; ttlMs?: number },
): Promise<WriterLeaseView> {
  const holder = options?.holder ?? resolveWriterLeaseHolder();
  if (!holder) {
    throw new AtomsWriterLeaseNotHeldError(
      `${WRITER_LEASE_HOLDER_ENV} is unset — a writer without the live lease cannot write`,
    );
  }
  const now = options?.now ?? new Date();
  const nowIso = now.toISOString();
  const expiresIso = new Date(now.getTime() + ttlMsOrDefault(options?.ttlMs)).toISOString();

  const updated = await sql<WriterLeaseRow[]>`
    UPDATE atoms_bulk_writer_lease
    SET heartbeat = ${nowIso}::timestamptz,
        expires = ${expiresIso}::timestamptz
    WHERE lock_id = ${WRITER_LEASE_LOCK_ID}
      AND holder = ${holder}
      AND expires > ${nowIso}::timestamptz
    RETURNING holder, taken_at, heartbeat, expires
  `;
  if (updated.length === 0) {
    throw new AtomsWriterLeaseNotHeldError(
      `no live lease for holder=${holder}`,
    );
  }
  const row = updated[0]!;
  return {
    holder: row.holder,
    takenAt: toIso(row.taken_at),
    heartbeat: toIso(row.heartbeat),
    expires: toIso(row.expires),
  };
}

export async function takeWriterLease(
  sql: postgres.Sql,
  options: { holder: string; now?: Date; ttlMs?: number },
): Promise<WriterLeaseView> {
  const holder = options.holder.trim();
  if (!holder) {
    throw new AtomsWriterLeaseNotHeldError("take requires a non-empty holder");
  }
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const expiresIso = new Date(now.getTime() + ttlMsOrDefault(options.ttlMs)).toISOString();

  const rows = await sql<WriterLeaseRow[]>`
    INSERT INTO atoms_bulk_writer_lease (lock_id, holder, taken_at, heartbeat, expires)
    VALUES (
      ${WRITER_LEASE_LOCK_ID},
      ${holder},
      ${nowIso}::timestamptz,
      ${nowIso}::timestamptz,
      ${expiresIso}::timestamptz
    )
    ON CONFLICT (lock_id) DO UPDATE SET
      holder = EXCLUDED.holder,
      taken_at = CASE
        WHEN atoms_bulk_writer_lease.holder = EXCLUDED.holder
          THEN atoms_bulk_writer_lease.taken_at
        ELSE EXCLUDED.taken_at
      END,
      heartbeat = EXCLUDED.heartbeat,
      expires = EXCLUDED.expires
    WHERE atoms_bulk_writer_lease.expires <= ${nowIso}::timestamptz
       OR atoms_bulk_writer_lease.holder = EXCLUDED.holder
    RETURNING holder, taken_at, heartbeat, expires
  `;
  if (rows.length === 0) {
    const current = await readWriterLease(sql);
    throw new AtomsWriterLeaseHeldByOtherError(
      `live lease held by ${current?.holder ?? "unknown"} until ${current?.expires ?? "unknown"}`,
    );
  }
  const row = rows[0]!;
  return {
    holder: row.holder,
    takenAt: toIso(row.taken_at),
    heartbeat: toIso(row.heartbeat),
    expires: toIso(row.expires),
  };
}

export async function releaseWriterLease(
  sql: postgres.Sql,
  options: { holder: string },
): Promise<WriterLeaseView> {
  const holder = options.holder.trim();
  if (!holder) {
    throw new AtomsWriterLeaseNotHeldError("release requires a non-empty holder");
  }
  const rows = await sql<WriterLeaseRow[]>`
    DELETE FROM atoms_bulk_writer_lease
    WHERE lock_id = ${WRITER_LEASE_LOCK_ID}
      AND holder = ${holder}
    RETURNING holder, taken_at, heartbeat, expires
  `;
  if (rows.length === 0) {
    throw new AtomsWriterLeaseNotHeldError(
      `release failed — no lease row for holder=${holder}`,
    );
  }
  const row = rows[0]!;
  return {
    holder: row.holder,
    takenAt: toIso(row.taken_at),
    heartbeat: toIso(row.heartbeat),
    expires: toIso(row.expires),
  };
}

export async function readWriterLease(
  sql: postgres.Sql,
): Promise<WriterLeaseView | null> {
  const rows = await sql<WriterLeaseRow[]>`
    SELECT holder, taken_at, heartbeat, expires
    FROM atoms_bulk_writer_lease
    WHERE lock_id = ${WRITER_LEASE_LOCK_ID}
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    holder: row.holder,
    takenAt: toIso(row.taken_at),
    heartbeat: toIso(row.heartbeat),
    expires: toIso(row.expires),
  };
}
