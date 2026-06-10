import type { CalibrationStamp } from "./types";

export function stampsMatch(
  current: CalibrationStamp,
  stored: CalibrationStamp,
): boolean {
  return (
    current.codeRef === stored.codeRef &&
    current.edition === stored.edition &&
    current.sourceSetVersion === stored.sourceSetVersion
  );
}

export function stampFromFields(args: {
  codeRef: string | null;
  edition: string | null;
  sourceSetVersion: number;
}): CalibrationStamp {
  return {
    codeRef: args.codeRef ?? "",
    edition: args.edition ?? "",
    sourceSetVersion: args.sourceSetVersion,
  };
}
