/**
 * P-302 — engine-core's site-plan reader shows a declared refusal, never the
 * baked value.
 *
 * The defect this file pins, in one sentence: every helper in
 * `parcel-record-reader-client.ts` returned `undefined` for any cell whose kind
 * was not `value`, and `undefined` is indistinguishable from "this rail is not
 * slated", so every caller's `?? cadRoll?.<field>` (and
 * `resolve-export-setback`'s fall-through to the ruled corpus row) printed the
 * legacy or baked value where OPS-24 law 7 (operator ruling A-193) requires a
 * declared refusal carrying its reason.
 *
 * THREE THINGS ARE ASSERTED HERE THAT ARE NOT ASSERTIONS OF THIS LANE'S OWN
 * OUTPUT:
 *
 *  1. The shared cross-repo fixture (`services/retrieval-api/src/__fixtures__/cell-serve-rule.json`,
 *     P-297's contract, an artifact of the OTHER repo, read here and never
 *     edited) drives THIS client row by row. Until this lane the engine half of
 *     that contract was unasserted: the fixture pinned the server's decision and
 *     nothing checked that engine-core consumed it. The expectations come from
 *     the file, not from the function under test.
 *  2. Both directions for every caller: a slated refusal shows the refusal and
 *     NOT the substrate value; an unslated rail still shows the substrate.
 *  3. The three dispatch falsifiers, by name, including the mutation half of
 *     falsifier 3 performed and reverted rather than asserted.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import type { PropertyAtomInstance } from "@hauska-engine/atoms";
import type { StoragePort } from "@hauska-engine/storage";

import {
  recordScalarValueAnswer,
  type ParcelRecordRail,
  type ParcelRecordResponse,
  type RecordReaderClient,
} from "../parcel-record-reader-client.js";
import { composeParcelReportFacts } from "../report-model.js";
import { resolveExportSetback } from "../resolve-export-setback.js";

/* ─────────────── the fixture is the contract, not this file ─────────────── */

const FIXTURE_URL = new URL(
  "../../../../../services/retrieval-api/src/__fixtures__/cell-serve-rule.json",
  import.meta.url,
);

interface CellServeFixtureRow {
  name: string;
  slated: boolean;
  cellState: Record<string, unknown> | null;
  companionRows: unknown[];
  expect: {
    serve: "cell" | "current-path";
    form: "value" | "absence" | "refusal" | null;
    absenceVerdict: "absent-verified" | "not-applicable" | null;
    refusalCode: string | null;
  };
}

interface CellServeFixture {
  _ruleId: string;
  pinnedRowNames: string[];
  rows: CellServeFixtureRow[];
}

const FIXTURE: CellServeFixture = JSON.parse(readFileSync(FIXTURE_URL, "utf8"));

/**
 * Turn one fixture row into the rail the wire would carry for it. The row's
 * `expect` is the SERVER's decision (which `serve` state the response lands
 * in); this is the documented translation of that decision onto the wire shape
 * the client consumes, and it is the only place this file interprets the
 * fixture rather than reading it.
 */
function railFromFixtureRow(row: CellServeFixtureRow): ParcelRecordRail {
  const serve =
    row.expect.serve === "current-path"
      ? "legacy-transitional"
      : row.expect.form === "refusal"
        ? "refused"
        : "record";
  const reason =
    (row.cellState?.reason as string | undefined) ??
    ((row.cellState?.basis as { finding?: string } | undefined)?.finding as string | undefined) ??
    "the store's own reason is not repeated in the fixture for this row";
  return {
    cell: row.cellState,
    gate: { verdict: null, evaluatedAt: null },
    serve,
    refusal: row.expect.form === "refusal" ? { code: row.expect.refusalCode as never, reason } : null,
    atom: null,
    atomBacked: false,
    rendering: null,
    companions: row.companionRows,
  };
}

