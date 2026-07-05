/**
 * engine-api runtime configuration.
 *
 * Scaffold only — no secrets management or deploy wiring yet.
 */

export type GateContextMode = "off" | "log" | "enforce";

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
  /**
   * Shared secret for verifying gate-signed tenant context (HMAC key).
   * When unset, gate context verification is disabled.
   */
  gateContextSigningKey: string;
  /**
   * Gate context verification mode:
   * - off: disabled (default when signing key unset)
   * - log: verify and log results, but don't reject (DEFAULT when key set)
   * - enforce: reject 401 on missing/invalid context
   */
  gateContextMode: GateContextMode;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): EngineApiConfig {
  const portRaw = env.PORT ?? "8080";
  const port = Number(portRaw);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`Invalid PORT: ${portRaw}`);
  }

  const gateContextSigningKey = env.GATE_CONTEXT_SIGNING_KEY ?? "";
  const modeRaw = env.GATE_CONTEXT_MODE ?? "";
  let gateContextMode: GateContextMode = "off";

  if (gateContextSigningKey) {
    if (modeRaw === "enforce") {
      gateContextMode = "enforce";
    } else if (modeRaw === "off") {
      gateContextMode = "off";
    } else {
      gateContextMode = "log";
    }
  }

  return {
    port,
    gateServiceToken: env.ENGINE_API_GATE_TOKEN ?? "",
    startedAt: new Date().toISOString(),
    gateContextSigningKey,
    gateContextMode,
  };
}
