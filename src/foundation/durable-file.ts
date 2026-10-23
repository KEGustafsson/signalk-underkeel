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

/**
 * Errors are ignored: the file is already in place, and Windows cannot open a directory to
 * sync it.
 */
export function syncDirectory(dir: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(dir, "r");
    fs.fsyncSync(fd);
  } catch {
    // The entry stays where the rename put it; only its durability is not confirmed.
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
}
