/**
 * P-120 item 21 (gas half) -- gas provider identification.
 *
 * `_decisions/2026-09-03_gas_utility_service_rail_closed_unacquirable.md`
 * (operator ruling, 2026-09-03): the gas sub-row of the utilityService rail
 * is PERMANENTLY UNACCOUNTED for Texas. PARCEL-SCOUT-GIS found no
 * acquisition path by any mechanism -- Texas gas distribution is
 * franchise-based (municipality + Railroad Commission), not a
 * certificated-territory/polygon model the way water/sewer/electric are, so
 * no GIS layer of gas retail territories exists to query, staged or live.
 * The ruling is explicit that this stays a REAL, COUNTED, UNACCOUNTED cell
 * on every parcel forever (not demoted to not-applicable, not re-scouted),
 * reversible only if a materially different sourcing mechanism appears.
 *
 * So this resolver never queries anything: gas is always the same honest,
 * structural absence, never a per-parcel "not found this time" that invites
 * a retry. If the decision is ever reversed, this function is where that
 * reversal lands.
 */
export type GasProviderResult = { status: "absent"; reason: string; structural: true };

const GAS_STRUCTURAL_ABSENCE_REASON =
  "Gas retail-territory data has no acquisition path in Texas (franchise-based distribution, not certificated-territory GIS); ruled permanently unaccounted 2026-09-03, decisions/2026-09-03_gas_utility_service_rail_closed_unacquirable.md.";

export function resolveGasProviderFact(): GasProviderResult {
  return { status: "absent", reason: GAS_STRUCTURAL_ABSENCE_REASON, structural: true };
}
