#!/usr/bin/env node
"use strict";

// Writes the synthetic S-57 cells the tests read with gdal3.js:
//
// - fixtures/s57/FI5RAW01.000: a 0.02° × 0.01° square off 60° N, 22° E with
//   coverage, CATZOC B, a 2.5–10 m depth area around a land square, two soundings
//   and a compilation scale of 1:12 000.
// - fixtures/s57/synth/FI4SYNTH.000 and FI5SYNTH.000: the scenario of
//   fixtures/enc (scripts/make-synthetic-enc.js) as S-57 cells, so the plugin
//   tests start from cells as delivered.
//
// GDAL writes S-57 from primitive layers (nodes, edges) and feature records that
// point at them by NAME_RCNM / NAME_RCID, as it reads them with RETURN_PRIMITIVES,
// RETURN_LINKAGES and LNAM_REFS. Each polygon ring here is one closed edge from a
// connected node at its first vertex. Run from the repository root:
//
//   OGR_S57_OPTIONS=RETURN_PRIMITIVES=ON,RETURN_LINKAGES=ON,LNAM_REFS=ON node fixtures/s57/generate.js

const fs = require("fs");
const os = require("os");
const path = require("path");
const initGdalJs = require("gdal3.js/node.js");

const ENC = path.resolve(__dirname, "..", "enc");

/** S-57 object class codes of the layers the fixtures use. */
const OBJL = { DEPARE: 42, LNDARE: 71, M_COVR: 302, M_QUAL: 308, SOUNDG: 129, SWPARE: 134, UWTROC: 153 };
/** Attributes carried over from the GeoJSON layers. */
const ATTRIBUTES = ["DRVAL1", "DRVAL2", "CATCOV", "CATZOC", "VALSOU", "WATLEV"];

/**
 * Collects primitives and feature records for one cell. Areas get one closed
 * edge per ring; points an isolated node (soundings with their depths).
 */
