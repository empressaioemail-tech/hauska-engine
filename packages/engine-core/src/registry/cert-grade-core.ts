/**
 * Cert-grade core — the reusable per-parcel grading machinery behind THE
 * proven Block-13 harness (scripts/block13-cert-grade.mjs). Lives in src/ so
 * it can be imported by other src/ modules (e.g. preflight-probes.ts, the
 * OPS-8 pre-flight geometry-parity probe) WITHOUT pulling in a CLI script's
 * top-level side effects (arg parsing, DB connection setup, process.exit).
 *
 * Dependency direction: scripts/block13-cert-grade.mjs imports FROM this
 * module (script depends on src). No src/ module may import from scripts/ —
 * that direction previously dragged a CLI script's whole module graph into
 * whatever test file transitively imported it (postmortem: PR #218 was
 * reverted after CI flagged this as an architectural smell; the reversion
 * turned out to trace to a pre-existing, unrelated PDF-decode test flake —
 * see the #218 rework PR description for the mechanism writeup — but the
 * inversion is still the correct fix regardless, since script-depends-on-src
 * is the only safe direction for a package's public import graph).
 *
 * Two entry points, mirroring the roster loop's two modes:
 *   - gradeOneParcelInQueryMode: dominant-district layer-23 answer key
 *     (--roster-from=query / --roster-from=file).
 *   - gradeBlock13Parcel: the frozen BLOCK-13 answer key
 *     (--roster-from=block13, the default).
 * Both reuse the identical gate logic; only the answer-key source differs.
 */
import type { Sql } from "postgres";
import { fetchBastropPerParcelSetbackRecord } from "@hauska-engine/adapters";
import type { PgStorage } from "@hauska-engine/storage";

import {
  fetchBcadParcelRings,
  scrubLotLineRing,
  ringCentroidLngLat,
  BASTROP_BCAD_PARCELS_URL,
} from "../boundary-primitive/index.js";
import {
  readBoundaryEdgesForParcel,
  BoundaryPrimitiveMissingError,
} from "../boundary-primitive/read.js";
import { labelEdgesFromRoads } from "../depth-warm/edgeLabeling.js";
import { DEPTH_WARM_PROMOTION_MARKER, RECIPE_VERSION } from "../depth-warm/types.js";
import { openRing } from "../depth-warm/geometry.js";
import { measurePerEdgeInsetForRings } from "../depth-warm/measure-inset.js";
import { computeWarmCandidateFromBoundary } from "../boundary-primitive/consume.js";
import { computeWarmCandidate } from "../depth-warm/warm-compute.js";
import { relabelBoundaryEdgesFromRoadLabels } from "../boundary-primitive/relabel-from-roads.js";
import {
  primitiveNormalsAgreeWithRing,
  recomputeBoundaryEdgesForRing,
} from "../boundary-primitive/recompute-for-ring.js";
import {
  verifyFrontEdgeOrientation,
  verifyWarmCandidateMechanically,
} from "../depth-warm/verify-mechanical.js";
import {
  streetNamesMatchForFacesAnswer,
  isNoDeterminableFrontageSitus,
  R35_ORIENTATION_DECLINE,
  edgeMidpointNearKnownMiterPoint,
} from "../depth-warm/cert-equivalent-gates.js";
import { resolveSetbackTableRow } from "../property-reasoning/emit-setback-rule.js";
import type { JurisdictionDescriptor } from "../property-reasoning/types.js";

export const CERT_GRADE_COUNTY_FIPS = "48021";
export const CERT_GRADE_INSET_TOL_FT = 1.0;

/** Frozen Block-13 regression roster + answer key. */
export const BLOCK13_ROSTER = [
  "48021:34145",
  "48021:34121",
  "48021:34153",
  "48021:34137",
  "48021:34169",
  "48021:34177",
  "48021:34161",
];

export interface Block13AnswerKey {
  readonly situs: string;
  readonly district: string;
  readonly F: number;
  readonly S: number;
  readonly C: number | null;
  readonly R: number;
  readonly frontStreet: string;
}

export const ANSWER_KEY_BLOCK13: Readonly<Record<string, Block13AnswerKey>> = {
  "48021:34145": { situs: "909 Pecan", district: "GC", F: 20, S: 5, C: null, R: 20, frontStreet: "Pecan" },
  "48021:34121": { situs: "907 Chestnut", district: "GC", F: 20, S: 5, C: null, R: 20, frontStreet: "Chestnut" },
  "48021:34153": { situs: "909 Chestnut", district: "GC", F: 20, S: 5, C: null, R: 20, frontStreet: "Chestnut" },
  "48021:34137": { situs: "908 Pine", district: "SF-1", F: 25, S: 5, C: 15, R: 25, frontStreet: "Pine" },
  "48021:34169": { situs: "906 Pine", district: "SF-1", F: 25, S: 5, C: 15, R: 25, frontStreet: "Pine" },
  "48021:34177": { situs: "901 Pecan", district: "MU", F: 15, S: 5, C: null, R: 15, frontStreet: "Pecan" },
  "48021:34161": { situs: "905 Pecan", district: "MU", F: 15, S: 5, C: null, R: 15, frontStreet: "Pecan" },
};

