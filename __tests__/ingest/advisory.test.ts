import {
  advisoryNotice,
  isAdvisorySource,
  keptStamps,
  licenceNotes,
  ODC_SOURCE,
  WFS_SOURCE
} from "../../src/ingest/advisory";
import { ODC_NOTICE } from "../../src/ingest/odc";
import { WFS_NOTICE } from "../../src/ingest/wfs";

/** The sources not for navigation that the plugin writes cells of itself (plan §4.2). */
describe("advisory sources", () => {
  test("the Traficom WFS and Open Data Charts are advisory; ENC cells are not", () => {
    expect(isAdvisorySource(WFS_SOURCE)).toBe(true);
    expect(isAdvisorySource(ODC_SOURCE)).toBe(true);
    expect(isAdvisorySource(undefined)).toBe(false);
    expect(isAdvisorySource("charts-provider")).toBe(false);
  });

  test("the notice names each advisory source in use, the WFS one when none is named", () => {
    expect(advisoryNotice([ODC_SOURCE, undefined])).toBe(ODC_NOTICE);
    expect(advisoryNotice([WFS_SOURCE, ODC_SOURCE, ODC_SOURCE])).toBe(
      `${WFS_NOTICE}; ${ODC_NOTICE}`
    );
    expect(advisoryNotice([])).toBe(WFS_NOTICE);
  });

  test("a saved stamp of a cell the start left out stays only while its source is off", () => {
    const enc = "FR5ENC01 edition 3";
    const odc = "OD1ODC01 edition 1";
    const wfs = "FI1WFS01 edition 1";
    const was = [enc, odc, wfs];
    expect(keptStamps(was, [enc], { wfs: {}, openDataCharts: {} })).toEqual([enc]);
    expect(keptStamps(was, [enc], {})).toEqual(was);
    expect(keptStamps(was, [enc, odc], { openDataCharts: {} })).toEqual([enc, odc, wfs]);
  });

  test("the status says each source is not for navigation unless the reason already does", () => {
    const cells = [{ source: ODC_SOURCE }, {}];
    expect(licenceNotes({ wfs: {} }, cells, "")).toEqual([WFS_NOTICE, ODC_NOTICE]);
    expect(licenceNotes({}, cells, ODC_NOTICE)).toEqual([]);
    expect(licenceNotes({}, undefined, "")).toEqual([]);
  });
});
