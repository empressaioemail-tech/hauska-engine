/**
 * TCE / atom-contract@1.6.0 surface shim.
 *
 * cc-agent-AC publishes `@hauska/atom-contract@1.6.0` with these types;
 * until npm resolves 1.6.0 the engine carries the contract verbatim here
 * and re-exports from `@hauska-engine/atom-contract-pin/tce`.
 */

import { z } from "zod";

/** Registered structural node-type prefixes (evt_, parcel_, jurisdiction_, …). */
export const NODE_TYPE_PREFIXES = ["evt_", "parcel_", "jurisdiction_"] as const;

export type NodeTypePrefix = (typeof NODE_TYPE_PREFIXES)[number];

export type AnticipatoryClaimType =
  | "anticipatory.calendar_item"
  | "anticipatory.legislative_item"
  | "anticipatory.regulatory_notice";

export type EventContentType =
  | "calendar_item"
  | "legislative_item"
  | "regulatory_notice";

export interface EventCaptureProvenance {
  source: string;
  retrieved_at: string;
  license: string;
  derived_ok: boolean;
}

export interface EventCaptureContent {
  event_type: EventContentType;
  stated_date: string;
  subject_ids: ReadonlyArray<string>;
  summary: string;
  raw_url: string;
}

/**
 * Event-family capture atom per TCE spec (step 1).
 * `valid_from` is the event's own stated date; `knowledge_time` is fetch time.
 */
export interface EventCaptureAtom {
  family: "event";
  claim_type: AnticipatoryClaimType;
  valid_from: string;
  knowledge_time: string;
  provenance: EventCaptureProvenance;
  accessPolicy: "platform-internal";
  content: EventCaptureContent;
  /** Dedup identity: (source, stable_external_id, valid_from). */
  stable_external_id: string;
}

/**
 * Structural `would_affect` edge per atom-contract@1.6.0.
 * Immutable once written; effect-probability is out of scope for this dispatch.
 */
export interface WouldAffectEdge {
  type: "would_affect";
  sourceNodeId: string;
  targetSubjectId: string;
  effectiveDate: string;
  immutable: true;
}

export const WOULD_AFFECT_EDGE_SCHEMA = z.object({
  type: z.literal("would_affect"),
  sourceNodeId: z
    .string()
    .min(1)
    .refine((id) => id.startsWith("evt_"), {
      message: "sourceNodeId must carry evt_ prefix",
    }),
  targetSubjectId: z.string().min(1),
  effectiveDate: z.string().datetime({ offset: true }),
  immutable: z.literal(true),
});

export const EVENT_CAPTURE_ATOM_SCHEMA = z.object({
  family: z.literal("event"),
  claim_type: z.enum([
    "anticipatory.calendar_item",
    "anticipatory.legislative_item",
    "anticipatory.regulatory_notice",
  ]),
  valid_from: z.string().datetime({ offset: true }),
  knowledge_time: z.string().datetime({ offset: true }),
  provenance: z.object({
    source: z.string().min(1),
    retrieved_at: z.string().datetime({ offset: true }),
    license: z.string(),
    derived_ok: z.boolean(),
  }),
  accessPolicy: z.literal("platform-internal"),
  content: z.object({
    event_type: z.enum([
      "calendar_item",
      "legislative_item",
      "regulatory_notice",
    ]),
    stated_date: z.string().datetime({ offset: true }),
    subject_ids: z.array(z.string().min(1)),
    summary: z.string(),
    raw_url: z.string(),
  }),
  stable_external_id: z.string().min(1),
});

export function isRegisteredNodePrefix(id: string): boolean {
  return NODE_TYPE_PREFIXES.some((p) => id.startsWith(p));
}
