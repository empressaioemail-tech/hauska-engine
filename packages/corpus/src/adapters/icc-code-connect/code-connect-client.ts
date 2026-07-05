/**
 * ICC Code Connect API client — Layer 1 model-code base (ADR-019).
 *
 * Code Connect is ICC's commercial OAuth2 JSON API for the I-Codes. Per
 * ADR-019's 2026-05-21 material update, Layer 1 ingest is gated on Code
 * Connect access; this client is built ahead of credentials so that the
 * moment access lands the ingest is "populate the secret, run it."
 *
 * ── CONTRACT STATUS ──────────────────────────────────────────────────
 * Contract verified live 2026-07-05 against production with demo credentials.
 * All types and endpoints below reflect the real wire contract (see
 * CURSOR_TASK.md for sample payloads).
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
 *  Real wire contract (verified live 2026-07-05)
 * ──────────────────────────────────────────────────────────────────── */

/**
 * OAuth2 client-credentials token response (RFC 6749 §5.1).
 * Verified live 2026-07-05.
 */
export interface OAuthTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

/**
 * One published I-Code edition from GET /v1/books.
 * Verified live 2026-07-05.
 */
export interface CodeConnectBook {
  /** The shortCode is the bookId used everywhere (e.g. IBC2018P6). */
  shortCode: string;
  /** URI components */
  uri: {
    category: string;
    /** Year as a STRING, not a number */
    year: string;
    titleCode: string;
    printing: string;
  };
  /** Printing label (e.g. "Sixth Printing: November 2021") */
  printing: string;
  /** Full title (e.g. "2018 International Building Code 6th printing") */
  title: string;
  /** Access window */
  accessStartDate: string;
  accessEndDate: string;
}

/**
 * A chapter from GET /v1/book/{bookId}/chapters.
 * Verified live 2026-07-05.
 */
export interface CodeConnectChapter {
  /** Chapter ordinal (e.g. "3") */
  ordinal: string;
  /** Cleaned ordinal (same as ordinal in practice) */
  ordinalClean: string;
  /** Chapter title */
  title: string;
  /** Chapter ID (e.g. "IBC2018P6_Ch03") */
  id: string;
  /** Discriminator type */
  dtype: string;
}

/**
 * A section from GET /v1/book/{bookId}/chapter/{chapterId}/sections.
 * Verified live 2026-07-05.
 */
export interface CodeConnectSectionRef {
  /** Section ordinal (e.g. "301") */
  ordinal: string;
  /** Cleaned ordinal */
  ordinalClean: string;
  /** Section title */
  title: string;
  /** Section ID (e.g. "IBC2018P6_Ch03_Sec301") - used to fetch content */
  id: string;
  /** Discriminator type */
  dtype: string;
}

/**
 * Recursive content node from GET /v1/content/{xmlId}.
 * Verified live 2026-07-05. Sections have inline subsections as children,
 * each with their own HTML content.
 */
export interface CodeConnectContentNode {
  /** Node type (e.g. "codeSection") */
  type: string;
  /** Label (e.g. "SECTION"); may be absent on live nodes */
  label?: string;
  /** Title text; may be absent on live nodes */
  title?: string;
  /** XML ID */
  xmlId: string;
  /**
   * HTML content for this node. Optional: live corpus nodes (verified
   * against the full IBC2018P6 pull 2026-07-05) may omit the field.
   */
  content?: string;
  /** Section ordinal (e.g. "301" or "301.1"); may be absent on live nodes */
  ordinal?: string;
  /** Cleaned ordinal; may be absent on live nodes */
  ordinalClean?: string;
  /** Child subsections (recursive, same shape); absent on live leaf nodes */
  children?: ReadonlyArray<CodeConnectContentNode>;
}

/**
 * Search result from GET /v2/search?bookId={bookId}&search={q}.
 * Verified live 2026-07-05. Optional for this task.
 */
export interface CodeConnectSearchResult {
  xmlId: string;
  ordinal: string;
  title: string;
  content: string;
  type: string;
  label: string;
  figure: string;
  /** Search highlights embedded in content/title */
  highlighted?: {
    contentTitle?: string[];
    content?: string[];
  };
}

/**
 * A whole I-Code edition assembled from a book + chapters + sections.
 * This is what the adapter's `fetch()` serializes into the `RawCode`
 * body so `normalize()` is a pure JSON walk.
 */
