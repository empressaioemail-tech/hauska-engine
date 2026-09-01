#!/usr/bin/env node
/**
 * PERMITS-FIELD step 2 — one Austin parcel end to end (public SODA only).
 *
 * Acquire → normalize → write companion cell → project serve field with provenance.
 * No store token; measures wall-clock acquisition cost on the public API.
 *
 * On Windows Node may need: NODE_OPTIONS=--use-system-ca (TLS root store).
 */

import {
  AUSTIN_SODA_PERMIT_SOURCE,
  AUSTIN_TX_JURISDICTION,
  applyPermitsToRecord,
  indexPermitsByPlaceKey,
  normalizeAustinSodaPermitRow,
  placeKeyFromTcadId,
  tcadIdToTravisPropId,
} from "../src/parcel-record/ingest-permits.js";
import {
  instantiateParcelRecord,
  projectPermitsServeField,
  texasCtxPermitSourcingWithAustin,
} from "../src/parcel-record/index.js";

const AUSTIN_SODA_BASE =
  "https://data.austintexas.gov/resource/3syk-w9eu.json";

function flag(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

async function fetchPermitsForTcad(tcadId, limit = 50) {
  const params = new URLSearchParams({
    $limit: String(limit),
    $where: `tcad_id='${tcadId.replace(/'/g, "''")}'`,
    $order: "issue_date DESC",
  });
  const url = `${AUSTIN_SODA_BASE}?${params.toString()}`;
  const t0 = performance.now();
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  const elapsedMs = performance.now() - t0;
  if (!res.ok) {
    throw new Error(`Austin SODA HTTP ${res.status} for tcad_id=${tcadId}`);
  }
  const body = await res.json();
  if (!Array.isArray(body)) {
    throw new Error("Austin SODA response was not a JSON array");
  }
  return { rows: body, elapsedMs, httpStatus: res.status, url };
}

async function main() {
  const tcadArg = flag("--tcad");
  const acquiredAt = new Date().toISOString();

  let tcadId = tcadArg;
  let discoveryMs = 0;
  if (!tcadId) {
    const found = await discoverTcadId();
    tcadId = found.tcadId;
    discoveryMs = found.discoveryMs;
  }
async function discoverTcadId() {
  const url = `${AUSTIN_SODA_BASE}?$limit=10&$where=tcad_id IS NOT NULL&$order=issue_date DESC`;
  const t0 = performance.now();
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  const discoveryMs = performance.now() - t0;
  if (!res.ok) throw new Error(`Austin SODA discovery HTTP ${res.status}`);
  const arr = await res.json();
  const tcadId = arr?.[0]?.tcad_id ?? null;
  if (!tcadId) throw new Error("could not discover a tcad_id from Austin SODA");
  return { tcadId: String(tcadId), discoveryMs };
}

  const { rows, elapsedMs, httpStatus, url } = await fetchPermitsForTcad(tcadId);
  const normalized = [];
  for (const row of rows) {
    const n = normalizeAustinSodaPermitRow(row);
    if (n) normalized.push({ tcadId, row: n });
  }

  const placeKey = placeKeyFromTcadId(tcadId);
  const propId = tcadIdToTravisPropId(tcadId);
  const record = instantiateParcelRecord({
    countyFips: "48453",
    propId,
    incorporated: true,
    permitsJurisdictionKey: AUSTIN_TX_JURISDICTION,
    permitSourcing: texasCtxPermitSourcingWithAustin(),
    nowIso: acquiredAt,
  });

  const byPlace = indexPermitsByPlaceKey(normalized);
  const permitRows = byPlace.get(placeKey) ?? [];
  applyPermitsToRecord(
    record,
    permitRows,
    AUSTIN_SODA_PERMIT_SOURCE,
    acquiredAt,
  );

  const served = projectPermitsServeField({
    jurisdictionKey: AUSTIN_TX_JURISDICTION,
    permitsCell: record.cells.permits,
    companionRows: permitRows,
  });

  const out = {
    ok: true,
    jurisdiction: AUSTIN_TX_JURISDICTION,
    jurisdictionChoice: {
      name: "City of Austin",
      source: "Austin Open Data SODA 3syk-w9eu",
      why:
        "Documented public JSON API (no key), Travis county overlap, tcad_id join " +
        "to cad roll, existing adapter in repo; Bastrop MyGov off limits per ruling.",
      url: AUSTIN_SODA_BASE,
    },
    acquisition: {
      tcadId,
      placeKey,
      httpStatus,
      queryUrl: url,
      rawRowCount: rows.length,
      normalizedRowCount: permitRows.length,
      discoveryMs: tcadArg ? null : Math.round(discoveryMs),
      fetchMs: Math.round(elapsedMs),
      totalMs: Math.round((tcadArg ? 0 : discoveryMs) + elapsedMs),
      acquiredAt,
    },
    parcel: {
      placeKey: record.placeKey,
      permitsCell: record.cells.permits,
    },
    served,
    blockers: [],
  };

  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => {
  console.error(
    JSON.stringify({
      ok: false,
      error: String(err.message ?? err),
      cause: err?.cause ? String(err.cause) : undefined,
    }),
  );
  process.exit(1);
});
