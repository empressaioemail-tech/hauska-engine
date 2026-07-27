export {
  computeSetbackOffset,
  assignSetbackRoles,
  dedupeClosingVertex,
  ringSegments,
  type ComputeSetbackOffsetOptions,
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
  type FloodZoneSummaryInput,
  type SetbackRuleInput,
  type SitePlanDescriptorInput,
  type SitePlanModel,
  type SitePlanNorthModel,
  type SitePlanSetbackModel,
  type SitePlanStreetAnchorModel,
  type SitePlanStreetModel,
  type SitePlanSummaryModel,
  type StreetAnchorInput,
  type ZoningSummaryInput,
} from "./site-model.js";

export {
  streetAnchorFromRoadNode,
  streetAnchorsFromRoadNodes,
  type RoadNodeStreetSource,
} from "./road-street-anchors.js";

export {
  expandRingBbox,
  filterRoadsAttachingByProximity,
  resolveAttachingRoadNodes,
  roadIdsFromBoundaryEdges,
  type ParcelBboxWgs84,
  type ResolveAttachingRoadNodesResult,
} from "./resolve-attaching-roads.js";

export {
  anyNotSpecified,
  formatSetbackEdgeLabel,
  formatSetbackSummaryLine,
  notSpecifiedAxesFromSetbackTable,
  resolveNotSpecifiedAxes,
  type NotSpecifiedAxes,
} from "./setback-display.js";

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

export {
  buildSitePlanDrawingLayout,
  computeDrawingTransform,
  projectPoint,
  type DrawingBox,
  type PageXY,
  type PdfTransform,
  type SitePlanDrawingLayout,
} from "./pdf/layout.js";

export {
  buildProvenancePanelEntries,
  SITE_PLAN_HONESTY_LINE,
  type ProvenancePanelEntry,
} from "./pdf/provenance.js";

export { emitPdfSitePlan, type PdfSitePlanResult } from "./pdf/render.js";