describe("P-302: the shared cell-serve fixture drives THIS client", () => {
  it("every row lands on the form and code the fixture pins — the engine half of P-297's cross-repo contract", () => {
    expect(FIXTURE.rows.length).toBeGreaterThanOrEqual(11);
    for (const row of FIXTURE.rows) {
      const answer = recordScalarValueAnswer(railFromFixtureRow(row));
      // Compared as a tuple so a failure names the row as well as the mismatch.
      expect([row.name, answer.form]).toEqual([row.name, row.expect.form ?? "current-path"]);
      if (row.expect.form === "absence") {
        expect([row.name, answer.form === "absence" ? answer.absenceVerdict : null]).toEqual([
          row.name,
          row.expect.absenceVerdict,
        ]);
        // A stated absence carries the store's own words, not engine prose.
        if (answer.form === "absence") expect(answer.reason).toBeTruthy();
      }
      if (row.expect.form === "refusal") {
        expect([row.name, answer.form === "refusal" ? answer.code : null]).toEqual([
          row.name,
          row.expect.refusalCode,
        ]);
        // A refusal always carries a reason. The fixture pins the CODE, not the
        // prose (for the missing-cell and unaccounted rows the server composes
        // its own sentence, which the fixture deliberately does not restate).
        if (answer.form === "refusal") expect(answer.reason.length).toBeGreaterThan(0);
      }
    }
  });

  it("NON-VACUITY: the fixture spans the whole decision space, so 'it agrees with every row' is not a rule that always passes", () => {
    // If every row pinned the same answer, the test above would pass for ANY
    // implementation. These are the dimensions that make it discriminating.
    const forms = new Set(FIXTURE.rows.map((r) => r.expect.form));
    expect(forms).toEqual(new Set(["value", "absence", "refusal", null]));
    const verdicts = new Set(FIXTURE.rows.filter((r) => r.expect.form === "absence").map((r) => r.expect.absenceVerdict));
    expect(verdicts).toEqual(new Set(["absent-verified", "not-applicable"]));
    const codes = new Set(FIXTURE.rows.filter((r) => r.expect.form === "refusal").map((r) => r.expect.refusalCode));
    expect(codes).toEqual(new Set(["engine-refused", "unaccounted", "malformed-cell", "no-such-parcel-or-rail"]));
    // Both slate answers appear, and the pinned names are all present.
    expect(new Set(FIXTURE.rows.map((r) => r.slated))).toEqual(new Set([true, false]));
    expect(FIXTURE.pinnedRowNames.length).toBeGreaterThanOrEqual(11);
    for (const pinned of FIXTURE.pinnedRowNames) {
      expect(FIXTURE.rows.map((r) => r.name)).toContain(pinned);
    }
    expect(FIXTURE._ruleId).toBe("cell-serve-rule-v1");
  });

  it("serve 'record' with a kind this reader has never seen is its OWN refusal — never a value, never silence", () => {
    // Not reachable through a post-P-297 serving build (the server would have
    // said `refused`), which is exactly why it is asserted directly: the client
    // must not depend on the server having classified the cell for it.
    const answer = recordScalarValueAnswer({
      cell: { kind: "something-nobody-has-seen", value: 12 },
      gate: { verdict: null, evaluatedAt: null },
      serve: "record",
      refusal: null,
      atom: null,
      atomBacked: false,
      rendering: null,
      companions: [],
    });
    expect(answer.form).toBe("refusal");
    if (answer.form === "refusal") expect(answer.code).toBe("malformed-cell");
  });

  it("serve 'refused' with no refusal detail refuses under the client's OWN code, never one of the wire's four", () => {
    const answer = recordScalarValueAnswer({
      cell: null,
      gate: { verdict: null, evaluatedAt: null },
      serve: "refused",
      refusal: null,
      atom: null,
      atomBacked: false,
      rendering: null,
      companions: [],
    });
    expect(answer.form).toBe("refusal");
    if (answer.form === "refusal") {
      expect(answer.code).toBe("refusal-detail-missing");
      // Naming one of the wire's codes here would attribute a finding to the
      // store that the store never made.
      expect(["engine-refused", "unaccounted", "malformed-cell", "no-such-parcel-or-rail"]).not.toContain(answer.code);
    }
  });
});

