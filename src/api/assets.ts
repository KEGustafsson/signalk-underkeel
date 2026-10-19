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
}
interface Res {
  setHeader(name: string, value: string): void;
  statusCode: number;
  end(body?: Buffer | string): void;
}
type Next = () => void;
export type Middleware = (req: Req, res: Res, next: Next) => void;

/** The file under `root` that `urlPath` names, or undefined when it is outside or missing. */
export function assetFile(root: string, urlPath: string): string | undefined {
  let rel: string;
  try {
    rel = decodeURIComponent(urlPath);
  } catch {
    return undefined;
  }
  const file = path.resolve(root, `.${rel.startsWith("/") ? rel : `/${rel}`}`);
  if (!file.startsWith(root + path.sep) || !TYPES[path.extname(file)]) {
    return undefined;
  }
  return fs.existsSync(file) && fs.statSync(file).isFile() ? file : undefined;
}

export function assetMiddleware(root = PUBLIC_DIR): Middleware {
  return (req, res, next) => {
    const file =
      req.method === "GET" || req.method === "HEAD" ? assetFile(root, req.path) : undefined;
    if (!file) {
      next();
      return;
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", TYPES[path.extname(file)] as string);
    res.setHeader("Cache-Control", "no-cache");
    res.end(req.method === "HEAD" ? undefined : fs.readFileSync(file));
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
