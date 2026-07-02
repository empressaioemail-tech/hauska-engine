import { describe, it, expect } from "vitest";

import {
  DocumentIngestService,
  InMemoryDocumentIngestStore,
  GenericPdfAdapter,
  SurveyAdapter,
  UtilityBillAdapter,
  defaultDocumentAdapters,
  storageRelationForExtraction,
} from "../index.js";
import { canonicalize } from "../mint.js";
import type { DocumentAdapter } from "../types.js";

function service(adapters?: ReadonlyArray<DocumentAdapter>) {
  const store = new InMemoryDocumentIngestStore();
  const svc = new DocumentIngestService({
    store,
    adapters: adapters ?? defaultDocumentAdapters(),
  });
  return { store, svc };
}

const SURVEY_TEXT = `RECORD OF SURVEY
Lot 4, Block B, Whispering Oaks Subdivision
Point of beginning at the NE corner.
N 45°30'10" E 210.5 feet to an iron rod.
Containing 2.35 acres more or less.
Prepared by John Smith, R.P.L.S.
Recorded in Volume 12, Page 88, Bastrop County.`;

const UTILITY_TEXT = `CITY OF BASTROP UTILITY BILL
Account Number: 100238845
Service: Electric
Billing period 06/01/2026 to 06/30/2026
Usage: 1,240 kWh
Amount Due: $184.52`;

describe("document-ingest orchestrator", () => {
  it("mints provenanced point-to atoms with sourceDocumentCid + asserted confidence", async () => {
    const { svc } = service();
    const result = await svc.ingest({
      document: {
        kind: "inline",
        body: SURVEY_TEXT,
        encoding: "utf8",
        contentType: "text/plain",
        sourceRef: "whispering-oaks-survey.pdf",
      },
      tenant: "tenant-acme",
    });

    expect(result.status).toBe("ok");
    expect(result.sourceDocument.cid).toMatch(/^bafydoc-/);
    expect(result.sourceDocument.accessPolicy).toBe("tenant-private");
    expect(result.classification.documentType).toBe("survey");
    expect(result.atoms.length).toBeGreaterThan(0);

    const atom = result.atoms[0]!;
    // point-to: references the pinned blob
    expect(atom.sourceDocumentCid).toBe(result.sourceDocument.cid);
    expect(atom.storageRelation).toBe("point-to");
    // confidence is asserted, never calibrated
    expect(atom.confidence.kind).toBe("asserted");
    expect(atom.confidence.n).toBe(0);
    expect(atom.confidence.intervalWidth).toBeGreaterThan(0);
    expect(atom.verificationStatus).toBe("extracted-unverified");
  });

  it("defaults extracted-atom accessPolicy to tenant-private (never auto-public)", async () => {
    const { svc } = service();
    const result = await svc.ingest({
      document: {
        kind: "inline",
        body: UTILITY_TEXT,
        encoding: "utf8",
        contentType: "text/plain",
        sourceRef: "june-electric-bill.pdf",
      },
      tenant: "tenant-user-123",
      // NO accessPolicy passed → must default tenant-private
    });
    expect(result.atoms.every((a) => a.accessPolicy === "tenant-private")).toBe(
      true,
    );
  });

  it("honors an explicit public-paid accessPolicy for marketplace ingest", async () => {
    const { svc } = service();
    const result = await svc.ingest({
      document: {
        kind: "inline",
        body: UTILITY_TEXT,
        encoding: "utf8",
        contentType: "text/plain",
        sourceRef: "licensed-doc.pdf",
      },
      tenant: "hauska-marketplace",
      accessPolicy: "public-paid",
    });
    expect(result.atoms.every((a) => a.accessPolicy === "public-paid")).toBe(
      true,
    );
    // The SOURCE BLOB stays tenant-private even when extracted atoms are public-paid.
    expect(result.sourceDocument.accessPolicy).toBe("tenant-private");
  });

  it("is idempotent — re-ingesting the same document mints no duplicate atoms", async () => {
    const { svc } = service();
    const req = {
      document: {
        kind: "inline" as const,
        body: SURVEY_TEXT,
        encoding: "utf8" as const,
        contentType: "text/plain",
        sourceRef: "survey.pdf",
      },
      tenant: "tenant-acme",
      extractedAt: "2026-07-02T00:00:00.000Z",
    };
    const first = await svc.ingest(req);
    const second = await svc.ingest(req);

    expect(first.sourceDocument.cid).toBe(second.sourceDocument.cid);
    // Same atom ids both times
    const firstIds = first.atoms.map((a) => a.atomDid).sort();
    const secondIds = second.atoms.map((a) => a.atomDid).sort();
    expect(secondIds).toEqual(firstIds);
    // First pass created; second pass was a no-op (created=false)
    expect(first.atoms.every((a) => a.created)).toBe(true);
    expect(second.atoms.every((a) => !a.created)).toBe(true);
  });

  it("degrades honestly on an unreadable document — no throw, blob pinned", async () => {
    // Generic adapter only, binary body, no extractor/OCR wired → cannot read.
    const store = new InMemoryDocumentIngestStore();
    const svc = new DocumentIngestService({
      store,
      adapters: [new GenericPdfAdapter()],
    });
    const result = await svc.ingest({
      document: {
        kind: "inline",
        body: Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x01]).toString(
          "base64",
        ),
        encoding: "base64",
        contentType: "application/pdf",
        sourceRef: "scan.pdf",
      },
      tenant: "tenant-acme",
    });
    expect(result.status).toBe("degraded");
    expect(result.atoms.length).toBe(0);
    expect(result.reason).toBeTruthy();
    // Commitment #1: the blob was still pinned even though extraction degraded.
    expect(result.sourceDocument.pinned).toBe(true);
    expect(result.sourceDocument.cid).toMatch(/^bafydoc-/);
  });

  it("routes to the typed utility-bill adapter over the generic fallback", async () => {
    const { svc } = service();
    const result = await svc.ingest({
      document: {
        kind: "inline",
        body: UTILITY_TEXT,
        encoding: "utf8",
        contentType: "text/plain",
        sourceRef: "bill.pdf",
      },
      tenant: "tenant-acme",
    });
    expect(result.classification.documentType).toBe("utility-bill");
    const atom = result.atoms[0]!;
    expect(atom.entityType).toBe("utility-bill-record");
  });

  it("blob-ref idempotency: pinning identical content twice reuses the CID", async () => {
    const { store } = service();
    const a = await store.pinBlob({
      contentHash: "abc",
      body: "hello",
      contentType: "text/plain",
      size: 5,
    });
    const b = await store.pinBlob({
      contentHash: "abc",
      body: "hello",
      contentType: "text/plain",
      size: 5,
    });
    expect(a.cid).toBe(b.cid);
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
  });
});

