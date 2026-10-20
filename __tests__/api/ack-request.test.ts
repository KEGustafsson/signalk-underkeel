import { parseAckRequest } from "../../src/api/ack-request";

/** `POST /acks` polygons get the same checks as `POST /query` polygons. */

const polygon = (...rings: number[][][]) => ({ polygon: { type: "Polygon", coordinates: rings } });
const SQUARE = [
  [22.0, 60.0],
  [22.01, 60.0],
  [22.01, 60.01],
  [22.0, 60.01],
  [22.0, 60.0]
];
const errors = (body: unknown) => {
  const r = parseAckRequest(body);
  return r.ok ? [] : r.errors;
};

describe("POST /acks polygon", () => {
  test("a closed ring is kept without its closing position", () => {
    const r = parseAckRequest(polygon(SQUARE));
    expect(r.ok && r.value.polygon).toEqual(SQUARE.slice(0, -1));
  });

  test("an unclosed ring, a hole, a ±180° crossing and a whole-world box are refused", () => {
    expect(errors(polygon(SQUARE.slice(0, -1).concat([[22.0, 60.005]])))).toEqual([
      "polygon outer ring must be closed"
    ]);
    const hole = [
      [22.004, 60.004],
      [22.006, 60.004],
      [22.006, 60.006],
      [22.004, 60.004]
    ];
    expect(errors(polygon(SQUARE, hole))).toEqual(["polygon holes are not supported"]);
    const across = [
      [179.9, 60.0],
      [-179.9, 60.0],
      [-179.9, 60.01],
      [179.9, 60.0]
    ];
    expect(errors(polygon(across))).toEqual(["polygon must fit in a box 50 km across"]);
    const world = [
      [-180, -85],
      [180, -85],
      [180, 85],
      [-180, 85],
      [-180, -85]
    ];
    expect(errors(polygon(world))).toEqual(["polygon must fit in a box 50 km across"]);
  });

  test("a geometry that is not a Polygon is refused", () => {
    expect(errors({ polygon: { type: "Point", coordinates: [22, 60] } })).toEqual([
      "polygon must be a GeoJSON Polygon"
    ]);
  });
});