export function resolveBlock13Key(
  parcelNodeId: string,
): { ok: true; key: Block13AnswerKey } | { ok: false; reason: string } {
  const key = ANSWER_KEY_BLOCK13[parcelNodeId];
  if (!key) return { ok: false, reason: "not in BLOCK13 answer key" };
  return { ok: true, key };
}

export function expectedFtForRole(
  role: string,
  key: { F: number; R: number; S: number; C: number | null },
): number {
  if (role === "front") return key.F;
  if (role === "rear") return key.R;
  if (role === "side_corner") return key.C ?? key.S;
  return key.S;
}

export function situsFrontStreetToken(situs: string | null | undefined): string | null {
  if (!situs?.trim()) return null;
  const streetPart = situs.split(",")[0]?.trim() ?? situs.trim();
  const m = /^\d+\s+(.+)$/.exec(streetPart);
  return m ? m[1]!.trim() : streetPart;
}

interface Layer23Key {
  district: string;
  F: number;
  S: number;
  C: number | null;
  R: number;
  frontStreet: string | null;
}

export async function buildLayer23Key(
  parcelNodeId: string,
  district: string | null,
  centroidLngLat: [number, number],
  zoningStamp: string | null,
): Promise<{ ok: true; key: Layer23Key } | { ok: false; code: string; reason?: string }> {
  const fetched = await fetchBastropPerParcelSetbackRecord(parcelNodeId.split(":")[1]!, {
    districtCode: zoningStamp ?? district ?? undefined,
    centroidLngLat,
  });
  if (fetched.kind !== "parsed") {
    return { ok: false, code: fetched.code, reason: fetched.reason };
  }
  const d = (fetched.resolvedDistrictCode ?? district ?? "").trim() || (district ?? "");
  const C =
    fetched.sideCornerFt != null &&
    fetched.sideInteriorFt != null &&
    fetched.sideCornerFt !== fetched.sideInteriorFt
      ? fetched.sideCornerFt
      : null;
  return {
    ok: true,
    key: {
      district: d.split(/\s+/)[0]!,
      F: fetched.frontFt,
      S: fetched.sideInteriorFt ?? fetched.sideCornerFt,
      C,
      R: fetched.rearFt,
      frontStreet: null,
    },
  };
}

/**
 * Descriptor-backed answer key — same scalars warm/promote uses via
 * resolveSetbackTableRow (Elgin and other descriptor-only jurisdictions).
 */
export function buildDescriptorSetbackKey(
  descriptor: JurisdictionDescriptor,
  stampedDistrict: string | null,
): { ok: true; key: Layer23Key } | { ok: false; code: string; reason?: string } {
  const raw = (stampedDistrict ?? "").trim();
  if (!raw) {
    return { ok: false, code: "no-district", reason: "missing stamped district on zoning-fact" };
  }
  const district = raw.split(/\s+/)[0]!;
  const resolved = resolveSetbackTableRow(descriptor.setbackTable, district);
  if ("kind" in resolved) {
    return { ok: false, code: resolved.code, reason: resolved.reason };
  }
  const { setbacks } = resolved;
  const C =
    setbacks.sideCornerFt != null &&
    setbacks.sideFt != null &&
    setbacks.sideCornerFt !== setbacks.sideFt
      ? setbacks.sideCornerFt
      : null;
  return {
    ok: true,
    key: {
      district,
      F: setbacks.frontFt,
      S: setbacks.sideFt,
      C,
      R: setbacks.rearFt,
      frontStreet: null,
    },
  };
}

/** Grading context shared across a roster run — the caller (script or probe) owns and closes these. */
export interface CertGradeContext {
  readonly sql: Sql;
  readonly txSql: Sql;
  readonly storage: PgStorage;
  readonly roads: unknown[];
  readonly descriptor: unknown;
  /** When "descriptor", answer key comes from descriptor setback table; default layer-23 (Bastrop). */
  readonly answerKeyMode?: "layer23" | "descriptor";
  /**
   * The county's cadastral-ring query endpoint (registry row's
   * railC.cadastralQueryUrl), threaded through to fetchBcadParcelRings so a
   * non-Bastrop county's per-parcel grade queries ITS OWN cadastral service
   * instead of silently defaulting to Bastrop's (see resolveCadastralQueryUrl
   * below). Absent/undefined is legal only for a 48021 (Bastrop) parcel,
   * which falls back to the legacy BASTROP_BCAD_PARCELS_URL default for
   * back-compat; every other county fails loud instead of silently
   * defaulting.
   */
  readonly cadastralQueryUrl?: string | null;
  /**
   * Cadastral layer parcel-id field name (registry row railPerParcel.propIdField).
   * Defaults to prop_id when absent (BCAD/Guadalupe/Kaufman shape).
   */
  readonly cadastralPropIdField?: string;
}

