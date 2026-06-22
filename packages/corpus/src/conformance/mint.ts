/**
 * Born-correct conformance stamping for immutable code-corpus atoms.
 *
 * Every atom emitted by atomization carries the architecture-homes
 * conformance target: read-contract (asserted source-quality baseline),
 * accessPolicy, signed genesis history, and conservative consequence
 * defaults until ICC I-Code ingest thickens coverage.
 */

import type {
  AccessPolicy,
  Asce7RiskCategory,
  CodeAtomInstance,
  ConsequenceClassificationInputs,
} from "@hauska-engine/atoms";
import type { AtomEvent } from "@hauska/atom-contract";
import {
  buildValidSignedEventChain,
  verifyEventChain,
} from "@hauska/atom-contract/conformance";
import {
  createConsequenceAxis,
  createReadContract,
  createThreeAxisConfidence,
  createWidthedConfidence,
  type ReadContract,
} from "@hauska/atom-contract/read-contract";

import type { AtomizationResult } from "../atomization/index.js";
import type { ConsequenceClassificationInputs as ParsedConsequenceInputs } from "../consequence/types.js";

/** Conservative ASCE 7 default until ICC I-Code ingest thickens coverage. */
export const CONSERVATIVE_CONSEQUENCE_INPUTS: ConsequenceClassificationInputs = {
  asce7RiskCategories: ["II"],
  parsedAt: "2026-06-21T00:00:00.000Z",
};

const SOURCE_ADAPTER_BASELINE: Readonly<Record<string, number>> = {
  "raw-pdf": 0.82,
  "icc-code-connect": 0.78,
  "municode-html": 0.72,
  "ecode360-html": 0.72,
};

const DEFAULT_SOURCE_BASELINE = 0.65;

const CALIBRATED_SEED = createWidthedConfidence({
  estimate: 0.5,
  n: 0,
  intervalWidth: 0.5,
  provenance: "seed",
});

function assertedBaselineFromAdapter(sourceAdapter: string): number {
  const key = sourceAdapter.trim().toLowerCase();
  return SOURCE_ADAPTER_BASELINE[key] ?? DEFAULT_SOURCE_BASELINE;
}

function consequenceAxisFromInputs(
  inputs: ParsedConsequenceInputs | ConsequenceClassificationInputs | undefined,
  assertedAt: string,
) {
  const risk: Asce7RiskCategory =
    inputs?.asce7RiskCategories?.[0] ?? "II";
  const occupancy = inputs?.ibcOccupancyGroups?.[0];
  return createConsequenceAxis({
    derivation: {
      source: "asce7-risk-category",
      asce7RiskCategory: risk,
      ...(occupancy ? { ibcOccupancyGroup: occupancy } : {}),
    },
    stratum: risk === "IV" ? "essential" : risk === "III" ? "elevated" : "routine",
    assertedAt,
  });
}

export function buildCorpusReadContract(args: {
  sourceAdapter: string;
  fetchedAt: string;
  consequenceInputs?: ParsedConsequenceInputs | ConsequenceClassificationInputs;
}): ReadContract {
  const assertedEstimate = assertedBaselineFromAdapter(args.sourceAdapter);
  return createReadContract({
    axes: createThreeAxisConfidence({
      calibratedConfidence: CALIBRATED_SEED,
      assertedConfidence: createWidthedConfidence({
        estimate: assertedEstimate,
        n: 0,
        intervalWidth: 0.35,
        provenance: "asserted",
      }),
      consequence: consequenceAxisFromInputs(
        args.consequenceInputs,
        args.fetchedAt,
      ),
    }),
    assembledAt: args.fetchedAt,
  });
}

export function buildIngestSignedHistory(atom: {
  entityType: string;
  entityId: string;
  fetchedAt: string;
  sourceAdapter: string;
  contentHash: string;
}): { events: ReadonlyArray<AtomEvent>; verifyChain: ReturnType<typeof verifyEventChain> } {
  const occurredAt = new Date(atom.fetchedAt);
  const recordedAt = new Date(occurredAt.getTime() + 1000);
  const events = buildValidSignedEventChain([
    {
      id: `evt-${atom.contentHash.slice(0, 16)}-created`,
      entityType: atom.entityType,
      entityId: atom.entityId,
      eventType: `${atom.entityType}.ingested`,
      actor: { kind: "system", id: `ingest:${atom.sourceAdapter}` },
      payload: {
        contentHash: atom.contentHash,
        sourceAdapter: atom.sourceAdapter,
      },
      prevHash: null,
      occurredAt,
      recordedAt,
    },
  ]);
  const verifyChain = verifyEventChain(events);
  return { events, verifyChain };
}

export type ConformedAtomFields = {
  readContract: ReadContract;
  accessPolicy: AccessPolicy;
  signedHistory: {
    events: ReadonlyArray<AtomEvent>;
    verifyChain: ReturnType<typeof verifyEventChain>;
  };
};

export type ConformedCodeAtomInstance = CodeAtomInstance & ConformedAtomFields;

function withConservativeConsequenceInputs<
  T extends { consequenceInputs?: ConsequenceClassificationInputs },
>(atom: T): T {
  if (atom.consequenceInputs) return atom;
  return {
    ...atom,
    consequenceInputs: {
      ...CONSERVATIVE_CONSEQUENCE_INPUTS,
      parsedAt: new Date().toISOString(),
    },
  };
}

export function stampCorpusAtomConformance<
  T extends CodeAtomInstance,
>(atom: T, accessPolicy: AccessPolicy): T & ConformedAtomFields {
  const sectionLike =
    atom.entityType === "code-section"
      ? withConservativeConsequenceInputs(atom)
      : atom;
  const readContract = buildCorpusReadContract({
    sourceAdapter: atom.sourceAdapter,
    fetchedAt: atom.fetchedAt,
    consequenceInputs:
      atom.entityType === "code-section"
        ? (sectionLike as typeof atom & { consequenceInputs?: ConsequenceClassificationInputs })
            .consequenceInputs
        : undefined,
  });
  const signedHistory = buildIngestSignedHistory(atom);
  return {
    ...sectionLike,
    readContract,
    accessPolicy,
    signedHistory,
  } as T & ConformedAtomFields;
}

export function stampAtomizationResult(
  result: AtomizationResult,
  accessPolicy: AccessPolicy = "public-free",
): AtomizationResult {
  return {
    jurisdictionCorpus: stampCorpusAtomConformance(
      {
        ...result.jurisdictionCorpus,
        accessPolicy,
      },
      accessPolicy,
    ),
    edition: stampCorpusAtomConformance(result.edition, accessPolicy),
    sections: result.sections.map((s) => stampCorpusAtomConformance(s, accessPolicy)),
    definitions: result.definitions.map((d) =>
      stampCorpusAtomConformance(d, accessPolicy),
    ),
    amendments: result.amendments.map((a) =>
      stampCorpusAtomConformance(a, accessPolicy),
    ),
    crossReferences: result.crossReferences.map((x) =>
      stampCorpusAtomConformance(x, accessPolicy),
    ),
    links: result.links,
  };
}
