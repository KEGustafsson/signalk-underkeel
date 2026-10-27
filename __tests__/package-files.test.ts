import { execSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const ROOT = path.resolve(__dirname, "..");

interface Packed {
  files: { path: string; mode: number }[];
}

/**
 * The files `npm pack` would publish. The plugin registry runs the tests with
 * a read-only home, where npm cannot write its cache, so it gets its own.
 */
function packedFiles(): Packed["files"] | undefined {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "underkeel-npm-cache-"));
  try {
    const out = execSync("npm pack --dry-run --json --ignore-scripts", {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, npm_config_cache: cache }
    });
    return (JSON.parse(out) as Packed[])[0]?.files;
  } finally {
    fs.rmSync(cache, { recursive: true, force: true });
  }
}

describe("published package", () => {
  const packed = packedFiles();

  // The App Store loads screenshots and README images from the published tarball.
  test("ships every App Store screenshot and README image", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
      signalk?: { screenshots?: string[] };
    };
    const shots = pkg.signalk?.screenshots ?? [];
    const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
    const images = [...readme.matchAll(/!\[[^\]]*\]\((?!https?:)([^)\s]+)\)/g)].map((m) => m[1]);
    const paths = new Set(packed?.map((f) => f.path));
    expect(shots.length).toBeGreaterThan(0);
    expect(shots.length).toBeLessThanOrEqual(6);
    for (const file of [...shots, ...images]) {
      expect(paths).toContain(path.posix.normalize(file as string));
    }
  });

  test("ships no repository script: the cells are read as delivered", () => {
    expect(packed?.filter((f) => f.path.startsWith("scripts/"))).toEqual([]);
  });
});
