/**
 * Bastrop TX Planning & Zoning Commission agenda — fixture feed.
 *
 * Grep scope: no live legislative/calendar adapters existed in hauska-engine
 * at dispatch time; this feed is the first wired anticipatory capture path
 * and uses deterministic fixture items for self-test (knowledge_time ≠ valid_from).
 *
 * Adapter path: packages/capture/src/feeds/bastrop-planning-agenda.ts
 */

import type { EventFeed, EventFeedContext, EventFeedFetchResult } from "./types.js";

const SOURCE =
  "https://www.cityofbastrop.org/government/city-departments/planning-development/planning-zoning-commission";

export const bastropPlanningAgendaFeed: EventFeed = {
  feedName: "bastrop-tx:planning-agenda",
  registry: {
    source: SOURCE,
    license: "public-record",
    derived_ok: true,
  },
  async fetch(_ctx: EventFeedContext): Promise<EventFeedFetchResult> {
    return {
      items: [
        {
          stable_external_id: "pz-2026-06-12-item-4",
          claim_type: "anticipatory.calendar_item",
          event_type: "calendar_item",
          stated_date: "2026-06-12T18:00:00-05:00",
          subject_ids: ["jurisdiction_bastrop-tx"],
          summary: "PZ-2026-06: Site plan review — 142 River Oaks Dr",
          raw_url: `${SOURCE}#agenda-2026-06-12-item-4`,
        },
        {
          stable_external_id: "pz-2026-06-12-item-7",
          claim_type: "anticipatory.calendar_item",
          event_type: "calendar_item",
          stated_date: "2026-06-12T18:00:00-05:00",
          subject_ids: ["jurisdiction_bastrop-tx", "parcel_bastrop-142-river-oaks"],
          summary: "PZ-2026-06: Variance request — setback relief",
          raw_url: `${SOURCE}#agenda-2026-06-12-item-7`,
        },
      ],
    };
  },
};
