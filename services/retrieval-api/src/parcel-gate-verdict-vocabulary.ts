/**
 * P-293 remainder: the pinned `parcel_gate_verdict.verdict` vocabulary.
 *
 * WHY THIS FILE EXISTS. `parcel_gate_verdict` is written by hauska-factory
 * (PARCEL-B-GATE-SCHED and successors) and read by THIS service, which is
 * the hop LDT's own reader sits behind. The set of strings that column may
 * hold is therefore NOT this repo's to choose — it is a cross-repo contract
 * with no dependency edge to enforce it. On 2026-09-16 the factory widened
 * it (P-201 / A-153, migration 0011a, then P-252's classifier) and the
 * narrowing survived here: `parcel-record-db.ts`'s `loadGateVerdict`
 * accepted only the original three and returned `null` for everything else
 * — the same `null` a missing row and a caught read failure produce — so
 * every new string was silently "no usable verdict". LDT's reader was fixed
 * by P-293 (legacy-design-tools PR #702, merged 9ce30b8) and its own
 * commit message names THIS file's predecessor as the reason that fix does
 * nothing on its own: "hauska-engine's
 * services/retrieval-api/src/parcel-record-db.ts:160 applies the same
 * three-string narrowing on the live HTTP path, so in production an
 * excluded-* row is dropped one hop before it would reach this reader."
 *
 * PATTERN FOLLOWED. Same shape as LDT's `parcelGateVerdictVocabulary.ts` at
 * 9ce30b8 (the two copies are meant to read alike: same exported names, same
 * stamp fields, same closed-list discipline) and the same provenance
 * discipline as this repo's own vendored contract,
 * `parcel-record-slate.json` — "a divergence test in each repo guards drift
 * between publish and the next resync". See that file's `$comment` and
 * `sourceCommit` for the sibling practice; this module carries the stamp in
 * code because the type itself has to be derived from the list (a JSON
 * import is `string[]`, which would collapse `ParcelGateVerdictKind`).
 *
 * WHAT IT CANNOT DO, stated rather than implied. A pin with no dependency
 * edge to its upstream "cannot detect upstream drift it has no dependency
 * edge to observe — it guards internal consistency of this file, not
 * freshness against" the upstream (the same sentence `countyRailDimension`
 * carries in legacy-design-tools). Freshness is a HUMAN step, recorded by
 * the stamp below: re-read the three `factoryPaths` and re-verify the three
 * `upstreamBlobShas` whenever the stamp is refreshed. If the factory widens
 * the CHECK a third time and nobody re-reads it, this pin and the test that
 * mirrors it stay internally consistent and stay WRONG together. That is a
 * known, accepted, named limitation, not a control.
 *
 * WHERE THE LIST LIVES. `accepted` below is the ONE copy the running code
 * consumes: `parcel-record-db.ts`'s judgement and the types of everything
 * that carries a verdict are derived from it, never restated. The
 * vocabulary test holds a SECOND, deliberately independent transcription of
 * the same upstream files and asserts the two agree — that is the divergence
 * tripwire, and it is the only other copy of this list permitted in this
 * repo.
 */

