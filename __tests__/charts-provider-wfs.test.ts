import { wfsUrl } from "../src/charts-provider-wfs";
import { DEFAULT_WFS_URL } from "../src/ingest/wfs";
import { parseConfig } from "../src/config";

/** The WFS read through signalk-charts-provider-simple's local WFS proxy. */

const PROXY = "http://127.0.0.1:41234/token/aHR0cHM6Ly9qdWxraW5lbg";

describe("wfsUrl", () => {
  test("the proxy's URL for the WFS when the charts provider proxies it", () => {
    const asked: string[] = [];
    const g = {
      __signalk_chartsProviderWfs: {
        apiVersion: 1,
        proxyUrl: (u: string) => {
          asked.push(u);
          return PROXY;
        }
      }
    };
    expect(wfsUrl(DEFAULT_WFS_URL, true, g)).toBe(PROXY);
    expect(asked).toEqual([DEFAULT_WFS_URL]);
  });

  test("the WFS itself when the setting is off, there is no proxy, or it does not proxy it", () => {
    const g = { __signalk_chartsProviderWfs: { apiVersion: 1, proxyUrl: () => PROXY } };
    expect(wfsUrl(DEFAULT_WFS_URL, false, g)).toBe(DEFAULT_WFS_URL);
    expect(wfsUrl(DEFAULT_WFS_URL, true, {})).toBe(DEFAULT_WFS_URL);
    const none = { __signalk_chartsProviderWfs: { apiVersion: 1, proxyUrl: () => undefined } };
    expect(wfsUrl(DEFAULT_WFS_URL, true, none)).toBe(DEFAULT_WFS_URL);
    // An older charts provider without the call.
    expect(wfsUrl(DEFAULT_WFS_URL, true, { __signalk_chartsProviderWfs: { apiVersion: 1 } })).toBe(
      DEFAULT_WFS_URL
    );
  });

  test("never a URL off the loopback interface, and never a throw", () => {
    const remote = {
      __signalk_chartsProviderWfs: {
        apiVersion: 1,
        proxyUrl: () => "https://elsewhere.example/wfs"
      }
    };
    expect(wfsUrl(DEFAULT_WFS_URL, true, remote)).toBe(DEFAULT_WFS_URL);
    const broken = {
      __signalk_chartsProviderWfs: {
        apiVersion: 1,
        proxyUrl: () => {
          throw new Error("stopping");
        }
      }
    };
    expect(wfsUrl(DEFAULT_WFS_URL, true, broken)).toBe(DEFAULT_WFS_URL);
  });

  test("the setting is on unless turned off", () => {
    expect(parseConfig({ wfs: { enabled: true } }).wfs?.viaChartsProvider).toBe(true);
    expect(
      parseConfig({ wfs: { enabled: true, viaChartsProvider: false } }).wfs?.viaChartsProvider
    ).toBe(false);
  });
});
