/**
 * Mirrors @workspace/empressa-atom ContextSummary and tributary types.
 */

import type { AtomReference } from "./registration.js";

export interface KeyMetric {
  label: string;
  value: string | number;
  unit?: string;
}

export interface HistoryProvenance {
  latestEventId: string;
  latestEventAt: string;
}

export interface ContextSummary<_TType extends string = string> {
  prose: string;
  typed: Record<string, unknown>;
  keyMetrics: KeyMetric[];
  relatedAtoms: AtomReference[];
  historyProvenance: HistoryProvenance;
  scopeFiltered: boolean;
}
