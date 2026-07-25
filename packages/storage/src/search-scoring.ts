/**
 * Shared token search scoring for StoragePort back-ends.
 */

import type { CodeAtomInstance, PropertyAtomInstance, StoredAtomInstance } from "@hauska-engine/atoms";

import type { AtomQuery, AtomSearchResult } from "./port.js";

export function tokenize(s: string): ReadonlyArray<string> {
  return s
    .split(/[^a-z0-9.-]+/i)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= 2 || /^[0-9]$/.test(t));
}

export function buildSnippet(inst: StoredAtomInstance): string {
  if (inst.entityType === "road-node") {
    const road = inst as import("@hauska-engine/atoms").RoadNodeAtomInstance;
    return `${road.entityType} ${road.roadNodeId} ${road.displayName ?? ""} ${road.sourceCitation}`;
  }
  if (
    inst.entityType === "zoning-fact" ||
    inst.entityType === "setback-rule" ||
    inst.entityType === "buildable-envelope" ||
    inst.entityType === "parcel-terrain-model"
  ) {
    const property = inst as PropertyAtomInstance;
    return `${property.entityType} ${property.parcelNodeId} ${property.sourceCitation}`;
  }
  switch (inst.entityType) {
    case "code-section":
      return `${inst.sectionNumber} ${inst.title}. ${inst.bodyText}`;
    case "code-definition":
      return `${inst.term} — ${inst.definitionText}`;
    case "code-cross-reference":
      return `${inst.referenceText} (${inst.referenceType})`;
    case "code-amendment":
      return `Ordinance ${inst.ordinanceId}: ${inst.amendmentText}`;
    case "code-edition":
      return inst.editionLabel;
    case "jurisdiction-corpus":
      return inst.jurisdictionName;
    default: {
      const exhaustive: never = inst;
      return String(exhaustive);
    }
  }
}

export function buildSearchResult(
  atomDid: string,
  inst: StoredAtomInstance,
  snippet: string,
  score: number,
): AtomSearchResult {
  return {
    atomDid,
    entityType: inst.entityType as AtomSearchResult["entityType"],
    entityId: inst.entityId,
    jurisdictionTenant: inst.jurisdictionTenant,
    sectionNumber: inst.entityType === "code-section" ? inst.sectionNumber : null,
    snippet,
    score,
  };
}

export function scoreAtomSearch(
  inst: StoredAtomInstance,
  atomDid: string,
  query: AtomQuery,
): AtomSearchResult | null {
  const q = (query.q ?? "").toLowerCase().trim();
  const tokens = tokenize(q);
  const snippet = buildSnippet(inst);
  const lowerSnippet = snippet.toLowerCase();

  if (q.length === 0) {
    return buildSearchResult(atomDid, inst, snippet, 1);
  }
  if (tokens.length === 0) return null;

  let matched = 0;
  for (const t of tokens) {
    if (lowerSnippet.includes(t)) matched++;
  }
  if (matched === 0) return null;

  let bonus = 0;
  if (inst.entityType === "code-section" && inst.sectionNumber) {
    const sectionLower = inst.sectionNumber
      .toLowerCase()
      .replace(/[.,;:!?]+$/, "");
    if (sectionLower) {
      if (tokens.includes(sectionLower)) {
        bonus += 0.25;
      } else {
        const stripped = sectionLower.split("#")[0];
        if (
          stripped &&
          stripped !== sectionLower &&
          tokens.includes(stripped)
        ) {
          bonus += 0.25;
        }
      }
    }
  }

  const score = matched / tokens.length + bonus;
  return buildSearchResult(atomDid, inst, snippet, score);
}

export function rankSearchResults(
  results: AtomSearchResult[],
  limit: number,
): ReadonlyArray<AtomSearchResult> {
  const capped = Math.max(1, Math.min(limit, 100));
  return [...results].sort((a, b) => b.score - a.score).slice(0, capped);
}

export function matchesAtomQuery(
  inst: StoredAtomInstance,
  query: AtomQuery,
): boolean {
  if (query.jurisdiction && inst.jurisdictionTenant !== query.jurisdiction) {
    return false;
  }
  if (query.entityType && inst.entityType !== query.entityType) return false;
  return true;
}
