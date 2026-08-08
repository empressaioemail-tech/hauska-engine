/**
 * Structural pins — depth-warm-bastrop-batch bulk acquisition (2026-08-08).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const batchPath = join(HERE, "../depth-warm-bastrop-batch.mjs");
const prefetchPath = join(HERE, "../bastrop-batch-bulk-prefetch.mjs");
const batchSource = readFileSync(batchPath, "utf8");
const prefetchSource = readFileSync(prefetchPath, "utf8");

describe("depth-warm-bastrop-batch bulk acquisition", () => {
  it("prefetch module exports bulk loaders for situs, BCAD, layer-23, geometry, idempotency, boundary edges", () => {
    expect(prefetchSource).toContain("export async function bulkLoadSitusByPropId");
    expect(prefetchSource).toContain("export async function bulkLoadBcadRingsByPropId");
    expect(prefetchSource).toContain("export async function bulkLoadLayer23FeatureIndex");
    expect(prefetchSource).toContain("export async function bulkLoadTxgioGeometryByPropId");
    expect(prefetchSource).toContain("export async function bulkLoadAlreadyPromotedSet");
    expect(prefetchSource).toContain("export async function bulkLoadBoundaryEdgesByParcel");
    expect(prefetchSource).toContain("export function buildLayer23DescriptorCache");
  });

  it("batch script bulk-loads before the compute loop and tracks liveHttpCallsInLoop", () => {
    expect(batchSource).toContain("bulkLoadSitusByPropId");
    expect(batchSource).toContain("bulkLoadBcadRingsByPropId");
    expect(batchSource).toContain("bulkLoadLayer23FeatureIndex");
    expect(batchSource).toContain("layer23DescriptorCache");
    expect(batchSource).toContain("liveHttpCallsInLoop");
    expect(batchSource).toContain("bulkLoadMs");
    expect(batchSource).toContain("loopMsTotal");
    expect(batchSource).toMatch(/const loopT0 = performance\.now\(\)/);
  });

  it("batch loop does not per-parcel situs SELECT, BCAD fetch, layer-23 build, idempotency SELECT, or geomResolver.resolve", () => {
    const loopStart = batchSource.indexOf("for (const row of parcelRows)");
    const loopBody = batchSource.slice(loopStart);
    expect(loopBody).not.toMatch(/await txSql`\s*\n\s*SELECT situs_address/);
    expect(loopBody).not.toMatch(/assertParcelCurrencyInBcad\(/);
    expect(loopBody).not.toMatch(/await buildBastropPerParcelSetbackDescriptor\(/);
    expect(loopBody).not.toMatch(/await geomResolver\.resolve\(/);
    expect(loopBody).not.toMatch(/await readBoundaryEdgesForParcel\(/);
    expect(loopBody).not.toMatch(/fetchBcadParcelRings\(/);
  });

  it("batch loop retains R30 relabelBoundaryEdgesFromRoadLabels on force-repromote / ringSwapped", () => {
    expect(batchSource).toContain("relabelBoundaryEdgesFromRoadLabels");
    expect(batchSource).toMatch(
      /args\.forceRepromote \|\| ringSwapped[\s\S]*relabelBoundaryEdgesFromRoadLabels/,
    );
  });

  it("BCAD divergence report uses bulk BCAD map, not live fetch in loop", () => {
    expect(batchSource).not.toMatch(
      /for \(const row of parcelRows\)[\s\S]*fetchBcadParcelRings\(/,
    );
    expect(batchSource).toMatch(/bcadByPropId\.get\(normalizePropId\(propId\)\)/);
  });
});
