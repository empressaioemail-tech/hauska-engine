import type {
  AnticipatoryClaimType,
  EventCaptureAtom,
  EventContentType,
} from "@hauska-engine/atom-contract-pin/tce";

export interface SourceRegistryEntry {
  source: string;
  license: string;
  derived_ok: boolean;
}

export interface FetchedEventItem {
  stable_external_id: string;
  claim_type: AnticipatoryClaimType;
  event_type: EventContentType;
  stated_date: string;
  subject_ids: ReadonlyArray<string>;
  summary: string;
  raw_url: string;
}

export interface EventFeedFetchResult {
  items: ReadonlyArray<FetchedEventItem>;
}

export interface EventFeedContext {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

/**
 * Anticipatory event feed — fetches forward-looking items for display.
 * Capture layer persists in parallel via `persistCapturedEventsFireAndForget`.
 */
export interface EventFeed {
  readonly feedName: string;
  readonly registry: SourceRegistryEntry;
  fetch(ctx: EventFeedContext): Promise<EventFeedFetchResult>;
}

export function toEventCaptureAtoms(
  feed: EventFeed,
  fetchResult: EventFeedFetchResult,
  knowledgeTime: string,
): ReadonlyArray<EventCaptureAtom> {
  return fetchResult.items.map((item) => ({
    family: "event" as const,
    claim_type: item.claim_type,
    valid_from: item.stated_date,
    knowledge_time: knowledgeTime,
    provenance: {
      source: feed.registry.source,
      retrieved_at: knowledgeTime,
      license: feed.registry.license,
      derived_ok: feed.registry.derived_ok,
    },
    accessPolicy: "platform-internal" as const,
    content: {
      event_type: item.event_type,
      stated_date: item.stated_date,
      subject_ids: [...item.subject_ids],
      summary: item.summary,
      raw_url: item.raw_url,
    },
    stable_external_id: item.stable_external_id,
  }));
}
