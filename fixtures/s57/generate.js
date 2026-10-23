#!/usr/bin/env node
"use strict";

// Writes fixtures/s57/FI5RAW01.000, a synthetic S-57 cell for the gdal3.js
// reader's tests: a 0.02° × 0.01° square off 60° N, 22° E with coverage,
// CATZOC B, a 2.5–10 m depth area around a land square, and two soundings.
// GDAL writes S-57 from primitive layers (nodes, edges) and feature records
// that point at them by NAME_RCNM / NAME_RCID, as it reads them with
// RETURN_PRIMITIVES, RETURN_LINKAGES and LNAM_REFS. Run from the repository root:
//
//   OGR_S57_OPTIONS=RETURN_PRIMITIVES=ON,RETURN_LINKAGES=ON,LNAM_REFS=ON node fixtures/s57/generate.js

const fs = require("fs");
const os = require("os");
const path = require("path");
const initGdalJs = require("gdal3.js/node.js");

const OUT = path.join(__dirname, "FI5RAW01.000");
const src = fs.mkdtempSync(path.join(os.tmpdir(), "s57-fixture-"));

const [W, E, S, N] = [22.0, 22.02, 60.0, 60.01];
const [LW, LE, LS, LN] = [22.008, 22.012, 60.004, 60.006];
// Connected nodes 1–4 round the coverage, 5–8 round the land.
const nodes = [
  [W, S],
  [E, S],
  [E, N],
  [W, N],
  [LW, LS],
  [LE, LS],
  [LE, LN],
  [LW, LN]
];

const write = (name, features) =>
  fs.writeFileSync(
    path.join(src, `${name}.geojson`),
    JSON.stringify({ type: "FeatureCollection", features })
  );

write(
  "ConnectedNode",
  nodes.map((p, i) => ({
    type: "Feature",
    properties: { RCNM: 120, RCID: i + 1, RVER: 1, RUIN: 1 },
    geometry: { type: "Point", coordinates: p }
  }))
);

/** Edge `rcid` from node a to node b, with one interior vertex: GDAL's Edge holds only those. */
const edge = (rcid, a, b) => {
  const [pa, pb] = [nodes[a - 1], nodes[b - 1]];
  const end = (k, node, topi) => ({
    [`NAME_RCNM_${k}`]: 120,
    [`NAME_RCID_${k}`]: node,
    [`ORNT_${k}`]: 255,
    [`USAG_${k}`]: 255,
    [`TOPI_${k}`]: topi,
    [`MASK_${k}`]: 255
  });
  return {
    type: "Feature",
    properties: { RCNM: 130, RCID: rcid, RVER: 1, RUIN: 1, ...end(0, a, 1), ...end(1, b, 2) },
    geometry: {
      type: "LineString",
      coordinates: [[(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2]]
    }
  };
};
write("Edge", [
  edge(1, 1, 2),
  edge(2, 2, 3),
  edge(3, 3, 4),
  edge(4, 4, 1),
  edge(5, 5, 6),
  edge(6, 6, 7),
  edge(7, 7, 8),
  edge(8, 8, 5)
]);
write("IsolatedNode", [
  {
    type: "Feature",
    properties: { RCNM: 110, RCID: 1, RVER: 1, RUIN: 1 },
    geometry: {
      type: "MultiPoint",
      coordinates: [
        [22.004, 60.002, 3.4],
        [22.016, 60.008, 7.1]
      ]
    }
  }
]);

let rcid = 1;
/** A feature record of class `objl` pointing at `refs`: [RCNM, RCID, ORNT, USAG]. */
const object = (objl, prim, refs, attrs) => ({
  type: "Feature",
  properties: {
    RCID: rcid,
    PRIM: prim,
    GRUP: 2,
    OBJL: objl,
    RVER: 1,
    AGEN: 550,
    FIDN: 1000 + rcid++,
    FIDS: 1,
    NAME_RCNM: refs.map((r) => r[0]),
    NAME_RCID: refs.map((r) => r[1]),
    ORNT: refs.map((r) => r[2]),
    USAG: refs.map((r) => r[3]),
    MASK: refs.map(() => 255),
    ...attrs
  },
  geometry: null
});
const outer = [1, 2, 3, 4].map((e) => [130, e, 1, 1]);
const hole = [8, 7, 6, 5].map((e) => [130, e, 2, 2]);
const land = [5, 6, 7, 8].map((e) => [130, e, 1, 1]);
write("M_COVR", [object(302, 3, outer, { CATCOV: 1 })]);
write("M_QUAL", [object(308, 3, outer, { CATZOC: 2 })]);
write("DEPARE", [object(42, 3, [...outer, ...hole], { DRVAL1: 2.5, DRVAL2: 10 })]);
write("LNDARE", [object(71, 3, land, {})]);
write("SOUNDG", [object(129, 1, [[110, 1, 255, 255]], {})]);

const layers = ["ConnectedNode", "Edge", "IsolatedNode", "M_COVR", "M_QUAL", "DEPARE", "LNDARE", "SOUNDG"];
fs.writeFileSync(
  path.join(src, "cell.vrt"),
  `<OGRVRTDataSource>${layers
    .map(
      (l) =>
        `<OGRVRTLayer name="${l}"><SrcDataSource relativeToVRT="1">${l}.geojson</SrcDataSource></OGRVRTLayer>`
    )
    .join("")}</OGRVRTDataSource>`
);

const DSID = {
  S57_EXPP: 1,
  S57_INTU: 5,
  S57_EDTN: 1,
  S57_UPDN: 0,
  S57_UADT: "20261001",
  S57_ISDT: "20261001",
  S57_STED: "03.1",
  S57_AGEN: 550,
  S57_COMT: "synthetic test cell",
  S57_NOMR: 5,
  S57_NOGR: 5,
  S57_NOLR: 0,
  S57_NOIN: 1,
  S57_NOCN: 8,
  S57_NOED: 8,
  S57_HDAT: 2,
  S57_VDAT: 12,
  S57_SDAT: 12,
  S57_CSCL: 12000,
  S57_COMF: 10000000,
  S57_SOMF: 10
};

(async () => {
  const dist = path.join(path.dirname(require.resolve("gdal3.js/node.js")), "dist", "package");
  const gdal = await initGdalJs({
    path: path.relative(process.cwd(), dist) || ".",
    logHandler: () => undefined,
    errorHandler: (m) => console.error(`GDAL: ${m}`)
  });
  const { datasets, errors } = await gdal.open(path.join(src, "cell.vrt"));
  if (!datasets[0]) {
    throw new Error(`cannot open the layers: ${JSON.stringify(errors)}`);
  }
  const dsco = Object.entries(DSID).flatMap(([k, v]) => ["-dsco", `${k}=${v}`]);
  const out = await gdal.ogr2ogr(datasets[0], ["-f", "S57", ...dsco], "FI5RAW01");
  fs.writeFileSync(OUT, gdal.Module.FS.readFile(out.local));
  fs.rmSync(src, { recursive: true, force: true });
  console.log(`wrote ${path.relative(process.cwd(), OUT)}, ${fs.statSync(OUT).size} bytes`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
