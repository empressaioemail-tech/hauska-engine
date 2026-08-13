/**
 * Persisted special-district-fact plan artifact (slot-free plan/drain).
 *
 * Drain is FAIL CLOSED on membershipMethodId — only the locked true-geom
 * method may produce atoms.
 *
 * Metro counties (Harris ~1.5M parcels) exceed Node's max string length on
 * JSON.stringify of a single payload (`RangeError: Invalid string length`).
 * Persist as NDJSON:
 *   line 0: meta header (format=sd-plan-ndjson-v1, no planned[])
 *   line 1..N: one PlannedSpecialDistrict JSON object each
 * Legacy single-JSON files still read for smaller counties already on disk.
 */

import {
  appendFileSync,
  closeSync,
  fstatSync,
  openSync,
  readSync,
  writeFileSync,
} from "node:fs";

import {
  EMPTY_COUNTY_DISTRICT_ABSENCE_RULE,
  OUTSIDE_TRUE_GEOM_ABSENCE_RULE,
} from "./honesty.js";
import {
  TRUE_GEOM_MEMBERSHIP_METHOD,
  assertTrueGeomMembershipMethod,
} from "./membership-method.js";
import type {
  CountySpecialDistrictPlan,
  PlannedSpecialDistrict,
} from "./plan-county-special-districts.js";
import type { PostgisSpecialDistrictPlanMeta } from "./postgis-special-district-plan.js";

export const SD_PLAN_NDJSON_FORMAT = "sd-plan-ndjson-v1" as const;

export interface SpecialDistrictPlanStoreTruth {
  districtTablePresent?: boolean;
  districtRowsInCounty?: number;
  parcelsLoaded?: number;
  skippedNullGeometry?: number;
  registryCsvMissing?: string;
}

export interface SpecialDistrictPlanPayload {
  countyFips: string;
  membershipMethodId: string;
  plannedAt: string;
  districtsIndexed: number;
  emptyDistrictIndex: boolean;
  absenceReasoningRuleId: string;
  planned: PlannedSpecialDistrict[];
  counts: CountySpecialDistrictPlan["counts"];
  parcelsRead: number;
  storeTruth?: SpecialDistrictPlanStoreTruth;
  provenance?: {
    sourceAdapter: string;
    sourceCitation: string;
    sourceUrl: string;
    observedAt: string;
    jurisdictionTenant: string;
    verificationStatus: string;
    sourceVintage: string;
  };
  /** Present on NDJSON header line only. */
  format?: typeof SD_PLAN_NDJSON_FORMAT;
}

export function buildPlanPayload(
  plan: CountySpecialDistrictPlan,
  meta: PostgisSpecialDistrictPlanMeta,
  extras?: {
    storeTruth?: SpecialDistrictPlanStoreTruth;
    provenance?: SpecialDistrictPlanPayload["provenance"];
  },
): SpecialDistrictPlanPayload {
  return {
    countyFips: plan.countyFips,
    membershipMethodId: meta.membershipMethodId,
    plannedAt: meta.plannedAt,
    districtsIndexed: plan.districtsIndexed,
    emptyDistrictIndex: plan.emptyDistrictIndex,
    absenceReasoningRuleId: meta.absenceReasoningRuleId,
    // Do not copy — metro planned[] is multi-GB; a spread doubles heap.
    planned: plan.planned as PlannedSpecialDistrict[],
    counts: { ...plan.counts },
    parcelsRead: plan.parcelsRead,
    ...(extras?.storeTruth ? { storeTruth: extras.storeTruth } : {}),
    ...(extras?.provenance ? { provenance: extras.provenance } : {}),
  };
}

/**
 * Sync NDJSON writer. Never JSON.stringify the full payload (Harris hit
 * RangeError: Invalid string length on compact single-JSON).
 */