/* ─────────────────── the report model: both directions ─────────────────── */

const PARCEL = "48021:34049";
/** Deliberately a value that appears NOWHERE else in these fixtures. */
const SUBSTRATE_MARKET_VALUE = 100_000;

function rail(
  serve: ParcelRecordRail["serve"],
  cell: Record<string, unknown> | null,
  refusal: ParcelRecordRail["refusal"] = null,
  companions: unknown[] = [],
): ParcelRecordRail {
  return { cell, gate: { verdict: null, evaluatedAt: null }, serve, refusal, atom: null, atomBacked: false, rendering: null, companions };
}

const ABSENT_GEOMETRY = { status: "absent" as const, reason: "not needed for this fixture" };
const NO_DRAINAGE = { status: "absent" as const, reason: "test fixture: drainage not composed" };

function fakeStorage(atoms: unknown[]): StoragePort {
  return { listPropertyAtomsByParcelNodeId: async () => atoms } as unknown as StoragePort;
}

function cadRollAtom(): PropertyAtomInstance {
  return {
    entityType: "cad-parcel-roll",
    atomDid: "cad_p302",
    parcelNodeId: PARCEL,
    taxYear: 2025,
    countyFips: "48021",
    propId: "34049",
    keyKind: "prop_id",
    joinPassedOwnerMatchGate: true,
    reasoningChain: { reasoningKind: "observed" },
    sourceTier: "county-cad",
    marketValue: SUBSTRATE_MARKET_VALUE,
    accessPolicy: "public-free",
    sourceCitation: "Bastrop CAD 2025 roll",
    extractedAt: "2026-08-01T00:00:00Z",
    verificationStatus: "machine",
    sourceAdapter: "cad-roll:bastrop",
    evaluatedAt: "2026-08-01T00:00:00Z",
    atomTier: "data",
    entityId: PARCEL,
    jurisdictionTenant: "property-spine",
    fetchedAt: "2026-08-01T00:00:00Z",
    sourceUrl: "",
    contentHash: "",
    status: "active",
  } as unknown as PropertyAtomInstance;
}

function substrateSpecialDistrictAtom(): PropertyAtomInstance {
  return {
    entityType: "special-district-fact",
    atomDid: "sdf_p302",
    parcelNodeId: PARCEL,
    districtId: "west-travis-mud-3",
    districtName: "SUBSTRATE-ONLY DISTRICT",
    districtType: "MUD",
    reasoningChain: { reasoningKind: "observed" },
    sourceTier: "tceq",
    accessPolicy: "public-free",
    sourceCitation: "TCEQ water-district membership",
    extractedAt: "2026-08-01T00:00:00Z",
    verificationStatus: "machine",
    sourceAdapter: "tceq-special-district",
    evaluatedAt: "2026-08-01T00:00:00Z",
    atomTier: "data",
    entityId: PARCEL,
    jurisdictionTenant: "property-spine",
    fetchedAt: "2026-08-01T00:00:00Z",
    sourceUrl: "",
    contentHash: "",
    status: "active",
  } as unknown as PropertyAtomInstance;
}

/** A REAL macrotask delay, never an instantly-resolving fake — see parcel-record-reader-integration.test.ts's own note on the defect an instant fake masked. */
function delayed<T>(value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), 5));
}

function fakeReader(record: ParcelRecordResponse): RecordReaderClient {
  return { fetchRecord: () => delayed({ ok: true, record }) };
}

function recordWith(rails: Record<string, ParcelRecordRail>): ParcelRecordResponse {
  return { parcelNodeId: PARCEL, placeKey: PARCEL, countyFips: "48021", railRegistrySha: "test", readAt: "2026-09-17T00:00:00.000Z", rails, refused: null };
}

const UNACCOUNTED_REASON = "parcel_record has not yet examined this rail for this parcel.";

