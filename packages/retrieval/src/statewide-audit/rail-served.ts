// THE SERVED LAYER, MEASURED ON ALL FOURTEEN RAILS.
//
// WHY THIS FILE EXISTS. The frozen serving-sweep record carries NINE FieldKey
// values: geometry, situsAddress, apn, landUse, zoning, setbacks, envelope,
// flood, frontage. There are FOURTEEN rails. The five never asked about are
// footprint, easement, owner, rrc-wells and rrc-pipelines — and four of those
// five sit in the six-rail set with no scorer at all, so the sweep was blind on
// the SERVED layer for most of the rails already invisible on the other two.
// A three-layer record whose third layer covers nine of fourteen cannot answer
// the question the record exists for. Operator ruling 2026-08-19.
//
// WHAT IT DOES NOT DO. It does not edit the frozen record. `serving-sweep/
// types.ts` stays byte-for-byte; this is an additive second tally computed from
// the same composed body, so the nine-field record and the fourteen-rail record
// come out of one pass over one payload and cannot drift.
//
// AN ABSENCE HERE IS MEASURED, NEVER SKIPPED. For a rail with no slot on the
// sheet, this file does not omit the rail — it inspects the real payload, finds
// no key path that could carry it, and records `no-slot-in-payload` WITH the
// key paths it looked at. `__tests__/rail-served.test.ts` proves every detector
// fires on a payload that does carry its slot, so a zero here is a measurement
// and not a dead gate.

import type { RailKey } from "./types.js";

/**
 * Where a rail sits relative to the served sheet, for ONE parcel.
 *
 * The four values are four different remediations and must never collapse:
 * `served` is fine, `slot-empty` is data or an adapter, `on-wire-not-served` is
 * an adapter reading a field it already receives, and `no-slot-in-payload`
 * means the sheet has no field at all and somebody has to add one.
 */
export type RailServedState =
  /** The composed served body carries a value for this rail. */
  | "served"
  /** A slot exists in the payload and resolves empty for this parcel. */
  | "slot-empty"
  /** The retrieval chain carries the atom and the served body has no slot for it. */
  | "on-wire-not-served"
  /** No key path in the served body could carry this rail. The sheet has no field. */
  | "no-slot-in-payload";

export interface RailServedTally {
  served: number;
  slotEmpty: number;
  onWireNotServed: number;
  noSlotInPayload: number;
}

export function emptyRailTally(): RailServedTally {
  return { served: 0, slotEmpty: 0, onWireNotServed: 0, noSlotInPayload: 0 };
}

/**
 * Lowercase tokens that would appear in a key NAME if the sheet ever carried
 * this rail. Deliberately NOT the bare word "district": the payload already has
 * `facets.zoning.district` and `facets.envelope.district`, and a token matching
 * those would report `mud` as served on every zoned parcel in Texas.
 *
 * THIS LIST IS PART OF THE INSTRUMENT'S CONTRACT (DEV_PROCESS 2.1). A future
 * adapter that surfaces a rail under a name outside these tokens is reported as
 * `no-slot-in-payload` until the token is added here, so the list is published
 * beside every figure it produces and the observed slot paths travel with the
 * county record.
 */
export const RAIL_SLOT_TOKENS: Readonly<Record<RailKey, readonly string[]>> = {
  geometry: ["geojson", "geometry", "ring", "boundary"],
  cad: ["situsaddress", "situscity", "situszip", "situsstate", "apn", "acreage"],
  zoning: ["zoning"],
  roads: ["frontage", "attachingroads", "roadnode", "road"],
  flood: ["flood", "tier2", "sfha", "femazone"],
  envelope: ["envelope", "setback", "buildable"],
  landuse: ["landuse"],
  footprint: ["footprint", "buildingarea", "structure"],
  easement: ["easement"],
  owner: ["owner"],
  "rrc-wells": ["well", "apinumber"],
  "rrc-pipelines": ["pipeline"],
  "rail-corridor": ["railcorridor", "railroad", "corridor"],
  mud: ["specialdistrict", "mud", "waterdistrict", "utilitydistrict", "taxdistrict"],
};

/** The atom family whose presence on the assembled chain counts as on-wire. */
export const RAIL_WIRE_ENTITY_TYPES: Readonly<Record<RailKey, readonly string[]>> = {
  geometry: ["parcel-node"],
  cad: ["cad-parcel-roll"],
  zoning: ["zoning-fact", "setback-rule"],
  roads: ["road-node"],
  flood: ["flood-hazard-fact"],
  envelope: ["buildable-envelope"],
  landuse: ["land-use-fact"],
  footprint: ["building-footprint"],
  easement: ["utility-easement"],
  owner: ["owner-fact"],
  "rrc-wells": ["well-fact"],
  "rrc-pipelines": ["rrc-pipeline-fact"],
  "rail-corridor": ["rail-corridor-fact"],
  mud: ["special-district-fact"],
};

