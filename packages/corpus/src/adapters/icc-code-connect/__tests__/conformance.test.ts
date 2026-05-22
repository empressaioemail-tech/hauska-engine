/**
 * ICC Code Connect adapter — conformance + OAuth2 + content tests.
 *
 * Runs entirely hermetic: the conformance + content suites use the
 * mock-mode adapter (fixtures, no network); the OAuth2 suite uses a
 * stubbed `RespectfulFetch` so the client's token + bearer flow is
 * exercised without `api.iccsafe.org`.
 */

import { describe, expect, it } from "vitest";

import { runAdapterConformance } from "../../__fixtures__/conformance.js";
import { RespectfulFetch } from "../../http.js";
import type { CodeReference, RawCode } from "../../types.js";
import { IccCodeConnectAdapter } from "../index.js";
import { CodeConnectClient, CodeConnectError } from "../code-connect-client.js";
import {
  ICC_CODE_CONNECT_FIXTURES,
  IRC_2021_TITLE_ID,
} from "../__fixtures__/irc-2021.js";

/* ── Conformance ──────────────────────────────────────────────────── */

const fixtureReference: CodeReference = {
  sourceId: IRC_2021_TITLE_ID,
  jurisdictionTenant: "icc-model-code",
  editionLabel: "2021 International Residential Code",
  sourceUrl: "https://codes.iccsafe.org/content/IRC2021",
};

const mockAdapter = new IccCodeConnectAdapter({
  fixtures: ICC_CODE_CONNECT_FIXTURES,
});

runAdapterConformance({ adapter: mockAdapter, fixtureReference });

/* ── Content-specific (IRC 2021 fixture) ──────────────────────────── */

describe("IccCodeConnectAdapter — content (IRC 2021 fixture)", () => {
  it("discover() lists every I-Code edition as a reference", async () => {
    const refs = await mockAdapter.discover();
    expect(refs.map((r) => r.sourceId)).toEqual([
      "IRC2021",
      "IRC2018",
      "IBC2021",
      "IECC2021",
    ]);
    expect(refs.every((r) => r.jurisdictionTenant === "icc-model-code")).toBe(
      true,
    );
    expect(refs[0]!.editionLabel).toBe("2021 International Residential Code");
  });

  it("emits chapter headings at depth 1 and section headings at depth 2", async () => {
    const raw = await mockAdapter.fetch(fixtureReference);
    const normalized = await mockAdapter.normalize(raw);
    const chapters = normalized.blocks.filter(
      (b) => b.kind === "heading" && b.depth === 1,
    );
    const sections = normalized.blocks.filter(
      (b) => b.kind === "heading" && b.depth === 2,
    );
    expect(chapters.map((c) => (c.kind === "heading" ? c.text : ""))).toEqual([
      "Chapter 2 Definitions",
      "Chapter 3 Building Planning",
    ]);
    expect(sections.map((s) => (s.kind === "heading" ? s.label : ""))).toEqual([
      "R201",
      "R202",
      "R301",
      "R302",
    ]);
  });

  it("emits structurally-tagged defined terms as definition blocks", async () => {
    const raw = await mockAdapter.fetch(fixtureReference);
    const normalized = await mockAdapter.normalize(raw);
    const defs = normalized.blocks.filter((b) => b.kind === "definition");
    const terms = defs.map((d) => (d.kind === "definition" ? d.term : ""));
    expect(terms).toContain("HABITABLE SPACE");
    expect(terms).toContain("TOWNHOUSE");
  });

  it("lifts model-code cross-references out of section prose", async () => {
    const raw = await mockAdapter.fetch(fixtureReference);
    const normalized = await mockAdapter.normalize(raw);
    const xrefs = normalized.blocks.filter((b) => b.kind === "cross-reference");
    const labels = xrefs.map((x) =>
      x.kind === "cross-reference" ? x.targetSectionLabel : "",
    );
    // "Table R301.2(1)", "Table R302.1(1)", "Section R302.2",
    // "Section R301", "Chapter 2" are all cited in the fixture prose.
    expect(labels).toContain("R301.2(1)");
    expect(labels).toContain("R302.2");
    expect(labels).toContain("2");
    const types = new Set(
      xrefs.map((x) => (x.kind === "cross-reference" ? x.referenceType : "")),
    );
    expect(types.has("notwithstanding")).toBe(true);
  });

  it("emits table and figure blocks from structured section content", async () => {
    const raw = await mockAdapter.fetch(fixtureReference);
    const normalized = await mockAdapter.normalize(raw);
    const table = normalized.blocks.find((b) => b.kind === "table");
    const figure = normalized.blocks.find((b) => b.kind === "figure");
    expect(table && table.kind === "table" ? table.headers.length : 0).toBe(3);
    expect(figure && figure.kind === "figure" ? figure.caption : "").toMatch(
      /FIGURE R302\.1/,
    );
  });

  it("fetch() returns a JSON body; an unknown title yields an empty body", async () => {
    const raw = await mockAdapter.fetch(fixtureReference);
    expect(raw.contentType).toBe("application/json");
    expect(raw.body.length).toBeGreaterThan(0);

    const unknown = await mockAdapter.fetch({
      ...fixtureReference,
      sourceId: "IRC1999",
    });
    expect(unknown.body).toBe("");
    const normalized = await mockAdapter.normalize(unknown);
    expect(normalized.blocks).toEqual([]);
  });
});

