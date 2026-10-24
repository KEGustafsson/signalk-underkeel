/**
 * Server-side reasons as they may go on the wire: `GET /status`, a 5xx
 * reply and the notifications any Signal K client can read. The full
 * reason stays in the plugin status and the server log.
 */

/**
 * A run of path characters ending in one that is not a closing `.` or `:`. An
 * apostrophe followed by a path character is part of a name, as in `O'Reilly`.
 */
const SEGMENT = String.raw`(?:[^\s'"\`;,()<>]|'(?=[^\s'"\`;,()<>]))*[^\s'"\`;,()<>.:]`;

/**
 * An absolute file path: Unix (`/srv/x`), Windows (`C:\x`, `C:/x`) or UNC
 * (`\\host\share`). It starts where no word, URL, relative path or `<path>` goes on
 * (`https://h/p`, `1/2`, `m/s` and `~/x` are left alone) and ends before a
 * space, quote, bracket, separator or a closing `.` or `:`, unless the word
 * after the space goes on with a path separator, as in `C:\Users\A Smith\x`.
 */
const FILE_PATH = new RegExp(
  String.raw`(?<![\w:/.~\\>-])(?:[A-Za-z]:)?[\\/]${SEGMENT}(?:\s+[^\s'"\`;,()<>\\/]*[\\/]${SEGMENT})*`,
  "g"
);

/**
 * An absolute path in quotes, as Node's errors give one, hidden to its closing
 * quote: the first one followed by the end or a space, perhaps after
 * punctuation, where the next word holds no path separator. A quote inside a
 * name (`'/home/O'Reilly/x'`, `'/srv/Jones' files/x'`) does not close it.
 */
const QUOTED_PATH = new RegExp(
  String.raw`(['"\`])((?:[A-Za-z]:)?[\\/][^\n]*?)\1(?=[,;:.)\]]*(?:$|\s(?![^\s'"\`]*[\\/])))`,
  "g"
);

/** An S-57 cell file name, base or update, kept from a path so the cell stays named. */
const CELL_FILE = /[\\/]([A-Za-z0-9]{8}\.\d{3})$/;

function hidePath(path: string): string {
  const cell = CELL_FILE.exec(path)?.[1];
  return cell === undefined ? "<path>" : `<path>/${cell}`;
}

/**
 * `reason` with the text of a nested failure, which may name anything,
 * given way to "see the server log", and each absolute file path shown as
 * `<path>` (an S-57 cell file keeps its name). The failure is also the
 * plugin error. Why a saved index could not be read is kept, its paths
 * hidden: the index reason is the only place it is reported. URLs, cell
 * names and numbers are kept.
 */
export function publicReason(reason: string): string;
export function publicReason(reason: string | undefined): string | undefined;
export function publicReason(reason: string | undefined): string | undefined {
  return reason
    ?.replace(/\bfailed: [^;]*/g, "failed (see the server log)")
    .replace(QUOTED_PATH, (_m, quote: string, path: string) => `${quote}${hidePath(path)}${quote}`)
    .replace(FILE_PATH, hidePath);
}