export interface IccCodeDocument {
  book: CodeConnectBook;
  chapters: ReadonlyArray<{
    bookId: string;
    chapters: ReadonlyArray<CodeConnectChapter>;
    /** Map of section ID to content tree */
    sections: Record<string, CodeConnectContentNode>;
  }>;
}

/* ──────────────────────────────────────────────────────────────────────
 *  Defaults + errors
 * ──────────────────────────────────────────────────────────────────── */

/**
 * Token endpoint. Verified live 2026-07-05.
 * Override via `tokenUrl` / `ICC_CODE_CONNECT_TOKEN_URL`.
 */
export const DEFAULT_CODE_CONNECT_TOKEN_URL =
  "https://api.iccsafe.org/auth/token";

/**
 * API base. Verified live 2026-07-05.
 * Override via `baseUrl` / `ICC_CODE_CONNECT_BASE_URL`.
 */
export const DEFAULT_CODE_CONNECT_BASE_URL = "https://api.iccsafe.org";

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
 * Fixture set for mock mode. Built by hand from the real response
 * models (verified live 2026-07-05) and checked into `__fixtures__/`.
 * The conformance suite and unit tests run entirely against these —
 * no network, no OAuth.
 * IMPORTANT: Fixture content must be synthetic placeholder text, NEVER
 * real ICC code text (licensing/derivative boundary).
 */
export interface CodeConnectFixtures {
  books: ReadonlyArray<CodeConnectBook>;
  /** Assembled documents keyed by `bookId` (shortCode). */
  documents: Record<string, IccCodeDocument>;
  /** Search results keyed by lower-cased query string. */
  search?: Record<string, ReadonlyArray<CodeConnectSearchResult>>;
}

