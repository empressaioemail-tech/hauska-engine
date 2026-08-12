import type { OutcomeStatus } from "./outcomes.js";

export type Bbox4326 = {
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
};

export type JurisdictionKind = "incorporated-city" | "unincorporated" | "unknown";

export type QueueItem = {
  cityKey: string;
  cityName: string;
  cityGeoId: string;
  parentCountyFips: string;
  jurisdictionKind: JurisdictionKind;
  bbox4326: Bbox4326;
  seedHostUrls?: string[];
};

export type HostCatalogueEntry = {
  hostId: string;
  kind: "agol-org" | "county-rest-root" | "municipal-rest-root" | "cog-portal" | "ckan-portal";
  baseUrl: string;
  evidenceUrl: string;
  observedAt: string;
  notes?: string;
};

export type HostCatalogue = {
  hosts: HostCatalogueEntry[];
};

export type SearchPathSource = "seed" | "catalogue" | "agol-hub" | "txgio-ckan";

export type SearchPathAttempt = {
  url: string;
  source: SearchPathSource;
  httpStatus: number | null;
  transportError: string | null;
  authBlocked: boolean;
  pathsAttempted: string[];
  layersInspected: number;
};

export type LayerFieldMeta = {
  name: string;
  type: string;
  alias?: string;
};

export type LayerProbeMeta = {
  layerUrl: string;
  servicePath: string;
  layerId: number;
  name: string;
  geometryType: string | null;
  featureCount: number | null;
  fields: LayerFieldMeta[];
  codeField: string | null;
  descriptionField: string | null;
  extent: Bbox4326 | null;
  euclideanScore: number;
  isConstraintLayer: boolean;
  isEuclideanCandidate: boolean;
  rejectReason: string | null;
};

export type DiscoveryProbeEvidence = {
  cityKey: string;
  searchPaths: SearchPathAttempt[];
  layers: LayerProbeMeta[];
  bestEuclidean: LayerProbeMeta | null;
  constraintLayers: LayerProbeMeta[];
  emptySearch: boolean;
  allPathsTransportFailed: boolean;
  anyAuthBlocked: boolean;
};

export type ClassifiedVerdict = {
  cityKey: string;
  status: OutcomeStatus;
  layerUrl: string | null;
  layer: LayerProbeMeta | null;
  searchPaths: SearchPathAttempt[];
  classifiedAt: string;
  notes: string[];
};

export const RUNNER_VERSION = "0.1.0";
