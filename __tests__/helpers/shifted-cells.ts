import fs from "fs";
import path from "path";
import { FIXTURES } from "./fixture-index";

type Coords = number[] | Coords[];

function shift(c: Coords, dLon: number, dLat: number): Coords {
  if (typeof c[0] === "number") {
    const [lon, lat, ...rest] = c as number[];
    return [(lon as number) + dLon, (lat as number) + dLat, ...rest];
  }
  return (c as Coords[]).map((x) => shift(x, dLon, dLat)) as Coords;
}

/**
 * Copies a fixture cell into `dir`, every coordinate moved by (dLon, dLat)
 * degrees and the DSID renamed to `name`, so several copies index as
 * separate cells spread over many index roots.
 */
export function shiftedCell(
  fixture: string,
  dir: string,
  name: string,
  dLon: number,
  dLat: number
): string {
  const out = path.join(dir, name);
  fs.mkdirSync(out, { recursive: true });
  for (const file of fs.readdirSync(path.join(FIXTURES, fixture))) {
    const fc = JSON.parse(fs.readFileSync(path.join(FIXTURES, fixture, file), "utf8")) as {
      features: { geometry: { coordinates: Coords } | null; properties: Record<string, unknown> }[];
    };
    for (const f of fc.features) {
      if (f.geometry) {
        f.geometry.coordinates = shift(f.geometry.coordinates, dLon, dLat);
      }
      if (typeof f.properties.DSID_DSNM === "string") {
        f.properties.DSID_DSNM = `${name}.000`;
      }
    }
    fs.writeFileSync(path.join(out, file), JSON.stringify(fc));
  }
  return out;
}

/** Copies of both fixture cells across several z10 roots, some straddling a root's edge. */
export function spreadCells(dir: string): string[] {
  const shifts: [number, number][] = [
    [0, 0],
    // 22.15° E is a z10 column edge: this copy lies across it.
    [0.12, 0.02],
    // 60.065° N is a z10 row edge: this copy lies across it, in the first copy's column.
    [0.005, 0.05],
    [0.36, 0],
    [0.71, -0.03],
    [1.06, 0.01]
  ];
  return shifts.flatMap(([dLon, dLat], k) => [
    shiftedCell("FI5SYNTH", dir, `FI5SH${k}`, dLon, dLat),
    shiftedCell("FI4SYNTH", dir, `FI4SH${k}`, dLon, dLat)
  ]);
}
