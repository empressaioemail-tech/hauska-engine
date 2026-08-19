/**
 * The offline fixture gate — the CI-runnable half of the SS-W17 standing check.
 *
 * Every ring, sample point and PostGIS verdict in the fixture is REAL, dumped
 * read-only from production. This grades the SHIPPING JS predicate against the
 * PostGIS verdicts recorded beside each case, which makes the job a genuine
 * cross-implementation divergence test rather than one implementation replaying
 * against itself.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { gradeFloodAdjudication } from "../grade.js";
import { CODE_LEGS, type FloodAdjudicationCase } from "../types.js";

const FIXTURE_PATH = fileURLToPath(
  new URL("../__fixtures__/flood-containment-48021.json", import.meta.url),
);

interface Fixture {
  dumpedFrom: string;
  nfhlEdition: string | null;
  expectedContainment: { notContained: number; contained: number };
  cases: FloodAdjudicationCase[];
}

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Fixture;

describe("flood containment offline fixture", () => {
  it("carries real production provenance rather than a synthetic shape", () => {
    expect(fixture.dumpedFrom).toContain("txgio_parcel");
    expect(fixture.nfhlEdition).toBe("NFHL_48_20260101");
  });

  it("STILL CONTAINS VIOLATIONS, so a regenerated fixture cannot go green by being clean", () => {
    // A fixture of well-behaved squares would pass every band while the check
    // itself was broken. This pins the violation count the fixture was built to
    // carry, so a regeneration that loses them fails here rather than silently
    // weakening the gate.
    expect(fixture.expectedContainment.notContained).toBeGreaterThan(100);
    const r = gradeFloodAdjudication(fixture.cases, CODE_LEGS);
    expect(r.containmentStates.notContained).toBe(
      fixture.expectedContainment.notContained,
    );
    expect(r.containmentStates.contained).toBe(
      fixture.expectedContainment.contained,
    );
  });

  it("PASSES: the JS predicate and the recorded PostGIS verdicts agree on every case", () => {
    const r = gradeFloodAdjudication(fixture.cases, CODE_LEGS);
    expect(r.breaches).toEqual([]);
    expect(r.pass).toBe(true);
    expect(r.legs.containmentDivergence.checked).toBe(fixture.cases.length);
    expect(r.legs.containmentDivergence.failed).toBe(0);
  });

  it("the atom's zone matches NFHL at the re-derived point on every case", () => {
    const r = gradeFloodAdjudication(fixture.cases, CODE_LEGS);
    expect(r.zoneAdjudicationOnStandInPoint.checked).toBe(fixture.cases.length);
    expect(r.zoneAdjudicationOnStandInPoint.failed).toBe(0);
  });

  it("FIRES when a single PostGIS verdict is flipped, proving the gate can fail", () => {
    // 2.2: a gating indicator is tested for its ability to fire before it is
    // trusted. Without this, a fixture gate that had silently stopped comparing
    // anything would look identical to a passing one.
    const tampered = fixture.cases.map((c, i) =>
      i === 0 ? { ...c, postgisContains: !c.postgisContains } : c,
    );
    const r = gradeFloodAdjudication(tampered, CODE_LEGS);
    expect(r.pass).toBe(false);
    expect(r.legs.containmentDivergence.failed).toBe(1);
    expect(r.breaches[0]).toMatch(/containment implementation divergences 1 of/);
  });

  it("FIRES when a ring is removed from a case that PostGIS still answers for", () => {
    const tampered = fixture.cases.map((c, i) =>
      i === 0 ? { ...c, parcelGeometry: null } : c,
    );
    const r = gradeFloodAdjudication(tampered, CODE_LEGS);
    expect(r.pass).toBe(false);
    expect(r.findings[0]!.detail).toMatch(/no testable ring/);
  });

  it("FIRES when an atom's claimed zone is changed away from the authority's answer", () => {
    const idx = fixture.cases.findIndex(
      (c) => c.atomFloodZone != null && c.nfhlZoneAtSamplePoint != null,
    );
    expect(idx).toBeGreaterThanOrEqual(0);
    const tampered = fixture.cases.map((c, i) =>
      i === idx ? { ...c, atomFloodZone: "ZZ-NOT-A-ZONE" } : c,
    );
    const r = gradeFloodAdjudication(tampered, CODE_LEGS);
    // Routed to the stand-in bucket because these atoms carry no stamped point,
    // so it is REPORTED rather than banded — and it must still be visible.
    expect(r.zoneAdjudicationOnStandInPoint.failed).toBe(1);
    expect(
      r.findings.some((f) => f.detail.includes("ZZ-NOT-A-ZONE")),
    ).toBe(true);
  });
});
