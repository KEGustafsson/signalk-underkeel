"use strict";
const vm = require("node:vm");
const { TestEnvironment: NodeEnvironment } = require("jest-environment-node");

/** Set on the test global when the fast realm is active; test-environment.test.ts checks it. */
const MARK = Symbol.for("signalk-underkeel.uncontextified-realm");
// Node >= 22.8: a context whose global is an ordinary object, so global lookups
// (Math, Number, typed arrays) run at plain-Node speed instead of through the
// interceptor and Proxy the stock environment puts in front of every one.
const PLAIN = vm.constants?.DONT_CONTEXTIFY;

/**
 * Jest's node environment built on a DONT_CONTEXTIFY context (DEVELOPMENT-PLAN §7,
 * Test runtime). Everything else (globals, fake timers, module mocker) is the stock
 * constructor's. On a Node without DONT_CONTEXTIFY it is the stock environment.
 */
class UncontextifiedNodeEnvironment extends NodeEnvironment {
  constructor(config, context) {
    const createContext = vm.createContext;
    let calls = 0;
    if (PLAIN !== undefined) {
      // NodeEnvironment calls vm.createContext exactly once, synchronously, in its constructor.
      vm.createContext = () => {
        calls += 1;
        return createContext(PLAIN);
      };
    }
    try {
      super(config, context);
    } finally {
      vm.createContext = createContext;
    }
    if (PLAIN !== undefined) {
      if (calls !== 1 || this.context !== this.global) {
        throw new Error(
          "jest-environment-node no longer builds its context with one vm.createContext call; " +
            "update __tests__/helpers/node-realm-environment.js (tests would run about 15x slower)"
        );
      }
      Object.defineProperty(this.global, MARK, { value: true });
    }
    this.setupKeys = new Set(Reflect.ownKeys(this.global));
  }

  async teardown() {
    const g = this.global;
    await super.teardown();
    if (PLAIN === undefined || g === null || g === undefined) {
      return;
    }
    // Replaces the GlobalProxy cleanup, which saw nothing: drop only what the test
    // file added to the global. Never delete intrinsics, which late async callbacks
    // may still read.
    for (const k of Reflect.ownKeys(g)) {
      if (this.setupKeys.has(k)) {
        continue;
      }
      if (Object.getOwnPropertyDescriptor(g, k)?.configurable) {
        delete g[k];
      }
    }
  }
}

module.exports = UncontextifiedNodeEnvironment;
