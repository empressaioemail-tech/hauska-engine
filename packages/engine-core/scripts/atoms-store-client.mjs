/**
 * P-342 — one place that decides the Postgres client options for the atoms store,
 * used by the P-263 census (read) and the P-263/P-342 apply (read + write).
 *
 * WHY IT EXISTS: both instruments must reach the same store with the same TLS decision.
 * Before this, the census hardcoded `ssl: "require"`, so a fixture dry run against a
 * local container (which has no TLS) could not reproduce the census's buckets — and the
 * apply's own verification explicitly compares itself to a fresh census. Two clients that
 * disagree about how to reach the store are two instruments that cannot be compared.
 *
 * The rule is P-342's, and it is narrow: a loopback/private host reads WITHOUT TLS (a local
 * Docker fixture), everything else REQUIRES it. `localhost`, `127.0.0.1`, `::1`, `host.
 * docker.internal` and any bare hostname with no dot are treated as local. This is a client
 * OPTION, never a security downgrade path for a remote store: Neon hosts always carry dots
 * and always take `require`, and an unparseable URL takes `require` (fail closed).
 */
import postgres from "postgres";

/** True when `url` points at a local/fixture Postgres that does not speak TLS. */
export function isLocalPostgresUrl(url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") return true;
  if (host === "host.docker.internal" || host.endsWith(".localhost")) return true;
  /** A bare hostname with no dot is a container/service name on the Docker network. */
  return !host.includes(".");
}

export function substrateClientOptions(url, overrides = {}) {
  return {
    ssl: isLocalPostgresUrl(url) ? false : "require",
    max: 1,
    prepare: false,
    ...overrides,
  };
}

/** A short, non-reversible store fingerprint for an artifact (never the DSN). */
export function storeHostFingerprint(url) {
  try {
    return new URL(url).host.replace(/\.[a-z0-9-]+\.aws\.neon\.tech$/i, ".…neon.tech");
  } catch {
    return "unparseable";
  }
}

export function openSubstrateClient(url, overrides = {}) {
  return postgres(url, substrateClientOptions(url, overrides));
}
