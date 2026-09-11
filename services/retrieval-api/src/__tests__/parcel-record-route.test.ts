import { describe, expect, it } from "vitest";

import { InMemoryStorage, buildHaysZoningFactProof } from "@hauska-engine/storage";

import { buildApp } from "../server.js";
import { memoryFactoryStore } from "../parcel-record-db.js";
import { readParcelRecord } from "../parcel-record-reader.js";

/**
 * Non-vacuity + refusal tests required by the P-152 dispatch step 6.
 * Cell/gate-verdict fixtures for 48021:34049 (cityLimits) are captured
 * verbatim from a live, read-only query against FACTORY_DATABASE_URL_RO
 * (hauska-prod-497015) on 2026-09-11, timestamps included — never
 * hand-invented.
 */

const CITY_LIMITS_CELL_2026_09_11 = {
  kind: "value",
  value: "Bastrop",
  source: "landing_parcel_jurisdiction",
  vintage: "2026-09-02T18:13:56.751Z",
};

const CITY_LIMITS_VERDICT_2026_09_11 = {
  countyFips: "48021",
  railKey: "cityLimits",
  verdict: "pass" as const,
  evaluatedAt: "2026-09-11T20:03:09.067Z",
};

describe("GET /property-nodes/:parcelNodeId/record (P-152)", () => {
  it("serves 'record' with the real cell value for a slated, passing (county, rail) pair", async () => {
    const factoryStore = memoryFactoryStore({
      places: ["48021:34049"],
      cells: [
        { placeKey: "48021:34049", railKey: "cityLimits", cellState: CITY_LIMITS_CELL_2026_09_11 },
      ],
      verdicts: [CITY_LIMITS_VERDICT_2026_09_11],
    });
    const app = buildApp({ storage: new InMemoryStorage(), apiKey: "", factoryStore });

    const res = await app.request("/property-nodes/48021:34049/record");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      parcelNodeId: string;
      placeKey: string;
      countyFips: string;
      railRegistrySha: string;
      refused: unknown;
      rails: Record<string, { cell: unknown; serve: string; gate: unknown; atomBacked: boolean }>;
    };
    expect(body.parcelNodeId).toBe("48021:34049");
    expect(body.placeKey).toBe("48021:34049");
    expect(body.countyFips).toBe("48021");
    expect(body.refused).toBeNull();
    expect(typeof body.railRegistrySha).toBe("string");
    expect(body.railRegistrySha.length).toBeGreaterThan(0);

    const cityLimits = body.rails.cityLimits!;
    expect(cityLimits.serve).toBe("record");
    expect(cityLimits.cell).toEqual(CITY_LIMITS_CELL_2026_09_11);
    expect(cityLimits.gate).toEqual({ verdict: "pass", evaluatedAt: "2026-09-11T20:03:09.067Z" });
    expect(cityLimits.atomBacked).toBe(false);

    // A rail with no real slate entry (e.g. 'pipelines') declares legacy-transitional, not record.
    expect(body.rails.pipelines!.serve).toBe("legacy-transitional");
    // Every one of the closed 65 rails is present in the response.
    expect(Object.keys(body.rails)).toHaveLength(65);
  });

  it("declares a refusal, never an empty rails map, when the factory store is not configured", async () => {
    const app = buildApp({ storage: new InMemoryStorage(), apiKey: "", factoryStore: null });
    const res = await app.request("/property-nodes/48021:34049/record");
    expect(res.status).toBe(503);
    const body = (await res.json()) as { errorClass: string; rails?: unknown };
    expect(body.errorClass).toBe("store-not-configured");
    expect(body.rails).toBeUndefined();
  });

  it("declares a refusal, never an empty rails map, when the factory store read fails", async () => {
    const factoryStore = memoryFactoryStore({ failReads: true });
    const app = buildApp({ storage: new InMemoryStorage(), apiKey: "", factoryStore });
    const res = await app.request("/property-nodes/48021:34049/record");
    expect(res.status).toBe(503);
    const body = (await res.json()) as { errorClass: string; rails?: unknown };
    expect(body.errorClass).toBe("read-failed");
    expect(body.rails).toBeUndefined();
  });

  it("refuses a crosswalk-ambiguous parcel: raw and normalized place_key forms both exist", async () => {
    // 48021:007595 (raw, zero-padded) and 48021:7595 (normalized) both real
    // parcel_record rows -- P-161 has not landed a rule to pick one.
    const factoryStore = memoryFactoryStore({
      places: ["48021:7595", "48021:007595"],
    });
    const app = buildApp({ storage: new InMemoryStorage(), apiKey: "", factoryStore });
    const res = await app.request("/property-nodes/48021:7595/record");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      placeKey: string | null;
      refused: { reason: string } | null;
      rails: Record<string, unknown>;
    };
    expect(body.placeKey).toBeNull();
    expect(body.refused).not.toBeNull();
    expect(body.refused!.reason).toContain("crosswalk ambiguous");
    expect(body.rails).toEqual({});
  });

  it("dereferences an atom under 'atom' when a cell carries an atomDid, atomBacked flips true", async () => {
    const storage = new InMemoryStorage();
    await storage.writePropertyAtom(buildHaysZoningFactProof());

    const factoryStore = memoryFactoryStore({
      places: ["48021:34049"],
      cells: [
        {
          placeKey: "48021:34049",
          railKey: "zoningDistrict",
          cellState: {
            kind: "value",
            value: "RS",
            source: "parcel-record-engine",
            vintage: "2026-09-11T00:00:00.000Z",
            // Forward-looking fixture: no live cell carries this field yet
            // (P-163 has not landed the pointer column). Proves the
            // dereference path works ahead of real data, per dispatch step 3.
            atomDid: "did:hauska:zoning-fact:48209:156346",
          },
        },
      ],
    });
    const app = buildApp({ storage, apiKey: "", factoryStore });

    const res = await app.request("/property-nodes/48021:34049/record");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rails: Record<string, { atom: { did: string; entityType: string } | null; atomBacked: boolean }>;
    };
    const zoning = body.rails.zoningDistrict!;
    expect(zoning.atomBacked).toBe(true);
    expect(zoning.atom).not.toBeNull();
    expect(zoning.atom!.entityType).toBe("zoning-fact");
  });

  it("rejects an invalid parcelNodeId with 400 before touching the store", async () => {
    const app = buildApp({
      storage: new InMemoryStorage(),
      apiKey: "",
      factoryStore: memoryFactoryStore({ failReads: true }),
    });
    const res = await app.request("/property-nodes/not-a-valid-id/record");
    expect(res.status).toBe(400);
  });
});

