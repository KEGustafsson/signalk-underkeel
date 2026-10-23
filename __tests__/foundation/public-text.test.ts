import { publicReason } from "../../src/foundation/public-text";

/** One form for a server reason on the wire: status, 5xx replies and notifications. */

describe("public reason", () => {
  test("nested error text gives way to the server log", () => {
    expect(
      publicReason(
        "chart index failed: ENOENT: no such file or directory, scandir '/media/usb/ENC'"
      )
    ).toBe("chart index failed (see the server log)");
    expect(publicReason("chart index failed: disk gone; using the last one")).toBe(
      "chart index failed (see the server log); using the last one"
    );
  });

  test("why a saved index could not be read is kept, reported nowhere else, without its paths", () => {
    expect(
      publicReason("rebuilt the index: the saved one could not be read (bad header in /x/y.bin)")
    ).toBe("rebuilt the index: the saved one could not be read (bad header in <path>)");
    expect(
      publicReason("rebuilt the index: the saved one could not be read (pyramid file is truncated)")
    ).toBe("rebuilt the index: the saved one could not be read (pyramid file is truncated)");
  });

  test.each([
    ["no cells in /srv/signalk/charts", "no cells in <path>"],
    ["no cells in /srv/signalk/charts.", "no cells in <path>."],
    ["no chart index in /srv/sk/index: set cellsDir", "no chart index in <path>: set cellsDir"],
    ["EACCES: open '/srv/sk/wfs/box.json'", "EACCES: open '<path>'"],
    ["write (/srv/sk/x.json) refused", "write (<path>) refused"],
    ["--cells=/srv/sk/charts", "--cells=<path>"]
  ])("a POSIX path is hidden whole: %s", (raw, shown) => {
    expect(publicReason(raw)).toBe(shown);
  });

  test.each([
    [
      "no chart index in C:\\srv\\sk\\index; set cellsDir",
      "no chart index in <path>; set cellsDir"
    ],
    ["no cells in D:/srv/charts", "no cells in <path>"],
    ["no cells in \\\\nas\\charts\\enc", "no cells in <path>"],
    ["EPERM: open 'C:\\srv\\sk\\box.json'", "EPERM: open '<path>'"]
  ])("a Windows path is hidden whole: %s", (raw, shown) => {
    expect(publicReason(raw)).toBe(shown);
  });

  test("an S-57 cell file keeps its name, its directory does not", () => {
    expect(publicReason("cell /srv/charts/ENC_ROOT/US5MA22M/US5MA22M.000: bad record")).toBe(
      "cell <path>/US5MA22M.000: bad record"
    );
    expect(publicReason("update C:\\srv\\charts\\FI5HKI01.002 skipped")).toBe(
      "update <path>/FI5HKI01.002 skipped"
    );
  });

  test("URLs, cell names, numbers and plain reasons are kept as they are", () => {
    for (const kept of [
      "no chart index loaded",
      "fetch https://example.org/wfs/ows?typeName=a/b returned 503",
      "file:///srv/x is a URL",
      "skipped X.000 in cells: not a cell directory",
      "skipped FI5HKI01.000 in ENC_ROOT/FI5HKI01: no DSID",
      "HTTP 503 1/2 layers at 3 m/s",
      "~/charts holds no cells",
      "busy: 5 requests are waiting; try again shortly",
      "charted 2.1 m (±0.5 m) − draft 1.8 m → μ = −0.3 m, σ = 0.4 m, P = 77 %"
    ]) {
      expect(publicReason(kept)).toBe(kept);
    }
  });

  test("undefined stays undefined", () => {
    expect(publicReason(undefined)).toBeUndefined();
  });
});
