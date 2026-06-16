import { effectiveConfidence } from "../calibration/overlay.js";
import { assertedBaselineFromSourceType } from "../calibration/corpusBaseline.js";
import type { CodeSectionInput } from "../finding/types.js";
import type { ConfidenceKind, EnvelopeConfidence } from "./schema.js";

export interface ReadPathConfidenceInput {
  /** LLM/asserted baseline when no code sections supply confidence. */
  assertedBaseline?: number;
  /** When true, envelope kind is deterministic (pure math / lookup). */
  deterministic?: boolean;
  codeSections?: ReadonlyArray<Pick<CodeSectionInput, "atomId" | "webProvenance">>;
  /** Optional calibrated overlay values keyed by atom id. */
  calibratedByAtomId?: ReadonlyMap<string, number>;
  calibrationStaleByAtomId?: ReadonlyMap<string, boolean>;
}

function confidenceFromCodeSections(
  sections: ReadonlyArray<Pick<CodeSectionInput, "atomId" | "webProvenance">>,
  calibratedByAtomId?: ReadonlyMap<string, number>,
  calibrationStaleByAtomId?: ReadonlyMap<string, boolean>,
): { value: number; kind: ConfidenceKind } {
  if (sections.length === 0) {
    return { value: assertedBaselineFromSourceType(null), kind: "asserted" };
  }

  let minValue = 1;
  let sawCalibrated = false;
  let sawStale = false;

  for (const section of sections) {
    const asserted =
      section.webProvenance?.confidence ??
      assertedBaselineFromSourceType(
        section.webProvenance?.verificationState === "verified-web-source"
          ? "web"
          : "api",
      );
    const calibrated = calibratedByAtomId?.get(section.atomId) ?? null;
    const stale = calibrationStaleByAtomId?.get(section.atomId) ?? false;
    const eff = effectiveConfidence({
      assertedConfidence: asserted,
      calibratedConfidence: calibrated,
      calibrationStale: stale,
    });
    if (eff.grade === "calibrated") sawCalibrated = true;
    if (eff.grade === "stale") sawStale = true;
    minValue = Math.min(minValue, eff.value);
  }

  const kind: ConfidenceKind = sawCalibrated
    ? "calibrated"
    : sawStale
      ? "asserted"
      : "asserted";
  return { value: minValue, kind };
}

/** Aggregate read-path confidence for briefing / findings / code-atom surfaces. */
export function resolveReadPathConfidence(
  input: ReadPathConfidenceInput,
): EnvelopeConfidence {
  if (input.deterministic) {
    return { value: 1, kind: "deterministic" };
  }

  if (input.codeSections && input.codeSections.length > 0) {
    const fromSections = confidenceFromCodeSections(
      input.codeSections,
      input.calibratedByAtomId,
      input.calibrationStaleByAtomId,
    );
    return fromSections;
  }

  return {
    value: input.assertedBaseline ?? assertedBaselineFromSourceType(null),
    kind: "asserted",
  };
}
