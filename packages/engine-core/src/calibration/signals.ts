/**
 * Collect calibration signals from Phase 1 adjudication ledger + Phase 2 outcomes.
 */

import {
  assertedBaselineFromSourceType,
  atomClassFromCodeRef,
} from "./corpusBaseline.js";
import { PUBLIC_CALIBRATION_TENANT } from "./dbShim.js";
import { FINDING_OUTCOME_RECORDED_EVENT_TYPE } from "./findingOutcomeEventType.js";
import { canonicalOverlayAtomKey, isReasoningOverlayAtomId } from "./overlayAtomKey.js";
import { isPublicPoolEligible } from "./partition.js";
import type {
  AtomAccessContext,
  CalibrationRepositoryPort,
  EngagementTenantFields,
  JurisdictionTenantResolver,
} from "./ports.js";
import type { CalibrationSignal } from "./types.js";

const ADJUDICATION_EVENT_TYPES = new Set([
  "finding.accepted",
  "finding.rejected",
  "finding.overridden",
]);

const OUTCOME_POSITIVE = new Set([
  "permit-approved",
  "variance-granted",
  "comment-resolved",
]);

function resolveJurisdictionTenant(
  engagement: EngagementTenantFields,
  resolveKey?: JurisdictionTenantResolver,
): string | null {
  const stored = (engagement.cortexJurisdictionKey ?? "").trim();
  if (stored) return stored;
  return resolveKey?.(engagement) ?? null;
}

function isCodeSectionCitation(
  c: unknown,
): c is { kind: "code-section"; atomId: string } {
  return (
    typeof c === "object" &&
    c !== null &&
    (c as { kind?: unknown }).kind === "code-section" &&
    typeof (c as { atomId?: unknown }).atomId === "string" &&
    (c as { atomId: string }).atomId.length > 0
  );
}

function extractCodeCitationAtomIds(citations: unknown): string[] {
  if (!Array.isArray(citations)) return [];
  const ids: string[] = [];
  for (const c of citations) {
    if (isCodeSectionCitation(c)) {
      ids.push(canonicalOverlayAtomKey(c.atomId));
    }
  }
  return ids;
}

function parseStatedConfidence(raw: string | null | undefined): number {
  if (raw == null) return 0.65;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : 0.65;
}

function adjudicationSuccess(eventType: string): number {
  if (eventType === "finding.accepted") return 1;
  if (eventType === "finding.rejected") return 0;
  return 0.5;
}

