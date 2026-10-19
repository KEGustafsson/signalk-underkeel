import type { Geom } from "../foundation/geometry";

/**
 * Chart features after ingest, in Web Mercator metres. Every source (S-57,
 * open data) is normalised to these roles before the index is built.
 */

/** S-57 CATZOC codes: 1 A1, 2 A2, 3 B, 4 C, 5 D, 6 U (unassessed). */
export type Catzoc = 1 | 2 | 3 | 4 | 5 | 6;

interface FeatureBase {
  /** S-57 object class acronym, e.g. "DEPARE", "UWTROC". */
  objectClass: string;
  geom: Geom;
  /** Index into the cell catalogue (`cells.json`). */
  cellRef: number;
  /** Usage band 1–6 of the source cell; larger bands are larger scale. */
  band: number;
  lnam?: string;
  /** From a source licensed for non-navigational use only (the Traficom WFS). */
  advisory?: boolean;
}

/** Anything that bounds the depth from above: areas, soundings, hazards, land. */
export interface DepthFeature extends FeatureBase {
  role: "depth";
  /** Conservative depth below chart datum in metres; -Infinity for land. */
  depth: number;
  /** Point/line hazards and soundings carry exact geometry for explanations. */
  hazard: boolean;
  dredged: boolean;
}

/** M_COVR with CATCOV = 1: the source cell has data here. */
export interface CoverageFeature extends FeatureBase {
  role: "coverage";
}

/** M_QUAL survey-quality zone. */
export interface QualityFeature extends FeatureBase {
  role: "quality";
  catzoc: Catzoc;
  /** Positional accuracy in metres, when the cell states it. */
  posacc?: number;
  /** Sounding accuracy in metres, when the cell states it. */
  souacc?: number;
}

/** SWPARE: a guaranteed minimum depth over the whole area. */
export interface SweptFeature extends FeatureBase {
  role: "swept";
  depth: number;
}

/** UNSARE: inside the cell's coverage, but never surveyed, so it has no depth. */
export interface UnsurveyedFeature extends FeatureBase {
  role: "unsurveyed";
}

export type ChartFeature =
  DepthFeature | CoverageFeature | QualityFeature | SweptFeature | UnsurveyedFeature;