/**
 * Resolve the cadastral query URL a grader should use for `parcelNodeId`.
 * 48021 (Bastrop) parcels keep the legacy implicit default
 * (BASTROP_BCAD_PARCELS_URL) when no explicit URL is supplied, so the
 * existing Bastrop invocations (block13, dominant-district query mode, the
 * unzoned county row) stay byte-identical. Every other county MUST carry an
 * explicit `cadastralQueryUrl` (from its registry row) — absent that, this
 * throws a named error rather than silently defaulting to Bastrop's
 * cadastral service, which would either false-fail (cadastral-ring-unresolved
 * against the wrong service) or, worse, resolve a cross-county prop_id
 * collision and grade the wrong ring.
 */
export function resolveCadastralQueryUrl(
  parcelNodeId: string,
  cadastralQueryUrl: string | null | undefined,
): string {
  if (cadastralQueryUrl) return cadastralQueryUrl;
  const fips = parcelNodeId.split(":")[0];
  if (fips === CERT_GRADE_COUNTY_FIPS) return BASTROP_BCAD_PARCELS_URL;
  throw new Error(
    `cadastral query URL not configured for row (parcelNodeId=${parcelNodeId}, fips=${fips ?? "unknown"}) — ` +
      `set railC.cadastralQueryUrl on this county's registry row (jurisdiction-registry.ts) instead of ` +
      `relying on the Bastrop default.`,
  );
}

export interface ParcelGradeResult {
  pass: boolean;
  gates: Record<string, unknown>;
  edges: unknown[];
  honestDecline?: boolean;
  declineReason?: string;
  error?: string;
  reason?: string;
  district?: string;
  answerKey?: unknown;
  situs?: string | null;
  orientationHonestDecline?: string | null;
}

/**
 * Grade a single parcel in "query" mode (dominant-district layer-23 answer
 * key, R28/R33 warm==cert parity gates). Same gates, same pass/decline
 * semantics as the frozen Block-13 path — only the answer-key source differs.
 */
