import { describe, expect, it } from "vitest";
import { PLACEHOLDER_SETBACK_PROVENANCE } from "@hauska-engine/adapters";

import {
  CITY_REQUIRED,
  COUNTY_REQUIRED,
  DISTRICT_UNRESOLVED,
  JURISDICTION_BINDING_UNRESOLVED,
  MCLENNAN_ENVELOPE_COLLISION,
  PLACEHOLDER_COLLISION,
  SETBACK_APPLY_HELD,
  SetbackWriterRefuseError,
  planCitySetback,
  planConformantChunks,
  resolveSetbackCityBinding,
} from "../index.js";
import {
  parseSetbackWriterArgs,
  runSetbackWriter,
} from "../../../scripts/write-setback-city.mjs";

function refuseCode(fn: () => unknown): string {
  try {
    fn();
    throw new Error("expected refuse");
  } catch (err) {
    if (err instanceof SetbackWriterRefuseError) return err.code;
    throw err;
  }
}

describe("setback writer flags", () => {
  it("parses --county=48021 and --city=elgin-tx (falsifier: equals-form dropped)", () => {
    const args = parseSetbackWriterArgs(["--county=48021", "--city=elgin-tx"]);
    expect(args.county).toBe("48021");
    expect(args.city).toBe("elgin-tx");
  });

  it("parses spaced --county and --city", () => {
    const args = parseSetbackWriterArgs(["--county", "48021", "--city", "elgin-tx"]);
    expect(args.county).toBe("48021");
    expect(args.city).toBe("elgin-tx");
  });

  it("missing county refuses COUNTY_REQUIRED (falsifier: default 48021)", () => {
    expect(refuseCode(() => resolveSetbackCityBinding("elgin-tx", null))).toBe(
      COUNTY_REQUIRED,
    );
    expect(refuseCode(() => planCitySetback({ cityKey: "elgin-tx", parcels: [] }))).toBe(
      COUNTY_REQUIRED,
    );
  });

  it("missing city refuses CITY_REQUIRED (falsifier: county-only emit)", () => {
    expect(refuseCode(() => resolveSetbackCityBinding(null, "48021"))).toBe(CITY_REQUIRED);
    expect(refuseCode(() => planCitySetback({ countyFips: "48021", parcels: [] }))).toBe(
      CITY_REQUIRED,
    );
  });

  it("--apply refuses SETBACK_APPLY_HELD (falsifier: apply writes)", () => {
    expect(
      refuseCode(() =>
        runSetbackWriter(["--county=48021", "--city=elgin-tx", "--apply"], {
          SETBACK_PATH: "1",
        }),
      ),
    ).toBe(SETBACK_APPLY_HELD);
  });

  it("CLI missing county refuses COUNTY_REQUIRED before fixture", () => {
    expect(
      refuseCode(() =>
        runSetbackWriter(["--city=elgin-tx"], { SETBACK_PATH: "1" }),
      ),
    ).toBe(COUNTY_REQUIRED);
  });

  it("CLI missing city refuses CITY_REQUIRED before fixture", () => {
    expect(
      refuseCode(() =>
        runSetbackWriter(["--county=48021"], { SETBACK_PATH: "1" }),
      ),
    ).toBe(CITY_REQUIRED);
  });
});

describe("setback city binding", () => {
  it("elgin-tx + 48021 resolves from staging and registry (two derivations)", () => {
    const binding = resolveSetbackCityBinding("elgin-tx", "48021");
    expect(binding.cityKey).toBe("elgin-tx");
    expect(binding.counties).toContain("48021");
    expect(binding.tableLanded).toBe(true);
    expect(binding.namedSource?.id).toBeTruthy();
    expect(binding.namedSource?.citation).toBeTruthy();
    expect(binding.derivations.length).toBeGreaterThanOrEqual(1);
  });

  it("unknown city refuses JURISDICTION_BINDING_UNRESOLVED (falsifier: raw key accepted)", () => {
    expect(refuseCode(() => resolveSetbackCityBinding("not-a-city", "48021"))).toBe(
      JURISDICTION_BINDING_UNRESOLVED,
    );
  });

  it("table key without county membership refuses (austin-tx on 48021)", () => {
    expect(refuseCode(() => resolveSetbackCityBinding("austin-tx", "48021"))).toBe(
      JURISDICTION_BINDING_UNRESOLVED,
    );
  });

  it("elgin-tx on McLennan 48309 is not a binding", () => {
    expect(refuseCode(() => resolveSetbackCityBinding("elgin-tx", "48309"))).toBe(
      JURISDICTION_BINDING_UNRESOLVED,
    );
  });
});

