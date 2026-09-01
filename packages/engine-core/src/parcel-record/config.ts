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
