/**
 * ICC Code Connect API client — Layer 1 model-code base (ADR-019).
 *
 * Code Connect is ICC's commercial OAuth2 JSON API for the I-Codes. Per
 * ADR-019's 2026-05-21 material update, Layer 1 ingest is gated on Code
 * Connect access; this client is built ahead of credentials so that the
 * moment access lands the ingest is "populate the secret, run it."
 *
 * ── CONTRACT STATUS ──────────────────────────────────────────────────
 * The ICC Code Connect dev portal (`api.iccsafe.org`) is a credentialed
 * SPA; the public Code Connect product pages document only that it is
 * an OAuth 2.0 JSON API returning sections / tables / figures / whole
 * chapters, with search across titles and current + historical
 * versions. Everything below the OAuth-2.0-JSON-API line is therefore
 * an ASSUMED contract, built so that adapting to the real OpenAPI spec
 * is a localized edit. Every assumption is tagged `@assumption` and is
 * collected in the CDX/ICC `_inbox` report's "needs confirmation" list.
 *
 * The operator is bringing the OpenAPI/Swagger spec, example payloads,
 * and the OAuth2 token-endpoint details back from the ICC meeting.
 * Reconcile this file against them when they land.
 *
 * ── MODES ────────────────────────────────────────────────────────────
 *   - "live"          — credentials supplied; OAuth2 + HTTP against the
 *                       real API.
 *   - "mock"          — fixtures supplied; hermetic, no network, no
 *                       OAuth. The default for tests and the conformance
 *                       suite, mirroring the RawPdfAdapter stub pattern.
 *   - "unconfigured"  — neither supplied; every call resolves empty so a
 *                       bare `new IccCodeConnectAdapter()` stays green
 *                       and inert until the credential secret is filled.
 */

import { RespectfulFetch } from "../http.js";

/* ──────────────────────────────────────────────────────────────────────
 *  Assumed wire contract
 * ──────────────────────────────────────────────────────────────────── */

/**
 * OAuth2 client-credentials token response.
 *
 * @assumption The token endpoint returns the RFC 6749 §5.1 standard
 * shape `{ access_token, token_type, expires_in }`. `expires_in` is
 * seconds. Confirm against the real token-endpoint response.
 */
export interface OAuthTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

/**
 * One published I-Code edition (e.g. the 2021 IRC). Code Connect's unit
 * of "title".
 *
 * @assumption Field names `titleId` / `codeAbbrev` / `name` / `year` /
 * `versionStatus`. The real API may name the edition key differently
 * (e.g. `id`, `documentId`); `titleId` is what every other call keys
 * on, so this is the highest-value field to confirm first.
 */
export interface CodeConnectTitle {
  /** Stable id Code Connect uses to address this edition. */
  titleId: string;
  /** I-Code family abbreviation: `IRC`, `IBC`, `IECC`, ... */
  codeAbbrev: string;
  /** Human name, e.g. "International Residential Code". */
  name: string;
  /** Edition year, e.g. 2021. */
  year: number;
  /** Whether this edition is the current one or a historical edition. */
  versionStatus: "current" | "historical";
}

/**
 * A chapter of an I-Code edition. Carries an ordered list of section
 * references; section bodies are fetched separately.
 *
 * @assumption A chapter response carries lightweight section references
 * (`sectionId` + `sectionNumber` + `heading`) rather than full section
 * bodies, and the bodies are fetched per-section. If Code Connect
 * returns whole chapters with inlined section bodies, `getChapter` can
 * return them directly and `fetchCodeDocument` skips the per-section
 * fan-out.
 */
export interface CodeConnectChapter {
  chapterId: string;
  titleId: string;
  /** Chapter number as published, e.g. "3" or "R3". */
  chapterNumber: string;
  heading: string;
  /** Ordered section references within this chapter. */
  sections: ReadonlyArray<CodeConnectSectionRef>;
}

