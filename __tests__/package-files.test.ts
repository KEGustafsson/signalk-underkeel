import { execSync } from "child_process";
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

  test("ships the cell export script the README tells users to run, executable", () => {
    const script = packed?.find((f) => f.path === "scripts/enc-to-geojson.sh");
    expect(script).toBeDefined();
    expect((script?.mode ?? 0) & 0o111).not.toBe(0);
  });

  test("ships no other repository script", () => {
    const scripts = packed?.filter((f) => f.path.startsWith("scripts/")).map((f) => f.path);
    expect(scripts).toEqual(["scripts/enc-to-geojson.sh"]);
  });
});
