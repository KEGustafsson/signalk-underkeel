import fs from "fs";
import path from "path";
import { writeFileDurable } from "../foundation/durable-file";

/** Where an index records the ENC source it was built from (`index-source.ts`). */
export const SOURCE_FILE = "source.json";

export function writeSource(staging: string, source: string): void {
  writeFileDurable(path.join(staging, SOURCE_FILE), JSON.stringify({ version: 1, source }));
}

/** The source the index in `dir` was built from; undefined when it records none. */
export function readSource(dir: string): string | undefined {
  try {
    const json = JSON.parse(fs.readFileSync(path.join(dir, SOURCE_FILE), "utf8")) as {
      version?: unknown;
      source?: unknown;
    };
    return json.version === 1 && typeof json.source === "string" ? json.source : undefined;
  } catch {
    return undefined;
  }
}
