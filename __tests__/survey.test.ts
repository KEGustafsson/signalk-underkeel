import fs from "fs";
import os from "os";
import path from "path";
import { readCellDirectory } from "../src/ingest/cell-reader";
import type { Bbox, WfsFetch } from "../src/ingest/wfs";
import { downloadWfsCell, partGroups } from "../src/ingest/wfs";
import {
  fetchLayer,
  limiter,
  retried,
  TILE_TRIES,
  WFS_LIMITS,
  WfsRefusal
} from "../src/ingest/wfs-fetch";
import type { Survey } from "../src/survey";
import { cellDegrees, markPolygon, SURVEY_MAX_CELLS, surveyGrid, surveyTiles } from "../src/survey";
import { readSurvey, runSurvey, writeSurvey } from "../src/survey-worker";

/** The depth survey (signalk-route-planner's plan §4.2) and the corridor's WFS download. */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-survey-"));
// Tried again at once: the pause between tries is the WFS's, not the tests'.
const limits = WFS_LIMITS as { retryPauseMs: number };
const PAUSE = limits.retryPauseMs;
beforeAll(() => {
  limits.retryPauseMs = 0;
});
afterAll(() => {
  limits.retryPauseMs = PAUSE;
});
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

const REGION: Bbox = [22.0, 60.0, 22.2, 60.1];

const square = ([w, s, e, n]: Bbox): number[][][] => [
  [
    [w, s],
    [e, s],
    [e, n],
    [w, n],
    [w, s]
  ]
];

/** The cell at `[lon, lat]`. */
function at(g: Survey, lon: number, lat: number): number {
  const [dLat, dLon] = cellDegrees(g);
  const c = Math.floor((lon - g.bbox[0]) / dLon);
  const r = Math.floor((lat - g.bbox[1]) / dLat);
  return g.depth[r * g.cols + c] as number;
}

describe("survey grid", () => {
  test("cells of the size asked for, the region rounded out to whole cells", () => {
    const g = surveyGrid(REGION, 100);
    expect(g.cellMetres).toBe(100);
    // 0.2° east–west at 60.05° N is 11.1 km, 0.1° north–south 11.1 km.
    expect(g.cols).toBe(112);
    expect(g.rows).toBe(112);
    expect(g.bbox[0]).toBe(22.0);
    expect(g.bbox[1]).toBe(60.0);
    expect(g.bbox[2]).toBeGreaterThanOrEqual(22.2);
    expect(g.bbox[3]).toBeGreaterThanOrEqual(60.1);
    expect(g.depth.every(Number.isNaN)).toBe(true);
  });

  test("coarser than asked when the cells would be too many", () => {
    const g = surveyGrid([20, 59, 23, 61], 50);
    expect(g.cols * g.rows).toBeLessThanOrEqual(SURVEY_MAX_CELLS);
    expect(g.cellMetres).toBeGreaterThan(50);
  });

  test("tiles cover every cell once, each within the WFS tile span", () => {
    const g = surveyGrid([20.5, 59.4, 22.4, 60.6], 200);
    const seen = new Uint8Array(g.cols * g.rows);
    for (const t of surveyTiles(g)) {
      const [c0, r0, c1, r1] = t.range;
      expect(t.bbox[2] - t.bbox[0]).toBeLessThanOrEqual(1.0 + 1e-9);
      expect(t.bbox[3] - t.bbox[1]).toBeLessThanOrEqual(0.5 + 1e-9);
      for (let r = r0; r < r1; r++) {
        for (let c = c0; c < c1; c++) {
          seen[r * g.cols + c] = (seen[r * g.cols + c] as number) + 1;
        }
      }
    }
    expect(seen.every((n) => n === 1)).toBe(true);
  });
});

