/**
 * Deterministic mock generator for `AIR_FINDING_LLM_MODE = "mock"`.
 *
 * Returns up to three structurally-complete findings (1 blocker, 1
 * concern, 1 advisory) without calling Anthropic — used by:
 *   - the api-server's local dev workflow (no API key needed),
 *   - CI / vitest (no flaky network),
 *   - pre-Empressa-approval engineering iterations.
 *
 * The fixture is parameterized on `submissionId` + the resolver
 * lookups so cited ids actually exist in the input bundle: a finding
 * is emitted only when its citation prerequisites are present. This
 * means the validator's "every token resolves" path is exercised in
 * mock mode exactly the same way it would be against Claude.
 *
 * Atom ids are constructed as `finding:{submissionId}:{ulid}` to
 * match the FE deep-link grammar. The ulid is a small-but-unique
 * timestamp+random suffix mirroring the FE mock's helper
 * (`findingsMock.ts:120-127`) — collision-resistant enough for tests
 * without pulling in a ulid dependency.
 */

import type {
  EngineFinding,
  GenerateFindingsInput,
  FindingCitation,
  FindingCodeCitation,
  FindingSourceCitation,
} from "./types";

/** Generate a small ulid-shaped id; collision-resistant for tests. */
function makeUlid(): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 10);
  return `${t}${r}`.toUpperCase().slice(0, 26);
}

function makeAtomId(submissionId: string): string {
  return `finding:${submissionId}:${makeUlid()}`;
}

function citeCode(atomId: string): string {
  return `[[CODE:${atomId}]]`;
}

function citeSource(id: string, label: string): string {
  return `{{atom|briefing-source|${id}|${label}}}`;
}

function sourceLabel(s: { provider: string | null; layerKind: string }): string {
  if (s.provider && s.provider.trim().length > 0) return s.provider.trim();
  return s.layerKind;
}

/**
 * Produce up to three deterministic findings for the input bundle.
 * Each finding's citations are picked from the input's reference
 * blocks so the validator's resolver lookups always succeed.
 *
 * The fixture skips findings whose citation prerequisites are
 * missing — e.g. without a code-section atomId the blocker is
 * suppressed — rather than emit a finding the validator would
 * discard. This keeps mock-mode behavior aligned with anthropic-mode
 * "valid output" expectations.
 */
export function generateMockFindings(
  input: GenerateFindingsInput,
  now: () => Date = () => new Date(),
): EngineFinding[] {
  const aiGeneratedAt = now();
  const findings: EngineFinding[] = [];

  const firstCode = input.codeSections[0];
  const firstSource = input.sources[0];
  const firstElement = input.bimElements[0];

  // 1. Blocker — needs a code-section + a briefing-source. Anchored
  // on a BIM element when one is provided.
  if (firstCode && firstSource) {
    const sLabel = sourceLabel(firstSource);
    const citations: FindingCitation[] = [
      { kind: "code-section", atomId: firstCode.atomId } satisfies FindingCodeCitation,
      {
        kind: "briefing-source",
        id: firstSource.id,
        label: sLabel,
      } satisfies FindingSourceCitation,
    ];
    findings.push({
      atomId: makeAtomId(input.submission.id),
      submissionId: input.submission.id,
      severity: "blocker",
      category: "setback",
      text:
        `Proposed envelope appears to violate the dimensional standard at ${firstCode.label}: ` +
        `the cited briefing source establishes the baseline for this parcel ` +
        `(${citeSource(firstSource.id, sLabel)}) and the relevant rule is ${citeCode(firstCode.atomId)}.`,
      citations,
      confidence: 0.92,
      lowConfidence: false,
      elementRef: firstElement ? firstElement.ref : null,
      sourceRef: { id: firstSource.id, label: sLabel },
      aiGeneratedAt,
    });
  }

  // 2. Concern — needs a code-section. Anchored on the second BIM
  // element when one exists, else the first, else null.
  if (firstCode) {
    const elementRef = input.bimElements[1]?.ref ?? firstElement?.ref ?? null;
    findings.push({
      atomId: makeAtomId(input.submission.id),
      submissionId: input.submission.id,
      severity: "concern",
      category: "egress",
      text:
        `An egress dimension on this submission is close to the minimum required by ${firstCode.label} ` +
        `(${citeCode(firstCode.atomId)}). Confirm field measurements before approval.`,
      citations: [{ kind: "code-section", atomId: firstCode.atomId }],
      confidence: 0.55,
      lowConfidence: true,
      elementRef,
      sourceRef: null,
      aiGeneratedAt,
    });
  }

  // 3. Advisory — needs either a code-section OR a briefing-source.
  const advisoryCode = input.codeSections[1] ?? firstCode;
  const advisorySource = input.sources[1] ?? firstSource;
  if (advisoryCode || advisorySource) {
    const citations: FindingCitation[] = [];
    const fragments: string[] = [];
    if (advisorySource) {
      const sLabel = sourceLabel(advisorySource);
      citations.push({
        kind: "briefing-source",
        id: advisorySource.id,
        label: sLabel,
      });
      fragments.push(citeSource(advisorySource.id, sLabel));
    }
    if (advisoryCode) {
      citations.push({ kind: "code-section", atomId: advisoryCode.atomId });
      fragments.push(citeCode(advisoryCode.atomId));
    }
    findings.push({
      atomId: makeAtomId(input.submission.id),
      submissionId: input.submission.id,
      severity: "advisory",
      category: "other",
      text:
        `Coordination note: reconcile the submitted plan against ${fragments.join(" and ")}. ` +
        `This is informational only and does not block approval.`,
      citations,
      confidence: 0.78,
      lowConfidence: false,
      elementRef: null,
      sourceRef: null,
      aiGeneratedAt,
    });
  }

  return findings;
}
