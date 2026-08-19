/**
 * LIVE-WIRE PARITY — the control that makes this sweep's numbers mean anything.
 *
 * The sweep does not call the deployed endpoint 10 million times. It reads the
 * two stores in bulk and runs the serving transforms itself. That is only
 * legitimate if the offline composition produces the SAME wire body the
 * deployed surface produces, so this test asserts exactly that against captured
 * live responses.
 *
 * THIS IS NOT A GOLDEN-PARCEL REGRESSION SET, and the distinction is the whole
 * reason the operator refused one. A golden set would certify a COUNTY from a
 * handful of parcels — that is what narrowed scope on Bastrop and certified a
 * broken county. This certifies the INSTRUMENT, and the instrument then visits
 * every parcel without exception. Adding a parcel here widens the instrument's
 * proof; it never narrows the sweep's scope, because the sweep has no scope
 * knob to narrow.
 *
 * The fixtures are verbatim captures from
 * `https://property-explorer-xi.vercel.app/api/spine/property-atoms/:id/facets`
 * taken 2026-08-18, alongside the exact store rows the sweep would have read
 * for the same parcels at the same time. Re-capture with
 * `scripts/capture-live-parity-fixtures.mjs`.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assembleChain, dedupeParcelAtoms } from "../chain-assembly.js";
import { composeServedResponse } from "../bff-flow.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureFile = path.join(here, "__fixtures__", "live-parity.json");

interface ParityFixture {
  capturedAt: string;
  endpoint: string;
  cases: Array<{
    parcelNodeId: string;
    /** Response header the deployed surface returned. */
    liveReadPath: string;
    /** Verbatim live response body. */
    live: Record<string, unknown>;
    /** The store rows the sweep reads, captured at the same moment. */
    store: {
      atoms: Array<Record<string, unknown>>;
      tier1: Record<string, unknown> | null;
      tier1SnapshotAt: string | null;
      tier2: Record<string, unknown> | null;
      tier2SnapshotAt: string | null;
    };
  }>;
}

/**
 * Fields the comparison ignores, each for a stated reason. An unexplained
 * ignore is how a parity test stops being a control.
 *
 *  - `snapshotAt` / `bakedAt`: timestamps that move with a re-bake between the
 *    live capture and the store capture. The sweep never reports on them.
 *  - `geojson`: the sweep substitutes a feature-count stand-in by design
 *    (see `reattachGeojsonStandIn`); `geojson-standin.test.ts` proves the
 *    substitution changes no served decision, and this test asserts the
 *    feature COUNT matches rather than the coordinates.
 */
const IGNORED_LEAVES = new Set(["snapshotAt", "bakedAt", "geojson"]);

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      if (IGNORED_LEAVES.has(key)) continue;
      out[key] = normalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function featureCount(v: unknown): number | null {
  if (!v || typeof v !== "object") return null;
  const f = (v as { features?: unknown }).features;
  return Array.isArray(f) ? f.length : 1;
}

const fixture: ParityFixture | null = fs.existsSync(fixtureFile)
  ? (JSON.parse(fs.readFileSync(fixtureFile, "utf8")) as ParityFixture)
  : null;

describe("live-wire parity", () => {
  it("has a fixture; without one the sweep's numbers are unvalidated", () => {
    // Deliberately a HARD failure, not a skip. A parity control that silently
    // no-ops when its fixture is missing is the fail-open shape DEV_PROCESS 2.2
    // exists to stop.
    expect(fixture, `missing ${fixtureFile}`).not.toBeNull();
    expect(fixture!.cases.length).toBeGreaterThanOrEqual(8);
  });

  for (const c of fixture?.cases ?? []) {
    it(`reproduces the live wire body for ${c.parcelNodeId}`, () => {
      const deduped = dedupeParcelAtoms(c.parcelNodeId, c.store.atoms as never);
      const chain = assembleChain(c.parcelNodeId, deduped);
      const t1 = c.store.tier1;
      const cortex = t1
        ? {
            parcelNodeId: c.parcelNodeId,
            adapterKey: "node-facets:tier1",
            source: "baked-snapshot" as const,
            snapshotAt: c.store.tier1SnapshotAt,
            facets: {
              ...t1,
              envelope: null,
              facetCoverage: {
                ...((t1.facetCoverage as Record<string, unknown>) ?? {}),
                envelope: false,
              },
            },
            tier2:
              c.store.tier2 && typeof c.store.tier2.flood === "object"
                ? {
                    flood: c.store.tier2.flood,
                    envelope: null,
                    bakedAt: c.store.tier2.bakedAt ?? null,
                    snapshotAt: c.store.tier2SnapshotAt,
                  }
                : null,
          }
        : null;

      const served = composeServedResponse({
        parcelNodeId: c.parcelNodeId,
        chain: chain as never,
        cortex: cortex as never,
        propertyAtomPath: true,
      });

      expect(served.readPath).toBe(c.liveReadPath);
      expect(normalize(served.body)).toEqual(normalize(c.live));

      const liveEnv = (c.live.facets as Record<string, unknown> | undefined)
        ?.envelope as Record<string, unknown> | undefined;
      const sweptEnv = (served.body.facets as Record<string, unknown> | undefined)
        ?.envelope as Record<string, unknown> | undefined;
      expect(featureCount(sweptEnv?.geojson)).toBe(featureCount(liveEnv?.geojson));
    });
  }

  it("the live surface drops tier2 on the atom-chain path", () => {
    // The single most consequential finding of this lane, asserted against the
    // captured live bodies rather than argued from code reading. If a future
    // deploy starts carrying tier2 on the atom path, this test fails and the
    // flood tallies must be re-read.
    const atomPathCases = (fixture?.cases ?? []).filter((c) =>
      c.liveReadPath.startsWith("atom-chain"),
    );
    expect(atomPathCases.length).toBeGreaterThan(0);
    for (const c of atomPathCases) {
      expect(
        Object.prototype.hasOwnProperty.call(c.live, "tier2"),
        `${c.parcelNodeId} live body unexpectedly carries tier2`,
      ).toBe(false);
    }
  });
});
