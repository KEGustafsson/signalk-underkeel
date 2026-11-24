import fs from "fs";
import path from "path";
import { syncDirectory } from "./foundation/durable-file";
import { covers } from "./planning-region";
import type { HoldInputs, SavedHold } from "./planning-restore";
import { holdFile, readHold, restorable, RESTORE_MAX_AGE_MS, writeHold } from "./planning-restore";
import { readsSettled } from "./spatial/block-reader";

/**
 * Planning indexes kept on disk beside the one in the planning index directory. A build replaces
 * that directory whole, so a plan in one region, then in another, then in the first again built
 * the first one twice: 53 s in the running server for an index built the evening before. The
 * index a build is about to replace is copied here first, with its record
 * (`planning-restore.ts`), and read back from here for as long as that record lets the index in
 * the planning index directory be: the same cells and settings, not older than
 * RESTORE_MAX_AGE_MS. Each lies in `<index dir>.kept/<when it was built>`, its record beside it.
 */

/** Indexes kept at most: about 7 MB each for a 30 km by 25 km region of the archipelago. */
export const KEPT = 4;

const keptRoot = (indexDir: string): string => `${indexDir}.kept`;

interface Kept {
  dir: string;
  hold: SavedHold;
}

function names(root: string): string[] {
  try {
    return fs.readdirSync(root);
  } catch {
    return [];
  }
}

/** The kept indexes whose record parses, the one built last first. */
function kept(indexDir: string): Kept[] {
  const root = keptRoot(indexDir);
  return names(root)
    .filter((n) => /^\d+$/.test(n))
    .flatMap((n) => {
      const dir = path.join(root, n);
      const hold = readHold(dir);
      return hold ? [{ dir, hold }] : [];
    })
    .sort((a, b) => b.hold.builtAt - a.hold.builtAt);
}

/**
 * The saved index a build of `d` at `now` may read back that `serves`: the one in `d.indexDir`,
 * else the kept one built last. Undefined with none; the caller builds.
 */
export function readable(
  d: HoldInputs,
  now: number,
  serves: (hold: SavedHold) => boolean
): Kept | undefined {
  const current = restorable(d, now);
  if (current && serves(current)) {
    return { dir: d.indexDir, hold: current };
  }
  for (const k of kept(d.indexDir)) {
    // The record first: the stamp it is held to reads every chart cell's header.
    const hold = serves(k.hold) ? restorable({ ...d, indexDir: k.dir }, now) : undefined;
    if (hold && serves(hold)) {
      return { dir: k.dir, hold };
    }
  }
  return undefined;
}

async function synced(dir: string): Promise<void> {
  for (const name of await fs.promises.readdir(dir)) {
    const file = await fs.promises.open(path.join(dir, name), "r+");
    try {
      await file.sync();
    } finally {
      await file.close();
    }
  }
  syncDirectory(dir);
}

async function remove(dir: string): Promise<void> {
  // The record first: a directory half removed is then no index to read back.
  await fs.promises.rm(holdFile(dir), { force: true });
  await readsSettled(dir);
  await fs.promises.rm(dir, { recursive: true, force: true });
}

/**
 * Removes the kept indexes past KEPT, those too old to be read back, those a later one covers,
 * and whatever else lies among them: a copy cut short, a directory without its record.
 */
async function prune(indexDir: string, now: number): Promise<void> {
  const root = keptRoot(indexDir);
  const all = kept(indexDir);
  const stays = all.filter(
    (k, i) =>
      now - k.hold.builtAt <= RESTORE_MAX_AGE_MS &&
      !all.slice(0, i).some((later) => covers(later.hold, k.hold.region, k.hold.parts))
  );
  const keepDirs = new Set(stays.slice(0, KEPT).map((k) => k.dir));
  for (const name of names(root)) {
    const dir = path.join(root, name.replace(/\.held\.json$/, ""));
    if (!keepDirs.has(dir)) {
      await remove(path.join(root, name));
      await remove(dir);
    }
  }
}

/**
 * Copies the index in `indexDir`, which `hold` describes, among the kept ones, and prunes them.
 * Called before a build replaces that index, with no job reading it. A copy that fails is
 * removed and costs only a later build: nothing is thrown.
 */
export async function keep(
  indexDir: string,
  hold: SavedHold | undefined,
  now: number
): Promise<void> {
  if (!hold) {
    return;
  }
  const dir = path.join(keptRoot(indexDir), String(hold.builtAt));
  const partial = `${dir}.partial`;
  try {
    await remove(dir);
    await fs.promises.rm(partial, { recursive: true, force: true });
    await fs.promises.mkdir(keptRoot(indexDir), { recursive: true });
    await fs.promises.cp(indexDir, partial, { recursive: true });
    await synced(partial);
    await fs.promises.rename(partial, dir);
    // Last, and flushed: a record never describes a copy cut short.
    writeHold(dir, hold);
    await prune(indexDir, now);
  } catch {
    await fs.promises.rm(partial, { recursive: true, force: true }).catch(() => undefined);
  }
}
