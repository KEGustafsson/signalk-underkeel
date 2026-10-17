import fs from "fs";
import path from "path";

// The README advertises a "Documentation map" of `docs/*.md` files. Every
// referenced doc is a live assertion, so a renamed or deleted doc fails CI.

const ROOT = path.resolve(__dirname, "..");
const README = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");

function referencedDocs(text: string): string[] {
  const found = new Set<string>();
  const re = /\bdocs\/[A-Za-z0-9._/-]+\.md\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    found.add(m[0]);
  }
  return [...found].sort();
}

describe("README documentation map", () => {
  const docs = referencedDocs(README);

  test("the README references a documentation map", () => {
    expect(README).toMatch(/##\s+Documentation map/);
    expect(docs.length).toBeGreaterThan(0);
  });

  for (const doc of docs) {
    test(`${doc} exists`, () => {
      expect(fs.existsSync(path.join(ROOT, doc))).toBe(true);
    });
  }
});
