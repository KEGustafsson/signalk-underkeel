import fs from "fs";
import path from "path";

/** Where blocks are read from: the file a store was opened from, or a buffer holding it. */
export interface BlockReader {
  readonly size: number;
  readSync(offset: number, bytes: number): Buffer;
  read(offset: number, bytes: number): Promise<Buffer>;
}

export function bufferReader(buf: Buffer): BlockReader {
  const slice = (offset: number, bytes: number): Buffer => {
    if (offset + bytes > buf.length) {
      throw new Error("pyramid file is truncated");
    }
    return buf.subarray(offset, offset + bytes);
  };
  return {
    size: buf.length,
    readSync: slice,
    read: (offset, bytes) => Promise.resolve().then(() => slice(offset, bytes))
  };
}

type Identity = Pick<fs.Stats, "ino" | "size" | "mtimeMs">;

/**
 * A rebuild renames a new file into the same path, and its blocks lie
 * elsewhere: a read from a file other than the one opened is refused.
 */
function check(was: Identity, now: Identity): void {
  if (now.ino !== was.ino || now.size !== was.size || now.mtimeMs !== was.mtimeMs) {
    throw new Error("pyramid file was replaced since it was opened");
  }
}

function readFully(fd: number, offset: number, bytes: number): Buffer {
  const buf = Buffer.alloc(bytes);
  for (let at = 0; at < bytes;) {
    const n = fs.readSync(fd, buf, at, bytes - at, offset + at);
    if (n === 0) {
      throw new Error("pyramid file is truncated");
    }
    at += n;
  }
  return buf;
}

async function readFullyAsync(h: fs.promises.FileHandle, offset: number, bytes: number) {
  const buf = Buffer.alloc(bytes);
  for (let at = 0; at < bytes;) {
    const { bytesRead } = await h.read(buf, at, bytes - at, offset + at);
    if (bytesRead === 0) {
      throw new Error("pyramid file is truncated");
    }
    at += bytesRead;
  }
  return buf;
}

/** Reads off the event loop that hold a file open, by its directory. */
const inFlight = new Map<string, Set<Promise<unknown>>>();

function track<T>(file: string, read: Promise<T>): Promise<T> {
  const dir = path.resolve(path.dirname(file));
  const reads = inFlight.get(dir) ?? new Set<Promise<unknown>>();
  inFlight.set(dir, reads);
  reads.add(read);
  const done = (): void => {
    reads.delete(read);
    if (reads.size === 0 && inFlight.get(dir) === reads) {
      inFlight.delete(dir);
    }
  };
  read.then(done, done);
  return read;
}

/**
 * Resolves once no read off the event loop holds a file in `dir` open.
 * Windows refuses to rename a directory with an open file in it, so a
 * commit over `dir` waits for this first.
 */
export async function readsSettled(dir: string): Promise<void> {
  const key = path.resolve(dir);
  for (let reads = inFlight.get(key); reads && reads.size > 0; reads = inFlight.get(key)) {
    await Promise.allSettled([...reads]);
  }
}

/** Each read opens the file and closes it after, so a rebuild may rename over it meanwhile. */
function readerOf(file: string, was: Identity): BlockReader {
  return {
    size: was.size,
    readSync(offset, bytes) {
      const fd = fs.openSync(file, "r");
      try {
        check(was, fs.fstatSync(fd));
        return readFully(fd, offset, bytes);
      } finally {
        fs.closeSync(fd);
      }
    },
    read(offset, bytes) {
      return track(
        file,
        (async () => {
          const h = await fs.promises.open(file, "r");
          try {
            check(was, await h.stat());
            return await readFullyAsync(h, offset, bytes);
          } finally {
            await h.close();
          }
        })()
      );
    }
  };
}

export const fileReader = (file: string): BlockReader => readerOf(file, fs.statSync(file));

export const fileReaderAsync = async (file: string): Promise<BlockReader> =>
  readerOf(file, await fs.promises.stat(file));
