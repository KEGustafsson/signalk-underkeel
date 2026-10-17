#!/usr/bin/env node
"use strict";

// Writes the synthetic ENC fixtures in fixtures/enc/ in the layout that
// scripts/enc-to-geojson.sh produces from a real .000 cell (one GeoJSON
// FeatureCollection per S-57 layer, plus DSID.geojson). Re-run after
// changing the scenario; the output is committed.
//
// Scenario (plan §7): a rock inside a swept fairway, a CATZOC C bank, a
// coverage gap, and two overlapping usage bands.

const fs = require("fs");
const path = require("path");

const OUT = path.resolve(__dirname, "..", "fixtures", "enc");

function rect(w, s, e, n) {
  return {
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
  };
}

function feature(geometry, properties) {
  return { type: "Feature", geometry, properties };
}

function collection(features) {
  return { type: "FeatureCollection", features };
}

const CELLS = {
  FI5SYNTH: {
    DSID: [
      feature(null, {
        DSID_DSNM: "FI5SYNTH.000",
        DSID_EDTN: "3",
        DSID_UPDN: "1",
        DSID_ISDT: "20260101",
        DSPM_VDAT: 13,
        DSPM_SDAT: 13
      })
    ],
    // Coverage stops at 22.035 E; band 4 fills to 22.038 E, east of that is a gap.
    M_COVR: [feature(rect(22.0, 60.0, 22.035, 60.02), { CATCOV: 1, LNAM: "FI5-COVR" })],
    M_QUAL: [
      feature(rect(22.0, 60.008, 22.035, 60.02), { CATZOC: 2, LNAM: "FI5-QUAL-A2" }),
      feature(rect(22.0, 60.0, 22.035, 60.008), { CATZOC: 4, LNAM: "FI5-QUAL-C" })
    ],
    DEPARE: [
      feature(rect(22.0, 60.0, 22.035, 60.02), { DRVAL1: 10, DRVAL2: 20, LNAM: "FI5-DEP-10" }),
      feature(rect(22.01, 60.003, 22.015, 60.006), { DRVAL1: 2, DRVAL2: 5, LNAM: "FI5-BANK" })
    ],
    SWPARE: [feature(rect(22.0, 60.009, 22.035, 60.011), { DRVAL1: 8, LNAM: "FI5-SWEPT" })],
    UWTROC: [
      feature(
        { type: "Point", coordinates: [22.02, 60.01] },
        { VALSOU: 3.5, WATLEV: 3, LNAM: "FI5-ROCK" }
      )
    ],
    SOUNDG: [
      feature(
        {
          type: "MultiPoint",
          coordinates: [
            [22.005, 60.015, 12.3],
            [22.012, 60.0045, 1.8]
          ]
        },
        { LNAM: "FI5-SNDG" }
      )
    ],
    LNDARE: [feature(rect(22.025, 60.013, 22.03, 60.016), { LNAM: "FI5-ISLAND" })]
  },
  FI4SYNTH: {
    DSID: [
      feature(null, {
        DSID_DSNM: "FI4SYNTH.000",
        DSID_EDTN: "7",
        DSID_UPDN: "0",
        DSID_ISDT: "20250601"
      })
    ],
    M_COVR: [feature(rect(21.99, 59.99, 22.038, 60.03), { CATCOV: 1 })],
    M_QUAL: [feature(rect(21.99, 59.99, 22.038, 60.03), { CATZOC: 3 })],
    DEPARE: [feature(rect(21.99, 59.99, 22.038, 60.03), { DRVAL1: 5, DRVAL2: 10 })]
  }
};

for (const [cell, layers] of Object.entries(CELLS)) {
  const dir = path.join(OUT, cell);
  fs.mkdirSync(dir, { recursive: true });
  for (const [layer, features] of Object.entries(layers)) {
    fs.writeFileSync(
      path.join(dir, `${layer}.geojson`),
      `${JSON.stringify(collection(features), null, 2)}\n`
    );
  }
  console.log(`wrote ${dir}`);
}
