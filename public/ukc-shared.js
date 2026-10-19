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

  const api = {
    API: API,
    stateStyle: stateStyle,
    depth: depth,
    timeToShoal: timeToShoal,
    reason: reason,
    routeLine: routeLine,
    legFeatures: legFeatures,
    worstStatus: worstStatus
  };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.UKC = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
