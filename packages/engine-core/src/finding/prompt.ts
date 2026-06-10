/**
 * Prompt assembly for the Anthropic branch of the finding engine.
 *
 * Mirrors `lib/briefing-engine/src/prompt.ts`'s two-message split:
 *   - **system**: persona, severity rubric, citation rules, output
 *     format. Stable across submissions; updates here ripple
 *     everywhere, so any wording change should land with a snapshot
 *     test that re-anchors the expected output.
 *   - **user**: per-submission XML-tagged context blocks
 *     (`<submission>`, `<briefing>`, `<bim_elements>`,
 *     `<reference_code_atoms>`, `<reference_briefing_sources>`).
 *
 * The user prompt asks Claude to return strict JSON
 * (`{ "findings": [{...}, ...] }`) so the parser side never has to
 * guess at finding boundaries. The mock generator mirrors the same
 * shape.
 */

import type {
  BimElementInput,
  BriefingSourceInput,
  CodeSectionInput,
  GenerateFindingsInput,
  SubmissionInput,
} from "./types";

/** Hard cap on the briefing-narrative excerpt the prompt embeds. */
export const PROMPT_NARRATIVE_MAX_CHARS = 2000;
/** Hard cap on each code-atom snippet. */
export const PROMPT_CODE_SNIPPET_MAX_CHARS = 1200;

/**
 * The engine's system prompt. Stable across submissions — only the
 * user prompt carries per-submission data.
 */
export const FINDING_SYSTEM_PROMPT = `You are an AI plan reviewer assisting a jurisdiction's plan-review team. You produce compliance findings against an architect's plan-review submission.

Audience: a licensed reviewer about to read your findings inside the plan-review console. Findings are surfaced as cards in a tabbed list (severity-grouped); the reviewer accepts, rejects, or overrides each one.

Severity rubric (strictly enforced):
- blocker  — the submission violates a code requirement that MUST be resolved before approval. Cite the specific code section.
- concern  — there is ambiguity, missing information, or risk worth surfacing. The reviewer may downgrade to advisory or upgrade to blocker after investigation.
- advisory — preference, coordination note, or low-impact reminder. Does not block approval.

Category enum (exactly one per finding, no synonyms):
  setback | height | coverage | egress | use | overlay-conflict | divergence-related | other

Citation rules (strictly enforced):
- EVERY finding's text MUST cite at least one source: a code section via the inline token  [[CODE:<atomId>]]  OR a briefing source via  {{atom|briefing-source|<id>|<displayLabel>}}.
- Use ONLY the atom ids and briefing-source ids the user message lists in the <reference_code_atoms> and <reference_briefing_sources> blocks. NEVER invent ids.
- The deprecated  {{atom:type:id:label}}  shape is forbidden — emit only the pipe-delimited form above.
- Cite the atom that BEST supports the finding. If a finding's claim depends on multiple sections, cite each. Each citation token must appear inline in the text where the claim is made, not collected at the end.

Confidence: emit a number in [0, 1] reflecting how strongly the cited sources establish the finding. Set lowConfidence = true when confidence < 0.6.

elementRef: when the finding points at a specific BIM element listed in the <bim_elements> block, set elementRef to that element's ref string verbatim. Otherwise omit (null).

sourceRef: when one specific briefing source row is the single backing source for the finding, set sourceRef to {"id":"<id>","label":"<label>"} from <reference_briefing_sources>. Otherwise omit (null).

Output format: respond with ONLY a JSON object of the shape
  { "findings": [
      {
        "severity": "blocker|concern|advisory",
        "category": "<one of the eight categories>",
        "text": "<one-paragraph finding body with inline citation tokens>",
        "citations": [
          {"kind":"code-section","atomId":"..."},
          {"kind":"briefing-source","id":"...","label":"..."}
        ],
        "confidence": 0.0-1.0,
        "lowConfidence": true|false,
        "elementRef": "..." or null,
        "sourceRef": {"id":"...","label":"..."} or null
      },
      ...
  ] }
No prose outside the JSON. No markdown fencing. The "findings" array MAY be empty if you find nothing to flag.`;

function describeCodeSection(c: CodeSectionInput): string {
  const lines: string[] = [];
  lines.push(`- atomId=${c.atomId}`);
  lines.push(`  label: ${c.label}`);
  if (c.webProvenance) {
    lines.push(`  sourceUrl: ${c.webProvenance.sourceUrl}`);
    if (c.webProvenance.sources?.length) {
      for (const s of c.webProvenance.sources) {
        lines.push(
          `  source: ${s.sourceName} | ${s.url} | retrievedAt=${s.retrievedAt} | verified=${s.verified}`,
        );
      }
    }
    lines.push(`  retrievedAt: ${c.webProvenance.retrievedAt}`);
    lines.push(`  edition: ${c.webProvenance.edition}`);
    lines.push(`  verified: ${c.webProvenance.verified}`);
    if (c.webProvenance.displayMode) {
      lines.push(`  displayMode: ${c.webProvenance.displayMode}`);
    }
    if (c.webProvenance.unverifiedWebSource) {
      lines.push(`  unverified-web-source: true`);
    }
  }
  if (c.snippet) {
    const snippet =
      c.snippet.length > PROMPT_CODE_SNIPPET_MAX_CHARS
        ? c.snippet.slice(0, PROMPT_CODE_SNIPPET_MAX_CHARS - 1) + "…"
        : c.snippet;
    lines.push(`  snippet: ${snippet.replace(/\n/g, " ").trim()}`);
  }
  return lines.join("\n");
}

