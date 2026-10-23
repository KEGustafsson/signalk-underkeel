/**
 * Server-side reasons as they may go on the wire: `GET /status`, a 5xx
 * reply and the notifications any Signal K client can read. The full
 * reason stays in the plugin status and the server log.
 */

/**
 * An absolute file path: Unix (`/srv/x`), Windows (`C:\x`, `C:/x`) or UNC
 * (`\\host\share`). It starts where no word, URL or relative path goes on
 * (`https://h/p`, `1/2`, `m/s` and `~/x` are left alone) and ends before a
 * space, quote, bracket, separator or a closing `.` or `:`.
 */
const FILE_PATH = /(?<![\w:/.~\\-])(?:[A-Za-z]:)?[\\/][^\s'"`;,()<>]*[^\s'"`;,()<>.:]/g;

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
    .replace(FILE_PATH, hidePath);
}
