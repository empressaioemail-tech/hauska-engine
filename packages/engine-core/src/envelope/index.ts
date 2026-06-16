export {
  confidenceKindSchema,
  envelopeConfidenceSchema,
  envelopeCoverageSchema,
  envelopeSourceSchema,
  engineEnvelopeSchema,
  type ConfidenceKind,
  type EnvelopeConfidence,
  type EnvelopeCoverage,
  type EnvelopeSource,
  type EngineEnvelope,
} from "./schema.js";

export {
  resolveReadPathConfidence,
  type ReadPathConfidenceInput,
} from "./readPathConfidence.js";

export {
  sealEnvelope,
  degradedCoverage,
  okCoverage,
  type SealEnvelopeMeta,
} from "./seal.js";