describe("embed-with vs point-to decision rule", () => {
  it("small unit-of-meaning text embeds; a claim from a doc points-to", () => {
    expect(
      storageRelationForExtraction({
        text: "Setback shall be 25 feet.",
        isUnitOfMeaning: true,
      }),
    ).toBe("embed-with");
    expect(
      storageRelationForExtraction({
        text: "x".repeat(5000),
        isUnitOfMeaning: true,
      }),
    ).toBe("point-to");
    expect(
      storageRelationForExtraction({ isUnitOfMeaning: false }),
    ).toBe("point-to");
  });
});

describe("canonicalize (deep stable hash input)", () => {
  it("is key-order independent at every depth", () => {
    expect(canonicalize({ a: 1, b: { x: 1, y: 2 } })).toBe(
      canonicalize({ b: { y: 2, x: 1 }, a: 1 }),
    );
  });
  it("does NOT collapse nested objects to {} (the JSON.stringify allowlist trap)", () => {
    // Distinct nested content must produce distinct canonical strings.
    const a = canonicalize({ region: { page: 1, locator: "p1" } });
    const b = canonicalize({ region: { page: 2, locator: "p2" } });
    expect(a).not.toBe(b);
    expect(a).toContain("page");
    expect(a).toContain("locator");
  });
});

describe("typed adapters extract typed atoms", () => {
  it("survey adapter extracts parcel + acreage + surveyor", async () => {
    const store = new InMemoryDocumentIngestStore();
    const svc = new DocumentIngestService({
      store,
      adapters: [new SurveyAdapter()],
    });
    const result = await svc.ingest({
      document: {
        kind: "inline",
        body: SURVEY_TEXT,
        encoding: "utf8",
        contentType: "text/plain",
        sourceRef: "survey.pdf",
      },
      tenant: "t",
    });
    const atom = result.atoms[0]!;
    expect(atom.entityType).toBe("survey-record");
    const full = await store.getDocumentAtomByDid(atom.atomDid);
    expect(full?.entityType).toBe("survey-record");
    if (full?.entityType === "survey-record") {
      expect(full.acreage).toBe(2.35);
      expect(full.surveyor).toContain("R.P.L.S");
    }
  });

  it("utility-bill adapter extracts usage + amount + period", async () => {
    const store = new InMemoryDocumentIngestStore();
    const svc = new DocumentIngestService({
      store,
      adapters: [new UtilityBillAdapter()],
    });
    const result = await svc.ingest({
      document: {
        kind: "inline",
        body: UTILITY_TEXT,
        encoding: "utf8",
        contentType: "text/plain",
        sourceRef: "bill.pdf",
      },
      tenant: "t",
    });
    const atom = result.atoms[0]!;
    const full = await store.getDocumentAtomByDid(atom.atomDid);
    if (full?.entityType === "utility-bill-record") {
      expect(full.utilityType).toBe("electric");
      expect(full.usageQuantity).toBe(1240);
      expect(full.usageUnit).toBe("kWh");
      expect(full.amountUsd).toBe(184.52);
      expect(full.periodStart).toBe("2026-06-01");
      expect(full.periodEnd).toBe("2026-06-30");
    } else {
      throw new Error("expected utility-bill-record");
    }
  });
});
