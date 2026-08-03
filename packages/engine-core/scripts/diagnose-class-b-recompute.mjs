#!/usr/bin/env node
/** Class B diagnosis — trace warm vs cert recompute divergence for 28855/30857. */
import postgres from "postgres";
import { createPgStorage, resolveSubstrateDatabaseUrl } from "@hauska-engine/storage";
import bastropDescriptor from "../src/property-reasoning/fixtures/descriptors/bastrop_tx_descriptor.json" with { type: "json" };
import {
  fetchBcadParcelRings,
  scrubLotLineRing,
} from "../src/boundary-primitive/index.ts";
import { readBoundaryEdgesForParcel } from "../src/boundary-primitive/read.ts";
import {
  primitiveNormalsAgreeWithRing,
  recomputeBoundaryEdgesForRing,
} from "../src/boundary-primitive/recompute-for-ring.ts";
import { computeWarmCandidateFromBoundary } from "../src/boundary-primitive/consume.ts";
import { relabelBoundaryEdgesFromRoadLabels } from "../src/boundary-primitive/relabel-from-roads.ts";
import { roadAtomToWarmSource } from "../src/road-intake/road-to-warm-source.ts";
import { labelEdgesFromRoads } from "../src/depth-warm/edgeLabeling.ts";
import { openRing } from "../src/depth-warm/geometry.ts";
import { TxgioDatabaseParcelGeometryResolver } from "../src/parcel-terrain/parcel-geometry-resolver.ts";

const COUNTY = "48021";
const PARCELS = process.argv.slice(2).length ? process.argv.slice(2) : ["48021:28855", "48021:30857"];

const url = resolveSubstrateDatabaseUrl();
const txUrl = process.env.CORTEX_DATABASE_URL?.trim() || process.env.TXGIO_DATABASE_URL?.trim() || url;
const sql = postgres(url, { ssl: "require", max: 4, prepare: false });
const txSql = postgres(txUrl, { ssl: "require", max: 2, prepare: false });
const storage = createPgStorage({ databaseUrl: url, maxConnections: 2 });
const geomResolver = new TxgioDatabaseParcelGeometryResolver({ databaseUrl: txUrl });
const descriptor = { ...bastropDescriptor, sourceAdapter: "bastrop-per-parcel-record-layer-23" };

const roads = (
  await sql`SELECT body FROM atoms WHERE entity_type='road-node' AND body->>'countyFips'=${COUNTY} AND coalesce(body->>'status','active')='active'`
).map((r) => roadAtomToWarmSource(r.body)).filter(Boolean);

const report = { when: new Date().toISOString(), parcels: {} };

for (const parcelNodeId of PARCELS) {
  const propId = parcelNodeId.split(":")[1];
  const out = { parcelNodeId };

  const [situsRow] = await txSql`
    SELECT situs_address FROM txgio_parcel WHERE county_fips=${COUNTY} AND prop_id=${propId} LIMIT 1
  `;
  out.situs = situsRow?.situs_address ?? null;

  const txGeom = await geomResolver.resolve(parcelNodeId);
  out.txgioRingVerts = txGeom?.ring ? openRing(txGeom.ring).length : null;

  const bcad = await fetchBcadParcelRings([propId]);
  const bcadRing = scrubLotLineRing(bcad[0]?.ring);
  out.bcadRingVerts = bcadRing ? openRing(bcadRing).length : null;

  let stored = await readBoundaryEdgesForParcel(storage.storage, parcelNodeId).catch(() => null);
  out.storedPrimitiveEdgeCount = stored?.length ?? 0;

  if (!bcadRing) {
    out.error = "no-bcad-ring";
    report.parcels[parcelNodeId] = out;
    continue;
  }

  const labelResult = labelEdgesFromRoads({ parcelRing: bcadRing, roads, situsAddress: out.situs });

  let certEdges = stored ? [...stored] : null;
  if (certEdges?.length && bcadRing) {
    const rv = openRing(bcadRing).length;
    if (certEdges.length > rv) certEdges = certEdges.filter((e) => e.edgeIndex < rv);
    else if (certEdges.length < rv) certEdges = null;
  }
  if (certEdges?.length && labelResult.ok) {
    certEdges = relabelBoundaryEdgesFromRoadLabels({
      storedEdges: certEdges,
      edgeLabels: labelResult.edgeLabels,
      roads,
      countyFips: COUNTY,
    });
  }
  const certCandidate = certEdges?.length
    ? computeWarmCandidateFromBoundary({
        parcelNodeId,
        district: "SF-1",
        parcelRing: bcadRing,
        boundaryEdges: certEdges,
        roads,
        descriptor,
      })
    : null;
  out.certPathNoR28 = {
    empty: certCandidate?.empty ?? true,
    emptyReason: certCandidate?.emptyReason ?? "no-candidate",
    buildableAreaSqFt: certCandidate?.buildableAreaSqFt ?? null,
  };

  let warmEdges = stored ? [...stored] : null;
  const ring = bcadRing;
  const ringVerts = openRing(ring).length;
  if (warmEdges?.length && warmEdges.length > ringVerts) {
    warmEdges = warmEdges.filter((e) => e.edgeIndex < ringVerts);
  } else if (warmEdges?.length && warmEdges.length < ringVerts) {
    warmEdges = null;
  }
  const agreeBefore = warmEdges?.length
    ? primitiveNormalsAgreeWithRing(warmEdges, ring)
    : null;
  out.r28 = { agreeBefore: agreeBefore?.ok ?? null, perEdgeDot: agreeBefore?.perEdgeDot ?? [] };

  if (warmEdges?.length && warmEdges.length === ringVerts && agreeBefore && !agreeBefore.ok) {
    const rebuilt = recomputeBoundaryEdgesForRing({ storedEdges: warmEdges, ring, roads });
    const agreeAfter = primitiveNormalsAgreeWithRing(rebuilt, ring);
    out.r28.rebuiltOk = agreeAfter.ok;
    if (agreeAfter.ok) warmEdges = rebuilt;
    else warmEdges = null;
  }

  if (warmEdges?.length && labelResult.ok) {
    warmEdges = relabelBoundaryEdgesFromRoadLabels({
      storedEdges: warmEdges,
      edgeLabels: labelResult.edgeLabels,
      roads,
      countyFips: COUNTY,
    });
  }

  const warmCandidate = warmEdges?.length
    ? computeWarmCandidateFromBoundary({
        parcelNodeId,
        district: "SF-1",
        parcelRing: ring,
        boundaryEdges: warmEdges,
        roads,
        descriptor,
      })
    : null;
  out.warmPathWithR28 = {
    empty: warmCandidate?.empty ?? true,
    emptyReason: warmCandidate?.emptyReason ?? "no-candidate",
    buildableAreaSqFt: warmCandidate?.buildableAreaSqFt ?? null,
  };

  out.rootCause =
    out.certPathNoR28.empty && !out.warmPathWithR28.empty && agreeBefore && !agreeBefore.ok
      ? "R28: stored primitive normals disagree with BCAD ring; cert skipped recompute, warm applied recomputeBoundaryEdgesForRing"
      : out.certPathNoR28.empty && !out.warmPathWithR28.empty
        ? "recompute divergence (investigate further)"
        : "both paths same";

  report.parcels[parcelNodeId] = out;
}

console.log(JSON.stringify(report, null, 2));
await sql.end();
await txSql.end();
await storage.close();
