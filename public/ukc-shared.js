// Display logic shared by the extension pages. Plain script: the pages load
// it with <script>, the tests require() it.
(function (root) {
  "use strict";

  /** Plugin REST base; the pages are same-origin with the Signal K server. */
  const API = "/plugins/signalk-underkeel/v1";

  const STATES = {
    normal: { label: "Normal", colour: "#1a9850" },
    alert: { label: "Alert", colour: "#d4a000" },
    warn: { label: "Warning", colour: "#e66101" },
    alarm: { label: "ALARM", colour: "#d7301f" },
    unknown: { label: "Unknown", colour: "#808080" },
    off: { label: "Off", colour: "#808080" }
  };

  function stateStyle(state) {
    return STATES[state] || STATES.unknown;
  }

  /** Metres in the user's depth unit ("m" or "foot"); "—" when there is no number. */
  function depth(metres, unit) {
    if (typeof metres !== "number" || !isFinite(metres)) {
      return "—";
    }
    return unit === "foot" ? (metres / 0.3048).toFixed(1) + " ft" : metres.toFixed(1) + " m";
  }

  function timeToShoal(seconds) {
    if (typeof seconds !== "number" || !isFinite(seconds)) {
      return "";
    }
    return seconds < 120 ? "in " + Math.round(seconds) + " s" : "in " + Math.round(seconds / 60) + " min";
  }

  /** The reason part of a notification message: the text before the explanation sentence. */
  function reason(message) {
    if (typeof message !== "string") {
      return "";
    }
    const i = message.indexOf(": ");
    return i < 0 ? message : message.slice(0, i);
  }

  /** A host route's points as a GeoJSON LineString, or null with fewer than two. */
  function routeLine(points) {
    const coords = (points || [])
      .map(function (p) {
        return p && p.position ? [p.position[0], p.position[1]] : null;
      })
      .filter(function (c) {
        return c && isFinite(c[0]) && isFinite(c[1]);
      });
    return coords.length < 2 ? null : { type: "LineString", coordinates: coords };
  }

  /** One line feature per checked leg, coloured by its status in the style. */
  function legFeatures(routeId, legs) {
    return (legs || []).map(function (leg) {
      return {
        type: "Feature",
        id: routeId + ":" + leg.index,
        geometry: { type: "LineString", coordinates: [leg.from, leg.to] },
        properties: {
          routeId: routeId,
          index: leg.index,
          status: leg.status,
          risk: leg.risk,
          minUkc: leg.minUkc
        }
      };
    });
  }

  /**
   * Worst leg status of a route: fail > unverified > marginal > ok. A status
   * this page does not know counts as unverified, and so does a route with no
   * legs: nothing on it has been checked.
   */
  function worstStatus(legs) {
    const rank = { ok: 0, marginal: 1, unverified: 2, fail: 3 };
    const known = function (s) {
      return Object.prototype.hasOwnProperty.call(rank, s) ? s : "unverified";
    };
    if (!legs || legs.length === 0) {
      return "unverified";
    }
    return legs.reduce(function (worst, leg) {
      const s = known(leg.status);
      return rank[s] > rank[worst] ? s : worst;
    }, "ok");
  }

  /**
   * How long a Signal K value stays current, in ms from `now`; 0 when it is
   * already stale or has no timestamp. Signal K replays its cached values on
   * every subscribe, so a value counts from its own timestamp. One newer than
   * `previous`, the last timestamp seen on the path, shows the stream is live
   * even when the server's clock and this browser's disagree.
   */
  function freshFor(timestamp, previous, now, staleMs) {
    const t = Date.parse(timestamp);
    if (!isFinite(t)) {
      return 0;
    }
    if (typeof previous === "number" && t > previous) {
      return staleMs;
    }
    return Math.max(0, Math.min(staleMs, staleMs - (now - t)));
  }

  /** freshFor with the latest timestamp seen per path kept for the caller. */
  function freshness(staleMs) {
    const seen = {};
    return function (path, timestamp, now) {
      const left = freshFor(timestamp, seen[path], now, staleMs);
      const t = Date.parse(timestamp);
      if (isFinite(t) && !(seen[path] >= t)) {
        seen[path] = t;
      }
      return left;
    };
  }

  /**
   * The badge of a route result. An ok older than `maxAgeMs` is out of date:
   * the runtime re-checks every visible route each minute, so an old result
   * means it stopped and the water level or draft may have changed since.
   * The age counts from `receivedAt`, stamped by the runtime in this browser,
   * because the server's `checkedAt` comes from a clock that may differ.
   */
  function routeBadge(r, now, maxAgeMs) {
    if (r.pending) {
      return { text: "not checked yet", cls: "unverified" };
    }
    if (r.error) {
      return { text: "not checked", cls: "unverified" };
    }
    const at = Date.parse(r.receivedAt);
    if (!isFinite(at) || now - at > maxAgeMs) {
      return { text: "out of date", cls: "unverified" };
    }
    const worst = worstStatus(r.legs);
    return { text: worst, cls: worst };
  }

  function checkedAgo(iso, now) {
    const at = Date.parse(iso);
    if (!isFinite(at)) {
      return "";
    }
    const s = (now - at) / 1000;
    if (s < 60) {
      return "checked just now";
    }
    return s < 3600 ? "checked " + Math.round(s / 60) + " min ago" : "checked " + Math.round(s / 3600) + " h ago";
  }

  /** envelopeRev steps by one per change: any other step is a plugin restart or missed deltas. */
  function revJumped(prev, next) {
    return typeof prev === "number" && next !== prev && next !== prev + 1;
  }

  /**
   * The route results the panel lists: one per visible route, a route the
   * runtime has not answered for yet marked pending. Without the visible set
   * (a host that lists no routes) every result is listed.
   */
  function routeEntries(routeCheck, visible) {
    const results = routeCheck || {};
    if (!visible) {
      return Object.entries(results);
    }
    return visible.map(function (r) {
      return Object.prototype.hasOwnProperty.call(results, r.routeId)
        ? [r.routeId, results[r.routeId]]
        : [r.routeId, { name: r.name, legs: [], pending: true }];
    });
  }

  const api = {
    API: API,
    stateStyle: stateStyle,
    depth: depth,
    timeToShoal: timeToShoal,
    reason: reason,
    routeLine: routeLine,
    legFeatures: legFeatures,
    worstStatus: worstStatus,
    routeEntries: routeEntries,
    freshFor: freshFor,
    freshness: freshness,
    routeBadge: routeBadge,
    checkedAgo: checkedAgo,
    revJumped: revJumped
  };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.UKC = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
