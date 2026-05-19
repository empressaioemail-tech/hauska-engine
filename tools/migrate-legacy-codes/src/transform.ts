/**
 * Transform: legacy CodeAtomRow -> hauska CodeSectionAtomInstance.
 *
 * One row -> one section atom. Provenance fields preserved verbatim
 * where they exist on the legacy row; `entityId` derived deterministically
 * from `(jurisdictionKey, codeBook+edition, normalizedSectionNumber)`;
 * `contentHash` recomputed against hauska's input set. Legacy UUID +
 * legacy content-hash preserved in `metadataSidecar` for cross-system
 * trace (storage layer can persist this into the atom row's body json
 * if it round-trips a metadata field).
 */

import { createHash } from "node:crypto";

import type { CodeSectionAtomInstance } from "@hauska-engine/atoms";

import type { LegacyCodeAtomRow } from "./legacy-types.js";
import {
  buildEditionSlug,
  normalizeSectionLabel,
  slugify,
} from "./slug.js";
import { resolveSourceAdapter } from "./source-adapter-map.js";

export interface TransformContext {
  /** sourceId -> sourceName lookup built from code_atom_sources rows. */
  sourceNameById: Map<string, string>;
}

export interface TransformResult {
  instance: CodeSectionAtomInstance;
  /** Metadata sidecar to merge into the storage row at write time. */
  metadataSidecar: {
    legacyCodeAtomId: string;
    legacyContentHash: string;
    legacySourceName: string;
    legacyParentSection: string | null;
    legacyMetadata: Record<string, unknown> | null;
  };
}

function hashContent(...parts: ReadonlyArray<string>): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part, "utf8");
  return hash.digest("hex");
}

function buildSectionEntityId(
  jurisdictionKey: string,
  editionSlug: string,
  sectionNumber: string,
): string {
  return `${jurisdictionKey}/${editionSlug}/${slugify(normalizeSectionLabel(sectionNumber))}`;
}

export function buildEditionEntityId(
  jurisdictionKey: string,
  editionSlug: string,
): string {
  return `${jurisdictionKey}/${editionSlug}`;
}

export function transformRow(
  row: LegacyCodeAtomRow,
  ctx: TransformContext,
): TransformResult | null {
  // Drop rows with no section number — they cannot get a deterministic
  // entityId. Legacy schema permits null but real ingested rows carry
  // sectionRef per the AtomCandidate contract; null indicates malformed
  // ingest that's safe to skip.
  const rawSectionNumber = row.section_number ?? "";
  if (!rawSectionNumber.trim()) return null;
  if (!row.body.trim()) return null;

  const editionSlug = buildEditionSlug(row.code_book, row.edition);
  const entityId = buildSectionEntityId(
    row.jurisdiction_key,
    editionSlug,
    rawSectionNumber,
  );
  const codeEditionId = buildEditionEntityId(row.jurisdiction_key, editionSlug);
  const title = row.section_title ?? "";
  const subsectionPath = null;
  const contentHash = hashContent(
    "code-section",
    entityId,
    rawSectionNumber,
    title,
    subsectionPath ?? "",
    row.body,
  );
  const sourceName = ctx.sourceNameById.get(row.source_id) ?? "unknown";
  const sourceAdapter = resolveSourceAdapter(sourceName);

  const instance: CodeSectionAtomInstance = {
    entityType: "code-section",
    entityId,
    jurisdictionTenant: row.jurisdiction_key,
    codeEditionId,
    sectionNumber: rawSectionNumber,
    title,
    subsectionPath,
    bodyText: row.body,
    fetchedAt: row.fetched_at.toISOString(),
    sourceAdapter,
    sourceUrl: row.source_url,
    contentHash,
  };

  return {
    instance,
    metadataSidecar: {
      legacyCodeAtomId: row.id,
      legacyContentHash: row.content_hash,
      legacySourceName: sourceName,
      legacyParentSection: row.parent_section,
      legacyMetadata: row.metadata,
    },
  };
}

export interface TransformBatchResult {
  instances: ReadonlyArray<CodeSectionAtomInstance>;
  metadata: ReadonlyArray<TransformResult["metadataSidecar"]>;
  droppedNullSection: number;
  droppedEmptyBody: number;
  /** entityIds where two rows collided; later row dropped, earlier kept. */
  collisions: ReadonlyArray<{ entityId: string; keptLegacyId: string; droppedLegacyId: string }>;
}

export function transformBatch(
  rows: ReadonlyArray<LegacyCodeAtomRow>,
  ctx: TransformContext,
): TransformBatchResult {
  const seen = new Map<string, { row: LegacyCodeAtomRow; result: TransformResult }>();
  let droppedNullSection = 0;
  let droppedEmptyBody = 0;
  const collisions: Array<{
    entityId: string;
    keptLegacyId: string;
    droppedLegacyId: string;
  }> = [];

  for (const row of rows) {
    if (!row.section_number?.trim()) {
      droppedNullSection++;
      continue;
    }
    if (!row.body.trim()) {
      droppedEmptyBody++;
      continue;
    }
    const result = transformRow(row, ctx);
    if (!result) continue;
    const existing = seen.get(result.instance.entityId);
    if (!existing) {
      seen.set(result.instance.entityId, { row, result });
      continue;
    }
    // Collision: keep the earlier fetched_at row.
    if (existing.row.fetched_at.getTime() <= row.fetched_at.getTime()) {
      collisions.push({
        entityId: result.instance.entityId,
        keptLegacyId: existing.row.id,
        droppedLegacyId: row.id,
      });
    } else {
      collisions.push({
        entityId: result.instance.entityId,
        keptLegacyId: row.id,
        droppedLegacyId: existing.row.id,
      });
      seen.set(result.instance.entityId, { row, result });
    }
  }

  const instances: CodeSectionAtomInstance[] = [];
  const metadata: TransformResult["metadataSidecar"][] = [];
  for (const { result } of seen.values()) {
    instances.push(result.instance);
    metadata.push(result.metadataSidecar);
  }

  return {
    instances,
    metadata,
    droppedNullSection,
    droppedEmptyBody,
    collisions,
  };
}
