/**
 * Event capture atom store + structural would_affect graph (TCE steps 1 & 3).
 */

import type {
  EventCaptureAtom,
  WouldAffectEdge,
} from "@hauska-engine/atom-contract-pin/tce";
import {
  WOULD_AFFECT_EDGE_SCHEMA,
} from "@hauska-engine/atom-contract-pin/tce";
import { resolveEvtId } from "@hauska-engine/identity";

export type EventCaptureWriteOutcome = "written" | "duplicate";

export interface EventCaptureStore {
  /**
   * Idempotent on (source, stable_external_id, valid_from).
   * `source` is taken from atom.provenance.source.
   */
  writeEventCaptureAtom(atom: EventCaptureAtom): Promise<EventCaptureWriteOutcome>;
  countEventCaptureAtoms(): Promise<number>;
  listEventCaptureAtoms(): Promise<ReadonlyArray<EventCaptureAtom>>;
}

export interface EventsAffectingSubjectResult {
  evtNodeId: string;
  edge: WouldAffectEdge;
}

export interface StructuralGraphStore {
  writeWouldAffectEdge(edge: WouldAffectEdge): Promise<"written" | "duplicate">;
  /**
   * Walk inbound would_affect edges where targetSubjectId matches.
   * Indexed by targetSubjectId in production Postgres layer.
   */
  queryEventsAffectingSubject(
    targetSubjectId: string,
  ): Promise<ReadonlyArray<EventsAffectingSubjectResult>>;
}

export function parseWouldAffectEdge(raw: unknown): WouldAffectEdge {
  return WOULD_AFFECT_EDGE_SCHEMA.parse(raw) as WouldAffectEdge;
}

export function buildWouldAffectEdgesForCapture(
  atom: EventCaptureAtom,
): ReadonlyArray<WouldAffectEdge> {
  const evtId = resolveEvtId(
    atom.provenance.source,
    atom.stable_external_id,
  );
  return atom.content.subject_ids.map((targetSubjectId) => ({
    type: "would_affect" as const,
    sourceNodeId: evtId,
    targetSubjectId,
    effectiveDate: atom.content.stated_date,
    immutable: true as const,
  }));
}

function eventDedupKey(atom: EventCaptureAtom): string {
  return `${atom.provenance.source}\0${atom.stable_external_id}\0${atom.valid_from}`;
}

export class InMemoryEventCaptureStore implements EventCaptureStore {
  private readonly atoms = new Map<string, EventCaptureAtom>();

  async writeEventCaptureAtom(
    atom: EventCaptureAtom,
  ): Promise<EventCaptureWriteOutcome> {
    const key = eventDedupKey(atom);
    if (this.atoms.has(key)) return "duplicate";
    this.atoms.set(key, atom);
    return "written";
  }

  async countEventCaptureAtoms(): Promise<number> {
    return this.atoms.size;
  }

  async listEventCaptureAtoms(): Promise<ReadonlyArray<EventCaptureAtom>> {
    return [...this.atoms.values()];
  }
}

export class InMemoryStructuralGraphStore implements StructuralGraphStore {
  private readonly edges = new Map<string, WouldAffectEdge>();

  private edgeKey(edge: WouldAffectEdge): string {
    return `${edge.sourceNodeId}\0${edge.targetSubjectId}\0${edge.effectiveDate}`;
  }

  async writeWouldAffectEdge(
    edge: WouldAffectEdge,
  ): Promise<"written" | "duplicate"> {
    const parsed = parseWouldAffectEdge(edge);
    const key = this.edgeKey(parsed);
    if (this.edges.has(key)) return "duplicate";
    this.edges.set(key, parsed);
    return "written";
  }

  async queryEventsAffectingSubject(
    targetSubjectId: string,
  ): Promise<ReadonlyArray<EventsAffectingSubjectResult>> {
    const out: EventsAffectingSubjectResult[] = [];
    for (const edge of this.edges.values()) {
      if (edge.targetSubjectId !== targetSubjectId) continue;
      out.push({ evtNodeId: edge.sourceNodeId, edge });
    }
    return out;
  }
}

/** Combined in-memory substrate for capture + graph smoke tests. */
export class InMemoryTceStore
  extends InMemoryEventCaptureStore
  implements StructuralGraphStore
{
  private readonly graph = new InMemoryStructuralGraphStore();

  async writeWouldAffectEdge(
    edge: WouldAffectEdge,
  ): Promise<"written" | "duplicate"> {
    return this.graph.writeWouldAffectEdge(edge);
  }

  async queryEventsAffectingSubject(
    targetSubjectId: string,
  ): Promise<ReadonlyArray<EventsAffectingSubjectResult>> {
    return this.graph.queryEventsAffectingSubject(targetSubjectId);
  }
}
