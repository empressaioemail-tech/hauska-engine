import { describe, expect, it } from "vitest";

import {
  mapSymbolDescriptionToWellStatus,
  mapSymbolDescriptionToWellType,
  mapSymnumToWellStatus,
  mapSymnumToWellType,
  resolveWellStatus,
  resolveWellType,
} from "../symnum.js";

/**
 * Adversarial: unmatched SYMNUMs must fail closed.
 * SYMNUM 9 = Canceled/Abandoned Location in RRC Appendix A.
 * Must never silently become confident "producing" / "oil".
 */
describe("adversarial symnum fail-closed", () => {
  it("does not map unmatched SYMNUM 9 to producing/oil", () => {
    expect(mapSymnumToWellStatus(9)).not.toBe("producing");
    expect(mapSymnumToWellType(9)).not.toBe("oil");
    expect(mapSymnumToWellStatus(9)).toBe("unknown");
    expect(mapSymnumToWellType(9)).toBe("unknown");
  });

  it("does not map unknown SYMNUM 99999 to producing/oil", () => {
    expect(mapSymnumToWellStatus(99999)).not.toBe("producing");
    expect(mapSymnumToWellType(99999)).not.toBe("oil");
    expect(mapSymnumToWellStatus(99999)).toBe("unknown");
    expect(mapSymnumToWellType(99999)).toBe("unknown");
  });

  it("description Canceled/Abandoned Location wins over producing-ish SYMNUM", () => {
    expect(
      resolveWellStatus(4, "Canceled / Abandoned Location"),
    ).toBe("unknown");
    expect(
      resolveWellType(4, "Canceled / Abandoned Location"),
    ).toBe("unknown");
  });

  it("description Oil Well maps to producing/oil", () => {
    expect(mapSymbolDescriptionToWellStatus("Oil Well")).toBe("producing");
    expect(mapSymbolDescriptionToWellType("Oil Well")).toBe("oil");
    expect(resolveWellStatus(9, "Oil Well")).toBe("producing");
    expect(resolveWellType(9, "Oil Well")).toBe("oil");
  });

  it("description Oil/Gas Well is producing with oil type", () => {
    expect(mapSymbolDescriptionToWellStatus("Oil/Gas Well")).toBe("producing");
    expect(mapSymbolDescriptionToWellType("Oil/Gas Well")).toBe("oil");
  });
});
