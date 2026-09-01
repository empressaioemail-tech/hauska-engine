/**
 * Persisted flood-hazard-fact plan artifact (slot-free plan / in-slot drain).
 *
 * Metro counties (Harris ~1.5M parcels) exceed Node's max string length on
 * JSON.stringify of a single payload. Persist as NDJSON:
 *   line 0: meta header (format=flood-plan-ndjson-v1, no planned[])
 *   line 1..N: one PlannedFloodHazard JSON object each
 *
 * --from-plan consumes this artifact and MUST NOT open a PostGIS plan scan.
 */

import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  fstatSync,
  openSync,
  readSync,
  writeFileSync,
} from "node:fs";

import type {
  CountyFloodHazardPlan,
  FloodPlanPopulationIdentity,
  PlannedFloodHazard,
} from "./plan-county-flood-hazard.js";
import type { FloodCountyRunProvenance } from "./flood-hazard-fact-atoms.js";

export const FLOOD_PLAN_NDJSON_FORMAT = "flood-plan-ndjson-v1" as const;

export interface FloodPlanDigest {
  sha256: string;
  records: number;
  byZone: Record<string, number>;
}

export interface FloodPlanPayload {
  countyFips: string;
  plannedAt: string;
  planBackend?: string;
  zonesIndexed: number;
  emptyZoneIndex: boolean;
  planned: PlannedFloodHazard[];
  counts: CountyFloodHazardPlan["counts"];
  parcelsRead: number;
  planDigest: FloodPlanDigest;
  populationIdentity?: FloodPlanPopulationIdentity;
  provenance?: FloodCountyRunProvenance;
  /** Present on NDJSON header line only. */
  format?: typeof FLOOD_PLAN_NDJSON_FORMAT;
}

export function digestFloodPlan(
  plan: Pick<CountyFloodHazardPlan, "planned">,
): FloodPlanDigest {
  const lines = plan.planned.map((p) =>
    p.outcome === "present"
      ? [
          p.parcelKey,
          "present",
          p.inSpecialFloodHazardArea ? "1" : "0",
          p.floodZone ?? "",
          p.zoneSubtype ?? "",
          p.baseFloodElevation == null ? "" : String(p.baseFloodElevation),
        ].join("|")
      : [p.parcelKey, "absent", p.absenceKind, p.reason].join("|"),
  );
  lines.sort();
  const hash = createHash("sha256");
  for (const line of lines) hash.update(line).update("\n");
  const byZone: Record<string, number> = {};
  for (const p of plan.planned) {
    if (p.outcome !== "present") continue;
    const key = p.floodZone ?? "_outside";
    byZone[key] = (byZone[key] ?? 0) + 1;
  }
  return { sha256: hash.digest("hex"), records: lines.length, byZone };
}

export function buildFloodPlanPayload(
  plan: CountyFloodHazardPlan,
  extras?: {
    plannedAt?: string;
    planBackend?: string;
    provenance?: FloodCountyRunProvenance;
  },
): FloodPlanPayload {
  return {
    countyFips: plan.countyFips,
    plannedAt: extras?.plannedAt ?? new Date().toISOString(),
    ...(extras?.planBackend ? { planBackend: extras.planBackend } : {}),
    zonesIndexed: plan.zonesIndexed,
    emptyZoneIndex: plan.emptyZoneIndex,
    planned: plan.planned as PlannedFloodHazard[],
    counts: { ...plan.counts },
    parcelsRead: plan.parcelsRead,
    planDigest: digestFloodPlan(plan),
    populationIdentity: plan.populationIdentity,
    ...(extras?.provenance ? { provenance: extras.provenance } : {}),
  };
}

export function writeFloodPlanPayload(
  path: string,
  payload: FloodPlanPayload,
): void {
  const { planned, ...headerRest } = payload;
  const header = {
    format: FLOOD_PLAN_NDJSON_FORMAT,
    plannedCount: planned.length,
    ...headerRest,
  };
  writeFileSync(path, `${JSON.stringify(header)}\n`, "utf8");
  const CHUNK = 5000;
  for (let i = 0; i < planned.length; i += CHUNK) {
    let buf = "";
    const end = Math.min(i + CHUNK, planned.length);
    for (let j = i; j < end; j++) {
      buf += `${JSON.stringify(planned[j])}\n`;
    }
    appendFileSync(path, buf, "utf8");
  }
}

function peekFileUtf8(path: string, maxBytes: number): string {
  const fh = openSync(path, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    const n = readSync(fh, buf, 0, maxBytes, 0);
    return buf.toString("utf8", 0, n);
  } finally {
    closeSync(fh);
  }
}

function fileSize(path: string): number {
  const fh = openSync(path, "r");
  try {
    return fstatSync(fh).size;
  } finally {
    closeSync(fh);
  }
}

export function readFloodPlanPayload(path: string): FloodPlanPayload {
  const peek = peekFileUtf8(path, 256);
  const size = fileSize(path);
  const looksNdjson =
    peek.includes(FLOOD_PLAN_NDJSON_FORMAT) || size > 32_000_000;

  if (looksNdjson) {
    return readFloodPlanPayloadNdjson(path);
  }

  try {
    const fh = openSync(path, "r");
    let raw: string;
    try {
      const buf = Buffer.alloc(size);
      readSync(fh, buf, 0, size, 0);
      raw = buf.toString("utf8");
    } finally {
      closeSync(fh);
    }
    const parsed = JSON.parse(raw) as FloodPlanPayload;
    if (!parsed || typeof parsed !== "object") {
      throw new Error(`flood-hazard-fact plan payload invalid: ${path}`);
    }
    if (parsed.format === FLOOD_PLAN_NDJSON_FORMAT) {
      return readFloodPlanPayloadNdjson(path);
    }
    return parsed;
  } catch (err) {
    if (
      err instanceof RangeError ||
      (err instanceof Error &&
        /Invalid string length|Cannot create a string/i.test(err.message))
    ) {
      return readFloodPlanPayloadNdjson(path);
    }
    throw err;
  }
}

