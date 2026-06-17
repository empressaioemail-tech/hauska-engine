declare module "d3-contour" {
  export interface ContourMultiPolygon {
    type: "MultiPolygon";
    value: number;
    coordinates: number[][][][];
  }

  export interface ContoursGenerator {
    size(size: [number, number]): ContoursGenerator;
    thresholds(thresholds: number[]): ContoursGenerator;
    (values: number[]): ContourMultiPolygon[];
  }

  export function contours(): ContoursGenerator;
}
