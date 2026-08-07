/**
 * OFFLINE block13 regression gate (2026-08-07, master planner directive —
 * "CRITICAL PROCESS ADDITION": the 48021:34121/34161 R32 fossil-cohort
 * regression on PR #270 was only ever caught by a live, manually-dispatched
 * block13-cert-grade.mjs run — this test closes that gap by running the
 * SAME grading primitive (gradeAgainstKeyResolved, cert-grade-core.ts) in
 * CI, every run, against a frozen snapshot of the 7 BLOCK13_ROSTER
 * parcels' live-resolved inputs (ring, insetRing, boundaryEdges,
 * zoningFact, setbackRule, situsAddress, proximate roads).
 *
 * Fixture: src/registry/__fixtures__/block13-offline.json, captured by
 * scripts/dump-block13-offline-fixture.mjs (READ-ONLY live dump; re-run and
 * commit a fresh snapshot whenever block13's underlying atoms change).
 *
 * This test calls gradeAgainstKeyResolved directly — the exact pure
 * grading body gradeBlock13Parcel calls after its DB fetches — so it is
 * NOT a re-derived copy of the grading logic (the class of drift that
 * caused the 34121/34161 regression in the first place: cert-grade-core.ts
 * had its own inline per-edge comparison loop that silently diverged from
 * verifyR32PerEdgeInset). A change to gradeAgainstKeyResolved is exercised
 * here exactly as it will run live.
 */
import { describe, expect, it } from "vitest";

import {
  ANSWER_KEY_BLOCK13,
  BLOCK13_ROSTER,
  gradeAgainstKeyResolved,
} from "../cert-grade-core.js";
import bastropDescriptor from "../../property-reasoning/fixtures/descriptors/bastrop_tx_descriptor.json" with { type: "json" };
import fixture from "../__fixtures__/block13-offline.json" with { type: "json" };

const descriptor = {
  ...bastropDescriptor,
  sourceAdapter: "bastrop-per-parcel-record-layer-23",
};

interface FixtureParcel {
  situsAddress: string | null;
  ring: Array<[number, number]>;
  insetRing: Array<[number, number]>;
  zoningFact: { district?: string } | null;
  setbackRule: Record<string, unknown> | null;
  boundaryEdges: Array<Record<string, unknown>> | null;
}

interface Block13OfflineFixture {
  fixtureVersion: number;
  generatedAt: string;
  parcels: Record<string, FixtureParcel>;
  roads: unknown[];
}

const typedFixture = fixture as unknown as Block13OfflineFixture;

describe("block13 OFFLINE regression gate (frozen fixture, no DB/network)", () => {
  it("fixture covers exactly the 7 frozen BLOCK13_ROSTER parcels", () => {
    expect(Object.keys(typedFixture.parcels).sort()).toEqual([...BLOCK13_ROSTER].sort());
  });

  for (const parcelNodeId of BLOCK13_ROSTER) {
    it(`${parcelNodeId}: gradeAgainstKeyResolved (offline) — must match live 7/7`, () => {
      const fx = typedFixture.parcels[parcelNodeId];
      expect(fx, `no fixture entry for ${parcelNodeId}`).toBeDefined();
      const key = ANSWER_KEY_BLOCK13[parcelNodeId];
      expect(key, `no answer key for ${parcelNodeId}`).toBeDefined();

      const result = gradeAgainstKeyResolved(
        parcelNodeId,
        key!,
        fx!.situsAddress,
        fx!.ring as never,
        {
          zoningFact: fx!.zoningFact,
          setbackRule: fx!.setbackRule as never,
          insetRing: fx!.insetRing,
          boundaryEdges: fx!.boundaryEdges as never,
          roads: typedFixture.roads,
          descriptor,
        },
        true,
      );

      expect(
        result.pass,
        `${parcelNodeId} offline grade failed — gates: ${JSON.stringify(result.gates, null, 2)}\nedges: ${JSON.stringify(result.edges, null, 2)}`,
      ).toBe(true);
    });
  }
});