export const ALL_RAIL_KEYS = Object.keys(RAIL_SLOT_TOKENS) as RailKey[];

export interface KeyPathHit {
  path: string;
  leaf: string;
  hasValue: boolean;
}

/**
 * Every key path in the served body, with whether its leaf carries a value.
 *
 * Depth-capped at 6 and array-capped at the first element, because the payload
 * is a fact sheet and not a document store. Both caps are stated because an
 * instrument's exclusion set is part of its contract.
 */
export function keyPathsOf(body: unknown): KeyPathHit[] {
  const out: KeyPathHit[] = [];
  const walk = (node: unknown, path: string, depth: number): void => {
    if (depth > 6) return;
    if (Array.isArray(node)) {
      if (node.length > 0) walk(node[0], `${path}[0]`, depth + 1);
      return;
    }
    if (!node || typeof node !== "object") return;
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      const p = `${path}/${k}`;
      const hasValue =
        v !== null &&
        v !== undefined &&
        !(typeof v === "string" && v.trim() === "") &&
        !(Array.isArray(v) && v.length === 0) &&
        v !== false;
      out.push({ path: p, leaf: k.toLowerCase(), hasValue });
      walk(v, p, depth + 1);
    }
  };
  walk(body, "", 0);
  return out;
}

/**
 * A cheap structural signature so a 13-million-parcel sweep walks a handful of
 * distinct payload SHAPES rather than thirteen million payloads. Two bodies
 * with the same top-level keys, the same facet keys and the same read path have
 * the same key-PATH set by construction; only the VALUES differ, and values are
 * read separately per parcel.
 */
export function shapeSignature(body: Record<string, unknown>): string {
  const facets =
    body.facets && typeof body.facets === "object"
      ? (body.facets as Record<string, unknown>)
      : undefined;
  const keysOf = (o: unknown): string =>
    o && typeof o === "object" ? Object.keys(o as Record<string, unknown>).sort().join(",") : "";
  return [
    Object.keys(body).sort().join(","),
    keysOf(facets),
    keysOf(facets?.envelope),
    keysOf(facets?.baseFacts),
    keysOf(facets?.zoning),
    keysOf(body.tier2),
    String(body.readPath ?? ""),
  ].join("|");
}

/** Which rails this payload SHAPE could carry at all, and under which paths. */
export interface SlotMap {
  pathsByRail: Record<RailKey, string[]>;
}

export function slotMapFor(body: unknown): SlotMap {
  const hits = keyPathsOf(body);
  const pathsByRail = {} as Record<RailKey, string[]>;
  for (const rail of ALL_RAIL_KEYS) {
    const tokens = RAIL_SLOT_TOKENS[rail];
    pathsByRail[rail] = hits
      .filter((h) => tokens.some((t) => h.leaf.includes(t)))
      .map((h) => h.path);
  }
  return { pathsByRail };
}

/** The valued key paths of ONE parcel's body, for the per-parcel value check. */
export function valuedPathsOf(body: unknown): Set<string> {
  const out = new Set<string>();
  for (const h of keyPathsOf(body)) if (h.hasValue) out.add(h.path);
  return out;
}

export interface RailStateInput {
  rail: RailKey;
  slotPaths: readonly string[];
  /** Key paths in THIS parcel's body that carry a value. */
  valuedPaths: ReadonlySet<string>;
  /** Entity types present on this parcel's assembled retrieval chain. */
  chainEntityTypes: ReadonlySet<string>;
  /**
   * True when the sweep's chain read does not cover this rail's family, so
   * on-wire cannot be determined and must NOT be reported as false. An absent
   * probe is not an absence.
   */
  wireProbeUnavailable: boolean;
}

/**
 * PRECEDENCE, and it names the remediation each time:
 *
 *  1. a slot path carries a value                  -> served
 *  2. a slot path exists, none carries a value     -> slot-empty
 *  3. no slot path, the chain carries the atom     -> on-wire-not-served
 *  4. no slot path                                 -> no-slot-in-payload
 *
 * Case 3 is separated from case 4 because they cost different amounts: one is
 * an adapter reading a field it already receives, the other is a new field on
 * the product surface.
 */
export function railServedState(input: RailStateInput): RailServedState {
  const { slotPaths, valuedPaths, chainEntityTypes, rail, wireProbeUnavailable } = input;
  if (slotPaths.length > 0) {
    for (const p of slotPaths) if (valuedPaths.has(p)) return "served";
    return "slot-empty";
  }
  if (!wireProbeUnavailable) {
    for (const t of RAIL_WIRE_ENTITY_TYPES[rail]) {
      if (chainEntityTypes.has(t)) return "on-wire-not-served";
    }
  }
  return "no-slot-in-payload";
}

export function bumpRailTally(t: RailServedTally, s: RailServedState): void {
  if (s === "served") t.served += 1;
  else if (s === "slot-empty") t.slotEmpty += 1;
  else if (s === "on-wire-not-served") t.onWireNotServed += 1;
  else t.noSlotInPayload += 1;
}
