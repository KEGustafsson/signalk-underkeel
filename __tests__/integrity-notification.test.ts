import type { IntegrityResult } from "../src/model/integrity";
import { integrityUpdate } from "../src/notifications";

/** The position-integrity notification repeats on a new kind of reason, not on drifting numbers. */

const key = (reasons: string[]): string =>
  integrityUpdate({ ok: false, reasons, sigmaPos: 40, divergence: 30 }, 0).repeat.key;

test("a drifting HDOP or divergence keeps the repeat key", () => {
  expect(key(["HDOP 4.1", "GNSS and dead reckoning differ by 31 m"])).toBe(
    key(["HDOP 4.7", "GNSS and dead reckoning differ by 58 m"])
  );
});

test("a change of fix quality is a new kind of reason", () => {
  expect(key(['GNSS fix quality "2D fix"'])).not.toBe(key(['GNSS fix quality "3D fix"']));
});
