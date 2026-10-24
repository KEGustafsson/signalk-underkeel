import fs from "fs";

/** The living chart's append-only files: one JSON value per line, each line ended. */

/** `items` one per line; "" for none, which reads back as no lines rather than one empty one. */
export function ndjson(items: readonly unknown[]): string {
  return items.length === 0 ? "" : items.map((i) => JSON.stringify(i)).join("\n") + "\n";
}

export interface NdjsonRead<T> {
  items: T[];
  malformed: number;
  /** The last line had no newline and did not read: an append cut short. */
  torn: boolean;
  /** Complete lines in the file. */
  lines: number;
  /** The file did not end with a newline: rewrite it whole before appending to it. */
  partial: boolean;
}

/**
 * Reads `file` when there is one, a line at a time through `parse`, which gives undefined for
 * a line it does not accept; throws when the file cannot be read.
 */
export function readNdjson<T>(
  file: string,
  parse: (v: unknown) => T | undefined
): NdjsonRead<T> | undefined {
  if (!fs.existsSync(file)) {
    return undefined;
  }
  const parts = fs.readFileSync(file, "utf8").split("\n");
  // "" when the file ends with a newline, as every complete append does.
  const tail = parts.pop() ?? "";
  const read: NdjsonRead<T> = {
    items: [],
    malformed: 0,
    torn: false,
    lines: parts.length,
    partial: tail !== ""
  };
  for (const line of parts) {
    const v = parseLine(line, parse);
    if (v === undefined) {
      read.malformed++;
    } else {
      read.items.push(v);
    }
  }
  if (tail !== "") {
    const v = parseLine(tail, parse);
    read.torn = v === undefined;
    if (v !== undefined) {
      read.items.push(v);
    }
  }
  return read;
}

function parseLine<T>(line: string, parse: (v: unknown) => T | undefined): T | undefined {
  try {
    return parse(JSON.parse(line));
  } catch {
    return undefined;
  }
}
