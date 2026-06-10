/**
 * Deterministic mock generator for `BRIEFING_LLM_MODE = "mock"`.
 *
 * Returns a structurally-complete A–G briefing without calling
 * Anthropic. Used by:
 *   - the api-server's local dev workflow (no API key needed),
 *   - CI / vitest (no flaky network),
 *   - pre-Empressa-approval engineering iterations.
 *
 * The narrative is intentionally short and references each known
 * briefing-source / code-section by its real id so the citation
 * validator's "every token resolves" path is exercised in mock mode
 * exactly the same way it would be against Claude.
 */

import type {
  BriefingSections,
  BriefingSourceInput,
  CodeSectionInput,
  GenerateBriefingInput,
} from "./types";
import {
  citationLabel,
  groupSourcesBySection,
} from "./sourceCategories";

function citeOne(s: BriefingSourceInput): string {
  return `{{atom|briefing-source|${s.id}|${citationLabel(s)}}}`;
}

function citeCode(c: CodeSectionInput): string {
  return `[[CODE:${c.atomId}]]`;
}

function joinClaims(claims: string[], gapNote: string): string {
  if (claims.length === 0) return gapNote;
  return claims.join(" ");
}

/**
 * Build the seven sections from the input bundle. Pure function,
 * synchronous — used by callers and by the engine's `mock` branch.
 */
export function generateMockBriefing(
  input: GenerateBriefingInput,
): BriefingSections {
  const buckets = groupSourcesBySection(input.sources);
  const codeSections = input.codeSections ?? [];

  // Section A — executive summary, no citations.
  const sourceCount = input.sources.length;
  const a =
    `Engagement ${input.engagementId} has ${sourceCount} briefing source` +
    `${sourceCount === 1 ? "" : "s"} attached. ` +
    `This mock-mode summary stands in for the Claude-authored A–G narrative — ` +
    `the structure (executive summary, threshold issues, regulatory gates, ` +
    `site infrastructure, buildable envelope, neighboring context, next steps) ` +
    `mirrors what the architect will see when BRIEFING_LLM_MODE flips to anthropic.`;

  // Section B — threshold issues; cite floodplain/wetland/soil/etc.
  const bClaims: string[] = [];
  for (const s of buckets.b) {
    bClaims.push(
      `Layer ${s.layerKind} (snapshot ${s.snapshotDate}) is on file ${citeOne(s)}.`,
    );
  }
  const b = joinClaims(
    bClaims,
    `No threshold-issue overlays (floodplain, wetland, soil, hazard) on file — order site-specific environmental review before scoping foundations.`,
  );

  // Section C — regulatory gates; cite zoning sources + code sections.
  const cClaims: string[] = [];
  for (const s of buckets.c) {
    cClaims.push(
      `Zoning / overlay layer ${s.layerKind} attached (snapshot ${s.snapshotDate}) ${citeOne(s)}.`,
    );
  }
  for (const code of codeSections) {
    cClaims.push(`Applicable code section ${code.label} ${citeCode(code)}.`);
  }
  const c = joinClaims(
    cClaims,
    `No zoning / overlay briefing-source attached and no code sections cited — pull the jurisdiction's current zoning code before issuing a feasibility memo.`,
  );

  // Section D — site infrastructure.
  const dClaims: string[] = [];
  for (const s of buckets.d) {
    dClaims.push(
      `Utility / road layer ${s.layerKind} on file ${citeOne(s)}.`,
    );
  }
  const d = joinClaims(
    dClaims,
    `No utility or road-access briefing-source attached — request a utility availability letter from the jurisdiction.`,
  );

  // Section E — buildable envelope.
  const eClaims: string[] = [];
  for (const s of buckets.e) {
    eClaims.push(
      `Envelope-input layer ${s.layerKind} attached (snapshot ${s.snapshotDate}) ${citeOne(s)}.`,
    );
  }
  const e = joinClaims(
    eClaims,
    `No parcel / topography / buildable-envelope briefing-source attached — request a parcel polygon export and a current contour set before envelope studies.`,
  );

  // Section F — neighboring context.
  const fClaims: string[] = [];
  for (const s of buckets.f) {
    fClaims.push(
      `Neighboring-context layer ${s.layerKind} on file ${citeOne(s)}.`,
    );
  }
  const f = joinClaims(
    fClaims,
    `No neighboring-context briefing-source attached — capture adjacent-parcel masses and view corridors before the design intent locks.`,
  );

  // Section G — next-step checklist; no citations.
  const gItems: string[] = [
    `Confirm the parcel polygon and current zoning district with the jurisdiction.`,
    `Order any environmental study the threshold-issues section flagged as a gap.`,
    `Walk the site to verify neighboring context against the briefing's recorded snapshot date.`,
    `Schedule a feasibility review against the regulatory-gates section before fee proposal.`,
  ];
  const g = gItems.map((item) => `- ${item}`).join("\n");

  return { a, b, c, d, e, f, g };
}
