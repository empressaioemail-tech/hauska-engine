/**
 * P-120 R-06 (2026-09-09 CTX-FAMILIES) — live wiring for `utilities`.
 *
 * `WhoServesResolver` (feasibility-model.ts) was specified against a
 * cross-repo `legacy-design-tools GET /api/who-serves` endpoint backed by an
 * internal water/sewer/electric territory staging table. Neither exists:
 * confirmed by a direct read of the `legacy-design-tools` checkout (no
 * `who-serves` route anywhere in that repo) and by PR #404's own CP1 record
 * (the `tx_utility_territory_staging` table's migration was never committed
 * anywhere, and this lane holds no credential to it regardless). That is a
 * missing build, not a missing connection, and it is out of this lane's
 * scope to build one — no writes to `legacy-design-tools`, no new database
 * migration from a fact-family wiring lane.
 *
 * This wraps the already-shipped, already-verified-live HIFLD electric-
 * retail-territory read (`electric-provider-fact/`, the same source
 * `electricProvider` uses) to answer `utilities` for real on the one
 * utility type this repo can actually check today. Water, sewer and
 * water-district territory are named, explicitly, in `residual` — never
 * silently omitted, never defaulted to an empty or fabricated value. A real,
 * partial answer, honestly labeled partial, per `ENFORCEMENT.md`'s
 * degradation rule ("degradation is permitted only when declared").
 */
import { resolveElectricProviderFact } from "../electric-provider-fact/resolve-electric-provider.js";
import type { WhoServesResolver } from "./feasibility-model.js";

export const UTILITIES_ELECTRIC_ONLY_RESIDUAL =
  "Only electric retail territory is checked here. Water, sewer and water-district service territory " +
  "have no acquisition path in this repo yet (no legacy-design-tools who-serves endpoint, no internal " +
  "utility-territory table — see CP1, 2026-09-09 CTX-FAMILIES). Confirm all four directly with the " +
  "county or utility before assuming capacity.";

/** Real, live resolver backed by the HIFLD electric-retail-territory read. */
export function createElectricOnlyWhoServesResolver(fetchImpl?: typeof fetch): WhoServesResolver {
  return {
    async resolve(point) {
      let result;
      try {
        result = await resolveElectricProviderFact(point, fetchImpl);
      } catch (error) {
        return {
          status: "unmeasured",
          kind: "failed-this-run",
          basis: `Electric-territory read failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      if (result.status !== "present") {
        return { status: "unmeasured", kind: result.kind, basis: result.reason };
      }
      return {
        status: "measured",
        holders: result.facts.candidates.map((candidate) => ({
          serviceKind: "electric" as const,
          territoryName: candidate.name,
        })),
        residual: UTILITIES_ELECTRIC_ONLY_RESIDUAL,
        asOf: new Date().toISOString(),
      };
    },
  };
}
