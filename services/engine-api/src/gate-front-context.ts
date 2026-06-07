/**
 * Gate-front seam contract — types only (scaffold).
 *
 * engine-api trusts the hauska-mcp-server gate to resolve product,
 * tenant, package, and access tier before forwarding a request.
 * See `docs/gate-front-seam.md` for the full contract.
 */

import { z } from "zod";

/** Product surfaces that consume engine reasoning through the gate. */
export const GATE_FRONT_PRODUCTS = [
  "cortex",
  "codex",
  "smartcity",
  "brief-extension",
  "revit-addin",
] as const;

export type GateFrontProduct = (typeof GATE_FRONT_PRODUCTS)[number];

/**
 * Access tier the gate resolved for this call. Aligns with ADR-017 /
 * tenant-leg enforcement behind the gate.
 */
export const GATE_FRONT_ACCESS_TIERS = [
  "public-free",
  "public-paid",
  "platform-internal",
  "tenant-private",
] as const;

export type GateFrontAccessTier = (typeof GATE_FRONT_ACCESS_TIERS)[number];

/**
 * Resolved auth context engine-api accepts from the MCP gate on every
 * non-health request. The gate is the sole authority for tenant +
 * package resolution; engine-api does not re-resolve.
 */
export interface GateFrontContext {
  /** Gate-issued service credential id (for audit; not the raw secret). */
  gateCredentialId: string;
  /** Calling product surface. */
  product: GateFrontProduct;
  /** Tenant partition (ADR-005 Layer A). */
  tenantId: string;
  /**
   * Commercial / capability package the gate authorized for this call
   * (e.g. `plan-review`, `site-context`, `brokerage-brief`).
   */
  packageId: string;
  /** Access tier the gate enforced before forwarding. */
  accessTier: GateFrontAccessTier;
  /** Optional end-user subject when the gate proxied a user session. */
  subjectId?: string;
  /** Gate request id for cross-service provenance (HR-8). */
  requestId: string;
}

/** HTTP header names the gate sends (canonical contract). */
export const GATE_FRONT_HEADERS = {
  product: "x-hauska-product",
  tenantId: "x-hauska-tenant-id",
  packageId: "x-hauska-package-id",
  accessTier: "x-hauska-access-tier",
  credentialId: "x-hauska-gate-credential-id",
  requestId: "x-hauska-request-id",
  subjectId: "x-hauska-subject-id",
} as const;

export const gateFrontContextSchema = z.object({
  gateCredentialId: z.string().min(1),
  product: z.enum(GATE_FRONT_PRODUCTS),
  tenantId: z.string().min(1),
  packageId: z.string().min(1),
  accessTier: z.enum(GATE_FRONT_ACCESS_TIERS),
  subjectId: z.string().min(1).optional(),
  requestId: z.string().min(1),
});

export type GateFrontContextInput = z.infer<typeof gateFrontContextSchema>;

/**
 * Parse gate-front headers into a typed context. Returns null when
 * required headers are absent or invalid — callers respond 401/400.
 */
export function parseGateFrontHeaders(
  headers: Headers,
): GateFrontContext | null {
  const raw = {
    gateCredentialId: headers.get(GATE_FRONT_HEADERS.credentialId) ?? "",
    product: headers.get(GATE_FRONT_HEADERS.product) ?? "",
    tenantId: headers.get(GATE_FRONT_HEADERS.tenantId) ?? "",
    packageId: headers.get(GATE_FRONT_HEADERS.packageId) ?? "",
    accessTier: headers.get(GATE_FRONT_HEADERS.accessTier) ?? "",
    requestId: headers.get(GATE_FRONT_HEADERS.requestId) ?? "",
    subjectId: headers.get(GATE_FRONT_HEADERS.subjectId) ?? undefined,
  };

  const parsed = gateFrontContextSchema.safeParse({
    ...raw,
    ...(raw.subjectId === "" ? {} : { subjectId: raw.subjectId }),
  });

  return parsed.success ? parsed.data : null;
}