export interface CodeConnectClientOptions {
  /** OAuth2 client-credentials. Omit (or leave env empty) for mock mode. */
  credentials?: { clientId: string; clientSecret: string; tokenUrl?: string; baseUrl?: string };
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
 * Resolve Code Connect credentials and URLs from the environment.
 * Returns `undefined` when either secret is empty — the pre-credential
 * state — so the adapter stays in mock / unconfigured mode.
 */
export function codeConnectCredentialsFromEnv(
  env: Record<string, string | undefined> = process.env,
): { clientId: string; clientSecret: string; tokenUrl?: string; baseUrl?: string } | undefined {
  const clientId = env.ICC_CODE_CONNECT_CLIENT_ID?.trim();
  const clientSecret = env.ICC_CODE_CONNECT_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return undefined;
  const tokenUrl = env.ICC_CODE_CONNECT_TOKEN_URL?.trim();
  const baseUrl = env.ICC_CODE_CONNECT_BASE_URL?.trim();
  return { clientId, clientSecret, tokenUrl, baseUrl };
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
    this.credentials = opts.credentials
      ? { clientId: opts.credentials.clientId, clientSecret: opts.credentials.clientSecret }
      : undefined;
    this.fixtures = opts.fixtures;
    this.tokenUrl =
      opts.tokenUrl ??
      opts.credentials?.tokenUrl ??
      DEFAULT_CODE_CONNECT_TOKEN_URL;
    this.baseUrl = (
      opts.baseUrl ??
      opts.credentials?.baseUrl ??
      DEFAULT_CODE_CONNECT_BASE_URL
    ).replace(/\/$/, "");
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
   * Verified live 2026-07-05: credentials in form body (not Basic auth),
   * with grant_type=client_credentials and scope=content-read.
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
      scope: "content-read",
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
   * GET /v1/books → { collections: [...] }
   * Verified live 2026-07-05.
   */
  async listBooks(): Promise<ReadonlyArray<CodeConnectBook>> {
    if (this.mode === "unconfigured") return [];
    if (this.mode === "mock") return this.fixtures!.books;
    const response = await this.getJson<{ collections: CodeConnectBook[] }>(
      "/v1/books",
    );
    return response.collections;
  }

  /**
   * List the chapters of one edition.
   * GET /v1/book/{bookId}/chapters → { bookId, chapters: [...] }
   * Verified live 2026-07-05.
   */
  async getChapters(
    bookId: string,
  ): Promise<{ bookId: string; chapters: ReadonlyArray<CodeConnectChapter> }> {
    if (this.mode === "unconfigured") return { bookId, chapters: [] };
    if (this.mode === "mock") {
      const doc = this.fixtures!.documents[bookId];
      if (!doc || doc.chapters.length === 0) return { bookId, chapters: [] };
      return { bookId, chapters: doc.chapters[0]!.chapters };
    }
    return await this.getJson<{ bookId: string; chapters: CodeConnectChapter[] }>(
      `/v1/book/${encodeURIComponent(bookId)}/chapters`,
    );
  }

  /**
   * List the sections of one chapter.
   * GET /v1/book/{bookId}/chapter/{chapterId}/sections → { bookId, chapterId, sections: [...] }
   * Verified live 2026-07-05.
   */
  async getSections(
    bookId: string,
    chapterId: string,
  ): Promise<ReadonlyArray<CodeConnectSectionRef>> {
    if (this.mode === "unconfigured") return [];
    if (this.mode === "mock") {
      const doc = this.fixtures!.documents[bookId];
      if (!doc) return [];
      // Mock fixture returns sections from the document structure
      // For simplicity in tests, we return empty here and rely on getContent
      return [];
    }
    const response = await this.getJson<{ bookId: string; chapterId: string; sections: CodeConnectSectionRef[] }>(
      `/v1/book/${encodeURIComponent(bookId)}/chapter/${encodeURIComponent(chapterId)}/sections`,
    );
    return response.sections;
  }

  /**
   * Fetch recursive content tree for a section.
   * GET /v1/content/{xmlId} → { type, label, title, xmlId, content, ordinal, ordinalClean, children }
   * Verified live 2026-07-05. A section's subsections are inline children with their own html content.
   */
  async getContent(xmlId: string): Promise<CodeConnectContentNode | null> {
    if (this.mode === "unconfigured") return null;
    if (this.mode === "mock") {
      // Mock mode: extract from fixtures documents
      for (const doc of Object.values(this.fixtures!.documents)) {
        for (const chapter of doc.chapters) {
          const content = chapter.sections[xmlId];
          if (content) return content;
        }
      }
      return null;
    }
    return await this.getJson<CodeConnectContentNode>(
      `/v1/content/${encodeURIComponent(xmlId)}`,
    );
  }

  /**
   * Search across titles.
   * GET /v2/search?bookId={bookId}&search={q}
   * Verified live 2026-07-05. Optional for this task.
   */
  async search(
    query: string,
    bookId?: string,
  ): Promise<ReadonlyArray<CodeConnectSearchResult>> {
    if (this.mode === "unconfigured") return [];
    if (this.mode === "mock") {
      return this.fixtures!.search?.[query.toLowerCase()] ?? [];
    }
    const params: Record<string, string> = { search: query };
    if (bookId) params.bookId = bookId;
    const response = await this.getJson<{ success: boolean; data: CodeConnectSearchResult[] }>(
      "/v2/search",
      params,
    );
    return response.data;
  }

  /**
   * Assemble a whole edition: book + chapters + section content trees.
   * Mock mode returns the fixture document directly; live mode walks
   * chapters and fetches top-level sections via /v1/content/{xmlId}.
   */
  async fetchCodeDocument(bookId: string): Promise<IccCodeDocument | null> {
    if (this.mode === "unconfigured") return null;
    if (this.mode === "mock") {
      return this.fixtures!.documents[bookId] ?? null;
    }
    const books = await this.listBooks();
    const book = books.find((b) => b.shortCode === bookId);
    if (!book) return null;
    const chaptersResponse = await this.getChapters(bookId);
    const chapters: Array<{
      bookId: string;
      chapters: CodeConnectChapter[];
      sections: Record<string, CodeConnectContentNode>;
    }> = [];
    
    // Fetch top-level sections for each chapter
    for (const chapter of chaptersResponse.chapters) {
      const sectionsResponse = await this.getSections(bookId, chapter.id);
      const sections: Record<string, CodeConnectContentNode> = {};
      for (const sectionRef of sectionsResponse) {
        const content = await this.getContent(sectionRef.id);
        if (content) sections[sectionRef.id] = content;
      }
      chapters.push({
        bookId: chaptersResponse.bookId,
        chapters: [chapter],
        sections,
      });
    }
    return { book, chapters };
  }
}
