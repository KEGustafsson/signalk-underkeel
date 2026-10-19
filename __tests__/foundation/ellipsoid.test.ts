import { mercatorYToLat, offset, toMercator } from "../../src/foundation/geo";
import { mercatorBuffer } from "../../src/spatial/pyramid";

// WGS84 meridian and parallel arcs, the ground the chart is surveyed on.
const A = 6378137;
const F = 1 / 298.257223563;
const E2 = F * (2 - F);
const DEG = Math.PI / 180;
const meridianRadius = (phi: number) => (A * (1 - E2)) / (1 - E2 * Math.sin(phi) ** 2) ** 1.5;
const primeVertical = (phi: number) => A / Math.sqrt(1 - E2 * Math.sin(phi) ** 2);

function meridianArc(lat0: number, lat1: number): number {
  const n = 2000;
  const step = ((lat1 - lat0) / n) * DEG;
  let s = 0;
  for (let i = 0; i < n; i++) {
    s += meridianRadius((lat0 + ((i + 0.5) * (lat1 - lat0)) / n) * DEG) * step;
  }
  return Math.abs(s);
}

const parallelArc = (lat: number, dLon: number) =>
  primeVertical(lat * DEG) * Math.cos(lat * DEG) * Math.abs(dLon) * DEG;

const LATS = [0, 10, 30, 45, 55, 60, 70, 80];

describe("ground distances on the WGS84 ellipsoid", () => {
  test.each(LATS)("a 100 m buffer at %d° reaches at least 100 m every way", (lat) => {
    const [x, y] = toMercator(20, lat);
    const b = mercatorBuffer({ minX: x, minY: y, maxX: x, maxY: y }, 100);
    expect(meridianArc(lat, mercatorYToLat(y + b))).toBeGreaterThanOrEqual(100);
    expect(meridianArc(mercatorYToLat(y - b), lat)).toBeGreaterThanOrEqual(100);
    expect(parallelArc(lat, b / A / DEG)).toBeGreaterThanOrEqual(100);
  });

  test.each(LATS)("offset at %d° lands within 5 cm of 1000 m", (lat) => {
    const north = offset([20, lat], 0, 1000);
    const south = offset([20, lat], 0, -1000);
    const east = offset([20, lat], 1000, 0);
    expect(meridianArc(lat, north[1])).toBeCloseTo(1000, 1);
    expect(meridianArc(south[1], lat)).toBeCloseTo(1000, 1);
    expect(parallelArc(lat, east[0] - 20)).toBeCloseTo(1000, 1);
  });
});
