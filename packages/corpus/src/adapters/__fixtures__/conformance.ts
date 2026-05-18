/**
 * Adapter conformance fixtures.
 *
 * Every adapter implementation passes the same conformance suite. The
 * suite asserts contract invariants — not source-specific behavior —
 * so divergence between adapters surfaces in CI rather than at first
 * production ingest.
 *
 * Per-adapter source-specific behavior is tested separately under the
 * adapter's own `__tests__/` directory.
 */

import { describe, expect, it } from "vitest";

import type {
  CodeSourceAdapter,
  CodeReference,
} from "../types.js";

/**
 * Run the conformance suite against one adapter implementation.
 *
 * `fixtureReference` and `fixtureRaw` are caller-provided — every
 * adapter ships with at least one fixture covering a real source
 * payload. The fixture is captured at conformance-suite write time and
 * checked into git under `__fixtures__/`.
 */
export interface ConformanceHarness {
  adapter: CodeSourceAdapter;
  /** A reference the suite can pass to fetch/metadata/normalize. */
  fixtureReference: CodeReference;
}

export function runAdapterConformance(harness: ConformanceHarness): void {
  const { adapter, fixtureReference } = harness;

  describe(`adapter conformance — ${adapter.capabilities.name}`, () => {
    it("exposes capabilities with a stable name", () => {
      expect(adapter.capabilities.name).toMatch(/^[a-z0-9-]+$/);
      expect(adapter.capabilities.displayName.length).toBeGreaterThan(0);
      expect(adapter.capabilities.sourceFamilies.length).toBeGreaterThan(0);
    });

    it("metadata() carries adapter name + non-empty jurisdiction + sourceUrl", async () => {
      const meta = await adapter.metadata(fixtureReference);
      expect(meta.sourceAdapter).toBe(adapter.capabilities.name);
      expect(meta.jurisdictionTenant.length).toBeGreaterThan(0);
      expect(meta.sourceUrl.length).toBeGreaterThan(0);
      expect(meta.fetchedAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
    });

    it("fetch() returns raw bytes with content type + metadata matching the reference", async () => {
      const raw = await adapter.fetch(fixtureReference);
      expect(raw.contentType.length).toBeGreaterThan(0);
      expect(raw.body.length).toBeGreaterThan(0);
      expect(raw.metadata.jurisdictionTenant).toBe(
        fixtureReference.jurisdictionTenant,
      );
      expect(raw.metadata.editionLabel).toBe(fixtureReference.editionLabel);
    });

    it("normalize() returns metadata matching fetch() + block stream", async () => {
      const raw = await adapter.fetch(fixtureReference);
      const normalized = await adapter.normalize(raw);
      expect(normalized.metadata.sourceAdapter).toBe(adapter.capabilities.name);
      expect(normalized.metadata.jurisdictionTenant).toBe(
        raw.metadata.jurisdictionTenant,
      );
      expect(Array.isArray(normalized.blocks)).toBe(true);
    });

    it("normalize() is pure — same input yields same output", async () => {
      const raw = await adapter.fetch(fixtureReference);
      const a = await adapter.normalize(raw);
      const b = await adapter.normalize(raw);
      expect(a.blocks.length).toBe(b.blocks.length);
      for (let i = 0; i < a.blocks.length; i++) {
        expect(a.blocks[i]).toEqual(b.blocks[i]);
      }
    });

    it("discover() returns an array (empty if !supportsDiscovery)", async () => {
      const results = await adapter.discover();
      expect(Array.isArray(results)).toBe(true);
      if (!adapter.capabilities.supportsDiscovery) {
        expect(results.length).toBe(0);
      }
    });

    it("every emitted heading carries a depth in [1,6] + text", async () => {
      const raw = await adapter.fetch(fixtureReference);
      const normalized = await adapter.normalize(raw);
      for (const block of normalized.blocks) {
        if (block.kind === "heading") {
          expect(block.depth).toBeGreaterThanOrEqual(1);
          expect(block.depth).toBeLessThanOrEqual(6);
          expect(block.text.length).toBeGreaterThan(0);
        }
      }
    });

    it("every cross-reference carries a referenceText + referenceType", async () => {
      const raw = await adapter.fetch(fixtureReference);
      const normalized = await adapter.normalize(raw);
      for (const block of normalized.blocks) {
        if (block.kind === "cross-reference") {
          expect(block.referenceText.length).toBeGreaterThan(0);
          expect(block.referenceType.length).toBeGreaterThan(0);
        }
      }
    });
  });
}
