import { describe, expect, it } from "vitest";
import { PLACEHOLDER_SETBACK_PROVENANCE, classifySetbackRuleAtom } from "@hauska-engine/adapters";

import { PLACEHOLDER_COLLISION, planCitySetback } from "../index.js";

const placeholderRule = {
  sourceAdapter: "property-atom-proof",
  sourceCodeAtomRef: {
    atomDid: `did:hauska:code-section:${PLACEHOLDER_SETBACK_PROVENANCE}`,
  },
};

describe("setback city plan placeholder granularity", () => {
  it("placeholder plus named source supersedes; does not refuse the city plan", () => {
    const plan = planCitySetback({
      countyFips: "48021",
      cityKey: "elgin-tx",
      parcels: [
        {
          parcelNodeId: "48021:PH-1",
          inCity: true,
          district: "R-1",
          existingSetbackRule: placeholderRule,
        },
        { parcelNodeId: "48021:CLEAN-1", inCity: true, district: "R-1" },
      ],
    });
    expect(plan.planned).toHaveLength(2);
    expect(plan.planned[0]?.outcome).toBe("present");
    expect(plan.planned[0]?.placeholderDisposition).toBe(
      "superseded-by-named-source",
    );
    expect(plan.planned[0]?.basis).toContain(PLACEHOLDER_COLLISION);
    expect(plan.planned[1]?.outcome).toBe("present");
    expect(plan.planned[1]?.placeholderDisposition).toBeUndefined();
    expect(plan.counts.present).toBe(2);
  });

  it("placeholder without a named source is recorded-unknown and not adopted", () => {
    const plan = planCitySetback({
      countyFips: "48021",
      cityKey: "smithville-tx",
      parcels: [
        {
          parcelNodeId: "48021:PH-SMITH",
          inCity: true,
          existingSetbackRule: placeholderRule,
        },
      ],
    });
    expect(plan.planned[0]?.outcome).toBe("unmeasured");
    expect(plan.planned[0]?.placeholderDisposition).toBe("recorded-unknown");
    expect(plan.planned[0]?.outcome).not.toBe("present");
  });

  it("F3: overwrite a placeholder body with a named-source rule classifies value", () => {
    const named = {
      sourceAdapter: "bastrop-per-parcel-record-layer-23",
      sourceCodeAtomRef: { atomDid: "did:hauska:code-section:bdc:14.02.003" },
    };
    expect(classifySetbackRuleAtom(placeholderRule).disposition).toBe("unknown");
    expect(classifySetbackRuleAtom(named).disposition).toBe("value");
  });
});
