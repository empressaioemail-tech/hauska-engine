/**
 * Model-code ingest — ICC Code Connect Layer 1 (ADR-019).
 *
 * Runs discover → fetch → normalize → extractModelCodeAtoms →
 * conformance stamp → storage write. Mock mode uses the hand-built
 * fixtures; live mode uses OAuth2 credentials from the environment.
 */

import type { AccessPolicy, CodeAtomInstance } from "@hauska-engine/atoms";
import { buildAtomDid } from "@hauska-engine/atoms";
import type { StoragePort } from "@hauska-engine/storage";

import {
  IccCodeConnectAdapter,
  type CodeConnectFixtures,
  type IccCodeDocument,
} from "../adapters/icc-code-connect/index.js";
import { stampCorpusAtomConformance } from "../conformance/mint.js";
import {
  ICC_CODE_CONNECT_DEMO_TITLE_IDS,
  ICC_CODE_CONNECT_SOURCE_ADAPTER,
  ICC_MODEL_CODE_ACCESS_POLICY,
  ICC_MODEL_CODE_JURISDICTION_NAME,
  ICC_MODEL_CODE_TENANT,
  filterDemoCodeReferences,
} from "./demo-instance.js";
import { extractModelCodeAtoms } from "./extractor.js";

export interface ModelCodeIngestOptions {
  storage: StoragePort;
  /**
   * I-Code edition titleIds to ingest. Defaults to the PoC demo scope
   * (2018 IBC + 2018 IPMC).
   */
  titleIds?: ReadonlyArray<string>;
  /** Pre-built adapter (tests inject fixtures / stub transport). */
  adapter?: IccCodeConnectAdapter;
  /** Fixture set — selects mock mode when no adapter is injected. */
  fixtures?: CodeConnectFixtures;
  /** ADR-017 access tier stamped on every emitted atom. */
  accessPolicy?: AccessPolicy;
}

export interface ModelCodeEditionIngestReport {
  titleId: string;
  editionLabel: string;
  editionEntityId: string;
  editionDid: string;
  sectionsIngested: number;
  definitionsIngested: number;
  crossReferencesIngested: number;
  crossReferencesResolved: number;
  atomLinksEmitted: number;
  sectionSample: ReadonlyArray<{
    entityId: string;
    sectionNumber: string;
    title: string;
    verbatimTextDeepLink: string;
  }>;
}

export interface ModelCodeIngestReport {
  adapterMode: string;
  jurisdictionTenant: string;
  jurisdictionName: string;
  accessPolicy: AccessPolicy;
  sourceAdapter: typeof ICC_CODE_CONNECT_SOURCE_ADAPTER;
  editionsIngested: number;
  sectionsIngested: number;
  definitionsIngested: number;
  crossReferencesIngested: number;
  crossReferencesResolved: number;
  atomLinksEmitted: number;
  atomCount: number;
  editions: ReadonlyArray<ModelCodeEditionIngestReport>;
}

export interface ModelCodeIngestResult {
  report: ModelCodeIngestReport;
}

function stampModelCodeAtoms(
  atoms: ReadonlyArray<CodeAtomInstance>,
  accessPolicy: AccessPolicy,
): CodeAtomInstance[] {
  return atoms.map((atom) => stampCorpusAtomConformance(atom, accessPolicy));
}

