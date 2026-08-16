/**
 * ICC model-code ingest — wires the ICC Code Connect adapter + model-code
 * extractor into the corpus snapshot build (Lane E deliverable 3).
 *
 * Discovers all available ICC editions (IBC2018P6 + IPMC2018P2 as of
 * 2026-07-05), extracts Layer 1 model-code atoms via
 * {@link extractModelCodeAtoms}, and writes them to the provided
 * `StoragePort`. If credentials are unconfigured, the unit logs a warning
 * and becomes a no-op skip rather than throwing.
 */

import type { StoragePort } from "@hauska-engine/storage";
import {
  IccCodeConnectAdapter,
  codeConnectCredentialsFromEnv,
} from "@hauska-engine/corpus/adapters";
import { extractModelCodeAtoms } from "@hauska-engine/corpus/model-code";
import type { ModelCodeReasoningLayer } from "@hauska-engine/corpus/model-code";
import type { IccCodeDocument } from "@hauska-engine/corpus/adapters";

export interface IccModelCodeIngestOptions {
  reasoningLayer?: ModelCodeReasoningLayer;
  credentials?: { clientId: string; clientSecret: string };
  adapter?: IccCodeConnectAdapter;
}

export interface IccModelCodeIngestResult {
  editions: number;
  sections: number;
  crossReferences: number;
  links: number;
}

export async function runIccModelCodeIngest(
  storage: StoragePort,
  opts?: IccModelCodeIngestOptions,
): Promise<IccModelCodeIngestResult> {
  const adapter = opts?.adapter ?? new IccCodeConnectAdapter({
    credentials: opts?.credentials ?? codeConnectCredentialsFromEnv(),
  });

  // If adapter is unconfigured, log warning and skip
  if (adapter.mode === "unconfigured") {
    console.warn(
      "ICC Code Connect adapter is unconfigured — skipping model-code ingest. Set ICC_CODE_CONNECT_CLIENT_ID and ICC_CODE_CONNECT_CLIENT_SECRET environment variables to enable.",
    );
    return { editions: 0, sections: 0, crossReferences: 0, links: 0 };
  }

  // Discover all available ICC editions
  const references = await adapter.discover();
  
  let totalSections = 0;
  let totalCrossReferences = 0;
  let totalLinks = 0;

  // Process each edition
  for (const ref of references) {
    const raw = await adapter.fetch(ref);
    
    // Skip if fetch failed (empty body)
    if (!raw.body) {
      console.warn(`Skipping ${ref.editionLabel} — fetch returned empty body`);
      continue;
    }

    const doc = JSON.parse(raw.body) as IccCodeDocument;
    
    // Extract model-code atoms
    const result = await extractModelCodeAtoms(doc, {
      modelCodeTenant: "icc-model-code",
      reasoningLayer: opts?.reasoningLayer,
    });

    // Write atoms to storage
    await storage.writeAtoms([
      result.edition,
      ...result.sections,
      ...result.definitions,
      ...result.crossReferences,
    ]);
    
    // Write links
    await storage.writeAtomLinks(result.links);

    totalSections += result.sections.length;
    totalCrossReferences += result.crossReferences.length;
    totalLinks += result.links.length;
  }

  // Synthesize the jurisdiction-corpus atom for icc-model-code
  const now = new Date().toISOString();
  const editionIds = references.map((ref) => 
    `icc-model-code/${ref.editionLabel.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")}`
  );
  
  const jurisdictionCorpus = {
    entityType: "jurisdiction-corpus" as const,
    entityId: "icc-model-code",
    jurisdictionTenant: "icc-model-code",
    jurisdictionName: "ICC model codes (Layer 1)",
    adoptedEditionIds: editionIds,
    currentEditionId: editionIds[editionIds.length - 1] ?? null,
    coverageQualityBar: "not-evaluated" as const,
    lastRefreshedAt: now,
    fetchedAt: now,
    sourceAdapter: "icc-code-connect",
    sourceUrl: "https://codes.iccsafe.org",
    contentHash: "",
    accessPolicy: "platform-internal" as const,
  };
  
  await storage.writeAtoms([jurisdictionCorpus]);

  // Register jurisdiction status
  await storage.upsertJurisdictionStatus({
    jurisdictionTenant: "icc-model-code",
    jurisdictionName: "ICC model codes (Layer 1)",
    currentEditionDid: null,
    qualityBar: "not-evaluated",
    top3Score: null,
    sectionNumScore: null,
    crossRefScore: null,
    atomCount: totalSections,
    lastRefreshedAt: new Date().toISOString(),
    driftStatus: "clean",
    accessPolicy: "platform-internal",
  });

  return {
    editions: references.length,
    sections: totalSections,
    crossReferences: totalCrossReferences,
    links: totalLinks,
  };
}
