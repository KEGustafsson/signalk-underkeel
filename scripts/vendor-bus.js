#!/usr/bin/env node
"use strict";

// Copies the browser build of the reference Plotter Extensions client
// (signalk-plotterext-bus, MIT) into public/vendor/, where the extension
// pages import it from. Run by `npm run build`; the copy is not committed.

const fs = require("fs");
const path = require("path");

// The package exports only its entry points, so resolve one and walk up to dist/.
const dist = path.dirname(require.resolve("signalk-plotterext-bus/extension"));
const pkgDir = path.dirname(dist);
const out = path.resolve(__dirname, "..", "public", "vendor", "plotterext-bus");

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const files = fs
  .readdirSync(dist)
  .filter((f) => f === "extension.js" || /^chunk-[A-Z0-9]+\.js$/.test(f));
for (const f of files) {
  fs.copyFileSync(path.join(dist, f), path.join(out, f));
}
fs.copyFileSync(path.join(pkgDir, "LICENSE"), path.join(out, "LICENSE"));
console.log(`vendored ${files.length} files to ${path.relative(process.cwd(), out)}`);
