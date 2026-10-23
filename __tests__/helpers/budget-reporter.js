"use strict";
const path = require("node:path");

/** How many of the slowest test files the run summary names. */
const SLOWEST = 10;

/**
 * Jest reporter: prints the slowest test files and the run's wall time, and fails
 * the run when UNDERKEEL_TEST_BUDGET_S is a positive number of seconds and the run
 * took longer (AGENTS.md Validation; DEVELOPMENT-PLAN §7, Test runtime). With the
 * variable unset it never fails; CI sets it on `npm run verify`.
 */
class BudgetReporter {
  /**
   * @param {{ rootDir: string }} globalConfig
   * @param {unknown} [_options]
   * @param {unknown} [_context]
   * @param {() => number} [now] clock in ms since the epoch, for tests
   */
  constructor(globalConfig, _options, _context, now = Date.now) {
    this.rootDir = globalConfig.rootDir;
    this.now = now;
    /** @type {Error | undefined} */
    this.error = undefined;
  }

  /**
   * @param {unknown} _contexts
   * @param {{ startTime: number, testResults: Array<{ testFilePath: string,
   *   perfStats: { start: number, end: number } }> }} results
   */
  onRunComplete(_contexts, results) {
    const wall = (this.now() - results.startTime) / 1000;
    const slowest = results.testResults
      .map((r) => ({
        file: path.relative(this.rootDir, r.testFilePath),
        s: (r.perfStats.end - r.perfStats.start) / 1000
      }))
      .sort((a, b) => b.s - a.s)
      .slice(0, SLOWEST);
    const lines = slowest.map((f) => `  ${f.s.toFixed(1).padStart(6)} s  ${f.file}`);
    const budget = Number(process.env.UNDERKEEL_TEST_BUDGET_S);
    this.error =
      budget > 0 && wall > budget
        ? new Error(
            `npm test took ${wall.toFixed(1)} s, over the ${budget} s budget ` +
              "(AGENTS.md Validation; DEVELOPMENT-PLAN §7)"
          )
        : undefined;
    // @jest/core exits non-zero on getLastError() but never prints it, so say why here.
    const verdict = this.error ? `${this.error.message}\n` : "";
    process.stderr.write(
      `Slowest test files:\n${lines.join("\n")}\nTest run wall time: ${wall.toFixed(1)} s\n` +
        verdict
    );
  }

  /** @returns {Error | undefined} the over-budget error; @jest/core then exits non-zero */
  getLastError() {
    return this.error;
  }
}

module.exports = BudgetReporter;
