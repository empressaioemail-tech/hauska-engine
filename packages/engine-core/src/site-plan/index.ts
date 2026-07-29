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
  mapBuildableDisplay,
  violatesHistoricalDisagreementGuard,
  resolveBuildableAreaSqFt,
  type BuildableDisplayInput,
  type BuildableDisplayKind,
  type BuildableDisplayVocab,
} from "./buildable-display-vocab.js";

export {
  buildDxfSitePlanRequest,
  emitDxfSitePlan,
  emitIfcSitePlan,
  type DxfSitePlanResult,
  type IfcSitePlanResult,
} from "./emitters.js";

export {
  authorParcelSitePlanExport,
  composeSitePlanModelForParcel,
  type AuthorParcelSitePlanExportOptions,
  type AuthorParcelSitePlanExportResult,
  type ComposeSitePlanModelForParcelResult,
} from "./author.js";

export {
  authorParcelPropertyDossierExport,
  type AuthorParcelPropertyDossierExportOptions,
  type AuthorParcelPropertyDossierExportResult,
} from "./dossier-author.js";

export {
  DOSSIER_CAPS,
  DOSSIER_NOT_LEGAL_ADVICE,
  DOSSIER_USER_CONTENT_DISCLOSURE,
  emitPdfDossier,
  sanitizeDossierContent,
  sanitizeDossierText,
  type DossierBriefFactInput,
  type DossierBriefSectionInput,
  type DossierContentInput,
  type EmitPdfDossierOptions,
  type PdfDossierResult,
} from "./pdf/dossier.js";

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
  PROPERTY_LINE_TAGS_HONESTY,
  clipPolylineToAabb,
  craftLabelFontSize,
  estimateTextWidth,
  formatGisBearing,
  formatPropertyLineTag,
  placeNonCollidingEdgeLabels,
  placeNonCollidingPointLabels,
} from "./pdf/annotation-placement.js";

export {
  PROPERTY_LINE_TAGS_ATOM_HONESTY,
  PROPERTY_LINE_TAGS_PROVENANCE_KIND,
  PROPERTY_LINE_TAGS_SOURCE,
  computePropertyLineTagsFromLocalEnuEndpoints,
  propertyLineTagsHonestyIsGisApproximate,
  type PropertyLineTags,
} from "../geometry/gis-property-line-tags.js";

export {
  buildProvenancePanelEntries,
  SITE_PLAN_HONESTY_LINE,
  type ProvenancePanelEntry,
} from "./pdf/provenance.js";

export {
  emitPdfSitePlan,
  TOTAL_SHEETS,
  type EmitPdfSitePlanOptions,
  type PdfSitePlanResult,
  type SheetNumbering,
} from "./pdf/render.js";

export {
  AERIAL_IMAGERY_ATTRIBUTION,
  AERIAL_NOT_A_SURVEY_LINE,
  AERIAL_UNAVAILABLE_NOTE,
  fetchAerialImagery,
  type AerialImageFetcher,
  type AerialImageryResult,
} from "./pdf/aerial.js";
