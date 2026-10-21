import fs from "fs";
import os from "os";
import path from "path";
import { fileReaderAsync, readsSettled } from "../../src/spatial/block-reader";

/**
 * A read off the event loop holds its file open across turns; a commit over
 * the directory waits for `readsSettled`, since Windows refuses to rename a
 * directory with an open file in it.
 */

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-reader-"));
  fs.writeFileSync(path.join(dir, "pyramid.bin"), Buffer.alloc(1024, 7));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

test("readsSettled waits for every read under the directory, and only those", async () => {
  const reader = await fileReaderAsync(path.join(dir, "pyramid.bin"));
  let settled = false;
  const reads = [reader.read(0, 512), reader.read(512, 512)];
  const waited = readsSettled(dir).then(() => (settled = true));
  await expect(readsSettled(os.tmpdir())).resolves.toBeUndefined();
  expect(settled).toBe(false);
  const bodies = await Promise.all(reads);
  await waited;
  expect(settled).toBe(true);
  expect(bodies.map((b) => b.length)).toEqual([512, 512]);
});

test("a failed read settles too", async () => {
  const reader = await fileReaderAsync(path.join(dir, "pyramid.bin"));
  const read = reader.read(1000, 512);
  await expect(readsSettled(dir)).resolves.toBeUndefined();
  await expect(read).rejects.toThrow(/truncated/);
});
