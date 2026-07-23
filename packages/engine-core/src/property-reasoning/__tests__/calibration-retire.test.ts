import { createWidthedConfidence } from "@empressaio/atom-contract/read-contract";
import { describe, expect, it } from "vitest";

import {
  InMemoryCalibrationOverlayPort,
  resolveCalibratedConfidence,
} from "../calibration-overlay.js";
import { flipPropertyAtomRetired, successorPropertyAtomIdentity } from "../retire.js";
import { emitZoningFact } from "../emit-zoning-fact.js";
import type { JurisdictionDescriptor } from "../types.js";

import cookStub from "../fixtures/descriptors/cook_county_il_stub.json" with { type: "json" };

describe("calibration overlay read-through (WDLL 3.10)", () => {
  it("resolves calibrated axis from overlay keyed by atom_id + jurisdiction_tenant", async () => {
    const overlay = new InMemoryCalibrationOverlayPort();
    const atomId = "17031:PARCEL1";
    const tenant = "cook_county_il_stub";
    const calibrated = createWidthedConfidence({
      estimate: 0.82,
      n: 12,
      intervalWidth: 0.08,
      provenance: "live",
    });
    overlay.seed(atomId, tenant, { calibratedConfidence: calibrated });

    const asserted = createWidthedConfidence({
      estimate: 0.9,
      n: 0,
      intervalWidth: 0.12,
      provenance: "asserted",
    });
    const resolved = await resolveCalibratedConfidence({
      atomId,
      jurisdictionTenant: tenant,
      assertedBaseline: asserted,
      overlayPort: overlay,
    });
    expect(resolved.estimate).toBe(0.82);
    expect(resolved.provenance).toBe("live");
  });

  it("no overlay row keeps asserted baseline (honest empty earn)", async () => {
    const overlay = new InMemoryCalibrationOverlayPort();
    const asserted = createWidthedConfidence({
      estimate: 0.88,
      n: 0,
      intervalWidth: 0.15,
      provenance: "asserted",
    });
    const resolved = await resolveCalibratedConfidence({
      atomId: "48209:156346",
      jurisdictionTenant: "hays_tx_proof",
      assertedBaseline: asserted,
      overlayPort: overlay,
    });
    expect(resolved.estimate).toBe(0.88);
    expect(resolved.provenance).toBe("asserted");
  });
});

describe("retire-not-overwrite", () => {
  it("flips status and assigns successor version identity", () => {
    const descriptor = cookStub as JurisdictionDescriptor;
    const parcelNodeId = `${descriptor.parcelFips}:RETIRE-001`;
    const active = emitZoningFact(descriptor, {
      parcelNodeId,
      districtCode: "RS-1",
      matchBasis: "exact",
      sourceCitation: "stub",
      extractedAt: "2026-07-23T12:00:00.000Z",
    });
    expect(active.entityId).toBe(parcelNodeId);
    const retired = flipPropertyAtomRetired(active);
    expect(retired.status).toBe("retired");
    const next = successorPropertyAtomIdentity(active);
    expect(next.entityId).toBe(`${parcelNodeId}/v2`);
    expect(next.supersedesEntityId).toBe(active.entityId);
  });
});
