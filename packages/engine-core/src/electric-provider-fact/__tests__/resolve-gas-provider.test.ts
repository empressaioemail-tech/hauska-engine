/**
 * item 21 (gas) -- always a structural absence, never a live lookup. See
 * `_decisions/2026-09-03_gas_utility_service_rail_closed_unacquirable.md`.
 */
import { describe, expect, it } from "vitest";

import { resolveGasProviderFact } from "../resolve-gas-provider.js";

describe("resolveGasProviderFact", () => {
  it("is always a structural, cited absence -- never present, never a per-call variation", () => {
    const a = resolveGasProviderFact();
    const b = resolveGasProviderFact();
    expect(a.status).toBe("absent");
    expect(a.structural).toBe(true);
    expect(a.reason).toContain("2026-09-03_gas_utility_service_rail_closed_unacquirable");
    expect(a).toEqual(b);
  });

  it("takes no arguments -- it is not a lookup that could ever find gas coverage", () => {
    expect(resolveGasProviderFact.length).toBe(0);
  });
});
