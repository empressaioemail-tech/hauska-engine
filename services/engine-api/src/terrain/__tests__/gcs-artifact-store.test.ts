import { describe, expect, it, vi } from "vitest";

import { GcsTerrainArtifactStore } from "../gcs-artifact-store.js";

describe("GcsTerrainArtifactStore", () => {
  it("writes content-addressed refs and round-trips bytes via get", async () => {
    const objects = new Map<string, Buffer>();
    const storage = {
      bucket: (_name: string) => ({
        file: (path: string) => ({
          save: async (body: Buffer) => {
            objects.set(path, body);
          },
          download: async () => [objects.get(path) ?? Buffer.alloc(0)],
        }),
      }),
    };

    const store = new GcsTerrainArtifactStore({
      bucket: "hauska-test-terrain",
      storage: storage as never,
    });

    const bytes = new Uint8Array([1, 2, 3, 4]);
    const ref = await store.put({
      parcelNodeId: "parcel:123",
      format: "glb",
      bytes,
      contentType: "model/gltf-binary",
    });

    expect(ref).toMatch(/^gcs:\/\/hauska-test-terrain\/terrain\/parcel_123\/glb\/[a-f0-9]{64}$/);
    expect(objects.size).toBe(1);

    const roundTrip = await store.get(ref);
    expect(roundTrip).toEqual(bytes);
  });

  it("returns null for unknown ref schemes and missing objects", async () => {
    const storage = {
      bucket: (_name: string) => ({
        file: (_path: string) => ({
          save: vi.fn(),
          download: vi.fn(async () => {
            const err = new Error("not found") as Error & { code: number };
            err.code = 404;
            throw err;
          }),
        }),
      }),
    };

    const store = new GcsTerrainArtifactStore({
      bucket: "hauska-test-terrain",
      storage: storage as never,
    });

    expect(await store.get("memory://missing")).toBeNull();
    expect(await store.get("gcs://hauska-test-terrain/terrain/x/glb/deadbeef")).toBeNull();
  });
});
