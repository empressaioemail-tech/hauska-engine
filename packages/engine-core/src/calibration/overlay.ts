import { computePartitionCalibration } from "./compute.js";
import { assertedBaselineFromSourceType, atomClassFromCodeRef } from "./corpusBaseline.js";
import {
  PUBLIC_CALIBRATION_TENANT,
  type CalibrationPartitionKind,
} from "./dbShim.js";
import {
  canonicalOverlayAtomKey,
  canonicalOverlayKeyFromCodeToken,
  isReasoningOverlayAtomId,
  overlayAtomLookupKey,
} from "./overlayAtomKey.js";
import { partitionForSignal } from "./partition.js";
import type { CalibrationRepositoryPort } from "./ports.js";
import { collectCalibrationSignals, loadAtomAccessContexts } from "./signals.js";
import { stampsMatch, stampFromFields } from "./stamp.js";
import type { OverlayCalibrationRow } from "./types.js";

export function effectiveConfidence(args: {
  assertedConfidence: number;
  calibratedConfidence: number | null;
  calibrationStale: boolean;
}): { value: number; grade: "asserted" | "calibrated" | "stale" } {
  if (args.calibrationStale) {
    return { value: args.assertedConfidence, grade: "stale" };
  }
  if (args.calibratedConfidence != null) {
    return { value: args.calibratedConfidence, grade: "calibrated" };
  }
  return { value: args.assertedConfidence, grade: "asserted" };
}

function groupKey(
  overlayTenant: string,
  atomId: string,
  atomClass: string,
): string {
  return `${overlayTenant}\0${atomId}\0${atomClass}`;
}

function rowToOverlayCalibration(
  row: {
    atomId: string;
    jurisdictionTenant: string;
    partitionKind: string;
    accessPolicy: string;
    sharedWithTenants: string[] | null;
    assertedConfidence: string;
    calibratedConfidence: string | null;
    codeRef: string | null;
    edition: string | null;
    sourceSetVersion: number;
    calibrationStale: boolean;
    calibrationGrain: string;
    atomClass: string | null;
    signalCount: number;
  },
  overrides?: {
    assertedConfidence?: number;
    calibratedConfidence?: number | null;
    calibrationStale?: boolean;
  },
): OverlayCalibrationRow {
  const asserted =
    overrides?.assertedConfidence ?? Number(row.assertedConfidence);
  const calibrated =
    overrides?.calibratedConfidence !== undefined
      ? overrides.calibratedConfidence
      : row.calibratedConfidence != null
        ? Number(row.calibratedConfidence)
        : null;
  const stale = overrides?.calibrationStale ?? row.calibrationStale;
  const eff = effectiveConfidence({
    assertedConfidence: asserted,
    calibratedConfidence: calibrated,
    calibrationStale: stale,
  });
  return {
    atomId: row.atomId,
    jurisdictionTenant: row.jurisdictionTenant,
    partitionKind: row.partitionKind as CalibrationPartitionKind,
    accessPolicy: row.accessPolicy,
    sharedWithTenants: row.sharedWithTenants,
    assertedConfidence: asserted,
    calibratedConfidence: calibrated,
    effectiveConfidence: eff.value,
    calibrationGrade: eff.grade,
    codeRef: row.codeRef,
    edition: row.edition,
    sourceSetVersion: Number(row.sourceSetVersion ?? 1),
    calibrationStale: stale,
    calibrationGrain: row.calibrationGrain as "atom" | "class",
    atomClass: row.atomClass,
    signalCount: row.signalCount,
  };
}

