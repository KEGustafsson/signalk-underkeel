import fs from "fs";
import path from "path";
import { haversine } from "../../src/foundation/geo";
import { readCellDirectory } from "../../src/ingest/cell-reader";
import type { WfsFetch } from "../../src/ingest/wfs";
import {
  bboxProblem,
  boxAround,
  clipRing,
  downloadWfsCell,
  WFS_LIMITS
} from "../../src/ingest/wfs";

const TMP = path.join(__dirname, "..", "temp", "wfs-ingest");
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

function reply(features: unknown[], extra: Record<string, unknown> = {}) {
  return {
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify({ type: "FeatureCollection", features, ...extra }))
  };
}

const area = {
  type: "Feature",
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [21.9, 59.9],
        [22.1, 59.9],
        [22.1, 60.1],
        [21.9, 60.1],
        [21.9, 59.9]
      ]
    ]
  },
  properties: { DRVAL1: "3", DRVAL2: "6", IDENTIFIER: "FI 3" }
};
const sounding = {
  type: "Feature",
  geometry: { type: "Point", coordinates: [22.0, 60.0, 0] },
  properties: { DEPTH: 4.2, IDENTIFIER: "FI 4" }
};

describe("Traficom WFS ingest", () => {
  test("the box around the vessel reaches the radius on every side", () => {
    const b = boxAround([22, 60], 10);
    expect(haversine([22, 60], [22, b[3]])).toBeCloseTo(10000, -1);
    expect(haversine([22, 60], [b[2], 60])).toBeCloseTo(10000, -1);
    expect(bboxProblem(b)).toBeUndefined();
    expect(bboxProblem(boxAround([22, 60], WFS_LIMITS.maxRadiusKm))).toBeUndefined();
    expect(bboxProblem([22, 60, 23, 61])).toMatch(/at most/);
    expect(bboxProblem([22, 60, 21, 61])).toMatch(/west < east/);
  });

  test("a ring is clipped to the box and a ring outside it vanishes", () => {
    const ring = clipRing(
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
        [0, 0]
      ],
      [5, -1, 20, 5]
    );
    // Closed, and exactly the part of the square inside the box.
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    const corners = ring
      .slice(0, -1)
      .map((p) => p.join(","))
      .sort();
    expect(corners).toEqual(["10,0", "10,5", "5,0", "5,5"]);
    expect(
      clipRing(
        [
          [30, 30],
          [31, 30],
          [31, 31],
          [30, 30]
        ],
        [0, 0, 10, 10]
      )
    ).toEqual([]);
  });

  test("the download asks for the box in lat, lon order and writes a readable cell", async () => {
    const urls: string[] = [];
    const fetch: WfsFetch = (url) => {
      urls.push(url);
      if (new URL(url).searchParams.get("startIndex") !== "0") {
        return Promise.resolve(reply([]));
      }
      if (url.includes("DepthArea_A")) {
        return Promise.resolve(reply([area]));
      }
      return Promise.resolve(reply(url.includes("Sounding_P") ? [sounding] : []));
    };
    const dir = path.join(TMP, "FI1WFS01");
    const counts = await downloadWfsCell({
      fetch,
      url: "https://wfs.test/wfs",
      bbox: [21.95, 59.95, 22.05, 60.05],
      dir,
      now: new Date("2026-10-18T07:00:00Z"),
      catzoc: 3
    });
    expect(counts).toEqual({ depthAreas: 1, dredgedAreas: 0, soundings: 1 });
    const q = new URL(urls[0] as string).searchParams;
    expect(q.get("bbox")).toBe("59.95,21.95,60.05,22.05,urn:ogc:def:crs:EPSG::4326");
    expect(q.get("srsName")).toBe("EPSG:4326");
    const cell = readCellDirectory(dir, 3);
    expect(cell.info).toMatchObject({
      name: "FI1WFS01",
      band: 1,
      source: "traficom-wfs",
      issueDate: "20261018"
    });
    expect(cell.features.every((f) => f.advisory === true)).toBe(true);
    const roles = cell.features.map((f) => f.role).sort();
    expect(roles).toEqual(["coverage", "depth", "depth", "quality"]);
    expect(cell.features.find((f) => f.role === "quality")).toMatchObject({
      catzoc: 3,
      lnam: "WFS-QUAL-ASSUMED"
    });
    const depths = cell.features.flatMap((f) => (f.role === "depth" ? [f.depth] : [])).sort();
    expect(depths).toEqual([3, 4.2]);
  });

  test("pages are fetched until one comes back empty", async () => {
    const starts: string[] = [];
    const fetch: WfsFetch = (url) => {
      const start = new URL(url).searchParams.get("startIndex") as string;
      starts.push(start);
      const pages = url.includes("Sounding_P")
        ? { "0": WFS_LIMITS.pageSize, [String(WFS_LIMITS.pageSize)]: 1 }
        : { "0": 1 };
      const n = (pages as Record<string, number>)[start] ?? 0;
      return Promise.resolve(reply(Array.from({ length: n }, () => sounding)));
    };
    const counts = await downloadWfsCell({
      fetch,
      url: "https://wfs.test/wfs",
      bbox: [21.95, 59.95, 22.05, 60.05],
      dir: path.join(TMP, "paged"),
      now: new Date()
    });
    expect(counts.soundings).toBe(WFS_LIMITS.pageSize + 1);
    expect(starts).toContain(String(WFS_LIMITS.pageSize));
  });

  test("a server that caps its pages below the asked count is read to the end", async () => {
    // Pages of 3, as from a server whose own limit is below WFS_LIMITS.pageSize.
    const read = async (matched: boolean): Promise<number> => {
      const fetch: WfsFetch = (url) => {
        const start = Number(new URL(url).searchParams.get("startIndex"));
        const n = url.includes("Sounding_P") ? Math.max(0, Math.min(3, 7 - start)) : 0;
        const features = Array.from({ length: n }, () => sounding);
        return Promise.resolve(reply(features, matched ? { numberMatched: 7 } : {}));
      };
      const counts = await downloadWfsCell({
        fetch,
        url: "https://wfs.test/wfs",
        bbox: [21.95, 59.95, 22.05, 60.05],
        dir: path.join(TMP, `capped-${String(matched)}`),
        now: new Date()
      });
      return counts.soundings;
    };
    expect(await read(true)).toBe(7);
    expect(await read(false)).toBe(7);
  });

  test("a server that ignores startIndex is refused after maxPages pages", async () => {
    const fetch: WfsFetch = () => Promise.resolve(reply([sounding]));
    await expect(
      downloadWfsCell({
        fetch,
        url: "https://wfs.test/wfs",
        bbox: [21.95, 59.95, 22.05, 60.05],
        dir: path.join(TMP, "endless"),
        now: new Date()
      })
    ).rejects.toThrow(`more than ${WFS_LIMITS.maxPages} pages`);
  });

  test("an HTTP error or an oversize box fails and leaves the previous cell", async () => {
    const dir = path.join(TMP, "kept");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "marker"), "old");
    const failing: WfsFetch = () =>
      Promise.resolve({ ok: false, status: 503, text: () => Promise.resolve("") });
    const d = { url: "https://wfs.test/wfs", dir, now: new Date() };
    await expect(
      downloadWfsCell({ ...d, fetch: failing, bbox: [21.95, 59.95, 22.05, 60.05] })
    ).rejects.toThrow("rajoitettu:DepthArea_A: HTTP 503");
    await expect(downloadWfsCell({ ...d, fetch: failing, bbox: [20, 59, 23, 61] })).rejects.toThrow(
      /at most/
    );
    expect(fs.readFileSync(path.join(dir, "marker"), "utf8")).toBe("old");
  });
});
