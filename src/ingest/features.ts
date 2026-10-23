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
  /**
   * Compilation scale denominator of the source cell (DSPM_CSCL), when it
   * states one: nothing it draws is placed finer than 1 mm on that chart,
   * so the index splits tiles no finer for it (plan §4.3).
   */
  scale?: number;
}

/** Anything that bounds the depth from above: areas, soundings, hazards, land. */
export interface DepthFeature extends FeatureBase {
  role: "depth";
  /** Conservative depth below chart datum in metres; -Infinity for land. */
  depth: number;
  /** Point/line hazards and soundings carry exact geometry for explanations. */
  hazard: boolean;
  dredged: boolean;
  /**
   * Land and shoreline objects (`TOPOGRAPHY`): the 1σ of their own charted
   * position in metres, from the cell's compilation scale (plan §4.4). Set
   * only when the export carries the cell's positional quality
   * (`QUAPOS.geojson`); without it the object is placed by the survey's
   * CATZOC like the depths around it.
   */
  topoSigma?: number;
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

/**
 * A spatial record (edge or node) whose position the cell does not give as
 * surveyed: QUAPOS other than 1 (surveyed), 10 (precisely known) or 11
 * (calculated), or a stated POSACC. Land and shoreline objects on it keep
 * the survey's position σ, or POSACC when stated, rather than the
 * compilation scale's.
 */
export interface PositionFeature extends FeatureBase {
  role: "position";
  /** QUAPOS says the position is not surveyed, e.g. 4 (approximated). */
  lowAccuracy: boolean;
  /** Stated positional accuracy, metres. */
  posacc?: number;
}

export type ChartFeature =
  | DepthFeature
  | CoverageFeature
  | QualityFeature
  | SweptFeature
  | UnsurveyedFeature
  | PositionFeature;
