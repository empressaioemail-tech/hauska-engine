import { engineEnvelopeSchema, type EngineEnvelope } from "./schema.js";
import type { EnvelopeConfidence, EnvelopeCoverage, EnvelopeSource } from "./schema.js";

export interface SealEnvelopeMeta {
  confidence: EnvelopeConfidence;
  dataVintage: string | null;
  coverage: EnvelopeCoverage;
  source: EnvelopeSource;
}

/** Wrap an engine result in the uniform gate-front envelope and Zod-validate. */
export function sealEnvelope<T>(
  payload: T,
  meta: SealEnvelopeMeta,
): EngineEnvelope<T> {
  const envelope: EngineEnvelope<T> = {
    payload,
    confidence: meta.confidence,
    dataVintage: meta.dataVintage,
    coverage: meta.coverage,
    source: meta.source,
  };
  const parsed = engineEnvelopeSchema.safeParse(envelope);
  if (!parsed.success) {
    throw new Error(
      `EngineEnvelope validation failed: ${parsed.error.message}`,
    );
  }
  return envelope;
}

export function degradedCoverage(
  reason: string,
  partial = false,
): EnvelopeCoverage {
  return { degraded: true, reason: partial ? `partial: ${reason}` : reason };
}

export function okCoverage(): EnvelopeCoverage {
  return { degraded: false };
}