export async function gradeOneParcelInQueryMode(
  parcelNodeId: string,
  ctx: CertGradeContext & { districtPrefix: string | null },
): Promise<ParcelGradeResult> {
  const { sql, txSql, storage, roads, descriptor, districtPrefix } = ctx;
  const propId = parcelNodeId.split(":")[1]!;
  const propIdField = ctx.cadastralPropIdField ?? "prop_id";
  const parcelResult: ParcelGradeResult = { pass: false, gates: {}, edges: [] };
  const cadastralQueryUrl = resolveCadastralQueryUrl(parcelNodeId, ctx.cadastralQueryUrl);

  const [envRowPre] = await sql`
    SELECT body FROM atoms
    WHERE entity_type = 'buildable-envelope' AND body->>'parcelNodeId' = ${parcelNodeId}
    ORDER BY updated_at DESC NULLS LAST LIMIT 1
  `;
  const envPre = envRowPre?.body;
  const warmDecline =
    (typeof envPre?.absence?.reason === "string" && envPre.absence.reason.trim().length > 0
      ? envPre.absence.reason
      : null) ??
    envPre?.warmVerifyDecline ??
    null;
  const isPromotedPre = envPre?.depthWarmPromotion === DEPTH_WARM_PROMOTION_MARKER;
  const recipeVersionPre = envPre?.recipeVersion ?? null;

  if (warmDecline && recipeVersionPre === RECIPE_VERSION && !isPromotedPre) {
    parcelResult.pass = true;
    parcelResult.honestDecline = true;
    parcelResult.declineReason = warmDecline;
    return parcelResult;
  }

  if (isPromotedPre && recipeVersionPre !== RECIPE_VERSION) {
    parcelResult.error = "stale-residue";
    return parcelResult;
  }

  if (!isPromotedPre || recipeVersionPre !== RECIPE_VERSION) {
    const [zf] = await sql`
      SELECT 1 FROM atoms WHERE entity_type = 'zoning-fact'
        AND body->>'parcelNodeId' = ${parcelNodeId} AND NOT (body ? 'absence') LIMIT 1
    `;
    if (!zf) {
      parcelResult.pass = true;
      parcelResult.honestDecline = true;
      parcelResult.declineReason = "no-zoning-fact-on-substrate";
      return parcelResult;
    }
    parcelResult.error = "missing-single-vintage-state";
    return parcelResult;
  }

  const [situsRow] = await txSql`
    SELECT situs_address FROM txgio_parcel
    WHERE county_fips = ${CERT_GRADE_COUNTY_FIPS} AND prop_id = ${propId} LIMIT 1
  `;
  const situsAddress: string | null = situsRow?.situs_address?.trim() ?? null;
  parcelResult.situs = situsAddress;

  let ring: unknown = null;
  try {
    const bcad = await fetchBcadParcelRings([propId], fetch, cadastralQueryUrl, propIdField);
    const bcadRing = bcad[0]?.ring;
    ring = bcadRing ? scrubLotLineRing(bcadRing) : null;
  } catch (err) {
    parcelResult.error = "bcad-fetch-failed";
    parcelResult.reason = err instanceof Error ? err.message : String(err);
    return parcelResult;
  }
  if (!ring) {
    parcelResult.error = "no-ring";
    return parcelResult;
  }

  const centroidLngLat = ringCentroidLngLat(ring as never);

  const [zfRow] = await sql`
    SELECT body FROM atoms WHERE entity_type = 'zoning-fact'
      AND body->>'parcelNodeId' = ${parcelNodeId}
    ORDER BY updated_at DESC NULLS LAST LIMIT 1
  `;
  const stampedDistrict = zfRow?.body?.district ?? districtPrefix ?? null;

  const useDescriptorKey = ctx.answerKeyMode === "descriptor";
  const keyBuilt = useDescriptorKey
    ? buildDescriptorSetbackKey(ctx.descriptor as JurisdictionDescriptor, stampedDistrict)
    : await buildLayer23Key(parcelNodeId, stampedDistrict, centroidLngLat, stampedDistrict);
  if (!keyBuilt.ok) {
    parcelResult.error = keyBuilt.code;
    parcelResult.reason = keyBuilt.reason;
    return parcelResult;
  }
  const key: Layer23Key = {
    ...keyBuilt.key,
    frontStreet: situsFrontStreetToken(situsAddress),
  };
  parcelResult.answerKey = key;

  return gradeAgainstKey(parcelNodeId, propId, key, situsAddress, ring, { sql, txSql, storage, roads, descriptor });
}

/**
 * Decline code minted by the unzoned-county envelope cascade for the
 * genuinely unincorporated / no-city-signal cohort
 * (property-reasoning/cascade-unzoned-envelope-decline.ts). Deliberately
 * distinct from that module's NO_DISTRICT_ON_RECORD_CODE (in-city-but-
 * unonboarded cohort, added 2026-08-04) — gradeUnzonedParcel below asserts
 * the parcel is genuinely unzoned, so it must keep matching ONLY this code;
 * an in-city parcel is zoned (just not yet stamped) and correctly does NOT
 * pass this grader.
 */
export const UNZONED_CASCADE_DECLINE_CODE = "unzoned-no-district-basis";

/**
 * Grade a single parcel on the unzoned-county cert branch
 * (--grade-mode=unzoned). Asserts the parcel is a genuine, coherent
 * zoning-absence: honest-absence zoning-fact present with NO district and
 * NO setback-rule atom (a setback-rule on an absence parcel would itself be
 * a contract violation per the planner's 2026-08-03 ruling — never minted by
 * the cascade); the cascade envelope decline present
 * (warmVerifyDeclineCode === unzoned-no-district-basis, post cascade-bake
 * state); and the parcel's cadastral ring actually resolves (an absence
 * parcel still needs to be a REAL parcel, not a dangling node id). Same
 * result shape as gradeOneParcelInQueryMode / gradeBlock13Parcel so
 * block13-cert-grade.mjs can drive either grader interchangeably.
 */
