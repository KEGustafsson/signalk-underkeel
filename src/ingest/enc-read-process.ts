import { isMainThread } from "worker_threads";
import { exitWithParent, forkLimited, sendToParent } from "../foundation/child-process";
import type { EncLayers } from "./enc-wasm";
import { readEncLayers, readEncParts, sharedLayers } from "./enc-wasm";

/**
 * S-57 cells read through gdal3.js in a child process that exits once they are read. Read in
 * the build itself, gdal3.js's WebAssembly memory (512 MB declared, 250–300 MB resident after
 * the 20 Waddenzee cells, x86) stayed resident through the region build, so the build's peak
 * RSS was the two phases' sum. Each cell's layers come back in a message of their own, so
 * neither process holds a serialized copy of every cell at once.
 */

/** The layers of each `.000` file in `files`. */
export type EncReader = (files: readonly string[]) => Promise<Map<string, EncLayers>>;

/** Reads on the calling thread; the WebAssembly memory stays with it. */
export const readInProcess: EncReader = async (files) => {
  const out = new Map<string, EncLayers>();
  for (const file of files) {
    out.set(file, await readEncLayers(file));
  }
  return out;
};

interface ReadReply {
  file?: string;
  layers?: Record<string, Uint8Array>;
  error?: string;
}

/**
 * Reads in a child process running the compiled `script`, its heap capped at `heapMb`. It
 * joins this process's process group, so a build killed from outside ends it too. A child
 * that exits before every cell has come back fails the read.
 */
export function readInChild(heapMb: number, script = __filename): EncReader {
  return (files) => {
    const want = [...new Set(files)];
    if (want.length === 0) {
      return Promise.resolve(new Map());
    }
    return new Promise((resolve, reject) => {
      const { child, stderr, outOfMemory } = forkLimited(script, heapMb);
      const out = new Map<string, EncLayers>();
      let failure: Error | undefined;
      child.on("message", (m: ReadReply) => {
        if (m.error !== undefined) {
          failure ??= new Error(m.error);
        } else if (m.file !== undefined && m.layers) {
          out.set(m.file, sharedLayers(new Map(Object.entries(m.layers))));
        }
      });
      child.once("error", (err) => (failure ??= err));
      child.once("close", (code: number | null, signal: string | null) => {
        if (failure === undefined && want.every((f) => out.has(f))) {
          resolve(out);
          return;
        }
        const end = code === null ? `signal ${signal ?? "?"}` : `code ${code}`;
        reject(
          failure ??
            new Error(
              outOfMemory()
                ? `S-57 cell reader stopped at the ${heapMb} MB heap limit: ${stderr()}`
                : `S-57 cell reader exited with ${end} before every cell was read: ${stderr()}`
            )
        );
      });
      // A child that cannot take the job exits, and "close" reports it.
      child.send({ files: want }, () => undefined);
    });
  };
}

/** The child: reads each cell, sends its layers, and exits. */
async function serve(files: string[]): Promise<void> {
  for (const file of files) {
    const parts = await readEncParts(file);
    await sendToParent({ file, layers: Object.fromEntries(parts) } satisfies ReadReply);
  }
}

if (isMainThread && require.main === module && process.send) {
  exitWithParent();
  process.once("message", (m: { files: string[] }) => {
    serve(m.files).then(
      () => process.exit(0),
      (err: Error) =>
        sendToParent({ error: err.message } satisfies ReadReply).finally(() => process.exit(1))
    );
  });
}