/** A lightweight pointer to a section, as carried in a chapter response. */
export interface CodeConnectSectionRef {
  sectionId: string;
  /** Section number as published, e.g. "R301.2" or "1604.3". */
  sectionNumber: string;
  heading: string;
}

/**
 * One unit of section content. Code Connect returns content as prose,
 * tables, and figures.
 *
 * @assumption Content is an ordered array of discriminated nodes keyed
 * on `kind`. The real API may deliver section content as a single HTML
 * blob instead; if so, `normalize()` switches to an HTML walk and this
 * union collapses to a single `prose`-with-html node.
 */
export type CodeConnectContentNode =
  | { kind: "prose"; text: string }
  | {
      kind: "table";
      caption?: string;
      headers: ReadonlyArray<string>;
      rows: ReadonlyArray<ReadonlyArray<string>>;
    }
  | { kind: "figure"; caption?: string; imageUrl?: string };

/**
 * A defined term, as Code Connect surfaces it for the Definitions
 * chapters (Chapter 2 of the IRC/IBC).
 *
 * @assumption Code Connect structurally tags defined terms. If it does
 * not, `definedTerms` is simply absent and the model-code extractor
 * (Lane E deliverable 2) parses definitions out of prose instead.
 */
export interface CodeConnectDefinedTerm {
  term: string;
  definition: string;
}

/**
 * A section of an I-Code edition with its content.
 *
 * @assumption Section carries `sectionNumber` / `heading` / `content` /
 * optional `definedTerms`. Cross-references are NOT assumed to be
 * structurally tagged — model-code prose cites sister sections inline
 * ("see Section R301.2", "Table R301.2(1)"), and the adapter parses
 * them out of prose, exactly as the Municode adapter does. If Code
 * Connect does tag cross-references, add a `crossReferences` field and
 * prefer it over the prose parse.
 */
export interface CodeConnectSection {
  sectionId: string;
  titleId: string;
  chapterId: string;
  sectionNumber: string;
  heading: string;
  content: ReadonlyArray<CodeConnectContentNode>;
  definedTerms?: ReadonlyArray<CodeConnectDefinedTerm>;
  /**
   * The publisher's free Digital Codes viewer URL for this section, if
   * Code Connect returns it. The ADR-019 Layer 1 deep-link footing
   * needs a per-section deep-link; when Code Connect does not return
   * one the model-code extractor synthesizes it from `sectionNumber`.
   *
   * @assumption Optional; presence unknown until the spec lands.
   */
  viewerUrl?: string;
}

/**
 * One search hit. Code Connect "supports search across titles".
 *
 * @assumption Search returns section-level hits with a snippet. Result
 * field names and whether search is title-scoped or global are
 * unconfirmed.
 */
export interface CodeConnectSearchResult {
  sectionId: string;
  titleId: string;
  sectionNumber: string;
  heading: string;
  snippet: string;
}

/**
 * One edition in a code family's version history.
 *
 * @assumption `getVersions` is keyed by the family abbreviation
 * (`IRC`) and returns every edition Code Connect carries.
 */
export interface CodeConnectVersion {
  titleId: string;
  codeAbbrev: string;
  year: number;
  versionStatus: "current" | "historical";
}

/**
 * A whole I-Code edition assembled from a title + its chapters + every
 * section body. This is what the adapter's `fetch()` serializes into
 * the `RawCode` body so `normalize()` is a pure JSON walk.
 */
export interface IccCodeDocument {
  title: CodeConnectTitle;
  chapters: ReadonlyArray<{
    chapter: CodeConnectChapter;
    sections: ReadonlyArray<CodeConnectSection>;
  }>;
}

/* ──────────────────────────────────────────────────────────────────────
 *  Defaults + errors
 * ──────────────────────────────────────────────────────────────────── */

