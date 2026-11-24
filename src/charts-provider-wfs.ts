/**
 * The WFS read through signalk-charts-provider-simple's local WFS proxy, when
 * it serves one: each area is downloaded once and read from its store again
 * (that plugin's docs/wfs-proxy.md). The proxy speaks the same WFS, so only
 * the URL changes; the build processes read it like the upstream.
 *
 * Charts Provider offers the proxy as the `chartsProviderWfs` PropertyValue, once
 * per server process, whichever plugin starts first; its members answer for the
 * proxy running at the time of each call (`watchChartsProviderWfs`).
 */

/** The PropertyValue Charts Provider offers its WFS proxy as. */
export const WFS_PROPERTY = "chartsProviderWfs";
/** The version of that offer read here. */
export const WFS_PROXY_API_VERSION = 1;

/** The part of Charts Provider's `ChartsProviderWfsApi` used here. */
export interface ChartsProviderWfsApi {
  apiVersion: number;
  /** The proxy's URL for the WFS at `upstream`; undefined when not proxied or no proxy runs. */
  proxyUrl: (upstream: string) => string | undefined;
  /** The upstream WFS base URLs proxied; none while no proxy runs. */
  upstreams?: () => string[];
}

/** The part of the server's PropertyValues API used here. */
interface PropertyValues {
  onPropertyValues?: (
    name: string,
    cb: (history: ({ value: unknown } | undefined)[]) => void
  ) => () => void;
}

/** The proxy offer taken last; undefined while none is. */
let offered: ChartsProviderWfsApi | undefined;

/** Whether `v` is an offer of the version read here, with the call this plugin makes. */
function isOffer(v: unknown): v is ChartsProviderWfsApi {
  const o = v as Partial<ChartsProviderWfsApi> | null;
  return (
    typeof o === "object" &&
    o !== null &&
    o.apiVersion === WFS_PROXY_API_VERSION &&
    typeof o.proxyUrl === "function"
  );
}

/**
 * Follows Charts Provider's `chartsProviderWfs` offer: its last value, when it has the shape and
 * version read here, is the proxy `wfsUrl` asks. Returns the call that stops following it and
 * forgets the offer. A server with no PropertyValues (a test harness) offers none.
 */
export function watchChartsProviderWfs(app: PropertyValues): () => void {
  if (typeof app.onPropertyValues !== "function") {
    return () => undefined;
  }
  const unsubscribe = app.onPropertyValues(WFS_PROPERTY, (history) => {
    const last = history[history.length - 1]?.value;
    offered = isOffer(last) ? last : undefined;
  });
  return () => {
    unsubscribe();
    offered = undefined;
  };
}

/** The proxy offer followed now (`watchChartsProviderWfs`), if any. */
export const chartsProviderWfs = (): ChartsProviderWfsApi | undefined => offered;

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
  api: ChartsProviderWfsApi | undefined = offered
): string {
  if (!via || !isOffer(api)) {
    return upstream;
  }
  try {
    const url = api.proxyUrl(upstream);
    return typeof url === "string" && LOOPBACK.test(url) ? url : upstream;
  } catch {
    return upstream;
  }
}

/**
 * The WFS URLs among `upstreams` Charts Provider's proxy runs but does not keep, for the setup
 * hint that names them; none while no proxy runs or its list cannot be read.
 */
export function unproxied(
  upstreams: readonly string[],
  api: ChartsProviderWfsApi | undefined = offered
): string[] {
  if (!isOffer(api) || typeof api.upstreams !== "function") {
    return [];
  }
  try {
    const kept = api.upstreams();
    // No proxy running: nothing to add sources to.
    return Array.isArray(kept) && kept.length > 0
      ? upstreams.filter((u) => api.proxyUrl(u) === undefined)
      : [];
  } catch {
    return [];
  }
}
