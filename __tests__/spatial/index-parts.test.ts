import type { CellCatalogue } from "../../src/ingest/cells";
import { parseCatalogue } from "../../src/ingest/cells";
import type { BuiltIndex } from "../../src/spatial/build-worker";
import { HazardIndex } from "../../src/spatial/hazards";
import { indexParts } from "../../src/spatial/index-parts";
import type { NodeColumns, NodeStore } from "../../src/spatial/node-store";

/**
 * The index a build hands over carries its catalogue as `cells.json` saves it, so a catalogue
 * read from the cells compares equal, key for key, to one loaded from the saved index.
 */

test("a cell read with datum areas is handed over in the order cells.json loads it", () => {
  // The cell reader adds `datumAreas` after the other fields; cells.json puts it after the datums.
  const read: CellCatalogue = {
    version: 1,
    cells: [{ name: "1R5WADDZ", edition: 2, update: 0, band: 5, source: "/enc/1R5WADDZ" }].map(
      (c) => ({ ...c, datumAreas: [3, 7] })
    )
  };
  const built = {
    catalogue: read,
    hazards: new HazardIndex([]),
    pyramid: { minZoom: 12, leafZoom: 16 } as NodeStore,
    cols: {} as NodeColumns,
    roots: { built: 0, copied: 0, nodesCopied: 0 },
    reaches: []
  } as BuiltIndex;
  const saved = parseCatalogue(JSON.parse(JSON.stringify(read)));
  expect(JSON.stringify(indexParts(built).catalogue)).toBe(JSON.stringify(saved));
  expect(JSON.stringify(read)).not.toBe(JSON.stringify(saved));
});
