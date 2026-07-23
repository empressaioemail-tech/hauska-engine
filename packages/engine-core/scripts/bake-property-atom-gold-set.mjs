#!/usr/bin/env node
/**
 * bake-property-atom-gold-set.mjs — Master WDLL 3.12 named gold-set atom bake.
 *
 * Reads cortex Neon place_layer_snapshots (CORTEX_DATABASE_URL) as INPUTS only.
 * Emits zoning-fact / setback-rule / buildable-envelope via engine emitters
 * (confidence composed via contract — never labeling×district multiply).
 * Writes via StoragePort to hauska_mcp (DATABASE_URL / SUBSTRATE_DATABASE_URL).
 * Retire-not-overwrite on rewrite. Records coverage ledger + approx compute cost.
 *
 *   PROPERTY_ATOM_PATH=1 \
 *   DATABASE_URL=...hauska_mcp... \
 *   CORTEX_DATABASE_URL=...neondb... \
 *     pnpm --filter @hauska-engine/engine-core run bake-property-atom-gold-set
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

import postgres from "postgres";
import { createWidthedConfidence } from "@empressaio/atom-contract/read-contract";
import { buildAtomDid } from "@hauska-engine/atoms";
import {
  STORAGE_PORT_PROOF_ATOM_DID,
  buildBexarAbsenceZoningProof,
  buildCaldwellZoningProof,
  buildHaysEnvelopeProof,
  buildHaysSetbackRuleProof,
  buildHaysZoningFactProof,
  createPgStorage,
  resolveSubstrateDatabaseUrl,
} from "@hauska-engine/storage";

import {
  emitBuildableEnvelope,
  emitSetbackRule,
  emitZoningFact,
} from "../src/property-reasoning/index.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLD_SET_PATH = join(
  HERE,
  "../src/property-reasoning/fixtures/central-tx-gold-set.json",
);
const LEDGER_PATH = join(
  HERE,
  "../src/property-reasoning/fixtures/central-tx-gold-coverage-ledger.json",
);

if (process.env.PROPERTY_ATOM_PATH !== "1") {
  console.error("FATAL: PROPERTY_ATOM_PATH=1 required.");
  process.exit(1);
}

const substrateUrl = resolveSubstrateDatabaseUrl();
const cortexUrl = process.env.CORTEX_DATABASE_URL?.trim();
if (!substrateUrl) {
  console.error("FATAL: DATABASE_URL or SUBSTRATE_DATABASE_URL required.");
  process.exit(1);
}
if (!cortexUrl) {
  console.error("FATAL: CORTEX_DATABASE_URL required (snapshot inputs).");
  process.exit(1);
}

const goldSet = JSON.parse(readFileSync(GOLD_SET_PATH, "utf8"));
const handle = createPgStorage({ databaseUrl: substrateUrl, maxConnections: 1 });
const cortexSql = postgres(cortexUrl, { max: 1, ssl: "require", prepare: false });

const t0 = performance.now();
let computeUnits = 0;

async function retireThenWrite(instance) {
  computeUnits += 1;
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

function descriptorFor(parcelNodeId, cityHint) {
  const fips = parcelNodeId.split(":")[0];
  const city = (cityHint || "unknown").toLowerCase().replace(/\s+/g, "_");
  return {
    key: `gold_bake_${fips}`,
    displayName: `Gold bake ${fips}`,
    jurisdictionTenant: `gold_bake_${fips}_${city}`,
    parcelFips: fips,
    defaultAccessPolicy: "public-free",
    sourceAdapter: "cortex-tier1-snapshot-gold-bake",
    sourceUrl: "https://hauska.dev/internal/gold-atom-bake/cortex-snapshot",
  };
}

function asserted(estimate, width = 0.15) {
  return createWidthedConfidence({
    estimate,
    n: 0,
    intervalWidth: width,
    provenance: "asserted",
  });
}

async function loadTier1Snapshot(parcelNodeId) {
  computeUnits += 1;
  const rows = await cortexSql`
    select payload_json
    from place_layer_snapshots
    where place_key = ${"node:" + parcelNodeId}
      and adapter_key = 'node-facets:tier1'
    limit 1`;
  return rows[0]?.payload_json ?? null;
}

function emitFromSnapshot(parcelNodeId, snap) {
  const extractedAt = snap.bakedAt || new Date().toISOString();
  const city = snap.baseFacts?.situsCity ?? null;
  const descriptor = descriptorFor(parcelNodeId, city);
  const zoningDistrict =
    typeof snap.zoning?.district === "string" && snap.zoning.district.trim()
      ? snap.zoning.district.trim()
      : null;
  const env = snap.envelope && typeof snap.envelope === "object" ? snap.envelope : null;
  const out = { atoms: [], notes: [] };

  if (!zoningDistrict) {
    const z = emitZoningFact(descriptor, {
      parcelNodeId,
      districtCode: null,
      matchBasis: "exact",
      sourceCitation: `Gold bake honest-absence from cortex tier1 snapshot (${parcelNodeId})`,
      extractedAt,
    });
    out.atoms.push(z);
    out.notes.push("zoning-absence");
    return out;
  }

  const z = emitZoningFact(descriptor, {
    parcelNodeId,
    districtCode: zoningDistrict,
    matchBasis: "exact",
    sourceCitation: `Gold bake zoning from cortex tier1 snapshot (${parcelNodeId})`,
    extractedAt,
  });
  out.atoms.push(z);
  out.notes.push("zoning");

  const setbacks = env?.setbacks;
  const hasSetbacks =
    setbacks &&
    typeof setbacks.front_ft === "number" &&
    typeof setbacks.side_ft === "number" &&
    typeof setbacks.rear_ft === "number";

  if (!hasSetbacks) {
    out.notes.push("setback-omitted-no-snapshot-dims");
    return out;
  }

  const row = {
    atom_did: STORAGE_PORT_PROOF_ATOM_DID,
    match_basis: "exact",
    district_code: zoningDistrict,
    front_ft: {
      value: setbacks.front_ft,
      confidence: 0.85,
      verification_state: "transcribed",
    },
    side_ft: {
      value: setbacks.side_ft,
      confidence: 0.85,
      verification_state: "transcribed",
    },
    rear_ft: {
      value: setbacks.rear_ft,
      confidence: 0.85,
      verification_state: "transcribed",
    },
    side_corner_ft: {
      value: setbacks.side_ft,
      confidence: 0.7,
      verification_state: "transcribed",
    },
  };

  const setback = emitSetbackRule(
    descriptor,
    zoningDistrict,
    row,
    parcelNodeId,
  );
  if (setback && setback.kind === "honest-absence") {
    out.notes.push(`setback-absence:${setback.code}`);
    return out;
  }
  out.atoms.push(setback);
  out.notes.push("setback");

  const status = env?.status;
  let outcome;
  if (status === "no-buildable-area") {
    outcome = { kind: "no-buildable-area", areaSqFt: 0 };
  } else if (status === "ok") {
    outcome = {
      kind: "buildable",
      areaSqFt:
        typeof env.buildableAreaSqFt === "number" ? env.buildableAreaSqFt : 0,
    };
  } else {
    out.notes.push(`envelope-omitted-status:${status || "null"}`);
    return out;
  }

  const envelope = emitBuildableEnvelope({
    descriptor,
    parcelNodeId,
    zoningFactAtomDid: z.atomDid,
    setbackRuleAtomDid: setback.atomDid,
    geometryRefId: `${parcelNodeId}/geometry`,
    frontEdgeRefId: `${parcelNodeId}/front-edge`,
    outcome,
    inputAssertedConfidences: [
      z.readContract.axes.assertedConfidence,
      setback.readContract.axes.assertedConfidence,
    ],
    sourceCitation:
      "Gold bake derived envelope from cortex snapshot geometry outcome — assertedConfidence composed via contract (not labeling×district)",
    extractedAt,
  });
  if (envelope && envelope.kind === "honest-absence") {
    out.notes.push(`envelope-absence:${envelope.code}`);
    return out;
  }
  // Geometry stays a reference-field on the chain; do not invent geojson here.
  out.atoms.push(envelope);
  out.notes.push("envelope");
  void asserted;
  return out;
}

async function bakeProofParcel(role) {
  if (role === "hays-proof-full-chain") {
    return [
      buildHaysZoningFactProof(),
      buildHaysSetbackRuleProof(),
      buildHaysEnvelopeProof(),
    ];
  }
  if (role === "bexar-honest-absence") {
    return [buildBexarAbsenceZoningProof()];
  }
  if (role === "caldwell-roads-zoning") {
    return [buildCaldwellZoningProof()];
  }
  return [];
}

const ledger = {
  id: goldSet.id,
  bakedAt: new Date().toISOString(),
  purpose: goldSet.purpose,
  parcels: [],
  totals: {
    parcels: 0,
    atomsWritten: 0,
    zoning: 0,
    setback: 0,
    envelope: 0,
    absence: 0,
  },
  compute: {
    units: 0,
    wallMs: 0,
    approxUsdNote:
      "Neon read/write units only; under $1 for named gold set (I-H). Full-county (~984k tier1 envelopes) deferred.",
  },
};

try {
  for (const entry of goldSet.parcels) {
    const { parcelNodeId, role, source, expect } = entry;
    const parcelLedger = {
      parcelNodeId,
      role,
      source,
      expect,
      written: [],
      notes: [],
      ok: false,
    };

    let atoms = [];
    if (source === "property-atom-proof") {
      atoms = await bakeProofParcel(role);
      parcelLedger.notes.push("proof-builder");
    } else {
      const snap = await loadTier1Snapshot(parcelNodeId);
      if (!snap) {
        parcelLedger.notes.push("snapshot-missing");
        ledger.parcels.push(parcelLedger);
        continue;
      }
      const emitted = emitFromSnapshot(parcelNodeId, snap);
      atoms = emitted.atoms;
      parcelLedger.notes.push(...emitted.notes);
    }

    for (const atom of atoms) {
      const { atomDid, cid } = await retireThenWrite(atom);
      parcelLedger.written.push({
        atomDid,
        cid,
        entityType: atom.entityType,
        district: atom.district ?? null,
        absence: atom.absence?.kind ?? null,
        outcome: atom.outcome?.kind ?? null,
      });
      ledger.totals.atomsWritten += 1;
      if (atom.entityType === "zoning-fact") {
        ledger.totals.zoning += 1;
        if (atom.absence) ledger.totals.absence += 1;
      }
      if (atom.entityType === "setback-rule") ledger.totals.setback += 1;
      if (atom.entityType === "buildable-envelope") ledger.totals.envelope += 1;
    }

    const chain = await handle.storage.listPropertyAtomsByParcelNodeId(
      parcelNodeId,
    );
    parcelLedger.chainCount = chain.length;
    parcelLedger.ok = chain.length > 0;
    ledger.totals.parcels += 1;
    ledger.parcels.push(parcelLedger);
  }

  ledger.compute.units = computeUnits;
  ledger.compute.wallMs = Math.round(performance.now() - t0);

  mkdirSync(dirname(LEDGER_PATH), { recursive: true });
  writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2) + "\n");

  console.log(JSON.stringify({ event: "gold-atom-bake.done", ledger }, null, 2));

  const failed = ledger.parcels.filter((p) => !p.ok);
  if (failed.length) {
    throw new Error(
      `gold bake failed for: ${failed.map((p) => p.parcelNodeId).join(", ")}`,
    );
  }

  await handle.close();
  await cortexSql.end({ timeout: 1 });
  process.exit(0);
} catch (err) {
  console.error("Bake FAILED:", err instanceof Error ? err.message : err);
  await handle.close().catch(() => {});
  await cortexSql.end({ timeout: 1 }).catch(() => {});
  process.exit(1);
}
