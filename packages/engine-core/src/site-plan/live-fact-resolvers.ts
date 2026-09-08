import { resolveFloodplainFact } from "../floodplain-acreage-fact/index.js";
import { resolveSoilFact } from "../soil-fact/index.js";
import {
  resolveElectricProviderFact,
  resolveGasProviderFact,
} from "../electric-provider-fact/index.js";
import type { ParcelReportFactResolvers } from "./report-model.js";

/**
 * The live wiring for the three fact families PR #404 shipped.
 *
 * These exist as a named constant rather than as defaults inside
 * `composeParcelReportFacts` for one reason: they are live network reads
 * against FEMA NFHL, USDA SSURGO and HIFLD. Defaulting them on would make
 * every unit test that composes a report reach the internet, which is how a
 * suite becomes slow, flaky, and quietly dependent on someone else's uptime.
 *
 * The cost of injecting instead of defaulting is that a caller can forget to
 * pass them, and the families would then be missing from a report with nobody
 * noticing. That is the dormant-mechanism failure this program keeps finding,
 * so it is closed on the other side: an omitted resolver reports
 * `out-of-scope` with a reason naming that it was not requested, rather than
 * the section silently not existing. Absent is visible; unreached is not.
 */
export const LIVE_PARCEL_REPORT_FACT_RESOLVERS: ParcelReportFactResolvers = {
  floodplain: (ring) => resolveFloodplainFact([...ring] as Array<[number, number]>),
  soil: (point) => resolveSoilFact(point),
  electricProvider: (point) => resolveElectricProviderFact(point),
  gasProvider: () => resolveGasProviderFact(),
};
