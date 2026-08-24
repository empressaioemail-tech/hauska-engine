/**
 * Fail-closed access-policy resolution at atom write time.
 * An absent policy is a refuse, never a default to the most permissive tier.
 */

export class AccessPolicyRequiredError extends Error {
  readonly code = "access_policy_required" as const;

  constructor(
    readonly entityType: string,
    readonly entityId: string,
  ) {
    super(
      `accessPolicy required for ${entityType}:${entityId} — refusing write rather than defaulting`,
    );
    this.name = "AccessPolicyRequiredError";
  }
}

export class JurisdictionAccessPolicyRequiredError extends Error {
  readonly code = "jurisdiction_access_policy_required" as const;

  constructor(readonly jurisdictionTenant: string) {
    super(
      `accessPolicy required for jurisdiction_status:${jurisdictionTenant} — refusing write rather than defaulting`,
    );
    this.name = "JurisdictionAccessPolicyRequiredError";
  }
}

/** Resolve a declared access policy or refuse. Used by every storage write path. */
export function resolveAccessPolicyOrRefuse(
  instance: { entityType: string; entityId: string; accessPolicy?: string },
): string {
  const policy = instance.accessPolicy;
  if (policy == null || policy === "") {
    throw new AccessPolicyRequiredError(instance.entityType, instance.entityId);
  }
  return policy;
}

/** Jurisdiction status rows carry policy on the snapshot, not nested instance shape. */
export function resolveJurisdictionAccessPolicyOrRefuse(
  snapshot: { jurisdictionTenant: string; accessPolicy?: string },
): string {
  const policy = snapshot.accessPolicy;
  if (policy == null || policy === "") {
    throw new JurisdictionAccessPolicyRequiredError(snapshot.jurisdictionTenant);
  }
  return policy;
}

/** Read-side filter: absent policy never widens to public-free. */
export function accessPolicyMatchesFilter(
  accessPolicy: string | undefined,
  allowed: ReadonlySet<string>,
): boolean {
  if (accessPolicy == null || accessPolicy === "") return false;
  return allowed.has(accessPolicy);
}