export async function loadAtomAccessContexts(
  repo: CalibrationRepositoryPort,
  atomIds: string[],
): Promise<Map<string, AtomAccessContext>> {
  const unique = [...new Set(atomIds)];
  const map = new Map<string, AtomAccessContext>();
  if (unique.length === 0) return map;

  const reasoningIds = unique.filter(isReasoningOverlayAtomId);
  const corpusIds = unique.filter((id) => !isReasoningOverlayAtomId(id));

  if (reasoningIds.length > 0) {
    const rows = await repo.findReasoningAtoms(reasoningIds);
    for (const row of rows) {
      map.set(row.id, {
        atomId: row.id,
        accessPolicy: row.accessPolicy,
        sharedWithTenants: null,
        codeRef: row.codeRef,
        edition: row.edition,
        sourceSetVersion: Number(row.sourceSetVersion ?? 1),
        assertedConfidence: Number(row.assertedConfidence),
      });
    }
  }

  for (const corpusKey of corpusIds) {
    if (map.has(corpusKey)) continue;
    const uuidForm = corpusKey.match(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    if (!uuidForm) continue;
    const atom = await repo.findCorpusAtom(corpusKey);
    if (!atom) continue;
    map.set(corpusKey, {
      atomId: corpusKey,
      accessPolicy: "public-free",
      sharedWithTenants: null,
      codeRef: atom.sectionNumber,
      edition: atom.edition,
      sourceSetVersion: 1,
      assertedConfidence: assertedBaselineFromSourceType(atom.sourceType),
    });
  }

  return map;
}

export async function collectCalibrationSignals(
  repo: CalibrationRepositoryPort,
  options?: { resolveJurisdictionTenant?: JurisdictionTenantResolver },
): Promise<CalibrationSignal[]> {
  const signals: CalibrationSignal[] = [];
  const resolveKey = options?.resolveJurisdictionTenant;

  const adjudicationRows = (await repo.loadAdjudicationLedgerRows()).filter(
    (row) => ADJUDICATION_EVENT_TYPES.has(row.eventType),
  );

  const allAtomIds = new Set<string>();
  for (const row of adjudicationRows) {
    for (const id of extractCodeCitationAtomIds(row.citations)) {
      allAtomIds.add(id);
    }
  }

  const outcomeRows = (await repo.loadOutcomeLedgerRows()).filter(
    (row) => true,
  );

  for (const row of outcomeRows) {
    for (const id of extractCodeCitationAtomIds(row.citations)) {
      allAtomIds.add(id);
    }
  }

  const contexts = await loadAtomAccessContexts(repo, [...allAtomIds]);

  for (const row of adjudicationRows) {
    const tenant = resolveJurisdictionTenant(row, resolveKey);
    if (!tenant) continue;
    const citedAtomIds = extractCodeCitationAtomIds(row.citations);
    const stated = parseStatedConfidence(row.confidence);
    const success = adjudicationSuccess(row.eventType);
    for (const atomId of citedAtomIds) {
      const ctx = contexts.get(atomId);
      if (!ctx) continue;
      signals.push(
        buildSignal({
          atomId,
          tenant,
          ctx,
          stated,
          success,
        }),
      );
    }
  }

  for (const row of outcomeRows) {
    const tenant = resolveJurisdictionTenant(row, resolveKey);
    if (!tenant) continue;
    const payload = row.payload as Record<string, unknown> | null;
    const outcomeKind =
      payload && typeof payload.outcomeKind === "string"
        ? payload.outcomeKind
        : null;
    if (!outcomeKind) continue;
    const success = OUTCOME_POSITIVE.has(outcomeKind) ? 1 : 0;
    const citedAtomIds = extractCodeCitationAtomIds(row.citations);
    const stated = parseStatedConfidence(row.confidence);
    for (const atomId of citedAtomIds) {
      const ctx = contexts.get(atomId);
      if (!ctx) continue;
      signals.push(
        buildSignal({
          atomId,
          tenant,
          ctx,
          stated,
          success,
        }),
      );
    }
  }

  return signals;
}

export { FINDING_OUTCOME_RECORDED_EVENT_TYPE };

/** Tenant adjudications never pool into public; only anonymous/public-tier does. */
function buildSignal(args: {
  atomId: string;
  tenant: string;
  ctx: AtomAccessContext;
  stated: number;
  success: number;
}): CalibrationSignal {
  const isAnonymousPublic = args.tenant === "__anonymous__";
  if (isAnonymousPublic && isPublicPoolEligible(args.ctx.accessPolicy)) {
    return {
      atomId: args.atomId,
      jurisdictionTenant: args.tenant,
      partitionKind: "public",
      accessPolicy: "public-free",
      sharedWithTenants: null,
      atomClass: atomClassFromCodeRef(args.ctx.codeRef),
      stamp: {
        codeRef: args.ctx.codeRef ?? "",
        edition: args.ctx.edition ?? "",
        sourceSetVersion: args.ctx.sourceSetVersion,
      },
      statedConfidence: args.stated,
      observedSuccess: args.success,
    };
  }
  if (args.ctx.accessPolicy === "tenant-shared") {
    return {
      atomId: args.atomId,
      jurisdictionTenant: args.tenant,
      partitionKind: "tenant-shared",
      accessPolicy: "tenant-shared",
      sharedWithTenants: args.ctx.sharedWithTenants,
      atomClass: atomClassFromCodeRef(args.ctx.codeRef),
      stamp: {
        codeRef: args.ctx.codeRef ?? "",
        edition: args.ctx.edition ?? "",
        sourceSetVersion: args.ctx.sourceSetVersion,
      },
      statedConfidence: args.stated,
      observedSuccess: args.success,
    };
  }
  return {
    atomId: args.atomId,
    jurisdictionTenant: args.tenant,
    partitionKind: "tenant-private",
    accessPolicy: "tenant-private",
    sharedWithTenants: null,
    atomClass: atomClassFromCodeRef(args.ctx.codeRef),
    stamp: {
      codeRef: args.ctx.codeRef ?? "",
      edition: args.ctx.edition ?? "",
      sourceSetVersion: args.ctx.sourceSetVersion,
    },
    statedConfidence: args.stated,
    observedSuccess: args.success,
  };
}

export type { AtomAccessContext };
