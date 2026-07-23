/**
 * Write finding.outcome.recorded rows + upsert atom_calibration_overlay.
 *
 * Overlay home: cortex Neon (migration 0037) — same Topology A as Gate C.
 * Chain hash algorithm mirrors `@empressaio/atom-contract` history.ts
 * (deterministic SHA-256 over prevHash+payload+occurredAt+eventType+actor).
 */

import { createHash, randomBytes } from "node:crypto";
import type { Sql } from "postgres";
import {
  permitOutcomeEntityId,
  toFindingOutcomePayload,
  type NormalizedPermitOutcome,
} from "@hauska-engine/adapters/portal/permit-outcomes";

export const FINDING_OUTCOME_RECORDED_EVENT_TYPE =
  "finding.outcome.recorded" as const;

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function generateId(): string {
  let time = Date.now();
  let timeChars = "";
  for (let i = 0; i < 10; i++) {
    timeChars = (CROCKFORD[time % 32] ?? "0") + timeChars;
    time = Math.floor(time / 32);
  }
  const bytes = randomBytes(10);
  let rand = "";
  for (let i = 0; i < 16; i++) {
    rand += CROCKFORD[bytes[i % bytes.length]! % 32] ?? "0";
  }
  return timeChars + rand;
}

function computeChainHash(args: {
  prevHash: string | null;
  payload: Record<string, unknown>;
  occurredAt: Date;
  eventType: string;
  actor: { kind: string; id: string };
}): string {
  const stable = JSON.stringify({
    prevHash: args.prevHash,
    payload: args.payload,
    occurredAt: args.occurredAt.toISOString(),
    eventType: args.eventType,
    actor: args.actor,
  });
  return createHash("sha256").update(stable).digest("hex");
}

export type WriteOutcomeLedgerResult = {
  written: number;
  skippedDuplicate: number;
  eventIds: string[];
};

/**
 * Append outcome events. Idempotent on payload.recordHash within the
 * same entity_id (skips if an event with that recordHash already exists).
 */
export async function writeOutcomeLedger(
  sql: Sql,
  outcomes: NormalizedPermitOutcome[],
): Promise<WriteOutcomeLedgerResult> {
  const actor = { kind: "system" as const, id: "permit-outcome-adapter" };
  let written = 0;
  let skippedDuplicate = 0;
  const eventIds: string[] = [];

  for (const outcome of outcomes) {
    const entityType = "finding";
    const entityId = permitOutcomeEntityId(outcome);
    const payload = toFindingOutcomePayload(outcome);

    const existing = await sql`
      SELECT id
      FROM atom_events
      WHERE entity_type = ${entityType}
        AND entity_id = ${entityId}
        AND event_type = ${FINDING_OUTCOME_RECORDED_EVENT_TYPE}
        AND payload->>'recordHash' = ${outcome.recordHash}
      LIMIT 1
    `;
    if (existing.length > 0) {
      skippedDuplicate += 1;
      continue;
    }

    const tail = await sql`
      SELECT chain_hash
      FROM atom_events e1
      WHERE entity_type = ${entityType}
        AND entity_id = ${entityId}
        AND NOT EXISTS (
          SELECT 1 FROM atom_events e2
          WHERE e2.entity_type = e1.entity_type
            AND e2.entity_id = e1.entity_id
            AND e2.prev_hash = e1.chain_hash
        )
      LIMIT 1
    `;
    const prevHash =
      (tail[0]?.chain_hash as string | null | undefined) ?? null;
    const occurredAt = new Date(outcome.observedAt);
    const id = generateId();
    const chainHash = computeChainHash({
      prevHash,
      payload,
      occurredAt,
      eventType: FINDING_OUTCOME_RECORDED_EVENT_TYPE,
      actor,
    });

    // postgres.json expects JSONValue; payload is a plain JSON object.
    const actorJson = JSON.parse(JSON.stringify(actor)) as Parameters<
      typeof sql.json
    >[0];
    const payloadJson = JSON.parse(JSON.stringify(payload)) as Parameters<
      typeof sql.json
    >[0];

    await sql`
      INSERT INTO atom_events (
        id, entity_type, entity_id, event_type, actor, payload,
        prev_hash, chain_hash, occurred_at
      ) VALUES (
        ${id},
        ${entityType},
        ${entityId},
        ${FINDING_OUTCOME_RECORDED_EVENT_TYPE},
        ${sql.json(actorJson)},
        ${sql.json(payloadJson)},
        ${prevHash},
        ${chainHash},
        ${occurredAt.toISOString()}
      )
    `;
    written += 1;
    eventIds.push(id);
  }

  return { written, skippedDuplicate, eventIds };
}

export type UpsertOverlayArgs = {
  atomId: string;
  jurisdictionTenant: string;
  /** Distinct from Gate C hand-seed 0.71 when re-proving adapter path. */
  calibratedConfidence?: number;
  assertedConfidence?: number;
  signalCount: number;
  codeRef: string;
  edition?: string;
};

export async function upsertCalibrationOverlayBacktest(
  sql: Sql,
  args: UpsertOverlayArgs,
): Promise<Record<string, unknown>> {
  const calibrated = args.calibratedConfidence ?? 0.73;
  const asserted = args.assertedConfidence ?? 0.88;
  const edition = args.edition ?? "permit-outcome-adapter";
  const provenance = "backtest";

  await sql`
    INSERT INTO atom_calibration_overlay (
      atom_id,
      jurisdiction_tenant,
      partition_kind,
      access_policy,
      asserted_confidence,
      calibrated_confidence,
      code_ref,
      edition,
      source_set_version,
      calibration_stale,
      calibration_grain,
      atom_class,
      signal_count,
      updated_at
    ) VALUES (
      ${args.atomId},
      ${args.jurisdictionTenant},
      'public',
      'public-free',
      ${asserted},
      ${calibrated},
      ${args.codeRef},
      ${edition},
      1,
      false,
      'atom',
      ${provenance},
      ${args.signalCount},
      now()
    )
    ON CONFLICT (atom_id, jurisdiction_tenant) DO UPDATE SET
      asserted_confidence = EXCLUDED.asserted_confidence,
      calibrated_confidence = EXCLUDED.calibrated_confidence,
      code_ref = EXCLUDED.code_ref,
      edition = EXCLUDED.edition,
      calibration_stale = EXCLUDED.calibration_stale,
      atom_class = EXCLUDED.atom_class,
      signal_count = EXCLUDED.signal_count,
      updated_at = now()
  `;

  const rows = await sql`
    SELECT
      atom_id,
      jurisdiction_tenant,
      asserted_confidence,
      calibrated_confidence,
      atom_class,
      signal_count,
      code_ref,
      edition,
      calibration_stale
    FROM atom_calibration_overlay
    WHERE atom_id = ${args.atomId}
      AND jurisdiction_tenant = ${args.jurisdictionTenant}
  `;
  return (rows[0] as Record<string, unknown>) ?? {};
}
