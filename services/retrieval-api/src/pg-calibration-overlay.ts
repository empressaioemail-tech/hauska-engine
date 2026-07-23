/**
 * Thin Postgres read of cortex Neon migration 0037 `atom_calibration_overlay`.
 *
 * Topology A: overlay stays on cortex Neon (CORTEX_DATABASE_URL /
 * OVERLAY_DATABASE_URL / DEPLOYMENT_DATABASE_URL). Substrate `hauska_mcp`
 * does not host this table — do not invent a second calibration model.
 */

import postgres from "postgres";

import {
  PUBLIC_CALIBRATION_TENANT,
  widthedFromOverlayScalars,
  type CalibrationOverlayPort,
} from "@hauska-engine/engine-core/property-reasoning";
import type { WidthedConfidence } from "@empressaio/atom-contract/read-contract";

export interface PgCalibrationOverlayHandle {
  port: CalibrationOverlayPort;
  close: () => Promise<void>;
}

export function resolveOverlayDatabaseUrl(explicit?: string): string | undefined {
  return (
    explicit ??
    process.env.OVERLAY_DATABASE_URL ??
    process.env.CORTEX_DATABASE_URL ??
    process.env.DEPLOYMENT_DATABASE_URL
  );
}

export function createPgCalibrationOverlayPort(options: {
  databaseUrl: string;
  maxConnections?: number;
}): PgCalibrationOverlayHandle {
  const ssl =
    options.databaseUrl.includes("sslmode=require") ||
    options.databaseUrl.includes("neon.tech")
      ? ("require" as const)
      : false;
  const sql = postgres(options.databaseUrl, {
    ssl,
    max: options.maxConnections ?? 2,
  });

  const port: CalibrationOverlayPort = {
    async findCalibratedConfidence(atomId, jurisdictionTenant) {
      const rows = await sql<
        Array<{
          calibrated_confidence: string | null;
          asserted_confidence: string;
          calibration_stale: boolean;
          signal_count: number;
          atom_class: string | null;
        }>
      >`
        SELECT
          calibrated_confidence,
          asserted_confidence,
          calibration_stale,
          signal_count,
          atom_class
        FROM atom_calibration_overlay
        WHERE atom_id = ${atomId}
          AND jurisdiction_tenant = ${jurisdictionTenant}
        LIMIT 1
      `;
      const row = rows[0];
      if (!row) return null;

      const assertedFallback = widthedFromOverlayScalars({
        estimate: Number(row.asserted_confidence),
        signalCount: 0,
        atomClass: "asserted",
      });

      let calibratedConfidence: WidthedConfidence | null = null;
      if (row.calibrated_confidence != null && row.calibrated_confidence !== "") {
        calibratedConfidence = widthedFromOverlayScalars({
          estimate: Number(row.calibrated_confidence),
          signalCount: row.signal_count,
          atomClass: row.atom_class,
        });
      }

      return {
        calibratedConfidence,
        calibrationStale: Boolean(row.calibration_stale),
        assertedFallback,
      };
    },
  };

  return {
    port,
    close: async () => {
      await sql.end({ timeout: 5 });
    },
  };
}

export { PUBLIC_CALIBRATION_TENANT };