export async function gradeUnzonedParcel(
  parcelNodeId: string,
  ctx: Pick<CertGradeContext, "sql" | "cadastralQueryUrl" | "cadastralPropIdField">,
): Promise<ParcelGradeResult> {
  const { sql } = ctx;
  const propId = parcelNodeId.split(":")[1]!;
  const propIdField = ctx.cadastralPropIdField ?? "prop_id";
  const parcelResult: ParcelGradeResult = { pass: false, gates: {}, edges: [] };
  let cadastralQueryUrl: string;
  try {
    cadastralQueryUrl = resolveCadastralQueryUrl(parcelNodeId, ctx.cadastralQueryUrl);
  } catch (err) {
    parcelResult.pass = false;
    parcelResult.reason = "cadastral-query-url-not-configured";
    parcelResult.error = err instanceof Error ? err.message : String(err);
    return parcelResult;
  }

  const [zfRow] = await sql`
    SELECT body FROM atoms WHERE entity_type = 'zoning-fact'
      AND body->>'parcelNodeId' = ${parcelNodeId}
    ORDER BY updated_at DESC NULLS LAST LIMIT 1
  `;
  const zoningFact = zfRow?.body ?? null;
  const district: string | null = zoningFact?.district ?? null;
  const absenceKind: string | null = zoningFact?.absence?.kind ?? null;
  parcelResult.district = district ?? undefined;

  if (!zoningFact || district !== null || absenceKind !== "no-zoning-stamp") {
    parcelResult.pass = false;
    parcelResult.reason = "expected-unzoned-but-district-present";
    return parcelResult;
  }

  const [srRow] = await sql`
    SELECT 1 FROM atoms WHERE entity_type = 'setback-rule'
      AND body->>'parcelNodeId' = ${parcelNodeId} LIMIT 1
  `;
  if (srRow) {
    parcelResult.pass = false;
    parcelResult.reason = "unexpected-setback-rule";
    return parcelResult;
  }

  const [envRow] = await sql`
    SELECT body FROM atoms WHERE entity_type = 'buildable-envelope'
      AND body->>'parcelNodeId' = ${parcelNodeId}
    ORDER BY updated_at DESC NULLS LAST LIMIT 1
  `;
  const envelope = envRow?.body ?? null;
  const envelopeDeclineCode =
    (typeof envelope?.absence?.kind === "string" && envelope.absence.kind.trim().length > 0
      ? envelope.absence.kind
      : null) ??
    envelope?.warmVerifyDeclineCode ??
    null;
  if (!envelope || envelopeDeclineCode !== UNZONED_CASCADE_DECLINE_CODE) {
    parcelResult.pass = false;
    parcelResult.reason = "cascade-missing";
    return parcelResult;
  }

  try {
    const bcad = await fetchBcadParcelRings([propId], fetch, cadastralQueryUrl, propIdField);
    const bcadRing = bcad[0]?.ring;
    const ring = bcadRing ? scrubLotLineRing(bcadRing) : null;
    if (!ring) {
      parcelResult.pass = false;
      parcelResult.reason = "cadastral-ring-unresolved";
      return parcelResult;
    }
  } catch (err) {
    parcelResult.pass = false;
    parcelResult.reason = "cadastral-ring-unresolved";
    parcelResult.error = err instanceof Error ? err.message : String(err);
    return parcelResult;
  }

  parcelResult.pass = true;
  parcelResult.honestDecline = true;
  parcelResult.declineReason =
    (typeof envelope.absence?.reason === "string" && envelope.absence.reason.trim().length > 0
      ? envelope.absence.reason
      : null) ??
    envelope.warmVerifyDecline ??
    UNZONED_CASCADE_DECLINE_CODE;
  return parcelResult;
}

/**
 * Grade a single parcel against the frozen BLOCK13 answer key
 * (--roster-from=block13, the default invocation).
 */
export async function gradeBlock13Parcel(
  parcelNodeId: string,
  ctx: CertGradeContext,
): Promise<ParcelGradeResult> {
  const { sql, txSql, storage, roads, descriptor } = ctx;
  const propId = parcelNodeId.split(":")[1]!;
  const propIdField = ctx.cadastralPropIdField ?? "prop_id";
  const parcelResult: ParcelGradeResult = { pass: false, gates: {}, edges: [] };
  const cadastralQueryUrl = resolveCadastralQueryUrl(parcelNodeId, ctx.cadastralQueryUrl);

  const resolved = resolveBlock13Key(parcelNodeId);
  if (!resolved.ok) {
    parcelResult.error = resolved.reason;
    return parcelResult;
  }
  const key: Block13AnswerKey = { ...resolved.key };
  parcelResult.district = key.district;
  parcelResult.answerKey = key;

  const [situsRow] = await txSql`
    SELECT situs_address FROM txgio_parcel
    WHERE county_fips = ${CERT_GRADE_COUNTY_FIPS} AND prop_id = ${propId} LIMIT 1
  `;
  const situsAddress: string | null = situsRow?.situs_address?.trim() ?? null;
  parcelResult.situs = situsAddress;

  let ring: unknown = null;
  try {
    const bcad = await fetchBcadParcelRings([propId], fetch, cadastralQueryUrl, propIdField);
    const bcadRing = bcad[0]?.ring;
    ring = bcadRing ? scrubLotLineRing(bcadRing) : null;
  } catch (err) {
    parcelResult.error = "bcad-fetch-failed";
    parcelResult.reason = err instanceof Error ? err.message : String(err);
    return parcelResult;
  }
  if (!ring) {
    parcelResult.error = "no-ring";
    return parcelResult;
  }

  return gradeAgainstKey(parcelNodeId, propId, key, situsAddress, ring, { sql, txSql, storage, roads, descriptor }, true);
}

