/**
 * In-memory StoragePort implementation.
 *
 * Backs tests + the retrieval-api dev mode. Production Postgres + IPFS
 * implementation lives in a sibling file (lands with the storage
 * migration sprint; this in-memory version satisfies the same port
 * so retrieval-api endpoints can be exercised end-to-end pre-Postgres).
 */

import { buildAtomDid, type AtomLink } from "@hauska-engine/atoms";
import type { CodeAtomInstance } from "@hauska-engine/atoms";

import { HotCache, InProcessIpfsPin } from "./in-process-cache.js";
import type {
  AtomQuery,
  AtomSearchResult,
  JurisdictionStatusSnapshot,
  StoragePort,
} from "./port.js";

export class InMemoryStorage implements StoragePort {
  private readonly atoms = new Map<string, CodeAtomInstance>();
  /** atomDid -> cid */
  private readonly cids = new Map<string, string>();
  private readonly links: AtomLink[] = [];
  private readonly jurisdictionStatus = new Map<string, JurisdictionStatusSnapshot>();
  private readonly cache = new HotCache();
  private readonly ipfs = new InProcessIpfsPin();

  async writeAtom(
    instance: CodeAtomInstance,
  ): Promise<{ atomDid: string; cid: string }> {
    const atomDid = buildAtomDid(instance.entityType, instance.entityId).raw;
    const pin = await this.ipfs.pin(instance.contentHash, JSON.stringify(instance));
    this.atoms.set(atomDid, instance);
    this.cids.set(atomDid, pin.cid);
    this.cache.set(atomDid, instance);
    return { atomDid, cid: pin.cid };
  }

  async writeAtoms(
    instances: ReadonlyArray<CodeAtomInstance>,
  ): Promise<ReadonlyArray<{ atomDid: string; cid: string }>> {
    const out: Array<{ atomDid: string; cid: string }> = [];
    for (const inst of instances) {
      out.push(await this.writeAtom(inst));
    }
    return out;
  }

  async writeAtomLinks(links: ReadonlyArray<AtomLink>): Promise<void> {
    for (const link of links) {
      const exists = this.links.some(
        (l) =>
          l.fromEntityId === link.fromEntityId &&
          l.fromEntityType === link.fromEntityType &&
          l.toEntityId === link.toEntityId &&
          l.toEntityType === link.toEntityType &&
          l.linkType === link.linkType,
      );
      if (!exists) this.links.push(link);
    }
  }

  async getAtom<T extends CodeAtomInstance>(
    entityType: T["entityType"],
    entityId: string,
  ): Promise<T | null> {
    const atomDid = buildAtomDid(entityType, entityId).raw;
    const cached = this.cache.get(atomDid);
    if (cached) return cached as T;
    const inst = this.atoms.get(atomDid);
    return (inst as T | undefined) ?? null;
  }

  async getAtomByDid(atomDid: string): Promise<CodeAtomInstance | null> {
    const cached = this.cache.get(atomDid);
    if (cached) return cached;
    return this.atoms.get(atomDid) ?? null;
  }

  async search(query: AtomQuery): Promise<ReadonlyArray<AtomSearchResult>> {
    const q = (query.q ?? "").toLowerCase().trim();
    const limit = Math.max(1, Math.min(query.limit ?? 25, 100));
    const results: AtomSearchResult[] = [];
    for (const [atomDid, inst] of this.atoms) {
      if (query.jurisdiction && inst.jurisdictionTenant !== query.jurisdiction) {
        continue;
      }
      if (query.entityType && inst.entityType !== query.entityType) continue;
      const snippet = buildSnippet(inst);
      if (q && !snippet.toLowerCase().includes(q)) continue;
      results.push({
        atomDid,
        entityType: inst.entityType,
        entityId: inst.entityId,
        jurisdictionTenant: inst.jurisdictionTenant,
        sectionNumber: inst.entityType === "code-section" ? inst.sectionNumber : null,
        snippet,
        score: q ? scoreMatch(snippet.toLowerCase(), q) : 1,
      });
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  async traverse(
    fromAtomDid: string,
    linkType?: AtomLink["linkType"],
  ): Promise<ReadonlyArray<AtomLink & { toAtom: CodeAtomInstance | null }>> {
    const out: Array<AtomLink & { toAtom: CodeAtomInstance | null }> = [];
    for (const link of this.links) {
      const fromDid = buildAtomDid(link.fromEntityType, link.fromEntityId).raw;
      if (fromDid !== fromAtomDid) continue;
      if (linkType && link.linkType !== linkType) continue;
      const toDid = buildAtomDid(link.toEntityType, link.toEntityId).raw;
      out.push({ ...link, toAtom: this.atoms.get(toDid) ?? null });
    }
    return out;
  }

  async listJurisdictionStatus(filter?: {
    qualityBarOnly?: boolean;
  }): Promise<ReadonlyArray<JurisdictionStatusSnapshot>> {
    const snapshots = Array.from(this.jurisdictionStatus.values());
    if (!filter?.qualityBarOnly) return snapshots;
    return snapshots.filter((s) => s.qualityBar.startsWith("passing"));
  }

  async upsertJurisdictionStatus(snapshot: JurisdictionStatusSnapshot): Promise<void> {
    this.jurisdictionStatus.set(snapshot.jurisdictionTenant, snapshot);
  }
}

function buildSnippet(inst: CodeAtomInstance): string {
  switch (inst.entityType) {
    case "code-section":
      return `${inst.sectionNumber} ${inst.title}. ${inst.bodyText}`;
    case "code-definition":
      return `${inst.term} — ${inst.definitionText}`;
    case "code-cross-reference":
      return `${inst.referenceText} (${inst.referenceType})`;
    case "code-amendment":
      return `Ordinance ${inst.ordinanceId}: ${inst.amendmentText}`;
    case "code-edition":
      return inst.editionLabel;
    case "jurisdiction-corpus":
      return inst.jurisdictionName;
    default: {
      const exhaustive: never = inst;
      return String(exhaustive);
    }
  }
}

function scoreMatch(haystack: string, needle: string): number {
  if (!needle) return 0;
  const i = haystack.indexOf(needle);
  if (i < 0) return 0;
  // Prefer earlier matches + shorter haystacks.
  return 1 - i / haystack.length;
}
