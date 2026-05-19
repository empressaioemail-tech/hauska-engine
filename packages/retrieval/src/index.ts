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
import type {
  AccessPolicy,
  AtomSearchResult,
  JurisdictionStatusSnapshot,
  StoragePort,
} from "@hauska-engine/storage";

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
  constructor(private readonly storage: StoragePort) {}

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
