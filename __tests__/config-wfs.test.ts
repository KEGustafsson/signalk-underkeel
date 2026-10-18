import { parseConfig } from "../src/config";
import { DEFAULT_WFS_URL } from "../src/ingest/wfs";

describe("Traficom WFS configuration", () => {
  test("off unless enabled; the radius is clamped to 2..25 km; quality B unless set", () => {
    expect(parseConfig({}).wfs).toBeUndefined();
    expect(parseConfig({ wfs: { radiusKm: 5 } }).wfs).toBeUndefined();
    expect(parseConfig({ wfs: { enabled: true } }).wfs).toEqual({
      url: DEFAULT_WFS_URL,
      radiusKm: 10,
      catzoc: 3
    });
    expect(parseConfig({ wfs: { enabled: true, radiusKm: 40 } }).wfs?.radiusKm).toBe(10);
    expect(
      parseConfig({ wfs: { enabled: true, radiusKm: 2, url: "https://x.test/wfs" } }).wfs
    ).toEqual({
      url: "https://x.test/wfs",
      radiusKm: 2,
      catzoc: 3
    });
    expect(parseConfig({ wfs: { enabled: true, catzoc: "U" } }).wfs?.catzoc).toBe(6);
    expect(parseConfig({ wfs: { enabled: true, catzoc: "Z" } }).wfs?.catzoc).toBe(3);
  });
});
