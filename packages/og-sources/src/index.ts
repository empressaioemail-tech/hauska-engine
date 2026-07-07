/**
 * @hauska-engine/og-sources — Oil & Gas data source adapters.
 *
 * This package houses adapters for O&G regulatory sources:
 * - RRC W-1 drilling permits (Texas)
 * - RRC PDQ production data (lease-level oil, well-level gas)
 * - RRC H-10 injection/disposal data (well-level)
 *
 * Each adapter follows the domain-specific conventions for its source and
 * normalizes into @empressaio/atom-contract/og atom shapes.
 */

export * from "./adapters/rrc-w1/index.js";
export * from "./adapters/rrc-pdq/index.js";
export * from "./adapters/rrc-h10/index.js";
