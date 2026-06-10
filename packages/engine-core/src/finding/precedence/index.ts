export {
  reconcileStandardPrecedence,
  reconcileRequirementsByTopic,
  formatPrecedenceFindingText,
} from "./reconcile.js";

export {
  compareStringency,
  pickMostStringent,
  allAlign,
} from "./comparability.js";

export {
  detectStandardDescriptor,
  codeSectionToRequirementShell,
} from "./standardRegistry.js";

export {
  buildAdaFhaA117DoorClearanceRequirements,
  buildLocalAmendmentOverlayRequirement,
  buildFederalPreemptPair,
  ADA_DOOR_CLEARANCE_ATOM_ID,
  FHA_DOOR_CLEARANCE_ATOM_ID,
  A1171_DOOR_CLEARANCE_ATOM_ID,
} from "./accessibilityDemo.js";

export type {
  ApplicableRequirement,
  PrecedenceConflict,
  PrecedenceDomain,
  PrecedenceReconciliationResult,
  PrecedenceRuleApplied,
  ReconcileRequirementsByTopicInput,
  ReconcileRequirementsByTopicResult,
  ReconcileStandardPrecedenceOptions,
  RequirementKind,
  StandardAuthority,
} from "./types.js";

export type { StandardDescriptor } from "./standardRegistry.js";
