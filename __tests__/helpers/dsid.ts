/**
 * An S-57 file's bytes with its DSID record's EDTN and UPDN replaced, the field's length, the
 * positions of the fields after it and the record's length moved to match, as a producer would
 * write a cell of that edition and update.
 */
export function withDsidVersion(cell: Buffer, edition: string, update: string): Buffer {
  const num = (at: number, len: number): number => Number(cell.toString("latin1", at, at + len));
  const dr = num(0, 5);
  const base = dr + num(dr + 12, 5);
  const [lenSize, posSize, tagSize] = [num(dr + 20, 1), num(dr + 21, 1), num(dr + 23, 1)];
  const entries: number[] = [];
  for (let e = dr + 24; cell[e] !== 0x1e; e += tagSize + lenSize + posSize) {
    entries.push(e);
  }
  const tag = (e: number): string => cell.toString("latin1", e, e + tagSize);
  const dsid = entries.find((e) => tag(e) === "DSID");
  if (dsid === undefined) {
    throw new Error("no DSID field");
  }
  const len = num(dsid + tagSize, lenSize);
  const pos = num(dsid + tagSize + lenSize, posSize);
  const start = base + pos;
  // RCNM (1), RCID (4), EXPP (1), INTU (1), then DSNM, EDTN and UPDN, each ended by 0x1f.
  const dsnm = cell.indexOf(0x1f, start + 7);
  const updn = cell.indexOf(0x1f, cell.indexOf(0x1f, dsnm + 1) + 1);
  const field = Buffer.concat([
    cell.subarray(start, dsnm + 1),
    Buffer.from(`${edition}\x1f${update}`, "latin1"),
    cell.subarray(updn, start + len)
  ]);
  const delta = field.length - len;
  const out = Buffer.concat([cell.subarray(0, start), field, cell.subarray(start + len)]);
  const put = (at: number, width: number, n: number): void => {
    out.write(String(n).padStart(width, "0"), at, width, "latin1");
  };
  put(dr, 5, num(dr, 5) + delta);
  for (const e of entries) {
    const at = num(e + tagSize + lenSize, posSize);
    if (e === dsid) {
      put(e + tagSize, lenSize, len + delta);
    } else if (at > pos) {
      put(e + tagSize + lenSize, posSize, at + delta);
    }
  }
  return out;
}
