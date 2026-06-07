import postgres from "postgres";

export interface SubstrateDbProbeResult {
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

/**
 * Liveness probe against the substrate Neon Postgres instance.
 * Opens a short-lived connection, runs `SELECT 1`, and closes.
 */
export async function probeSubstrateDb(
  databaseUrl: string,
): Promise<SubstrateDbProbeResult> {
  const sql = postgres(databaseUrl, {
    max: 1,
    idle_timeout: 5,
    connect_timeout: 5,
    onnotice: () => {},
    ssl: databaseUrl.includes("sslmode=require") ? "require" : false,
  });
  const started = Date.now();
  try {
    await sql`SELECT 1 AS ok`;
    return { ok: true, latencyMs: Date.now() - started };
  } catch (err) {
    return { ok: false, error: String(err) };
  } finally {
    await sql.end({ timeout: 2 });
  }
}

export function resolveSubstrateDatabaseUrl(
  explicit?: string,
): string | undefined {
  const url =
    explicit ??
    process.env.SUBSTRATE_DATABASE_URL ??
    process.env.DATABASE_URL ??
    undefined;
  return url && url.length > 0 ? url : undefined;
}