/* ── Unconfigured mode ────────────────────────────────────────────── */

describe("IccCodeConnectAdapter — unconfigured (no credentials, no fixtures)", () => {
  // Mirrors the RawPdfAdapter no-hooks stub: a bare adapter is green and
  // inert until the OAuth2 secret is populated.
  const bare = new IccCodeConnectAdapter();

  it("resolves to unconfigured mode", () => {
    expect(bare.mode).toBe("unconfigured");
  });

  it("discover() is empty and fetch() yields an empty body", async () => {
    expect(await bare.discover()).toEqual([]);
    const raw = await bare.fetch(fixtureReference);
    expect(raw.body).toBe("");
    expect((await bare.normalize(raw)).blocks).toEqual([]);
  });
});

/* ── OAuth2 client (stubbed transport) ────────────────────────────── */

interface StubCall {
  url: string;
  init: { method?: string; headers?: Record<string, string>; body?: unknown };
}

/** Minimal `Response`-shaped object the client consumes. */
function fakeResponse(status: number, json: unknown): unknown {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return json;
    },
    async text() {
      return JSON.stringify(json);
    },
  };
}

/**
 * Stub transport: records every call and answers the token endpoint and
 * the `/titles` endpoint. `tokenIssues` counts how many times the OAuth
 * token grant was hit so caching / refresh can be asserted.
 */
class StubFetch extends RespectfulFetch {
  readonly calls: StubCall[] = [];
  tokenIssues = 0;
  constructor(private readonly tokenExpiresIn: number) {
    super({ maxRequestsPerSecondPerHost: 1000 });
  }
  override async fetch(url: string, init: Record<string, unknown> = {}) {
    this.calls.push({
      url,
      init: init as StubCall["init"],
    });
    if (url.includes("/oauth2/token")) {
      this.tokenIssues += 1;
      return fakeResponse(200, {
        access_token: `token-${this.tokenIssues}`,
        token_type: "Bearer",
        expires_in: this.tokenExpiresIn,
      }) as never;
    }
    return fakeResponse(200, ICC_CODE_CONNECT_FIXTURES.titles) as never;
  }
}

describe("CodeConnectClient — OAuth2 client-credentials flow", () => {
  const credentials = { clientId: "cid", clientSecret: "secret" };

  it("resolves mode from the constructor inputs", () => {
    expect(new CodeConnectClient({ credentials }).mode).toBe("live");
    expect(
      new CodeConnectClient({ fixtures: ICC_CODE_CONNECT_FIXTURES }).mode,
    ).toBe("mock");
    expect(new CodeConnectClient().mode).toBe("unconfigured");
  });

  it("fetches a token then sends it as a bearer header on API calls", async () => {
    const http = new StubFetch(3600);
    const client = new CodeConnectClient({ credentials, http });
    await client.listTitles();

    const tokenCall = http.calls.find((c) => c.url.includes("/oauth2/token"));
    expect(tokenCall?.init.method).toBe("POST");
    expect(String(tokenCall?.init.body)).toContain(
      "grant_type=client_credentials",
    );

    const apiCall = http.calls.find((c) => c.url.includes("/titles"));
    expect(apiCall?.init.headers?.Authorization).toBe("Bearer token-1");
  });

  it("caches a non-expired token across calls", async () => {
    const http = new StubFetch(3600);
    const client = new CodeConnectClient({ credentials, http });
    await client.listTitles();
    await client.listTitles();
    expect(http.tokenIssues).toBe(1);
  });

  it("re-authenticates once the token has expired", async () => {
    // expires_in 0 -> expiresAt is in the past after the refresh buffer,
    // so every call re-issues.
    const http = new StubFetch(0);
    const client = new CodeConnectClient({ credentials, http });
    await client.listTitles();
    await client.listTitles();
    expect(http.tokenIssues).toBe(2);
  });

  it("surfaces a non-2xx API response as a CodeConnectError", async () => {
    class FailingFetch extends RespectfulFetch {
      constructor() {
        super({ maxRequestsPerSecondPerHost: 1000 });
      }
      override async fetch(url: string) {
        if (url.includes("/oauth2/token")) {
          return fakeResponse(200, {
            access_token: "t",
            token_type: "Bearer",
            expires_in: 3600,
          }) as never;
        }
        return fakeResponse(503, { error: "unavailable" }) as never;
      }
    }
    const client = new CodeConnectClient({
      credentials,
      http: new FailingFetch(),
    });
    await expect(client.listTitles()).rejects.toBeInstanceOf(CodeConnectError);
  });
});
