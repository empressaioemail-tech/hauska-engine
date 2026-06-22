/**
 * ICC Code Connect PoC demo instance tests.
 */

import { describe, expect, it } from "vitest";

import { buildAtomDid } from "@hauska-engine/atoms";

import {
  ICC_CODE_CONNECT_DEMO_TITLE_IDS,
  ICC_CODE_CONNECT_SOURCE_ADAPTER,
  ICC_MODEL_CODE_ACCESS_POLICY,
  ICC_MODEL_CODE_DID_LOCAL_ID_PREFIX,
  ICC_MODEL_CODE_TENANT,
  isIccModelCodeAtom,
  isIccModelCodeAtomDid,
} from "../demo-instance.js";
import { extractModelCodeAtoms } from "../extractor.js";
import {
  IBC_2018_DOCUMENT,
  IPMC_2018_DOCUMENT,
} from "../../adapters/icc-code-connect/__fixtures__/irc-2021.js";

describe("ICC Code Connect PoC demo instance", () => {
  it("scopes the demo to 2018 IBC + 2018 IPMC under icc-model-code", () => {
    expect(ICC_CODE_CONNECT_DEMO_TITLE_IDS).toEqual(["IBC2018", "IPMC2018"]);
    expect(ICC_MODEL_CODE_TENANT).toBe("icc-model-code");
    expect(ICC_MODEL_CODE_ACCESS_POLICY).toBe("platform-internal");
  });

  it("identifies ICC atoms by tenant, source adapter, and DID prefix", async () => {
    const ibc = await extractModelCodeAtoms(IBC_2018_DOCUMENT);
    const section = ibc.sections[0]!;
    expect(
      isIccModelCodeAtom({
        jurisdictionTenant: section.jurisdictionTenant,
        sourceAdapter: section.sourceAdapter,
        entityId: section.entityId,
      }),
    ).toBe(true);
    expect(section.sourceAdapter).toBe(ICC_CODE_CONNECT_SOURCE_ADAPTER);

    const did = buildAtomDid("code-section", section.entityId).raw;
    expect(isIccModelCodeAtomDid(did)).toBe(true);
    expect(section.entityId.startsWith(ICC_MODEL_CODE_DID_LOCAL_ID_PREFIX)).toBe(
      true,
    );
  });

  it("rejects non-ICC atoms", () => {
    expect(
      isIccModelCodeAtom({
        jurisdictionTenant: "bastrop_tx",
        sourceAdapter: ICC_CODE_CONNECT_SOURCE_ADAPTER,
        entityId: "bastrop_tx/edition/101",
      }),
    ).toBe(false);
  });
});

describe("extractModelCodeAtoms — PoC demo fixtures (layer-in-between)", () => {
  it("sets verbatimTextDeepLink and keeps verbatim prose out of bodyText (IBC 2018)", async () => {
    const result = await extractModelCodeAtoms(IBC_2018_DOCUMENT);
    const s1604 = result.sections.find((s) => s.sectionNumber === "1604")!;
    expect(s1604.verbatimTextDeepLink).toContain("IBC2018");
    expect(s1604.bodyText).toContain("Layer 1 model-code base section");
    expect(s1604.bodyText).not.toContain("safely support all loads");
    expect(s1604.bodyText).not.toContain("dead loads, live loads");
  });

  it("emits definitions and cross-references from the IPMC 2018 fixture", async () => {
    const result = await extractModelCodeAtoms(IPMC_2018_DOCUMENT);
    expect(result.definitions.map((d) => d.term).sort()).toEqual([
      "DWELLING UNIT",
      "EXTERIOR PROPERTY",
    ]);
    expect(result.crossReferences.length).toBeGreaterThan(0);
    const s501 = result.sections.find((s) => s.sectionNumber === "501")!;
    expect(s501.verbatimTextDeepLink).toBeTruthy();
    expect(s501.bodyText).not.toContain("bathtub or shower");
  });
});
