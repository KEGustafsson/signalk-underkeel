// Which colour scheme of theme.css a page shows. Plain script: the pages load it with
// <script>, the tests require() it.
//
// The chart host's night mode wins: on, the page is "night"; off, or not offered, the page
// follows the OS preference (day, or dusk when it prefers dark), with no data-scheme set.
(function (root) {
  "use strict";

  const SCHEMES = ["day", "dusk", "night"];

  /** Shows `scheme` on `doc`; null or an unknown name follows the OS preference. */
  function applyScheme(doc, scheme) {
    const el = doc.documentElement;
    if (SCHEMES.includes(scheme)) {
      el.setAttribute("data-scheme", scheme);
    } else {
      el.removeAttribute("data-scheme");
    }
  }

  /** The scheme a host night-mode state asks for: night when enabled, else none (the OS's). */
  function schemeOf(state) {
    return state && state.enabled === true ? "night" : null;
  }

  /** The scheme named in a page URL's `scheme` parameter, or null. */
  function schemeFromUrl(href) {
    try {
      const s = new URL(href).searchParams.get("scheme");
      return SCHEMES.includes(s) ? s : null;
    } catch {
      return null;
    }
  }

  /**
   * Follows the host's night mode on `doc` while the page lives, when the host offers it
   * (capability `nightMode`). Resolves with the scheme shown; a host that does not answer
   * leaves the page following the OS.
   */
  async function followHost(client, doc, onChange) {
    if (!client.hasCapability("nightMode")) {
      return null;
    }
    const show = (state) => {
      const scheme = schemeOf(state);
      applyScheme(doc, scheme);
      if (onChange) {
        onChange(scheme);
      }
      return scheme;
    };
    try {
      // Subscribed first, so a change while the state is read is not missed.
      await client.subscribe(["nightMode.changed"], (_name, params) => show(params));
      return show(await client.call("nightMode.get"));
    } catch (err) {
      console.warn("under-keel night mode", err);
      return null;
    }
  }

  const api = {
    SCHEMES: SCHEMES,
    applyScheme: applyScheme,
    schemeOf: schemeOf,
    schemeFromUrl: schemeFromUrl,
    followHost: followHost
  };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.UKC_THEME = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
