/**
 * Atom trace — E7 spine-console read surface.
 *
 * Given an atom DID, returns context summary, provenance, citations
 * (cross-reference atoms), and traversable outbound/inbound graph edges
 * so an operator can drill from parcel → atom → source.
 */

import type { ConsequenceClassificationInputs } from "@hauska-engine/atoms";
import {
  bootstrapEngineAtomRegistry,
  buildAtomDid,
  isPropertyAtomInstance,
  type AtomInstance,
  type AtomLink,
  type CodeAtomEntityType,
  type CodeAtomInstance,
  type StoredAtomInstance,
} from "@hauska-engine/atoms";
import type { ContextSummary, Scope } from "@hauska-engine/atom-contract-pin";
import { deriveConsequenceStrata } from "@hauska-engine/corpus/consequence";
import type { StoragePort } from "@hauska-engine/storage";

export interface AtomProvenance {
  sourceAdapter: string;
  sourceUrl: string;
  fetchedAt: string;
  contentHash: string;
  atomDid: string;
}

export interface TraceEdge {
  link: AtomLink;
  atom: StoredAtomInstance | null;
  atomDid: string;
}

function asCodeAtom(stored: StoredAtomInstance | null): CodeAtomInstance | null {
  if (!stored || isPropertyAtomInstance(stored)) return null;
  return stored;
}

export interface AtomTraceOutput {
  atom: CodeAtomInstance;
  atomDid: string;
  contextSummary: ContextSummary;
  provenance: AtomProvenance;
  /** F2 classification inputs when present on code-section atoms. */
  consequenceInputs?: ConsequenceClassificationInputs;
  /** F2 strata derived at read — no severity scalar. */
  consequenceStrata: ReadonlyArray<{
    kind: string;
    value: string;
  }>;
  /** Outbound cross-reference atoms linked from this atom. */
  citations: ReadonlyArray<{
    link: AtomLink;
    crossReference: CodeAtomInstance | null;
    crossReferenceDid: string;
    targetAtom: CodeAtomInstance | null;
    targetAtomDid: string | null;
  }>;
  outbound: ReadonlyArray<TraceEdge>;
  inbound: ReadonlyArray<TraceEdge>;
}

function storageLookup(storage: StoragePort) {
  return {
    async get<T extends AtomInstance>(
      entityType: T["entityType"],
      entityId: string,
    ): Promise<T | null> {
      return storage.getAtom(
        entityType as CodeAtomEntityType,
        entityId,
      ) as Promise<T | null>;
    },
  };
}

function provenanceFromAtom(atom: CodeAtomInstance, atomDid: string): AtomProvenance {
  return {
    atomDid,
    sourceAdapter: atom.sourceAdapter,
    sourceUrl: atom.sourceUrl,
    fetchedAt: atom.fetchedAt,
    contentHash: atom.contentHash,
  };
}

async function resolveContextSummary(
  atom: CodeAtomInstance,
  scope: Scope,
  storage: StoragePort,
): Promise<ContextSummary> {
  const registry = bootstrapEngineAtomRegistry({ lookup: storageLookup(storage) });
  const resolved = registry.resolve(atom.entityType);
  if (!resolved.ok) {
    return {
      prose: `${atom.entityType}/${atom.entityId}`,
      typed: { entityType: atom.entityType, entityId: atom.entityId },
      keyMetrics: [],
      relatedAtoms: [],
      historyProvenance: {
        latestEventId: `${atom.entityId}@${atom.contentHash}`,
        latestEventAt: atom.fetchedAt,
      },
      scopeFiltered: false,
    };
  }
  return resolved.registration.contextSummary(atom.entityId, scope);
}

export async function getAtomTrace(
  storage: StoragePort,
  input: { atomDid: string; audience?: Scope["audience"] },
): Promise<AtomTraceOutput | null> {
  const stored = await storage.getAtomByDid(input.atomDid);
  if (!stored || isPropertyAtomInstance(stored)) return null;
  const atom = stored;

  const scope: Scope = { audience: input.audience ?? "user" };
  const contextSummary = await resolveContextSummary(atom, scope, storage);
  const provenance = provenanceFromAtom(atom, input.atomDid);

  const outboundRaw = await storage.traverse(input.atomDid);
  const outbound: TraceEdge[] = outboundRaw.map((edge) => ({
    link: {
      fromEntityType: edge.fromEntityType,
      fromEntityId: edge.fromEntityId,
      toEntityType: edge.toEntityType,
      toEntityId: edge.toEntityId,
      linkType: edge.linkType,
      ...(edge.context ? { context: edge.context } : {}),
    },
    atom: edge.toAtom,
    atomDid: buildAtomDid(edge.toEntityType, edge.toEntityId).raw,
  }));

  const inboundRaw = await storage.traverseInbound(input.atomDid);
  const inbound: TraceEdge[] = inboundRaw.map((edge) => ({
    link: {
      fromEntityType: edge.fromEntityType,
      fromEntityId: edge.fromEntityId,
      toEntityType: edge.toEntityType,
      toEntityId: edge.toEntityId,
      linkType: edge.linkType,
      ...(edge.context ? { context: edge.context } : {}),
    },
    atom: edge.fromAtom,
    atomDid: buildAtomDid(edge.fromEntityType, edge.fromEntityId).raw,
  }));

  const citations: Array<AtomTraceOutput["citations"][number]> = [];
  for (const edge of outbound) {
    if (edge.link.toEntityType !== "code-cross-reference") continue;
    const xref = asCodeAtom(edge.atom);
    const targetSectionId =
      xref && xref.entityType === "code-cross-reference"
        ? xref.toSectionId
        : null;
    const targetAtomDid = targetSectionId
      ? buildAtomDid("code-section", targetSectionId).raw
      : null;
    const targetAtom = targetAtomDid
      ? asCodeAtom(await storage.getAtomByDid(targetAtomDid))
      : null;
    citations.push({
      link: edge.link,
      crossReference: xref,
      crossReferenceDid: edge.atomDid,
      targetAtom,
      targetAtomDid,
    });
  }

  return {
    atom,
    atomDid: input.atomDid,
    contextSummary,
    provenance,
    ...(atom.entityType === "code-section" && atom.consequenceInputs
      ? { consequenceInputs: atom.consequenceInputs }
      : {}),
    consequenceStrata: deriveConsequenceStrata(
      atom.entityType === "code-section" ? atom.consequenceInputs : undefined,
    ),
    citations,
    outbound,
    inbound,
  };
}
