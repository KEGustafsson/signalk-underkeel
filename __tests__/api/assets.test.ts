import fs from "fs";
import path from "path";
import { assetFile, assetMiddleware, mountAssets } from "../../src/api/assets";
import { buildManifest, PLUGIN_ID } from "../../src/api/manifest";

const PUBLIC = path.resolve(__dirname, "..", "..", "public");

function serve(p: string, method = "GET") {
  let next = false;
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    setHeader: (k: string, v: string) => (headers[k] = v),
    end(b?: unknown) {
      this.body = b;
    }
  };
  assetMiddleware(PUBLIC)({ method, path: p }, res, () => (next = true));
  return { next, headers, res };
}

describe("extension assets", () => {
  test("every page and style the manifest names exists in public/", () => {
    const m = buildManifest("0")[PLUGIN_ID];
    const urls = [...(m?.background ?? []), ...(m?.widgets ?? []), ...(m?.panels ?? [])].map(
      (c) => c.url
    );
    urls.push(
      ...(m?.overlays ?? []).map((o) => o.style).filter((s) => s.startsWith("/plotterext/"))
    );
    expect(urls.length).toBeGreaterThan(4);
    for (const url of urls) {
      const rel = url.replace(`/plotterext/${PLUGIN_ID}/`, "");
      expect(fs.existsSync(path.join(PUBLIC, rel))).toBe(true);
    }
  });

  test("the styles are MapLibre version 8 with an id and GeoJSON sources", () => {
    for (const f of ["lookahead-style.json", "routecheck-style.json"]) {
      const s = JSON.parse(fs.readFileSync(path.join(PUBLIC, f), "utf8")) as {
        version: number;
        id: string;
        sources: Record<string, { type: string }>;
      };
      expect(s.version).toBe(8);
      expect(s.id).toMatch(/^underkeel-/);
      expect(Object.values(s.sources).every((src) => src.type === "geojson")).toBe(true);
    }
  });

  test("files are served with their type and no-cache; anything else falls through", () => {
    const page = serve("/widget.html");
    expect(page.next).toBe(false);
    expect(page.res.statusCode).toBe(200);
    expect(page.headers["Content-Type"]).toMatch(/text\/html/);
    expect(page.headers["Cache-Control"]).toBe("no-cache");
    expect(serve("/missing.html").next).toBe(true);
    expect(serve("/widget.html", "POST").next).toBe(true);
  });

  test("paths outside public/ and unknown file types are refused", () => {
    expect(assetFile(PUBLIC, "/../package.json")).toBeUndefined();
    expect(assetFile(PUBLIC, "/%2e%2e/package.json")).toBeUndefined();
    expect(assetFile(PUBLIC, "/%E0%A4%A")).toBeUndefined();
    expect(assetFile(PUBLIC, "/ukc-shared.js")).toBe(path.join(PUBLIC, "ukc-shared.js"));
  });

  test("the pages are mounted once per server app", () => {
    const mounts: string[] = [];
    const app = { use: (prefix: string) => mounts.push(prefix) };
    mountAssets(app);
    mountAssets(app);
    expect(mounts).toEqual([`/plotterext/${PLUGIN_ID}`]);
  });
});
