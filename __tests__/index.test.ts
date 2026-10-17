import type { ServerAPI } from "@signalk/server-api";
import underkeel = require("../src/index");

type Handler = (req: unknown, res: { json: (body: unknown) => void }) => void;

function fakeApp() {
  const messages: unknown[] = [];
  const statuses: string[] = [];
  const app = {
    handleMessage: (_id: string, msg: unknown) => messages.push(msg),
    setPluginStatus: (msg: string) => statuses.push(msg),
    setPluginError: jest.fn()
  } as unknown as ServerAPI;
  return { app, messages, statuses };
}

function fakeRouter() {
  const routes = new Map<string, Handler>();
  const router = { get: (path: string, handler: Handler) => routes.set(path, handler) };
  const call = (path: string): unknown => {
    let body: unknown;
    routes.get(path)?.({}, { json: (b) => (body = b) });
    return body;
  };
  return { router, routes, call };
}

describe("plugin lifecycle", () => {
  test("identifies itself", () => {
    const plugin = underkeel(fakeApp().app);
    expect(plugin.id).toBe("signalk-underkeel");
    expect(plugin.name).toBe("Under-Keel Awareness");
  });

  test("start publishes state off with a reason, never normal", () => {
    const { app, messages, statuses } = fakeApp();
    const plugin = underkeel(app);
    plugin.start({}, () => undefined);

    expect(messages).toEqual([
      { updates: [{ values: [{ path: "navigation.underKeel.state", value: "off" }] }] }
    ]);
    expect(statuses[0]).toMatch(/monitoring OFF/);
  });

  test("GET /v1/status reports the engine state and reason", () => {
    const plugin = underkeel(fakeApp().app);
    const { router, call } = fakeRouter();
    plugin.registerWithRouter?.(router as never);

    expect(call("/v1/status")).toMatchObject({
      engine: { state: "off", reason: "plugin not started" }
    });

    plugin.start({}, () => undefined);
    expect(call("/v1/status")).toMatchObject({
      engine: { state: "off", reason: "risk engine not implemented" }
    });

    plugin.stop();
    expect(call("/v1/status")).toMatchObject({
      engine: { state: "off", reason: "plugin stopped" }
    });
  });
});