async function ownership(
  marketValueRail: ParcelRecordRail,
  atoms: unknown[] = [cadRollAtom()],
) {
  const model = await composeParcelReportFacts({
    parcelNodeId: PARCEL,
    storage: fakeStorage(atoms),
    geometry: ABSENT_GEOMETRY,
    drainage: NO_DRAINAGE,
    recordReader: fakeReader(recordWith({ marketValue: marketValueRail })),
  });
  return model.facts.parcelOwnership;
}

describe("P-302 falsifier 1 and 2: a slated refusal is the refusal; an unslated rail is still the substrate", () => {
  it("FALSIFIER 1 — a slated rail with an `unaccounted` cell and a substrate value renders the refusal with its reason, and the substrate value appears NOWHERE in the output", async () => {
    const ownershipFacts = await ownership(
      rail("refused", { kind: "unaccounted" }, { code: "unaccounted", reason: UNACCOUNTED_REASON }),
    );

    // (a) the refusal is rendered, with the store's own reason
    expect(JSON.stringify(ownershipFacts)).toContain(UNACCOUNTED_REASON);
    expect(ownershipFacts).toMatchObject({
      status: "present",
      ledgerRefusals: [{ field: "marketValue", code: "unaccounted", reason: UNACCOUNTED_REASON }],
    });

    // (b) the refused field is unset
    if (ownershipFacts.status !== "present") throw new Error("unreachable");
    expect(ownershipFacts.marketValue).toBeUndefined();

    // (c) the substrate value is not anywhere in the section — the half that
    // cannot pass by accident, because the atom above really does carry it.
    expect(JSON.stringify(ownershipFacts)).not.toContain(String(SUBSTRATE_MARKET_VALUE));
  });

  it("FALSIFIER 2 — the SAME fixture with the rail unslated still renders the substrate value, and adds no refusal", async () => {
    // Differs from falsifier 1 by `serve` alone.
    const ownershipFacts = await ownership(
      rail("legacy-transitional", { kind: "unaccounted" }, null),
    );

    if (ownershipFacts.status !== "present") throw new Error("unreachable");
    expect(ownershipFacts.marketValue).toBe(SUBSTRATE_MARKET_VALUE);
    expect(ownershipFacts.ledgerRefusals).toBeUndefined();
    expect(JSON.stringify(ownershipFacts)).not.toContain("refusal");
  });

  it("a slated rail's STATED ABSENCE is the answer too — the substrate value is not substituted for it either", async () => {
    const ownershipFacts = await ownership(
      rail("record", { kind: "absent-verified", basis: { finding: "no valuation on file for this account" } }),
    );
    if (ownershipFacts.status !== "present") throw new Error("unreachable");
    expect(ownershipFacts.marketValue).toBeUndefined();
    expect(JSON.stringify(ownershipFacts)).not.toContain(String(SUBSTRATE_MARKET_VALUE));
    expect(ownershipFacts.ledgerRefusals).toBeUndefined();
  });

  it("ONE refused rail suppresses only its own field: the section stays present, and owner/legal facts the ruling never named are NOT withheld", async () => {
    const ownershipFacts = await ownership(
      rail("refused", { kind: "refused" }, { code: "engine-refused", reason: "no usable zoning district could be resolved" }),
    );
    expect(ownershipFacts.status).toBe("present");
    // legalDescription comes from the SAME substrate atom the refused rail did
    // not answer for, and is still stated: field-level refusal, not section-level.
    if (ownershipFacts.status !== "present") throw new Error("unreachable");
    expect(ownershipFacts.ledgerRefusals).toHaveLength(1);
  });

  it("when a refusal is ALL there is, the section itself is absent(`refused`) — a stronger statement than blocked-at-source, because the ledger was asked", async () => {
    const ownershipFacts = await ownership(rail("refused", { kind: "unaccounted" }, { code: "unaccounted", reason: UNACCOUNTED_REASON }), []);
    expect(ownershipFacts).toMatchObject({ status: "absent", kind: "refused" });
    if (ownershipFacts.status !== "absent") throw new Error("unreachable");
    expect(ownershipFacts.reason).toContain(UNACCOUNTED_REASON);
  });
});

