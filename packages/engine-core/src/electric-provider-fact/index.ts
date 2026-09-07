/**
 * P-120 item 21 -- electric and gas provider identification.
 */
export { queryHifldElectricTerritory, type HifldElectricTerritory } from "./hifld-query.js";
export {
  resolveElectricProviderFact,
  type ElectricProviderFacts,
  type ElectricProviderResult,
} from "./resolve-electric-provider.js";
export { resolveGasProviderFact, type GasProviderResult } from "./resolve-gas-provider.js";
