import type { Context } from "hono";

import {
  sealEnvelope,
  type SealEnvelopeMeta,
} from "@hauska-engine/engine-core/envelope";

/** Return a Zod-validated EngineEnvelope JSON response. */
export function envelopeJson(c: Context, payload: unknown, meta: SealEnvelopeMeta) {
  return c.json(sealEnvelope(payload, meta));
}
