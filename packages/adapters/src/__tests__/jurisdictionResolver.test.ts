import { describe, expect, it } from "vitest";
import { resolveJurisdiction } from "../jurisdictionResolver";

describe("resolveJurisdiction", () => {
  it("resolves Moab UT → grand-county-ut + utah", () => {
    expect(
      resolveJurisdiction({
        jurisdictionCity: "Moab",
        jurisdictionState: "UT",
      }),
    ).toEqual({ stateKey: "utah", localKey: "grand-county-ut" });
  });

  it("resolves Salmon ID → lemhi-county-id + idaho", () => {
    expect(
      resolveJurisdiction({
        jurisdictionCity: "Salmon",
        jurisdictionState: "Idaho",
      }),
    ).toEqual({ stateKey: "idaho", localKey: "lemhi-county-id" });
  });

  it("resolves Bastrop TX → bastrop-tx + texas", () => {
    expect(
      resolveJurisdiction({
        jurisdictionCity: "Bastrop",
        jurisdictionState: "TX",
      }),
    ).toEqual({ stateKey: "texas", localKey: "bastrop-tx" });
  });

  it("falls back to the freeform jurisdiction string when city/state cols are blank", () => {
    expect(
      resolveJurisdiction({ jurisdiction: "Moab, UT 84532" }),
    ).toEqual({ stateKey: "utah", localKey: "grand-county-ut" });
  });

  it("scans the address line for a known city/state pair when no other field matches", () => {
    expect(
      resolveJurisdiction({
        address: "123 Main St, Bastrop, TX 78602",
      }),
    ).toEqual({ stateKey: "texas", localKey: "bastrop-tx" });
  });

  it("returns the state-only resolution when only the state is known", () => {
    expect(
      resolveJurisdiction({ jurisdictionState: "Utah" }),
    ).toEqual({ stateKey: "utah", localKey: null });
  });

  it("returns null/null when nothing matches", () => {
    expect(
      resolveJurisdiction({
        jurisdictionCity: "Springfield",
        jurisdictionState: "MA",
      }),
    ).toEqual({ stateKey: null, localKey: null });
  });
});
