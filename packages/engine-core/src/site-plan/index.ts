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
  DEFAULT_DRAINAGE_RESOLUTION_METERS,
  DEFAULT_RAINFALL_CITATION,
  DEFAULT_RAINFALL_DEPTH_INCHES,
  DESIGN_STORM_RETURN_PERIOD_YEARS,
  HONEST_EMPTY_COMPUTATION,
  HONEST_EMPTY_DEM_VOID,
  HONEST_EMPTY_FLAT_TERRAIN,
  MIN_DRAINAGE_RESOLUTION_METERS,
  NEGLIGIBLE_CATCHMENT_CELLS,
  buildFloodDrainageBriefing,
  clipPondingToParcel,
  deriveDrainageZones,
  featureCollectionAreaSqFt,
  negligibleCatchmentThresholdSqFt,
  paddedCatchmentBbox,
  pointInRing,
  resolveFlowExits,
  resolvePourPoint,
  resolveStudyRainfall,
  runFloodDrainageStudy,
  type FloodDrainageFlowExit,
  type FloodDrainageStudy,
  type FloodDrainageStudyStats,
  type PondingClipResult,
  type PourPointMethod,
  type PourPointResolution,
  type RainfallSource,
  type RunFloodDrainageStudyOptions,
  type RunFloodDrainageStudyResult,
} from "./flood-drainage-study.js";

export {
  GRADIENT_INTENSITY_FLOOR,
  GRADIENT_MAX_AXIS_PX,
  GRADIENT_POND_WEIGHT,
  GRADIENT_RAMP_STOPS,
  buildDrainageGradient,
  computeGradientIntensity,
  downsampleIntensity,
  featherIntensity,
  gradientRampColor,
  type BuildDrainageGradientOptions,
  type FloodDrainageGradient,
} from "./drainage-gradient.js";

export {
  FLOW_PATHS_MAX,
  FLOW_PATH_MAX_POINTS,
  FLOW_PATH_MIN_CELLS,
  SWATH_MAX_HALF_WIDTH_CELLS,
  SWATH_MIN_HALF_WIDTH_CELLS,
  buildFloodFlowPaths,
  buildSwathRing,
  douglasPeuckerIndices,
  type BuildFloodFlowPathsOptions,
  type FloodCatchmentSwath,
  type FloodFlowPath,
  type FloodFlowPathKind,
  type FloodFlowPathsResult,
} from "./flood-flow-paths.js";

export {
  authorParcelFloodDrainageReport,
  type AuthorParcelFloodDrainageReportOptions,
  type AuthorParcelFloodDrainageReportResult,
} from "./flood-drainage-author.js";

export {
  FD_CONTEXT_PAD_FRACTION,
  FLOOD_DRAINAGE_BACKDROP_LINE,
  FLOOD_DRAINAGE_DEFAULT_RAINFALL_NOTE,
  FLOOD_DRAINAGE_DISCLAIMER,
  FLOOD_DRAINAGE_EMPTY_TITLE,
  FLOOD_DRAINAGE_KICKER,
  FLOOD_DRAINAGE_MODEL_BASIS_LINE,
  FLOOD_DRAINAGE_TOTAL_SHEETS,
  catchmentBoundaryRings,
  emitPdfFloodDrainage,
  type EmitPdfFloodDrainageOptions,
  type FloodDrainageDescriptor,
  type PdfFloodDrainageResult,
} from "./pdf/flood-drainage.js";

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
  countSitePlanSheets,
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
  computeMercatorBboxFromWgs84Ring,
  fetchAerialImagery,
  makeWgs84PageTransform,
  type AerialImageFetcher,
  type AerialImageryResult,
} from "./pdf/aerial.js";
