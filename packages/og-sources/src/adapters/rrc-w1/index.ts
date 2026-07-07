/**
 * RRC W-1 Drilling Permit adapter — public interface.
 *
 * This adapter fetches and normalizes W-1 drilling permits from the RRC's
 * public EWA query surface into well atoms per @empressaio/atom-contract/og.
 *
 * Usage:
 *   import { fetchW1Permits, normalizeW1Permits } from "@hauska-engine/og-sources/adapters/rrc-w1";
 *
 *   const result = await fetchW1Permits({
 *     county: "REEVES",
 *     fromDate: "2022-01-01",
 *     toDate: "2026-07-07",
 *   });
 *   const wells = normalizeW1Permits(result);
 */

export * from "./types.js";
export * from "./client.js";
export * from "./normalize.js";

import type { RrcW1AdapterCapabilities } from "./types.js";

/**
 * Adapter capabilities descriptor. Surfaced for discovery and routing.
 */
export const RRC_W1_ADAPTER_CAPABILITIES: RrcW1AdapterCapabilities = {
  name: "rrc-w1",
  displayName: "RRC W-1 Drilling Permits",
  sourceFamilies: ["oil-gas", "rrc", "texas"],
  supportsCountyFilter: true,
  supportsCompletionTypeFilter: true,
};
