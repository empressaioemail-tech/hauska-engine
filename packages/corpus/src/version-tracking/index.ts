/**
 * Version tracking — Stream 1D / 49 §B.5.
 *
 * Drift detection + amendment ingestion + edition tracking.
 *
 * Drift detection: re-fetch source per jurisdiction on schedule; diff
 * structural extraction; flag changes. New amendment → `code-amendment`
 * atom + new CID on affected `code-section` per ADR-011 chain.
 * `code-edition` atom version bump on amendments. Operator review
 * surface for flagged drift (manual triage before atom updates).
 */

import { atomize, type AtomizationResult } from "../atomization/index.js";
import { buildCodeTree } from "../extraction/extractor.js";
import type { CodeSourceAdapter, CodeReference } from "../adapters/types.js";

export interface DriftSnapshot {
  jurisdictionTenant: string;
  editionLabel: string;
  capturedAt: string;
  sectionContentHashes: Record<string, string>;
  amendmentIds: ReadonlyArray<string>;
}

export interface DriftReport {
  jurisdictionTenant: string;
  comparedAt: string;
  hasChanges: boolean;
  changedSections: ReadonlyArray<{
    sectionEntityId: string;
    priorHash: string;
    currentHash: string;
  }>;
  addedSections: ReadonlyArray<string>;
  removedSections: ReadonlyArray<string>;
  newAmendments: ReadonlyArray<string>;
}

export function captureDriftSnapshot(
  atomization: AtomizationResult,
): DriftSnapshot {
  const sectionContentHashes: Record<string, string> = {};
  for (const section of atomization.sections) {
    sectionContentHashes[section.entityId] = section.contentHash;
  }
  return {
    jurisdictionTenant: atomization.jurisdictionCorpus.jurisdictionTenant,
    editionLabel: atomization.edition.editionLabel,
    capturedAt: atomization.edition.fetchedAt,
    sectionContentHashes,
    amendmentIds: atomization.amendments.map((a) => a.entityId),
  };
}

export function diffSnapshots(
  prior: DriftSnapshot,
  current: DriftSnapshot,
): DriftReport {
  const changedSections: Array<{
    sectionEntityId: string;
    priorHash: string;
    currentHash: string;
  }> = [];
  const addedSections: string[] = [];
  const removedSections: string[] = [];

  const priorIds = new Set(Object.keys(prior.sectionContentHashes));
  const currentIds = new Set(Object.keys(current.sectionContentHashes));

  for (const id of currentIds) {
    if (!priorIds.has(id)) {
      addedSections.push(id);
      continue;
    }
    const priorHash = prior.sectionContentHashes[id];
    const currentHash = current.sectionContentHashes[id];
    if (priorHash && currentHash && priorHash !== currentHash) {
      changedSections.push({ sectionEntityId: id, priorHash, currentHash });
    }
  }
  for (const id of priorIds) {
    if (!currentIds.has(id)) removedSections.push(id);
  }

  const priorAmendments = new Set(prior.amendmentIds);
  const newAmendments = current.amendmentIds.filter(
    (id) => !priorAmendments.has(id),
  );

  return {
    jurisdictionTenant: current.jurisdictionTenant,
    comparedAt: new Date().toISOString(),
    hasChanges:
      changedSections.length > 0 ||
      addedSections.length > 0 ||
      removedSections.length > 0 ||
      newAmendments.length > 0,
    changedSections,
    addedSections,
    removedSections,
    newAmendments,
  };
}

/**
 * Full re-fetch + diff. Used by the scheduled drift detector to
 * surface flagged changes for operator review.
 */
export async function detectDriftAgainstSnapshot(
  adapter: CodeSourceAdapter,
  reference: CodeReference,
  prior: DriftSnapshot,
): Promise<DriftReport> {
  const raw = await adapter.fetch(reference);
  const normalized = await adapter.normalize(raw);
  const tree = buildCodeTree(normalized);
  const current = atomize(tree);
  const currentSnapshot = captureDriftSnapshot(current);
  return diffSnapshots(prior, currentSnapshot);
}