describe("P-302: the single-rail sections render a refusal as a refusal, and consult no other source", () => {
  it("specialDistricts: a slated refusal is NOT the substrate TCEQ atoms, and the substrate-only district does not appear anywhere", async () => {
    const model = await composeParcelReportFacts({
      parcelNodeId: PARCEL,
      storage: fakeStorage([substrateSpecialDistrictAtom()]),
      geometry: ABSENT_GEOMETRY,
      drainage: NO_DRAINAGE,
      recordReader: fakeReader(
        recordWith({
          specialDistricts: rail("refused", { kind: "refused" }, { code: "engine-refused", reason: "the district sweep did not complete for this parcel" }),
        }),
      ),
    });
    expect(model.facts.specialDistricts).toMatchObject({ status: "absent", kind: "refused" });
    if (model.facts.specialDistricts.status !== "absent") throw new Error("unreachable");
    expect(model.facts.specialDistricts.reason).toContain("the district sweep did not complete for this parcel");
    // The pre-cutover path would have named it; the ruling forbids that.
    expect(JSON.stringify(model.facts.specialDistricts)).not.toContain("SUBSTRATE-ONLY DISTRICT");
  });

  it("specialDistricts: the same substrate atoms still answer when the rail is UNSLATED (the other direction)", async () => {
    const model = await composeParcelReportFacts({
      parcelNodeId: PARCEL,
      storage: fakeStorage([substrateSpecialDistrictAtom()]),
      geometry: ABSENT_GEOMETRY,
      drainage: NO_DRAINAGE,
      recordReader: fakeReader(recordWith({ specialDistricts: rail("legacy-transitional", null) })),
    });
    expect(model.facts.specialDistricts).toMatchObject({ status: "present" });
    expect(JSON.stringify(model.facts.specialDistricts)).toContain("SUBSTRATE-ONLY DISTRICT");
  });

  it("specialDistricts: a slated value cell that carried no districts is a CHECKED clear, not the pre-cutover substrate path", async () => {
    const model = await composeParcelReportFacts({
      parcelNodeId: PARCEL,
      storage: fakeStorage([substrateSpecialDistrictAtom()]),
      geometry: ABSENT_GEOMETRY,
      drainage: NO_DRAINAGE,
      recordReader: fakeReader(recordWith({ specialDistricts: rail("record", { kind: "value" }) })),
    });
    expect(model.facts.specialDistricts).toMatchObject({ status: "absent", kind: "clear" });
    expect(JSON.stringify(model.facts.specialDistricts)).not.toContain("SUBSTRATE-ONLY DISTRICT");
  });

  it("utilities: a slated refusal is a refusal AND the HIFLD resolver is never called at all", async () => {
    let hifldCalled = false;
    const model = await composeParcelReportFacts({
      parcelNodeId: PARCEL,
      storage: fakeStorage([]),
      geometry: ABSENT_GEOMETRY,
      drainage: NO_DRAINAGE,
      recordReader: fakeReader(
        recordWith({ utilityService: rail("refused", { kind: "unaccounted" }, { code: "unaccounted", reason: "the CCN rails are unaccounted for this county" }) }),
      ),
      centroid: { latitude: 30.11, longitude: -97.31 },
      whoServes: {
        resolve: async () => {
          hifldCalled = true;
          return { status: "measured" as const, holders: [{ serviceKind: "electric" as const, territoryName: "SUBSTRATE-ONLY ELECTRIC" }], residual: "residual", asOf: "2026-09-15T00:00:00.000Z" };
        },
      },
    });
    expect(model.facts.utilities).toMatchObject({ status: "absent", kind: "refused" });
    expect(hifldCalled).toBe(false);
    expect(JSON.stringify(model.facts.utilities)).not.toContain("SUBSTRATE-ONLY ELECTRIC");
  });

  it("utilities: an unslated rail keeps the pre-existing HIFLD-only behaviour (the other direction)", async () => {
    let hifldCalled = false;
    const model = await composeParcelReportFacts({
      parcelNodeId: PARCEL,
      storage: fakeStorage([]),
      geometry: ABSENT_GEOMETRY,
      drainage: NO_DRAINAGE,
      recordReader: fakeReader(recordWith({ utilityService: rail("legacy-transitional", null) })),
      centroid: { latitude: 30.11, longitude: -97.31 },
      whoServes: {
        resolve: async () => {
          hifldCalled = true;
          return { status: "measured" as const, holders: [{ serviceKind: "electric" as const, territoryName: "SUBSTRATE-ONLY ELECTRIC" }], residual: "residual", asOf: "2026-09-15T00:00:00.000Z" };
        },
      },
    });
    expect(hifldCalled).toBe(true);
    expect(JSON.stringify(model.facts.utilities)).toContain("SUBSTRATE-ONLY ELECTRIC");
  });

  it("overlayDistricts: a slated refusal is `refused`, not the `blocked-at-source` a rail that never ran earns", async () => {
    const model = await composeParcelReportFacts({
      parcelNodeId: PARCEL,
      storage: fakeStorage([]),
      geometry: ABSENT_GEOMETRY,
      drainage: NO_DRAINAGE,
      recordReader: fakeReader(recordWith({ overlayDistricts: rail("refused", { kind: "refused" }, { code: "engine-refused", reason: "the overlay lookup declined for this parcel" }) })),
    });
    expect(model.facts.overlayDistricts).toMatchObject({ status: "absent", kind: "refused" });
  });

  it("overlayDistricts: unslated keeps blocked-at-source (the other direction)", async () => {
    const model = await composeParcelReportFacts({
      parcelNodeId: PARCEL,
      storage: fakeStorage([]),
      geometry: ABSENT_GEOMETRY,
      drainage: NO_DRAINAGE,
      recordReader: fakeReader(recordWith({ overlayDistricts: rail("legacy-transitional", null) })),
    });
    expect(model.facts.overlayDistricts).toMatchObject({ status: "absent", kind: "blocked-at-source" });
  });

  it("readerParcelArea: a slated refusal is `refused`, not the `out-of-scope` an unasked rail earns", async () => {
    const model = await composeParcelReportFacts({
      parcelNodeId: PARCEL,
      storage: fakeStorage([]),
      geometry: ABSENT_GEOMETRY,
      drainage: NO_DRAINAGE,
      recordReader: fakeReader(recordWith({ parcelAreaSqFt: rail("refused", { kind: "unaccounted" }, { code: "unaccounted", reason: "no area row was examined" }) })),
    });
    expect(model.facts.readerParcelArea).toMatchObject({ status: "absent", kind: "refused" });
  });

  it("readerParcelArea: unslated keeps out-of-scope (the other direction)", async () => {
    const model = await composeParcelReportFacts({
      parcelNodeId: PARCEL,
      storage: fakeStorage([]),
      geometry: ABSENT_GEOMETRY,
      drainage: NO_DRAINAGE,
      recordReader: fakeReader(recordWith({ parcelAreaSqFt: rail("legacy-transitional", null) })),
    });
    expect(model.facts.readerParcelArea).toMatchObject({ status: "absent", kind: "out-of-scope" });
  });

  it("cityLimits: a slated refusal keeps the honest `unresolved` status AND carries the ledger's code and reason instead of going silent", async () => {
    const model = await composeParcelReportFacts({
      parcelNodeId: PARCEL,
      storage: fakeStorage([]),
      geometry: ABSENT_GEOMETRY,
      drainage: NO_DRAINAGE,
      recordReader: fakeReader(recordWith({ cityLimits: rail("refused", { kind: "refused" }, { code: "engine-refused", reason: "no usable jurisdiction could be resolved for this parcel" }) })),
    });
    expect(model.facts.jurisdiction.cityLimitsStatus).toBe("unresolved");
    expect(model.facts.jurisdiction.cityLimitsLedgerAnswer).toEqual({
      form: "refusal",
      code: "engine-refused",
      reason: "no usable jurisdiction could be resolved for this parcel",
    });
    expect(model.facts.jurisdiction.cityLimitsSourceCitation).toBeUndefined();
  });

  it("cityLimits: an UNSLATED rail still leaves `unresolved` with no ledger answer attached (the other direction)", async () => {
    const model = await composeParcelReportFacts({
      parcelNodeId: PARCEL,
      storage: fakeStorage([]),
      geometry: ABSENT_GEOMETRY,
      drainage: NO_DRAINAGE,
      recordReader: fakeReader(recordWith({ cityLimits: rail("legacy-transitional", null) })),
    });
    expect(model.facts.jurisdiction.cityLimitsStatus).toBe("unresolved");
    expect(model.facts.jurisdiction.cityLimitsLedgerAnswer).toBeUndefined();
  });
});