export const PARCEL_GATE_VERDICT_VOCABULARY_PIN = {
  /** Upstream, read-only: this is the factory's contract, not ours. */
  factoryRepo: "empressaioemail-tech/hauska-factory",
  /** The ref this list was actually read at (read-only, via the GitHub API). */
  factorySha: "afdda428811eac1c1fc59055ece36496a0f1685a",
  factoryShaShort: "afdda428",
  /**
   * The P-201 merge where migration 0011a landed, i.e. where the three
   * `excluded-*` strings entered the contract. LDT's copy pins this SHA
   * alone; both refs carry byte-identical CHECK lists, so the string lists
   * agree and only the stamp's granularity differs between the two copies.
   */
  vocabularyLandedAt: "91712795ea2a1eb7c27f7328cf7f52fcb7810b59",
  vocabularyLandedAtShort: "9171279",
  cardRows: ["P-201", "A-153", "P-252", "P-293"],
  /** Re-read these three to refresh the stamp: the CHECK's history, then the writer's own constant list. */
  factoryPaths: [
    "migrations/0009_parcel_gate_verdict.sql",
    "migrations/0011a_parcel_gate_verdict_excluded_kinds.sql",
    "src/lib/gate-exclusion-classifier.mjs",
  ],
  /** Per-file evidence for the stamp above, so a refresh can tell WHICH file moved. */
  upstreamBlobShas: {
    "migrations/0009_parcel_gate_verdict.sql": "c47ea23b1863d3bcc2212c6fc62a26f3721cf89f",
    "migrations/0011a_parcel_gate_verdict_excluded_kinds.sql":
      "d3c0205d93eb5c19c7652504321eafbe7221fe67",
    "src/lib/gate-exclusion-classifier.mjs": "2724b7f1946e6d4b63af1324f542d6fc9acf5780",
  },
  verifiedAt: "2026-09-16",
  verifiedBy: "cursor-p293r",
  /**
   * Exactly these six. Migration 0009 wrote the CHECK as
   * `IN ('pass', 'refuse', 'excluded')`; 0011a re-wrote it ALONGSIDE the
   * legacy three rather than replacing them, because existing rows still
   * carry a bare 'excluded' (151 rows live as of 2026-09-16T21:13:47Z) and
   * a not-yet-updated writer must still be able to write one.
   *
   * NOTE THE SHAPE, because the next person's instinct will be wrong here:
   * 'excluded' is the excluded- PREFIX with no suffix, so a predicate
   * written `startsWith("excluded")` would accept both families for the
   * wrong reason and would silently admit any future `excluded-anything`.
   * The list is explicit and closed; the test asserts an invented
   * `excluded-*` string is still UNRECOGNISED.
   */
  accepted: [
    "pass",
    "refuse",
    "excluded",
    "excluded-not-applicable",
    "excluded-mid-cutover",
    "excluded-no-acquisition-path",
  ],
  /**
   * The P-201 refinement of the bare 'excluded' — the factory now says WHY
   * a rail was excluded. Carried as data so the vocabulary test can assert
   * the family is a strict subset of `accepted` and that each member wears
   * the prefix; `loadGateVerdict` does not branch on it, because this
   * service's decision table treats every recognised non-pass verdict
   * identically (see `parcel-record-reader.ts`).
   */
  excludedKinds: [
    "excluded-not-applicable",
    "excluded-mid-cutover",
    "excluded-no-acquisition-path",
  ],
} as const;

/** The six strings above, as a union. Derived, never re-typed. */
export type ParcelGateVerdictKind =
  (typeof PARCEL_GATE_VERDICT_VOCABULARY_PIN.accepted)[number];

export type ParcelGateVerdictVocabularyPin = typeof PARCEL_GATE_VERDICT_VOCABULARY_PIN;

/** The accepted set as a lookup. Pass a pin to check a different stamp. */
export function acceptedParcelGateVerdictKinds(
  pin: ParcelGateVerdictVocabularyPin = PARCEL_GATE_VERDICT_VOCABULARY_PIN,
): ReadonlySet<string> {
  return new Set<string>(pin.accepted as readonly string[]);
}

export const ACCEPTED_PARCEL_GATE_VERDICT_KINDS: ReadonlySet<string> =
  acceptedParcelGateVerdictKinds();

/**
 * The one place a raw column string is judged. `unrecognised` carries the
 * raw string back out so a caller can log the exact offending value instead
 * of a guess.
 */
export type ParcelGateVerdictClassification =
  | { state: "accepted"; kind: ParcelGateVerdictKind }
  | { state: "unrecognised"; raw: string };

export function classifyParcelGateVerdictKind(
  raw: string,
): ParcelGateVerdictClassification {
  return ACCEPTED_PARCEL_GATE_VERDICT_KINDS.has(raw)
    ? { state: "accepted", kind: raw as ParcelGateVerdictKind }
    : { state: "unrecognised", raw };
}

export function isAcceptedParcelGateVerdictKind(
  v: string,
): v is ParcelGateVerdictKind {
  return ACCEPTED_PARCEL_GATE_VERDICT_KINDS.has(v);
}
