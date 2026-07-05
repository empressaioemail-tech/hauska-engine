/**
 * Gate context verification module.
 *
 * Verifies signed tenant context stamped by hauska-mcp-server gate on
 * every upstream call (PR #37). Implements BUILD-AND-STAGE semantics:
 * verification ships in log-only mode; enforcement is a config flip.
 */

import { timingSafeEqual } from "node:crypto";
import { z } from "zod";

/** Wire format for the gate-signed context payload. */
export const gateContextPayloadSchema = z.object({
  v: z.literal(1),
  tenant: z.string().nullable(),
  product: z.string(),
  tier: z.string(),
  keyId: z.string().nullable(),
  platformInternal: z.boolean(),
  iat: z.number(),
  exp: z.number(),
});

export type GateContextPayload = z.infer<typeof gateContextPayloadSchema>;

/** Typed errors from verification. */
export enum GateContextVerifyError {
  SIGNATURE_INVALID = "SIGNATURE_INVALID",
  EXPIRED = "EXPIRED",
  MALFORMED = "MALFORMED",
}

export type VerifyResult =
  | { ok: true; payload: GateContextPayload }
  | { ok: false; error: GateContextVerifyError };

export interface VerifyOptions {
  /** Injectable clock for testing (unix seconds). */
  nowSeconds?: () => number;
}

/**
 * Verify gate-stamped context signature and payload.
 *
 * @param encodedPayload - base64url-encoded canonical JSON payload
 * @param signatureHex - hex HMAC-SHA256 signature
 * @param signingKey - GATE_CONTEXT_SIGNING_KEY
 * @param options - verification options (injectable clock)
 */
export async function verifyGateContext(
  encodedPayload: string,
  signatureHex: string,
  signingKey: string,
  options: VerifyOptions = {},
): Promise<VerifyResult> {
  const nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));

  // Step 1: Constant-time signature verification (on encoded string)
  let expectedHex: string;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(signingKey),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );

    const data = new TextEncoder().encode(encodedPayload);
    const expectedSignature = await crypto.subtle.sign("HMAC", key, data);
    expectedHex = Buffer.from(expectedSignature).toString("hex");
  } catch {
    return { ok: false, error: GateContextVerifyError.SIGNATURE_INVALID };
  }

  // Length guard + constant-time compare
  if (
    signatureHex.length !== expectedHex.length ||
    !timingSafeEqual(
      Buffer.from(signatureHex, "hex"),
      Buffer.from(expectedHex, "hex"),
    )
  ) {
    return { ok: false, error: GateContextVerifyError.SIGNATURE_INVALID };
  }

  // Step 2: Decode base64url payload
  let payloadJson: string;
  try {
    const decoded = Buffer.from(encodedPayload, "base64url").toString("utf8");
    payloadJson = decoded;
  } catch {
    return { ok: false, error: GateContextVerifyError.MALFORMED };
  }

  // Step 3: Parse JSON
  let payload: unknown;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    return { ok: false, error: GateContextVerifyError.MALFORMED };
  }

  // Step 4: Shape check (including v === 1)
  const parsed = gateContextPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return { ok: false, error: GateContextVerifyError.MALFORMED };
  }

  // Step 5: Expiry check
  if (parsed.data.exp < nowSeconds()) {
    return { ok: false, error: GateContextVerifyError.EXPIRED };
  }

  return { ok: true, payload: parsed.data };
}

/** Header names for gate-signed context. */
export const GATE_CONTEXT_HEADERS = {
  context: "x-hauska-gate-context",
  signature: "x-hauska-gate-signature",
} as const;
