import type { HeelModel, Term } from "./allowances";
import { heel, squat, waveAllowance } from "./allowances";
import type { VesselTerms } from "./uncertainty";

/**
 * Vessel model (plan §4.6): static draft and hull rectangle, plus the
 * parameters of the dynamic terms (squat, heel, wave allowance).
 */

export interface VesselModel {
  /** Static draft in metres, including any load allowance. */
  draft: number;
  /** Hull length overall in metres. */
  length: number;
  /** Beam in metres. */
  beam: number;
}

export interface DynamicsOptions {
  blockCoefficient: number;
  /** Doubles squat everywhere, for boats that mostly run narrow channels. */
  confined: boolean;
  heel: HeelModel;
  /** c in W = c·Hs. */
  waveFactor: number;
  /** 1σ of the static draft, metres. */
  draftSigma: number;
  /** Fixed extra margin under the keel, metres. */
  margin: number;
}

export const DEFAULT_DYNAMICS: DynamicsOptions = {
  blockCoefficient: 0.4,
  confined: false,
  heel: { kind: "none" },
  waveFactor: 0.4,
  draftSigma: 0.05,
  margin: 0
};

export interface MotionInputs {
  /** Speed for squat, m/s. */
  speed: number;
  /** Roll angle, radians. */
  roll?: number;
  /** Significant wave height, metres. */
  waveHeight?: number;
}

/** The draft-side UKC terms at a speed, roll and sea state. */
export function vesselTerms(
  vessel: VesselModel,
  motion: MotionInputs,
  dyn: DynamicsOptions
): VesselTerms {
  const draft: Term = { value: vessel.draft, sigma: dyn.draftSigma };
  return {
    draft,
    heel: heel(motion.roll, vessel.draft, dyn.heel),
    squat: squat(motion.speed, dyn),
    wave: waveAllowance(motion.waveHeight, dyn.waveFactor),
    margin: dyn.margin
  };
}

export interface VesselInputs {
  /** Plugin configuration; overrides Signal K values when set. */
  config: Partial<VesselModel>;
  /** `design.draft.maximum`, `design.length.overall`, `design.beam` from Signal K. */
  signalk: Partial<VesselModel>;
}

/**
 * Hull size used when neither the configuration nor Signal K states it.
 * Larger than most yachts, so the footprint errs toward catching more.
 */
export const FALLBACK_HULL = { length: 15, beam: 5 } as const;

export interface ResolvedVessel {
  /** Undefined when the draft is unknown: the engine must not guess it. */
  vessel?: VesselModel;
  /** Human-readable notes on values that were missing or defaulted. */
  notes: string[];
}

function positive(v: number | undefined): number | undefined {
  return v !== undefined && Number.isFinite(v) && v > 0 ? v : undefined;
}

export function resolveVessel(inputs: VesselInputs): ResolvedVessel {
  const pick = (key: keyof VesselModel) =>
    positive(inputs.config[key]) ?? positive(inputs.signalk[key]);
  const notes: string[] = [];
  const draft = pick("draft");
  let length = pick("length");
  let beam = pick("beam");
  if (length === undefined) {
    length = FALLBACK_HULL.length;
    notes.push(`hull length unknown, using ${FALLBACK_HULL.length} m`);
  }
  if (beam === undefined) {
    beam = FALLBACK_HULL.beam;
    notes.push(`beam unknown, using ${FALLBACK_HULL.beam} m`);
  }
  if (draft === undefined) {
    notes.unshift("vessel draft not configured");
    return { notes };
  }
  return { vessel: { draft, length, beam }, notes };
}
