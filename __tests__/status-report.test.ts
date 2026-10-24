import type { ApiProvider } from "../src/api/routes";
import { registerRoutes } from "../src/api/routes";
import type { WfsService } from "../src/wfs-service";
import { statusReport } from "../src/status-report";
import { fakeRouter } from "./helpers/plugin-harness";

/** `GET /status` is read-only: the server's directories stay off the wire. */

const stopped = {
  state: "off" as const,
  reason: "plugin stopped",
  since: new Date(0).toISOString()
};

describe("status report paths", () => {
  test("the index directory and the full paths in reasons are not reported", () => {
    const wfs = {
      status: () => ({
        notice: "n",
        busy: false,
        lastError: "EPERM: open 'C:\\srv\\sk\\wfs\\box.json'"
      })
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
        stopped,
        now: 0
      })
    );
    expect(body).not.toMatch(/srv|box\.json|charts/);
    expect(body).toContain("no cells in <path>");
    expect(body).toContain("EPERM: open '<path>'");
  });

  test("a failed index load reads the same in the status as in the 503 for it", async () => {
    const reason = "chart index failed: ENOENT: no such file or directory, scandir '/srv/usb/ENC'";
    const report = statusReport({
      load: { indexDir: "/srv/index", built: false, reason },
      monitor: undefined,
      stopped,
      now: 0
    }) as { index: { reason: string } };
    const api = {
      query: () => Promise.resolve({ status: 503, body: { errors: [reason] } })
    } as unknown as ApiProvider;
    const { router, post } = fakeRouter();
    registerRoutes(router as never, api);
    const reply = await post("/v1/query", {});
    expect(report.index.reason).toBe("chart index failed (see the server log)");
    expect(reply).toEqual({ code: 503, body: { errors: [report.index.reason] } });
  });
});