describe("marking areas", () => {
  test("a square marks the cells it touches with its depth, keeping the deepest", () => {
    const g = surveyGrid(REGION, 100);
    markPolygon(g, square([22.05, 60.02, 22.1, 60.05]), 6);
    markPolygon(g, square([22.08, 60.04, 22.12, 60.06]), 12);
    markPolygon(g, square([22.06, 60.03, 22.07, 60.035]), 3);
    expect(at(g, 22.07, 60.03)).toBe(6);
    expect(at(g, 22.09, 60.045)).toBe(12);
    // A shallower area inside a deeper one leaves the deeper depth.
    expect(at(g, 22.065, 60.032)).toBe(6);
    // ...and its own shallowest: the cell may hold 3 m.
    const [dLat, dLon] = cellDegrees(g);
    const cell = (lon: number, lat: number) =>
      Math.floor((lat - g.bbox[1]) / dLat) * g.cols + Math.floor((lon - g.bbox[0]) / dLon);
    expect(g.shallowest[cell(22.065, 60.032)]).toBe(3);
    expect(g.shallowest[cell(22.07, 60.045)]).toBe(6);
    expect(at(g, 22.01, 60.01)).toBeNaN();
    expect(at(g, 22.15, 60.08)).toBeNaN();
  });

  test("a hole is not marked, and a sliver thinner than a cell still is", () => {
    const g = surveyGrid(REGION, 100);
    markPolygon(
      g,
      [...square([22.02, 60.02, 22.1, 60.06]), ...square([22.04, 60.03, 22.08, 60.05])],
      8
    );
    expect(at(g, 22.06, 60.04)).toBeNaN();
    expect(at(g, 22.03, 60.04)).toBe(8);
    // A channel 20 m wide, diagonal across many cells.
    const sliver = [
      [
        [22.12, 60.01],
        [22.18, 60.08],
        [22.1803, 60.08],
        [22.1203, 60.01],
        [22.12, 60.01]
      ]
    ];
    markPolygon(g, sliver, 5);
    expect(at(g, 22.15, 60.045)).toBe(5);
  });

  test("marks only the cells of the range given, its crossings paired from outside it", () => {
    const g = surveyGrid(REGION, 100);
    const half = Math.floor(g.cols / 2);
    markPolygon(g, square([22.02, 60.02, 22.18, 60.06]), 7, [half, 0, g.cols, g.rows]);
    expect(at(g, 22.05, 60.04)).toBeNaN();
    expect(at(g, 22.15, 60.04)).toBe(7);
  });
});

/** A WFS serving `layers[typeName]` whatever the box, paged, its page requests counted. */
function fakeWfs(layers: Record<string, unknown[]>, asked: string[]): WfsFetch {
  return (url) => {
    const u = new URL(url);
    const typeName = u.searchParams.get("typeNames") ?? "";
    const features = layers[typeName] ?? [];
    if (u.searchParams.get("resultType") === "hits") {
      const xml = `<wfs:FeatureCollection numberMatched="${features.length}"/>`;
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(xml) });
    }
    asked.push(`${typeName} ${u.searchParams.get("bbox")}`);
    const start = Number(u.searchParams.get("startIndex"));
    const count = Number(u.searchParams.get("count"));
    const body = { type: "FeatureCollection", features: features.slice(start, start + count) };
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify(body))
    });
  };
}

const depthArea = (b: Bbox, drval2: number) => ({
  type: "Feature",
  geometry: { type: "Polygon", coordinates: square(b) },
  properties: { DRVAL1: 2, DRVAL2: drval2, IDENTIFIER: `FI ${drval2}` }
});

