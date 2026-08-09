/**
 * Rail 1 `parcel-node` writer — the seam between the STATEWIDE factory (which
 * acquires jurisdiction-free parcel geometry into `txgio_parcel`) and the
 * ATOM layer the County Manifest actually counts.
 *
 * Before this module, geometry could land for a county and Rail 1 would still
 * read empty, because the manifest reads atoms and nothing wrote a
 * `parcel-node`. The CLI is `scripts/write-parcel-node-county.mjs`.
 */

export {
  SYNTHETIC_PARCEL_KEY_PREFIX,
  classifyGeometryShape,
  isSyntheticParcelKey,
  normalizeParcelKeyToken,
  planCountyParcelNodes,
  sanitizeVintageToken,
  syntheticParcelKey,
  type CountyKeyPolicy,
  type CountyParcelNodePlan,
  type GeometryShape,
  type PlannedAbsentParcel,
  type PlannedParcelNode,
  type PlannedResolvedParcel,
  type TxgioParcelRowInput,
} from "./plan-county-parcel-nodes.js";

export {
  assertNoActiveOrphans,
  reconcileCountyParcelNodes,
  type CountyReconcilePlan,
  type OrphanRetirementVerdict,
  type ParcelNodeOrphan,
  type ParcelNodeSurvivor,
  type StoredParcelNodeRow,
} from "./reconcile-county-parcel-nodes.js";

export {
  assertWarmGateApplied,
  emptyWarmGateTally,
  gateWarmCohort,
  parcelNodeWarmEligibility,
  tallyWarmEligibility,
  type ParcelNodeAnchorState,
  type WarmDeclineCode,
  type WarmEligibility,
  type WarmGateTally,
  type WarmGateVerdict,
} from "./warm-preflight-gate.js";

export {
  buildAtomForPlanned,
  buildAtomsForPlan,
  buildCountyCoverageAtom,
  parcelNodeContentHash,
  verifyStoredParcelNodeAtom,
  type CountyRunProvenance,
  type StoredAtomVerdict,
} from "./parcel-node-atoms.js";
