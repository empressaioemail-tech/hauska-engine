import { buildAtomDid, roadNodeIdFromParts, type RoadNodeAtomInstance } from "@hauska-engine/atoms";

import {
  buildPropertyReadContract,
  propertyNotApplicableConsequence,
  sha256HexCanonical,
  widthedFromMatchBasis,
} from "../property-reasoning/confidence.js";
import {
  classifyCountyStreetAttributes,
  countyRoadSyntheticWayId,
  type CountyStreetAttributes,
} from "./classify-county-street.js";
import { assumedRowWidthFt } from "./classify.js";
import { buildRowEdgesFromCenterline, defaultAttachPoint } from "./geometry.js";
import type { RoadIntakeDescriptor } from "./types.js";

export interface CountyStreetObservation {
  objectId: number;
  displayName?: string;
  attributes: CountyStreetAttributes;
  classification: ReturnType<typeof classifyCountyStreetAttributes>;
  centerline: ReadonlyArray<readonly [number, number]>;
  sourceCitation: string;
  extractedAt: string;
}

export function parseCountyStreetFeature(
  feature: {
    objectId: number;
    attributes: CountyStreetAttributes;
    centerline: ReadonlyArray<readonly [number, number]>;
  },
  extractedAt: string,
): CountyStreetObservation | null {
  if (feature.centerline.length < 2) return null;
  const classification = classifyCountyStreetAttributes(feature.attributes);
  const name =
    feature.attributes.full_name?.trim() ||
    feature.attributes.st_name?.trim() ||
    undefined;
  const surface = feature.attributes.surface?.trim() ?? "";
  const cls = feature.attributes.class?.trim() ?? "";
  return {
    objectId: feature.objectId,
    displayName: name,
    attributes: feature.attributes,
    classification,
    centerline: feature.centerline,
    sourceCitation: [
      `Bastrop County StreetsSurveyed2016 objectid=${feature.objectId}`,
      name ? `name=${name}` : null,
      cls ? `class=${cls}` : null,
      surface ? `surface=${surface}` : null,
    ]
      .filter(Boolean)
      .join(" "),
    extractedAt,
  };
}

export function emitCountySurveyedRoadNode(
  descriptor: RoadIntakeDescriptor,
  obs: CountyStreetObservation,
  version = 1,
): RoadNodeAtomInstance {
  const syntheticWayId = countyRoadSyntheticWayId(obs.objectId);
  const roadNodeId = roadNodeIdFromParts(descriptor.countyFips, syntheticWayId);
  const entityId = roadNodeId;
  const atomDid = buildAtomDid("road-node", entityId).raw;
  const surfaceWidthFt = Number(obs.attributes.surface_wi);
  const widthFt =
    Number.isFinite(surfaceWidthFt) && surfaceWidthFt > 0
      ? surfaceWidthFt
      : assumedRowWidthFt(obs.classification, descriptor.assumedRowWidthFt);
  const { leftEdge, rightEdge } = buildRowEdgesFromCenterline(obs.centerline, widthFt);
  const extractedAt = obs.extractedAt;
  const asserted = widthedFromMatchBasis("prefix");

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
      provenance: {
        kind: "county-surveyed-2016",
        countySegmentObjectId: obs.objectId,
        countyClass: obs.attributes.class?.trim() ?? "",
        countySurface: obs.attributes.surface?.trim() ?? "",
        ...(obs.attributes.rdcls_typ?.trim()
          ? { countyRdclsTyp: obs.attributes.rdcls_typ.trim() }
          : {}),
        ...(Number.isFinite(surfaceWidthFt) && surfaceWidthFt > 0
          ? { surfaceWidthFt }
          : {}),
        ...(obs.attributes.row_notes?.trim()
          ? { rowNotes: obs.attributes.row_notes.trim() }
          : {}),
        note: "Bastrop County surveyed streets 2016 — authoritative surface/class",
      },
      leftEdge,
      rightEdge,
    },
    attachPoints: [defaultAttachPoint(obs.centerline)],
    reasoningChain: { reasoningKind: "observed" },
    jurisdictionTenant: descriptor.jurisdictionTenant,
    fetchedAt: extractedAt,
    sourceAdapter: "road-intake-county-streets-surveyed-2016",
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
        "road-node-county-surveyed-2016-has-no-life-safety-stratum",
        extractedAt,
      ),
      assembledAt: extractedAt,
    }),
    contentHash: "",
  };
  instance.contentHash = sha256HexCanonical(JSON.stringify(instance));
  return instance;
}

export function bastropCountySurveyedRoadDescriptor(): RoadIntakeDescriptor {
  return {
    key: "bastrop_tx_streets_surveyed_2016",
    displayName: "Bastrop County StreetsSurveyed2016",
    jurisdictionTenant: "breadth_48021_bastrop",
    countyFips: "48021",
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
    sourceAdapter: "road-intake-county-streets-surveyed-2016",
    sourceUrl:
      "https://maps.co.bastrop.tx.us/server/rest/services/RoadAndBridgeMap/StreetsSurveyed2016/FeatureServer",
  };
}
