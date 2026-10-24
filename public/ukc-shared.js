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

  /**
   * The status widget's texts and colour at `now`. A stale view, or one past
   * its `freshUntil`, reads Unknown with no numbers, whatever values it last
   * held: a timer can fire late in a hidden page, the clock cannot.
   */
  function widgetView(view, unit, now) {
    const stale = view.stale || (typeof view.freshUntil === "number" && !(now < view.freshUntil));
    const s = stateStyle(stale ? "unknown" : view.state);
    const tts = stale ? "" : timeToShoal(view.timeToShoal);
    return {
      colour: s.colour,
      state: "UKC " + s.label,
      line: "min " + depth(stale ? null : view.clearance, unit) + (tts ? " · shoal " + tts : ""),
      reason: stale ? "no data from the under-keel plugin" : reason(view.message)
    };
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

  /**
   * The runtime re-checks every visible route each minute: three missed
   * re-checks make a result out of date, on the panel and on the chart.
   */
  const ROUTE_MAX_AGE_MS = 180000;

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

  /**
   * The chart's features for a route result: as legFeatures, but every leg
   * of a result older than `maxAgeMs` is unverified, as on the panel: the
   * water level or draft may have changed since its check.
   */
  function overlayLegs(routeId, r, now, maxAgeMs) {
    const at = Date.parse(r.receivedAt);
    const old = !isFinite(at) || now - at > maxAgeMs;
    return legFeatures(routeId, r.legs).map(function (f) {
      if (old) {
        f.properties.status = "unverified";
      }
      return f;
    });
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

  /** Whether a water level (metres, or null for none) differs from `prev` by more than `step`. */
  function levelMoved(prev, next, step) {
    if (typeof prev === "number" && typeof next === "number") {
      return Math.abs(next - prev) > step;
    }
    return prev !== next;
  }

  /**
   * Which UKC tiles the runtime fetches again. While the plugin's change list
   * (`GET /tiles/ukc/changes`) answers, the tiles it lists; the runtime asks
   * it again once the water level has moved 1 cm. Without it, every tile when
   * the level falls 1 cm or rises 10 cm or its source changes: a tile left
   * stale by a rise shows more danger than the truth, never less.
   *
   * `polled` takes a change list reply and `level` a water level (with the
   * source key from `/status`, when known); each answers "all", a list of
   * [z, x, y], "poll" (ask the list) or null.
   */
  function tileRefresh() {
    const STEP = 0.01;
    const RISE = 0.1;
    let cursor = null;
    let live = false;
    let ref;
    let key;
    return {
      query: function () {
        return cursor ? "?epoch=" + encodeURIComponent(cursor.epoch) + "&rev=" + cursor.rev : "";
      },
      polled: function (reply, h) {
        cursor = { epoch: reply.epoch, rev: reply.rev };
        live = true;
        ref = h;
        if (reply.all) {
          return "all";
        }
        return reply.tiles && reply.tiles.length > 0 ? reply.tiles : null;
      },
      lost: function () {
        const was = live;
        live = false;
        return was ? "all" : null;
      },
      level: function (h, sourceKey) {
        if (live) {
          if (!levelMoved(ref, h, STEP)) {
            return null;
          }
          ref = h;
          return "poll";
        }
        const keyMoved = sourceKey !== undefined && key !== undefined && sourceKey !== key;
        if (sourceKey !== undefined) {
          key = sourceKey;
        }
        const both = typeof ref === "number" && typeof h === "number";
        const moved = both ? ref - h > STEP || h - ref > RISE : ref !== undefined && ref !== h;
        if (ref === undefined) {
          ref = h;
        }
        if (!keyMoved && !moved) {
          return null;
        }
        ref = h;
        return "all";
      }
    };
  }

  /** The applied water level's source and degraded reason from `GET /status`; "" without one. */
  function waterSourceKey(status) {
    const applied = status && status.waterLevel && status.waterLevel.applied;
    return applied ? applied.source + "|" + (applied.degraded || "") : "";
  }

  /** The panel's status notes from `GET /status`: the water level applied, its degradation, the WFS notice. */
  function statusLines(status, unit) {
    const parts = [];
    const wl = status && status.waterLevel && status.waterLevel.applied;
    if (wl) {
      parts.push("Water level " + depth(wl.h, unit) + " (" + wl.source + ")");
      if (wl.degraded) {
        parts.push("Water level degraded: " + wl.degraded);
      }
    }
    if (status && status.wfs && status.wfs.notice) {
      parts.push(status.wfs.notice);
    }
    return parts;
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

  /**
   * A route result as the runtime keeps it in host state, which a host may
   * persist on every write: the panel and its badges read only these fields.
   * The leg geometry and explanations stay in the runtime for the overlay.
   */
  function compactResult(r) {
    const out = {
      name: r.name,
      rev: r.rev,
      legs: (r.legs || []).map(function (leg) {
        return { index: leg.index, status: leg.status, minUkc: leg.minUkc, risk: leg.risk };
      })
    };
    ["receivedAt", "checkedAt", "error", "pending"].forEach(function (k) {
      if (r[k] !== undefined) {
        out[k] = r[k];
      }
    });
    return out;
  }

  /** One row of the panel's leg table: leg number, status, minimum UKC and P(UKC < 0). */
  function legRow(leg, unit) {
    return [String(leg.index + 1), leg.status, depth(leg.minUkc, unit), (leg.risk * 100).toFixed(1) + " %"];
  }

  /**
   * At most one run per key. A start while one runs is refused and
   * remembered, and `end` says whether to run once more for it.
   */
  function oneAtATime() {
    const running = new Set();
    const again = new Set();
    return {
      start: function (key) {
        if (running.has(key)) {
          again.add(key);
          return false;
        }
        running.add(key);
        return true;
      },
      end: function (key) {
        running.delete(key);
        return again.delete(key);
      },
      /** Drops a remembered start, so the run in progress is not followed by another. */
      forget: function (key) {
        again.delete(key);
      }
    };
  }

  /** A Retry-After of whole seconds as ms, held to 1–30 s; null when there is none. */
  function retryAfterMs(header) {
    const s = typeof header === "string" && /^\s*\d+\s*$/.test(header) ? Number(header) : NaN;
    return isFinite(s) ? Math.min(30, Math.max(1, s)) * 1000 : null;
  }

  const api = {
    API: API,
    stateStyle: stateStyle,
    depth: depth,
    timeToShoal: timeToShoal,
    reason: reason,
    widgetView: widgetView,
    routeLine: routeLine,
    ROUTE_MAX_AGE_MS: ROUTE_MAX_AGE_MS,
    legFeatures: legFeatures,
    overlayLegs: overlayLegs,
    worstStatus: worstStatus,
    routeEntries: routeEntries,
    compactResult: compactResult,
    legRow: legRow,
    oneAtATime: oneAtATime,
    retryAfterMs: retryAfterMs,
    freshFor: freshFor,
    freshness: freshness,
    routeBadge: routeBadge,
    checkedAgo: checkedAgo,
    revJumped: revJumped,
    levelMoved: levelMoved,
    tileRefresh: tileRefresh,
    waterSourceKey: waterSourceKey,
    statusLines: statusLines
  };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.UKC = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
