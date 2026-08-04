/**
 * robots.txt gate — unit tests against the real ecode360.com robots.txt
 * captured live during the 2026-07-29 proof wave
 * (P:/tmp/tx_scraper_proofs/smithville/robots_raw.txt, HTTP 200 fetch;
 * copied here as `__tests__/fixtures/robots-ecode360.txt`).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ECode360RobotsDisallowedError,
  assertPathAllowed,
  isPathAllowed,
  parseRobotsTxt,
} from "../robots.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROBOTS_TXT = readFileSync(
  join(__dirname, "fixtures/robots-ecode360.txt"),
  "utf-8",
);

describe("parseRobotsTxt — real ecode360.com robots.txt", () => {
  const rules = parseRobotsTxt(ROBOTS_TXT);

  it("captures the UA * Disallow prefixes verified live 2026-07-29", () => {
    expect([...rules.disallowPrefixes].sort()).toEqual(
      [
        "/admin",
        "/admin/",
        "/archives",
        "/archives/",
        "/attachment",
        "/attachment/",
        "/dashboard",
        "/dashboard/",
        "/documents",
        "/documents/",
        "/output",
        "/output/",
        "/permissions",
        "/permissions/",
        "/print",
        "/print/",
        "/search",
        "/search/",
        "/user",
        "/user/",
      ].sort(),
    );
  });

  it("does not pick up bingbot/Applebot's blanket Disallow: / (UA-specific, not *)", () => {
    // If the parser mis-grouped and applied bingbot's `Disallow: /` to
    // UA *, every path would be blocked — including the landing page,
    // which the live proof confirmed is allowed.
    expect(isPathAllowed(rules, "/SM6484")).toBe(true);
  });

  it("allows the landing page, TOC, and numeric content paths the adapter fetches", () => {
    expect(isPathAllowed(rules, "/SM6484")).toBe(true);
    expect(isPathAllowed(rules, "/toc/SM6484")).toBe(true);
    expect(isPathAllowed(rules, "/39654740")).toBe(true);
    expect(isPathAllowed(rules, "/39654892")).toBe(true);
  });

  it("disallows the documented UA * paths", () => {
    expect(isPathAllowed(rules, "/admin")).toBe(false);
    expect(isPathAllowed(rules, "/admin/panel")).toBe(false);
    expect(isPathAllowed(rules, "/search")).toBe(false);
    expect(isPathAllowed(rules, "/search/foo")).toBe(false);
    expect(isPathAllowed(rules, "/print")).toBe(false);
  });

  it("assertPathAllowed throws ECode360RobotsDisallowedError on a disallowed path", () => {
    expect(() => assertPathAllowed(rules, "/admin")).toThrow(
      ECode360RobotsDisallowedError,
    );
  });

  it("assertPathAllowed does not throw on an allowed path", () => {
    expect(() => assertPathAllowed(rules, "/toc/SM6484")).not.toThrow();
  });
});

describe("parseRobotsTxt — grouping edge cases", () => {
  it("does not leak a later UA's rules into an earlier group", () => {
    const body = [
      "User-agent: BadBot",
      "Disallow: /",
      "",
      "User-agent: *",
      "Disallow: /admin",
    ].join("\n");
    const rules = parseRobotsTxt(body);
    expect(rules.disallowPrefixes).toEqual(["/admin"]);
    expect(isPathAllowed(rules, "/")).toBe(true);
  });

  it("ignores comments and blank lines", () => {
    const body = [
      "# comment",
      "User-agent: *",
      "# another comment",
      "Disallow: /admin # inline comment",
      "",
    ].join("\n");
    const rules = parseRobotsTxt(body);
    expect(rules.disallowPrefixes).toEqual(["/admin"]);
  });

  it("returns no disallow prefixes when there is no UA * group", () => {
    const body = ["User-agent: BadBot", "Disallow: /"].join("\n");
    const rules = parseRobotsTxt(body);
    expect(rules.disallowPrefixes).toEqual([]);
    expect(isPathAllowed(rules, "/anything")).toBe(true);
  });
});
