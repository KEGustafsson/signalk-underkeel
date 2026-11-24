import type { ChartsProviderWfsApi } from "../src/charts-provider-wfs";
import {
  chartsProviderWfs,
  unproxied,
  watchChartsProviderWfs,
  wfsUrl,
  WFS_PROPERTY
} from "../src/charts-provider-wfs";
import { DEFAULT_WFS_URL, FTIA_WFS_URL } from "../src/ingest/wfs";
import { parseConfig } from "../src/config";

/**
 * The WFS read through signalk-charts-provider-simple's local WFS proxy, which it offers as the
 * `chartsProviderWfs` PropertyValue.
 */

const PROXY = "http://127.0.0.1:41234/token/aHR0cHM6Ly9qdWxraW5lbg";

const offer = (
  proxyUrl: (u: string) => string | undefined,
  upstreams: () => string[] = () => [DEFAULT_WFS_URL]
): ChartsProviderWfsApi => ({ apiVersion: 1, proxyUrl, upstreams });

/** A server's PropertyValues: each listener gets the whole history, starting with undefined. */
function propertyValues() {
  const values: ({ value: unknown } | undefined)[] = [undefined];
  const listeners = new Set<(h: ({ value: unknown } | undefined)[]) => void>();
  const asked: string[] = [];
  return {
    asked,
    listeners,
    app: {
      onPropertyValues: (name: string, cb: (h: ({ value: unknown } | undefined)[]) => void) => {
        asked.push(name);
        listeners.add(cb);
        cb([...values]);
        return () => {
          listeners.delete(cb);
        };
      }
    },
    emit(value: unknown) {
      values.push({ value });
      listeners.forEach((cb) => cb([...values]));
    }
  };
}

describe("wfsUrl", () => {
  test("the proxy's URL for the WFS when the charts provider proxies it", () => {
    const asked: string[] = [];
    const api = offer((u) => {
      asked.push(u);
      return PROXY;
    });
    expect(wfsUrl(DEFAULT_WFS_URL, true, api)).toBe(PROXY);
    expect(asked).toEqual([DEFAULT_WFS_URL]);
  });

  test("the WFS itself when the setting is off, there is no proxy, or it does not proxy it", () => {
    const api = offer(() => PROXY);
    expect(wfsUrl(DEFAULT_WFS_URL, false, api)).toBe(DEFAULT_WFS_URL);
    expect(wfsUrl(DEFAULT_WFS_URL, true, undefined)).toBe(DEFAULT_WFS_URL);
    expect(
      wfsUrl(
        DEFAULT_WFS_URL,
        true,
        offer(() => undefined)
      )
    ).toBe(DEFAULT_WFS_URL);
    // Another version of the offer, or one without the call.
    expect(wfsUrl(DEFAULT_WFS_URL, true, { ...api, apiVersion: 2 })).toBe(DEFAULT_WFS_URL);
    expect(
      wfsUrl(DEFAULT_WFS_URL, true, { apiVersion: 1 } as unknown as ChartsProviderWfsApi)
    ).toBe(DEFAULT_WFS_URL);
  });

  test("never a URL off the loopback interface, and never a throw", () => {
    expect(
      wfsUrl(
        DEFAULT_WFS_URL,
        true,
        offer(() => "https://elsewhere.example/wfs")
      )
    ).toBe(DEFAULT_WFS_URL);
    const broken = offer(() => {
      throw new Error("stopping");
    });
    expect(wfsUrl(DEFAULT_WFS_URL, true, broken)).toBe(DEFAULT_WFS_URL);
  });

  test("the setting is on unless turned off", () => {
    expect(parseConfig({ wfs: { enabled: true } }).wfs?.viaChartsProvider).toBe(true);
    expect(
      parseConfig({ wfs: { enabled: true, viaChartsProvider: false } }).wfs?.viaChartsProvider
    ).toBe(false);
  });
});

