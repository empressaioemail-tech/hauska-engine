import { buildAtomDid, roadNodeIdFromParts, type RoadNodeAtomInstance } from "@hauska-engine/atoms";

import {
  buildPropertyReadContract,
  propertyNotApplicableConsequence,
  sha256HexCanonical,
  widthedFromMatchBasis,
} from "../property-reasoning/confidence.js";
import {
  caldwellCadIsAuthoritative,
  caldwellCadSyntheticWayId,
  classifyCaldwellCadAttributes,
  type CaldwellCadRoadAttributes,
} from "./classify-caldwell-cad.js";
import { assumedRowWidthFt } from "./classify.js";
import { buildRowEdgesFromCenterline, defaultAttachPoint } from "./geometry.js";
import type { RoadIntakeDescriptor } from "./types.js";

const CALDWELL_CAD_ROAD_CENTERLINES_URL =
  "https://services.arcgis.com/rVxY74DxxIDrDbc0/arcgis/rest/services/Caldwell_CAD_Parcel_Map/FeatureServer/6";

export interface CaldwellCadRoadObservation {
  objectId: number;
  displayName?: string;
  attributes: CaldwellCadRoadAttributes;
  classification: ReturnType<typeof classifyCaldwellCadAttributes>;
  centerline: ReadonlyArray<readonly [number, number]>;
  sourceCitation: string;
  extractedAt: string;
}

export function parseCaldwellCadRoadFeature(
  feature: {
    objectId: number;
    attributes: CaldwellCadRoadAttributes;
    centerline: ReadonlyArray<readonly [number, number]>;
  },
  extractedAt: string,
): CaldwellCadRoadObservation | null {
  if (feature.centerline.length < 2) return null;
  const classification = classifyCaldwellCadAttributes(feature.attributes);
  const name = feature.attributes.ROADNAME?.toString().trim() || undefined;
  const surface = feature.attributes.SURFACE?.toString().trim() ?? "";
  const cls = feature.attributes.CLASS?.toString().trim() ?? "";
  const roadType = feature.attributes.ROADTYPE?.toString().trim() ?? "";
  return {
    objectId: feature.objectId,
    displayName: name,
    attributes: feature.attributes,
    classification,
    centerline: feature.centerline,
    sourceCitation: [
      `Caldwell_CAD_Road_Centerlines OBJECTID=${feature.objectId}`,
      name ? `name=${name}` : null,
      cls ? `class=${cls}` : null,
      surface ? `surface=${surface}` : null,
      roadType ? `roadtype=${roadType}` : null,
    ]
      .filter(Boolean)
      .join(" "),
    extractedAt,
  };
}

export function emitCaldwellCadRoadNode(
  descriptor: RoadIntakeDescriptor,
  obs: CaldwellCadRoadObservation,
  version = 1,
): RoadNodeAtomInstance {
  const syntheticWayId = caldwellCadSyntheticWayId(obs.objectId);
  const roadNodeId = roadNodeIdFromParts(descriptor.countyFips, syntheticWayId);
  const entityId = roadNodeId;
  const atomDid = buildAtomDid("road-node", entityId).raw;
  const widthFt = assumedRowWidthFt(obs.classification, descriptor.assumedRowWidthFt);
  const { leftEdge, rightEdge } = buildRowEdgesFromCenterline(obs.centerline, widthFt);
  const extractedAt = obs.extractedAt;
  const asserted = widthedFromMatchBasis("prefix");
  const authoritative = caldwellCadIsAuthoritative(obs.attributes);
  const surface = obs.attributes.SURFACE?.toString().trim() ?? "";
  const cls = obs.attributes.CLASS?.toString().trim() ?? "";

  const instance: RoadNodeAtomInstance = {
    entityType: "road-node",
    atomDid,
    entityId,
    roadNodeId,
    displayName: obs.displayName,
    countyFips: descriptor.countyFips,
    osmWayId: syntheticWayId,
    classification: obs.classification,
    centerline: { type: "LineString", coordinates: [...obs.centerline] },
    row: {
      assumedWidthFt: widthFt,
      provenance: authoritative
        ? {
            kind: "county-roadway-authoritative",
            countySegmentObjectId: obs.objectId,
            countyClass: cls,
            countySurface: surface,
            note: "Caldwell CAD Road_Centerlines — defined SURFACE only",
          }
        : {
            kind: "county-roadway-undefined",
            countySegmentObjectId: obs.objectId,
            countyClass: cls,
            countySurface: surface,
            note: "Geometry only — SURFACE empty/sentinel; OSM best-available for city labeling",
          },
      leftEdge,
      rightEdge,
    },
    attachPoints: [defaultAttachPoint(obs.centerline)],
    reasoningChain: { reasoningKind: "observed" },
    jurisdictionTenant: descriptor.jurisdictionTenant,
    fetchedAt: extractedAt,
    sourceAdapter: "road-intake-caldwell-cad-centerlines",
    sourceUrl: descriptor.sourceUrl,
    accessPolicy: descriptor.defaultAccessPolicy,
    sourceCitation: obs.sourceCitation,
    extractedAt,
    atomTier: "data",
    status: "active",
    versionStamp: `${roadNodeId}:road-node:${version}:${extractedAt}`,
    readContract: buildPropertyReadContract({
      asserted,
      consequence: propertyNotApplicableConsequence(
        "road-node-caldwell-cad-has-no-life-safety-stratum",
        extractedAt,
      ),
      assembledAt: extractedAt,
    }),
    contentHash: "",
  };
  instance.contentHash = sha256HexCanonical(JSON.stringify(instance));
  return instance;
}

export function caldwellCadRoadIntakeDescriptor(): RoadIntakeDescriptor {
  return {
    key: "caldwell_tx_cad_centerlines",
    displayName: "Caldwell CAD Road_Centerlines",
    jurisdictionTenant: "breadth_48055_caldwell",
    countyFips: "48055",
    defaultAccessPolicy: "public-free",
    assumedRowWidthFt: {
      highway: 100,
      major_collector: 60,
      minor_collector: 50,
      residential: 50,
      alley: 20,
      gravel: 30,
      unclassified: 40,
    },
    sourceAdapter: "road-intake-caldwell-cad-centerlines",
    sourceUrl: CALDWELL_CAD_ROAD_CENTERLINES_URL,
  };
}

export function caldwellOsmRoadIntakeDescriptor(): RoadIntakeDescriptor {
  return {
    key: "caldwell_tx_osm",
    displayName: "Caldwell County OSM roads (Lockhart city best-available)",
    jurisdictionTenant: "breadth_48055_caldwell",
    countyFips: "48055",
    defaultAccessPolicy: "public-free",
    assumedRowWidthFt: {
      highway: 100,
      major_collector: 60,
      minor_collector: 50,
      residential: 50,
      alley: 20,
      gravel: 30,
      unclassified: 40,
    },
    sourceAdapter: "road-intake-caldwell-osm",
    sourceUrl: "https://overpass-api.de/api/interpreter",
  };
}
