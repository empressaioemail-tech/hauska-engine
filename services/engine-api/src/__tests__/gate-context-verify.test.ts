import { describe, expect, it } from "vitest";
import {
  verifyGateContext,
  GateContextVerifyError,
  GATE_CONTEXT_HEADERS,
  type GateContextPayload,
} from "../gate-context-verify.js";
import type { EngineApiConfig } from "../config.js";
import { GATE_FRONT_HEADERS } from "../gate-front-context.js";
import { buildApp } from "../server.js";

async function signGateContext(
  payload: GateContextPayload,
  signingKey: string,
): Promise<{ encodedPayload: string; signatureHex: string }> {
  const canonicalJson = JSON.stringify(payload);
  const encodedPayload = Buffer.from(canonicalJson, "utf8").toString(
    "base64url",
  );

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const data = new TextEncoder().encode(encodedPayload);
  const signature = await crypto.subtle.sign("HMAC", key, data);
  const signatureHex = Buffer.from(signature).toString("hex");

  return { encodedPayload, signatureHex };
}

describe("gate-context verification", () => {
  const signingKey = "test-signing-key-12345";
  
  function makePayload(iatOffsetSeconds = 0, expOffsetSeconds = 300): GateContextPayload {
    const now = Math.floor(Date.now() / 1000);
    return {
      v: 1,
      tenant: "tenant-demo",
      product: "cortex",
      tier: "tenant-private",
      keyId: "key-123",
      platformInternal: false,
      iat: now + iatOffsetSeconds,
      exp: now + expOffsetSeconds,
    };
  }

  const basePayload: GateContextPayload = makePayload();

  describe("verifyGateContext", () => {
    it("verifies valid signed context", async () => {
      const { encodedPayload, signatureHex } = await signGateContext(
        basePayload,
        signingKey,
      );

      const result = await verifyGateContext(
        encodedPayload,
        signatureHex,
        signingKey,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.payload).toEqual(basePayload);
      }
    });

    it("rejects tampered payload", async () => {
      const { encodedPayload, signatureHex } = await signGateContext(
        basePayload,
        signingKey,
      );

      const tamperedPayload = encodedPayload.slice(0, -5) + "XXXXX";

      const result = await verifyGateContext(
        tamperedPayload,
        signatureHex,
        signingKey,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe(GateContextVerifyError.SIGNATURE_INVALID);
      }
    });

    it("rejects tampered signature", async () => {
      const { encodedPayload, signatureHex } = await signGateContext(
        basePayload,
        signingKey,
      );

      const tamperedSignature = "ff" + signatureHex.slice(2);

      const result = await verifyGateContext(
        encodedPayload,
        tamperedSignature,
        signingKey,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe(GateContextVerifyError.SIGNATURE_INVALID);
      }
    });

    it("rejects wrong signing key", async () => {
      const { encodedPayload, signatureHex } = await signGateContext(
        basePayload,
        signingKey,
      );

      const result = await verifyGateContext(
        encodedPayload,
        signatureHex,
        "wrong-key",
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe(GateContextVerifyError.SIGNATURE_INVALID);
      }
    });

    it("rejects expired context", async () => {
      const expiredPayload = makePayload(-400, -100);
      const { encodedPayload, signatureHex } = await signGateContext(
        expiredPayload,
        signingKey,
      );

      const result = await verifyGateContext(
        encodedPayload,
        signatureHex,
        signingKey,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe(GateContextVerifyError.EXPIRED);
      }
    });

    it("rejects malformed base64url", async () => {
      const result = await verifyGateContext(
        "not-valid-base64url!!!",
        "abcd1234",
        signingKey,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe(GateContextVerifyError.SIGNATURE_INVALID);
      }
    });

    it("rejects malformed JSON", async () => {
      const invalidJson = Buffer.from("{invalid json}", "utf8").toString(
        "base64url",
      );
      
      const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(signingKey),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const data = new TextEncoder().encode(invalidJson);
      const signature = await crypto.subtle.sign("HMAC", key, data);
      const signatureHex = Buffer.from(signature).toString("hex");

      const result = await verifyGateContext(
        invalidJson,
        signatureHex,
        signingKey,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe(GateContextVerifyError.MALFORMED);
      }
    });

    it("rejects invalid schema version", async () => {
      const invalidPayload = { ...basePayload, v: 2 };
      const { encodedPayload, signatureHex } = await signGateContext(
        invalidPayload as unknown as GateContextPayload,
        signingKey,
      );

      const result = await verifyGateContext(
        encodedPayload,
        signatureHex,
        signingKey,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe(GateContextVerifyError.MALFORMED);
      }
    });

    it("accepts null tenant", async () => {
      const nullTenantPayload = { ...basePayload, tenant: null };
      const { encodedPayload, signatureHex } = await signGateContext(
        nullTenantPayload,
        signingKey,
      );

      const result = await verifyGateContext(
        encodedPayload,
        signatureHex,
        signingKey,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.payload.tenant).toBeNull();
      }
    });
  });

  describe("middleware integration", () => {
    const baseConfig: EngineApiConfig = {
      port: 8080,
      gateServiceToken: "test-gate-token",
      startedAt: "2026-06-07T00:00:00.000Z",
      gateContextSigningKey: signingKey,
      gateContextMode: "log",
    };

    const gateFrontHeaders = {
      [GATE_FRONT_HEADERS.product]: "cortex",
      [GATE_FRONT_HEADERS.tenantId]: "tenant-demo",
      [GATE_FRONT_HEADERS.packageId]: "plan-review",
      [GATE_FRONT_HEADERS.accessTier]: "tenant-private",
      [GATE_FRONT_HEADERS.credentialId]: "gate-cred-1",
      [GATE_FRONT_HEADERS.requestId]: "req-abc",
    };

    it("verifies valid signed context in log mode", async () => {
      const app = buildApp({ config: baseConfig });
      const { encodedPayload, signatureHex } = await signGateContext(
        basePayload,
        signingKey,
      );

      const res = await app.request("/v1/test", {
        headers: {
          Authorization: "Bearer test-gate-token",
          ...gateFrontHeaders,
          [GATE_CONTEXT_HEADERS.context]: encodedPayload,
          [GATE_CONTEXT_HEADERS.signature]: signatureHex,
        },
      });

      expect(res.status).toBe(501);
    });

    it("does not reject invalid context in log mode", async () => {
      const app = buildApp({ config: baseConfig });
      const { encodedPayload } = await signGateContext(basePayload, signingKey);

      const res = await app.request("/v1/test", {
        headers: {
          Authorization: "Bearer test-gate-token",
          ...gateFrontHeaders,
          [GATE_CONTEXT_HEADERS.context]: encodedPayload,
          [GATE_CONTEXT_HEADERS.signature]: "invalid-signature",
        },
      });

      expect(res.status).toBe(501);
    });

    it("allows missing signed context in log mode", async () => {
      const app = buildApp({ config: baseConfig });

      const res = await app.request("/v1/test", {
        headers: {
          Authorization: "Bearer test-gate-token",
          ...gateFrontHeaders,
        },
      });

      expect(res.status).toBe(501);
    });

    it("rejects invalid context in enforce mode", async () => {
      const enforceConfig = { ...baseConfig, gateContextMode: "enforce" as const };
      const app = buildApp({ config: enforceConfig });
      const { encodedPayload } = await signGateContext(basePayload, signingKey);

      const res = await app.request("/v1/test", {
        headers: {
          Authorization: "Bearer test-gate-token",
          ...gateFrontHeaders,
          [GATE_CONTEXT_HEADERS.context]: encodedPayload,
          [GATE_CONTEXT_HEADERS.signature]: "invalid-signature",
        },
      });

      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("gate_context_invalid");
    });

    it("rejects missing context in enforce mode", async () => {
      const enforceConfig = { ...baseConfig, gateContextMode: "enforce" as const };
      const app = buildApp({ config: enforceConfig });

      const res = await app.request("/v1/test", {
        headers: {
          Authorization: "Bearer test-gate-token",
          ...gateFrontHeaders,
        },
      });

      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("gate_context_required");
    });

    it("accepts valid context in enforce mode", async () => {
      const enforceConfig = { ...baseConfig, gateContextMode: "enforce" as const };
      const app = buildApp({ config: enforceConfig });
      const { encodedPayload, signatureHex } = await signGateContext(
        basePayload,
        signingKey,
      );

      const res = await app.request("/v1/test", {
        headers: {
          Authorization: "Bearer test-gate-token",
          ...gateFrontHeaders,
          [GATE_CONTEXT_HEADERS.context]: encodedPayload,
          [GATE_CONTEXT_HEADERS.signature]: signatureHex,
        },
      });

      expect(res.status).toBe(501);
    });

    it("is disabled in off mode", async () => {
      const offConfig = { ...baseConfig, gateContextMode: "off" as const };
      const app = buildApp({ config: offConfig });

      const res = await app.request("/v1/test", {
        headers: {
          Authorization: "Bearer test-gate-token",
          ...gateFrontHeaders,
        },
      });

      expect(res.status).toBe(501);
    });

    it("logs mismatch between signed and plain tenant", async () => {
      const app = buildApp({ config: baseConfig });
      const mismatchPayload = { ...basePayload, tenant: "different-tenant" };
      const { encodedPayload, signatureHex } = await signGateContext(
        mismatchPayload,
        signingKey,
      );

      const res = await app.request("/v1/test", {
        headers: {
          Authorization: "Bearer test-gate-token",
          ...gateFrontHeaders,
          [GATE_CONTEXT_HEADERS.context]: encodedPayload,
          [GATE_CONTEXT_HEADERS.signature]: signatureHex,
        },
      });

      expect(res.status).toBe(501);
    });
  });
});
