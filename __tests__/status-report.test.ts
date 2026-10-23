import type { WfsService } from "../src/wfs-service";
import { statusReport, withoutPaths } from "../src/status-report";

/** `GET /status` is read-only: the server's directories stay off the wire. */

describe("status report paths", () => {
  test("a reason keeps the last part of each absolute path, and URLs and cell names as they are", () => {
    expect(
      withoutPaths(
        "chart index failed: ENOENT: no such file or directory, scandir '/media/usb/ENC'"
      )
    ).toBe("chart index failed: ENOENT: no such file or directory, scandir '…/ENC'");
    expect(withoutPaths("no cells in /srv/signalk/charts")).toBe("no cells in …/charts");
    for (const kept of [
      "fetch https://example.org/wfs/ows failed",
      "skipped X.000 in cells: not a cell directory",
      "HTTP 503 1/2 layers"
    ]) {
      expect(withoutPaths(kept)).toBe(kept);
    }
  });

  test("the index directory and the full paths in reasons are not reported", () => {
    const wfs = {
      status: () => ({ notice: "n", busy: false, lastError: "EACCES: open '/srv/sk/wfs/box.json'" })
    } as unknown as WfsService;
    const body = JSON.stringify(
      statusReport({
        load: {
          indexDir: "/srv/signalk/.signalk/plugin-config-data/signalk-underkeel/index",
          built: false,
          reason: "no cells in /srv/signalk/charts"
        },
        monitor: undefined,
        wfs,
        stopped: { state: "off", reason: "plugin stopped", since: new Date(0).toISOString() },
        now: 0
      })
    );
    expect(body).not.toMatch(/sailor|\/srv/);
    expect(body).toContain("no cells in …/charts");
    expect(body).toContain("…/box.json");
  });
});
