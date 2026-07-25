import { buildAtomDid, roadNodeIdFromParts, type RoadNodeAtomInstance } from "@hauska-engine/atoms";

import {
  buildPropertyReadContract,
  propertyNotApplicableConsequence,
  sha256HexCanonical,
  widthedFromMatchBasis,
} from "../property-reasoning/confidence.js";
import { assumedRowWidthFt, classifyOsmHighwayTag } from "./classify.js";
import { buildRowEdgesFromCenterline, defaultAttachPoint } from "./geometry.js";
import type { OsmRoadObservation, ParsedOsmElement, RoadIntakeDescriptor } from "./types.js";

export function parseOsmWayElement(
  element: ParsedOsmElement,
  extractedAt: string,
): OsmRoadObservation | null {
  if (element.type !== "way" || !Array.isArray(element.geometry) || element.geometry.length < 2) {
    return null;
  }
  const tags = element.tags ?? {};
  const highwayTag = tags.highway ?? "";
  const classification = classifyOsmHighwayTag(highwayTag, tags);
  const name = tags.name?.trim();
  const centerline = element.geometry.map(
    (g) => [g.lon, g.lat] as readonly [number, number],
  );
  const citationParts = [`OpenStreetMap way/${element.id}`, `highway=${highwayTag}`];
  if (name) citationParts.push(`name=${name}`);
  return {
    osmWayId: element.id,
    displayName: name || undefined,
    osmHighwayTag: highwayTag,
    osmTags: tags,
    classification,
    centerline,
    sourceCitation: citationParts.join(" "),
    extractedAt,
  };
}

export function emitRoadNode(
  descriptor: RoadIntakeDescriptor,
  obs: OsmRoadObservation,
  version = 1,
): RoadNodeAtomInstance {
  const roadNodeId = roadNodeIdFromParts(descriptor.countyFips, obs.osmWayId);
  const entityId = roadNodeId;
  const atomDid = buildAtomDid("road-node", entityId).raw;
  const widthFt = assumedRowWidthFt(obs.classification, descriptor.assumedRowWidthFt);
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
    osmWayId: obs.osmWayId,
    classification: obs.classification,
    centerline: { type: "LineString", coordinates: [...obs.centerline] },
    row: {
      assumedWidthFt: widthFt,
      provenance: {
        kind: "approximate-assumed-per-class",
        assumedWidthTableKey: obs.classification,
        osmHighwayTag: obs.osmHighwayTag,
        ...(obs.osmTags?.surface
          ? { surface: obs.osmTags.surface }
          : {}),
        note: "v1 assumed ROW — not survey/CAD",
      },
      leftEdge,
      rightEdge,
    },
    attachPoints: [defaultAttachPoint(obs.centerline)],
    reasoningChain: { reasoningKind: "observed" },
    jurisdictionTenant: descriptor.jurisdictionTenant,
    fetchedAt: extractedAt,
    sourceAdapter: descriptor.sourceAdapter,
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
        "road-node-v1-approximate-row-has-no-life-safety-stratum",
        extractedAt,
      ),
      assembledAt: extractedAt,
    }),
    contentHash: "",
  };
  instance.contentHash = sha256HexCanonical(JSON.stringify(instance));
  return instance;
}

export function bastropRoadIntakeDescriptor(): RoadIntakeDescriptor {
  return {
    key: "bastrop_tx_roads",
    displayName: "Bastrop city + county road pilot",
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
    sourceAdapter: "road-intake-osm-overpass",
    sourceUrl: "https://overpass-api.de/api/interpreter",
  };
}