describe("runSurvey", () => {
  test("downloads depth and dredged areas tile by tile and marks each on its own cells", async () => {
    const asked: string[] = [];
    const fetch = fakeWfs(
      {
        "rajoitettu:DepthArea_A": [depthArea([22.02, 60.02, 22.3, 60.06], 10)],
        "rajoitettu:DredgedArea_A": [
          {
            type: "Feature",
            geometry: { type: "Polygon", coordinates: square([22.05, 60.03, 22.06, 60.04]) },
            properties: { DRVAL1: 14, IDENTIFIER: "FI D" }
          }
        ]
      },
      asked
    );
    const g = await runSurvey(
      { url: "https://wfs.test/wfs", region: [22.0, 60.0, 22.5, 60.09], cellMetres: 200 },
      fetch
    );
    // One tile: a page of each layer, and the empty page after it.
    expect(surveyTiles(g)).toHaveLength(1);
    expect(asked).toHaveLength(4);
    expect(at(g, 22.1, 60.04)).toBe(10);
    expect(at(g, 22.055, 60.035)).toBe(14);
    expect(at(g, 22.4, 60.04)).toBeNaN();
    // Past the area's east edge.
    expect(at(g, 22.32, 60.04)).toBeNaN();
  });

  test("reads a layer page by page, and asks again for a page that fails", async () => {
    const asked: string[] = [];
    const many = Array.from({ length: 600 }, (_, i) =>
      depthArea([22.0 + i * 0.0005, 60.0, 22.0005 + i * 0.0005, 60.01], 4)
    );
    const wfs = fakeWfs({ "rajoitettu:DepthArea_A": many }, asked);
    let failed = false;
    // The second page stalls once.
    const fetch: WfsFetch = (url) => {
      if (!failed && new URL(url).searchParams.get("startIndex") === "250") {
        failed = true;
        return Promise.reject(new Error("no data for 30 s"));
      }
      return wfs(url);
    };
    const g = await runSurvey(
      { url: "https://wfs.test/wfs", region: [22.0, 60.0, 22.4, 60.05], cellMetres: 200 },
      fetch
    );
    expect(failed).toBe(true);
    const depthPages = asked.filter((a) => a.startsWith("rajoitettu:DepthArea_A"));
    // 250, 250, 100 and the empty page.
    expect(depthPages).toHaveLength(4);
    expect(at(g, 22.29, 60.005)).toBe(4);
    expect(at(g, 22.35, 60.005)).toBeNaN();
  });

  test("writes the grid and reads it back", () => {
    const g = surveyGrid(REGION, 500);
    markPolygon(g, square([22.05, 60.02, 22.1, 60.05]), 6);
    const d = path.join(TMP, "survey");
    writeSurvey(d, g);
    const back = readSurvey(d);
    expect(back.cols).toBe(g.cols);
    expect(back.bbox).toEqual(g.bbox);
    expect(Array.from(back.depth)).toEqual(Array.from(g.depth));
    expect(Array.from(back.shallowest)).toEqual(Array.from(g.shallowest));
  });
});

describe("corridor download", () => {
  test("parts are grouped while their box stays within twice their area", () => {
    const row = (s: number, w: number, e: number): Bbox => [w, s, e, s + 0.01];
    // A diagonal corridor of rows: neighbours group; far ones do not.
    const parts = [
      row(60.0, 22.0, 22.1),
      row(60.01, 22.02, 22.12),
      row(60.02, 22.04, 22.14),
      row(60.03, 22.4, 22.5)
    ];
    const groups = partGroups(parts);
    expect(groups.map((g) => g.length)).toEqual([3, 1]);
    // A long run of rows is cut where its box would pass GROUP_LAT.
    const tall = Array.from({ length: 12 }, (_, i): Bbox => [
      22.0,
      60 + i * 0.009,
      22.1,
      60 + (i + 1) * 0.009
    ]);
    expect(partGroups(tall).map((g) => g.length)).toEqual([5, 5, 2]);
  });

  test("the cell covers the parts alone, its areas clipped to each", async () => {
    const asked: string[] = [];
    const fetch = fakeWfs(
      {
        "rajoitettu:DepthArea_A": [depthArea([21.9, 59.9, 22.3, 60.2], 9)],
        "rajoitettu:DredgedArea_A": [],
        "rajoitettu:Sounding_P": [
          {
            type: "Feature",
            geometry: { type: "Point", coordinates: [22.05, 60.01] },
            properties: { DEPTH: 4, IDENTIFIER: "S1" }
          },
          {
            type: "Feature",
            geometry: { type: "Point", coordinates: [22.25, 60.15] },
            properties: { DEPTH: 5, IDENTIFIER: "S2" }
          }
        ]
      },
      asked
    );
    const parts: Bbox[] = [
      [22.0, 60.0, 22.1, 60.02],
      [22.02, 60.02, 22.12, 60.04]
    ];
    const d = path.join(TMP, "corridor", "FI1WFS01");
    await downloadWfsCell({
      fetch,
      url: "https://wfs.test/wfs",
      bbox: [22.0, 60.0, 22.12, 60.04],
      parts,
      dir: d,
      now: new Date("2026-11-19T12:00:00Z"),
      catzoc: 3
    });
    // One group: a page of each layer with features over the group's box (no dredged area).
    expect(asked).toHaveLength(2);
    const covr = JSON.parse(fs.readFileSync(path.join(d, "M_COVR.geojson"), "utf8"));
    expect(covr.features).toHaveLength(2);
    const depare = JSON.parse(fs.readFileSync(path.join(d, "DEPARE.geojson"), "utf8"));
    expect(depare.features).toHaveLength(2);
    const soundg = JSON.parse(fs.readFileSync(path.join(d, "SOUNDG.geojson"), "utf8"));
    expect(soundg.features.map((f: { properties: { LNAM: string } }) => f.properties.LNAM)).toEqual(
      ["S1"]
    );
    const qual = JSON.parse(fs.readFileSync(path.join(d, "M_QUAL.geojson"), "utf8"));
    expect(qual.features).toHaveLength(2);
    expect(() => readCellDirectory(d, 0)).not.toThrow();
  });
});

