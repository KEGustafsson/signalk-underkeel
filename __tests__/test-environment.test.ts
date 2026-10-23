import vm from "node:vm";
import path from "path";
import { checkAssertionCount, MAX_ASSERTIONS_PER_TEST } from "./helpers/assertion-budget";
import BudgetReporter = require("./helpers/budget-reporter.js");
import { readProbe } from "./helpers/realm-probe";

/**
 * The test runtime (DEVELOPMENT-PLAN §7): the fast realm is active, the per-test
 * assertion budget holds, and the wall-time budget fails a slow run only when set.
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

describe("assertion budget", () => {
  test(`allows ${MAX_ASSERTIONS_PER_TEST} expect() calls in one test and refuses one more`, () => {
    expect(() => checkAssertionCount(MAX_ASSERTIONS_PER_TEST)).not.toThrow();
    expect(() => checkAssertionCount(MAX_ASSERTIONS_PER_TEST + 1)).toThrow(
      `${MAX_ASSERTIONS_PER_TEST + 1} expect() calls in one test`
    );
    // The per-element loops it was set against: pyramid-build-equality's 42,012 calls.
    expect(() => checkAssertionCount(42012)).toThrow();
  });
});

describe("wall-time budget reporter", () => {
  const root = path.join(__dirname, "..");
  const fast = path.join("__tests__", "fast.test.ts");
  const slow = path.join("__tests__", "slow.test.ts");
  const START = 1_000_000;

  /** Reports a run of `wallS` seconds with UNDERKEEL_TEST_BUDGET_S set to `budget`. */
  const run = (
    budget: string | undefined,
    wallS: number
  ): { error: Error | undefined; printed: string } => {
    const saved = process.env.UNDERKEEL_TEST_BUDGET_S;
    const write = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      if (budget === undefined) {
        delete process.env.UNDERKEEL_TEST_BUDGET_S;
      } else {
        process.env.UNDERKEEL_TEST_BUDGET_S = budget;
      }
      const reporter = new BudgetReporter({ rootDir: root }, {}, {}, () => START + 1000 * wallS);
      reporter.onRunComplete(undefined, {
        startTime: START,
        testResults: [
          { testFilePath: path.join(root, fast), perfStats: { start: 0, end: 2000 } },
          { testFilePath: path.join(root, slow), perfStats: { start: 0, end: 9000 } }
        ]
      });
      const printed = String(write.mock.calls[0]?.[0]);
      expect(printed.indexOf(slow)).toBeGreaterThan(-1);
      expect(printed.indexOf(slow)).toBeLessThan(printed.indexOf(fast));
      expect(printed).toContain(`Test run wall time: ${wallS.toFixed(1)} s`);
      return { error: reporter.getLastError(), printed };
    } finally {
      write.mockRestore();
      if (saved === undefined) {
        delete process.env.UNDERKEEL_TEST_BUDGET_S;
      } else {
        process.env.UNDERKEEL_TEST_BUDGET_S = saved;
      }
    }
  };

  test("fails a run over the budget, and prints why since Jest does not", () => {
    const { error, printed } = run("120", 130.04);
    expect(error?.message).toContain("took 130.0 s, over the 120 s budget");
    expect(printed).toContain(error?.message);
  });

  test("passes a run within the budget, and any run with the budget unset or not positive", () => {
    for (const [budget, wallS] of [
      ["120", 119],
      [undefined, 1e6],
      ["", 1e6],
      ["0", 1e6],
      ["soon", 1e6]
    ] as const) {
      const { error, printed } = run(budget, wallS);
      expect(error).toBeUndefined();
      expect(printed).not.toContain("budget");
    }
  });
});
