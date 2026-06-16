import type { Context, Next } from "hono";
import { engineEnvelopeSchema } from "@hauska-engine/engine-core/envelope";

/**
 * Gate-front seam middleware: validates outbound /v1 JSON bodies that
 * handlers already wrapped via {@link envelopeJson}. Rejects accidental
 * bare payloads that bypass the envelope contract.
 */
export async function validateEnvelopeMiddleware(
  c: Context,
  next: Next,
): Promise<Response | void> {
  await next();

  const contentType = c.res.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return;

  const status = c.res.status;
  if (status < 200 || status >= 300) return;

  const cloned = c.res.clone();
  let body: unknown;
  try {
    body = await cloned.json();
  } catch {
    return;
  }

  const parsed = engineEnvelopeSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      {
        error: "envelope_contract_violation",
        message:
          "Reasoning surface returned a bare payload; EngineEnvelope required",
        details: parsed.error.flatten(),
      },
      500,
    );
  }
}
