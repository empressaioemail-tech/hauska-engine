#!/usr/bin/env node
/**
 * write-property-atom-proof.mjs — Gate C Central-TX property atom bake.
 *
 * Writes Hays gold chain + Bexar honest-absence (+ optional Caldwell) via
 * PgStorage.writePropertyAtom. Retire-not-overwrite: if an active row exists
 * at the canonical DID, copy it to a /vN history DID as retired, then upsert
 * the new active body at the canonical DID.
 *
 *   PROPERTY_ATOM_PATH=1 \
 *   DATABASE_URL='postgres://...neon.tech/hauska_mcp?sslmode=require' \
 *     pnpm exec tsx packages/storage/scripts/write-property-atom-proof.mjs
 */

import { buildAtomDid } from "@hauska-engine/atoms";
import {
  BEXAR_ABSENCE_PARCEL,
  BEXAR_ZONING_DID,
  CALDWELL_ROADS_PARCEL,
  CALDWELL_ZONING_DID,
  HAYS_ENVELOPE_DID,
  HAYS_GOLD_PARCEL,
  HAYS_SETBACK_DID,
  HAYS_ZONING_DID,
  buildBexarAbsenceZoningProof,
  buildCaldwellZoningProof,
  buildHaysEnvelopeProof,
  buildHaysSetbackRuleProof,
  buildHaysZoningFactProof,
  createPgStorage,
  resolveSubstrateDatabaseUrl,
} from "@hauska-engine/storage";

if (process.env.PROPERTY_ATOM_PATH !== "1") {
  console.error(
    "FATAL: PROPERTY_ATOM_PATH=1 required to write property atom proofs.",
  );
  process.exit(1);
}

const url = resolveSubstrateDatabaseUrl();
if (!url) {
  console.error(
    "FATAL: neither DATABASE_URL nor SUBSTRATE_DATABASE_URL is set.",
  );
  process.exit(1);
}

const handle = createPgStorage({ databaseUrl: url, maxConnections: 1 });

async function retireThenWrite(instance) {
  const canonicalDid =
    instance.atomDid ??
    buildAtomDid(instance.entityType, instance.entityId).raw;
  const existing = await handle.storage.getAtomByDid(canonicalDid);
  if (
    existing &&
    existing.entityType === instance.entityType &&
    existing.status === "active" &&
    existing.contentHash !== instance.contentHash
  ) {
    const versionMatch = /\/v(\d+)$/.exec(existing.entityId);
    const priorVersion = versionMatch ? Number(versionMatch[1]) : 1;
    const historyEntityId = `${instance.parcelNodeId}/v${priorVersion}`;
    const historyDid = buildAtomDid(existing.entityType, historyEntityId).raw;
    const retired = {
      ...existing,
      atomDid: historyDid,
      entityId: historyEntityId,
      status: "retired",
      retiredAt: new Date().toISOString(),
    };
    await handle.storage.writePropertyAtom(retired);
  }
  return handle.storage.writePropertyAtom(instance);
}

try {
  const proofs = [
    buildHaysZoningFactProof(),
    buildHaysSetbackRuleProof(),
    buildHaysEnvelopeProof(),
    buildBexarAbsenceZoningProof(),
    buildCaldwellZoningProof(),
  ];

  const written = [];
  for (const proof of proofs) {
    const { atomDid, cid } = await retireThenWrite(proof);
    const roundTrip = await handle.storage.getAtomByDid(atomDid);
    written.push({
      atomDid,
      cid,
      entityType: proof.entityType,
      parcelNodeId: proof.parcelNodeId,
      roundTripOk: roundTrip?.entityType === proof.entityType,
      absence: proof.absence ?? null,
      district: proof.district ?? null,
    });
  }

  const haysChain = await handle.storage.listPropertyAtomsByParcelNodeId(
    HAYS_GOLD_PARCEL,
  );
  const bexarChain = await handle.storage.listPropertyAtomsByParcelNodeId(
    BEXAR_ABSENCE_PARCEL,
  );

  console.log(
    JSON.stringify(
      {
        event: "property-atom-proof.written",
        dids: {
          haysZoning: HAYS_ZONING_DID,
          haysSetback: HAYS_SETBACK_DID,
          haysEnvelope: HAYS_ENVELOPE_DID,
          bexarZoningAbsence: BEXAR_ZONING_DID,
          caldwellZoning: CALDWELL_ZONING_DID,
        },
        parcels: {
          haysGold: HAYS_GOLD_PARCEL,
          bexarAbsence: BEXAR_ABSENCE_PARCEL,
          caldwellRoads: CALDWELL_ROADS_PARCEL,
        },
        written,
        chainCounts: {
          hays: haysChain.length,
          bexar: bexarChain.length,
        },
        curlExamples: {
          haysChain:
            "GET /property-nodes/48209:156346/atom-chain",
          bexarChain:
            "GET /property-nodes/48029:410119/atom-chain",
          haysZoningAtom: `GET /atoms/${HAYS_ZONING_DID}`,
          bexarZoningAtom: `GET /atoms/${BEXAR_ZONING_DID}`,
        },
      },
      null,
      2,
    ),
  );

  if (haysChain.length < 3) {
    throw new Error(`expected 3 Hays chain atoms, got ${haysChain.length}`);
  }
  const bexarZoning = bexarChain.find((a) => a.entityType === "zoning-fact");
  if (!bexarZoning?.absence || bexarZoning.absence.kind !== "no-zoning-stamp") {
    throw new Error("Bexar zoning proof missing absence.kind=no-zoning-stamp");
  }
  if (bexarZoning.district) {
    throw new Error("Bexar zoning proof must not stamp a district");
  }

  await handle.close();
  process.exit(0);
} catch (err) {
  console.error("Write FAILED:", err instanceof Error ? err.message : err);
  await handle.close().catch(() => {});
  process.exit(1);
}