export async function runModelCodeIngest(
  options: ModelCodeIngestOptions,
): Promise<ModelCodeIngestResult> {
  const accessPolicy = options.accessPolicy ?? ICC_MODEL_CODE_ACCESS_POLICY;
  const titleIds = options.titleIds ?? [...ICC_CODE_CONNECT_DEMO_TITLE_IDS];
  const adapter =
    options.adapter ??
    new IccCodeConnectAdapter({
      fixtures: options.fixtures,
      modelCodeTenant: ICC_MODEL_CODE_TENANT,
    });

  const discovered = filterDemoCodeReferences(await adapter.discover());
  const refsByTitle = new Map(discovered.map((ref) => [ref.sourceId, ref]));
  const editionReports: ModelCodeEditionIngestReport[] = [];
  const allAtoms: CodeAtomInstance[] = [];
  const allLinks: Awaited<
    ReturnType<typeof extractModelCodeAtoms>
  >["links"] = [];

  for (const titleId of titleIds) {
    const reference = refsByTitle.get(titleId);
    if (!reference) {
      throw new Error(
        `runModelCodeIngest: titleId "${titleId}" not found in discover() — ` +
          `available: ${[...refsByTitle.keys()].join(", ") || "(none)"}`,
      );
    }

    const raw = await adapter.fetch(reference);
    if (raw.body.length === 0) {
      throw new Error(
        `runModelCodeIngest: fetch("${titleId}") returned an empty body`,
      );
    }
    const document = JSON.parse(raw.body) as IccCodeDocument;
    const extracted = await extractModelCodeAtoms(document, {
      modelCodeTenant: ICC_MODEL_CODE_TENANT,
      fetchedAt: raw.metadata.fetchedAt,
    });

    const atoms = stampModelCodeAtoms(
      [
        extracted.edition,
        ...extracted.sections,
        ...extracted.definitions,
        ...extracted.crossReferences,
      ],
      accessPolicy,
    );
    allAtoms.push(...atoms);
    allLinks.push(...extracted.links);

    const resolvedXrefs = extracted.crossReferences.filter(
      (x) => x.toSectionId !== "",
    ).length;

    editionReports.push({
      titleId,
      editionLabel: extracted.edition.editionLabel,
      editionEntityId: extracted.edition.entityId,
      editionDid: buildAtomDid("code-edition", extracted.edition.entityId).raw,
      sectionsIngested: extracted.sections.length,
      definitionsIngested: extracted.definitions.length,
      crossReferencesIngested: extracted.crossReferences.length,
      crossReferencesResolved: resolvedXrefs,
      atomLinksEmitted: extracted.links.length,
      sectionSample: extracted.sections.slice(0, 10).map((s) => ({
        entityId: s.entityId,
        sectionNumber: s.sectionNumber,
        title: s.title,
        verbatimTextDeepLink: s.verbatimTextDeepLink,
      })),
    });
  }

  await options.storage.writeAtoms(allAtoms);
  await options.storage.writeAtomLinks(allLinks);

  const sectionsIngested = editionReports.reduce(
    (n, e) => n + e.sectionsIngested,
    0,
  );
  const definitionsIngested = editionReports.reduce(
    (n, e) => n + e.definitionsIngested,
    0,
  );
  const crossReferencesIngested = editionReports.reduce(
    (n, e) => n + e.crossReferencesIngested,
    0,
  );
  const crossReferencesResolved = editionReports.reduce(
    (n, e) => n + e.crossReferencesResolved,
    0,
  );
  const atomLinksEmitted = allLinks.length;
  const latestEdition = editionReports.at(-1);

  await options.storage.upsertJurisdictionStatus({
    jurisdictionTenant: ICC_MODEL_CODE_TENANT,
    jurisdictionName: ICC_MODEL_CODE_JURISDICTION_NAME,
    currentEditionDid: latestEdition?.editionDid ?? null,
    qualityBar: "not-evaluated",
    top3Score: null,
    sectionNumScore: null,
    crossRefScore: null,
    atomCount: sectionsIngested,
    lastRefreshedAt: new Date().toISOString(),
    driftStatus: "clean",
    accessPolicy,
  });

  return {
    report: {
      adapterMode: adapter.mode,
      jurisdictionTenant: ICC_MODEL_CODE_TENANT,
      jurisdictionName: ICC_MODEL_CODE_JURISDICTION_NAME,
      accessPolicy,
      sourceAdapter: ICC_CODE_CONNECT_SOURCE_ADAPTER,
      editionsIngested: editionReports.length,
      sectionsIngested,
      definitionsIngested,
      crossReferencesIngested,
      crossReferencesResolved,
      atomLinksEmitted,
      atomCount: allAtoms.length,
      editions: editionReports,
    },
  };
}