function describeBriefingSource(s: BriefingSourceInput): string {
  const lines: string[] = [];
  lines.push(`- id=${s.id}`);
  lines.push(`  layerKind: ${s.layerKind}`);
  lines.push(`  sourceKind: ${s.sourceKind}`);
  if (s.provider) lines.push(`  provider: ${s.provider}`);
  lines.push(`  snapshotDate: ${s.snapshotDate}`);
  if (s.note) lines.push(`  note: ${s.note}`);
  const label =
    s.provider && s.provider.trim().length > 0 ? s.provider.trim() : s.layerKind;
  lines.push(`  displayLabel (use in citation token): ${label}`);
  return lines.join("\n");
}

function describeBimElement(e: BimElementInput): string {
  const lines: string[] = [];
  lines.push(`- ref=${e.ref}`);
  lines.push(`  label: ${e.label}`);
  if (e.description) lines.push(`  description: ${e.description}`);
  return lines.join("\n");
}

function describePlanSetPiece(
  p: import("./planSet/types").PlanSetPieceInput,
): string {
  const lines: string[] = [];
  lines.push(`- pieceId=${p.pieceId} kind=${p.kind} discipline=${p.discipline}`);
  lines.push(`  label: ${p.label}`);
  if (p.text && p.text.trim().length > 0) {
    const clipped =
      p.text.length > 1200 ? p.text.slice(0, 1199) + "…" : p.text;
    lines.push(`  text: ${clipped.replace(/\n/g, " ").trim()}`);
  }
  return lines.join("\n");
}

function describeSubmission(s: SubmissionInput): string {
  const lines: string[] = [`id: ${s.id}`];
  if (s.projectName) lines.push(`projectName: ${s.projectName}`);
  if (s.jurisdiction) lines.push(`jurisdiction: ${s.jurisdiction}`);
  if (s.note) lines.push(`note: ${s.note}`);
  return lines.join("\n");
}

/**
 * Assemble the per-submission user prompt. Pure function — same
 * inputs in, same string out, so the snapshot test pinning the
 * prompt format is deterministic.
 */
export function buildUserPrompt(input: GenerateFindingsInput): string {
  const sections: string[] = [];

  if (input.disciplineScope) {
    sections.push(
      `<discipline_scope>\nSpecialist pass for discipline: ${input.disciplineScope}. ` +
        `Only flag issues within this discipline's scope.\n</discipline_scope>`,
    );
  }

  sections.push(
    `<submission>\n${describeSubmission(input.submission)}\n</submission>`,
  );

  if (input.planSetPieces && input.planSetPieces.length > 0) {
    sections.push(
      `<plan_set_pieces>\n${input.planSetPieces.map(describePlanSetPiece).join("\n")}\n</plan_set_pieces>`,
    );
  }

  if (input.briefingNarrative && input.briefingNarrative.trim().length > 0) {
    const trimmed = input.briefingNarrative.trim();
    const excerpt =
      trimmed.length > PROMPT_NARRATIVE_MAX_CHARS
        ? trimmed.slice(0, PROMPT_NARRATIVE_MAX_CHARS - 1) + "…"
        : trimmed;
    sections.push(`<briefing>\n${excerpt}\n</briefing>`);
  }

  if (input.bimElements.length > 0) {
    sections.push(
      `<bim_elements>\n${input.bimElements.map(describeBimElement).join("\n")}\n</bim_elements>`,
    );
  }

  // The reference blocks are the resolver's allow-list. The validator
  // strips any citation token whose id is not in these lists.
  if (input.codeSections.length > 0) {
    sections.push(
      `<reference_code_atoms>\n${input.codeSections.map(describeCodeSection).join("\n")}\n</reference_code_atoms>`,
    );
  }
  if (input.sources.length > 0) {
    sections.push(
      `<reference_briefing_sources>\n${input.sources.map(describeBriefingSource).join("\n")}\n</reference_briefing_sources>`,
    );
  }

  // Closing instruction restates the output format so it lands at the
  // bottom of the user message — Claude weighs late instructions
  // strongly.
  sections.push(
    `Produce zero or more findings against this submission. Cite EVERY claim from the reference blocks above. Respond with strict JSON only — no prose, no markdown fencing.`,
  );

  return sections.join("\n\n");
}
