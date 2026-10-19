import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const SCRIPT = path.resolve(__dirname, "..", "..", "scripts", "enc-to-geojson.sh");

// The script is POSIX sh; Windows runners have no sh on PATH.
const onPosix = process.platform === "win32" ? describe.skip : describe;

/**
 * Stand-in GDAL: ogrinfo opens the source unless FAKE_OPEN_FAILS is set and
 * reports a layer present when it is in FAKE_LAYERS; ogr2ogr writes the
 * .geojson argument it is given.
 */
const OGRINFO = `#!/bin/sh
if [ $# -eq 3 ]; then [ -z "\${FAKE_OPEN_FAILS:-}" ]; exit $?; fi
case " $FAKE_LAYERS " in *" $4 "*) exit 0 ;; esac
exit 1
`;
const OGR2OGR = `#!/bin/sh
for a in "$@"; do case "$a" in *.geojson) echo '{}' > "$a" ;; esac; done
`;

let tmp: string;
let bin: string;
let src: string;

/** PATH with sh's helpers but no GDAL, plus the fakes when `gdal` is set. */
function pathFor(gdal: boolean): string {
  const tools = path.join(tmp, "tools");
  fs.mkdirSync(tools, { recursive: true });
  for (const tool of ["ls", "mkdir"]) {
    const found = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
    if (!fs.existsSync(path.join(tools, tool))) {
      fs.symlinkSync(found, path.join(tools, tool));
    }
  }
  return gdal ? `${bin}${path.delimiter}${tools}` : tools;
}

function run(opts: { gdal?: boolean; source?: string; env?: Record<string, string> } = {}) {
  const out = path.join(tmp, "out");
  const r = spawnSync("/bin/sh", [SCRIPT, opts.source ?? src, out], {
    encoding: "utf8",
    env: { PATH: pathFor(opts.gdal ?? true), FAKE_LAYERS: "DSID DEPARE M_COVR", ...opts.env }
  });
  return { status: r.status, stderr: r.stderr, out };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "enc-to-geojson-"));
  bin = path.join(tmp, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "ogrinfo"), OGRINFO, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "ogr2ogr"), OGR2OGR, { mode: 0o755 });
  src = path.join(tmp, "FI5ABCDE.000");
  fs.writeFileSync(src, "");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

onPosix("scripts/enc-to-geojson.sh", () => {
  test("exports the layers the cell has and exits 0", () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(fs.readdirSync(r.out).sort()).toEqual([
      "DEPARE.geojson",
      "DSID.geojson",
      "M_COVR.geojson"
    ]);
  });

  test("fails without GDAL on PATH", () => {
    const r = run({ gdal: false });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/ogrinfo/);
  });

  test("fails when the source is missing", () => {
    const r = run({ source: path.join(tmp, "nonexist.000") });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/nonexist\.000/);
  });

  test("fails when GDAL cannot open the source", () => {
    const r = run({ env: { FAKE_OPEN_FAILS: "1" } });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/cannot open/);
  });

  test("fails when the export has no M_COVR coverage", () => {
    const r = run({ env: { FAKE_LAYERS: "DSID DEPARE" } });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/M_COVR/);
  });
});
