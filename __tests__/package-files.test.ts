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

  const script = packed?.find((f) => f.path === "scripts/enc-to-geojson.sh");

  test("ships the cell export script the README tells users to run", () => {
    expect(script).toBeDefined();
  });

  // Windows has no execute bit: npm packs every file there as 0644.
  (process.platform === "win32" ? test.skip : test)(
    "packs the cell export script executable",
    () => {
      expect((script?.mode ?? 0) & 0o111).not.toBe(0);
    }
  );

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

  test("ships no other repository script", () => {
    const scripts = packed?.filter((f) => f.path.startsWith("scripts/")).map((f) => f.path);
    expect(scripts).toEqual(["scripts/enc-to-geojson.sh"]);
  });
});