export function writePlanPayload(
  path: string,
  payload: SpecialDistrictPlanPayload,
): void {
  const { planned, ...headerRest } = payload;
  const header = {
    format: SD_PLAN_NDJSON_FORMAT,
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

export function readPlanPayload(path: string): SpecialDistrictPlanPayload {
  const peek = peekFileUtf8(path, 256);
  const size = fileSize(path);
  const looksNdjson =
    peek.includes(SD_PLAN_NDJSON_FORMAT) ||
    size > 32_000_000;

  if (looksNdjson) {
    return readPlanPayloadNdjson(path);
  }

  try {
    // Small legacy single-JSON plans only.
    const fh = openSync(path, "r");
    let raw: string;
    try {
      const buf = Buffer.alloc(size);
      readSync(fh, buf, 0, size, 0);
      raw = buf.toString("utf8");
    } finally {
      closeSync(fh);
    }
    const parsed = JSON.parse(raw) as SpecialDistrictPlanPayload;
    if (!parsed || typeof parsed !== "object") {
      throw new Error(`special-district-fact plan payload invalid: ${path}`);
    }
    if (parsed.format === SD_PLAN_NDJSON_FORMAT) {
      return readPlanPayloadNdjson(path);
    }
    return parsed;
  } catch (err) {
    if (
      err instanceof RangeError ||
      (err instanceof Error &&
        /Invalid string length|Cannot create a string/i.test(err.message))
    ) {
      return readPlanPayloadNdjson(path);
    }
    throw err;
  }
}

function readPlanPayloadNdjson(path: string): SpecialDistrictPlanPayload {
  const fh = openSync(path, "r");
  const size = fstatSync(fh).size;
  let offset = 0;
  let carry = "";
  const planned: PlannedSpecialDistrict[] = [];
  let header: SpecialDistrictPlanPayload | null = null;
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
          header = obj as unknown as SpecialDistrictPlanPayload;
          continue;
        }
        planned.push(obj as unknown as PlannedSpecialDistrict);
      }
    }
    const tail = carry.trim();
    if (tail) {
      const obj = JSON.parse(tail) as Record<string, unknown>;
      if (!header) header = obj as unknown as SpecialDistrictPlanPayload;
      else planned.push(obj as unknown as PlannedSpecialDistrict);
    }
  } finally {
    closeSync(fh);
  }

  if (!header) {
    throw new Error(`special-district-fact NDJSON plan empty: ${path}`);
  }
  return {
    ...header,
    planned,
    parcelsRead: header.parcelsRead ?? planned.length,
  };
}

/**
 * Fail-closed drain gate: membershipMethodId must be the locked true-geom id.
 * Returns planned entries ready for atom build.
 */
export function drainSpecialDistrictPlanPayload(
  payload: SpecialDistrictPlanPayload,
): {
  countyFips: string;
  planned: PlannedSpecialDistrict[];
  plan: CountySpecialDistrictPlan;
  absenceReasoningRuleId: string;
  provenance: SpecialDistrictPlanPayload["provenance"];
} {
  if (
    payload.membershipMethodId == null ||
    payload.membershipMethodId === ""
  ) {
    throw new Error(
      `special-district-fact drain FAIL CLOSED: membershipMethodId missing`,
    );
  }
  assertTrueGeomMembershipMethod(payload.membershipMethodId);

  if (!payload.countyFips || !/^\d{5}$/.test(payload.countyFips)) {
    throw new Error(
      `special-district-fact drain FAIL CLOSED: invalid countyFips`,
    );
  }
  if (!Array.isArray(payload.planned)) {
    throw new Error(
      `special-district-fact drain FAIL CLOSED: planned[] missing`,
    );
  }

  const plan: CountySpecialDistrictPlan = {
    countyFips: payload.countyFips,
    districtsIndexed: payload.districtsIndexed ?? 0,
    parcelsRead: payload.parcelsRead ?? payload.planned.length,
    emptyDistrictIndex: Boolean(payload.emptyDistrictIndex),
    planned: payload.planned,
    counts: payload.counts ?? {
      presentMemberships: 0,
      absentOutside: 0,
      parcelsInDistrict: 0,
      parcelsOutside: 0,
      skippedUnusableKey: 0,
      rateEnrichedCount: 0,
    },
  };

  return {
    countyFips: payload.countyFips,
    planned: payload.planned,
    plan,
    absenceReasoningRuleId:
      payload.absenceReasoningRuleId ??
      (plan.emptyDistrictIndex
        ? EMPTY_COUNTY_DISTRICT_ABSENCE_RULE
        : OUTSIDE_TRUE_GEOM_ABSENCE_RULE),
    provenance: payload.provenance,
  };
}

export { TRUE_GEOM_MEMBERSHIP_METHOD };
