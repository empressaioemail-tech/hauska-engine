import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { isRoadNodeAtomInstance, roadNodeIdFromParts } from "@hauska-engine/atoms";

import { classifyOsmHighwayTag } from "../classify.js";
import { buildRowEdgesFromCenterline } from "../geometry.js";
import {
  bastropRoadIntakeDescriptor,
  emitRoadNode,
  parseOsmWayElement,
} from "../emit-road-node.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PILOT = JSON.parse(
  readFileSync(join(HERE, "../fixtures/bastrop-road-pilot.json"), "utf8"),
);

describe("road-intake — classify (R1)", () => {
  it("maps OSM residential to residential class", () => {
    expect(classifyOsmHighwayTag("residential")).toBe("residential");
  });

  it("maps primary to highway", () => {
    expect(classifyOsmHighwayTag("primary")).toBe("highway");
  });
});

describe("road-intake — geometry (R1)", () => {
  it("builds left/right ROW edges from centerline", () => {
    const centerline = [
      [-97.3188, 30.1102],
      [-97.3182, 30.1105],
    ] as const;
    const { leftEdge, rightEdge } = buildRowEdgesFromCenterline(centerline, 50);
    expect(leftEdge.coordinates).toHaveLength(2);
    expect(rightEdge.coordinates).toHaveLength(2);
    expect(leftEdge.coordinates[0]).not.toEqual(rightEdge.coordinates[0]);
  });
});

describe("road-intake — emit Bastrop Spring Street (WDLL 3)", () => {
  it("emits named road node 48021:road:123456789 with approximate ROW provenance", () => {
    const descriptor = bastropRoadIntakeDescriptor();
    const element = PILOT.elements[0];
    const obs = parseOsmWayElement(element, "2026-07-25T12:00:00.000Z");
    expect(obs).not.toBeNull();
    const atom = emitRoadNode(descriptor, obs!);
    expect(atom.roadNodeId).toBe(roadNodeIdFromParts("48021", 123456789));
    expect(atom.displayName).toBe("Spring Street");
    expect(atom.row.provenance.kind).toBe("approximate-assumed-per-class");
    expect(atom.attachPoints.length).toBeGreaterThan(0);
    expect(isRoadNodeAtomInstance(atom)).toBe(true);
    expect(atom.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });
});
