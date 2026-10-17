import type { CellInfo } from "../ingest/cells";
import type { Ukc, VesselTerms, WaterLevel } from "../model/uncertainty";
import { ukcAt } from "../model/uncertainty";

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
  /** Mean UKC, metres; null on land. */
  mean: number | null;
  sigma: number;
  /** P(UKC < 0). */
  risk: number;
}

const r2 = (v: number): number => Math.round(v * 100) / 100;
const finite = (v: number): number | null => (Number.isFinite(v) ? r2(v) : null);

export function explain(
  tile: { dMin: number; sigmaD: number },
  extras: {
    flags: string[];
    cell?: Explanation["cell"];
    hazard?: { class: string; lnam?: string; depth: number };
  },
  v: VesselTerms,
  wl: WaterLevel
): Explanation {
  const u: Ukc = ukcAt(tile.dMin, tile.sigmaD, v, wl);
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
    mean: finite(u.mean),
    sigma: r2(u.sigma),
    risk: Math.round(u.risk * 10000) / 10000
  };
}

const m = (v: number): string => `${v.toFixed(2).replace(/\.?0+$/, "") || "0"} m`;
const signed = (v: number): string => (v < 0 ? `− ${m(-v)}` : `+ ${m(v)}`);

/**
 * "charted 2.4 m (±1.06 m, SWEPT) + water level − 0.31 m (fmi) − draft 1.9 m
 *  − squat 0.08 m − heel 0 m − wave 0.15 m → μ = −0.04 m, σ = 0.58 m, P = 53 %"
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
  const mean = e.mean === null ? "−∞ m" : m(e.mean).replace(/^-/, "−");
  const pct =
    e.risk >= 0.995 ? "> 99" : e.risk < 0.005 && e.risk > 0 ? "< 1" : (e.risk * 100).toFixed(0);
  return `${terms.join(" ")} → μ = ${mean}, σ = ${m(e.sigma)}, P = ${pct} %`;
}
