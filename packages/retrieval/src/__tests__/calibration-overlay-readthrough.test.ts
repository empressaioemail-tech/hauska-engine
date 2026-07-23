import { createWidthedConfidence } from "@empressaio/atom-contract/read-contract";
import { describe, expect, it } from "vitest";

import { InMemoryCalibrationOverlayPort } from "@hauska-engine/engine-core/property-reasoning";
import {
  buildHaysEnvelopeProof,
  buildHaysSetbackRuleProof,
  buildHaysZoningFactProof,
  HAYS_GOLD_PARCEL,
  InMemoryStorage,
} from "@hauska-engine/storage";

import { HybridRetrieval } from "../index.js";

describe("property atom calibration overlay read-through (I-E / WDLL 3.10)", () => {
  it("changing overlay changes served calibratedConfidence; no labeling×district multiply", async () => {
    const storage = new InMemoryStorage();
    await storage.writePropertyAtom(buildHaysZoningFactProof());
    await storage.writePropertyAtom(buildHaysSetbackRuleProof());
    await storage.writePropertyAtom(buildHaysEnvelopeProof());

    const overlay = new InMemoryCalibrationOverlayPort();
    const retrieval = new HybridRetrieval(storage, {
      calibrationOverlay: overlay,
    });

    const before = await retrieval.getPropertyAtomChain(HAYS_GOLD_PARCEL);
    const beforeCal =
      before.buildableEnvelope &&
      "readContract" in before.buildableEnvelope
        ? (
            before.buildableEnvelope as {
              readContract: {
                axes: {
                  calibratedConfidence: { estimate: number; provenance: string };
                  assertedConfidence: { estimate: number };
                };
              };
            }
          ).readContract.axes
        : null;
    expect(beforeCal?.assertedConfidence.estimate).toBe(0.88);
    // No overlay row → asserted-provenance placeholder stays (honest empty earn).
    expect(beforeCal?.calibratedConfidence.estimate).toBe(0.88);
    expect(beforeCal?.calibratedConfidence.provenance).toBe("asserted");

    overlay.seed(HAYS_GOLD_PARCEL, "hays_tx_proof", {
      calibratedConfidence: createWidthedConfidence({
        estimate: 0.71,
        n: 3,
        intervalWidth: 0.2,
        provenance: "backtest",
      }),
    });

    const after = await retrieval.getPropertyAtomChain(HAYS_GOLD_PARCEL);
    const afterCal = (
      after.buildableEnvelope as {
        readContract: {
          axes: {
            calibratedConfidence: {
              estimate: number;
              provenance: string;
              n: number;
            };
            assertedConfidence: { estimate: number };
          };
        };
      }
    ).readContract.axes;
    expect(afterCal.assertedConfidence.estimate).toBe(0.88);
    expect(afterCal.calibratedConfidence.estimate).toBe(0.71);
    expect(afterCal.calibratedConfidence.provenance).toBe("backtest");
    expect(afterCal.calibratedConfidence.n).toBe(3);

    // Anti-multiply: calibrated is overlay value, not labeling×district product.
    const zoningAsserted = (
      after.zoningFact as {
        readContract: { axes: { assertedConfidence: { estimate: number } } };
      }
    ).readContract.axes.assertedConfidence.estimate;
    const setbackAsserted = (
      after.setbackRule as {
        readContract: { axes: { assertedConfidence: { estimate: number } } };
      }
    ).readContract.axes.assertedConfidence.estimate;
    expect(afterCal.calibratedConfidence.estimate).not.toBeCloseTo(
      zoningAsserted * setbackAsserted,
      5,
    );

    const byDid = await retrieval.getAtom({
      atomDid: "did:hauska:buildable-envelope:48209:156346",
    });
    expect(
      (
        byDid.atom as {
          readContract: {
            axes: { calibratedConfidence: { estimate: number } };
          };
        }
      ).readContract.axes.calibratedConfidence.estimate,
    ).toBe(0.71);
  });

  it("absent overlay leaves Bexar / unseeded parcels on asserted placeholder", async () => {
    const storage = new InMemoryStorage();
    await storage.writePropertyAtom(buildHaysEnvelopeProof());
    const overlay = new InMemoryCalibrationOverlayPort();
    // Seed a different parcel only.
    overlay.seed("48000:NOPE", "hays_tx_proof", {
      calibratedConfidence: createWidthedConfidence({
        estimate: 0.55,
        n: 1,
        intervalWidth: 0.2,
        provenance: "seed",
      }),
    });
    const retrieval = new HybridRetrieval(storage, {
      calibrationOverlay: overlay,
    });
    const chain = await retrieval.getPropertyAtomChain(HAYS_GOLD_PARCEL);
    const cal = (
      chain.buildableEnvelope as {
        readContract: {
          axes: { calibratedConfidence: { estimate: number; provenance: string } };
        };
      }
    ).readContract.axes.calibratedConfidence;
    expect(cal.estimate).toBe(0.88);
    expect(cal.provenance).toBe("asserted");
  });
});
