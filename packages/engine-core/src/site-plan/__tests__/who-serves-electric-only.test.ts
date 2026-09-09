/**
 * P-120 R-06 (2026-09-09 CTX-FAMILIES) -- `createElectricOnlyWhoServesResolver`
 * wraps the already-live HIFLD electric-provider read to answer `utilities`
 * for real. See the module's own doc for why this is electric-only rather
 * than the originally-specified water/sewer/electric cross-repo read.
 */
import { describe, expect, it } from "vitest";

import { createElectricOnlyWhoServesResolver, UTILITIES_ELECTRIC_ONLY_RESIDUAL } from "../who-serves-electric-only.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("createElectricOnlyWhoServesResolver", () => {
  it("measured, with the real HIFLD territory name as an 'electric' holder, and the water/sewer/water-district gap named in residual", async () => {
    const fetchImpl = (async () =>
      jsonResponse({ features: [{ attributes: { NAME: "BLUEBONNET ELECTRIC COOP, INC", TYPE: "COOPERATIVE" } }] })) as unknown as typeof fetch;
    const resolver = createElectricOnlyWhoServesResolver(fetchImpl);
    const result = await resolver.resolve({ latitude: 30.11148235687972, longitude: -97.31856839686304 });

    expect(result.status).toBe("measured");
    if (result.status === "measured") {
      expect(result.holders).toEqual([{ serviceKind: "electric", territoryName: "BLUEBONNET ELECTRIC COOP, INC" }]);
      expect(result.residual).toBe(UTILITIES_ELECTRIC_ONLY_RESIDUAL);
      expect(result.residual).toContain("water");
      expect(result.residual).toContain("sewer");
      expect(result.asOf).not.toBeNull();
    }
  });

  it("unmeasured with kind blocked-at-source when the HIFLD data genuinely does not reach this point -- never dressed as failed-this-run", async () => {
    const fetchImpl = (async () => jsonResponse({ features: [] })) as unknown as typeof fetch;
    const resolver = createElectricOnlyWhoServesResolver(fetchImpl);
    const result = await resolver.resolve({ latitude: 0, longitude: 0 });

    expect(result.status).toBe("unmeasured");
    if (result.status === "unmeasured") {
      expect(result.kind).toBe("blocked-at-source");
    }
  });

  it("unmeasured with kind failed-this-run when the live HIFLD read itself throws -- never collapsed into an honest declared absence", async () => {
    const fetchImpl = (async () => {
      throw new Error("network unreachable");
    }) as unknown as typeof fetch;
    const resolver = createElectricOnlyWhoServesResolver(fetchImpl);
    const result = await resolver.resolve({ latitude: 30.1, longitude: -97.3 });

    expect(result.status).toBe("unmeasured");
    if (result.status === "unmeasured") {
      expect(result.kind).toBe("failed-this-run");
      expect(result.basis).toContain("network unreachable");
    }
  });

  it("never fabricates water/sewer/water-district holders -- only electric is ever reported", async () => {
    const fetchImpl = (async () =>
      jsonResponse({ features: [{ attributes: { NAME: "CITY OF BASTROP - (TX)", TYPE: "MUNICIPAL" } }] })) as unknown as typeof fetch;
    const resolver = createElectricOnlyWhoServesResolver(fetchImpl);
    const result = await resolver.resolve({ latitude: 30.1, longitude: -97.3 });

    expect(result.status).toBe("measured");
    if (result.status === "measured") {
      expect(result.holders.map((h) => h.serviceKind)).toEqual(["electric"]);
      expect(result.holders.some((h) => h.serviceKind === "water" || h.serviceKind === "sewer" || h.serviceKind === "water-district")).toBe(false);
    }
  });
});
