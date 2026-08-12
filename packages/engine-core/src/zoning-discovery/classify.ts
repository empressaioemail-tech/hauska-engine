/**
 * Map probe evidence to one of seven pinned outcome statuses.
 */

import type { OutcomeStatus } from "./outcomes.js";
import type { ClassifiedVerdict, DiscoveryProbeEvidence, QueueItem } from "./types.js";

function isTransportFailure(path: { httpStatus: number | null; transportError: string | null }): boolean {
  if (path.transportError) return true;
  if (path.httpStatus == null) return true;
  return false;
}

export function classifyDiscoveryEvidence(
  item: QueueItem,
  evidence: DiscoveryProbeEvidence,
): ClassifiedVerdict {
  const notes: string[] = [];
  const classifiedAt = new Date().toISOString();

  if (item.jurisdictionKind === "unincorporated") {
    notes.push("jurisdictionKind=unincorporated → positive NO-ZONING-AUTHORITY");
    return {
      cityKey: item.cityKey,
      status: "NO-ZONING-AUTHORITY",
      layerUrl: null,
      layer: null,
      searchPaths: evidence.searchPaths,
      classifiedAt,
      notes,
    };
  }

  // LAYER-FOUND wins over AUTH-WALLED: one 401 seed must not mask an open host hit.
  if (evidence.bestEuclidean) {
    return {
      cityKey: item.cityKey,
      status: "LAYER-FOUND",
      layerUrl: evidence.bestEuclidean.layerUrl,
      layer: evidence.bestEuclidean,
      searchPaths: evidence.searchPaths,
      classifiedAt,
      notes: [`euclideanScore=${evidence.bestEuclidean.euclideanScore}`],
    };
  }

  if (evidence.anyAuthBlocked) {
    notes.push("HTTP 401/403 on reachable host; no Euclidean layer on any open path");
    return {
      cityKey: item.cityKey,
      status: "AUTH-WALLED",
      layerUrl: null,
      layer: null,
      searchPaths: evidence.searchPaths,
      classifiedAt,
      notes,
    };
  }

  if (
    evidence.constraintLayers.length > 0 &&
    !evidence.layers.some((l) => l.isEuclideanCandidate)
  ) {
    notes.push(
      `constraintLayers=${evidence.constraintLayers.length}; no Euclidean candidate after full recurse`,
    );
    return {
      cityKey: item.cityKey,
      status: "NO-EUCLIDEAN-REGIME",
      layerUrl: null,
      layer: null,
      searchPaths: evidence.searchPaths,
      classifiedAt,
      notes,
    };
  }

  const paths = evidence.searchPaths;
  const allTransportFailed =
    paths.length > 0 && paths.every((p) => isTransportFailure(p) || p.httpStatus === 0);

  if (allTransportFailed && evidence.allPathsTransportFailed) {
    notes.push("every catalogue/hub/seed path failed at transport");
    return {
      cityKey: item.cityKey,
      status: "HOST-BROKEN",
      layerUrl: null,
      layer: null,
      searchPaths: evidence.searchPaths,
      classifiedAt,
      notes,
    };
  }

  if (evidence.emptySearch || paths.length === 0) {
    notes.push("empty search or no hosts resolved");
  } else {
    notes.push("probe completed without positive absence or layer match");
  }

  return {
    cityKey: item.cityKey,
    status: "NOT-FOUND-UNKNOWN-WHY",
    layerUrl: null,
    layer: null,
    searchPaths: evidence.searchPaths,
    classifiedAt,
    notes,
  };
}

export function statusFromString(value: string): OutcomeStatus | null {
  const v = value.trim().toUpperCase();
  const statuses = [
    "NO-ZONING-AUTHORITY",
    "NO-EUCLIDEAN-REGIME",
    "ORDINANCE-NO-GIS",
    "AUTH-WALLED",
    "HOST-BROKEN",
    "NOT-FOUND-UNKNOWN-WHY",
    "LAYER-FOUND",
  ] as const;
  return (statuses as readonly string[]).includes(v) ? (v as OutcomeStatus) : null;
}