/**
 * @assumption Token endpoint. The Code Connect product page says
 * OAuth 2.0; the exact path is unconfirmed. `oauth2/token` is the
 * common convention. Override via `tokenUrl` / `ICC_CODE_CONNECT_TOKEN_URL`.
 */
export const DEFAULT_CODE_CONNECT_TOKEN_URL =
  "https://api.iccsafe.org/oauth2/token";

/**
 * @assumption API base. A `/v1`-style version segment is the common
 * convention; unconfirmed. Override via `baseUrl` /
 * `ICC_CODE_CONNECT_BASE_URL`.
 */
export const DEFAULT_CODE_CONNECT_BASE_URL =
  "https://api.iccsafe.org/codeconnect/v1";

/** Refresh the token this many ms before its stated expiry. */
const TOKEN_REFRESH_BUFFER_MS = 60_000;

/** Error raised by the Code Connect client for non-2xx / contract faults. */
export class CodeConnectError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: string,
  ) {
    super(message);
    this.name = "CodeConnectError";
  }
}

export type CodeConnectMode = "live" | "mock" | "unconfigured";

/**
 * Fixture set for mock mode. Built by hand from the assumed response
 * models and checked into `__fixtures__/`. The conformance suite and
 * unit tests run entirely against these — no network, no OAuth.
 */
export interface CodeConnectFixtures {
  titles: ReadonlyArray<CodeConnectTitle>;
  /** Assembled documents keyed by `titleId`. */
  documents: Record<string, IccCodeDocument>;
  /** Search results keyed by lower-cased query string. */
  search?: Record<string, ReadonlyArray<CodeConnectSearchResult>>;
  /** Version lists keyed by `codeAbbrev`. */
  versions?: Record<string, ReadonlyArray<CodeConnectVersion>>;
}

export interface CodeConnectClientOptions {
  /** OAuth2 client-credentials. Omit (or leave env empty) for mock mode. */
  credentials?: { clientId: string; clientSecret: string };
  /** Fixture set — supplying this selects mock mode. */
  fixtures?: CodeConnectFixtures;
  /** OAuth2 token endpoint. Defaults to {@link DEFAULT_CODE_CONNECT_TOKEN_URL}. */
  tokenUrl?: string;
  /** API base URL. Defaults to {@link DEFAULT_CODE_CONNECT_BASE_URL}. */
  baseUrl?: string;
  /** Shared respectful-fetch client (per-host throttle). */
  http?: RespectfulFetch;
}

/**
 * Resolve Code Connect credentials from the environment. Returns
 * `undefined` when either secret is empty — the pre-credential state —
 * so the adapter stays in mock / unconfigured mode.
 */
export function codeConnectCredentialsFromEnv(
  env: Record<string, string | undefined> = process.env,
): { clientId: string; clientSecret: string } | undefined {
  const clientId = env.ICC_CODE_CONNECT_CLIENT_ID?.trim();
  const clientSecret = env.ICC_CODE_CONNECT_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return undefined;
  return { clientId, clientSecret };
}

/* ──────────────────────────────────────────────────────────────────────
 *  Client
 * ──────────────────────────────────────────────────────────────────── */

interface CachedToken {
  accessToken: string;
  /** Epoch ms at which the token should be considered expired. */
  expiresAt: number;
}

/**
 * ICC Code Connect API client. OAuth2 client-credentials with token
 * caching + refresh in live mode; fixture-served in mock mode; inert in
 * unconfigured mode.
 */
export class CodeConnectClient {
  readonly mode: CodeConnectMode;

  private readonly credentials?: { clientId: string; clientSecret: string };
  private readonly fixtures?: CodeConnectFixtures;
  private readonly tokenUrl: string;
  private readonly baseUrl: string;
  private readonly http: RespectfulFetch;
  private cachedToken: CachedToken | null = null;

