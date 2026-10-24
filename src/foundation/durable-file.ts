import fs from "fs";
import path from "path";

/**
 * Writes that survive a power cut. A rename or an append is only on the disk once the data
 * and the directory entry are: without fsync, ext4 without `auto_da_alloc`, FAT and other
 * filesystems can leave an empty or torn file after the cut.
 */

/**
 * Replaces `file` with `data` through `tmp`: the data is flushed before the rename and the
 * directory after it, so a cut leaves the old content or the new, never an empty file.
 * A failed write leaves `tmp` for the caller to remove.
 */
export function writeFileDurable(
  file: string,
  data: string,
  tmp = `${file}.tmp-${process.pid}`
): void {
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  syncDirectory(path.dirname(file));
}

/** Appends `data` and flushes it; the directory too when the append created the file. */
export function appendFileDurable(file: string, data: string): void {
  const created = !fs.existsSync(file);
  const fd = fs.openSync(file, "a");
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (created) {
    syncDirectory(path.dirname(file));
  }
}

/** fsync answers that mean the platform cannot flush a directory, not that a flush failed. */
const NO_DIRECTORY_SYNC: ReadonlySet<string> = new Set([
  "EINVAL",
  "ENOTSUP",
  "EOPNOTSUPP",
  "EPERM",
  "EACCES",
  "EISDIR",
  "EBADF"
]);

/**
 * Flushes `dir`'s entries. A platform that cannot open or flush a directory (Windows, some
 * network and FUSE filesystems) is skipped: the entry stays where the rename put it, only
 * its durability is not confirmed. A flush that fails, as with EIO, is thrown, so a caller
 * does not go on as if the entries were on the disk.
 */
export function syncDirectory(dir: string): void {
  let fd: number;
  try {
    fd = fs.openSync(dir, "r");
  } catch {
    return;
  }
  try {
    fs.fsyncSync(fd);
  } catch (err) {
    if (!NO_DIRECTORY_SYNC.has((err as NodeJS.ErrnoException).code ?? "")) {
      throw err;
    }
  } finally {
    fs.closeSync(fd);
  }
}
