import { createHash, randomBytes } from "crypto";
import fs from "fs";
import path from "path";
import zlib from "zlib";
import { writeFileDurable } from "../foundation/durable-file";
import { encBounds } from "./enc-bounds";
import type { EncReader } from "./enc-read-process";
import type { EncLayers } from "./enc-wasm";
import { encReaderId, encStamp, sharedLayers, STAMP_LAYER } from "./enc-wasm";
import type { Bbox } from "./wfs-fetch";

/**
 * What the index build keeps of each S-57 cell between builds, in a directory of the plugin's
 * data: the layers gdal3.js read from it, compressed, and its extent. A box refresh read every
 * cell meeting the box through gdal3.js again: 18 s of a 32–57 s build of the 10 km Waddenzee
 * box, its reader at 320–370 MB RSS, and 3.4 s more reading every cell whole for its extent
 * (x86). An entry serves only the files it was read from (`encStamp`: names, sizes and
 * modification times of the `.000` and its updates) under the same reader (`encReaderId`), so
 * a new edition, update or replaced file is read from the cell again (invariant 3). Each
 * entry is written once per cell edition, through a rename, and carries a SHA-256 of itself:
 * one torn by a power cut or damaged on the card is read from the cell instead.
 */

/** Bumped when an entry's layout changes. */
const FORMAT = 1;
const MAGIC = Buffer.from(`UKLAYER${FORMAT}`, "latin1");
const SUM_BYTES = 32;
const ENTRY = ".layers";
const EXTENTS = "extents.json";

/**
 * Brotli quality 4: the 20 Waddenzee cells' 281 MB of layers became 34 MB in 3.6 s and read
 * back in 0.7 s; gzip level 6 gave 42 MB in 6.9 s, quality 6 32 MB in 8.4 s (x86).
 */
const BROTLI: zlib.BrotliOptions = {
  params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 }
};

export interface CacheLimits {
  /** Bytes of entries kept; past it those written longest ago go first. */
  maxBytes: number;
  /** No entry is written that would leave less free space than this on the cache's disk. */
  minFreeBytes: number;
}

export const CACHE_LIMITS: CacheLimits = { maxBytes: 512 * 2 ** 20, minFreeBytes: 512 * 2 ** 20 };

/** The name of the cache directory in the plugin's data directory. */
export const CACHE_DIR = "cell-cache";

const sha256 = (data: Uint8Array | string): Buffer => createHash("sha256").update(data).digest();

/** One entry per cell file: its next edition replaces it. */
function entryName(real: string): string {
  const base = path.basename(real, path.extname(real)).replace(/[^\w-]/g, "_");
  return `${base}-${sha256(real).toString("hex").slice(0, 16)}${ENTRY}`;
}

/** Whether process `pid` still runs: its temporary files may still be written. */
function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

const TMP = /\.tmp-(\d+)-[0-9a-f]+$/;