  constructor(opts: CodeConnectClientOptions = {}) {
    this.credentials = opts.credentials;
    this.fixtures = opts.fixtures;
    this.tokenUrl = opts.tokenUrl ?? DEFAULT_CODE_CONNECT_TOKEN_URL;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_CODE_CONNECT_BASE_URL).replace(
      /\/$/,
      "",
    );
    this.http =
      opts.http ??
      new RespectfulFetch({
        // Code Connect is a paid API with no documented public rate
        // limit; 2 rps is conservative and revisable once the spec
        // states the real ceiling.
        maxRequestsPerSecondPerHost: 2,
        userAgent: "HauskaEngineIngest/0.1 (+https://hauska.dev/bots) cc-agent-E",
      });

    if (this.fixtures) this.mode = "mock";
    else if (this.credentials) this.mode = "live";
    else this.mode = "unconfigured";
  }

  /* ── OAuth2 ─────────────────────────────────────────────────────── */

  /**
   * Return a valid bearer token, refreshing via the client-credentials
   * grant when the cache is empty or within the refresh buffer of
   * expiry. Only used in live mode.
   *
   * @assumption client-credentials grant, credentials in a
   * `application/x-www-form-urlencoded` body alongside
   * `grant_type=client_credentials`. The RFC 6749 alternative is HTTP
   * Basic auth for the client id/secret — switch the `body` / `headers`
   * here if the spec says Basic.
   */
  async getAccessToken(): Promise<string> {
    if (this.mode !== "live" || !this.credentials) {
      throw new CodeConnectError(
        "getAccessToken called outside live mode",
        0,
      );
    }
    const now = Date.now();
    if (this.cachedToken && this.cachedToken.expiresAt > now) {
      return this.cachedToken.accessToken;
    }
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.credentials.clientId,
      client_secret: this.credentials.clientSecret,
    });
    const res = await this.http.fetch(this.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new CodeConnectError(
        `Code Connect OAuth token request failed: HTTP ${res.status}`,
        res.status,
        text.slice(0, 500),
      );
    }
    const json = (await res.json()) as OAuthTokenResponse;
    if (!json.access_token) {
      throw new CodeConnectError(
        "Code Connect OAuth response missing access_token",
        res.status,
      );
    }
    const expiresInMs = (json.expires_in ?? 3600) * 1000;
    this.cachedToken = {
      accessToken: json.access_token,
      expiresAt: now + expiresInMs - TOKEN_REFRESH_BUFFER_MS,
    };
    return json.access_token;
  }

  /** Drop the cached token so the next call re-authenticates. */
  invalidateToken(): void {
    this.cachedToken = null;
  }

  /* ── HTTP ───────────────────────────────────────────────────────── */

  private async getJson<T>(
    path: string,
    params: Record<string, string | number | undefined> = {},
  ): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined) continue;
      url.searchParams.set(k, String(v));
    }
    const token = await this.getAccessToken();
    const res = await this.http.fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (res.status === 401) {
      // Stale token — drop the cache so a retry re-authenticates.
      this.invalidateToken();
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new CodeConnectError(
        `Code Connect ${path} -> HTTP ${res.status}`,
        res.status,
        text.slice(0, 500),
      );
    }
    return (await res.json()) as T;
  }

  /* ── Endpoints ──────────────────────────────────────────────────── */

  /**
   * List every I-Code edition Code Connect carries.
   *
   * @assumption `GET /titles`.
   */
  async listTitles(): Promise<ReadonlyArray<CodeConnectTitle>> {
    if (this.mode === "unconfigured") return [];
    if (this.mode === "mock") return this.fixtures!.titles;
    return await this.getJson<CodeConnectTitle[]>("/titles");
  }

  /**
   * List the chapters of one edition.
   *
   * @assumption `GET /titles/{titleId}/chapters`.
   */
  async getChapters(
    titleId: string,
  ): Promise<ReadonlyArray<CodeConnectChapter>> {
    if (this.mode === "unconfigured") return [];
    if (this.mode === "mock") {
      const doc = this.fixtures!.documents[titleId];
      return doc ? doc.chapters.map((c) => c.chapter) : [];
    }
    return await this.getJson<CodeConnectChapter[]>(
      `/titles/${encodeURIComponent(titleId)}/chapters`,
    );
  }

  /**
   * Fetch one chapter.
   *
   * @assumption `GET /titles/{titleId}/chapters/{chapterId}`.
   */
  async getChapter(
    titleId: string,
    chapterId: string,
  ): Promise<CodeConnectChapter | null> {
    if (this.mode === "unconfigured") return null;
    if (this.mode === "mock") {
      const doc = this.fixtures!.documents[titleId];
      return (
        doc?.chapters.find((c) => c.chapter.chapterId === chapterId)?.chapter ??
        null
      );
    }
    return await this.getJson<CodeConnectChapter>(
      `/titles/${encodeURIComponent(titleId)}/chapters/${encodeURIComponent(chapterId)}`,
    );
  }

  /**
   * Fetch one section with its content.
   *
   * @assumption `GET /titles/{titleId}/sections/{sectionId}`.
   */
  async getSection(
    titleId: string,
    sectionId: string,
  ): Promise<CodeConnectSection | null> {
    if (this.mode === "unconfigured") return null;
    if (this.mode === "mock") {
      const doc = this.fixtures!.documents[titleId];
      for (const c of doc?.chapters ?? []) {
        const hit = c.sections.find((s) => s.sectionId === sectionId);
        if (hit) return hit;
      }
      return null;
    }
    return await this.getJson<CodeConnectSection>(
      `/titles/${encodeURIComponent(titleId)}/sections/${encodeURIComponent(sectionId)}`,
    );
  }

  /**
   * Search across titles.
   *
   * @assumption `GET /search?q=...`. The real API may scope by title or
   * paginate; reconcile when the spec lands.
   */
  async search(
    query: string,
  ): Promise<ReadonlyArray<CodeConnectSearchResult>> {
    if (this.mode === "unconfigured") return [];
    if (this.mode === "mock") {
      return this.fixtures!.search?.[query.toLowerCase()] ?? [];
    }
    return await this.getJson<CodeConnectSearchResult[]>("/search", {
      q: query,
    });
  }

  /**
   * List the editions Code Connect carries for one I-Code family.
   *
   * @assumption `GET /codes/{codeAbbrev}/versions`.
   */
  async getVersions(
    codeAbbrev: string,
  ): Promise<ReadonlyArray<CodeConnectVersion>> {
    if (this.mode === "unconfigured") return [];
    if (this.mode === "mock") {
      return this.fixtures!.versions?.[codeAbbrev] ?? [];
    }
    return await this.getJson<CodeConnectVersion[]>(
      `/codes/${encodeURIComponent(codeAbbrev)}/versions`,
    );
  }

  /**
   * Assemble a whole edition: title + chapters + every section body.
   * Mock mode returns the fixture document directly; live mode walks
   * chapters and fans out one `getSection` per section reference.
   */
  async fetchCodeDocument(titleId: string): Promise<IccCodeDocument | null> {
    if (this.mode === "unconfigured") return null;
    if (this.mode === "mock") {
      return this.fixtures!.documents[titleId] ?? null;
    }
    const titles = await this.listTitles();
    const title = titles.find((t) => t.titleId === titleId);
    if (!title) return null;
    const chapters = await this.getChapters(titleId);
    const assembled: Array<{
      chapter: CodeConnectChapter;
      sections: CodeConnectSection[];
    }> = [];
    for (const chapter of chapters) {
      const sections: CodeConnectSection[] = [];
      for (const ref of chapter.sections) {
        const section = await this.getSection(titleId, ref.sectionId);
        if (section) sections.push(section);
      }
      assembled.push({ chapter, sections });
    }
    return { title, chapters: assembled };
  }
}
