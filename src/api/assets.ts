import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import { ASSET_BASE } from "./manifest";

/**
 * Serves the extension pages in `public/` at ASSET_BASE. The server's
 * Express app is used as a plain middleware host, so the plugin needs no
 * Express dependency of its own. Only files inside `public/` are served.
 */

const PUBLIC_DIR = path.resolve(__dirname, "..", "..", "public");

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml"
};

interface Req {
  method?: string;
  path: string;
  headers?: Record<string, string | string[] | undefined>;
}
interface Res {
  setHeader(name: string, value: string): void;
  statusCode: number;
  end(body?: Buffer | string): void;
}
type Next = () => void;
export type Middleware = (req: Req, res: Res, next: Next) => void;

/**
 * The path under `root` that `urlPath` names, or undefined when it is
 * outside or of no served type. A NUL byte, which `fs` throws on, names none.
 */
function assetPath(root: string, urlPath: string): string | undefined {
  let rel: string;
  try {
    rel = decodeURIComponent(urlPath);
  } catch {
    return undefined;
  }
  if (rel.includes("\0")) {
    return undefined;
  }
  const file = path.resolve(root, `.${rel.startsWith("/") ? rel : `/${rel}`}`);
  return file.startsWith(root + path.sep) && TYPES[path.extname(file)] ? file : undefined;
}

/**
 * `file`'s stats when it is a file. Undefined when it is missing or `fs`
 * fails on it, as on a name too long or a directory it may not read: the
 * request falls through to a 404 instead of a 500 that carries the stack.
 */
function fileStats(file: string): fs.Stats | undefined {
  try {
    const st = fs.statSync(file, { throwIfNoEntry: false });
    return st?.isFile() ? st : undefined;
  } catch {
    return undefined;
  }
}

/** The file under `root` that `urlPath` names, or undefined when it is outside or missing. */
export function assetFile(root: string, urlPath: string): string | undefined {
  const file = assetPath(root, urlPath);
  return file && fileStats(file) ? file : undefined;
}

interface Cached {
  mtimeMs: number;
  size: number;
  body: Buffer;
  etag: string;
}

/** Whether an If-None-Match header names `etag`; weak and strong forms match alike. */
function holds(header: string | string[] | undefined, etag: string): boolean {
  const list = Array.isArray(header) ? header.join(",") : (header ?? "");
  return list.split(",").some((t) => {
    const tag = t.trim().replace(/^W\//, "");
    return tag === "*" || tag === etag;
  });
}

/**
 * Each page load fetches every page and script of the extension, three
 * iframes each loading the shared ones, so a copy the browser holds is
 * revalidated by ETag. `no-cache` keeps an updated plugin's pages current.
 */
export function assetMiddleware(root = PUBLIC_DIR): Middleware {
  const cache = new Map<string, Cached>();
  const read = (file: string): Cached | undefined => {
    const st = fileStats(file);
    if (!st) {
      return undefined;
    }
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
      return hit;
    }
    let body: Buffer;
    try {
      body = fs.readFileSync(file);
    } catch {
      return undefined;
    }
    const etag = `"${createHash("sha1").update(body).digest("base64url")}"`;
    const entry = { mtimeMs: st.mtimeMs, size: st.size, body, etag };
    cache.set(file, entry);
    return entry;
  };
  return (req, res, next) => {
    const file =
      req.method === "GET" || req.method === "HEAD" ? assetPath(root, req.path) : undefined;
    const entry = file ? read(file) : undefined;
    if (!file || !entry) {
      next();
      return;
    }
    res.setHeader("Content-Type", TYPES[path.extname(file)] as string);
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("ETag", entry.etag);
    if (holds(req.headers?.["if-none-match"], entry.etag)) {
      res.statusCode = 304;
      res.end();
      return;
    }
    res.statusCode = 200;
    res.end(req.method === "HEAD" ? undefined : entry.body);
  };
}

const mounted = new WeakSet<object>();

/** Mounts the pages once per server app; a plugin restart reuses the mount. */
export function mountAssets(app: object): void {
  const use = (app as { use?: (prefix: string, mw: Middleware) => void }).use;
  if (typeof use !== "function" || mounted.has(app)) {
    return;
  }
  use.call(app, ASSET_BASE, assetMiddleware());
  mounted.add(app);
}
