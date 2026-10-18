import { encodeMvt, MVT_EXTENT } from "../../src/api/mvt";
import { decodeMvt } from "../helpers/mvt-decode";

describe("vector tile encoder", () => {
  test("writes one version-2 layer with polygon features and string properties", () => {
    const tile = encodeMvt("ukc", [
      {
        rings: [
          [
            [0, 0],
            [64, 0],
            [64, 64],
            [0, 64]
          ],
          [
            [128, 0],
            [4096, 0],
            [4096, 64],
            [128, 64]
          ]
        ],
        properties: { class: "danger" }
      },
      { rings: [], properties: { class: "empty" } },
      {
        rings: [
          [
            [0, 64],
            [64, 64],
            [64, 4096],
            [0, 4096]
          ]
        ],
        properties: { class: "clear" }
      }
    ]);
    const [layer, ...rest] = decodeMvt(tile);
    expect(rest).toEqual([]);
    expect(layer).toMatchObject({ version: 2, name: "ukc", extent: MVT_EXTENT });
    expect(layer?.features.map((f) => [f.type, f.properties])).toEqual([
      [3, { class: "danger" }],
      [3, { class: "clear" }]
    ]);
    // Cursor continues across rings: the second ring's MoveTo is relative to (0, 64).
    expect(layer?.features[0]?.rings).toEqual([
      [
        [0, 0],
        [64, 0],
        [64, 64],
        [0, 64]
      ],
      [
        [128, 0],
        [4096, 0],
        [4096, 64],
        [128, 64]
      ]
    ]);
    // The cursor resets per feature: the next feature's MoveTo is relative to (0, 0).
    expect(layer?.features[1]?.rings[0]?.[0]).toEqual([0, 64]);
  });

  test("an empty tile is still a valid layer", () => {
    expect(decodeMvt(encodeMvt("ukc", []))).toEqual([
      { version: 2, name: "ukc", extent: MVT_EXTENT, features: [] }
    ]);
  });
});
