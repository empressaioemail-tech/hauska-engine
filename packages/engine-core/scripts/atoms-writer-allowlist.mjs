/**
 * Writer-job allowlist and selection helpers.
 * Imported by atoms-writer-job.mjs and by tests that must not spawn pnpm.
 */

export const WRITER_REQUIRED = "WRITER_REQUIRED";
export const WRITER_NOT_ALLOWLISTED = "WRITER_NOT_ALLOWLISTED";
export const COUNTY_REQUIRED = "COUNTY_REQUIRED";

/**
 * Frozen allowlist. script is relative to packages/engine-core (tsx cwd
 * under pnpm --filter). pathEnv is the PATH=1 guard the child requires,
 * or null if the child has none.
 */
export const WRITER_ALLOWLIST = Object.freeze({
  "cad-parcel-roll": Object.freeze({
    id: "cad-parcel-roll",
    script: "scripts/write-cad-parcel-roll-county.mjs",
    pathEnv: "CAD_PARCEL_ROLL_PATH",
    planRow: "F-02",
  }),
  "well-fact": Object.freeze({
    id: "well-fact",
    script: "scripts/write-well-fact-county.mjs",
    pathEnv: "WELL_FACT_PATH",
    planRow: "F-02",
  }),
  "building-footprint": Object.freeze({
    id: "building-footprint",
    script: "scripts/write-building-footprint-county.mjs",
    pathEnv: "BUILDING_FOOTPRINT_PATH",
    planRow: "F-02",
  }),
  "utility-easement": Object.freeze({
    id: "utility-easement",
    script: "scripts/write-utility-easement-county.mjs",
    pathEnv: "UTILITY_EASEMENT_PATH",
    planRow: "F-02",
  }),
  setback: Object.freeze({
    id: "setback",
    script: "scripts/write-setback-city.mjs",
    pathEnv: "SETBACK_PATH",
    planRow: "F-11",
  }),
});

function coded(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

export function refusePooler(url, name) {
  if (!url || String(url).trim() === "") {
    throw coded("MISSING_ENV", `missing required env: ${name}`);
  }
  const host = new URL(url).hostname;
  if (host.includes("-pooler")) {
    throw coded("POOLER_HOST_REFUSED", `${name} is a pooler host (${host})`);
  }
  return host;
}

export function requireWriterEnv(env = process.env) {
  const atomsUrl = env.SUBSTRATE_DATABASE_URL || env.DATABASE_URL || env.ATOMS_DATABASE_URL;
  const sourceUrl = env.CORTEX_DATABASE_URL || env.SOURCE_DATABASE_URL || env.TXGIO_DATABASE_URL;
  const atomsHost = refusePooler(atomsUrl, "DATABASE_URL");
  const sourceHost = refusePooler(sourceUrl, "CORTEX_DATABASE_URL");
  return { atomsUrl, sourceUrl, atomsHost, sourceHost };
}

/**
 * Parse --name=value and --name value. Writer name from --writer or WRITER_NAME.
 * Neither is a CAD default. County is parsed here so equals-form cannot be dropped.
 */
export function parseWriterJobFlags(argv, env = {}) {
  let writer = null;
  let county = null;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--writer") {
      writer = String(argv[++i] ?? "").trim();
    } else if (a.startsWith("--writer=")) {
      writer = a.slice("--writer=".length).trim();
    } else if (a === "--county") {
      county = String(argv[++i] ?? "").trim();
    } else if (a.startsWith("--county=")) {
      county = a.slice("--county=".length).trim();
    } else {
      rest.push(a);
    }
  }
  if (!writer) {
    const fromEnv = String(env.WRITER_NAME ?? "").trim();
    writer = fromEnv || null;
  }
  if (writer === "") writer = null;
  if (county === "") county = null;
  return { writer, county, rest };
}

/** Unknown or absent writer name refuses. Never defaults to CAD. */
export function resolveWriterSelection(writerName) {
  if (writerName == null || String(writerName).trim() === "") {
    throw coded(WRITER_REQUIRED, WRITER_REQUIRED);
  }
  const key = String(writerName).trim();
  const entry = WRITER_ALLOWLIST[key];
  if (!entry) {
    throw coded(WRITER_NOT_ALLOWLISTED, `${WRITER_NOT_ALLOWLISTED}: ${key}`);
  }
  return entry;
}

export function requireCountyFips(county) {
  if (!county || !/^\d{5}$/.test(String(county))) {
    throw coded(COUNTY_REQUIRED, COUNTY_REQUIRED);
  }
  return String(county);
}

/**
 * Set only the selected writer's PATH=1 guard. Unconditional
 * CAD_PARCEL_ROLL_PATH=1 is the defect this function exists to kill.
 */
export function applyWriterPathEnv(env, writer) {
  const next = { ...env };
  for (const entry of Object.values(WRITER_ALLOWLIST)) {
    if (entry.pathEnv) delete next[entry.pathEnv];
  }
  if (writer.pathEnv) {
    next[writer.pathEnv] = "1";
  }
  return next;
}

export function writerJobRunScope({ writer, county }) {
  return {
    writer: writer.id,
    county,
    script: writer.script,
    pathEnv: writer.pathEnv,
  };
}

/**
 * Selection + county parse without spawn or store. Used by tests and main.
 */
export function resolveWriterJob(argv, env = {}) {
  const flags = parseWriterJobFlags(argv, env);
  const writer = resolveWriterSelection(flags.writer);
  const county = requireCountyFips(flags.county);
  const runScope = writerJobRunScope({ writer, county });
  return { writer, county, rest: flags.rest, runScope };
}
