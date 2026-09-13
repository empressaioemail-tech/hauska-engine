import { describe, expect, it } from "vitest";

import { resolveCallerAccessTier } from "../entitlement-gate.js";
import type { GateFrontContext } from "../gate-front-context.js";
import type { GateContextPayload } from "../gate-context-verify.js";

/**
 * P152-ENTITLEMENT (OPS-23 wave 4, CP1 approved 2026-09-13).
 *
 * `resolveCallerAccessTier` is the ONE place that decides which tier
 * `composeParcelReportFacts` trusts for a request. Two directions matter,
 * per the mission's own required negative tests: an unentitled call gets
 * the refusing tier, an entitled call gets the granting tier — plus the
 * CP1 ruling this function exists to implement: "the header is not trusted
 * on its own where a signed context exists."
 */

function gateFront(accessTier: GateFrontContext["accessTier"]): GateFrontContext {
  return {
    gateCredentialId: "cred-1",
    product: "cortex",
    tenantId: "tenant-1",
    packageId: "feasibility-export",
    accessTier,
    requestId: "req-1",
  };
}

function signedPayload(tier: string): GateContextPayload {
  return {
    v: 1,
    tenant: "tenant-1",
    product: "cortex",
    tier,
    keyId: "key-1",
    platformInternal: false,
    iat: 0,
    exp: 0,
  };
}

describe("resolveCallerAccessTier", () => {
  it("no signed context: resolves from the plain gate-front header", () => {
    expect(resolveCallerAccessTier(gateFront("public-paid"), undefined)).toBe("public-paid");
    expect(resolveCallerAccessTier(gateFront("public-free"), undefined)).toBe("public-free");
  });

  it("valid signed context present: its tier WINS over a disagreeing plain header — grant direction", () => {
    // The plain header claims public-free (would refuse); the verified
    // signed context says public-paid (would grant). Signed wins: granted.
    const resolved = resolveCallerAccessTier(gateFront("public-free"), signedPayload("public-paid"));
    expect(resolved).toBe("public-paid");
  });

  it("valid signed context present: its tier WINS over a disagreeing plain header — refuse direction", () => {
    // The plain header claims public-paid (would grant); the verified
    // signed context says public-free (would refuse). Signed wins: refused.
    const resolved = resolveCallerAccessTier(gateFront("public-paid"), signedPayload("public-free"));
    expect(resolved).toBe("public-free");
  });

  it("a verified-but-unrecognized signed tier claim fails closed to public-free, never falls back to the plain header", () => {
    // The plain header claims public-paid (would grant); the signed
    // context verified successfully but carries a tier value outside the
    // four known ones (a future/foreign vocabulary, or a bug upstream).
    // This is MORE suspicious than no signed context at all, so it must
    // refuse rather than silently trust the weaker-signal header it was
    // just told to distrust.
    const resolved = resolveCallerAccessTier(gateFront("public-paid"), signedPayload("some-future-tier"));
    expect(resolved).toBe("public-free");
  });

  it("platform-internal and tenant-private pass through unchanged from either path", () => {
    expect(resolveCallerAccessTier(gateFront("platform-internal"), undefined)).toBe("platform-internal");
    expect(resolveCallerAccessTier(gateFront("public-free"), signedPayload("tenant-private"))).toBe(
      "tenant-private",
    );
  });
});
