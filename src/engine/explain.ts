import type { LonLat } from "../foundation/geo";
import { geomBounds } from "../foundation/geometry";
import type { CellInfo } from "../ingest/cells";
import type { Ukc, VesselTerms, WaterLevel } from "../model/uncertainty";
import { ukcAt } from "../model/uncertainty";
import type { ChartIndex } from "../spatial/chart-index";
import { flagNames } from "../spatial/node-store";
import type { ChartReach, RiskTile } from "../spatial/pyramid";
import { footprintGeom, mercatorBuffer } from "../spatial/pyramid";
import { DEFAULT_BUILD } from "../spatial/pyramid-build";

/**
 * Explanation object (plan §4.7): every term behind a UKC estimate, so a
 * client can render the breakdown sentence and see which term dominates.
 */

export interface Explanation {
  /** Charted depth of the deciding tile, metres; null for land. */
  charted: number | null;
  sigmaCharted: number;
  flags: string[];
  cell?: Pick<CellInfo, "name" | "edition" | "update">;
  hazard?: { class: string; lnam?: string; depth: number | null };
  waterLevel: number;
  sigmaWaterLevel: number;
  waterLevelSource: string;
  draft: number;
  heel: number;
  squat: number;
  wave: number;
  margin: number;
  /**
   * Set when the deciding tile lies beyond the footprint and its buffer:
   * how far, how well the chart places it, and the chance it lies under
   * the keel. `charted`, `mean` and `sigma` are then the tile's own.
   */
  chartPosition?: {
    distance: number;
    sigmaP: number;
    weight: number;
    source: ChartReach["source"];
  };
  /** Mean UKC, metres; null on land. */
  mean: number | null;
  sigma: number;
  /** P(UKC < 0), times `chartPosition.weight` when set. */
  risk: number;
}

const r2 = (v: number): number => Math.round(v * 100) / 100;
const finite = (v: number): number | null => (Number.isFinite(v) ? r2(v) : null);

export function explain(
  tile: { dMin: number; sigmaD: number; chart?: ChartReach },
  extras: {
    flags: string[];
    cell?: Explanation["cell"];
    hazard?: { class: string; lnam?: string; depth: number };
  },
  v: VesselTerms,
  wl: WaterLevel
): Explanation {
  const u: Ukc = ukcAt(tile.dMin, tile.sigmaD, v, wl);
  const c = tile.chart;
  return {
    charted: finite(tile.dMin),
    sigmaCharted: r2(tile.sigmaD),
    flags: extras.flags,
    cell: extras.cell,
    hazard: extras.hazard && { ...extras.hazard, depth: finite(extras.hazard.depth) },
    waterLevel: r2(wl.h),
    sigmaWaterLevel: r2(wl.sigma),
    waterLevelSource: wl.source,
    draft: r2(v.draft.value),
    heel: r2(v.heel.value),
    squat: r2(v.squat.value),
    wave: r2(v.wave.value),
    margin: r2(v.margin),
    ...(c && {
      chartPosition: {
        distance: Math.round(c.distance),
        sigmaP: r2(c.sigmaP),
        weight: Math.round(c.weight * 10000) / 10000,
        source: c.source
      }
    }),
    mean: finite(u.mean),
    sigma: r2(u.sigma),
    risk: Math.round(u.risk * (c?.weight ?? 1) * 10000) / 10000
  };
}

export interface NamedHazard {
  class: string;
  lnam?: string;
  valsou: number | null;
}

/** The named hazard whose depth is the deciding tile's depth: the one that set it. */
function hazardIn(
  index: ChartIndex,
  ring: LonLat[],
  depth: number,
  bufferMetres: number
): NamedHazard | undefined {
  const geom = footprintGeom(ring);
  const hit = index.hazards
    .near(geom, mercatorBuffer(geomBounds(geom), bufferMetres))
    .find((h) => h.feature.depth === depth);
  return (
    hit && {
      class: hit.feature.objectClass,
      lnam: hit.feature.lnam,
      valsou: finite(hit.feature.depth)
    }
  );
}

/**
 * Ground metres from a footprint within which the hazard that set
 * `tile` lies: the buffer, the tile's distance past it and its extent when
 * it counted by its chart position, and a point's burn radius (k·σP, at most
 * the tile's widest σP).
 */
export function namingReach(
  tile: Pick<RiskTile, "sigmaP" | "chart">,
  bufferMetres: number
): number {
  const beyond = tile.chart ? tile.chart.distance + tile.chart.extent : 0;
  return bufferMetres + beyond + DEFAULT_BUILD.k * tile.sigmaP;
}

/**
 * The explanation of the deciding tile under `ring`, queried with
 * `bufferMetres` and chart position, with its cell and hazard.
 */
export function explainTile(
  index: ChartIndex,
  tile: RiskTile,
  ring: LonLat[],
  terms: VesselTerms,
  wl: WaterLevel,
  bufferMetres = 0
): { hazard?: NamedHazard; explanation: Explanation } {
  const hazard = hazardIn(index, ring, tile.dMin, namingReach(tile, bufferMetres));
  const cell = index.catalogue.cells[tile.cellRef];
  const explanation = explain(
    tile,
    {
      flags: flagNames(tile.flags),
      cell: cell && { name: cell.name, edition: cell.edition, update: cell.update },
      hazard: hazard && {
        class: hazard.class,
        lnam: hazard.lnam,
        depth: hazard.valsou ?? -Infinity
      }
    },
    terms,
    wl
  );
  return { hazard, explanation };
}

const pct = (p: number): string =>
  p >= 0.995 ? "> 99" : p < 0.005 && p > 0 ? "< 1" : (p * 100).toFixed(0);

const m = (v: number): string => `${v.toFixed(2).replace(/\.?0+$/, "") || "0"} m`;
const signed = (v: number): string => (v < 0 ? `− ${m(-v)}` : `+ ${m(v)}`);

/**
 * "charted 2.4 m (±1.06 m, SWEPT) − 0.31 m water level (fmi) − draft 1.9 m
 *  − squat 0.08 m + heel 0 m − wave 0.15 m → μ = −0.04 m, σ = 0.58 m, P = 53 %"
 */
export function sentence(e: Explanation): string {
  const notes = [`±${m(e.sigmaCharted)}`, ...e.flags].join(", ");
  const hazard = e.hazard ? ` ${e.hazard.class}${e.hazard.lnam ? ` ${e.hazard.lnam}` : ""}` : "";
  const charted =
    e.charted === null ? `land${hazard}` : `charted ${m(e.charted)}${hazard} (${notes})`;
  const terms = [
    charted,
    `${signed(e.waterLevel)} water level (${e.waterLevelSource})`,
    `− draft ${m(e.draft)}`,
    `− squat ${m(e.squat)}`,
    `${e.heel > 0 ? "−" : "+"} heel ${m(Math.abs(e.heel))}`,
    `− wave ${m(e.wave)}`
  ];
  if (e.margin > 0) {
    terms.push(`− margin ${m(e.margin)}`);
  }
  const p = e.chartPosition;
  if (p) {
    const what = p.source === "topography" ? "shoreline" : "survey";
    terms[0] = `${terms[0]} ${m(p.distance)} away, placed ±${m(2 * p.sigmaP)} by its ${what} (${pct(p.weight)} % under the keel)`;
  }
  const mean = e.mean === null ? "−∞ m" : m(e.mean).replace(/^-/, "−");
  return `${terms.join(" ")} → μ = ${mean}, σ = ${m(e.sigma)}, P = ${pct(e.risk)} %`;
}