export async function recomputeCalibrationOverlay(
  repo: CalibrationRepositoryPort,
): Promise<{ rowsWritten: number }> {
  const signals = await collectCalibrationSignals(repo);
  const buckets = new Map<
    string,
    {
      overlayTenant: string;
      partitionKind: CalibrationPartitionKind;
      atomId: string;
      atomClass: string;
      accessPolicy: string;
      sharedWithTenants: string[] | null;
      atomSignals: typeof signals;
      classSignals: typeof signals;
      context: import("./ports.js").AtomAccessContext | undefined;
    }
  >();

  const atomIds = [...new Set(signals.map((s) => s.atomId))];
  const contexts = await loadAtomAccessContexts(repo, atomIds);

  for (const signal of signals) {
    const ctx = contexts.get(signal.atomId);
    const { overlayTenant, partitionKind } = partitionForSignal({
      accessPolicy: signal.accessPolicy,
      jurisdictionTenant: signal.jurisdictionTenant,
      sharedWithTenants: signal.sharedWithTenants,
    });
    const key = groupKey(overlayTenant, signal.atomId, signal.atomClass);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        overlayTenant,
        partitionKind,
        atomId: signal.atomId,
        atomClass: signal.atomClass,
        accessPolicy: signal.accessPolicy,
        sharedWithTenants: signal.sharedWithTenants,
        atomSignals: [],
        classSignals: [],
        context: ctx,
      };
      buckets.set(key, bucket);
    }
    bucket.atomSignals.push(signal);
  }

  for (const bucket of buckets.values()) {
    for (const signal of bucket.atomSignals) {
      const classKey = groupKey(
        bucket.overlayTenant,
        "__class__",
        signal.atomClass,
      );
      let classBucket = buckets.get(classKey);
      if (!classBucket) {
        classBucket = {
          overlayTenant: bucket.overlayTenant,
          partitionKind: bucket.partitionKind,
          atomId: bucket.atomId,
          atomClass: signal.atomClass,
          accessPolicy: bucket.accessPolicy,
          sharedWithTenants: bucket.sharedWithTenants,
          atomSignals: [],
          classSignals: [],
          context: bucket.context,
        };
        buckets.set(classKey, classBucket);
      }
      classBucket.classSignals.push(signal);
    }
  }

  let rowsWritten = 0;
  const now = new Date();

  for (const bucket of buckets.values()) {
    if (bucket.atomId === "__class__") continue;
    const classBucket = buckets.get(
      groupKey(bucket.overlayTenant, "__class__", bucket.atomClass),
    );
    const classSignals = classBucket?.classSignals ?? bucket.atomSignals;
    const ctx = bucket.context;
    const asserted =
      ctx?.assertedConfidence ??
      computePartitionCalibration(bucket.atomSignals, classSignals)
        .assertedConfidence;

    const computed = computePartitionCalibration(
      bucket.atomSignals,
      classSignals,
    );
    const stamp = stampFromFields({
      codeRef: ctx?.codeRef ?? bucket.atomSignals[0]?.stamp.codeRef ?? null,
      edition: ctx?.edition ?? bucket.atomSignals[0]?.stamp.edition ?? null,
      sourceSetVersion:
        ctx?.sourceSetVersion ??
        bucket.atomSignals[0]?.stamp.sourceSetVersion ??
        1,
    });

    const existing = await repo.findOverlayRow(
      bucket.atomId,
      bucket.overlayTenant,
    );

    const storedStamp = stampFromFields({
      codeRef: existing?.codeRef ?? null,
      edition: existing?.edition ?? null,
      sourceSetVersion: Number(existing?.sourceSetVersion ?? 1),
    });
    const stale =
      existing != null &&
      existing.calibratedConfidence != null &&
      !stampsMatch(stamp, storedStamp);

    const calibratedValue = stale ? null : computed.calibratedConfidence;

    await repo.upsertOverlayRow({
      atomId: bucket.atomId,
      jurisdictionTenant: bucket.overlayTenant,
      partitionKind: bucket.partitionKind,
      accessPolicy: bucket.accessPolicy,
      sharedWithTenants: bucket.sharedWithTenants,
      assertedConfidence: String(asserted),
      calibratedConfidence:
        calibratedValue != null ? String(calibratedValue) : null,
      codeRef: stamp.codeRef || null,
      edition: stamp.edition || null,
      sourceSetVersion: stamp.sourceSetVersion,
      calibrationStale: stale,
      calibrationGrain: computed.calibrationGrain,
      atomClass: bucket.atomClass,
      signalCount: computed.signalCount,
      updatedAt: now,
    });
    rowsWritten += 1;

    if (
      isReasoningOverlayAtomId(bucket.atomId) &&
      bucket.overlayTenant === PUBLIC_CALIBRATION_TENANT
    ) {
      await repo.updateReasoningAtomCalibration(bucket.atomId, {
        calibratedConfidence:
          calibratedValue != null ? String(calibratedValue) : null,
        calibrationStale: stale,
        updatedAt: now,
      });
    }
  }

  return { rowsWritten };
}

export async function ensureCorpusOverlayRow(
  repo: CalibrationRepositoryPort,
  args: {
    atomId: string;
    jurisdictionTenant?: string;
    sourceType?: string | null;
    codeRef?: string | null;
    edition?: string | null;
  },
): Promise<void> {
  const atomId = canonicalOverlayAtomKey(args.atomId);
  const tenant = args.jurisdictionTenant ?? PUBLIC_CALIBRATION_TENANT;
  const asserted = assertedBaselineFromSourceType(args.sourceType ?? null);
  const existing = await repo.findOverlayRow(atomId, tenant);
  if (existing) return;
  await repo.upsertOverlayRow({
    atomId,
    jurisdictionTenant: tenant,
    partitionKind: "public",
    accessPolicy: "public-free",
    sharedWithTenants: null,
    assertedConfidence: String(asserted),
    calibratedConfidence: null,
    codeRef: args.codeRef ?? null,
    edition: args.edition ?? null,
    sourceSetVersion: 1,
    calibrationStale: false,
    calibrationGrain: "atom",
    atomClass: atomClassFromCodeRef(args.codeRef ?? null),
    signalCount: 0,
    updatedAt: new Date(),
  });
}

