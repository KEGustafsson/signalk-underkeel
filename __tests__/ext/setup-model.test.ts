import M = require("../../public/setup-model.js");
import { WARNING_PRESETS } from "../../src/config-presets";

/** The setup panel's logic: its edits as a patch, the drawing scale and the style in words. */

describe("setup edits", () => {
  const saved = { vessel: { draft: 2, margin: 0.3 }, warningStyle: "balanced" };

  test("a changed value goes into the patch, an unchanged one stays out", () => {
    let p = M.setEdit({}, saved, "vessel.draft", 2.2);
    expect(p).toEqual({ vessel: { draft: 2.2 } });
    p = M.setEdit(p, saved, "vessel.draft", 2);
    expect(p).toEqual({});
    expect(M.setEdit({}, saved, "warningStyle", "balanced")).toEqual({});
  });

  // An emptied draft must reach the server as a removal, so Signal K's draft applies again.
  test("emptying a saved field removes it; emptying an unsaved one sends nothing", () => {
    expect(M.setEdit({}, saved, "vessel.draft", undefined)).toEqual({ vessel: { draft: null } });
    expect(M.setEdit({}, saved, "vessel.keel", "")).toEqual({});
    expect(M.current(saved, { vessel: { draft: null } }, "vessel.draft")).toBeUndefined();
    expect(M.current(saved, {}, "vessel.margin")).toBe(0.3);
  });

  test("leaves the patch it was given unchanged", () => {
    const p = { vessel: { margin: 0.2 } };
    M.setEdit(p, saved, "vessel.margin", 0.5);
    expect(p).toEqual({ vessel: { margin: 0.2 } });
  });

  test("typed metres take a comma or a point; anything else is no number", () => {
    expect([M.metres("2,15"), M.metres(" 1.8 "), M.metres(""), M.metres("deep")]).toEqual([
      2.15,
      1.8,
      undefined,
      undefined
    ]);
  });

  test("a drag moves in 5 cm steps and never below the floor", () => {
    expect([M.snap(1.234), M.snap(-0.4), M.snap(0.02, 0.1)]).toEqual([1.25, 0, 0.1]);
  });

  test("the drawing fits draft, margin and room below in the given height", () => {
    expect(M.boatScale(2, 0.5, 140)).toBeCloseTo(140 / 2.8, 9);
    expect(M.boatScale(0, 0, 140)).toBe(140);
  });
});

describe("warning style in words", () => {
  test("balanced at 6 kn warns about 370 m before shoal water", () => {
    expect(M.styleLines(WARNING_PRESETS.balanced, 6)).toEqual({
      alert: "1 % chance of touching",
      warn: "5 % chance, within 2 min",
      alarm: "20 % chance within 60 s, or aground in 30 s",
      ahead: "Looks 0.3 NM ahead. At 6 kn it warns about 370 m before shoal water."
    });
    expect(M.styleLines(WARNING_PRESETS.early, 6).alert).toBe("0.5 % chance of touching");
  });
});

describe("save outcome", () => {
  test.each([
    [202, null, true, /^Sent\. The plugin saves the settings and restarts/],
    [401, null, false, /administrator/],
    [403, null, false, /administrator/],
    [400, { errors: ["vessel.draft must be a number"] }, false, /Not saved: vessel\.draft/],
    [500, null, false, /HTTP 500/]
  ])("HTTP %s", (status, body, ok, text) => {
    const m = M.saveMessage(status as number, body);
    expect(m.ok).toBe(ok);
    expect(m.text).toMatch(text as RegExp);
  });
});
