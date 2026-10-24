// Logic of the setup panel: the edits as a patch on the saved configuration,
// the boat drawing's scale, and the warning style in words. Plain script: the
// page loads it with <script>, the tests require() it.
(function (root) {
  "use strict";

  const API = "/plugins/signalk-underkeel/v1";
  const KNOT = 1852 / 3600;

  function get(obj, path) {
    return path.split(".").reduce(function (o, k) {
      return o && typeof o === "object" ? o[k] : undefined;
    }, obj);
  }

  function isEmpty(value) {
    return value === undefined || value === null || value === "" || (typeof value === "number" && !isFinite(value));
  }

  /**
   * The patch with `path` set to `value`. A value equal to the saved one
   * leaves the field out of the patch; an empty value removes a saved field
   * (null) or leaves an unsaved one out. Returns a new patch.
   */
  function setEdit(patch, saved, path, value) {
    const keys = path.split(".");
    const out = JSON.parse(JSON.stringify(patch || {}));
    const before = get(saved, path);
    let node = out;
    for (let i = 0; i < keys.length - 1; i++) {
      if (!node[keys[i]] || typeof node[keys[i]] !== "object") {
        node[keys[i]] = {};
      }
      node = node[keys[i]];
    }
    const last = keys[keys.length - 1];
    if (isEmpty(value) ? isEmpty(before) : value === before) {
      delete node[last];
    } else {
      node[last] = isEmpty(value) ? null : value;
    }
    return prune(out);
  }

  function prune(obj) {
    Object.keys(obj).forEach(function (k) {
      const v = obj[k];
      if (v && typeof v === "object" && !Array.isArray(v)) {
        prune(v);
        if (Object.keys(v).length === 0) {
          delete obj[k];
        }
      }
    });
    return obj;
  }

  /** The value at `path` once the patch is applied; undefined when removed or unset. */
  function current(saved, patch, path) {
    const edited = get(patch, path);
    if (edited === null) {
      return undefined;
    }
    return edited !== undefined ? edited : get(saved, path);
  }

  /** Metres as a number, or undefined for text that is not one. */
  function metres(text) {
    const t = String(text === null || text === undefined ? "" : text).trim().replace(",", ".");
    const v = t === "" ? NaN : Number(t);
    return isFinite(v) ? v : undefined;
  }

  /** Metres rounded to the 5 cm a drag moves in, never below `min`. */
  function snap(m, min) {
    const v = Math.round(m * 20) / 20;
    return Math.max(min === undefined ? 0 : min, Number(v.toFixed(2)));
  }

  /** Pixels per metre for the side view: keel, margin and sounder fit in `height` px. */
  function boatScale(draft, margin, height) {
    const depth = Math.max(1, (draft || 0) + (margin || 0) + 0.3);
    return height / depth;
  }

  function percent(p) {
    return (p * 100).toFixed(p < 0.01 ? 1 : 0) + " %";
  }

  function duration(s) {
    return s >= 120 ? Math.round(s / 60) + " min" : s + " s";
  }

  /** The style's levels in words, and how far ahead of shoal water it warns at `knots`. */
  function styleLines(p, knots) {
    return {
      alert: percent(p.alertRisk) + " chance of touching",
      warn: percent(p.warnRisk) + " chance, within " + duration(p.warnWithin),
      alarm: percent(p.alarmRisk) + " chance within " + duration(p.alarmWithin) + ", or aground in " + p.certainWithin + " s",
      ahead: "Looks " + (p.distance / 1852).toFixed(1) + " NM ahead. At " + knots + " kn it warns about " + Math.round(p.warnWithin * knots * KNOT) + " m before shoal water."
    };
  }

  const MARK = { ok: "✓", warn: "!", todo: "✗" };

  /** What to tell the user after a save answered `status`. */
  function saveMessage(status, body) {
    if (status === 202) {
      return { ok: true, text: "Sent. The plugin saves the settings and restarts; they are read back in a few seconds." };
    }
    if (status === 401 || status === 403) {
      return { ok: false, text: "Log in to Signal K as an administrator to change settings." };
    }
    const errors = body && Array.isArray(body.errors) ? body.errors.join("; ") : "HTTP " + status;
    return { ok: false, text: "Not saved: " + errors };
  }

  const api = {
    API: API,
    get: get,
    setEdit: setEdit,
    current: current,
    metres: metres,
    snap: snap,
    boatScale: boatScale,
    styleLines: styleLines,
    MARK: MARK,
    saveMessage: saveMessage
  };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.UKC_SETUP = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