describe("setback city plan — applicability", () => {
  it("unincorporated is not-applicable (falsifier: emit setback outside city)", () => {
    const plan = planCitySetback({
      countyFips: "48021",
      cityKey: "elgin-tx",
      parcels: [{ parcelNodeId: "48021:UNINC-1", inCity: false }],
    });
    expect(plan.planned[0]?.outcome).toBe("not-applicable");
    expect(plan.counts.notApplicable).toBe(1);
  });

  it("in-city no table is unmeasured, never not-applicable (smithville)", () => {
    const plan = planCitySetback({
      countyFips: "48021",
      cityKey: "smithville-tx",
      parcels: [{ parcelNodeId: "48021:SMITH-1", inCity: true, district: "R-1" }],
    });
    expect(plan.binding.tableLanded).toBe(false);
    expect(plan.planned[0]?.outcome).toBe("unmeasured");
    expect(plan.planned[0]?.outcome).not.toBe("not-applicable");
    expect(plan.counts.notApplicable).toBe(0);
  });

  it("in-city no table after probe is absent-verified, not not-applicable", () => {
    const plan = planCitySetback({
      countyFips: "48021",
      cityKey: "smithville-tx",
      parcels: [{ parcelNodeId: "48021:SMITH-2", inCity: true }],
      tableProbed: true,
    });
    expect(plan.planned[0]?.outcome).toBe("absent-verified");
    expect(plan.planned[0]?.outcome).not.toBe("not-applicable");
  });

  it("in-city elgin R-1 plans present with a named source", () => {
    const plan = planCitySetback({
      countyFips: "48021",
      cityKey: "elgin-tx",
      parcels: [{ parcelNodeId: "48021:ELGIN-R1", inCity: true, district: "R-1" }],
    });
    expect(plan.planned[0]?.outcome).toBe("present");
    expect(plan.planned[0]?.district).toBe("R-1");
    expect(plan.planned[0]?.source?.id).toBeTruthy();
  });

  it("in-city unresolvable district refuses DISTRICT_UNRESOLVED (falsifier: fallback row)", () => {
    expect(
      refuseCode(() =>
        planCitySetback({
          countyFips: "48021",
          cityKey: "elgin-tx",
          parcels: [{ parcelNodeId: "48021:ELGIN-ZZ", inCity: true, district: "ZZZ" }],
        }),
      ),
    ).toBe(DISTRICT_UNRESOLVED);
  });

  it("placeholder setback-rule input refuses PLACEHOLDER_COLLISION (falsifier: adopt phase-1a)", () => {
    expect(
      refuseCode(() =>
        planCitySetback({
          countyFips: "48021",
          cityKey: "elgin-tx",
          parcels: [
            {
              parcelNodeId: "48021:PH-1",
              inCity: true,
              district: "R-1",
              existingSetbackRule: {
                sourceAdapter: "property-atom-proof",
                sourceCodeAtomRef: {
                  atomDid: `did:hauska:code-section:${PLACEHOLDER_SETBACK_PROVENANCE}`,
                },
              },
            },
          ],
        }),
      ),
    ).toBe(PLACEHOLDER_COLLISION);
  });

  it("McLennan envelope from 0 rules refuses MCLENNAN_ENVELOPE_COLLISION (named before binding)", () => {
    expect(
      refuseCode(() =>
        planCitySetback({
          countyFips: "48309",
          cityKey: "elgin-tx",
          parcels: [
            {
              parcelNodeId: "48309:ENV-1",
              inCity: true,
              envelopeWithoutSetbackRule: true,
            },
          ],
        }),
      ),
    ).toBe(MCLENNAN_ENVELOPE_COLLISION);
  });
});

describe("setback conformant chunk plan", () => {
  it("orders slices and emits a run_event per chunk with lease lock in the chunk", () => {
    const plan = planCitySetback({
      countyFips: "48021",
      cityKey: "elgin-tx",
      parcels: [
        { parcelNodeId: "48021:B", inCity: false },
        { parcelNodeId: "48021:A", inCity: true, district: "R-1" },
      ],
    });
    const chunks = planConformantChunks(plan, { chunkSize: 1, runId: "factory-run-1" });
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.items[0]?.parcelNodeId).toBe("48021:A");
    expect(chunks[0]?.runEvent).toMatchObject({
      kind: "chunk",
      runId: "factory-run-1",
      chunkIndex: 0,
      countyFips: "48021",
    });
    expect(chunks[0]?.leaseLock).toEqual({
      scope_type: "write",
      entity_type: "setback-rule",
      county_fips: "48021",
      lockInChunkTransaction: true,
    });
    expect(chunks[0]?.links[0]?.kind).toBe("derived-from");
  });
});
