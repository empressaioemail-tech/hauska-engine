import { z } from "zod";

export const confidenceKindSchema = z.enum([
  "calibrated",
  "asserted",
  "deterministic",
]);

export const envelopeConfidenceSchema = z.object({
  value: z.number().min(0).max(1),
  kind: confidenceKindSchema,
});

export const envelopeCoverageSchema = z.object({
  degraded: z.boolean(),
  reason: z.string().optional(),
});

export const envelopeSourceSchema = z.object({
  adapter: z.string(),
  citationIds: z.array(z.string()).optional(),
});

export const engineEnvelopeSchema = z.object({
  payload: z.unknown(),
  confidence: envelopeConfidenceSchema,
  dataVintage: z.string().nullable(),
  coverage: envelopeCoverageSchema,
  source: envelopeSourceSchema,
});

export type ConfidenceKind = z.infer<typeof confidenceKindSchema>;
export type EnvelopeConfidence = z.infer<typeof envelopeConfidenceSchema>;
export type EnvelopeCoverage = z.infer<typeof envelopeCoverageSchema>;
export type EnvelopeSource = z.infer<typeof envelopeSourceSchema>;
export type EngineEnvelope<T = unknown> = {
  payload: T;
  confidence: EnvelopeConfidence;
  dataVintage: string | null;
  coverage: EnvelopeCoverage;
  source: EnvelopeSource;
};
