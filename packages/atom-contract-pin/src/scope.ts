/**
 * Mirrors @workspace/empressa-atom Scope.
 */

export interface Scope {
  audience: "ai" | "user" | "internal";
  requestor?: { kind: "user" | "agent"; id: string };
  asOf?: Date;
  permissions?: ReadonlyArray<string>;
}

export function defaultScope(): Scope {
  return { audience: "internal" };
}
