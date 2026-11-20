import type { LonLat } from "../../src/foundation/geo";
import { tracksOf } from "../../src/livechart/tracks";
import type { Sounding } from "../../src/livechart/soundings";
import { trackObjects } from "../../src/planning-objects";

/** The boat's own passages from its soundings, a planner's preference (plan §4.13). */

const T0 = Date.parse("2026-07-01T10:00:00Z");

/** A sounding `i` seconds in, `i` × 5 m east, taken at water `level` above chart datum. */
const at = (i: number, level = 0.3, t = T0 + i * 1000): Sounding => ({
  position: [22 + (i * 5) / 55_600, 60] as LonLat,
  at: t,
  belowSurface: 4 + level,
  depth: 4,
  sigma: 0.2
});

describe("own tracks", () => {
  test("soundings close in time and space are one track, a point every 25 m or more", () => {
    const [t] = tracksOf(Array.from({ length: 60 }, (_, i) => at(i)));
    expect(t?.coordinates.length).toBeGreaterThan(5);
    expect(t?.coordinates.length).toBeLessThan(20);
    expect(t?.level).toBeCloseTo(0.3, 9);
  });

  test("a gap in time or a jump in position starts another; one point is no track", () => {
    const gap = [at(0), at(10), at(20, 0.3, T0 + 600_000), at(30, 0.3, T0 + 610_000), at(5000)];
    const tracks = tracksOf(gap);
    expect(tracks).toHaveLength(2);
  });

  test("a track keeps the highest water it was sailed at", () => {
    const [t] = tracksOf([at(0, 0.1), at(10, 0.6), at(20, 0.2)]);
    expect(t?.level).toBeCloseTo(0.6, 9);
  });

  test("a planner gets a track only at water no lower than it was sailed at, and only where known", () => {
    const tracks = tracksOf(Array.from({ length: 30 }, (_, i) => at(i, 0.5)));
    const box: [LonLat, LonLat] = [
      [21.99, 59.99],
      [22.01, 60.01]
    ];
    expect(trackObjects(tracks, ...box, () => 0.6)).toEqual([
      expect.objectContaining({ class: "TRACK" })
    ]);
    expect(trackObjects(tracks, ...box, () => 0.4)).toEqual([]);
    expect(trackObjects(tracks, ...box, () => undefined)).toEqual([]);
    expect(trackObjects(tracks, [23, 61], [23.1, 61.1], () => 1)).toEqual([]);
  });

  test("the water is asked at every point a track keeps, not its ends and middle alone", () => {
    const [track] = tracksOf(Array.from({ length: 60 }, (_, i) => at(i, 0.5)));
    const c = (track as { coordinates: LonLat[] }).coordinates;
    const shallow = c[1] as LonLat;
    const low = (points: readonly LonLat[]) =>
      points.some((p) => p[0] === shallow[0] && p[1] === shallow[1]) ? 0.4 : 0.6;
    expect(trackObjects([track as never], [21.99, 59.99], [22.01, 60.01], low)).toEqual([]);
  });

  test("a passage across ±180° is cut there: it meets no box near Greenwich", () => {
    const track = {
      coordinates: [
        [179.999, 60],
        [-179.999, 60]
      ] as LonLat[],
      level: 0.2
    };
    expect(trackObjects([track], [-1, 59], [1, 61], () => 0.5)).toEqual([]);
    const near = trackObjects([track], [179.99, 59.99], [180, 60.01], () => 0.5);
    expect(near).toHaveLength(1);
    const lons = (near[0]?.geometry.coordinates as LonLat[]).map((p) => p[0]);
    expect(Math.max(...lons) - Math.min(...lons)).toBeLessThan(0.01);
  });

  test("a track is listed where its leg crosses the box with no point inside it", () => {
    const track = {
      coordinates: [
        [22, 60],
        [22.001, 60]
      ] as LonLat[],
      level: 0.2
    };
    expect(trackObjects([track], [22.0004, 59.9999], [22.0006, 60.0001], () => 0.5)).toHaveLength(
      1
    );
    expect(trackObjects([track], [22.0004, 60.0001], [22.0006, 60.0002], () => 0.5)).toEqual([]);
  });
});
