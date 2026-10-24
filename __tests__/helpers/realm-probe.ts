/** A global the realm test assigns; declared here so the lookup below is a bare identifier. */
declare const __underkeelProbe: number | undefined;

/** Reads `__underkeelProbe` by bare global lookup, from another module than the test's. */
export function readProbe(): number | undefined {
  return typeof __underkeelProbe === "undefined" ? undefined : __underkeelProbe;
}