describe("the chartsProviderWfs PropertyValue", () => {
  test("its last value is the proxy asked, whether it came before the watch or after", () => {
    const pv = propertyValues();
    pv.emit(offer(() => PROXY));
    const stop = watchChartsProviderWfs(pv.app);
    expect(pv.asked).toEqual([WFS_PROPERTY]);
    expect(wfsUrl(DEFAULT_WFS_URL)).toBe(PROXY);
    // A later offer replaces it.
    const other = "http://127.0.0.1:41999/other/aHR0cHM6Ly9qdWxraW5lbg";
    pv.emit(offer(() => other));
    expect(wfsUrl(DEFAULT_WFS_URL)).toBe(other);
    stop();
    // Stopped: no proxy, and nothing followed.
    expect(chartsProviderWfs()).toBeUndefined();
    expect(wfsUrl(DEFAULT_WFS_URL)).toBe(DEFAULT_WFS_URL);
    expect(pv.listeners.size).toBe(0);
  });

  test("an offer that comes once the watch runs is taken", () => {
    const pv = propertyValues();
    const stop = watchChartsProviderWfs(pv.app);
    expect(wfsUrl(DEFAULT_WFS_URL)).toBe(DEFAULT_WFS_URL);
    pv.emit(offer(() => PROXY));
    expect(wfsUrl(DEFAULT_WFS_URL)).toBe(PROXY);
    stop();
  });

  test("a last value of another shape or version is no proxy, an earlier good one aside", () => {
    const pv = propertyValues();
    const stop = watchChartsProviderWfs(pv.app);
    pv.emit(offer(() => PROXY));
    pv.emit({ apiVersion: 2, proxyUrl: () => PROXY });
    expect(chartsProviderWfs()).toBeUndefined();
    pv.emit("not an offer");
    expect(wfsUrl(DEFAULT_WFS_URL)).toBe(DEFAULT_WFS_URL);
    stop();
  });

  test("a server without PropertyValues offers none", () => {
    const stop = watchChartsProviderWfs({});
    expect(chartsProviderWfs()).toBeUndefined();
    stop();
  });
});

describe("the WFS servers the proxy does not keep", () => {
  test("named while a proxy runs that does not proxy them", () => {
    const keepsTraficom = offer(
      (u) => (u === DEFAULT_WFS_URL ? PROXY : undefined),
      () => [DEFAULT_WFS_URL]
    );
    expect(unproxied([DEFAULT_WFS_URL, FTIA_WFS_URL], keepsTraficom)).toEqual([FTIA_WFS_URL]);
    const keepsBoth = offer(
      () => PROXY,
      () => [DEFAULT_WFS_URL, FTIA_WFS_URL]
    );
    expect(unproxied([DEFAULT_WFS_URL, FTIA_WFS_URL], keepsBoth)).toEqual([]);
  });

  test("none while no proxy runs, there is no offer, or its list cannot be read", () => {
    const stopped = offer(
      () => undefined,
      () => []
    );
    expect(unproxied([DEFAULT_WFS_URL], stopped)).toEqual([]);
    expect(unproxied([DEFAULT_WFS_URL], undefined)).toEqual([]);
    const broken = offer(
      () => undefined,
      () => {
        throw new Error("stopping");
      }
    );
    expect(unproxied([DEFAULT_WFS_URL], broken)).toEqual([]);
  });

  test("its stats tell a running proxy with no sources from a stopped one", () => {
    const stats = { features: 0, areas: 0, bytes: 0 };
    const empty = {
      ...offer(
        () => undefined,
        () => []
      ),
      stats: () => stats
    };
    // Running, no WFS sources: both servers are named.
    expect(unproxied([DEFAULT_WFS_URL, FTIA_WFS_URL], empty)).toEqual([
      DEFAULT_WFS_URL,
      FTIA_WFS_URL
    ]);
    // Stopped: nothing to add sources to.
    expect(unproxied([DEFAULT_WFS_URL], { ...empty, stats: () => undefined })).toEqual([]);
    const broken = {
      ...empty,
      stats: () => {
        throw new Error("stopping");
      }
    };
    expect(unproxied([DEFAULT_WFS_URL], broken)).toEqual([]);
  });
});
