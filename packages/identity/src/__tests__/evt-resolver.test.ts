import { describe, expect, it } from "vitest";

import {
  assertValidEvtId,
  rejectHandConstructedEvtId,
  resolveEvtId,
} from "../evt-resolver.js";

describe("evt_ resolver", () => {
  const source = "https://example.gov/agenda";
  const externalId = "item-42";

  it("generates stable evt_ ids from (source, external_id)", () => {
    const a = resolveEvtId(source, externalId);
    const b = resolveEvtId(source, externalId);
    expect(a).toBe(b);
    expect(a.startsWith("evt_")).toBe(true);
  });

  it("rejects hand-constructed evt_ ids", () => {
    const real = resolveEvtId(source, externalId);
    assertValidEvtId(real, source, externalId);
    expect(() =>
      assertValidEvtId("evt_deadbeefdeadbeefdeadbeefdeadbeef", source, externalId),
    ).toThrow(/Invalid evt_ id/);
    expect(() => rejectHandConstructedEvtId("evt_not-hex-suffix")).toThrow();
  });
});
