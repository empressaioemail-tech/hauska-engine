/**
 * Map findings input code sections to applicable requirements and run
 * ADR-019 / ADR-021 precedence reconciliation when multiple standards
 * cover the same topic.
 */

import type { GenerateFindingsInput } from "../types.js";
import {
  ADA_DOOR_CLEARANCE_ATOM_ID,
  A1171_DOOR_CLEARANCE_ATOM_ID,
  FHA_DOOR_CLEARANCE_ATOM_ID,
  buildAdaFhaA117DoorClearanceRequirements,
  reconcileRequirementsByTopic,
  type ApplicableRequirement,
  type ReconcileRequirementsByTopicResult,
} from "../precedence/index.js";

const KNOWN_ACCESSIBILITY_ATOMS = new Set([
  ADA_DOOR_CLEARANCE_ATOM_ID,
  FHA_DOOR_CLEARANCE_ATOM_ID,
  A1171_DOOR_CLEARANCE_ATOM_ID,
]);

function extractKnownAccessibilityRequirements(
  input: GenerateFindingsInput,
): ApplicableRequirement[] {
  const atomIds = new Set(input.codeSections.map((c) => c.atomId));
  const matched = buildAdaFhaA117DoorClearanceRequirements().filter((r) =>
    atomIds.has(r.atomId),
  );
  if (matched.length >= 2) return matched;

  const accessibilityHits = input.codeSections.filter(
    (c) =>
      KNOWN_ACCESSIBILITY_ATOMS.has(c.atomId) ||
      /ada|fha|a117|accessible|door.*clear/i.test(`${c.atomId} ${c.label}`),
  );
  if (accessibilityHits.length < 2) return matched;

  const demo = buildAdaFhaA117DoorClearanceRequirements();
  return demo.slice(0, Math.min(demo.length, accessibilityHits.length));
}

/** Run precedence reconciliation for code sections on the findings read path. */
export function runFindingsPrecedencePass(
  input: GenerateFindingsInput,
): ReconcileRequirementsByTopicResult | null {
  const requirements = extractKnownAccessibilityRequirements(input);
  if (requirements.length < 2) return null;

  return reconcileRequirementsByTopic({
    requirements,
    options: { domain: "accessibility" },
  });
}