export async function resolveOverlayCalibration(
  repo: CalibrationRepositoryPort,
  args: {
    atomId: string;
    jurisdictionTenant: string;
  },
): Promise<OverlayCalibrationRow | null> {
  const atomKey = canonicalOverlayAtomKey(args.atomId);
  const lookupKeys = [
    overlayAtomLookupKey({
      jurisdictionTenant: args.jurisdictionTenant,
      atomId: atomKey,
    }),
    overlayAtomLookupKey({
      jurisdictionTenant: PUBLIC_CALIBRATION_TENANT,
      atomId: atomKey,
    }),
  ];

  for (const key of lookupKeys) {
    const sep = key.indexOf("\0");
    const tenant = key.slice(0, sep);
    const atomId = key.slice(sep + 1);
    const row = await repo.findOverlayRow(atomId, tenant);
    if (!row) continue;

    if (isReasoningOverlayAtomId(atomId)) {
      const reasoning = await repo.findReasoningAtom(atomId);
      if (reasoning) {
        const stamp = stampFromFields({
          codeRef: reasoning.codeRef,
          edition: reasoning.edition,
          sourceSetVersion: Number(reasoning.sourceSetVersion ?? 1),
        });
        const storedStamp = stampFromFields({
          codeRef: row.codeRef,
          edition: row.edition,
          sourceSetVersion: Number(row.sourceSetVersion ?? 1),
        });
        const stale =
          Boolean(reasoning.calibrationStale) ||
          (row.calibratedConfidence != null &&
            !stampsMatch(stamp, storedStamp));
        const asserted = Number(reasoning.assertedConfidence);
        const calibrated =
          row.calibratedConfidence != null
            ? Number(row.calibratedConfidence)
            : reasoning.calibratedConfidence != null
              ? Number(reasoning.calibratedConfidence)
              : null;
        return rowToOverlayCalibration(row, {
          assertedConfidence: asserted,
          calibratedConfidence: calibrated,
          calibrationStale: stale,
        });
      }
    }

    return rowToOverlayCalibration(row);
  }

  return null;
}

export async function listOverlayRows(
  repo: CalibrationRepositoryPort,
  options?: {
    jurisdictionTenant?: string | null;
    atomIds?: string[];
  },
): Promise<OverlayCalibrationRow[]> {
  const tenantFilter = (options?.jurisdictionTenant ?? "").trim() || null;
  const atomFilter = options?.atomIds?.map(canonicalOverlayAtomKey);

  const rows = await repo.listOverlayRows();
  const out: OverlayCalibrationRow[] = [];
  for (const row of rows) {
    if (tenantFilter && row.jurisdictionTenant !== tenantFilter) continue;
    if (atomFilter && !atomFilter.includes(row.atomId)) continue;
    out.push(rowToOverlayCalibration(row));
  }
  out.sort((a, b) => {
    const t = a.jurisdictionTenant.localeCompare(b.jurisdictionTenant);
    if (t !== 0) return t;
    return a.atomId.localeCompare(b.atomId);
  });
  return out;
}

export function resolveOverlayKeyFromStructuredRef(
  token: string,
): string | null {
  return canonicalOverlayKeyFromCodeToken(token);
}

export async function seedReasoningOverlayFromAtom(
  repo: CalibrationRepositoryPort,
  args: {
    reasoningAtomId: string;
    jurisdictionTenant?: string;
  },
): Promise<void> {
  const row = await repo.findReasoningAtom(args.reasoningAtomId);
  if (!row) return;
  const tenant = args.jurisdictionTenant ?? PUBLIC_CALIBRATION_TENANT;
  const existing = await repo.findOverlayRow(row.id, tenant);
  if (existing) return;
  await repo.upsertOverlayRow({
    atomId: row.id,
    jurisdictionTenant: tenant,
    partitionKind: "public",
    accessPolicy: row.accessPolicy,
    sharedWithTenants: null,
    assertedConfidence: row.assertedConfidence,
    calibratedConfidence: null,
    codeRef: row.codeRef,
    edition: row.edition,
    sourceSetVersion: Number(row.sourceSetVersion ?? 1),
    calibrationStale: row.calibrationStale,
    calibrationGrain: "atom",
    atomClass: atomClassFromCodeRef(row.codeRef),
    signalCount: 0,
    updatedAt: new Date(),
  });
}

export async function invalidateStaleCalibrationForAtom(
  repo: CalibrationRepositoryPort,
  args: {
    atomId: string;
    codeRef: string;
    edition: string;
    sourceSetVersion: number;
  },
): Promise<void> {
  const atomKey = canonicalOverlayAtomKey(args.atomId);
  const rows = (await repo.listOverlayRows()).filter(
    (row) => row.atomId === atomKey,
  );

  const current = stampFromFields(args);
  for (const row of rows) {
    const stored = stampFromFields({
      codeRef: row.codeRef,
      edition: row.edition,
      sourceSetVersion: Number(row.sourceSetVersion ?? 1),
    });
    if (!stampsMatch(current, stored) && row.calibratedConfidence != null) {
      await repo.updateOverlayRowsForAtom(atomKey, {
        jurisdictionTenant: row.jurisdictionTenant,
        calibrationStale: true,
        calibratedConfidence: null,
        sourceSetVersion: args.sourceSetVersion,
        updatedAt: new Date(),
      });
    }
  }
}
