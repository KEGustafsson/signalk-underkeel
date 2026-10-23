/**
 * The HTTP side of the Traficom WFS download: page requests with a byte cap and an idle
 * timeout, a shared limit on requests in flight, and the paging of one layer.
 */

export const WFS_LIMITS = {
  /** Half-width of the box around the vessel, km. */
  minRadiusKm: 2,
  maxRadiusKm: 25,
  /** Box size in degrees, which a 25 km radius stays inside up to 70° latitude. */
  maxLatSpan: 0.5,
  maxLonSpan: 1.5,
  pageSize: 5000,
  /**
   * Page requests in flight at once over the whole download. The server sends one response
   * at about 1 MB/s: the 461 depth areas of a 10 km box off Helsinki (5.5 MB) took 7.5 s as
   * one page and 3.5 s as four concurrent pages.
   */
  concurrency: 4,
  /** A box that returns more features than this is refused. */
  maxFeatures: 50_000,
  /** A layer that takes more pages than this is refused, so a server that ignores startIndex stops. */
  maxPages: 100,
  /** A page body larger than this fails the download: the 10 km box is one 22 MB page. */
  maxPageBytes: 64 * 2 ** 20,
  /**
   * A response or body that sends nothing for this long fails the download, so a stalled
   * server ends it while a slow link that keeps sending is read to the end.
   */
  idleTimeoutMs: 30_000
} as const;

/** What a page body is read through; a fetch Response's `body`. */
export interface ByteStream {
  getReader(): {
    read(): Promise<{ done: boolean; value?: Uint8Array }>;
    cancel(): Promise<void>;
  };
}

/** A response without `body` is read with text() and checked against the cap afterwards. */
export type WfsFetch = (
  url: string,
  init?: { signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number; body?: ByteStream | null; text(): Promise<string> }>;

/** [west, south, east, north], degrees. */
export type Bbox = [number, number, number, number];

export interface WfsFeature {
  type: "Feature";
  id?: unknown;
  geometry: { type: string; coordinates: unknown } | null;
  properties: Record<string, unknown> | null;
}

/** Runs at most `n` of the tasks given to it at once, the others in the order given. */
export type Limit = <T>(task: () => Promise<T>) => Promise<T>;

export function limiter(n: number): Limit {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async (task) => {
    if (active < n) {
      active++;
    } else {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) {
        next();
      } else {
        active--;
      }
    }
  };
}

/** What every request of one layer shares. */
export interface LayerRequest {
  fetch: WfsFetch;
  base: string;
  typeName: string;
  bbox: Bbox;
  limit: Limit;
  signal?: AbortSignal;
}

function query(r: LayerRequest, extra: Record<string, string>): string {
  const [w, s, e, n] = r.bbox;
  const q = new URLSearchParams({
    service: "WFS",
    version: "2.0.0",
    request: "GetFeature",
    typeNames: r.typeName,
    // WFS 2.0 with an EPSG URN reads the box as latitude, longitude.
    bbox: `${s},${w},${n},${e},urn:ogc:def:crs:EPSG::4326`,
    srsName: "EPSG:4326",
    ...extra
  });
  return `${r.base}?${q.toString()}`;
}

/**
 * Pages are sorted by IDENTIFIER, so concurrent requests for different start indexes split
 * one ordering: without a sort the server may order each request differently.
 */
const pageUrl = (r: LayerRequest, start: number, count: number): string =>
  query(r, {
    outputFormat: "application/json",
    sortBy: "IDENTIFIER",
    count: String(count),
    startIndex: String(start)
  });

/** numberMatched from a `resultType=hits` response (XML), or undefined when it has none. */
async function countMatched(r: LayerRequest): Promise<number | undefined> {
  const text = await r.limit(() =>
    fetchText(r.fetch, query(r, { resultType: "hits" }), r.typeName, r.signal)
  );
  const m = /numberMatched="(\d+)"/.exec(text);
  return m ? Number(m[1]) : undefined;
}

interface Page {
  features: WfsFeature[];
  matched?: number;
}

async function readPage(r: LayerRequest, start: number, count: number): Promise<Page> {
  const page = (await r.limit(() =>
    fetchPage(r.fetch, pageUrl(r, start, count), r.typeName, r.signal)
  )) as { type?: unknown; features?: unknown; numberMatched?: unknown };
  if (page.type !== "FeatureCollection" || !Array.isArray(page.features)) {
    throw new Error(`${r.typeName}: not a GeoJSON FeatureCollection`);
  }
  return { features: page.features as WfsFeature[], matched: num(page.numberMatched) };
}

const tooMany = (typeName: string): Error =>
  new Error(`${typeName}: more than ${WFS_LIMITS.maxFeatures} features; use a smaller box`);

const tooManyPages = (typeName: string): Error =>
  new Error(`${typeName}: more than ${WFS_LIMITS.maxPages} pages`);

/** Appends without a spread: a spread of more than ~100 000 features overflows the call stack. */
function append(out: WfsFeature[], features: WfsFeature[]): void {
  for (const f of features) {
    out.push(f);
  }
}

