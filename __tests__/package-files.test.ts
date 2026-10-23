import { execSync } from "child_process";
import fs from "fs";
import path from "path";

const ROOT = path.resolve(__dirname, "..");

interface Packed {
  files: { path: string; mode: number }[];
}

describe("published package", () => {
  const packed = (
    JSON.parse(
      execSync("npm pack --dry-run --json --ignore-scripts", {
        cwd: ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      })
    ) as Packed[]
  )[0]?.files;

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
