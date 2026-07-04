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

import type {
  AtomLink,
  CodeAtomEntityType,
  CodeAtomInstance,
} from "@hauska-engine/atoms";
import type { Scope } from "@hauska-engine/atom-contract-pin";
import type {
  AccessPolicy,
  AtomSearchResult,
  JurisdictionStatusSnapshot,
  StoragePort,
  StructuralGraphStore,
} from "@hauska-engine/storage";

import { resolveEffectiveRule, type EffectiveSection } from "./effective-rule.js";
import { getAtomTrace, type AtomTraceOutput } from "./atom-trace.js";
import { resolveEditionAtDate, type EditionAtDateResult } from "./edition-at-date.js";
import {
  queryEventsAffectingSubject,
  writeWouldAffectEdge,
} from "./events-affecting-subject.js";

export * from "./effective-rule.js";
export * from "./atom-trace.js";
export * from "./edition-at-date.js";
export * from "./events-affecting-subject.js";

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
  atom: CodeAtomInstance | null;
  /** Composition-resolved children when `includeComposition === true`. */
  composition?: ReadonlyArray<{
    link: AtomLink;
    atom: CodeAtomInstance | null;
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

export class HybridRetrieval {
  constructor(
    private readonly storage: StoragePort,
    private readonly structuralGraph?: StructuralGraphStore,
  ) {}

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
    let atom: CodeAtomInstance | null = null;
    if (input.atomDid) {
      atom = await this.storage.getAtomByDid(input.atomDid);
    } else if (input.entityType && input.entityId) {
      atom = await this.storage.getAtom(input.entityType, input.entityId);
    }
    if (!atom) return { atom: null };
    if (!input.includeComposition) return { atom };
    const atomDid = input.atomDid ?? "";
    const composition = atom
      ? await this.storage.traverse(atomDid)
      : [];
    return {
      atom,
      composition: composition.map((edge) => ({
        link: {
          fromEntityType: edge.fromEntityType,
          fromEntityId: edge.fromEntityId,
          toEntityType: edge.toEntityType,
          toEntityId: edge.toEntityId,
          linkType: edge.linkType,
          ...(edge.context ? { context: edge.context } : {}),
        },
        atom: edge.toAtom,
      })),
    };
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

  /** TCE — what events would affect a subject (walk would_affect edges). */
  async eventsAffectingSubject(targetSubjectId: string) {
    if (!this.structuralGraph) {
      throw new Error("StructuralGraphStore not configured on HybridRetrieval");
    }
    return queryEventsAffectingSubject(this.structuralGraph, targetSubjectId);
  }

  /** TCE — write an immutable would_affect edge (evt_ source required). */
  async writeWouldAffect(
    edge: import("@hauska-engine/atom-contract-pin/tce").WouldAffectEdge,
  ) {
    if (!this.structuralGraph) {
      throw new Error("StructuralGraphStore not configured on HybridRetrieval");
    }
    return writeWouldAffectEdge(this.structuralGraph, edge);
  }
}
