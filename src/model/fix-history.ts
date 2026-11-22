/**
 * The boat's demonstrated fix quality (plan §4.11, pilotage): the position σ the integrity
 * monitor measured over the last WINDOW_HOURS, kept as a histogram per hour. A route is sailed
 * later and elsewhere than it is planned, so the pilotage buffer a plan is checked at comes from
 * what the boat's fix has shown over days, never from the fix at the moment of planning: one
 * HDOP reading at the berth says nothing of the fix under a bridge hours later. The live fix is
 * held to the plan underway instead (`engine/pilotage-watch.ts`).
 */

/** Width of a histogram bin, metres. */
export const FIX_BIN = 0.1;
/** Bins per hour: up to 20 m, the last one holding everything wider, its widest kept apart. */
export const FIX_BINS = 200;
/** The upper edge of the bins, metres. */
const TOP = FIX_BINS * FIX_BIN;
/** How far back the history reaches, hours. */
export const WINDOW_HOURS = 7 * 24;
/** Samples are taken at most this often, ms. */
export const SAMPLE_MS = 10_000;
/** The share of the history the planning σ covers. */
export const QUANTILE = 0.95;
/** Samples the history needs before it is used: an hour's at SAMPLE_MS. */
export const MIN_SAMPLES = 360;

const HOUR_MS = 3_600_000;

/** The history as it is saved. */
export interface FixHistoryJson {
  version: 1;
  /** Bin counts by hour since the epoch, each bin index → count. */
  hours: Record<string, Record<string, number>>;
  /** The widest σ above the bins' upper edge by hour since the epoch, metres. */
  overflow?: Record<string, number>;
}

export class FixHistory {
  private readonly hours = new Map<number, Map<number, number>>();
  /** The widest σ above TOP by hour: the last bin's upper edge is under it. */
  private readonly overflow = new Map<number, number>();
  private last = -Infinity;
  /** Whether a sample came in since the history was last saved. */
  dirty = false;

  /** Counts the measured σ `sigma` at `now`, at most every SAMPLE_MS. */
  add(sigma: number, now: number): void {
    if (!Number.isFinite(sigma) || sigma <= 0 || now - this.last < SAMPLE_MS) {
      return;
    }
    this.last = now;
    const hour = Math.floor(now / HOUR_MS);
    const bin = Math.min(FIX_BINS - 1, Math.floor(sigma / FIX_BIN + 1e-9));
    const bins = this.hours.get(hour) ?? new Map<number, number>();
    bins.set(bin, (bins.get(bin) ?? 0) + 1);
    this.hours.set(hour, bins);
    if (sigma > TOP) {
      this.overflow.set(hour, Math.max(this.overflow.get(hour) ?? 0, sigma));
    }
    this.prune(now);
    this.dirty = true;
  }

  /** Samples within the window at `now`. */
  samples(now: number): number {
    this.prune(now);
    let n = 0;
    for (const bins of this.hours.values()) {
      for (const c of bins.values()) {
        n += c;
      }
    }
    return n;
  }

  /**
   * The σ that share `q` of the samples within the window lie at or under, metres: the upper
   * edge of its bin, or in the last bin the widest σ it holds, so never under any of them.
   * Undefined below MIN_SAMPLES.
   */
  quantile(q: number, now: number): number | undefined {
    const total = this.samples(now);
    if (total < MIN_SAMPLES) {
      return undefined;
    }
    const counts = new Array<number>(FIX_BINS).fill(0);
    for (const bins of this.hours.values()) {
      for (const [b, c] of bins) {
        counts[b] = (counts[b] ?? 0) + c;
      }
    }
    const target = Math.ceil(q * total);
    let seen = 0;
    for (let b = 0; b < FIX_BINS - 1; b++) {
      seen += counts[b] ?? 0;
      if (seen >= target) {
        return Math.round((b + 1) * FIX_BIN * 10) / 10;
      }
    }
    return Math.ceil(Math.max(TOP, ...this.overflow.values()) * 10) / 10;
  }

  toJSON(): FixHistoryJson {
    const hours: FixHistoryJson["hours"] = {};
    for (const [h, bins] of this.hours) {
      hours[String(h)] = Object.fromEntries([...bins].map(([b, c]) => [String(b), c]));
    }
    const overflow = Object.fromEntries([...this.overflow].map(([h, v]) => [String(h), v]));
    return { version: 1, hours, ...(this.overflow.size > 0 && { overflow }) };
  }

  /** The history `raw` holds; anything malformed in it is left out. */
  static from(raw: unknown): FixHistory {
    const out = new FixHistory();
    const r = raw as Partial<FixHistoryJson> | null;
    if (r?.version !== 1 || typeof r.hours !== "object" || r.hours === null) {
      return out;
    }
    for (const [h, bins] of Object.entries(r.hours)) {
      const kept = Number.isInteger(Number(h)) ? binsOf(bins) : undefined;
      if (kept && kept.size > 0) {
        out.hours.set(Number(h), kept);
      }
    }
    for (const [h, v] of Object.entries(r.overflow ?? {})) {
      if (out.hours.has(Number(h)) && typeof v === "number" && Number.isFinite(v) && v > TOP) {
        out.overflow.set(Number(h), v);
      }
    }
    return out;
  }

  private prune(now: number): void {
    const oldest = Math.floor(now / HOUR_MS) - WINDOW_HOURS;
    for (const h of this.hours.keys()) {
      if (h <= oldest) {
        this.hours.delete(h);
        this.overflow.delete(h);
      }
    }
  }
}

/** An hour's bin counts as saved, the malformed ones left out. */
function binsOf(raw: unknown): Map<number, number> | undefined {
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }
  const kept = new Map<number, number>();
  for (const [b, c] of Object.entries(raw)) {
    const bin = Number(b);
    if (Number.isInteger(bin) && bin >= 0 && bin < FIX_BINS && Number.isInteger(c) && c > 0) {
      kept.set(bin, c as number);
    }
  }
  return kept;
}

/**
 * The position σ a plan is checked at, metres: the configured σ, or the history's QUANTILE
 * when it is wider. The boat's own history only adds caution (invariant 6): a fix that has been
 * worse widens the buffer, one that has been better never narrows it under the configuration.
 */
export function planningSigma(
  history: FixHistory | undefined,
  configured: number,
  now: number
): number {
  return Math.max(configured, history?.quantile(QUANTILE, now) ?? 0);
}
