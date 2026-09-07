/**
 * P-120 item 18 -- floodplain acreage in tract + FIRM panel citation.
 */

export { intersectionAreaAcres, ringAreaAcres, ringCentroid, type LngLat, type Ring } from "./geo.js";

export {
  queryFirmPanels,
  queryFloodHazardZones,
  type FirmPanelCitation,
  type NfhlZoneFeature,
} from "./nfhl-query.js";

export {
  resolveFloodplainFact,
  type FirmPanelResult,
  type FloodplainAcreageFacts,
  type FloodplainAcreageResult,
  type FloodplainFactResolution,
  type FloodplainZoneHit,
} from "./resolve-floodplain-acreage.js";
