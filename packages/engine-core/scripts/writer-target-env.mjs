/**
 * Staging/production target selection for the atoms-writer job (P-169).
 *
 * Mirrors hauska-factory's `src/lib/publish-target-env.mjs` exactly: a
 * target reads only its own pair of variables, and a missing variable
 * refuses TARGET_ENV_MISSING naming the variable (never its value, never a
 * `??` fallback across targets). The four variables already exist as
 * `hauska-prod-497015` secrets — STAGING_HAUSKA_MCP_URL /
 * PRODUCTION_HAUSKA_MCP_URL are the same atoms-store pair the factory's own
 * alias-persist / bastrop-publish jobs already read (confirmed by reading
 * their live usage: `atoms = new pg.Client({ connectionString:
 * stores.HAUSKA_MCP_DATABASE_URL })`), and STAGING_NEONDB_URL /
 * PRODUCTION_NEONDB_URL are the cortex/LDT database pair that holds
 * txgio_parcel. No new secret is required.
 *
 * Executes: atoms-writer-job.mjs, only when --target is supplied.
 * Triggers: every execution that passes --target=staging|production.
 * Bypasses: an execution with no --target keeps reading DATABASE_URL /
 * CORTEX_DATABASE_URL directly via requireWriterEnv, byte-for-byte
 * unchanged — so the already-deployed factory-atoms-cad job (which never
 * passes --target) is unaffected if it is ever rebuilt from a future main.
 */

export const TARGET_ENV_MISSING = "TARGET_ENV_MISSING";
export const TARGET_UNKNOWN = "TARGET_UNKNOWN";

export const WRITER_TARGETS = Object.freeze(["staging", "production"]);

const TARGET_VARS = Object.freeze({
  staging: Object.freeze({ atoms: "STAGING_HAUSKA_MCP_URL", source: "STAGING_NEONDB_URL" }),
  production: Object.freeze({ atoms: "PRODUCTION_HAUSKA_MCP_URL", source: "PRODUCTION_NEONDB_URL" }),
});

export function assertKnownWriterTarget(target) {
  if (!WRITER_TARGETS.includes(target)) {
    const err = new Error(`unknown writer target: ${String(target)}`);
    err.code = TARGET_UNKNOWN;
    throw err;
  }
  return target;
}

function present(env, name) {
  const v = env?.[name];
  return typeof v === "string" && v.trim() !== "";
}

function refuseMissing(target, names) {
  const err = new Error(`target ${target} is missing ${names.join(",")}`);
  err.code = TARGET_ENV_MISSING;
  err.target = target;
  err.missing = names;
  throw err;
}

/** { DATABASE_URL (atoms store), CORTEX_DATABASE_URL (source store) } for `target`. */
export function resolveWriterTargetStores(env, target) {
  assertKnownWriterTarget(target);
  const vars = TARGET_VARS[target];
  const missing = [vars.atoms, vars.source].filter((name) => !present(env, name));
  if (missing.length > 0) refuseMissing(target, missing);
  return {
    target,
    DATABASE_URL: env[vars.atoms],
    CORTEX_DATABASE_URL: env[vars.source],
    varNames: { atoms: vars.atoms, source: vars.source },
  };
}
