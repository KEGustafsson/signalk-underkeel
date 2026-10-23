import { ESCAPE_EVERY_MS, EscapeSearch, SLOW_TICK_MS } from "../src/escape-search";

/**
 * A search queued after a tick is dropped when a later tick ends the danger
 * or is not escapable, also where the deferral cannot cancel it.
 */

function search(cancellable: boolean) {
  let now = 0;
  const queued: (() => void)[] = [];
  const published: (number | null)[] = [];
  const escape = new EscapeSearch(
    {
      now: () => now,
      defer: (fn) => queued.push(fn),
      ...(cancellable ? { cancel: () => queued.splice(0) } : {})
    },
    () => 1.5,
    (h) => published.push(h)
  );
  return {
    escape,
    published,
    flush: () => queued.splice(0).forEach((fn) => fn()),
    advance: (ms: number) => (now += ms)
  };
}

describe.each([true, false])("escape search (deferral cancels: %s)", (cancellable) => {
  test("a calm tick before the queued search runs drops it", () => {
    const s = search(cancellable);
    s.escape.after("alarm", 0);
    s.escape.after("normal", 0);
    s.flush();
    expect(s.published).toEqual([]);
    expect(s.escape.heading).toBeNull();
  });

  test("a tick that is not escapable publishes and queues no heading", () => {
    const s = search(cancellable);
    s.escape.after("alarm", 0);
    s.flush();
    expect(s.escape.headingFor("alarm")).toBe(1.5);
    expect(s.escape.headingFor("warn", false)).toBeNull();
    s.advance(10_000);
    s.escape.after("warn", 0, false);
    s.flush();
    expect(s.published).toEqual([1.5]);
    expect(s.escape.heading).toBeNull();
  });
});

test("a search that is always slow runs no more often than every ESCAPE_EVERY_MS", () => {
  let now = 0;
  let searches = 0;
  const published: (number | null)[] = [];
  const escape = new EscapeSearch(
    { now: () => now },
    () => {
      searches++;
      now += SLOW_TICK_MS + 50;
      return 1.5;
    },
    (h) => published.push(h)
  );
  const skipped: (string | undefined)[] = [];
  const ticks = 12;
  for (let i = 0; i < ticks; i++) {
    now = i * 1000;
    escape.after("warn", 5);
    skipped.push(escape.skipped);
  }
  expect(searches).toBeLessThanOrEqual(Math.ceil((ticks * 1000) / ESCAPE_EVERY_MS));
  // The status names the skip until the next search runs, not on every other tick.
  expect(skipped.slice(1, 4).every((s) => s !== undefined)).toBe(true);
  expect(published.slice(0, 2)).toEqual([1.5, null]);
});