/**
 * Every feature of one layer in the box. With the count from a hits request the layer is
 * read as up to `concurrency` runs of pages side by side, each over its own share of the
 * start indexes, and the features read must number exactly the count; without one, page by
 * page. A server may return fewer features per page than asked, so a short page is not the
 * end of a run.
 */
export async function fetchLayer(r: LayerRequest): Promise<WfsFeature[]> {
  const matched = await countMatched(r);
  if (matched === undefined) {
    return fetchSequential(r);
  }
  if (matched > WFS_LIMITS.maxFeatures) {
    throw tooMany(r.typeName);
  }
  const runs = Math.min(WFS_LIMITS.concurrency, matched);
  const share = Math.ceil(matched / Math.max(1, runs));
  let pages = 0;
  const run = async (from: number, to: number): Promise<WfsFeature[]> => {
    const out: WfsFeature[] = [];
    while (from + out.length < to) {
      if (++pages > WFS_LIMITS.maxPages) {
        throw tooManyPages(r.typeName);
      }
      const start = from + out.length;
      const page = await readPage(r, start, Math.min(WFS_LIMITS.pageSize, to - start));
      if (page.features.length === 0) {
        break;
      }
      append(out, page.features);
    }
    return out;
  };
  const parts = await Promise.all(
    Array.from({ length: runs }, (_, i) => run(i * share, Math.min(matched, (i + 1) * share)))
  );
  const out: WfsFeature[] = [];
  for (const part of parts) {
    append(out, part);
  }
  if (out.length !== matched) {
    throw new Error(
      `${r.typeName}: ${out.length} features read, ${matched} matched; the pages do not add up to the count`
    );
  }
  // A server that ignores startIndex returns the first page to every run.
  const ids = out.map((f) => f.id);
  if (ids.every((id) => typeof id === "string") && new Set(ids).size !== ids.length) {
    throw new Error(`${r.typeName}: the same feature on more than one page`);
  }
  return out;
}

/** Page by page to numberMatched when the server reports it, else to an empty page. */
async function fetchSequential(r: LayerRequest): Promise<WfsFeature[]> {
  const out: WfsFeature[] = [];
  for (let pages = 1; ; pages++) {
    const page = await readPage(r, out.length, WFS_LIMITS.pageSize);
    if (out.length + page.features.length > WFS_LIMITS.maxFeatures) {
      throw tooMany(r.typeName);
    }
    append(out, page.features);
    if (page.features.length === 0 || (page.matched !== undefined && out.length >= page.matched)) {
      return out;
    }
    if (pages >= WFS_LIMITS.maxPages) {
      throw tooManyPages(r.typeName);
    }
  }
}

async function fetchPage(
  fetch: WfsFetch,
  url: string,
  typeName: string,
  signal?: AbortSignal
): Promise<unknown> {
  return JSON.parse(await fetchText(fetch, url, typeName, signal));
}

async function fetchText(
  fetch: WfsFetch,
  url: string,
  typeName: string,
  signal?: AbortSignal
): Promise<string> {
  const idle = new AbortController();
  let stalled: Error | undefined;
  let timer: NodeJS.Timeout | undefined;
  const alive = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = new Error(`${typeName}: no data for ${WFS_LIMITS.idleTimeoutMs / 1000} s`);
      idle.abort(stalled);
    }, WFS_LIMITS.idleTimeoutMs);
  };
  const ended = signal ? AbortSignal.any([signal, idle.signal]) : idle.signal;
  alive();
  try {
    const res = await unlessAborted(fetch(url, { signal: ended }), ended);
    if (!res.ok) {
      throw new Error(`${typeName}: HTTP ${res.status}`);
    }
    if (res.body) {
      return await readBody(res.body, typeName, ended, alive);
    }
    const text = await unlessAborted(res.text(), ended);
    if (Buffer.byteLength(text) > WFS_LIMITS.maxPageBytes) {
      throw tooLarge(typeName);
    }
    return text;
  } catch (err) {
    if (stalled && !signal?.aborted) {
      throw stalled;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const tooLarge = (typeName: string): Error =>
  new Error(
    `${typeName}: page larger than ${WFS_LIMITS.maxPageBytes / 2 ** 20} MB; use a smaller box`
  );

/** The body as text, read chunk by chunk; `alive` is called for every chunk. */
async function readBody(
  body: ByteStream,
  typeName: string,
  signal: AbortSignal,
  alive: () => void
): Promise<string> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await unlessAborted(reader.read(), signal);
      if (done || !value) {
        return Buffer.concat(chunks).toString("utf8");
      }
      size += value.byteLength;
      if (size > WFS_LIMITS.maxPageBytes) {
        throw tooLarge(typeName);
      }
      chunks.push(value);
      alive();
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

/** `p`, or a rejection with the signal's reason once it aborts: a fake or hung read may ignore it. */
function unlessAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(signal.reason as Error);
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", abort);
        resolve(v);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(err as Error);
      }
    );
  });
}

export function num(v: unknown): number | undefined {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}
