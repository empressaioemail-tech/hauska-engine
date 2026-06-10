/**
 * Demonstration fixtures for the combine-A117.1 + ADA + FHA case.
 *
 * ADA + FHA are live in the federal-accessibility-standards corpus (PR #66).
 * A117.1 is credential-pending — stubbed here per dispatch until ICC OAuth lands.
 */

import type { ApplicableRequirement } from "./types";

/** Corpus-aligned atom ids (hauska-engine PR #66 tenant paths). */
export const ADA_DOOR_CLEARANCE_ATOM_ID =
  "federal-accessibility-standards/2010-ada-standards-for-accessible-design/404.2.3-clear-width";

export const FHA_DOOR_CLEARANCE_ATOM_ID =
  "federal-accessibility-standards/fair-housing-act-design-manual-april-1998/ch4-door-clear-width";

/** Stub — ICC Code Connect credential-pending per WS3 dispatch. */
export const A1171_DOOR_CLEARANCE_ATOM_ID =
  "icc-model-code/a117.1-2021/404.2.3.2-clear-width-stub";

/**
 * Door maneuvering clearance — latch-side dimension (inches).
 * FHA Design Manual requires 24" latch-side clearance for certain dwelling units;
 * ADA 2010 requires 18"; A117.1-2021 stub at 18" (less stringent model code).
 */
export function buildAdaFhaA117DoorClearanceRequirements(): ApplicableRequirement[] {
  return [
    {
      atomId: ADA_DOOR_CLEARANCE_ATOM_ID,
      standardKey: "ada-2010",
      standardLabel: "2010 ADA Standards for Accessible Design",
      authority: "federal",
      topic: "door-maneuvering-clearance",
      dimension: "latch-side clearance",
      requirementKind: "minimum",
      numericValue: 18,
      numericUnit: "in",
      citationLabel: "ADA §404.2.3.2 latch-side clearance",
      snippet: "Minimum 18 inches latch-side clearance at door maneuvering space.",
      confidence: 0.94,
    },
    {
      atomId: FHA_DOOR_CLEARANCE_ATOM_ID,
      standardKey: "fha-design-manual",
      standardLabel: "Fair Housing Act Design Manual",
      authority: "federal",
      topic: "door-maneuvering-clearance",
      dimension: "latch-side clearance",
      requirementKind: "minimum",
      numericValue: 24,
      numericUnit: "in",
      citationLabel: "FHA Design Manual Ch.4 door maneuvering clearance",
      snippet: "24 inches latch-side clearance at entrance doors to covered dwelling units.",
      confidence: 0.91,
    },
    {
      atomId: A1171_DOOR_CLEARANCE_ATOM_ID,
      standardKey: "a117.1-2021",
      standardLabel: "ICC A117.1-2021 (credential-pending stub)",
      authority: "model-code",
      topic: "door-maneuvering-clearance",
      dimension: "latch-side clearance",
      requirementKind: "minimum",
      numericValue: 18,
      numericUnit: "in",
      citationLabel: "A117.1 §404.2.3.2 latch-side clearance (stub)",
      snippet: "Stub section — live ingest pending ICC Code Connect credentials.",
      confidence: 0.75,
    },
  ];
}

/** Local amendment tightening model-code door clearance on the same topic. */
export function buildLocalAmendmentOverlayRequirement(
  overlaysAtomId: string,
): ApplicableRequirement {
  return {
    atomId: "jurisdiction/bastrop-tx/ibc-amendment/door-clearance-404",
    standardKey: "local-amendment",
    standardLabel: "Bastrop IBC local amendment",
    authority: "local-amendment",
    topic: "door-maneuvering-clearance",
    dimension: "latch-side clearance",
    requirementKind: "minimum",
    numericValue: 20,
    numericUnit: "in",
    citationLabel: "Bastrop IBC Amendment §404 door clearance",
    snippet: "Local amendment requires 20 inches latch-side clearance.",
    confidence: 0.88,
    overlaysAtomId,
  };
}

/** Federal-only pair for federal-preempt tests without model code. */
export function buildFederalPreemptPair(): ApplicableRequirement[] {
  return buildAdaFhaA117DoorClearanceRequirements().filter(
    (r) => r.authority === "federal",
  );
}
