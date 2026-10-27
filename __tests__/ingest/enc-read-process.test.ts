import fs from "fs";
import os from "os";
import path from "path";
import { readInChild, readInProcess } from "../../src/ingest/enc-read-process";

/**
 * S-57 cells read in a short-lived child process, so gdal3.js's WebAssembly memory leaves with
 * it. The child runs the compiled lib/, which `npm run build` makes.
 */

const LIB_READER = path.resolve(__dirname, "..", "..", "lib", "ingest", "enc-read-process.js");
const S57 = path.resolve(__dirname, "..", "..", "fixtures", "s57");
const RAW = path.join(S57, "FI5RAW01.000");

if (!fs.existsSync(LIB_READER)) {
  throw new Error("lib/ is not built: run `npm run build` before the tests");
}

const bytes = (layers: Record<string, Uint8Array>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(layers).map(([k, v]) => [k, Buffer.from(v).toString("base64")])
  );

test("a child process reads the layers an in-process read gets, in shared memory", async () => {
  const files = [RAW, RAW];
  const [child, inline] = await Promise.all([
    readInChild(256, LIB_READER)(files),
    readInProcess([RAW])
  ]);
  expect([...child.keys()]).toEqual([RAW]);
  const layers = child.get(RAW) as Record<string, Uint8Array>;
  expect(Object.values(layers).every((v) => v.buffer instanceof SharedArrayBuffer)).toBe(true);
  expect(bytes(layers)).toEqual(bytes(inline.get(RAW) as Record<string, Uint8Array>));
}, 30_000);

test("no cell to read starts no process", async () => {
  await expect(readInChild(256, "/nonexistent/reader.js")([])).resolves.toEqual(new Map());
});

test("a cell GDAL cannot read fails the read with GDAL's error", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-reader-"));
  try {
    const bad = path.join(dir, "BROKEN.000");
    fs.writeFileSync(bad, "not an ISO 8211 file");
    await expect(readInChild(256, LIB_READER)([bad])).rejects.toThrow(/GDAL cannot read/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

test("a reader that exits before every cell is read fails the read", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-reader-"));
  try {
    const quits = path.join(dir, "quits.js");
    fs.writeFileSync(quits, 'process.once("message", () => process.exit(5));');
    await expect(readInChild(256, quits)([RAW])).rejects.toThrow(
      "S-57 cell reader exited with code 5 before every cell was read"
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
