/**
 * Mirrors @workspace/empressa-atom registry runtime.
 */

import type {
  AnyAtomRegistration,
  AtomMode,
  AtomRegistration,
  LiteralString,
} from "./registration.js";

export class AtomNotRegisteredError extends Error {
  readonly kind = "atom-not-registered" as const;
  constructor(public readonly entityType: string) {
    super(`No atom registered for entityType "${entityType}"`);
    this.name = "AtomNotRegisteredError";
  }
}

export interface DanglingCompositionRef {
  parentEntityType: string;
  childEntityType: string;
  dataKey: string;
}

export type ResolveResult<TType extends string = string> =
  | { ok: true; registration: AtomRegistration<TType, ReadonlyArray<AtomMode>> }
  | { ok: false; error: AtomNotRegisteredError };

export type ValidateResult =
  | { ok: true }
  | { ok: false; errors: ReadonlyArray<DanglingCompositionRef> };

export interface AtomPromptDescription {
  entityType: string;
  domain: string;
  supportedModes: ReadonlyArray<AtomMode>;
  defaultMode: AtomMode;
  composes: ReadonlyArray<string>;
  eventTypes: ReadonlyArray<string>;
}

export interface AtomRegistry {
  register: <TType extends string, TSupported extends ReadonlyArray<AtomMode>>(
    registration: AtomRegistration<TType, TSupported> & {
      entityType: LiteralString<TType>;
    },
  ) => void;
  registerAny: (registration: AnyAtomRegistration) => void;
  resolve: <TType extends string>(entityType: TType) => ResolveResult<TType>;
  list: () => ReadonlyArray<AnyAtomRegistration>;
  listByDomain: (domain: string) => ReadonlyArray<AnyAtomRegistration>;
  validate: () => ValidateResult;
  describeForPrompt: () => ReadonlyArray<AtomPromptDescription>;
}

export function createAtomRegistry(): AtomRegistry {
  const store = new Map<string, AnyAtomRegistration>();

  function insert(reg: AnyAtomRegistration) {
    if (store.has(reg.entityType)) {
      throw new Error(`Atom "${reg.entityType}" is already registered`);
    }
    store.set(reg.entityType, reg);
  }

  const registry: AtomRegistry = {
    register(registration) {
      insert(registration as unknown as AnyAtomRegistration);
    },
    registerAny(registration) {
      insert(registration);
    },
    resolve<TType extends string>(entityType: TType): ResolveResult<TType> {
      const reg = store.get(entityType);
      if (!reg) {
        return { ok: false, error: new AtomNotRegisteredError(entityType) };
      }
      return {
        ok: true,
        registration: reg as unknown as AtomRegistration<
          TType,
          ReadonlyArray<AtomMode>
        >,
      };
    },
    list() {
      return Array.from(store.values());
    },
    listByDomain(domain) {
      return Array.from(store.values()).filter((r) => r.domain === domain);
    },
    validate(): ValidateResult {
      const errors: DanglingCompositionRef[] = [];
      for (const reg of store.values()) {
        for (const edge of reg.composition) {
          if (edge.forwardRef) continue;
          if (!store.has(edge.childEntityType)) {
            errors.push({
              parentEntityType: reg.entityType,
              childEntityType: edge.childEntityType,
              dataKey: edge.dataKey,
            });
          }
        }
      }
      return errors.length === 0 ? { ok: true } : { ok: false, errors };
    },
    describeForPrompt() {
      return Array.from(store.values()).map((reg) => ({
        entityType: reg.entityType,
        domain: reg.domain,
        supportedModes: reg.supportedModes,
        defaultMode: reg.defaultMode,
        composes: reg.composition.map((c) => c.childEntityType),
        eventTypes: reg.eventTypes ?? [],
      }));
    },
  };

  return registry;
}
