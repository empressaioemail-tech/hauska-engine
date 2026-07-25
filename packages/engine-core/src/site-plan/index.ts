export {
  computeSetbackOffset,
  assignSetbackRoles,
  dedupeClosingVertex,
  ringSegments,
  type FrontEdgeBasis,
  type LocalPoint,
  type RingSegment,
  type SetbackAssignment,
  type SetbackOffsetResult,
  type SetbackRole,
} from "./ring-geometry.js";

export {
  composeSitePlanModel,
  type ComposeSitePlanModelInputs,
  type ElevationLabel,
  type SetbackRuleInput,
  type SitePlanModel,
  type SitePlanNorthModel,
  type SitePlanSetbackModel,
  type SitePlanStreetModel,
  type StreetAnchorInput,
} from "./site-model.js";

export {
  buildDxfSitePlanRequest,
  emitDxfSitePlan,
  emitIfcSitePlan,
  type DxfSitePlanResult,
  type IfcSitePlanResult,
} from "./emitters.js";

export {
  authorParcelSitePlanExport,
  type AuthorParcelSitePlanExportOptions,
  type AuthorParcelSitePlanExportResult,
} from "./author.js";
