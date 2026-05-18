/**
 * Mirrors @workspace/empressa-atom composition surface.
 */

import type {
  AnyAtomRegistration,
  AtomMode,
  AtomReference,
} from "./registration.js";

export interface AtomComposition {
  childEntityType: string;
  childMode: AtomMode;
  dataKey: string;
  forwardRef?: boolean;
}

export interface ResolvedChild {
  composition: AtomComposition;
  registration: AnyAtomRegistration;
  reference: AtomReference;
  data: Record<string, unknown>;
}

export interface CompositionRegistryView {
  resolve: (
    entityType: string,
  ) =>
    | { ok: true; registration: AnyAtomRegistration }
    | { ok: false; error: { entityType: string; message: string } };
}

function pickIdFrom(row: Record<string, unknown>, fallback: string): string {
  const candidate = row.id ?? row.entityId ?? row.slug ?? row.name;
  if (typeof candidate === "string" && candidate.length > 0) return candidate;
  if (typeof candidate === "number") return String(candidate);
  return fallback;
}

export function resolveComposition(
  parentRegistration: AnyAtomRegistration,
  parentRef: AtomReference,
  parentData: Record<string, unknown>,
  registry: CompositionRegistryView,
):
  | { ok: true; children: ResolvedChild[] }
  | {
      ok: false;
      errors: ReadonlyArray<{ childEntityType: string; message: string }>;
    } {
  const composition = parentRegistration.composition;
  const errors: Array<{ childEntityType: string; message: string }> = [];
  const children: ResolvedChild[] = [];

  for (const edge of composition) {
    const resolved = registry.resolve(edge.childEntityType);
    if (!resolved.ok) {
      if (edge.forwardRef) continue;
      errors.push({
        childEntityType: edge.childEntityType,
        message: resolved.error.message,
      });
      continue;
    }
    const raw = parentData[edge.dataKey];
    const rows: Array<Record<string, unknown>> = Array.isArray(raw)
      ? (raw as Array<Record<string, unknown>>)
      : [];
    rows.forEach((row, i) => {
      if (row === null || typeof row !== "object") return;
      const childId = pickIdFrom(
        row,
        `${parentRef.entityId}-${edge.dataKey}-${i}`,
      );
      children.push({
        composition: edge,
        registration: resolved.registration,
        reference: {
          kind: "atom",
          entityType: edge.childEntityType,
          entityId: childId,
          mode: edge.childMode,
        },
        data: row,
      });
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, children };
}