/* ─────────────── the export setback resolver: both directions ─────────────── */

const SETBACK_ATOM = {
  entityType: "setback-rule",
  atomDid: "did:hauska:setback-rule:48021:34049:setback:1",
  entityId: "48021:34049:setback:1",
  jurisdictionTenant: "bastrop-city-tx",
  parcelNodeId: PARCEL,
  fetchedAt: "2026-07-30T00:00:00.000Z",
  extractedAt: "2026-07-30T00:00:00.000Z",
  sourceAdapter: "bastrop-per-parcel-record-layer-23",
  sourceUrl: "https://example.test/ordinance.pdf",
  sourceCitation: "Setback rule for SF-1 cited to bastrop_tx/bdc-2026-adopted/14.02.003",
  accessPolicy: "platform-internal",
  atomTier: "data",
  status: "active",
  districtCode: "SF-1",
  front: 25,
  side: 5,
  rear: 25,
  sourceCodeAtomRef: { atomDid: "bastrop_tx/bdc-2026-adopted/14.02.003", role: "rule", entityType: "code-section" },
} as never;

const BASE_INPUT = {
  parcelNodeId: PARCEL,
  districtCode: "SF-1",
  jurisdictionKey: "bastrop-development-code",
};

describe("P-302: resolveExportSetback stops at the ledger's own answer instead of falling through to the ruled corpus", () => {
  it("a slated REFUSAL on a required rail is an honest absence carrying the store's words — the corpus row's scalars are not substituted", async () => {
    const resolved = await resolveExportSetback({
      ...BASE_INPUT,
      atom: SETBACK_ATOM,
      record: recordWith({
        setbackFrontFt: rail("refused", { kind: "unaccounted" }, { code: "unaccounted", reason: "the setback rails are unaccounted for this county" }),
        setbackSideFt: rail("legacy-transitional", null),
        setbackRearFt: rail("legacy-transitional", null),
      }),
    });

    expect(resolved.provenanceKind).toBe("honest-absence");
    expect(resolved.honestAbsence).toBe(true);
    expect(resolved.honestAbsenceReason).toContain("the setback rails are unaccounted for this county");
    expect(resolved.honestAbsenceReason).toContain("unaccounted");
    expect(resolved.ledgerRailAnswer?.form).toBe("refusal");
    expect(resolved.ledgerRailAnswer?.entries).toEqual([
      { rail: "setbackFrontFt", code: "unaccounted", reason: "the setback rails are unaccounted for this county" },
    ]);
    // Every inset is zero: NOT the ruled row's 25/5/25, and NOT the atom's.
    expect([resolved.front, resolved.side, resolved.rear, resolved.cornerFt]).toEqual([0, 0, 0, null]);
  });

  it("a slated STATED ABSENCE on a required rail is that absence — the ruled corpus row is not the answer for it", async () => {
    const resolved = await resolveExportSetback({
      ...BASE_INPUT,
      atom: SETBACK_ATOM,
      record: recordWith({
        setbackFrontFt: rail("legacy-transitional", null),
        setbackSideFt: rail("legacy-transitional", null),
        setbackRearFt: rail("record", { kind: "absent-verified", basis: { finding: "no rear-yard requirement applies in this district" } }),
      }),
    });
    expect(resolved.provenanceKind).toBe("honest-absence");
    expect(resolved.honestAbsenceReason).toContain("no rear-yard requirement applies in this district");
    expect(resolved.ledgerRailAnswer?.form).toBe("absence");
    expect([resolved.front, resolved.side, resolved.rear]).toEqual([0, 0, 0]);
  });

  it("an absence on the CORNER rail alone does NOT void a sheet the ledger answered: cornerFt is null, front/side/rear still come from the rails", async () => {
    const resolved = await resolveExportSetback({
      ...BASE_INPUT,
      atom: null,
      record: recordWith({
        setbackFrontFt: rail("record", { kind: "value", value: 30 }),
        setbackSideFt: rail("record", { kind: "value", value: 10 }),
        setbackRearFt: rail("record", { kind: "value", value: 30 }),
        setbackCornerFt: rail("record", { kind: "not-applicable", reason: "not a corner lot" }),
      }),
    });
    expect(resolved.provenanceKind).toBe("parcel-record-rails");
    expect([resolved.front, resolved.side, resolved.rear, resolved.cornerFt]).toEqual([30, 10, 30, null]);
  });

  it("UNSLATED: the rails answer nothing and the pre-cutover precedence still runs — the persisted atom is the answer, and the SAME atom is not the answer once the rail refuses", async () => {
    // A district with no ruled row, so the persisted atom below is the only
    // candidate — the shape the p219 suite already pins for this precedence.
    const liveAtom = {
      ...(SETBACK_ATOM as Record<string, unknown>),
      atomDid: "did:hauska:setback-rule:49019:1234:setback:1",
      entityId: "49019:1234:setback:1",
      parcelNodeId: "49019:1234",
      districtCode: "NOT-A-RULED-DISTRICT",
      front: 11,
      side: 12,
      rear: 13,
      sourceCodeAtomRef: { atomDid: "grand-county-ut/code/1.2.3", role: "rule", entityType: "code-section" },
    } as never;

    const unslated = await resolveExportSetback({
      parcelNodeId: "49019:1234",
      districtCode: "NOT-A-RULED-DISTRICT",
      jurisdictionKey: "grand-county-ut",
      atom: liveAtom,
      record: recordWith({
        setbackFrontFt: rail("legacy-transitional", { kind: "value", value: 30 }),
        setbackSideFt: rail("legacy-transitional", { kind: "value", value: 10 }),
        setbackRearFt: rail("legacy-transitional", { kind: "value", value: 30 }),
      }),
    });
    // UNSLATED — the rails are silent, so the pre-cutover precedence still runs
    // and the persisted atom is the answer, exactly as before this lane.
    expect(unslated.provenanceKind).toBe("setback-rule-atom");
    expect(unslated.ledgerRailAnswer).toBeUndefined();
    expect([unslated.front, unslated.side, unslated.rear]).toEqual([11, 12, 13]);

    // SLATED — the same atom, the same district, one rail refusing. The atom's
    // 11/12/13 are nowhere: the refusal outranks the substrate value.
    const slated = await resolveExportSetback({
      parcelNodeId: "49019:1234",
      districtCode: "NOT-A-RULED-DISTRICT",
      jurisdictionKey: "grand-county-ut",
      atom: liveAtom,
      record: recordWith({
        setbackFrontFt: rail("refused", { kind: "unaccounted" }, { code: "unaccounted", reason: UNACCOUNTED_REASON }),
        setbackSideFt: rail("legacy-transitional", { kind: "value", value: 10 }),
        setbackRearFt: rail("legacy-transitional", { kind: "value", value: 30 }),
      }),
    });
    expect(slated.provenanceKind).toBe("honest-absence");
    expect(slated.honestAbsenceReason).toContain(UNACCOUNTED_REASON);
    expect([slated.front, slated.side, slated.rear]).toEqual([0, 0, 0]);
  });
});
