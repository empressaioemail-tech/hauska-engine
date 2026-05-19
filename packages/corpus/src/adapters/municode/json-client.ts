/**
 * Municode JSON API client.
 *
 * Walks the same endpoint chain the legacy bastrop_municode adapter
 * uses; ported into hauska-engine so the Stream 1A MunicodeHtmlAdapter
 * can drill into real Bastrop UDC content rather than just fetching the
 * TOC landing page.
 *
 * Endpoint chain (verified Apr 2026, per legacy MUNICODE_API_NOTES.md):
 *
 *   GET /Clients/name?clientName=...&stateAbbr=..    -> ClientID, ClientName
 *   GET /ClientContent/{clientId}                    -> { codes: [{ productId, ... }] }
 *   GET /Jobs/latest/{productId}                     -> { Id, Name, ProductId }
 *   GET /codesToc/children?jobId=&productId=         -> top-level TOC
 *   GET /codesToc/children?jobId=&productId=&nodeId= -> children of a node
 *   GET /CodesContent?jobId=&productId=&nodeId=      -> { Docs: [{ Id, Title, Content, ... }] }
 *
 * Politeness: this client uses the package's `RespectfulFetch` for
 * per-host throttling. Default 1.5s spacing per the legacy budget.
 */

import { RespectfulFetch } from "../http.js";

export const MUNICODE_API_BASE = "https://api.municode.com";
export const MUNICODE_LIBRARY_BASE = "https://library.municode.com";

export interface MunicodeClientInfo {
  ClientID: number;
  ClientName: string;
  City?: string;
  ZipCode?: number | string;
  Website?: string;
}

export interface MunicodeCodeProduct {
  productName: string;
  productId: number;
  publicationId?: number;
  latestUpdatedDate?: string;
}

export interface MunicodeJob {
  Id: number;
  Name: string;
  ProductId: number;
}

export interface MunicodeTocNode {
  Id: string;
  Heading: string;
  ParentId: string;
  NodeDepth: number;
  HasChildren: boolean;
  DocOrderId: number;
}

export interface MunicodeDoc {
  Id: string;
  Title: string;
  Content: string | null;
  NodeDepth: number;
  DocOrderId: number;
  TitleHtml: string | null;
  IsAmended: boolean;
  IsUpdated: boolean;
}

export interface MunicodeContentEnvelope {
  Docs: MunicodeDoc[];
  PdfUrl: string | null;
  ShowToc: boolean;
}

export class MunicodeJsonError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: string,
  ) {
    super(message);
    this.name = "MunicodeJsonError";
  }
}

export interface MunicodeJsonClientOptions {
  http?: RespectfulFetch;
  baseUrl?: string;
}

export class MunicodeJsonClient {
  private readonly http: RespectfulFetch;
  private readonly baseUrl: string;

  constructor(opts: MunicodeJsonClientOptions = {}) {
    this.http =
      opts.http ??
      new RespectfulFetch({
        // 1.5s spacing matches the legacy adapter's default; well under
        // Municode's documented thresholds.
        maxRequestsPerSecondPerHost: 0.7,
        userAgent: "Hauska-CodeAtoms/0.1 (+nick@hauska.io) hauska-engine",
      });
    this.baseUrl = opts.baseUrl ?? MUNICODE_API_BASE;
  }

  private buildUrl(
    path: string,
    params: Record<string, string | number | undefined>,
  ): string {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      url.searchParams.set(k, String(v));
    }
    return url.toString();
  }

  private async getJson<T>(path: string, params: Record<string, string | number | undefined>): Promise<T | null> {
    const url = this.buildUrl(path, params);
    const res = await this.http.fetch(url, { headers: { Accept: "application/json" } });
    if (res.status === 204) return null;
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new MunicodeJsonError(
        `Municode ${path} -> HTTP ${res.status}`,
        res.status,
        body.slice(0, 500),
      );
    }
    return (await res.json()) as T;
  }

  async getClientByName(clientName: string, stateAbbr: string): Promise<MunicodeClientInfo | null> {
    return await this.getJson<MunicodeClientInfo>("/Clients/name", { clientName, stateAbbr });
  }

  async getClientContent(clientId: number): Promise<{ codes: MunicodeCodeProduct[] } | null> {
    return await this.getJson<{ codes: MunicodeCodeProduct[] }>(`/ClientContent/${clientId}`, {});
  }

  async getLatestJob(productId: number): Promise<MunicodeJob | null> {
    return await this.getJson<MunicodeJob>(`/Jobs/latest/${productId}`, {});
  }

  async getTocChildren(
    jobId: number,
    productId: number,
    nodeId?: string,
  ): Promise<MunicodeTocNode[]> {
    const params: Record<string, string | number> = { jobId, productId };
    if (nodeId) params.nodeId = nodeId;
    const data = await this.getJson<MunicodeTocNode[]>("/codesToc/children", params);
    return Array.isArray(data) ? data : [];
  }

  async getCodesContent(
    jobId: number,
    productId: number,
    nodeId: string,
  ): Promise<MunicodeContentEnvelope | null> {
    return await this.getJson<MunicodeContentEnvelope>("/CodesContent", {
      jobId,
      productId,
      nodeId,
    });
  }
}

/**
 * Build the canonical library.municode.com URL for one section.
 */
export function municodeLibraryUrl(
  stateAbbr: string,
  librarySlug: string,
  nodeId?: string,
): string {
  const base = `${MUNICODE_LIBRARY_BASE}/${stateAbbr.toLowerCase()}/${librarySlug}/codes/code_of_ordinances`;
  if (!nodeId) return base;
  return `${base}?nodeId=${encodeURIComponent(nodeId)}`;
}
