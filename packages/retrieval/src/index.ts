/**
 * @hauska-engine/retrieval
 *
 * Hybrid retrieval query layer per ADR-010 §4 (pre-expansion +
 * tool-call traversal). Consumed by `services/retrieval-api`.
 *
 * v1 implementation orchestrates structural search (storage.search) +
 * graph traversal (storage.traverse). Vector similarity lands behind
 * the same interface once pgvector + embedding pipeline are wired.
 */

import { isPropertyAtomInstance, isRoadNodeAtomInstance, buildAtomDid } from "@hauska-engine/atoms";
import type {
  AtomLink,
  CodeAtomEntityType,
  StoredAtomInstance,
} from "@hauska-engine/atoms";
import type { Scope } from "@hauska-engine/atom-contract-pin";
import {
  applyPropertyCalibrationAtRead,
  applyStoredAtomCalibrationAtRead,
  type CalibrationOverlayPort,
} from "@hauska-engine/engine-core/property-reasoning";
import type {
  AccessPolicy,
  AtomSearchResult,
  JurisdictionStatusSnapshot,
  StoragePort,
} from "@hauska-engine/storage";

import { resolveEffectiveRule, type EffectiveSection } from "./effective-rule.js";
import { getAtomTrace, type AtomTraceOutput } from "./atom-trace.js";
import { resolveEditionAtDate, type EditionAtDateResult } from "./edition-at-date.js";

export * from "./effective-rule.js";
export * from "./atom-trace.js";
export * from "./edition-at-date.js";

export interface SearchInput {
  q: string;
  jurisdiction?: string;
  entityType?: CodeAtomEntityType;
  limit?: number;
}

export interface SearchOutput {
  results: ReadonlyArray<AtomSearchResult>;
  totalCandidates: number;
}

export interface GetAtomInput {
  atomDid?: string;
  entityType?: CodeAtomEntityType;
  entityId?: string;
  includeComposition?: boolean;
}

export interface GetAtomOutput {
  /** Code-section or property reasoning atom (Gate C serves both). */
  atom: StoredAtomInstance | null;
  /** Composition-resolved children when `includeComposition === true`. */
  composition?: ReadonlyArray<{
    link: AtomLink;
    atom: StoredAtomInstance | null;
  }>;
}

export interface PropertyAtomChainWire {
  parcelNodeId: string;
  zoningFact: StoredAtomInstance | null;
  setbackRule: StoredAtomInstance | null;
  buildableEnvelope: StoredAtomInstance | null;
  atoms: ReadonlyArray<{
    did: string;
    type: string;
    kind: string;
    accessPolicy: string;
    payload: StoredAtomInstance;
  }>;
}

export interface RoadAtomChainWire {
  roadNodeId: string;
  roadNode: StoredAtomInstance | null;
  atoms: ReadonlyArray<{
    did: string;
    type: string;
    kind: string;
    accessPolicy: string;
    payload: StoredAtomInstance;
  }>;
}

export interface QueryJurisdictionInput {
  jurisdictionTenant: string;
  queryType?: "summary" | "permits";
  projectType?: string;
}

export interface QueryJurisdictionOutput {
  status: JurisdictionStatusSnapshot | null;
  /** Used for `/jurisdictions/:id/permits?projectType=` (renamed `search_permit_atoms` target). */
  permitAtoms?: ReadonlyArray<AtomSearchResult>;
}

export interface HybridRetrievalOptions {
  /**
   * Optional migration-0037 overlay port (cortex Neon). When set, property
   * atom READ paths resolve `calibratedConfidence` via overlay keyed on
   * parcel node / atom DID. Absent → served atoms keep asserted placeholders.
   */
  calibrationOverlay?: CalibrationOverlayPort | null;
}

export class HybridRetrieval {
  private readonly overlay: CalibrationOverlayPort | null;

  constructor(
    private readonly storage: StoragePort,
    options: HybridRetrievalOptions = {},
  ) {
    this.overlay = options.calibrationOverlay ?? null;
  }

  async search(input: SearchInput): Promise<SearchOutput> {
    const baseQuery: import("@hauska-engine/storage").AtomQuery = {
      ...(input.q.length > 0 ? { q: input.q } : {}),
      ...(input.jurisdiction ? { jurisdiction: input.jurisdiction } : {}),
      ...(input.entityType ? { entityType: input.entityType } : {}),
      limit: input.limit ?? 25,
    };
    const results = await this.storage.search(baseQuery);
    return { results, totalCandidates: results.length };
  }

  async getAtom(input: GetAtomInput): Promise<GetAtomOutput> {
    let atom: StoredAtomInstance | null = null;
    if (input.atomDid) {
      atom = await this.storage.getAtomByDid(input.atomDid);
    } else if (input.entityType && input.entityId) {
      atom = await this.storage.getAtom(input.entityType, input.entityId);
    }
    if (!atom) return { atom: null };
    atom = await applyStoredAtomCalibrationAtRead(atom, this.overlay);
    if (!input.includeComposition) return { atom };
    const atomDid =
      input.atomDid ??
      (isPropertyAtomInstance(atom)
        ? (atom.atomDid ?? buildAtomDid(atom.entityType, atom.entityId).raw)
        : buildAtomDid(atom.entityType, atom.entityId).raw);
    const composition = await this.storage.traverse(atomDid);
    return {
      atom,
      composition: await Promise.all(
        composition.map(async (edge) => ({
          link: {
            fromEntityType: edge.fromEntityType,
            fromEntityId: edge.fromEntityId,
            toEntityType: edge.toEntityType,
            toEntityId: edge.toEntityId,
            linkType: edge.linkType,
            ...(edge.context ? { context: edge.context } : {}),
          },
          atom: edge.toAtom
            ? await applyStoredAtomCalibrationAtRead(edge.toAtom, this.overlay)
            : null,
        })),
      ),
    };
  }

