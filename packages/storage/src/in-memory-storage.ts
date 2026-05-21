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
import { CORPUS_SNAPSHOT_FORMAT, type CorpusSnapshot } from "./snapshot.js";

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
    const tokens = tokenize(q);
    const limit = Math.max(1, Math.min(query.limit ?? 25, 100));
    const results: AtomSearchResult[] = [];
    for (const [atomDid, inst] of this.atoms) {
      if (query.jurisdiction && inst.jurisdictionTenant !== query.jurisdiction) {
        continue;
      }
      if (query.entityType && inst.entityType !== query.entityType) continue;
      const snippet = buildSnippet(inst);
      const lowerSnippet = snippet.toLowerCase();
      // Token-based scoring: count how many query tokens appear in the
      // snippet. Pure substring match was too brittle ("B3 Code" in
      // query doesn't substring-match "(B3) Code" in body). Tokenize
      // by punctuation + whitespace so parens, dashes, periods don't
      // sink retrieval.
      if (q.length === 0) {
        results.push(buildResult(atomDid, inst, snippet, 1));
        continue;
      }
      if (tokens.length === 0) continue;
      let matched = 0;
      for (const t of tokens) {
        if (lowerSnippet.includes(t)) matched++;
      }
      if (matched === 0) continue;
      // Section-number anchor boost: when the user includes the
      // atom's section number in the query (e.g. "Section 503
      // ignition resistant" or "2.3 SLR district"), that atom ranks
      // higher than peers sharing topic tokens but not the number.
      // Boost is small enough that a fully-matching atom still wins;
      // acts as a deterministic tiebreaker. Also matches against the
      // `#partN`-stripped form so a query like "4.4 PUD" anchors atom
      // whose sectionNumber is "4.4#part1" (legacy ingest splits
      // over-cap sections via the #partN convention).
      //
      // Match is token-equality (not substring) so short labels like
      // Roman numerals ("I", "V", "X") don't mis-fire as substring hits
      // inside English words ("drainage", "service", "tax"). The
      // tokenizer preserves dots, so "1.1.001" stays a single token.
      let bonus = 0;
      if (inst.entityType === "code-section" && inst.sectionNumber) {
        // Strip trailing punctuation (Municode atomization can carry
        // "36-7." with trailing period; queries naturally drop it) plus
        // the `#partN` ingest-artifact suffix.
        const sectionLower = inst.sectionNumber
          .toLowerCase()
          .replace(/[.,;:!?]+$/, "");
        if (sectionLower) {
          if (tokens.includes(sectionLower)) {
            bonus += 0.25;
          } else {
            const stripped = sectionLower.split("#")[0];
            if (
              stripped &&
              stripped !== sectionLower &&
              tokens.includes(stripped)
            ) {
              bonus += 0.25;
            }
          }
        }
      }
      const score = matched / tokens.length + bonus;
      results.push(buildResult(atomDid, inst, snippet, score));
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

  async getSectionsBySectionNumber(
    jurisdictionTenant: string,
    sectionNumber: string,
  ): Promise<ReadonlyArray<Extract<CodeAtomInstance, { entityType: "code-section" }>>> {
    const out: Array<Extract<CodeAtomInstance, { entityType: "code-section" }>> = [];
    for (const inst of this.atoms.values()) {
      if (inst.entityType !== "code-section") continue;
      if (inst.jurisdictionTenant !== jurisdictionTenant) continue;
      if (inst.sectionNumber !== sectionNumber) continue;
      out.push(inst);
    }
    return out;
  }

  async listJurisdictionStatus(filter?: {
    qualityBarOnly?: boolean;
    accessPolicies?: ReadonlyArray<import("@hauska-engine/atoms").AccessPolicy>;
  }): Promise<ReadonlyArray<JurisdictionStatusSnapshot>> {
    let snapshots = Array.from(this.jurisdictionStatus.values());
    if (filter?.qualityBarOnly) {
      snapshots = snapshots.filter((s) => s.qualityBar.startsWith("passing"));
    }
    if (filter?.accessPolicies && filter.accessPolicies.length > 0) {
      const allowed = new Set(filter.accessPolicies);
      // Absent accessPolicy is treated as "public-free" per port docs.
      snapshots = snapshots.filter((s) =>
        allowed.has(s.accessPolicy ?? "public-free"),
      );
    }
    return snapshots;
  }

  async upsertJurisdictionStatus(snapshot: JurisdictionStatusSnapshot): Promise<void> {
    this.jurisdictionStatus.set(snapshot.jurisdictionTenant, snapshot);
  }

  /**
   * Serialize the full corpus to a committable snapshot artifact.
   * Atoms and links are emitted verbatim; CIDs are intentionally NOT
   * carried — `importSnapshot` re-pins, recomputing each CID
   * deterministically from `contentHash`, so a snapshot round-trip is
   * stable without persisting a transient CID map.
   */
  exportSnapshot(provenance?: ReadonlyArray<string>): CorpusSnapshot {
    return {
      format: CORPUS_SNAPSHOT_FORMAT,
      generatedAt: new Date().toISOString(),
      ...(provenance ? { provenance } : {}),
      atoms: Array.from(this.atoms.values()),
      links: [...this.links],
      jurisdictionStatus: Array.from(this.jurisdictionStatus.values()),
    };
  }

  /**
   * Hydrate this storage from a snapshot. Reuses `writeAtoms` /
   * `writeAtomLinks` / `upsertJurisdictionStatus` so a hydrated storage
   * is indistinguishable from one populated by a live ingest run.
   */
  async importSnapshot(snapshot: CorpusSnapshot): Promise<void> {
    await this.writeAtoms(snapshot.atoms);
    await this.writeAtomLinks(snapshot.links);
    for (const status of snapshot.jurisdictionStatus) {
      await this.upsertJurisdictionStatus(status);
    }
  }

  /** Convenience constructor: a storage hydrated from a snapshot. */
  static async fromSnapshot(snapshot: CorpusSnapshot): Promise<InMemoryStorage> {
    const storage = new InMemoryStorage();
    await storage.importSnapshot(snapshot);
    return storage;
  }
}

function tokenize(s: string): ReadonlyArray<string> {
  // Preserve dots AND hyphens so compound section labels survive
  // intact: "36-7", "46-1", "5.04(b)", "R301.1" all stay single tokens.
  // Without `-` in the keep-set the anchor-boost match for Municode-
  // style chapter-number labels (e.g. "36-7.") would never fire.
  return s
    .split(/[^a-z0-9.-]+/i)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= 2);
}

function buildResult(
  atomDid: string,
  inst: CodeAtomInstance,
  snippet: string,
  score: number,
): AtomSearchResult {
  return {
    atomDid,
    entityType: inst.entityType,
    entityId: inst.entityId,
    jurisdictionTenant: inst.jurisdictionTenant,
    sectionNumber: inst.entityType === "code-section" ? inst.sectionNumber : null,
    snippet,
    score,
  };
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
