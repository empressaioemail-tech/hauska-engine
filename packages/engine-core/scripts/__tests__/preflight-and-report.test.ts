/**
 * preflight-and-report.mjs, pure payload-builder tests.
 *
 * Imports the script module directly for its exported
 * buildPreflightIngestPayload function. The script's top-level main() is
 * gated on a direct-run check (process.argv[1] === this file), so importing
 * it here never spawns onboard-preflight.mjs or performs any network call -
 * no live DB/network required.
 */
import { describe, it, expect } from "vitest";

// @ts-expect-error, .mjs has no type declarations; the exported function shape is asserted at the call sites below.
import { buildPreflightIngestPayload } from "../preflight-and-report.mjs";

/** Fixture shaped like onboard-preflight.mjs's `{ report, ledgerEvents }` stdout. */
const FIXTURE_ALL_PASS = {
  report: {
    fips: "48021",
    rows: [
      {
        rowId: "Bastrop",
        checks: [
          { id: "railASourceReachable", name: "Rail A source + adapter reachable", outcome: "PASS" },
          { id: "parcelLayerWired", name: "Rail C parcel layer wired in registry row", outcome: "PASS" },
        ],
        railPlan: { runs: ["Rail A source + adapter reachable", "Rail C parcel layer wired in registry row"], declines: [] },
      },
    ],
  },
  ledgerEvents: [],
};

const FIXTURE_WITH_DECLINE = {
  report: {
    fips: "48021",
    rows: [
      {
        rowId: "Elgin",
        checks: [
          { id: "railASourceReachable", name: "Rail A source + adapter reachable", outcome: "DECLINE", reason: "source unreachable, needs adapter: no Rail A layer wired for this row" },
          { id: "parcelLayerWired", name: "Rail C parcel layer wired in registry row", outcome: "PASS" },
        ],
        railPlan: { runs: ["Rail C parcel layer wired in registry row"], declines: ["Rail A source + adapter reachable"] },
      },
    ],
  },
  ledgerEvents: [
    {
      ts: "2026-08-03T00:00:00.000Z",
      fips: "48021",
      rowId: "Elgin",
      railOrCheck: "railASourceReachable",
      declineReason: "source unreachable, needs adapter: no Rail A layer wired for this row",
      defectClass: "ADAPTER-NEEDED",
    },
  ],
};

describe("preflight-and-report.mjs, buildPreflightIngestPayload", () => {
  it("marks a row with zero declines as status active in the rowMirror", () => {
    const { rowMirror } = buildPreflightIngestPayload(FIXTURE_ALL_PASS);
    expect(rowMirror).toHaveLength(1);
    expect(rowMirror[0]).toMatchObject({ rowId: "Bastrop", fips: "48021", countyName: "Bastrop", status: "active" });
  });

  it("marks a row with a decline as status pre-flight-pending in the rowMirror", () => {
    const { rowMirror } = buildPreflightIngestPayload(FIXTURE_WITH_DECLINE);
    expect(rowMirror).toHaveLength(1);
    expect(rowMirror[0]).toMatchObject({ rowId: "Elgin", fips: "48021", status: "pre-flight-pending" });
  });

  it("produces zero contract events for an all-pass report", () => {
    const { events } = buildPreflightIngestPayload(FIXTURE_ALL_PASS);
    expect(events).toHaveLength(0);
  });

  it("maps each ledgerEvent onto a contract-shaped event carrying both railOrCheck and checkId", () => {
    const { events } = buildPreflightIngestPayload(FIXTURE_WITH_DECLINE);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      ts: "2026-08-03T00:00:00.000Z",
      fips: "48021",
      rowId: "Elgin",
      railOrCheck: "railASourceReachable",
      checkId: "railASourceReachable",
      declineReason: "source unreachable, needs adapter: no Rail A layer wired for this row",
      defectClass: "ADAPTER-NEEDED",
    });
  });

  it("produces one gateSummary per row with correct pass/decline counts", () => {
    const { gateSummaries } = buildPreflightIngestPayload(FIXTURE_WITH_DECLINE);
    expect(gateSummaries).toHaveLength(1);
    expect(gateSummaries[0]).toMatchObject({ rowId: "Elgin", fips: "48021", passCount: 1, declineCount: 1 });
    expect(gateSummaries[0].checks).toHaveLength(2);
  });
});
