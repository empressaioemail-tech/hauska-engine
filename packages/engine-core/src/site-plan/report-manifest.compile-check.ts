/**
 * R4's compiler-refusal proof, checked for real by `pnpm typecheck` (`tsc
 * --noEmit`), which — unlike `vitest run` — actually type-checks this file.
 * `__tests__/**` is excluded from `tsconfig.json`'s `include`, and vitest's
 * transform strips types without checking them, so a `@ts-expect-error`
 * fixture placed in a test file would never be verified by anything. This
 * file lives in `src/` proper (still excluded from every runtime import
 * graph — nothing imports it) specifically so `tsc` sees it.
 *
 * `@ts-expect-error` itself fails to compile when the following line does
 * NOT produce an error, so this file only stays green while `ReportManifest`
 * genuinely has no index signature and no `facts`-shaped member. Loosen the
 * type and `pnpm --filter @hauska-engine/engine-core typecheck` breaks here.
 */
import type { ReportManifest } from "./report-manifest.js";

// A product manifest naming its own fact value. This must fail to compile —
// the manifest can name a section, never carry the section's data — or the
// disagreement class R4 exists to close (two products asserting two values
// for one fact) is reachable again. TS reports an excess-property error on
// the offending property's own line, not the declaration line, so the
// suppression comment sits directly above it.
const _attemptedFactValueOnManifest: ReportManifest = {
  product: "feasibility",
  sections: ["package"],
  // @ts-expect-error — ReportManifest has no index signature; a product
  // cannot smuggle a fact value onto its own manifest literal.
  zoningDistrict: "R-6",
};
void _attemptedFactValueOnManifest;
