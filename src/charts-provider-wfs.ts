/**
 * The WFS read through signalk-charts-provider-simple's local WFS proxy, when
 * it serves one: each area is downloaded once and read from its store again
 * (that plugin's docs/wfs-proxy.md). The proxy speaks the same WFS, so only
 * the URL changes; the build processes read it like the upstream.
 */

/** The part of `globalThis.__signalk_chartsProviderWfs` used here. */
export interface ChartsProviderWfsApi {
  apiVersion: number;
  proxyUrl?: (upstream: string) => string | undefined;
}

/** The proxy listens on the loopback interface alone; any other URL is not its. */
const LOOPBACK = /^http:\/\/127\.0\.0\.1:\d+\//;

/**
 * The URL to read the WFS at `upstream` from: the charts provider's proxy for
 * it when `via` and the proxy serves it, else `upstream` itself. Asked for each
 * download, as the proxy's port is the charts provider's process's.
 */
export function wfsUrl(
  upstream: string,
  via = true,
  g: Record<string, unknown> = globalThis as unknown as Record<string, unknown>
): string {
  if (!via) {
    return upstream;
  }
  const api = g.__signalk_chartsProviderWfs as ChartsProviderWfsApi | undefined;
  if (typeof api?.proxyUrl !== "function") {
    return upstream;
  }
  try {
    const url = api.proxyUrl(upstream);
    return typeof url === "string" && LOOPBACK.test(url) ? url : upstream;
  } catch {
    return upstream;
  }
}