function cellLayers() {
  const out = { ConnectedNode: [], Edge: [], IsolatedNode: [], objects: {} };
  let fidn = 1000;
  const feature = (rcnm, rcid, props, geometry) => ({
    type: "Feature",
    properties: { RCNM: rcnm, RCID: rcid, RVER: 1, RUIN: 1, ...props },
    geometry
  });
  const ring = (coords, usag) => {
    const node = out.ConnectedNode.length + 1;
    out.ConnectedNode.push(feature(120, node, {}, { type: "Point", coordinates: coords[0] }));
    const edge = out.Edge.length + 1;
    const end = (k, topi) => ({
      [`NAME_RCNM_${k}`]: 120,
      [`NAME_RCID_${k}`]: node,
      [`ORNT_${k}`]: 255,
      [`USAG_${k}`]: 255,
      [`TOPI_${k}`]: topi,
      [`MASK_${k}`]: 255
    });
    // GDAL's Edge holds only the interior vertices; both ends are the node.
    const interior = coords.slice(1, -1);
    out.Edge.push(
      feature(130, edge, { ...end(0, 1), ...end(1, 2) }, { type: "LineString", coordinates: interior })
    );
    return [130, edge, 1, usag];
  };
  const point = (geometry) => {
    const rcid = out.IsolatedNode.length + 1;
    out.IsolatedNode.push(feature(110, rcid, {}, geometry));
    return [110, rcid, 255, 255];
  };
  return {
    out,
    add(layer, geometry, props = {}) {
      let refs;
      let prim;
      if (geometry.type === "Polygon") {
        refs = geometry.coordinates.map((r, i) => ring(r, i === 0 ? 1 : 2));
        prim = 3;
      } else {
        refs = [point(geometry)];
        prim = 1;
      }
      const attrs = Object.fromEntries(ATTRIBUTES.filter((a) => props[a] !== undefined).map((a) => [a, props[a]]));
      (out.objects[layer] ??= []).push({
        type: "Feature",
        properties: {
          RCID: fidn - 999,
          PRIM: prim,
          GRUP: 2,
          OBJL: OBJL[layer],
          RVER: 1,
          AGEN: 550,
          FIDN: fidn++,
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
    }
  };
}

/** Writes `layers` as the S-57 cell `file` with the DSID creation options `dsid`. */
async function writeCell(gdal, file, layers, dsid) {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "s57-fixture-"));
  const all = { ConnectedNode: layers.ConnectedNode, Edge: layers.Edge, IsolatedNode: layers.IsolatedNode, ...layers.objects };
  const names = Object.keys(all).filter((l) => all[l].length > 0);
  for (const name of names) {
    fs.writeFileSync(
      path.join(src, `${name}.geojson`),
      JSON.stringify({ type: "FeatureCollection", features: all[name] })
    );
  }
  fs.writeFileSync(
    path.join(src, "cell.vrt"),
    `<OGRVRTDataSource>${names
      .map((l) => `<OGRVRTLayer name="${l}"><SrcDataSource relativeToVRT="1">${l}.geojson</SrcDataSource></OGRVRTLayer>`)
      .join("")}</OGRVRTDataSource>`
  );
  const { datasets, errors } = await gdal.open(path.join(src, "cell.vrt"));
  if (!datasets[0]) {
    throw new Error(`cannot open the layers of ${file}: ${JSON.stringify(errors)}`);
  }
  const options = {
    S57_EXPP: 1,
    S57_INTU: 5,
    S57_STED: "03.1",
    S57_AGEN: 550,
    S57_COMT: "synthetic test cell",
    S57_HDAT: 2,
    S57_COMF: 10000000,
    S57_SOMF: 10,
    ...dsid
  };
  const dsco = Object.entries(options).flatMap(([k, v]) => ["-dsco", `${k}=${v}`]);
  const name = path.basename(file, ".000");
  const out = await gdal.ogr2ogr(datasets[0], ["-f", "S57", ...dsco], name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, gdal.Module.FS.readFile(out.local));
  gdal.Module.FS.unlink(out.local);
  await gdal.close(datasets[0]);
  fs.rmSync(src, { recursive: true, force: true });
  console.log(`wrote ${path.relative(process.cwd(), file)}, ${fs.statSync(file).size} bytes`);
}

function raw01() {
  const c = cellLayers();
  const square = (w, s, e, n) => ({
    type: "Polygon",
    coordinates: [
      [
        [w, s],
        [e, s],
        [e, n],
        [w, n],
        [w, s]
      ]
    ]
  });
  const outer = square(22.0, 60.0, 22.02, 60.01);
  const land = square(22.008, 60.004, 22.012, 60.006);
  c.add("M_COVR", outer, { CATCOV: 1 });
  c.add("M_QUAL", outer, { CATZOC: 2 });
  // The land square is a hole in the depth area, its ring the other way round.
  c.add("DEPARE", { type: "Polygon", coordinates: [outer.coordinates[0], [...land.coordinates[0]].reverse()] }, { DRVAL1: 2.5, DRVAL2: 10 });
  c.add("LNDARE", land);
  c.add("SOUNDG", {
    type: "MultiPoint",
    coordinates: [
      [22.004, 60.002, 3.4],
      [22.016, 60.008, 7.1]
    ]
  });
  return c.out;
}

/** A fixtures/enc cell directory as layers; its DSID gives the edition, update and datums. */
function fromDirectory(dir) {
  const c = cellLayers();
  const read = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".geojson") && f !== "DSID.geojson")) {
    for (const ft of read(f).features) {
      c.add(path.basename(f, ".geojson"), ft.geometry, ft.properties ?? {});
    }
  }
  const p = read("DSID.geojson").features[0].properties;
  const dsid = {
    S57_EDTN: p.DSID_EDTN,
    S57_UPDN: p.DSID_UPDN,
    S57_UADT: p.DSID_ISDT,
    S57_ISDT: p.DSID_ISDT,
    // No compilation scale: the GeoJSON cells state none.
    S57_CSCL: 0,
    ...(p.DSPM_VDAT !== undefined ? { S57_VDAT: p.DSPM_VDAT } : {}),
    ...(p.DSPM_SDAT !== undefined ? { S57_SDAT: p.DSPM_SDAT } : {})
  };
  return { layers: c.out, dsid };
}

(async () => {
  const dist = path.join(path.dirname(require.resolve("gdal3.js/node.js")), "dist", "package");
  const gdal = await initGdalJs({
    path: path.relative(process.cwd(), dist) || ".",
    logHandler: () => undefined,
    errorHandler: (m) => console.error(`GDAL: ${m}`)
  });
  await writeCell(gdal, path.join(__dirname, "FI5RAW01.000"), raw01(), {
    S57_EDTN: 1,
    S57_UPDN: 0,
    S57_UADT: "20261001",
    S57_ISDT: "20261001",
    S57_VDAT: 12,
    S57_SDAT: 12,
    S57_CSCL: 12000
  });
  for (const cell of ["FI4SYNTH", "FI5SYNTH"]) {
    const { layers, dsid } = fromDirectory(path.join(ENC, cell));
    await writeCell(gdal, path.join(__dirname, "synth", `${cell}.000`), layers, dsid);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
