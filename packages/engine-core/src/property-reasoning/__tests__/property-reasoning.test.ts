import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createWidthedConfidence } from "@empressaio/atom-contract/read-contract";
import { describe, expect, it } from "vitest";

import { buildAtomDid } from "@hauska-engine/atoms";

import cookStub from "../fixtures/descriptors/cook_county_il_stub.json" with { type: "json" };
import bexarFixture from "../fixtures/descriptors/bexar_tx_fixture.json" with { type: "json" };
import { composeDerivedAssertedConfidence } from "../confidence.js";
import { emitBuildableEnvelope } from "../emit-buildable-envelope.js";
import { emitSetbackRule, resolveSetbackTableRow } from "../emit-setback-rule.js";
import { emitZoningFact } from "../emit-zoning-fact.js";
import type { JurisdictionDescriptor } from "../types.js";

const REASONING_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const JURISDICTION_LITERAL_PATTERN =
  /\b(texas|central[\s-]?tx|\bTX\b|bexar|hays|comal|travis|williamson|48029|48209|48091|48453|48491)\b/i;

describe("property-reasoning jurisdiction-agnostic grep gate (WDLL 3.8)", () => {
  it("reasoning .ts modules contain zero jurisdiction literals outside fixtures", () => {
    const tsFiles = readdirSync(REASONING_DIR, { recursive: true, withFileTypes: true })
      .filter(
        (e) =>
          e.isFile() &&
          e.name.endsWith(".ts") &&
          !e.name.endsWith(".test.ts") &&
          !String(e.parentPath ?? e.path).includes("fixtures"),
      )
      .map((e) => join(e.parentPath ?? e.path, e.name));

    const hits: string[] = [];
    for (const file of tsFiles) {
      const text = readFileSync(file, "utf8");
      if (JURISDICTION_LITERAL_PATTERN.test(text)) {
        hits.push(file);
      }
    }
    expect(hits).toEqual([]);
  });
});

describe("cook_county_il_stub golden descriptor (WDLL 3.8 I-B anti-zombie)", () => {
  const descriptor = cookStub as JurisdictionDescriptor;
  const parcelNodeId = `${descriptor.parcelFips}:COOK-STUB-001`;

  it("emits conformant zoning fact + setback rule + derived envelope without code changes", () => {
    const zoning = emitZoningFact(descriptor, {
      parcelNodeId,
      districtCode: "RS-1",
      matchBasis: "exact",
      sourceCitation: "Cook stub GIS zoning layer",
      extractedAt: "2026-07-23T12:00:00.000Z",
    });
    expect(zoning).toMatchObject({ entityType: "zoning-fact", districtCode: "RS-1" });

    const row = resolveSetbackTableRow(descriptor.setbackTable, "RS-1");
    expect(row).not.toHaveProperty("kind", "honest-absence");
    if ("kind" in row) throw new Error("expected setback row");

    const setback = emitSetbackRule(
      descriptor,
      "RS-1",
      descriptor.setbackTable!.rows[0]!,
      parcelNodeId,
    );
    expect(setback).toMatchObject({
      entityType: "setback-rule",
      sourceCodeAtomRef: { entityType: "code-section" },
    });
    if ("kind" in setback) throw new Error("expected setback atom");

    const envelope = emitBuildableEnvelope({
      descriptor,
      parcelNodeId,
      zoningFactAtomDid: buildAtomDid("zoning-fact", (zoning as { entityId: string }).entityId)
        .raw,
      setbackRuleAtomDid: buildAtomDid("setback-rule", setback.entityId).raw,
      geometryRefId: `${parcelNodeId}/geometry`,
      frontEdgeRefId: `${parcelNodeId}/front-edge`,
      outcome: { kind: "buildable", areaSqFt: 4200 },
      inputAssertedConfidences: [
        (zoning as { readAxes: { assertedConfidence: { estimate: number } } }).readAxes
          .assertedConfidence,
        setback.readAxes.assertedConfidence,
      ],
      sourceCitation: "Derived buildable envelope from stub chain",
      extractedAt: "2026-07-23T12:00:00.000Z",
    });
    expect(envelope).toMatchObject({
      entityType: "buildable-envelope",
      reasoningChain: { reasoningKind: "derived" },
    });
  });
});

describe("Bexar null-zoning honest absence (WDLL 3.3)", () => {
  const descriptor = bexarFixture as JurisdictionDescriptor;

  it("returns honest-absence for null zoning, not an I-2 stamp", () => {
    const result = emitZoningFact(descriptor, {
      parcelNodeId: `${descriptor.parcelFips}:BEXAR-NULL-001`,
      districtCode: null,
      matchBasis: "exact",
      sourceCitation: "Bexar fixture — null zoning polygon",
      extractedAt: "2026-07-23T12:00:00.000Z",
    });
    expect(result).toEqual(
      expect.objectContaining({
        kind: "honest-absence",
        code: "zoning-null",
      }),
    );
    expect(JSON.stringify(result)).not.toMatch(/I-2|"I2"|industrial/i);
  });
});

describe("composed confidence discipline (WDLL 3.6)", () => {
  it("never multiplies labeling x district style confidences", () => {
    const multiplyPattern =
      /labeling\.confidence\s*\*\s*district\.confidence|district\.confidence\s*\*\s*labeling\.confidence/;
    const tsFiles = readdirSync(REASONING_DIR, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".ts"))
      .map((e) => join(e.parentPath ?? e.path, e.name));
    const hits = tsFiles.filter((file) =>
      multiplyPattern.test(readFileSync(file, "utf8")),
    );
    expect(hits).toEqual([]);
  });

  it("composeDerivedAssertedConfidence uses minimum, not product", () => {
    const a = createWidthedConfidence({
      estimate: 0.9,
      n: 1,
      intervalWidth: 0.1,
      provenance: "asserted",
    });
    const b = createWidthedConfidence({
      estimate: 0.6,
      n: 1,
      intervalWidth: 0.2,
      provenance: "asserted",
    });
    const composed = composeDerivedAssertedConfidence([a, b]);
    expect(composed.estimate).toBe(0.6);
    expect(composed.estimate).not.toBeCloseTo(0.54);
  });
});
