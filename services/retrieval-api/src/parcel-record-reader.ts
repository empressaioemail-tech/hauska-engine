/**
 * P-152 ONE-READER: `GET /property-nodes/:parcelNodeId/record`.
 *
 * Walks the closed 65-rail parcel_record registry for one parcel, decides
 * per-rail `serve` state exactly as legacy-design-tools'
 * `parcelRecordAllowlist.ts` decides it today (record when slated + gate
 * pass; refused when slated + gate refuse/excluded; legacy-transitional
 * for anything unslated), and dereferences an atom when a cell names one.
 * See OPS-23 P-152 dispatch (`_dispatches/2026-09-11_p152-reader_dispatch.md`)
 * for the full contract this implements.
 */

import {
  PARCEL_RECORD_RAIL_KEYS,
  PARCEL_RECORD_RAIL_REGISTRY_SHA,
} from "./parcel-record-rail-registry.js";
import parcelRecordSlateData from "./parcel-record-slate.json" with { type: "json" };
import type { ParcelFactoryStore, ParcelGateVerdictKind } from "./parcel-record-db.js";

const PARCEL_RECORD_SLATE: ReadonlySet<string> = new Set(parcelRecordSlateData.slate);

export type ParcelRecordServeState = "record" | "refused" | "legacy-transitional";

export interface AtomDereference {
  did: string;
  entityType: string;
  body: unknown;
}

/** Minimal seam onto HybridRetrieval.getAtom — decouples this module from the full retrieval package type for testability. */
export interface AtomDereferencer {
  getAtom(input: { atomDid: string }): Promise<{ atom: unknown | null }>;
}

export interface ParcelRecordRailResponse {
  /** The decoded cell_state object verbatim (including 'kind'), or null when no parcel_record_cell row exists for this (place_key, rail_key). Deviation from the dispatch's non-nullable sketch: a rail genuinely can have no row, and fabricating a 'kind' would violate the fail-closed/never-invent-a-value convention this program is built on. Flagged in the close's `contradicted` field. */
  cell: Record<string, unknown> | null;
  gate: { verdict: ParcelGateVerdictKind | null; evaluatedAt: string | null };
  serve: ParcelRecordServeState;
  atom: AtomDereference | null;
  atomBacked: boolean;
  rendering: { text: string; atomVersion: string; vocabVersion: string } | null;
  companions: unknown[];
}

export interface ParcelRecordResponse {
  parcelNodeId: string;
  placeKey: string | null;
  countyFips: string;
  railRegistrySha: string;
  readAt: string;
  rails: Record<string, ParcelRecordRailResponse>;
  refused: { reason: string } | null;
}

function slateKey(countyFips: string, railKey: string): string {
  return `${countyFips}:${railKey}`;
}

/** Candidate field name for a future atom pointer on a cell (P-163 has not landed; no live cell carries one yet). */
function extractAtomDid(cellRaw: Record<string, unknown> | null): string | null {
  if (!cellRaw) return null;
  const v = cellRaw.atomDid;
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}

function asStoredAtom(atom: unknown): AtomDereference | null {
  if (!atom || typeof atom !== "object") return null;
  const rec = atom as Record<string, unknown>;
  const entityType = typeof rec.entityType === "string" ? rec.entityType : "unknown";
  const did =
    typeof rec.atomDid === "string" && rec.atomDid.length > 0
      ? rec.atomDid
      : typeof rec.did === "string"
        ? rec.did
        : "";
  return { did, entityType, body: atom };
}

async function buildRailResponse(
  store: ParcelFactoryStore,
  dereferencer: AtomDereferencer,
  placeKey: string,
  countyFips: string,
  railKey: string,
): Promise<ParcelRecordRailResponse> {
  const [cell, companions] = await Promise.all([
    store.loadCell(placeKey, railKey),
    store.loadCompanionRows(placeKey, railKey),
  ]);

  const slated = PARCEL_RECORD_SLATE.has(slateKey(countyFips, railKey));
  let serve: ParcelRecordServeState = "legacy-transitional";
  let gate: { verdict: ParcelGateVerdictKind | null; evaluatedAt: string | null } = {
    verdict: null,
    evaluatedAt: null,
  };
  if (slated) {
    // Mirror parcelRecordAllowlist.ts's own short-circuit: only touch the
    // verdict store for a pair that could ever resolve to anything but
    // legacy-transitional.
    const verdict = await store.loadGateVerdict(countyFips, railKey);
    if (verdict) {
      gate = { verdict: verdict.verdict, evaluatedAt: verdict.evaluatedAt };
      serve = verdict.verdict === "pass" ? "record" : "refused";
    }
    // slated + no usable verdict: fail closed to legacy-transitional, same
    // as the allowlist's own "in slate + no verdict -> legacy" branch.
  }

  const atomDid = extractAtomDid(cell.raw);
  let atom: AtomDereference | null = null;
  if (atomDid) {
    const result = await dereferencer.getAtom({ atomDid });
    atom = asStoredAtom(result.atom);
  }

  return {
    cell: cell.raw,
    gate,
    serve,
    atom,
    atomBacked: atom !== null,
    rendering: null,
    companions,
  };
}

/**
 * `parcelNodeId`'s prop_id token is already normalizeForJoin'd by
 * convention (dispatch fact). `countyFips`/`normalizedPropId` are the two
 * halves already split by the caller (route-level id validation regex).
 */
export async function readParcelRecord(
  store: ParcelFactoryStore,
  dereferencer: AtomDereferencer,
  parcelNodeId: string,
  countyFips: string,
  normalizedPropId: string,
): Promise<ParcelRecordResponse> {
  const readAt = new Date().toISOString();
  const resolution = await store.resolvePlaceKey(countyFips, normalizedPropId);

  if (resolution.state === "ambiguous") {
    return {
      parcelNodeId,
      placeKey: null,
      countyFips,
      railRegistrySha: PARCEL_RECORD_RAIL_REGISTRY_SHA,
      readAt,
      rails: {},
      refused: {
        reason:
          `crosswalk ambiguous: both ${resolution.candidates.join(" and ")} exist as ` +
          `distinct parcel_record identities for normalized prop_id ${normalizedPropId}. ` +
          `P-161 has not landed a crosswalk rule; refusing rather than guessing which is authoritative.`,
      },
    };
  }

  const placeKey =
    resolution.state === "resolved" ? resolution.placeKey : `${countyFips}:${normalizedPropId}`;

  const rails: Record<string, ParcelRecordRailResponse> = {};
  await Promise.all(
    PARCEL_RECORD_RAIL_KEYS.map(async (railKey) => {
      rails[railKey] = await buildRailResponse(store, dereferencer, placeKey, countyFips, railKey);
    }),
  );

  return {
    parcelNodeId,
    placeKey,
    countyFips,
    railRegistrySha: PARCEL_RECORD_RAIL_REGISTRY_SHA,
    readAt,
    rails,
    refused: null,
  };
}

export { PARCEL_RECORD_SLATE };
