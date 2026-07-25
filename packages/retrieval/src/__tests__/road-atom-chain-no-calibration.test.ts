import { describe, expect, it } from "vitest";

import type { CalibrationOverlayPort } from "@hauska-engine/engine-core/property-reasoning";
import {
  bastropRoadIntakeDescriptor,
  emitRoadNode,
  parseOsmWayElement,
} from "@hauska-engine/engine-core/road-intake";
import { InMemoryStorage } from "@hauska-engine/storage";

import { HybridRetrieval } from "../index.js";

const SPRING_STREET_ELEMENT = {
  type: "way" as const,
  id: 123456789,
  tags: { highway: "residential", name: "Spring Street" },
  geometry: [
    { lat: 30.1102, lon: -97.3188 },
    { lat: 30.1105, lon: -97.3182 },
  ],
};

/** Mimics postgres `UNDEFINED_VALUE` when atom_id is undefined (R1.1 live failure). */
const strictPgLikeOverlay: CalibrationOverlayPort = {
  async findCalibratedConfidence(atomId, jurisdictionTenant) {
    if (atomId === undefined || jurisdictionTenant === undefined) {
      throw new Error("UNDEFINED_VALUE: Undefined values are not allowed");
    }
    return null;
  },
};

describe("getRoadAtomChain — no property calibration overlay (27c WDLL 3 inspect)", () => {
  it("succeeds with overlay configured even though road atoms lack parcelNodeId", async () => {
    const storage = new InMemoryStorage();
    const descriptor = bastropRoadIntakeDescriptor();
    const obs = parseOsmWayElement(SPRING_STREET_ELEMENT, "2026-07-25T12:00:00.000Z");
    expect(obs).not.toBeNull();
    const atom = emitRoadNode(descriptor, obs!);
    await storage.writeRoadAtom(atom);

    const retrieval = new HybridRetrieval(storage, {
      calibrationOverlay: strictPgLikeOverlay,
    });
    const chain = await retrieval.getRoadAtomChain("48021:road:123456789");

    expect(chain.roadNodeId).toBe("48021:road:123456789");
    expect(chain.roadNode).not.toBeNull();
    expect(chain.atoms).toHaveLength(1);
    expect((chain.roadNode as { displayName?: string }).displayName).toBe(
      "Spring Street",
    );
    const asserted = (
      chain.roadNode as {
        readContract: {
          axes: { assertedConfidence: { estimate: number; provenance: string } };
        };
      }
    ).readContract.axes.assertedConfidence;
    expect(asserted.provenance).toBe("asserted");
  });
});
