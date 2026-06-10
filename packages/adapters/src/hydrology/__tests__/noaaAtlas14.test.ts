import { describe, it, expect } from "vitest";
import {
  buildPfdsUrl,
  parsePfdsDepthTable,
} from "../noaaAtlas14.js";

describe("noaaAtlas14", () => {
  it("buildPfdsUrl includes lat/lon and depth params", () => {
    const url = buildPfdsUrl(30.5086, -97.6789);
    expect(url).toContain("lat=30.508600");
    expect(url).toContain("lon=-97.678900");
    expect(url).toContain("data=depth");
  });

  it("parsePfdsDepthTable extracts return-period depths", () => {
    const html = `
      <table>
        <tr><td>100</td><td>6.2</td></tr>
        <tr><td>25</td><td>4.1</td></tr>
      </table>
    `;
    const parsed = parsePfdsDepthTable(html);
    expect(parsed.get(100)).toBe(6.2);
    expect(parsed.get(25)).toBe(4.1);
  });
});