  /**
   * Resolve zoning-fact → setback-rule → buildable-envelope for a parcel node.
   * Always-on storage read; empty slots when no PROPERTY_ATOM_PATH rows exist.
   * Calibrated axis resolves at READ via overlay (I-E / Master WDLL 3.10).
   */
  async getPropertyAtomChain(parcelNodeId: string): Promise<PropertyAtomChainWire> {
    const rows = await this.storage.listPropertyAtomsByParcelNodeId(parcelNodeId);
    const resolved = await Promise.all(
      rows.map((row) =>
        isPropertyAtomInstance(row)
          ? applyPropertyCalibrationAtRead(row, this.overlay)
          : Promise.resolve(row),
      ),
    );
    let zoningFact: StoredAtomInstance | null = null;
    let setbackRule: StoredAtomInstance | null = null;
    let buildableEnvelope: StoredAtomInstance | null = null;
    for (const row of resolved) {
      if (row.entityType === "zoning-fact") zoningFact = row;
      else if (row.entityType === "setback-rule") setbackRule = row;
      else if (row.entityType === "buildable-envelope") buildableEnvelope = row;
    }
    const atoms = resolved.map((payload) => {
      const did =
        typeof payload.atomDid === "string" && payload.atomDid.startsWith("did:")
          ? payload.atomDid
          : buildAtomDid(payload.entityType, payload.entityId).raw;
      return {
        did,
        type: payload.entityType,
        kind: payload.entityType,
        accessPolicy: payload.accessPolicy ?? "public-free",
        payload,
      };
    });
    return {
      parcelNodeId,
      zoningFact,
      setbackRule,
      buildableEnvelope,
      atoms,
    };
  }

  async getRoadAtomChain(roadNodeId: string): Promise<RoadAtomChainWire> {
    const rows = await this.storage.listRoadAtomsByRoadNodeId(roadNodeId);
    const resolved = await Promise.all(
      rows.map((row) =>
        isRoadNodeAtomInstance(row)
          ? applyPropertyCalibrationAtRead(
              row as unknown as import("@hauska-engine/atoms").PropertyAtomInstance,
              this.overlay,
            )
          : Promise.resolve(row),
      ),
    );
    const roadNode = resolved[0] ?? null;
    const atoms = resolved.map((payload) => {
      const did =
        typeof payload.atomDid === "string" && payload.atomDid.startsWith("did:")
          ? payload.atomDid
          : buildAtomDid(payload.entityType, payload.entityId).raw;
      return {
        did,
        type: payload.entityType,
        kind: payload.entityType,
        accessPolicy: payload.accessPolicy ?? "public-free",
        payload,
      };
    });
    return { roadNodeId, roadNode, atoms };
  }

  async queryJurisdiction(
    input: QueryJurisdictionInput,
  ): Promise<QueryJurisdictionOutput> {
    const statuses = await this.storage.listJurisdictionStatus();
    const status =
      statuses.find((s) => s.jurisdictionTenant === input.jurisdictionTenant) ??
      null;
    if (input.queryType === "permits" && input.projectType) {
      const permitAtoms = await this.storage.search({
        q: input.projectType,
        jurisdiction: input.jurisdictionTenant,
        limit: 25,
      });
      return { status, permitAtoms };
    }
    return { status };
  }

  /**
   * Resolve the ADR-019 effective rule for a Layer 1 base section in a
   * jurisdiction: the base section composed with that jurisdiction's
   * Layer 2 overlays. This is the "what does the IRC require for X in
   * jurisdiction Y" query path.
   */
  async resolveEffectiveRule(input: {
    jurisdictionTenant: string;
    baseSectionId: string;
  }): Promise<EffectiveSection> {
    return resolveEffectiveRule(this.storage, input);
  }

  async getAtomTrace(input: {
    atomDid: string;
    audience?: Scope["audience"];
  }): Promise<AtomTraceOutput | null> {
    return getAtomTrace(this.storage, input);
  }

  /** K2 — edition in effect at a historical date for retrodiction. */
  async resolveEditionAtDate(args: {
    jurisdictionTenant: string;
    asOf: string;
  }): Promise<EditionAtDateResult> {
    return resolveEditionAtDate(this.storage, args);
  }

  async listJurisdictions(filter?: {
    qualityBarOnly?: boolean;
    /**
     * Access-policy allow-list (ADR-017 / `@hauska/atom-contract@^1.1.0`).
     * Used by surfaces that gate on visibility:
     * `MCP list_jurisdictions` for unauthenticated callers passes
     * `["public-free"]`. Omitted = no access-policy filter. Snapshots
     * whose `accessPolicy` is absent are treated as `"public-free"`.
     */
    accessPolicies?: ReadonlyArray<AccessPolicy>;
  }): Promise<ReadonlyArray<JurisdictionStatusSnapshot>> {
    return this.storage.listJurisdictionStatus(filter);
  }
}
