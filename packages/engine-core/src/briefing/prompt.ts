/**
 * Prompt assembly for the Anthropic branch of the briefing engine.
 *
 * The engine speaks to Claude in two messages:
 *   - **system**: the architect-audience persona, the seven-section
 *     contract from Spec 51 §2, the citation token rules, and the
 *     "missing source → gap note, never fail" instruction. Does not
 *     change between engagements.
 *   - **user**: the per-engagement source bundle, grouped by the
 *     section that owns it, plus the per-section weighting hint
 *     (heavy for B/E/F/G, light for C/D — Spec 51 §1.2).
 *
 * The user prompt asks Claude to return strict JSON
 * (`{ "a": "...", ..., "g": "..." }`) so the parser side never has
 * to guess at where one section ends and the next starts. The mock
 * generator below mirrors the same shape.
 */

import type {
  BriefingSourceInput,
  CodeSectionInput,
  GenerateBriefingInput,
} from "./types";
import { HEAVY_SECTIONS, SECTION_LABELS } from "./types";
import {
  citationLabel,
  groupSourcesBySection,
  SECTIONS_WITH_NO_CITATIONS,
  SECTIONS_WITH_SOURCE_CITATIONS,
} from "./sourceCategories";

const HEAVY_SET: ReadonlySet<string> = new Set(HEAVY_SECTIONS);

/**
 * The engine's system prompt. Stable across engagements — only the
 * user prompt carries per-engagement data. Updates here ripple
 * everywhere, so any wording change should land with a snapshot
 * test that re-anchors the expected output.
 */
export const BRIEFING_SYSTEM_PROMPT = `You are an architect's site-context briefing engine. You synthesize raw site data into the seven-section A–G briefing defined in Spec 51 §2.

Audience: a licensed architect about to scope a project on this parcel. Weighting per Spec 51 §1.2: B (Threshold Issues), E (Buildable Envelope), F (Neighboring Context), and G (Next-Step Checklist) get the heaviest narrative; C (Regulatory Gates) and D (Site Infrastructure) are tighter. A (Executive Summary) is two to four sentences.

Citation rules (strictly enforced):
- Every factual claim in sections B, C, D, E, F MUST cite either a briefing-source via the inline token  {{atom|briefing-source|<id>|<displayLabel>}}  OR a code section via  [[CODE:<atomId>]] .
- Section A and Section G cite NOTHING. Do not place any citation tokens in those sections.
- Use ONLY the briefing-source ids and code-section atom ids the user message lists. NEVER invent ids.
- The deprecated  {{atom:type:id:label}}  shape is forbidden — emit only the pipe-delimited form above.

Missing-data contract: if a section's needed source is absent, write a one-line gap note instead of failing (e.g. "Soil data not available — order a soils test.").

Output format: respond with ONLY a JSON object of the shape
  { "a": "...", "b": "...", "c": "...", "d": "...", "e": "...", "f": "...", "g": "..." }
No prose outside the JSON. No markdown fencing. All seven keys present and non-empty.`;

/** Per-section instruction line included in the user prompt. */
const SECTION_INSTRUCTIONS: Readonly<Record<keyof typeof SECTION_LABELS, string>> = {
  a: `2–4 sentences. Synthesize the most consequential facts from B–F into a stand-alone summary. NO citation tokens.`,
  b: `Heavy section. Walk through floodplain / wetland / soil / hazard / snow-load / seismic exposure. Cite EVERY claim with a briefing-source token from category B below; cite code sections via [[CODE:...]] when their applicability depends on these hazards.`,
  c: `Tight section. Cover zoning district, setbacks, overlays, historic district, FAR / height limits. Cite zoning briefing-sources OR code-section atoms via [[CODE:...]] for every claim.`,
  d: `Tight section. Water, sewer, electric, gas, road / street access, transit. Cite each utility's briefing-source.`,
  e: `Heavy section. Synthesize the buildable envelope: parcel geometry, terrain / topography, the resulting envelope. Cite the parcel + topo + buildable-envelope briefing-sources.`,
  f: `Heavy section. Adjacent parcels, neighbor masses, view corridors. Cite the neighboring-context briefing-source(s).`,
  g: `Heavy section. Concrete next-step checklist for the architect (what to order, what to draw next, what to coordinate with consultants). NO citation tokens.`,
};

