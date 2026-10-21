import type { LookaheadOptions } from "./engine/lookahead";
import { MAX_POSITION_BUFFER } from "./engine/fan";
import type { LonLat, Rect } from "./foundation/geo";
import { project, toMercator } from "./foundation/geo";
import type { Clock, Monitor } from "./monitor";
import { cacheOf } from "./spatial/block-cache";
import type { ChartIndex } from "./spatial/chart-index";
import { MAX_CHART_BUFFER } from "./spatial/chart-position";
import { mercatorBuffer } from "./spatial/pyramid";

/**
 * Keeps the pyramid blocks the look-ahead can reach loaded (`block-cache.ts`),
 * and reads those ahead along the course before the vessel gets there, so a
 * tick seldom waits for a block or reads its stand-ins. Blocks of routes,
 * tiles and queries are read when those reach them and stay while used.
 */

/** Blocks the vessel would reach within this long at its speed and course are read ahead. */
export const PREFETCH_SECONDS = 300;

/** At most this often the kept blocks are updated, ms. */
const EVERY_MS = 2000;

function around(p: LonLat, metres: number): Rect {
  const [x, y] = toMercator(p[0], p[1]);
  const r = mercatorBuffer({ minX: x, minY: y, maxX: x, maxY: y }, metres);
  return { minX: x - r, minY: y - r, maxX: x + r, maxY: y + r };
}

/**
 * The squares the look-ahead can reach from `p` (its distance or horizon at
 * `sog`, the widest position buffer and chart reach), and the same square
 * PREFETCH_SECONDS ahead along `cog`.
 */
export function keptRects(
  p: LonLat,
  cog: number | undefined,
  sog: number | undefined,
  opts: LookaheadOptions
): Rect[] {
  const speed = sog ?? 0;
  const reach =
    Math.max(opts.distance, opts.minHorizon * speed) + MAX_POSITION_BUFFER + MAX_CHART_BUFFER;
  const here = around(p, reach);
  if (cog === undefined || speed <= opts.lowSpeed) {
    return [here];
  }
  return [here, around(project(p, cog, speed * PREFETCH_SECONDS), reach)];
}

/** Updates the kept blocks from the monitor's navigation inputs as the position moves. */
export function keepBlocksNearVessel(
  monitor: Monitor,
  index: () => ChartIndex | undefined,
  clock: Clock,
  opts: LookaheadOptions
): void {
  let last = -Infinity;
  monitor.watch(["navigation.position"], () => {
    const now = clock.now();
    const pyramid = index()?.pyramid;
    const p = monitor.nav.position?.value;
    if (now - last < EVERY_MS || !pyramid || !p) {
      return;
    }
    last = now;
    void cacheOf(pyramid)?.keep(keptRects(p, monitor.nav.cog?.value, monitor.nav.sog?.value, opts));
  });
}