const tmpName = (file: string): string =>
  `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;

/** Writes `data` to `file` through a rename; a failure leaves the old file, or none. */
function writeQuietly(file: string, data: string | Uint8Array): void {
  const tmp = tmpName(file);
  try {
    writeFileDurable(file, data, tmp);
  } catch {
    fs.rmSync(tmp, { force: true });
  }
}

interface Header {
  key: string;
  layers: [string, number][];
}

/** The layers in `bytes` filed under `key`; "stale" for another key, "corrupt" for a damaged entry. */
function decodeEntry(bytes: Buffer, key: string): EncLayers | "stale" | "corrupt" {
  const end = bytes.length - SUM_BYTES;
  const headAt = MAGIC.length + 4;
  if (end < headAt || !bytes.subarray(0, MAGIC.length).equals(MAGIC)) {
    return "corrupt";
  }
  if (!sha256(bytes.subarray(0, end)).equals(bytes.subarray(end))) {
    return "corrupt";
  }
  const bodyAt = headAt + bytes.readUInt32LE(MAGIC.length);
  let head: Header;
  let raw: Buffer;
  try {
    if (bodyAt > end) {
      return "corrupt";
    }
    head = JSON.parse(bytes.toString("utf8", headAt, bodyAt)) as Header;
    if (head.key !== key) {
      return "stale";
    }
    raw = zlib.brotliDecompressSync(bytes.subarray(bodyAt, end));
  } catch {
    return "corrupt";
  }
  const parts = new Map<string, Uint8Array>();
  let at = 0;
  for (const [layer, length] of head.layers) {
    parts.set(layer, raw.subarray(at, at + length));
    at += length;
  }
  return at === raw.length && parts.has(STAMP_LAYER) ? sharedLayers(parts) : "corrupt";
}

/** The layers' bytes in order as one view: their own buffer when they lie in order in one. */
function joined(views: Uint8Array[]): Uint8Array {
  const first = views[0];
  let at = first?.byteOffset ?? 0;
  const inOrder = views.every((v) => {
    const next = v.buffer === first?.buffer && v.byteOffset === at;
    at += v.byteLength;
    return next;
  });
  return first && inOrder
    ? new Uint8Array(first.buffer, first.byteOffset, at - first.byteOffset)
    : Buffer.concat(views);
}

const compress = (data: Uint8Array): Promise<Buffer> =>
  new Promise((resolve, reject) =>
    zlib.brotliCompress(data, BROTLI, (err, out) => (err ? reject(err) : resolve(out)))
  );

/**
 * S-57 cells' layers as `readEncLayers` returns them, one entry per cell file:
 * `MAGIC`, the header's length (u32 LE), the header (JSON: the key and each layer's name and
 * length), the layers' bytes compressed with Brotli, and a SHA-256 of all before it.
 */
export class LayerCache {
  private writes: Promise<void> = Promise.resolve();
  /** Entries this build looked up or wrote: never dropped to make room for another. */
  private readonly used = new Set<string>();

  private constructor(
    readonly dir: string,
    private readonly limits: CacheLimits
  ) {}

  /**
   * The cache in `dir`, made when missing, without the entries of cells not among `present`
   * nor the temporary files of processes that ended; undefined when `dir` cannot be made.
   */
  static open(
    dir: string,
    present: readonly string[],
    limits: CacheLimits = CACHE_LIMITS
  ): LayerCache | undefined {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const cache = new LayerCache(dir, limits);
      cache.prune(present);
      return cache;
    } catch {
      return undefined;
    }
  }

  private prune(present: readonly string[]): void {
    const keep = new Set<string>();
    for (const file of present) {
      try {
        keep.add(entryName(fs.realpathSync(file)));
      } catch {
        // Gone since it was found: its entry goes.
      }
    }
    for (const name of fs.readdirSync(this.dir)) {
      const pid = TMP.exec(name)?.[1];
      const gone =
        pid !== undefined ? !running(Number(pid)) : name.endsWith(ENTRY) && !keep.has(name);
      if (gone) {
        fs.rmSync(path.join(this.dir, name), { force: true });
      }
    }
  }

  /** The entry's name and the key it must hold for `file` with files stamped `stamp`. */
  private identify(file: string, stamp: string): { name: string; key: string } {
    const real = fs.realpathSync(file);
    const key = JSON.stringify({ format: FORMAT, reader: encReaderId(), file: real, stamp });
    return { name: entryName(real), key };
  }

  /** The layers of `file` as its files are now; undefined when none are kept for them. */
  get(file: string): EncLayers | undefined {
    let entry: string;
    let layers: ReturnType<typeof decodeEntry>;
    try {
      const { name, key } = this.identify(file, encStamp(file));
      this.used.add(name);
      entry = path.join(this.dir, name);
      layers = decodeEntry(fs.readFileSync(entry), key);
    } catch {
      return undefined;
    }
    if (layers === "corrupt") {
      fs.rmSync(entry, { force: true });
    }
    return typeof layers === "string" ? undefined : layers;
  }

  /**
   * Files the layers just read from `file`, compressed off the event loop; `flush` waits for
   * the write. Layers of a cell whose files changed while it was read are not kept: they are
   * filed under the stamp taken before the read, which no later lookup asks for.
   */
  put(file: string, layers: EncLayers): void {
    const stampBytes = layers[STAMP_LAYER];
    let id: { name: string; key: string };
    try {
      const stamp = stampBytes && Buffer.from(stampBytes).toString("utf8");
      if (stamp === undefined || stamp !== encStamp(file)) {
        return;
      }
      id = this.identify(file, stamp);
    } catch {
      return;
    }
    this.used.add(id.name);
    const names = Object.keys(layers);
    const views = names.map((n) => layers[n] as Uint8Array);
    const head: Header = {
      key: id.key,
      layers: names.map((n, i) => [n, views[i]?.byteLength ?? 0])
    };
    // One at a time: each holds its compressed copy until written.
    this.writes = this.writes
      .then(() => compress(joined(views)))
      .then((body) => this.write(id.name, Buffer.from(JSON.stringify(head)), body))
      .catch(() => undefined);
  }

  /** Settles once every entry `put` started is written or given up. */
  flush(): Promise<void> {
    return this.writes;
  }

  private write(name: string, head: Buffer, body: Buffer): void {
    const length = Buffer.alloc(4);
    length.writeUInt32LE(head.length);
    const content = Buffer.concat([MAGIC, length, head, body]);
    const data = Buffer.concat([content, sha256(content)]);
    if (this.room(name, data.length)) {
      writeQuietly(path.join(this.dir, name), data);
    }
  }

  /**
   * Makes room for an entry of `size` bytes named `name`, dropping the entries this build did
   * not use, those written longest ago first; false when the limits leave none.
   */
  private room(name: string, size: number): boolean {
    const { bavail, bsize } = fs.statfsSync(this.dir);
    if (bavail * bsize - size < this.limits.minFreeBytes) {
      return false;
    }
    const entries = fs
      .readdirSync(this.dir)
      .filter((n) => n.endsWith(ENTRY) && n !== name)
      .flatMap((n) => {
        try {
          const st = fs.statSync(path.join(this.dir, n));
          return [{ name: n, size: st.size, written: st.mtimeMs }];
        } catch {
          return [];
        }
      });
    let total = entries.reduce((sum, e) => sum + e.size, size);
    const drop: string[] = [];
    const spare = entries.filter((e) => !this.used.has(e.name));
    for (const e of spare.sort((a, b) => a.written - b.written)) {
      if (total <= this.limits.maxBytes) {
        break;
      }
      drop.push(e.name);
      total -= e.size;
    }
    if (total > this.limits.maxBytes) {
      return false;
    }
    drop.forEach((n) => fs.rmSync(path.join(this.dir, n), { force: true }));
    return true;
  }
}

/**
 * `reader` taking each cell's layers from `cache` while its files are those they were read
 * from, and filing those it reads. With every cell kept, gdal3.js is not started.
 */
export function cachedReader(reader: EncReader, cache: LayerCache): EncReader {
  return async (files) => {
    const out = new Map<string, EncLayers>();
    const read: string[] = [];
    for (const file of new Set(files)) {
      const layers = cache.get(file);
      if (layers) {
        out.set(file, layers);
      } else {
        read.push(file);
      }
    }
    for (const [file, layers] of await reader(read)) {
      out.set(file, layers);
      cache.put(file, layers);
    }
    return out;
  };
}

interface Extents {
  version: number;
  reader: string;
  /** SHA-256 of `JSON.stringify(cells)`. */
  sum: string;
  cells: Record<string, { stamp: string; bbox: Bbox | null }>;
}

function readExtents(file: string): Extents["cells"] {
  try {
    const json = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<Extents>;
    const cells = json.cells;
    const valid =
      json.version === FORMAT &&
      json.reader === encReaderId() &&
      cells !== undefined &&
      sha256(JSON.stringify(cells)).toString("hex") === json.sum;
    return valid ? cells : {};
  } catch {
    return {};
  }
}

/**
 * Each S-57 cell's extent as `encBounds` reads it, kept in `dir` by the cell's file stamp so
 * only a cell whose files changed is read again; undefined where it gives none. The extents
 * of cells not among `files` are dropped; the file is written only when one changed.
 */
export function cellExtents(
  files: readonly string[],
  dir: string | undefined
): Map<string, Bbox | undefined> {
  const out = new Map<string, Bbox | undefined>();
  if (dir === undefined) {
    files.forEach((f) => out.set(f, encBounds(f)));
    return out;
  }
  const file = path.join(dir, EXTENTS);
  const kept = readExtents(file);
  const cells: Extents["cells"] = {};
  for (const f of files) {
    let stamp: string;
    try {
      stamp = encStamp(f);
    } catch {
      out.set(f, encBounds(f));
      continue;
    }
    const was = kept[f];
    const bbox = was?.stamp === stamp ? (was.bbox ?? undefined) : encBounds(f);
    out.set(f, bbox);
    cells[f] = { stamp, bbox: bbox ?? null };
  }
  const json = JSON.stringify(cells);
  if (json !== JSON.stringify(kept)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const sum = sha256(json).toString("hex");
      writeQuietly(file, JSON.stringify({ version: FORMAT, reader: encReaderId(), sum, cells }));
    } catch {
      // Read again from the cells next time.
    }
  }
  return out;
}
