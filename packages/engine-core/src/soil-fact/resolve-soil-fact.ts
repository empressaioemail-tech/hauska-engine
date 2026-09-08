/**
 * P-120 item 20 -- soil type (USDA SSURGO).
 *
 * `@hauska-engine/adapters` already ships a working, live, per-point SSURGO
 * adapter (`usda:ssurgo-soils`, `packages/adapters/src/federal/usda-ssurgo.ts`)
 * -- queried live 2026-09-07 for both real Bastrop test parcels and returned
 * "Bosque loam, 0 to 1 percent slopes, occasionally flooded", well drained,
 * hydrologic group B, which independently corroborates the same parcels'
 * FEMA 0.2%-annual-chance shaded-X hit (`../floodplain-acreage-fact`) --
 * consistent live data from two unrelated federal sources.
 *
 * `packages/adapters` is CTX-B's package for the duration of this sprint, so
 * this module does not touch it; it consumes the adapter through the
 * already-public `FEDERAL_ADAPTERS` + `runAdapters` surface (the adapter's
 * own subpath, `./federal/usda-ssurgo`, is not in the package's export map,
 * unlike `./federal/fema-nfhl` which `site-plan/author.ts` already imports
 * directly -- so this resolver looks the adapter up by key instead of a
 * direct import).
 */
import {
  FEDERAL_ADAPTERS,
  runAdapters,
  type AdapterRunOutcome,
} from "@hauska-engine/adapters";
import type { AbsenceKind } from "../site-plan/feasibility-model.js";

const SSURGO_ADAPTER_KEY = "usda:ssurgo-soils";

/** Mirrors the payload shape `usdaSsurgoSoilsAdapter` actually returns. */
interface SsurgoAdapterPayload {
  kind?: unknown;
  degraded?: unknown;
  degradationReasons?: unknown;
  mukey?: unknown;
  musym?: unknown;
  muname?: unknown;
  areaSymbol?: unknown;
  drainageClass?: unknown;
  hydrologicSoilGroup?: unknown;
  dominantComponent?: unknown;
  slopePercentRounded?: unknown;
  depthToBedrockMinFeet?: unknown;
  waterTableDepthMinFeet?: unknown;
  shrinkSwellPotential?: unknown;
}

export interface SoilFacts {
  mukey: string | null;
  musym: string | null;
  muname: string | null;
  areaSymbol: string | null;
  drainageClass: string | null;
  hydrologicSoilGroup: string | null;
  dominantComponent: string | null;
  slopePercentRounded: number | null;
  depthToBedrockMinFeet: number | null;
  waterTableDepthMinFeet: number | null;
  shrinkSwellPotential: string | null;
  sourceCitation: string;
  /** True when one of the two USDA upstreams (gSSURGO polygon / SDA tabular)
   * failed but the other answered -- the fact is still present, just built
   * from a partial read. Never silently hidden. */
  degraded: boolean;
  degradationReasons: string[];
}

export type SoilFactResult = { status: "present"; facts: SoilFacts } | { status: "absent"; kind: AbsenceKind; reason: string };

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export async function resolveSoilFact(
  point: { latitude: number; longitude: number },
  fetchImpl?: typeof fetch,
  signal?: AbortSignal,
): Promise<SoilFactResult> {
  const adapter = FEDERAL_ADAPTERS.find((a) => a.adapterKey === SSURGO_ADAPTER_KEY);
  if (!adapter) {
    return {
      status: "absent",
      kind: "failed-this-run",
      reason: `USDA SSURGO adapter ("${SSURGO_ADAPTER_KEY}") is not registered in @hauska-engine/adapters' FEDERAL_ADAPTERS.`,
    };
  }

  let outcomes: AdapterRunOutcome[];
  try {
    outcomes = await runAdapters({
      adapters: [adapter],
      context: {
        parcel: { latitude: point.latitude, longitude: point.longitude },
        jurisdiction: { stateKey: null, localKey: null },
        fetchImpl,
        signal,
      },
    });
  } catch (error) {
    return {
      status: "absent",
      kind: "failed-this-run",
      reason: `USDA SSURGO adapter run threw: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const outcome = outcomes[0];
  if (!outcome) {
    return { status: "absent", kind: "failed-this-run", reason: "USDA SSURGO adapter run produced no outcome." };
  }
  if (outcome.status !== "ok" || !outcome.result) {
    return {
      status: "absent",
      kind: "failed-this-run",
      reason: outcome.error?.message ?? `USDA SSURGO adapter returned status "${outcome.status}" with no message.`,
    };
  }

  const payload = outcome.result.payload as SsurgoAdapterPayload;
  return {
    status: "present",
    facts: {
      mukey: str(payload.mukey),
      musym: str(payload.musym),
      muname: str(payload.muname),
      areaSymbol: str(payload.areaSymbol),
      drainageClass: str(payload.drainageClass),
      hydrologicSoilGroup: str(payload.hydrologicSoilGroup),
      dominantComponent: str(payload.dominantComponent),
      slopePercentRounded: num(payload.slopePercentRounded),
      depthToBedrockMinFeet: num(payload.depthToBedrockMinFeet),
      waterTableDepthMinFeet: num(payload.waterTableDepthMinFeet),
      shrinkSwellPotential: str(payload.shrinkSwellPotential),
      sourceCitation: outcome.result.provider,
      degraded: payload.degraded === true,
      degradationReasons: Array.isArray(payload.degradationReasons)
        ? payload.degradationReasons.filter((r): r is string => typeof r === "string")
        : [],
    },
  };
}