function describeOneSource(s: BriefingSourceInput): string {
  const lines: string[] = [];
  lines.push(`- id=${s.id}`);
  lines.push(`  layerKind: ${s.layerKind}`);
  lines.push(`  sourceKind: ${s.sourceKind}`);
  if (s.provider) lines.push(`  provider: ${s.provider}`);
  lines.push(`  snapshotDate: ${s.snapshotDate}`);
  if (s.note) lines.push(`  note: ${s.note}`);
  lines.push(`  displayLabel (use in citation token): ${citationLabel(s)}`);
  if (s.payload !== undefined && s.payload !== null) {
    let serialized: string;
    try {
      serialized = JSON.stringify(s.payload);
    } catch {
      serialized = "[unserializable]";
    }
    if (serialized.length > 4000) {
      serialized = serialized.slice(0, 4000) + "…[truncated]";
    }
    lines.push(`  payload: ${serialized}`);
  }
  return lines.join("\n");
}

function describeOneCodeSection(c: CodeSectionInput): string {
  const lines: string[] = [];
  lines.push(`- atomId=${c.atomId}`);
  lines.push(`  label: ${c.label}`);
  if (c.snippet) {
    const snip = c.snippet.length > 600 ? c.snippet.slice(0, 600) + "…" : c.snippet;
    lines.push(`  snippet: ${snip}`);
  }
  return lines.join("\n");
}

/**
 * Build the per-engagement user message. Sources are grouped under
 * the section that owns them (per `categorizeLayerKind`), with an
 * "uncategorized" bucket for slugs that didn't match any rule. Code
 * sections are listed once at the top — sections B/C may cite them.
 */
export function buildUserPrompt(input: GenerateBriefingInput): string {
  const buckets = groupSourcesBySection(input.sources);
  const lines: string[] = [];
  lines.push(`Engagement: ${input.engagementId}`);
  if (input.engagementLabel) {
    lines.push(`Engagement label: ${input.engagementLabel}`);
  }
  lines.push("");

  if (input.codeSections && input.codeSections.length > 0) {
    lines.push(`Code sections available for citation (use [[CODE:<atomId>]]):`);
    for (const c of input.codeSections) {
      lines.push(describeOneCodeSection(c));
    }
    lines.push("");
  }

  const sectionLabel = (k: keyof typeof SECTION_LABELS): string =>
    `${k.toUpperCase()} — ${SECTION_LABELS[k]}` +
    (HEAVY_SET.has(k) ? " (HEAVY)" : k === "a" ? "" : " (TIGHT)");

  // Sections A and G cite nothing — flag them up front so the model
  // does not feel pressure to invent tokens.
  for (const k of SECTIONS_WITH_NO_CITATIONS) {
    lines.push(`${sectionLabel(k)}`);
    lines.push(SECTION_INSTRUCTIONS[k]);
    lines.push("");
  }

  for (const k of SECTIONS_WITH_SOURCE_CITATIONS) {
    const list = buckets[k];
    lines.push(`${sectionLabel(k)}`);
    lines.push(SECTION_INSTRUCTIONS[k]);
    if (list.length === 0) {
      lines.push(`(No briefing-sources mapped to this section — emit a gap note.)`);
    } else {
      lines.push(`Sources for this section:`);
      for (const s of list) {
        lines.push(describeOneSource(s));
      }
    }
    lines.push("");
  }

  if (buckets.general.length > 0) {
    lines.push(
      `Uncategorized briefing-sources (no automatic section mapping — cite under the most relevant section):`,
    );
    for (const s of buckets.general) {
      lines.push(describeOneSource(s));
    }
    lines.push("");
  }

  lines.push(`Respond with the JSON object described in the system prompt — all seven keys, no prose outside the JSON, no markdown fencing.`);

  return lines.join("\n");
}
