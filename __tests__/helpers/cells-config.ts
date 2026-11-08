import type { PluginConfig } from "../../src/config";
import { parseConfig } from "../../src/config";

/**
 * The configuration `raw` parses to, reading its S-57 cells from `raw.cellsDir`: the
 * directory the chosen charts provider's store resolves to (`withSharedCells`), for tests of
 * what the plugin does with the cells it finds there. `cellsDir` is no setting of its own.
 */
export function cellsConfig(raw: Record<string, unknown>): PluginConfig {
  const config = parseConfig(raw);
  return typeof raw.cellsDir === "string" ? { ...config, cellsDir: raw.cellsDir } : config;
}
