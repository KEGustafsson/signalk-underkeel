import fs from "fs";
import path from "path";
import type { WfsConfig } from "./config";
import { writeFileDurable } from "./foundation/durable-file";
import { cellSources, sourceKeys } from "./index-loader";
import type { Bbox } from "./ingest/wfs";
import { readBox } from "./spatial/build-box";
import { savedIndexIsCurrent } from "./spatial/chart-index";

/**
 * What the planning index on disk was built for, saved beside it once a build has committed
 * (`planning-box.ts`). A planning index is released from memory when it goes unused and is not
 * held across a restart, but its files stay: while this record says they still serve a trip's
 * region, from the same cells and settings and not too long ago, the index is read back in about
 * a second instead of downloaded and built again, which takes minutes.
 */
export interface SavedHold {
  /** The region asked for, and the box it was built in. */
  region: Bbox;
  bbox: Bbox;
  /** A corridor's boxes, when it was built for one. */
  parts?: Bbox[];
  /** When the build ended, epoch ms. */
  builtAt: number;
  /** What the build read (`holdStamp`): another stamp now means another index would be built. */
  stamp: string;
}

/** A saved planning index older than this is built again, ms: its depths are downloaded anew. */
export const RESTORE_MAX_AGE_MS = 7 * 24 * 3_600_000;

const VERSION = 1;

/** The record's file: beside the index directory, which a commit replaces whole. */
export const holdFile = (indexDir: string): string =>
  path.join(path.dirname(indexDir), `${path.basename(indexDir)}.held.json`);

/** What a planning build reads besides the region: its sources' stamps and its settings. */
export interface HoldInputs {
  /** The planning box's Traficom WFS cell directory. */
  dir: string;
  indexDir: string;
  config: WfsConfig | { radiusKm: number };
  cellsDir?: string;
  leafZoom: number;
  source?: string;
}

/**
 * The stamp of what a build of `d` would read now: every source's edition and update, the leaf
 * zoom, the ENC source and the WFS depth settings. Undefined when a source cannot be read.
 */
export function holdStamp(d: HoldInputs): string | undefined {
  const wfs = "url" in d.config ? d.config : undefined;
  try {
    const dirs = [...cellSources(d.cellsDir), ...(wfs ? [d.dir] : [])];
    return JSON.stringify({
      sources: sourceKeys(dirs),
      leafZoom: d.leafZoom,
      source: d.source ?? null,
      wfs: wfs ? { url: wfs.url, catzoc: wfs.catzoc, via: wfs.viaChartsProvider } : null
    });
  } catch {
    return undefined;
  }
}

const isBbox = (v: unknown): v is Bbox =>
  Array.isArray(v) && v.length === 4 && v.every((x) => typeof x === "number" && Number.isFinite(x));

/** The record saved for `indexDir`, or undefined when there is none or it does not parse. */
export function readHold(indexDir: string): SavedHold | undefined {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(fs.readFileSync(holdFile(indexDir), "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const { region, bbox, parts, builtAt, stamp } = json;
  const partsOk = parts === undefined || (Array.isArray(parts) && parts.every(isBbox));
  if (json.version !== VERSION || !isBbox(region) || !isBbox(bbox) || !partsOk) {
    return undefined;
  }
  if (typeof builtAt !== "number" || !Number.isFinite(builtAt) || typeof stamp !== "string") {
    return undefined;
  }
  return { region, bbox, ...(parts !== undefined && { parts: parts as Bbox[] }), builtAt, stamp };
}

export function writeHold(indexDir: string, hold: SavedHold): void {
  writeFileDurable(holdFile(indexDir), JSON.stringify({ version: VERSION, ...hold }));
}

/** Removes the record: the index it describes is about to be replaced. */
export function dropHold(indexDir: string): void {
  fs.rmSync(holdFile(indexDir), { force: true });
}

/** What a planning build of `deps` reads now, for the record kept beside its index. */
export function holdInputsOf(deps: {
  dir: string;
  indexDir: string;
  job(): Pick<HoldInputs, "config" | "cellsDir" | "leafZoom" | "source">;
}): HoldInputs {
  const { config, cellsDir, leafZoom, source } = deps.job();
  const { dir, indexDir } = deps;
  return {
    dir,
    indexDir,
    config,
    leafZoom,
    ...(cellsDir !== undefined && { cellsDir }),
    ...(source !== undefined && { source })
  };
}

/**
 * Saves what the index just committed in `d.indexDir` was built for at `now`, so it can be read
 * back; nothing when a source's stamp cannot be read.
 */
export function recordHold(
  d: HoldInputs,
  held: { region: Bbox; bbox: Bbox; parts: readonly Bbox[] | undefined },
  now: number
): void {
  const stamp = holdStamp(d);
  if (stamp === undefined) {
    return;
  }
  const parts = held.parts?.map((p): Bbox => [p[0], p[1], p[2], p[3]]);
  writeHold(d.indexDir, {
    region: held.region,
    bbox: held.bbox,
    ...(parts && { parts }),
    builtAt: now,
    stamp
  });
}

const sameBbox = (a: Bbox, b: Bbox): boolean => a.every((v, i) => v === b[i]);

/**
 * The record of the planning index on disk when that index may be read back at `now` for a
 * build of `d`: the record's stamp is today's, it is not older than RESTORE_MAX_AGE_MS, and the
 * index in the directory is the one it describes, written by this version (its box and leaf
 * zoom as recorded). Undefined otherwise; the caller builds.
 */
export function restorable(d: HoldInputs, now: number): SavedHold | undefined {
  try {
    return restorableHold(d, now);
  } catch {
    return undefined;
  }
}

function restorableHold(d: HoldInputs, now: number): SavedHold | undefined {
  const hold = readHold(d.indexDir);
  if (!hold || now < hold.builtAt || now - hold.builtAt > RESTORE_MAX_AGE_MS) {
    return undefined;
  }
  if (hold.stamp !== holdStamp(d)) {
    return undefined;
  }
  const box = savedIndexIsCurrent(d.indexDir) ? readBox(d.indexDir) : undefined;
  return box && box.leafZoom === d.leafZoom && sameBbox(box.bbox, hold.bbox) ? hold : undefined;
}
