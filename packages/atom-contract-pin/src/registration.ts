/**
 * Mirrors @workspace/empressa-atom AtomRegistration and tributary types.
 *
 * Kept type-only-stable. Body matches lib/empressa-atom/src/registration.ts
 * so that swapping to @hauska/atom-contract on Sync 1 is a no-op for
 * engine consumers.
 */

import type { AtomComposition } from "./composition.js";
import type { ContextSummary } from "./context.js";
import type { Scope } from "./scope.js";

export type AtomMode = "inline" | "compact" | "card" | "expanded" | "focus";

export interface AtomReference {
  kind: "atom";
  entityType: string;
  entityId: string;
  mode?: AtomMode;
  displayLabel?: string;
}

export interface AtomProps {
  entityId: string;
  mode: AtomMode;
  data?: Record<string, unknown>;
  onAction?: (message: string) => void;
  onModeChange?: (mode: AtomMode) => void;
  onDrillIn?: (atom: AtomReference) => void;
}

export interface ChipAction {
  id: string;
  label: string;
  message: string;
}

export type DefaultModeOf<TSupported extends ReadonlyArray<AtomMode>> =
  TSupported[number];

export type LiteralString<T extends string> = string extends T ? never : T;

export interface AtomRegistration<
  TType extends string = string,
  TSupported extends ReadonlyArray<AtomMode> = ReadonlyArray<AtomMode>,
> {
  entityType: TType;
  domain: string;
  supportedModes: TSupported;
  defaultMode: DefaultModeOf<TSupported>;
  chipActions?: (data: Record<string, unknown>) => ChipAction[];
  contextSummary: (
    entityId: string,
    scope: Scope,
  ) => Promise<ContextSummary<TType>>;
  composition: ReadonlyArray<AtomComposition>;
  eventTypes?: ReadonlyArray<string>;
}

export type AnyAtomRegistration = AtomRegistration<
  string,
  ReadonlyArray<AtomMode>
>;
