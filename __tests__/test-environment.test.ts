import vm from "node:vm";
import { readProbe } from "./helpers/realm-probe";

/**
 * The test runtime (DEVELOPMENT-PLAN §7): the fast realm is active.
 */

const MARK = Symbol.for("signalk-underkeel.uncontextified-realm");
// A symbol at run time (@types/node says number); undefined before Node 22.8.
const plain = (vm.constants as { DONT_CONTEXTIFY?: unknown } | undefined)?.DONT_CONTEXTIFY;
const onPlainRealm = plain === undefined ? test.skip : test;

describe("test environment", () => {
  onPlainRealm(
    plain === undefined
      ? "Node < 22.8: stock (slow) environment"
      : "tests run on the uncontextified realm",
    () => {
      expect((globalThis as Record<symbol, unknown>)[MARK]).toBe(true);
    }
  );

  test("a global the test assigns is live in a helper module's bare lookup", () => {
    const g = globalThis as Record<string, unknown>;
    expect(readProbe()).toBeUndefined();
    g.__underkeelProbe = 1;
    try {
      expect(readProbe()).toBe(1);
    } finally {
      delete g.__underkeelProbe;
    }
    expect(readProbe()).toBeUndefined();
  });
});
