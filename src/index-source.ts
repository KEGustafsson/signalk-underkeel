import path from "path";
import type { PluginConfig } from "./config";
import type { CellScan } from "./ingest/cell-source";
import { readSource } from "./spatial/build-source";

/**
 * The ENC source an index was built from, as the settings name it: a cells directory, or a
 * collection signalk-charts-provider-simple shares. Recorded with the index, so a source left
 * without cells can be told apart from the source the index came from: a cells directory that
 * is gone or empty most likely sits on a drive that is not mounted, and its saved index is
 * used meanwhile, while a source the user chose since was never the saved index's.
 *
 * A collection is recorded by its id, not the directory it resolves to: the charts provider
 * may keep its store elsewhere than the default path read while it is still starting.
 */

/** The source `cfg` reads its S-57 cells from; undefined without one. */
export function indexSource(
  cfg: Pick<PluginConfig, "cellsDir" | "chartsProviderEnc">
): string | undefined {
  if (cfg.chartsProviderEnc !== undefined) {
    return `charts-provider:${cfg.chartsProviderEnc}`;
  }
  return cfg.cellsDir ? `dir:${path.resolve(cfg.cellsDir)}` : undefined;
}

/**
 * Why the index in `indexDir` was not built from the source `cfg` reads, or undefined when it
 * was, or records no source (an index saved by an older version).
 */
export function sourceChanged(
  cfg: Pick<PluginConfig, "cellsDir" | "chartsProviderEnc">,
  indexDir: string
): string | undefined {
  const saved = readSource(indexDir);
  const now = indexSource(cfg);
  return saved !== undefined && saved !== now
    ? `the saved index was built from ${describe(saved)}, not ${now === undefined ? "the cells now set" : describe(now)}`
    : undefined;
}

function describe(source: string): string {
  return source.startsWith("charts-provider:")
    ? `Charts Provider's ${source.slice("charts-provider:".length)}`
    : source.slice(source.indexOf(":") + 1);
}

/**
 * `found`, a scan of the cells directory or why it says nothing of the saved index, except
 * that cells away from a source the saved index was not built from are none: an unmounted
 * drive keeps the saved index, but only one built from the cells now set.
 */
export function cellsNow(
  found: { scan: CellScan } | { away: string },
  cfg: Pick<PluginConfig, "cellsDir" | "chartsProviderEnc">,
  indexDir: string
): { scan: CellScan; note?: string } | { away: string } {
  const moved = "away" in found ? sourceChanged(cfg, indexDir) : undefined;
  return "away" in found && moved !== undefined
    ? {
        scan: { sources: [], skipped: [] },
        note: `${found.away}; not using the saved index: ${moved}`
      }
    : found;
}

/**
 * Why the index in `indexDir` is not this configuration's when `cfg` sets no ENC source at
 * all, as when the source is cleared, though the index records one; undefined otherwise.
 */
export function sourceDropped(
  cfg: Pick<PluginConfig, "cellsDir" | "chartsProviderEnc">,
  indexDir: string
): string | undefined {
  return indexSource(cfg) === undefined ? sourceChanged(cfg, indexDir) : undefined;
}
