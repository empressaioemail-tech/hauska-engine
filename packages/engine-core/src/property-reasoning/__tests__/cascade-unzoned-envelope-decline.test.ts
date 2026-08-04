import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  buildCascadeEnvelopeDecline,
  UNZONED_NO_DISTRICT_BASIS_CODE,
  UNZONED_NO_DISTRICT_BASIS_REASON,
} from "../cascade-unzoned-envelope-decline.js";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("buildCascadeEnvelopeDecline (unzoned-county cascade, R27 shape reuse)", () => {
  it("emits ONLY a buildable-envelope honest-decline for an absence parcel — never a setback-rule", () => {
    const decline = buildCascadeEnvelopeDecline(
      {
        parcelNodeId: "48021:TEST-UNZONED-1",
        atomDid: "did:hauska:zoning-fact:48021:TEST-UNZONED-1",
        situsCity: null,
      },
      "48021",
      "2026-08-03T00:00:00.000Z",
    );

    expect(decline.entityType).toBe("buildable-envelope");
    expect(decline.parcelNodeId).toBe("48021:TEST-UNZONED-1");
    // R27 persisted-decline shape: engine-extension fields on the envelope
    // instance, the SAME fields cert-grade-core.ts's warm-decline
    // short-circuit and bastrop-dominant-district-roster.mjs already read.
    expect(decline.warmVerifyDeclineCode).toBe(UNZONED_NO_DISTRICT_BASIS_CODE);
    expect(decline.warmVerifyDecline).toBe(UNZONED_NO_DISTRICT_BASIS_REASON);
    expect(decline.recipeVersion).toBeTruthy();
    expect(decline.outcome).toMatchObject({ kind: "no-buildable-area" });
    // Cites the absence zoning-fact as its sole input — no setback-rule ref,
    // because none is minted (contract has no dimension-less setback shape).
    expect(decline.reasoningChain).toMatchObject({
      reasoningKind: "derived",
      inputAtomRefs: [
        {
          atomDid: "did:hauska:zoning-fact:48021:TEST-UNZONED-1",
          role: "fact",
          entityType: "zoning-fact",
        },
      ],
    });
    expect(decline.reasoningChain.inputAtomRefs).toHaveLength(1);
    expect(decline.contentHash).toBeTruthy();
  });

  it("is deterministic/idempotent for a given parcel+version (same atomDid on re-run)", () => {
    const a = buildCascadeEnvelopeDecline(
      { parcelNodeId: "48021:TEST-UNZONED-2", atomDid: "did:hauska:zoning-fact:48021:TEST-UNZONED-2" },
      "48021",
      "2026-08-03T00:00:00.000Z",
    );
    const b = buildCascadeEnvelopeDecline(
      { parcelNodeId: "48021:TEST-UNZONED-2", atomDid: "did:hauska:zoning-fact:48021:TEST-UNZONED-2" },
      "48021",
      "2026-08-03T00:00:00.000Z",
    );
    expect(a.atomDid).toBe(b.atomDid);
  });
});

describe("bake-property-atom-county.mjs --cascade-absence-only city-cohort exclusion (pinned)", () => {
  const scriptPath = join(HERE, "../../../scripts/bake-property-atom-county.mjs");
  const scriptSource = readFileSync(scriptPath, "utf8");

  it("selects candidate parcels with a district IS NULL predicate (never a district-bearing row)", () => {
    // Structural pin: the cascade query MUST filter on absence — a
    // district-bearing (city-cohort) zoning-fact must never be selected as a
    // cascade candidate. This greps the actual query text rather than
    // re-deriving DB behavior, so a future edit that drops the guard fails
    // this test even without a live database.
    const cascadeFnMatch = scriptSource.match(
      /async function runCascadeAbsenceOnly\(\)[\s\S]*$/,
    );
    expect(cascadeFnMatch).not.toBeNull();
    const cascadeFnSource = cascadeFnMatch![0];

    expect(cascadeFnSource).toContain("entity_type = 'zoning-fact'");
    // The per-row absence gate: only rows with district === null AND
    // absence_kind === 'no-zoning-stamp' are ever pushed into the cascade
    // (isAbsence check before atomBatch.push).
    expect(cascadeFnSource).toMatch(/row\.district === null/);
    expect(cascadeFnSource).toMatch(/absence_kind === "no-zoning-stamp"/);
    // Never touches setback-rule or re-mints zoning-fact in this mode.
    expect(cascadeFnSource).not.toMatch(/entity_type\s*=\s*'setback-rule'/);
    expect(cascadeFnSource).not.toContain("emitZoningFact");
    expect(cascadeFnSource).not.toContain("emitFromTier1Snapshot(");
  });

  it("--cascade-absence-only flag is parsed and gates cortex-snapshot connection", () => {
    expect(scriptSource).toContain('"--cascade-absence-only"');
    expect(scriptSource).toContain("cascadeAbsenceOnly");
    // In cascade mode, CORTEX_DATABASE_URL must not be required — the mode
    // reads/writes substrate only.
    expect(scriptSource).toMatch(
      /if \(!args\.cascadeAbsenceOnly && !cortexUrl\)/,
    );
  });
});