describe("retried", () => {
  test("a tile's download is tried again, at most TILE_TRIES times, never once aborted", async () => {
    let n = 0;
    const flaky = () => (++n < 3 ? Promise.reject(new Error("stalled")) : Promise.resolve(n));
    expect(await retried(flaky)).toBe(3);
    n = -10;
    await expect(retried(flaky)).rejects.toThrow("stalled");
    expect(n).toBe(-10 + TILE_TRIES);
    const stop = new AbortController();
    stop.abort();
    let once = 0;
    await expect(
      retried(() => {
        once++;
        return Promise.reject(new Error("aborted"));
      }, stop.signal)
    ).rejects.toThrow("aborted");
    expect(once).toBe(1);
  });
});

describe("a request on an aborted download", () => {
  test("its fetch's own later rejection is handled, not left to end the process", async () => {
    const unhandled: unknown[] = [];
    const listener = (e: unknown): void => {
      unhandled.push(e);
    };
    process.on("unhandledRejection", listener);
    try {
      const stop = new AbortController();
      stop.abort(new Error("a sibling layer failed"));
      const late: WfsFetch = () =>
        new Promise((_, reject) => setTimeout(() => reject(new Error("aborted late")), 5));
      await expect(
        fetchLayer({
          fetch: late,
          base: "https://wfs.test/wfs",
          typeName: "rajoitettu:Sounding_P",
          bbox: [22, 60, 22.1, 60.05],
          limit: limiter(1),
          signal: stop.signal
        })
      ).rejects.toThrow("a sibling layer failed");
      await new Promise((r) => setTimeout(r, 50));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });
});

describe("small pages", () => {
  test("a page asks for at least minPageCount features, and a small layer is one page", async () => {
    const counts: number[] = [];
    const features = Array.from({ length: 23 }, (_, i) => ({
      type: "Feature",
      id: `s${i}`,
      geometry: { type: "Point", coordinates: [22.01, 60.01] },
      properties: { DEPTH: 3, IDENTIFIER: `S${i}` }
    }));
    const fetch: WfsFetch = (url) => {
      const u = new URL(url);
      if (u.searchParams.get("resultType") === "hits") {
        const xml = `<wfs:FeatureCollection numberMatched="${features.length}"/>`;
        return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(xml) });
      }
      const count = Number(u.searchParams.get("count"));
      const start = Number(u.searchParams.get("startIndex"));
      counts.push(count);
      const body = { type: "FeatureCollection", features: features.slice(start, start + count) };
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify(body))
      });
    };
    const got = await fetchLayer({
      fetch,
      base: "https://wfs.test/wfs",
      typeName: "rajoitettu:Sounding_P",
      bbox: [22, 60, 22.1, 60.05],
      limit: limiter(4)
    });
    expect(got).toHaveLength(23);
    expect(counts).toEqual([WFS_LIMITS.minPageCount]);
  });
});

