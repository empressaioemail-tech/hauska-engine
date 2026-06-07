/**
 * engine-api runtime configuration.
 *
 * Scaffold only — no secrets management or deploy wiring yet.
 */

export interface EngineApiConfig {
  /** HTTP listen port. Cloud Run sets PORT. */
  port: number;
  /**
   * Shared secret the MCP gate presents as `Authorization: Bearer …`.
   * Empty disables the check (local dev).
   */
  gateServiceToken: string;
  /** ISO timestamp recorded at process start for /health. */
  startedAt: string;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): EngineApiConfig {
  const portRaw = env.PORT ?? "8080";
  const port = Number(portRaw);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`Invalid PORT: ${portRaw}`);
  }

  return {
    port,
    gateServiceToken: env.ENGINE_API_GATE_TOKEN ?? "",
    startedAt: new Date().toISOString(),
  };
}
