import { buildAtomDid, roadNodeIdFromParts, type RoadNodeAtomInstance } from "@hauska-engine/atoms";

import {
  buildPropertyReadContract,
  propertyNotApplicableConsequence,
  sha256HexCanonical,
  widthedFromMatchBasis,
} from "../property-reasoning/confidence.js";
import {
  bastropRoadwayIsAuthoritative,
  classifyBastropRoadwayAttributes,
  countyRoadwaySyntheticWayId,
  type BastropRoadwayAttributes,
} from "./classify-county-street.js";
import { assumedRowWidthFt } from "./classify.js";
import { buildRowEdgesFromCenterline, defaultAttachPoint } from "./geometry.js";
import type { RoadIntakeDescriptor } from "./types.js";

export interface BastropRoadwayObservation {
  objectId: number;
  displayName?: string;
  attributes: BastropRoadwayAttributes;
  classification: ReturnType<typeof classifyBastropRoadwayAttributes>;
  centerline: ReadonlyArray<readonly [number, number]>;
  sourceCitation: string;
  extractedAt: string;
}

export function parseBastropRoadwayFeature(
  feature: {
    objectId: number;
    attributes: BastropRoadwayAttributes;
    centerline: ReadonlyArray<readonly [number, number]>;
  },
  extractedAt: string,
): BastropRoadwayObservation | null {
  if (feature.centerline.length < 2) return null;
  const classification = classifyBastropRoadwayAttributes(feature.attributes);
  const name =
    feature.attributes.full_name?.trim() ||
    feature.attributes.st_name?.trim() ||
    undefined;
  const surface = feature.attributes.surface?.trim() ?? "";
  const cls = feature.attributes.class?.trim() ?? "";
  const owner = feature.attributes.owner?.trim() ?? "";
  return {
    objectId: feature.objectId,
    displayName: name,
    attributes: feature.attributes,
    classification,
    centerline: feature.centerline,
    sourceCitation: [
      `Bastrop_County_Roadway objectid=${feature.objectId}`,
      name ? `name=${name}` : null,
      owner ? `owner=${owner}` : null,
      cls ? `class=${cls}` : null,
      surface ? `surface=${surface}` : null,
    ]
      .filter(Boolean)
      .join(" "),
    extractedAt,
  };
}

export function emitCountyRoadwayRoadNode(
  descriptor: RoadIntakeDescriptor,
  obs: BastropRoadwayObservation,
  version = 1,
): RoadNodeAtomInstance {
  const syntheticWayId = countyRoadwaySyntheticWayId(obs.objectId);
  const roadNodeId = roadNodeIdFromParts(descriptor.countyFips, syntheticWayId);
  const entityId = roadNodeId;
  const atomDid = buildAtomDid("road-node", entityId).raw;
  const surfaceWidthFt = Number(
    obs.attributes.surface_width ?? obs.attributes.surface_wi,
  );
  const widthFt =
    Number.isFinite(surfaceWidthFt) && surfaceWidthFt > 0
      ? surfaceWidthFt
      : assumedRowWidthFt(obs.classification, descriptor.assumedRowWidthFt);
  const { leftEdge, rightEdge } = buildRowEdgesFromCenterline(obs.centerline, widthFt);
  const extractedAt = obs.extractedAt;
  const asserted = widthedFromMatchBasis("prefix");
  const authoritative = bastropRoadwayIsAuthoritative(obs.attributes);

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
            countyClass: obs.attributes.class?.trim() ?? "",
            countySurface: obs.attributes.surface?.trim() ?? "",
            ...(obs.attributes.rdcls_typ?.trim()
              ? { countyRdclsTyp: obs.attributes.rdcls_typ.trim() }
              : {}),
            ...(obs.attributes.owner?.trim()
              ? { countyOwner: obs.attributes.owner.trim() }
              : {}),
            ...(obs.attributes.l_muni?.trim()
              ? { countyLMuni: obs.attributes.l_muni.trim() }
              : {}),
            ...(obs.attributes.r_muni?.trim()
              ? { countyRMuni: obs.attributes.r_muni.trim() }
              : {}),
            ...(Number.isFinite(surfaceWidthFt) && surfaceWidthFt > 0
              ? { surfaceWidthFt }
              : {}),
            ...(obs.attributes.row_notes?.trim()
              ? { rowNotes: obs.attributes.row_notes.trim() }
              : {}),
            note: "Bastrop County Roadway — defined surface/class only",
          }
        : {
            kind: "county-roadway-undefined",
            countySegmentObjectId: obs.objectId,
            countyClass: obs.attributes.class?.trim() ?? "",
            countySurface: obs.attributes.surface?.trim() ?? "",
            ...(obs.attributes.rdcls_typ?.trim()
              ? { countyRdclsTyp: obs.attributes.rdcls_typ.trim() }
              : {}),
            ...(obs.attributes.owner?.trim()
              ? { countyOwner: obs.attributes.owner.trim() }
              : {}),
            ...(obs.attributes.l_muni?.trim()
              ? { countyLMuni: obs.attributes.l_muni.trim() }
              : {}),
            ...(obs.attributes.r_muni?.trim()
              ? { countyRMuni: obs.attributes.r_muni.trim() }
              : {}),
            note: "Geometry only — surface Undefined/empty; OSM best-available for labeling",
          },
      leftEdge,
      rightEdge,
    },
    attachPoints: [defaultAttachPoint(obs.centerline)],
    reasoningChain: { reasoningKind: "observed" },
    jurisdictionTenant: descriptor.jurisdictionTenant,
    fetchedAt: extractedAt,
    sourceAdapter: "road-intake-bastrop-county-roadway",
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
        "road-node-county-roadway-has-no-life-safety-stratum",
        extractedAt,
      ),
      assembledAt: extractedAt,
    }),
    contentHash: "",
  };
  instance.contentHash = sha256HexCanonical(JSON.stringify(instance));
  return instance;
}

export function bastropCountyRoadwayDescriptor(): RoadIntakeDescriptor {
  return {
    key: "bastrop_tx_county_roadway",
    displayName: "Bastrop County Roadway",
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
    sourceAdapter: "road-intake-bastrop-county-roadway",
    sourceUrl:
      "https://maps.co.bastrop.tx.us/server/rest/services/Transportation_BP/Bastrop_County_Roadway/MapServer/0",
  };
}
