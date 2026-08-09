/**
 * Easement Status / TYPE / LABEL_DESC → easementClass (ingest spec §4.2).
 */

import type { UtilityEasementClass } from "@hauska-engine/atoms";

export function classifyEasementStatus(
  status: string | null | undefined,
): UtilityEasementClass {
  if (status == null || !String(status).trim()) return "unknown";
  const normalized = String(status).trim().toUpperCase();

  if (normalized.includes("DRAINAGE")) return "drainage";
  if (
    normalized === "UTILITY" ||
    normalized === "UE" ||
    normalized.includes("UTILITY")
  ) {
    return "utility";
  }
  if (
    normalized.includes("SIDEWALK") ||
    normalized.includes("PUE") ||
    normalized.includes("ACCESS")
  ) {
    return "ingress-egress";
  }
  if (normalized.includes("COMBINED")) return "combined";
  return "unknown";
}
