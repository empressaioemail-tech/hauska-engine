/**
 * Central TX engine corpus keys — mirrors legacy-design-tools
 * `lib/codes/src/centralTexasPilot.ts` ENGINE_CORPUS_JURISDICTION_KEYS.
 */
export const ENGINE_CORPUS_JURISDICTION_KEYS = [
  "austin_tx",
  "bastrop_county_tx",
  "bastrop_tx",
  "boerne_tx",
  "brownsville_tx",
  "cedar_hill_tx",
  "converse_tx",
  "copperas_cove_tx",
  "crowley_tx",
  "dripping_springs_tx",
  "el_paso_tx",
  "elgin_tx",
  "georgetown_tx",
  "grand_county_ut",
  "hutto_tx",
  "keller_tx",
  "killeen_tx",
  "lago_vista_tx",
  "leander_tx",
  "live_oak_tx",
  "lockhart_tx",
  "manor_tx",
  "mission_tx",
  "new_braunfels_tx",
  "pasadena_tx",
  "plano_tx",
  "rollingwood_tx",
  "round_rock_tx",
  "saginaw_tx",
  "san_antonio_tx",
  "schertz_tx",
  "sugar_land_tx",
  "taylor_tx",
  "watauga_tx",
  "wimberley_tx",
] as const;

/** PB-001 Neon warmup pilot batch (priority order). */
export const NEON_WARMUP_PILOT_KEYS = [
  "round_rock_tx",
  "georgetown_tx",
  "new_braunfels_tx",
  "leander_tx",
  "hutto_tx",
  "austin_tx",
] as const;

export type NeonWarmupPilotKey = (typeof NEON_WARMUP_PILOT_KEYS)[number];
