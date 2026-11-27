import { parseConfig } from "../src/config";

describe("Open Data Charts configuration", () => {
  test("on unless switched off, with survey quality C unless set", () => {
    expect(parseConfig({}).openDataCharts).toEqual({ catzoc: 4 });
    expect(parseConfig({ openDataCharts: { enabled: true, catzoc: "U" } }).openDataCharts).toEqual({
      catzoc: 6
    });
    expect(parseConfig({ openDataCharts: { catzoc: "Z" } }).openDataCharts?.catzoc).toBe(4);
    expect(parseConfig({ openDataCharts: { enabled: false } }).openDataCharts).toBeUndefined();
    expect(parseConfig({ openDataCharts: false }).openDataCharts).toBeUndefined();
    // A name the lookup object inherits is no quality.
    expect(parseConfig({ openDataCharts: { catzoc: "constructor" } }).openDataCharts).toEqual({
      catzoc: 4
    });
    expect(parseConfig({ wfs: { enabled: true, catzoc: "toString" } }).wfs?.catzoc).toBe(3);
  });
});
