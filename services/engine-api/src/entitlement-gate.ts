/**
 * P152-ENTITLEMENT (OPS-23 wave 4, CP1 approved 2026-09-13).
 *
 * Resolves the access tier the engine's gated composers (currently only
 * `composeParcelReportFacts`'s `parcelOwnership` section — dollar rails +
 * owner info) should trust for one request, and answers the CP1-approved
 * allowlist question via `@hauska-engine/engine-core/site-plan`'s
 * `parcelOwnershipEntitledForTier`.
 *
 * TRUST ORDER (CP1 ruling: "the header is not trusted on its own where a
 * signed context exists"): when the gate-front SIGNED context
 * (`GATE_CONTEXT_SIGNING_KEY`, verified by `verifyGateContext` in
 * `gate-context-verify.ts`) is present and verified, its own `tier` claim
 * wins over the plain `x-hauska-access-tier` header — regardless of the
 * transport-level `gateContextMode` (log vs enforce). `gateContextMode`
 * only controls whether an INVALID/missing signature rejects the outer
 * request in `server.ts`'s `v1.use('*', ...)` middleware; it says nothing
 * about whether an already-verified payload's claims should be preferred
 * once present — those are orthogonal decisions.
 *
 * NOT LIVE-EXERCISED (stated precisely, per this session's own standing
 * "precise empirical claims" practice): as of 2026-09-13, no caller in
 * either `legacy-design-tools` or `hauska-engine` mints a signed gate
 * context (`x-hauska-gate-context` / `x-hauska-gate-signature`) — confirmed
 * by grep across both repos' outbound header-building code
 * (`engine-client.ts` in smartsite-mcp; nothing in the PE BFF's engine
 * callers either). This function's signed-context branch is real and
 * tested (see `__tests__/entitlement-gate.test.ts`) but presently unreached
 * by production traffic; every live call today resolves via the plain
 * header path below.
 *
 * The plain header path never needs to handle an unrecognized value: the
 * top-level middleware's `parseGateFrontHeaders` already validates
 * `accessTier` against `gateFrontContextSchema`'s `z.enum(GATE_FRONT_ACCESS_
 * TIERS)` and refuses (401) before any route — including this one — is
 * ever reached, so `gateFront.accessTier` is guaranteed to be one of the
 * four known values by the time this function runs.
 */
import type { GateFrontContext } from "./gate-front-context.js";
import type { GateContextPayload } from "./gate-context-verify.js";
import { GATE_FRONT_ACCESS_TIERS } from "./gate-front-context.js";
import type { CallerAccessTier } from "@hauska-engine/engine-core/site-plan";

const KNOWN_ACCESS_TIERS: ReadonlySet<string> = new Set<string>(GATE_FRONT_ACCESS_TIERS);

function asCallerAccessTier(value: string | null | undefined): CallerAccessTier | undefined {
  return value != null && KNOWN_ACCESS_TIERS.has(value) ? (value as CallerAccessTier) : undefined;
}

/**
 * Resolves the tier `composeParcelReportFacts` should trust for this
 * request. Always returns a concrete `CallerAccessTier` — never `undefined`
 * — so a route can pass the result straight through without a further
 * null-check: a verified-but-unrecognized signed `tier` claim (the ONLY way
 * an unrecognized string can reach this function, since the plain header is
 * already enum-validated) resolves to the REFUSING value `"public-free"`
 * rather than falling back to the weaker-trust plain header — a verified-
 * but-garbled signed claim is more suspicious than no signed context at
 * all, so this fails closed rather than silently trusting the header it was
 * just told to distrust.
 */
export function resolveCallerAccessTier(
  gateFront: GateFrontContext,
  gateContextVerified: GateContextPayload | undefined,
): CallerAccessTier {
  if (gateContextVerified) {
    return asCallerAccessTier(gateContextVerified.tier) ?? "public-free";
  }
  return gateFront.accessTier;
}
