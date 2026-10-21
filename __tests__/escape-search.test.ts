import { EscapeSearch } from "../src/escape-search";

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