/**
 * Shared post-key grading body (R28/R33 warm==cert parity gates): district,
 * setbacks, per-edge inset, front orientation. Identical between query mode
 * and block13 mode; only how `key`/`answerFrontToken` were built differs,
 * which the two callers above already resolved before calling in.
 */
async function gradeAgainstKey(
  parcelNodeId: string,
  propId: string,
  key: { district: string; F: number; S: number; C: number | null; R: number; frontStreet: string | null },
  situsAddress: string | null,
  ring: unknown,
  ctx: CertGradeContext,
  isBlock13Mode = false,
): Promise<ParcelGradeResult> {
  const { sql, storage, roads, descriptor } = ctx;
  const parcelResult: ParcelGradeResult = { pass: false, gates: {}, edges: [] };

  const [zfRow] = await sql`
    SELECT body FROM atoms WHERE entity_type = 'zoning-fact'
      AND body->>'parcelNodeId' = ${parcelNodeId}
    ORDER BY updated_at DESC NULLS LAST LIMIT 1
  `;

  const [envRow] = await sql`
    SELECT body FROM atoms
    WHERE entity_type = 'buildable-envelope'
      AND body->>'parcelNodeId' = ${parcelNodeId}
      AND body->>'depthWarmPromotion' = ${DEPTH_WARM_PROMOTION_MARKER}
    ORDER BY updated_at DESC NULLS LAST LIMIT 1
  `;
  let insetRing = envRow?.body?.geojson?.features?.[0]?.geometry?.coordinates?.[0];
  if (!insetRing?.length && !isBlock13Mode) {
    const [fallback] = await sql`
      SELECT body FROM atoms
      WHERE entity_type = 'buildable-envelope' AND body->>'parcelNodeId' = ${parcelNodeId}
      ORDER BY updated_at DESC NULLS LAST LIMIT 1
    `;
    insetRing = fallback?.body?.geojson?.features?.[0]?.geometry?.coordinates?.[0];
  }
  if (!insetRing?.length) {
    parcelResult.error = "no-promoted-envelope-geojson";
    return parcelResult;
  }

  const [srRow] = await sql`
    SELECT body FROM atoms WHERE entity_type = 'setback-rule'
      AND body->>'parcelNodeId' = ${parcelNodeId}
    ORDER BY updated_at DESC NULLS LAST LIMIT 1
  `;
  const zoningFact = zfRow?.body ?? null;
  const setbackRule = srRow?.body ?? null;

  let boundaryEdgesRaw: Awaited<ReturnType<typeof readBoundaryEdgesForParcel>> | null = null;
  try {
    boundaryEdgesRaw = await readBoundaryEdgesForParcel(storage, parcelNodeId);
  } catch (e) {
    if (!(e instanceof BoundaryPrimitiveMissingError)) throw e;
  }

  return gradeAgainstKeyResolved(
    parcelNodeId,
    key,
    situsAddress,
    ring,
    { zoningFact, setbackRule, insetRing, boundaryEdges: boundaryEdgesRaw, roads, descriptor },
    isBlock13Mode,
  );
}

/**
 * Pure, DB-free grading body (2026-08-07, block13 offline-fixture fix). Takes
 * every value gradeAgainstKey previously fetched live (zoningFact,
 * setbackRule, insetRing, boundaryEdges) as plain resolved data instead of
 * sql/storage handles, so this exact function — the SAME one the live
 * block13/query-mode graders call, not a re-derived copy — can run against a
 * frozen fixture in CI with no DB/network dependency. This is what closes
 * the gap the master planner flagged: a block13 regression (the
 * 34121/34161 R32 fossil-cohort defect) was only ever caught by a live,
 * manually-dispatched run; this function is the seam that makes an offline
 * regression test possible without duplicating the grading logic.
 */