function readFloodPlanPayloadNdjson(path: string): FloodPlanPayload {
  const fh = openSync(path, "r");
  const size = fstatSync(fh).size;
  let offset = 0;
  let carry = "";
  const planned: PlannedFloodHazard[] = [];
  let header: FloodPlanPayload | null = null;
  const BUF = Buffer.alloc(1024 * 1024);

  try {
    while (offset < size) {
      const n = readSync(fh, BUF, 0, BUF.length, offset);
      if (n <= 0) break;
      offset += n;
      carry += BUF.toString("utf8", 0, n);
      let nl: number;
      while ((nl = carry.indexOf("\n")) >= 0) {
        const line = carry.slice(0, nl).trim();
        carry = carry.slice(nl + 1);
        if (!line) continue;
        const obj = JSON.parse(line) as Record<string, unknown>;
        if (!header) {
          header = obj as unknown as FloodPlanPayload;
          continue;
        }
        planned.push(obj as unknown as PlannedFloodHazard);
      }
    }
    const tail = carry.trim();
    if (tail) {
      const obj = JSON.parse(tail) as Record<string, unknown>;
      if (!header) header = obj as unknown as FloodPlanPayload;
      else planned.push(obj as unknown as PlannedFloodHazard);
    }
  } finally {
    closeSync(fh);
  }

  if (!header) {
    throw new Error(`flood-hazard-fact NDJSON plan empty: ${path}`);
  }
  return {
    ...header,
    planned,
    parcelsRead: header.parcelsRead ?? planned.length,
  };
}

export function drainFloodPlanPayload(
  payload: FloodPlanPayload,
  options?: { countyFips?: string; expectDigest?: string },
): {
  countyFips: string;
  planned: PlannedFloodHazard[];
  plan: CountyFloodHazardPlan;
  planDigest: FloodPlanDigest;
  provenance: FloodPlanPayload["provenance"];
} {
  if (!payload.countyFips || !/^\d{5}$/.test(payload.countyFips)) {
    throw new Error(
      `flood-hazard-fact --from-plan FAIL CLOSED: invalid countyFips`,
    );
  }
  if (
    options?.countyFips &&
    options.countyFips !== payload.countyFips
  ) {
    throw new Error(
      `flood-hazard-fact --from-plan FAIL CLOSED: --county=${options.countyFips} != plan ${payload.countyFips}`,
    );
  }
  if (!Array.isArray(payload.planned)) {
    throw new Error(
      `flood-hazard-fact --from-plan FAIL CLOSED: planned[] missing`,
    );
  }

  const plan: CountyFloodHazardPlan = {
    countyFips: payload.countyFips,
    zonesIndexed: payload.zonesIndexed ?? 0,
    parcelsRead: payload.parcelsRead ?? payload.planned.length,
    emptyZoneIndex: Boolean(payload.emptyZoneIndex),
    planned: payload.planned,
    refused: [],
    containment: {
      contained: 0,
      notContained: 0,
      unmeasurable: 0,
      emitted: 0,
      refused: 0,
      byReasonCode: {},
      countingRule:
        "--from-plan drain does not re-run containment; refused[] is empty on the artifact",
    },
    counts: {
      present: payload.counts?.present ?? 0,
      presentInSfha: payload.counts?.presentInSfha ?? 0,
      presentOutside: payload.counts?.presentOutside ?? 0,
      absent: payload.counts?.absent ?? 0,
      refused: payload.counts?.refused ?? 0,
      skippedUnusableKey: payload.counts?.skippedUnusableKey ?? 0,
      skippedDuplicateKey: payload.counts?.skippedDuplicateKey ?? 0,
    },
    populationIdentity: {
      parcelsRead: payload.parcelsRead ?? payload.planned.length,
      skippedUnusableKey: payload.counts?.skippedUnusableKey ?? 0,
      skippedDuplicateKey: payload.counts?.skippedDuplicateKey ?? 0,
      contained: 0,
      notContained: 0,
      unmeasurable: 0,
      sum: 0,
      equation:
        "--from-plan drain does not re-run containment or population identity",
    },
  };

  const recomputed = digestFloodPlan(plan);
  if (payload.planDigest?.sha256 && payload.planDigest.sha256 !== recomputed.sha256) {
    throw new Error(
      `flood-hazard-fact --from-plan FAIL CLOSED: stored digest ${payload.planDigest.sha256} != recomputed ${recomputed.sha256}`,
    );
  }
  if (options?.expectDigest && options.expectDigest !== recomputed.sha256) {
    throw new Error(
      `flood-hazard-fact --from-plan FAIL CLOSED: --expect-digest ${options.expectDigest} != ${recomputed.sha256}`,
    );
  }

  return {
    countyFips: payload.countyFips,
    planned: payload.planned,
    plan,
    planDigest: recomputed,
    provenance: payload.provenance,
  };
}
