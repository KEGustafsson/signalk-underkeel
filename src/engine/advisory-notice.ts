import { advisoryNotice, isAdvisorySource } from "../ingest/advisory";
import type { ChartIndex } from "../spatial/chart-index";
import { FLAGS } from "../spatial/node-store";
import type { FootprintResult } from "./lookahead";

/** Each catalogue's advisory notices by the advisory cells read, worked out once each. */
const notices = new WeakMap<ChartIndex["catalogue"], Map<string, string>>();

/** The notice of the advisory sources whose flagged water the footprints read. */
export function noticeOf(index: ChartIndex, fps: readonly FootprintResult[]): string {
  const { cells } = index.catalogue;
  const refs = new Set<number>();
  for (const f of fps) {
    if (f.flags & FLAGS.NOT_FOR_NAVIGATION) {
      for (const ref of f.cellRefs ?? []) {
        if (isAdvisorySource(cells[ref]?.source)) {
          refs.add(ref);
        }
      }
    }
  }
  const key = [...refs].sort((a, b) => a - b).join(",");
  const byRefs = notices.get(index.catalogue) ?? new Map<string, string>();
  notices.set(index.catalogue, byRefs);
  let notice = byRefs.get(key);
  if (notice === undefined) {
    // None named (a tile flagged from beyond the buffer): every advisory cell of the index.
    const named = refs.size > 0 ? [...refs].map((r) => cells[r]) : cells;
    notice = advisoryNotice(named.map((c) => c?.source));
    byRefs.set(key, notice);
  }
  return notice;
}