describe("refusals and repeats", () => {
  test("a refusal no try again changes is not tried again, nor a try after an abort", async () => {
    let n = 0;
    await expect(
      retried(() => {
        n++;
        return Promise.reject(new WfsRefusal("more than 50000 features"));
      })
    ).rejects.toThrow("more than 50000");
    expect(n).toBe(1);
    // Aborted during the pause before the second try: no second try.
    const stop = new AbortController();
    let tries = 0;
    const was = limits.retryPauseMs;
    limits.retryPauseMs = 50;
    try {
      const r = retried(() => {
        tries++;
        setTimeout(() => stop.abort(), 10);
        return Promise.reject(new Error("stalled"));
      }, stop.signal);
      await expect(r).rejects.toThrow("stalled");
      expect(tries).toBe(1);
    } finally {
      limits.retryPauseMs = was;
    }
  });

  test("a server that ignores startIndex is refused, not read as complete", async () => {
    const page = Array.from({ length: 250 }, (_, i) => ({
      ...depthArea([22, 60, 22.01, 60.01], 4),
      id: `a${i}`
    }));
    const fetch: WfsFetch = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: () =>
          Promise.resolve(
            JSON.stringify({ type: "FeatureCollection", numberMatched: 600, features: page })
          )
      });
    await expect(
      runSurvey(
        { url: "https://wfs.test/wfs", region: [22.0, 60.0, 22.1, 60.05], cellMetres: 200 },
        fetch
      )
    ).rejects.toThrow("the same feature on more than one page");
  });

  test("a malformed depth area fails the survey, naming it", async () => {
    const asked: string[] = [];
    const bad = {
      type: "Feature",
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [22, 60],
            [Number.POSITIVE_INFINITY, 60],
            [22, 60.01],
            [22, 60]
          ]
        ]
      },
      properties: { DRVAL1: 2, DRVAL2: 6, IDENTIFIER: "FI BAD" }
    };
    const fetch = fakeWfs({ "rajoitettu:DepthArea_A": [bad] }, asked);
    await expect(
      runSurvey(
        { url: "https://wfs.test/wfs", region: [22.0, 60.0, 22.1, 60.05], cellMetres: 200 },
        fetch
      )
    ).rejects.toThrow("depth area FI BAD: malformed Polygon");
  });

  test("a corridor's single-box group keeps a sounding on its edge once, and skips a malformed one", async () => {
    const asked: string[] = [];
    const fetch = fakeWfs(
      {
        "rajoitettu:DepthArea_A": [],
        "rajoitettu:DredgedArea_A": [],
        "rajoitettu:Sounding_P": [
          // On the edge the two boxes share; and one with no position.
          {
            type: "Feature",
            geometry: { type: "Point", coordinates: [22.1, 60.005] },
            properties: { DEPTH: 4, IDENTIFIER: "EDGE" }
          },
          {
            type: "Feature",
            geometry: { type: "Point", coordinates: null },
            properties: { DEPTH: 4, IDENTIFIER: "NONE" }
          }
        ]
      },
      asked
    );
    // Two boxes far enough apart to be groups of their own.
    const parts: Bbox[] = [
      [22.0, 60.0, 22.1, 60.01],
      [22.1, 60.0, 22.2, 60.01]
    ];
    const d = path.join(TMP, "edge", "FI1WFS01");
    await downloadWfsCell({
      fetch,
      url: "https://wfs.test/wfs",
      bbox: [22.0, 60.0, 22.2, 60.01],
      parts: [parts[0] as Bbox],
      dir: d,
      now: new Date("2026-11-19T12:00:00Z")
    });
    const one = JSON.parse(fs.readFileSync(path.join(d, "SOUNDG.geojson"), "utf8"));
    // The first box does not own its east edge: the second does.
    expect(one.features).toHaveLength(0);
    await downloadWfsCell({
      fetch,
      url: "https://wfs.test/wfs",
      bbox: [22.0, 60.0, 22.2, 60.01],
      parts: [parts[1] as Bbox],
      dir: d,
      now: new Date("2026-11-19T12:00:00Z")
    });
    const two = JSON.parse(fs.readFileSync(path.join(d, "SOUNDG.geojson"), "utf8"));
    expect(two.features.map((f: { properties: { LNAM: string } }) => f.properties.LNAM)).toEqual([
      "EDGE"
    ]);
  });
});
