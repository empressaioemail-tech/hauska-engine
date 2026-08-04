import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  buildCascadeEnvelopeDecline,
  classifyCascadeCohort,
  jurisdictionTenantCitySegment,
  jurisdictionTenantHasCitySignal,
  NO_DISTRICT_ON_RECORD_CODE,
  NO_DISTRICT_ON_RECORD_REASON,
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

  it("mints the in-city no-district-on-record variant when situsCity carries a town name", () => {
    const decline = buildCascadeEnvelopeDecline(
      {
        parcelNodeId: "48021:TEST-INCITY-1",
        atomDid: "did:hauska:zoning-fact:48021:TEST-INCITY-1",
        situsCity: "Smithville",
      },
      "48021",
      "2026-08-04T00:00:00.000Z",
    );
    expect(decline.warmVerifyDeclineCode).toBe(NO_DISTRICT_ON_RECORD_CODE);
    expect(decline.warmVerifyDecline).toBe(NO_DISTRICT_ON_RECORD_REASON);
    expect(decline.jurisdictionTenant).toBe("breadth_48021_smithville");
  });

  it("mints the unincorporated unzoned-no-district-basis variant when situsCity is null (no signal)", () => {
    const decline = buildCascadeEnvelopeDecline(
      {
        parcelNodeId: "48021:TEST-UNINC-1",
        atomDid: "did:hauska:zoning-fact:48021:TEST-UNINC-1",
        situsCity: null,
      },
      "48021",
      "2026-08-04T00:00:00.000Z",
    );
    expect(decline.warmVerifyDeclineCode).toBe(UNZONED_NO_DISTRICT_BASIS_CODE);
    expect(decline.warmVerifyDecline).toBe(UNZONED_NO_DISTRICT_BASIS_REASON);
    expect(decline.jurisdictionTenant).toBe("breadth_48021_unknown");
  });

  it("mints the unincorporated variant when situsCity is empty string (falsy, no signal)", () => {
    const decline = buildCascadeEnvelopeDecline(
      {
        parcelNodeId: "48021:TEST-UNINC-2",
        atomDid: "did:hauska:zoning-fact:48021:TEST-UNINC-2",
        situsCity: "",
      },
      "48021",
      "2026-08-04T00:00:00.000Z",
    );
    expect(decline.warmVerifyDeclineCode).toBe(UNZONED_NO_DISTRICT_BASIS_CODE);
  });
});

describe("classifyCascadeCohort", () => {
  it("classifies a truthy situsCity as the in-city cohort", () => {
    expect(classifyCascadeCohort("Elgin")).toMatchObject({
      code: NO_DISTRICT_ON_RECORD_CODE,
      reason: NO_DISTRICT_ON_RECORD_REASON,
    });
  });

  it("classifies null/undefined/empty/whitespace-only situsCity as the unincorporated cohort", () => {
    // classifyCascadeCohort checks situsCity.trim().length > 0 — a
    // whitespace-only string has no real signal and is correctly treated the
    // same as null/undefined/empty (unincorporated cohort).
    for (const v of [null, undefined, "", "   "]) {
      const result = classifyCascadeCohort(v as string | null | undefined);
      expect(result.code).toBe(UNZONED_NO_DISTRICT_BASIS_CODE);
      expect(result.reason).toBe(UNZONED_NO_DISTRICT_BASIS_REASON);
    }
  });
});

describe("jurisdictionTenantCitySegment / jurisdictionTenantHasCitySignal", () => {
  it("extracts a single-word city segment", () => {
    expect(jurisdictionTenantCitySegment("breadth_48021_smithville")).toBe(
      "smithville",
    );
    expect(jurisdictionTenantHasCitySignal("breadth_48021_smithville")).toBe(
      true,
    );
  });

  it("extracts a multi-word (underscore-joined) city segment", () => {
    expect(jurisdictionTenantCitySegment("breadth_48021_del_valle")).toBe(
      "del_valle",
    );
  });

  it("returns null / false for the unknown sentinel (no signal)", () => {
    expect(jurisdictionTenantCitySegment("breadth_48021_unknown")).toBeNull();
    expect(jurisdictionTenantHasCitySignal("breadth_48021_unknown")).toBe(
      false,
    );
  });

  it("returns null / false for null, empty, or malformed input", () => {
    expect(jurisdictionTenantCitySegment(null)).toBeNull();
    expect(jurisdictionTenantCitySegment(undefined)).toBeNull();
    expect(jurisdictionTenantCitySegment("")).toBeNull();
    expect(jurisdictionTenantCitySegment("not-a-breadth-tenant")).toBeNull();
    expect(jurisdictionTenantCitySegment("breadth_48021")).toBeNull();
    expect(jurisdictionTenantHasCitySignal("elgin_tx")).toBe(false);
  });
});

