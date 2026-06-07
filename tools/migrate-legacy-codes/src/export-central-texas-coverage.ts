import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { CodeSectionAtomInstance } from "@hauska-engine/atoms";
import type { CorpusSnapshot } from "@hauska-engine/storage";

import { ENGINE_CORPUS_JURISDICTION_KEYS } from "./central-texas-pilot-keys.js";
import { readCorpusSnapshot } from "./snapshot-to-legacy-jsonl.js";

export interface CentralTexasCoverageEntry {
  jurisdictionKey: string;
  atomCount: number;
  sectionsWithBody: number;
  eval?: {
    top3Score: number | null;
    sectionNumScore: number | null;
    crossRefScore: number | null;
    qualityBar: string;
  };
}

export interface CentralTexasCoverageArtifact {
  format: "hauska-central-texas-coverage/1";
  generatedAt: string;
  snapshotGeneratedAt: string;
  keysMatchBaseline: boolean;
  baselineKeyCount: number;
  jurisdictions: CentralTexasCoverageEntry[];
}

export function buildCentralTexasCoverageFromSnapshot(
  snapshot: CorpusSnapshot,
): CentralTexasCoverageArtifact {
  const sections = snapshot.atoms.filter(
    (a): a is CodeSectionAtomInstance => a.entityType === "code-section",
  );

  const byKey = new Map<string, { total: number; withBody: number }>();
  for (const key of ENGINE_CORPUS_JURISDICTION_KEYS) {
    byKey.set(key, { total: 0, withBody: 0 });
  }
  for (const s of sections) {
    const bucket = byKey.get(s.jurisdictionTenant);
    if (!bucket) continue;
    bucket.total++;
    if (s.bodyText?.trim()) bucket.withBody++;
  }

  const statusByKey = new Map(
    snapshot.jurisdictionStatus.map((s) => [s.jurisdictionTenant, s]),
  );

  const jurisdictions: CentralTexasCoverageEntry[] = [];
  for (const key of ENGINE_CORPUS_JURISDICTION_KEYS) {
    const counts = byKey.get(key) ?? { total: 0, withBody: 0 };
    const status = statusByKey.get(key);
    jurisdictions.push({
      jurisdictionKey: key,
      atomCount: counts.total,
      sectionsWithBody: counts.withBody,
      eval: status
        ? {
            top3Score: status.top3Score,
            sectionNumScore: status.sectionNumScore,
            crossRefScore: status.crossRefScore,
            qualityBar: status.qualityBar,
          }
        : undefined,
    });
  }

  const snapshotKeys = new Set(
    snapshot.jurisdictionStatus.map((s) => s.jurisdictionTenant),
  );
  const keysMatchBaseline = ENGINE_CORPUS_JURISDICTION_KEYS.every((k) =>
    snapshotKeys.has(k),
  );

  return {
    format: "hauska-central-texas-coverage/1",
    generatedAt: new Date().toISOString(),
    snapshotGeneratedAt: snapshot.generatedAt,
    keysMatchBaseline,
    baselineKeyCount: ENGINE_CORPUS_JURISDICTION_KEYS.length,
    jurisdictions,
  };
}

export async function buildCentralTexasCoverage(options: {
  snapshotPath: string;
}): Promise<CentralTexasCoverageArtifact> {
  const snapshot = await readCorpusSnapshot(options.snapshotPath);
  return buildCentralTexasCoverageFromSnapshot(snapshot);
}

export async function writeCentralTexasCoverageArtifact(options: {
  snapshotPath: string;
  outPath: string;
}): Promise<CentralTexasCoverageArtifact> {
  const artifact = await buildCentralTexasCoverage({
    snapshotPath: options.snapshotPath,
  });
  await writeFile(options.outPath, JSON.stringify(artifact, null, 2) + "\n", "utf8");
  return artifact;
}

export function defaultCoverageOutPath(repoRoot: string): string {
  return join(repoRoot, "services/retrieval-api/corpus/central_texas_coverage.json");
}
