/**
 * Program config for parcel-record — no hardcoded jurisdiction in the template.
 * Callers supply county FIPS lists and program-level population guards.
 */

export interface ParcelRecordProgramConfig {
  /** Counties in the active proof/program wave (e.g. six CTX counties). */
  programCountyFips: readonly string[];
  /**
   * Measured unincorporated parcel count across programCountyFips — used ONLY
   * to guard against stamping not-applicable outside the containment population,
   * never to scale or invent per-parcel incorporation.
   */
  unincorporatedZoningPopulationProgram: number;
}

export function createParcelRecordProgramConfig(
  input: ParcelRecordProgramConfig,
): ParcelRecordProgramConfig {
  if (input.programCountyFips.length === 0) {
    throw new Error("programCountyFips must not be empty");
  }
  if (input.unincorporatedZoningPopulationProgram < 0) {
    throw new Error("unincorporatedZoningPopulationProgram must be non-negative");
  }
  return Object.freeze({ ...input });
}

/** Texas CTX six-county defaults — supplied by caller, not embedded in types. */
export function texasCtxProgramConfig(
  overrides: Partial<ParcelRecordProgramConfig> = {},
): ParcelRecordProgramConfig {
  return createParcelRecordProgramConfig({
    programCountyFips: overrides.programCountyFips ?? [
      "48021",
      "48055",
      "48209",
      "48309",
      "48453",
      "48491",
    ],
    unincorporatedZoningPopulationProgram:
      overrides.unincorporatedZoningPopulationProgram ?? 370_289,
  });
}

/**
 * Permit jurisdiction sourcing registry — unsourced vs sourced is explicit.
 * Bastrop (bastrop_tx) is intentionally absent from sourced: SmartCity route off limits.
 */
export interface PermitJurisdictionEntry {
  jurisdictionKey: string;
  countyFips: string;
  /** When true, parcels may receive empty-set or rows after acquisition. */
  sourced: boolean;
}

export interface PermitSourcingConfig {
  jurisdictions: readonly PermitJurisdictionEntry[];
}

export function createPermitSourcingConfig(
  jurisdictions: readonly PermitJurisdictionEntry[],
): PermitSourcingConfig {
  if (jurisdictions.length === 0) {
    throw new Error("permit sourcing config must name at least one jurisdiction");
  }
  const keys = new Set<string>();
  for (const j of jurisdictions) {
    if (keys.has(j.jurisdictionKey)) {
      throw new Error(`duplicate permit jurisdiction key: ${j.jurisdictionKey}`);
    }
    keys.add(j.jurisdictionKey);
  }
  return Object.freeze({ jurisdictions: [...jurisdictions] });
}

/** Default CTX registry: all unsourced until an acquisition card marks one sourced. */
export function texasCtxPermitSourcingUnsourced(): PermitSourcingConfig {
  return createPermitSourcingConfig([
    { jurisdictionKey: "bastrop_tx", countyFips: "48021", sourced: false },
    { jurisdictionKey: "austin_tx", countyFips: "48453", sourced: false },
    { jurisdictionKey: "hays_tx", countyFips: "48209", sourced: false },
    { jurisdictionKey: "mclennan_tx", countyFips: "48309", sourced: false },
    { jurisdictionKey: "travis_tx", countyFips: "48453", sourced: false },
    { jurisdictionKey: "williamson_tx", countyFips: "48491", sourced: false },
  ]);
}

/** After Austin SODA acquisition on PERMITS-FIELD card. */
export function texasCtxPermitSourcingWithAustin(): PermitSourcingConfig {
  return createPermitSourcingConfig([
    { jurisdictionKey: "bastrop_tx", countyFips: "48021", sourced: false },
    { jurisdictionKey: "austin_tx", countyFips: "48453", sourced: true },
    { jurisdictionKey: "hays_tx", countyFips: "48209", sourced: false },
    { jurisdictionKey: "mclennan_tx", countyFips: "48309", sourced: false },
    { jurisdictionKey: "williamson_tx", countyFips: "48491", sourced: false },
  ]);
}

export function isPermitJurisdictionSourced(
  config: PermitSourcingConfig,
  jurisdictionKey: string,
): boolean {
  const entry = config.jurisdictions.find((j) => j.jurisdictionKey === jurisdictionKey);
  return entry?.sourced === true;
}