describe("bake-property-atom-county.mjs --cascade-absence-only city-cohort exclusion (pinned)", () => {
  const scriptPath = join(HERE, "../../../scripts/bake-property-atom-county.mjs");
  const scriptSource = readFileSync(scriptPath, "utf8");

  function extractFunctionSource(name: string): string {
    // Bounded match: from `async function <name>()` up to (but not
    // including) the NEXT top-level (column-0, unindented) `async function`
    // declaration, or EOF. Anchored to line-start so a NESTED helper (e.g.
    // runCascadeAbsenceOnly's own indented `async function flush()`) does
    // not get mistaken for the next top-level function boundary.
    const header = `async function ${name}(`;
    const startIdx = scriptSource.indexOf(header);
    expect(startIdx).toBeGreaterThanOrEqual(0);
    const fromStart = scriptSource.slice(startIdx);
    const nextTopLevelFn = /\nasync function \w+\(/.exec(
      fromStart.slice(header.length),
    );
    return nextTopLevelFn
      ? fromStart.slice(0, header.length + nextTopLevelFn.index)
      : fromStart;
  }

  it("selects candidate parcels with a district IS NULL predicate (never a district-bearing row)", () => {
    // Structural pin: the cascade query MUST filter on absence — a
    // district-bearing (city-cohort) zoning-fact must never be selected as a
    // cascade candidate. This greps the actual query text rather than
    // re-deriving DB behavior, so a future edit that drops the guard fails
    // this test even without a live database.
    const cascadeFnSource = extractFunctionSource("runCascadeAbsenceOnly");

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

  it("cascade query reads jurisdiction_tenant (real column), not the dead baseFacts.situsCity JSON path", () => {
    // Regression pin for the REASON-OVERSTATES investigation finding: the
    // ORIGINAL cascade query selected body->'baseFacts'->>'situsCity', but
    // ZoningFactAtomInstance never carries a baseFacts key (verified against
    // packages/atoms/src/property-instances.ts) — that JSON path was always
    // NULL in cascade-absence-only mode. The fix reads jurisdiction_tenant,
    // a real persisted+indexed column, instead.
    const cascadeFnSource = extractFunctionSource("runCascadeAbsenceOnly");
    // The dead JSON-path SELECT expression (exact original line, including
    // its column alias) must be gone from the query. A code comment
    // elsewhere in this function legitimately mentions the same JSON-path
    // TEXT to document why it was removed, so this pins the precise SELECT
    // line rather than banning the substring outright.
    expect(cascadeFnSource).not.toContain(
      "body->'baseFacts'->>'situsCity' AS situs_city",
    );
    expect(cascadeFnSource).toContain("jurisdiction_tenant,");
    expect(cascadeFnSource).toContain("jurisdictionTenantCitySegment(row.jurisdiction_tenant)");
  });

  it("--cascade-absence-only flag is parsed and gates cortex-snapshot connection", () => {
    expect(scriptSource).toContain('"--cascade-absence-only"');
    expect(scriptSource).toContain("cascadeAbsenceOnly");
    // In cascade mode, CORTEX_DATABASE_URL must not be required — the mode
    // reads/writes substrate only.
    expect(scriptSource).toMatch(
      /substrateOnlyMode = args\.cascadeAbsenceOnly \|\| args\.rewordCityParcels/,
    );
    expect(scriptSource).toMatch(/if \(!substrateOnlyMode && !cortexUrl\)/);
  });

  it("--reword-city-parcels flag is parsed, dry-run by default, and gates cortex-snapshot connection", () => {
    expect(scriptSource).toContain('"--reword-city-parcels"');
    expect(scriptSource).toContain("rewordCityParcels");
    expect(scriptSource).toContain('"--apply"');
    // dry-run default: dryRun = !args.apply (never true-by-default persist).
    expect(scriptSource).toMatch(/const dryRun = !args\.apply;/);
  });

  it("reword function only ever UPDATEs entity_type='buildable-envelope', never zoning-fact or setback-rule", () => {
    const rewordFnSource = extractFunctionSource("runRewordCityParcels");
    expect(rewordFnSource).toContain(
      "WHERE entity_type = 'buildable-envelope'",
    );
    expect(rewordFnSource).not.toMatch(/UPDATE atoms[\s\S]*?entity_type = 'zoning-fact'/);
    expect(rewordFnSource).not.toMatch(/entity_type\s*=\s*'setback-rule'/);
    expect(rewordFnSource).not.toContain("emitZoningFact");
    expect(rewordFnSource).not.toContain("emitFromTier1Snapshot(");
    // Only ever rewrites FROM the old code TO the new code (never the reverse).
    expect(rewordFnSource).toContain(
      "env.body->>'warmVerifyDeclineCode' = ${UNZONED_NO_DISTRICT_BASIS_CODE}",
    );
    expect(rewordFnSource).toContain(
      "warmVerifyDeclineCode: NO_DISTRICT_ON_RECORD_CODE",
    );
    // Idempotency guard: skips rows already carrying the new code.
    expect(rewordFnSource).toMatch(
      /body\.warmVerifyDeclineCode === NO_DISTRICT_ON_RECORD_CODE/,
    );
    // contentHash recompute on every write.
    expect(rewordFnSource).toContain("contentHashExcludingProvenance(next)");
  });
});