export function gradeAgainstKeyResolved(
  parcelNodeId: string,
  key: { district: string; F: number; S: number; C: number | null; R: number; frontStreet: string | null },
  situsAddress: string | null,
  ring: unknown,
  resolved: {
    zoningFact: { district?: string } | null;
    setbackRule: {
      districtCode?: string;
      front?: number;
      rear?: number;
      side?: number;
      sideInteriorFt?: number;
      sideCornerFt?: number;
    } | null;
    insetRing: unknown;
    boundaryEdges: Awaited<ReturnType<typeof readBoundaryEdgesForParcel>> | null;
    roads: unknown[];
    descriptor: unknown;
  },
  isBlock13Mode = false,
): ParcelGradeResult {
  const { roads, descriptor } = resolved;
  const insetRing = resolved.insetRing as never;
  const parcelResult: ParcelGradeResult = { pass: false, gates: {}, edges: [] };
  if (!(insetRing as { length?: number } | null)?.length) {
    parcelResult.error = "no-promoted-envelope-geojson";
    return parcelResult;
  }
  const zoningFact = resolved.zoningFact;
  const setbackRule = resolved.setbackRule;

  const servedDistrict = zoningFact?.district ?? setbackRule?.districtCode ?? null;
  const districtOk =
    (setbackRule?.districtCode == null ||
      setbackRule.districtCode.split(/\s+/)[0] === key.district) &&
    (zoningFact?.district == null ||
      zoningFact.district.split(/\s+/)[0] === key.district ||
      setbackRule?.districtCode?.split(/\s+/)[0] === key.district);

  const servedSetbacks = setbackRule
    ? {
        front: setbackRule.front,
        rear: setbackRule.rear,
        side: setbackRule.sideInteriorFt ?? setbackRule.side,
        sideCorner: setbackRule.sideCornerFt,
      }
    : null;
  const setbackServedOk =
    !!servedSetbacks &&
    servedSetbacks.front === key.F &&
    servedSetbacks.rear === key.R &&
    servedSetbacks.side === key.S &&
    (key.C == null || servedSetbacks.sideCorner === key.C);

  const labelResult = labelEdgesFromRoads({ parcelRing: ring as never, roads: roads as never, situsAddress });
  const freshLabels = labelResult.ok ? labelResult.edgeLabels : [];

  let boundaryEdges: Awaited<ReturnType<typeof readBoundaryEdgesForParcel>> | null =
    resolved.boundaryEdges;
  if (boundaryEdges?.length) {
    const ringVerts = openRing(ring as never).length;
    if (boundaryEdges.length > ringVerts) {
      boundaryEdges = boundaryEdges.filter((e) => e.edgeIndex < ringVerts);
    } else if (boundaryEdges.length < ringVerts) {
      boundaryEdges = null;
    }
  }
  // R28 — recompute primitive when stored normals disagree with BCAD ring.
  if (boundaryEdges?.length) {
    const ringVerts = openRing(ring as never).length;
    if (boundaryEdges.length === ringVerts) {
      const agree = primitiveNormalsAgreeWithRing(boundaryEdges, ring as never);
      if (!agree.ok) {
        const rebuilt = recomputeBoundaryEdgesForRing({
          storedEdges: boundaryEdges,
          ring: ring as never,
          roads: roads as never,
        });
        const rebuiltAgree = primitiveNormalsAgreeWithRing(rebuilt, ring as never);
        boundaryEdges = rebuiltAgree.ok ? rebuilt : null;
      }
    }
  }
  if (boundaryEdges?.length && labelResult.ok) {
    boundaryEdges = relabelBoundaryEdgesFromRoadLabels({
      storedEdges: boundaryEdges,
      edgeLabels: freshLabels,
      roads: roads as never,
      countyFips: CERT_GRADE_COUNTY_FIPS,
    });
  }

  let warmCandidate: ReturnType<typeof computeWarmCandidateFromBoundary> | ReturnType<typeof computeWarmCandidate> | null = null;
  if (boundaryEdges?.length) {
    warmCandidate = computeWarmCandidateFromBoundary({
      parcelNodeId,
      district: key.district,
      parcelRing: ring as never,
      boundaryEdges,
      roads: roads as never,
      descriptor: descriptor as never,
    });
  }
  // Edge-count mismatch (TXGIO primitive vs BCAD ring): warm uses road-label path.
  if ((!warmCandidate || (warmCandidate as { empty?: boolean }).empty) && labelResult.ok) {
    warmCandidate = computeWarmCandidate({
      parcelNodeId,
      district: key.district,
      parcelRing: ring as never,
      descriptor: descriptor as never,
      roads: roads as never,
      edgeLabels: freshLabels.map((e) => ({
        index: e.index,
        label: e.label,
        roadClass: e.roadClass,
        osmHighwayTag: e.osmHighwayTag,
        osmSurfaceTag: e.osmSurfaceTag,
        roadProvenanceKind: e.roadProvenanceKind,
      })),
    });
  }

  let setbackGate: { pass: boolean; reasons: string[] } = { pass: false, reasons: ["no-warm-candidate"] };
  let engineOrient: { pass: boolean; reasons?: string[] } = { pass: false, reasons: ["no-warm-candidate"] };
  if (warmCandidate) {
    const full = verifyWarmCandidateMechanically(warmCandidate as never, descriptor as never, {
      situsAddress,
      roads: roads as never,
    });
    setbackGate = full.gates.setbackEdgeDistance;
    engineOrient = verifyFrontEdgeOrientation(warmCandidate as never, descriptor as never, {
      situsAddress,
      roads: roads as never,
    });
  }

  const freshFront = freshLabels.find((e) => e.label === "front");
  const answerFrontToken = isBlock13Mode ? key.frontStreet : (key.frontStreet ?? situsFrontStreetToken(situsAddress));
  let frontStreetResolved: string | null = null;
  let frontFacesAnswer = !answerFrontToken;
  if (freshFront && answerFrontToken) {
    const backingRoad = (roads as Array<{ osmWayId: unknown; name?: string }>).find(
      (r) => r.osmWayId === freshFront.osmWayId,
    ) ?? null;
    frontStreetResolved = backingRoad?.name ?? null;
    if (frontStreetResolved) {
      frontFacesAnswer = streetNamesMatchForFacesAnswer(answerFrontToken, frontStreetResolved);
    }
  }

  const r32Measured = measurePerEdgeInsetForRings(ring as never, insetRing) ?? [];
  const nEdges = openRing(ring as never).length;
  const miterPointsWgs84 = (warmCandidate as { miterPointsWgs84?: unknown } | null)
    ?.miterPointsWgs84 as never;
  let insetGatePass = true;
  for (let i = 0; i < nEdges; i++) {
    const role =
      freshLabels.find((e) => e.index === i)?.label ??
      (warmCandidate as { edges?: Array<{ index: number; label: string }> } | null)?.edges?.find(
        (e) => e.index === i,
      )?.label ??
      boundaryEdges?.find((e) => e.edgeIndex === i)?.role ??
      "?";
    const expected = expectedFtForRole(role, key);
    const measured = r32Measured[i];
    const r32 = measured?.insetFeet ?? null;

    // Honest non-comparable edge — MUST mirror verifyR32PerEdgeInset
    // (cert-equivalent-gates.ts) exactly, per this module's header rule
    // ("Both reuse the identical gate logic"): measure-inset.ts's
    // ownership-arbitration rewrite (PR #269/#270) reports
    // satisfiedByMoreRestrictiveNeighbor: true, or matched:false near a
    // real notch-collapse miter point, when this lot edge's own boundary
    // segment is legitimately not independently measurable (satisfied by
    // containment, or folded into a neighbor's corner join) — the
    // insetFeet value in that case is a NEIGHBOR's leftover unowned
    // candidate, not a measurement of this edge, and must never be
    // compared against this edge's own expected setback. Root cause of
    // the 48021:34121 / 48021:34161 block13 regression (2026-08-07): this
    // loop measured via the same measurePerEdgeInsetForRings but never
    // applied either check, so it graded that leftover number as if it
    // were a real measurement.
    const honestNonComparable =
      !!measured &&
      !measured.matched &&
      (measured.satisfiedByMoreRestrictiveNeighbor === true ||
        edgeMidpointNearKnownMiterPoint(ring as never, i, miterPointsWgs84));

    const edgeOk =
      honestNonComparable || (r32 != null && Math.abs(r32 - expected) <= CERT_GRADE_INSET_TOL_FT);
    if (!edgeOk) insetGatePass = false;
    parcelResult.edges.push({
      edgeIndex: i,
      role,
      expectedFt: expected,
      r32IndexMatched_ft: r32 == null ? null : Number(r32.toFixed(2)),
      insetPass: edgeOk,
      ...(honestNonComparable ? { honestNonComparable: true } : {}),
    });
  }

  const r35NoFrontage = isNoDeterminableFrontageSitus(situsAddress);

  parcelResult.gates = {
    district: {
      pass: districtOk,
      served: servedDistrict,
      servedSetbackRuleDistrict: setbackRule?.districtCode ?? null,
      expected: key.district,
    },
    setbacks: {
      pass: setbackServedOk && setbackGate.pass,
      served: servedSetbacks,
      expected: { front: key.F, rear: key.R, side: key.S, sideCorner: key.C },
      engineVerifyPass: setbackGate.pass,
    },
    perEdgeInset: { pass: insetGatePass },
    frontOrientation: {
      pass: r35NoFrontage || (frontFacesAnswer && engineOrient.pass),
      frontStreetResolved,
      answerFrontStreet: answerFrontToken,
      facesAnswer: frontFacesAnswer,
      engineOrientPass: engineOrient.pass,
      orientationHonestDecline: r35NoFrontage ? R35_ORIENTATION_DECLINE : null,
    },
  };

  if (r35NoFrontage) {
    parcelResult.orientationHonestDecline = R35_ORIENTATION_DECLINE;
  }

  parcelResult.pass =
    districtOk &&
    setbackServedOk &&
    setbackGate.pass &&
    insetGatePass &&
    (r35NoFrontage || (frontFacesAnswer && engineOrient.pass));

  return parcelResult;
}
