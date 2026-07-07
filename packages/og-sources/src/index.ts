/**
 * @hauska-engine/og-sources — Oil & Gas data source adapters.
 *
 * This package houses adapters for O&G regulatory sources:
 * - RRC W-1 drilling permits (Texas)
 * - Production data (future)
 * - Completion records (future)
 *
 * Each adapter follows the domain-specific conventions for its source and
 * normalizes into @empressaio/atom-contract/og atom shapes.
 */

export * from "./adapters/rrc-w1/index.js";
