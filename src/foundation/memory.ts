import os from "os";

/**
 * The RAM this process may use: the container's memory limit when it sets
 * one, else the machine's. In Docker os.totalmem() reports the host's RAM, and
 * a build sized from that is ended by the kernel with the whole server.
 */
export function usableMemory(
  total = os.totalmem(),
  constrained = process.constrainedMemory()
): number {
  return constrained > 0 ? Math.min(constrained, total) : total;
}
