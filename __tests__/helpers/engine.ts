import type { LookaheadInputs } from "../../src/engine/lookahead";
import type { WaterLevel } from "../../src/model/uncertainty";
import type { DynamicsOptions, VesselModel } from "../../src/model/vessel";
import { DEFAULT_DYNAMICS } from "../../src/model/vessel";

/** No water-level source: chart datum with σ 0.3 m (plan §4.5). */
export const CHART_DATUM: WaterLevel = { h: 0, sigma: 0.3, source: "chart-datum" };

export function ctx(
  vessel: VesselModel | undefined,
  waterLevel: WaterLevel = CHART_DATUM,
  dynamics: Partial<DynamicsOptions> = {}
): LookaheadInputs {
  return { vessel, waterLevel, dynamics: { ...DEFAULT_DYNAMICS, ...dynamics } };
}