describe("GET /parcel-record-gate-verdict/:countyFips/:railKey (P-152 lane 2 support)", () => {
  it("serves the same verdict the /record route computes per rail, with no parcel in scope", async () => {
    const factoryStore = memoryFactoryStore({ verdicts: [CITY_LIMITS_VERDICT_2026_09_11] });
    const app = buildApp({ storage: new InMemoryStorage(), apiKey: "", factoryStore });
    const res = await app.request("/parcel-record-gate-verdict/48021/cityLimits");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { verdict: { verdict: string; evaluatedAt: string } | null };
    expect(body.verdict).toEqual({ verdict: "pass", evaluatedAt: "2026-09-11T20:03:09.067Z" });
  });

  it("returns verdict: null for a rail with no evaluated verdict, never a fabricated one", async () => {
    const factoryStore = memoryFactoryStore({});
    const app = buildApp({ storage: new InMemoryStorage(), apiKey: "", factoryStore });
    const res = await app.request("/parcel-record-gate-verdict/48021/pipelines");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { verdict: unknown };
    expect(body.verdict).toBeNull();
  });

  it("declares a 503 refusal when the factory store is not configured", async () => {
    const app = buildApp({ storage: new InMemoryStorage(), apiKey: "", factoryStore: null });
    const res = await app.request("/parcel-record-gate-verdict/48021/cityLimits");
    expect(res.status).toBe(503);
  });

  it("rejects a malformed county fips with 400", async () => {
    const app = buildApp({
      storage: new InMemoryStorage(),
      apiKey: "",
      factoryStore: memoryFactoryStore({}),
    });
    const res = await app.request("/parcel-record-gate-verdict/notacounty/cityLimits");
    expect(res.status).toBe(400);
  });
});

describe("readParcelRecord (unit)", () => {
  it("resolves a leading-zero raw place_key when only the padded form exists (no ambiguity)", async () => {
    const factoryStore = memoryFactoryStore({
      places: ["48021:007595"],
      cells: [
        {
          placeKey: "48021:007595",
          railKey: "cityLimits",
          cellState: { kind: "value", value: "Bastrop", source: "x", vintage: "2026-01-01T00:00:00Z" },
        },
      ],
    });
    const result = await readParcelRecord(
      factoryStore,
      { async getAtom() { return { atom: null }; } },
      "48021:7595",
      "48021",
      "7595",
    );
    expect(result.refused).toBeNull();
    expect(result.placeKey).toBe("48021:007595");
    expect(result.rails.cityLimits!.cell).toEqual({
      kind: "value",
      value: "Bastrop",
      source: "x",
      vintage: "2026-01-01T00:00:00Z",
    });
  });

  it("returns null cell (never a fabricated kind) when no parcel_record_cell row exists for a rail", async () => {
    const factoryStore = memoryFactoryStore({ places: ["48021:34049"] });
    const result = await readParcelRecord(
      factoryStore,
      { async getAtom() { return { atom: null }; } },
      "48021:34049",
      "48021",
      "34049",
    );
    expect(result.rails.cityLimits!.cell).toBeNull();
  });
});
