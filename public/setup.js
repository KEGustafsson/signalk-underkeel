// Setup panel: boat, water level and warnings in three steps, saved as a
// patch on the plugin configuration. Reading and saving need an admin login.
const M = globalThis.UKC_SETUP;
const SVG_NS = "http://www.w3.org/2000/svg";
const ADMIN_PAGE = "/admin/#/serverConfiguration/plugins/signalk-underkeel";
const STEPS = ["Boat", "Water level", "Warnings"];
/** The plugin's state colours, each with a text colour that reads on it. */
const STATE_COLOURS = {
  alert: ["#d4a000", "#12233a"],
  warn: ["#e66101", "#12233a"],
  alarm: ["#b5261a", "#ffffff"]
};
const REFERENCE_KNOTS = 6;

const s = { data: null, patch: {}, step: 0, saving: false, dragScale: undefined };

function h(tag, attrs, ...kids) {
  const svg = tag.startsWith("svg:");
  const el = svg ? document.createElementNS(SVG_NS, tag.slice(4)) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k.startsWith("on") && typeof v === "function") {
      el.addEventListener(k.slice(2), v);
    } else if (k.startsWith("aria-") && typeof v === "boolean") {
      el.setAttribute(k, String(v));
    } else if (v === true) {
      el.setAttribute(k, "");
    } else if (v !== false && v !== null && v !== undefined) {
      el.setAttribute(k, String(v));
    }
  }
  kids.flat().forEach((c) => {
    if (c !== null && c !== undefined && c !== false) {
      el.append(c instanceof Node ? c : String(c));
    }
  });
  return el;
}

const val = (path) => M.current(s.data.values, s.patch, path);
const facts = () => s.data.facts;

function edit(path, value, redraw = true) {
  s.patch = M.setEdit(s.patch, s.data.values, path, value);
  message("");
  if (redraw) {
    render();
  } else {
    renderNav();
  }
}

function message(text, good) {
  const el = document.getElementById("message");
  el.textContent = text;
  el.className = "message" + (text ? (good ? " good" : " bad") : "");
}

// ── Step 1: boat ─────────────────────────────────────────────────────────

const VIEW = { w: 382, h: 250, water: 78, gnssX: 210, deck: 44, hullBottom: 92, depthPx: 140 };

function boatValues() {
  const draft = val("vessel.draft") ?? facts().signalk.draft;
  return {
    draft,
    margin: val("vessel.margin") ?? 0,
    sounder: facts().depthPaths.length > 0 || val("livechart.enabled") === true,
    transducerDepth: val("livechart.transducerDepth") ?? 0,
    forward: val("livechart.forward") ?? 0,
    length: facts().signalk.length ?? 12
  };
}

/** The side view's geometry for the current values: y of keel, margin line and sounder, x of the sounder. */
function geometry(b) {
  // A drag keeps the scale it started with, so the handle stays under the pointer.
  const scale = s.dragScale ?? M.boatScale(b.draft ?? 1.5, b.margin, VIEW.depthPx);
  const keelY = VIEW.water + (b.draft ?? 1.5) * scale;
  const hullPx = 300 / b.length;
  return {
    scale,
    keelY,
    marginY: keelY + b.margin * scale,
    sounderY: VIEW.water + b.transducerDepth * scale,
    sounderX: Math.min(330, Math.max(50, VIEW.gnssX + b.forward * hullPx)),
    hullPx
  };
}

function handle(cls, x, y, colour, label, now, onKey) {
  return h(
    "svg:g",
    {
      class: cls,
      tabindex: 0,
      role: "slider",
      "aria-label": label,
      "aria-valuenow": now,
      "aria-valuetext": `${now} m`,
      onkeydown: (e) => {
        const step = { ArrowUp: -0.05, ArrowDown: 0.05, ArrowLeft: -0.05, ArrowRight: 0.05 }[e.key];
        if (step !== undefined) {
          e.preventDefault();
          onKey(step, e.key);
        }
      }
    },
    h("svg:circle", { cx: x, cy: y, r: 16, fill: "transparent" }),
    h("svg:circle", { cx: x, cy: y, r: 8, fill: "var(--page)", stroke: colour, "stroke-width": 2.5 })
  );
}

function text(x, y, t, attrs) {
  return h("svg:text", { x, y, "font-size": 11, fill: "var(--ink)", ...attrs }, t);
}

/** Text drawn over the hull, with a halo so it reads on any part of the drawing. */
function label(x, y, t, attrs) {
  return text(x, y, t, { stroke: "var(--panel)", "stroke-width": 3, "paint-order": "stroke", ...attrs });
}

/**
 * A plain hull and keel, the stern on the left. Only the keel's lowest point
 * counts, at `keelY`, where the draft handle sits; without a draft the keel
 * is drawn as an outline.
 */
function hullShape(keelY, known) {
  const hb = VIEW.hullBottom;
  return [
    h("svg:path", {
      d: `M40 ${VIEW.deck} L340 ${VIEW.deck} Q336 ${hb - 18} 300 ${hb} L92 ${hb} Q52 ${hb - 6} 40 ${VIEW.deck} Z`,
      fill: "var(--page)",
      stroke: "var(--ink)",
      "stroke-width": 2
    }),
    h("svg:path", {
      d: `M173 ${hb} L209 ${hb} L203 ${keelY} L179 ${keelY} Z`,
      fill: known ? "var(--ink)" : "none",
      stroke: "var(--ink)",
      "stroke-dasharray": known ? null : "4 3"
    })
  ];
}

function boatSvg() {
  const b = boatValues();
  const g = geometry(b);
  const keelX = 191;
  const svg = h(
    "svg:svg",
    {
      viewBox: `0 0 ${VIEW.w} ${VIEW.h}`,
      role: "img",
      "aria-label": `Side view: draft ${b.draft ?? "not set"} m, margin ${b.margin} m`
    },
    h("svg:rect", { x: 0, y: 0, width: VIEW.w, height: VIEW.h, fill: "var(--panel)" }),
    h("svg:rect", { x: 0, y: VIEW.water, width: VIEW.w, height: VIEW.h - VIEW.water, fill: "var(--water)" }),
    h("svg:path", {
      d: `M0 ${VIEW.h - 14} C60 ${VIEW.h - 22} 120 ${VIEW.h - 8} 190 ${VIEW.h - 16} C260 ${VIEW.h - 24} 320 ${VIEW.h - 10} 382 ${VIEW.h - 16} L382 ${VIEW.h} L0 ${VIEW.h} Z`,
      fill: "var(--bed)"
    }),
    h("svg:line", { x1: 0, y1: VIEW.water, x2: VIEW.w, y2: VIEW.water, stroke: "var(--accent)", "stroke-width": 1.5 }),
    hullShape(g.keelY, b.draft !== undefined),
    label(8, VIEW.water + 14, "waterline", { fill: "var(--accent)" }),
    h("svg:circle", { cx: VIEW.gnssX, cy: 36, r: 4, fill: "var(--ink)" }),
    text(VIEW.gnssX + 8, 34, "GNSS"),
    text(318, 30, "bow →", { fill: "var(--muted)" }),
    h("svg:line", { x1: 280, y1: VIEW.water, x2: 280, y2: g.keelY, stroke: "var(--ink)" }),
    label(288, (VIEW.water + g.keelY) / 2 + 4, b.draft === undefined ? "Draft not set" : `Draft ${b.draft.toFixed(2)} m`, {
      "font-size": 13,
      "font-weight": 600
    }),
    h("svg:line", { x1: 40, y1: g.marginY, x2: 300, y2: g.marginY, stroke: "var(--margin)", "stroke-width": 2, "stroke-dasharray": "6 4" }),
    label(112, g.marginY + 16, `+ margin ${b.margin.toFixed(2)} m`, { fill: "var(--margin-ink)", "font-weight": 600 })
  );
  svg.append(
    handle("handle", keelX, g.keelY, "var(--ink)", "Draft", (b.draft ?? 1.5).toFixed(2), (d) => setDraft((b.draft ?? 1.5) + d)),
    handle("handle", 300, g.marginY, "var(--margin)", "Safety margin", b.margin.toFixed(2), (d) => setMargin(b.margin + d))
  );
  if (b.sounder) {
    svg.append(
      h("svg:line", { x1: g.sounderX, y1: 40, x2: VIEW.gnssX, y2: 40, stroke: "var(--accent)", "stroke-dasharray": "3 3" }),
      label(8, 16, `sounder ${b.transducerDepth.toFixed(2)} m down`, { fill: "var(--accent)" }),
      label(8, 30, `${Math.abs(b.forward).toFixed(2)} m ${b.forward >= 0 ? "forward of" : "aft of"} GNSS`, { fill: "var(--accent)" }),
      handle("handle free", g.sounderX, g.sounderY, "var(--accent)", "Sounder depth and position", b.transducerDepth.toFixed(2), (d, key) =>
        key === "ArrowUp" || key === "ArrowDown" ? setSounder(b.transducerDepth + d, b.forward) : setSounder(b.transducerDepth, b.forward + d)
      )
    );
  }
  return svg;
}

function setDraft(m) {
  edit("vessel.draft", M.snap(m, 0.1), false);
  redrawBoat();
}

function setMargin(m) {
  edit("vessel.margin", M.snap(m, 0), false);
  redrawBoat();
}

function setSounder(depth, forward) {
  s.patch = M.setEdit(s.patch, s.data.values, "livechart.transducerDepth", M.snap(depth, 0));
  edit("livechart.forward", Math.round(forward * 20) / 20, false);
  redrawBoat();
}

/**
 * The side view in a box that outlives each redraw, so a drag that redraws
 * keeps its pointer: the keel and margin move up and down, the sounder anywhere.
 */
function drawing() {
  const box = h("div", { class: "drawing", id: "drawing" }, boatSvg());
  box.addEventListener("pointerdown", (e) => {
    const target = e.target.closest(".handle");
    if (!target) {
      return;
    }
    const which = [...box.querySelectorAll(".handle")].indexOf(target);
    e.preventDefault();
    box.setPointerCapture(e.pointerId);
    s.dragScale = geometry(boatValues()).scale;
    const move = (ev) => {
      const svg = box.querySelector("svg");
      const pt = svg.createSVGPoint();
      pt.x = ev.clientX;
      pt.y = ev.clientY;
      const p = pt.matrixTransform(svg.getScreenCTM().inverse());
      const g = geometry(boatValues());
      if (which === 0) {
        setDraft((p.y - VIEW.water) / g.scale);
      } else if (which === 1) {
        setMargin((p.y - g.keelY) / g.scale);
      } else {
        setSounder((p.y - VIEW.water) / g.scale, (p.x - VIEW.gnssX) / g.hullPx);
      }
    };
    const drag = new AbortController();
    const end = () => {
      s.dragScale = undefined;
      drag.abort();
      redrawBoat();
    };
    box.addEventListener("pointermove", move, { signal: drag.signal });
    box.addEventListener("pointerup", end, { signal: drag.signal });
    box.addEventListener("pointercancel", end, { signal: drag.signal });
  });
  return box;
}

/** Redraws the side view and the number fields, keeping the focused handle focused. */
function redrawBoat() {
  const box = document.getElementById("drawing");
  if (!box) {
    return;
  }
  const focused = [...box.querySelectorAll(".handle")].indexOf(document.activeElement);
  box.replaceChildren(boatSvg());
  if (focused >= 0) {
    box.querySelectorAll(".handle")[focused]?.focus();
  }
  const b = boatValues();
  const draft = document.getElementById("draft");
  if (draft && document.activeElement !== draft) {
    draft.value = val("vessel.draft") ?? "";
  }
  document.getElementById("draft-hint")?.replaceWith(draftHint());
  const margin = document.getElementById("margin");
  if (margin && document.activeElement !== margin) {
    margin.value = b.margin;
  }
}

function numberField(id, label, path, placeholder, hint) {
  return h(
    "div",
    { class: "field" },
    h("label", { for: id }, label),
    h(
      "div",
      { class: "unit" },
      h("input", {
        id,
        inputmode: "decimal",
        placeholder,
        value: val(path) ?? "",
        onchange: (e) => {
          edit(path, M.metres(e.target.value), false);
          redrawBoat();
        }
      }),
      h("span", { class: "hint" }, "m")
    ),
    hint
  );
}

function addedOnTop() {
  const d = s.data.defaults;
  const cb = val("vessel.blockCoefficient") ?? d.blockCoefficient;
  const waves = val("vessel.waveFactor") ?? d.waveFactor;
  const keel = val("vessel.keel") ?? "none";
  // Squat in words: S = Cb·V²/100 m at V knots, here at the reference speed.
  const squat = Math.round(cb * REFERENCE_KNOTS ** 2);
  return h(
    "div",
    { class: "facts" },
    h("b", { style: "color:var(--ink)" }, "Added on top, automatically"),
    h("div", {}, `Squat: sits ${squat} cm deeper at ${REFERENCE_KNOTS} kn, 0 when stopped`),
    h("div", {}, `Waves: ${waves} × wave height, when Signal K has it`),
    h(
      "div",
      {},
      keel === "none"
        ? "No credit for heel: the keel always counts at full depth"
        : `Heel credit on (${keel}, set under expert settings)`
    )
  );
}

/** Where the draft comes from: Signal K while the field is empty, else the value set here. */
function draftHint() {
  const signalk = facts().signalk.draft;
  const fromSignalK = val("vessel.draft") === undefined && signalk !== undefined;
  const own = val("vessel.draft") !== undefined;
  const text = fromSignalK
    ? `using Signal K design.draft.maximum ${signalk} m`
    : signalk !== undefined
      ? `Signal K says ${signalk} m; empty uses it`
      : own
        ? "set here; Signal K states none"
        : "not in Signal K: set it here";
  return h("span", { class: fromSignalK ? "hint ok" : "hint", id: "draft-hint" }, text);
}

function boatStep() {
  const f = facts();
  const signalk = f.signalk.draft;
  return [
    h("h2", {}, "Your boat"),
    h("p", { class: "lead" }, "Only the lowest point counts. Drag the keel bottom, the margin line or the sounder, or type the numbers."),
    drawing(),
    h(
      "div",
      { class: "grid2" },
      numberField("draft", "Draft", "vessel.draft", signalk ?? "", draftHint()),
      numberField("margin", "Safety margin", "vessel.margin", "0", h("span", { class: "hint" }, "extra water you want kept"))
    ),
    addedOnTop(),
    h(
      "div",
      { class: "facts" },
      f.signalk.length || f.signalk.beam
        ? h("div", {}, `Length ${f.signalk.length ?? "?"} m, beam ${f.signalk.beam ?? "?"} m from Signal K design.*`)
        : h("div", {}, "No length or beam in Signal K: the plugin assumes 15 m by 5 m, which errs toward caution."),
      f.depthPaths.length > 0 ? h("div", {}, `Sounder seen on environment.depth.${f.depthPaths.join(", ")}`) : null
    )
  ];
}

// ── Step 2: water level ──────────────────────────────────────────────────

function datumNote() {
  const high = facts().datums.filter((d) => !d.lowWater);
  if (high.length === 0) {
    return null;
  }
  const list = high.map((d) => `VERDAT ${d.verdat} in ${d.cells} cells`).join(", ");
  return h(
    "div",
    { class: "note" },
    h("b", {}, "Your charts are not on low water"),
    `${list}. The sea is often well below this datum, so without a source the look-ahead stays at Alert or worse.`
  );
}

function sourceCard(id, title, body, extra) {
  const on = (val("waterLevel.source") ?? "none") === id;
  return h(
    "button",
    { type: "button", class: "card" + (on ? " on" : ""), role: "radio", "aria-checked": on, onclick: () => edit("waterLevel.source", id) },
    h(
      "span",
      { style: "flex:1" },
      h("span", { class: "t" }, title, s.data.suggestedSource === id ? h("span", { class: "badge" }, "suggested") : null),
      h("small", {}, body),
      extra
    )
  );
}

function waterStep() {
  const f = facts();
  const source = val("waterLevel.source") ?? "none";
  return [
    h("h2", {}, "Water level"),
    h("p", { class: "lead" }, "How far the sea stands above the depths printed on your charts."),
    datumNote(),
    h(
      "div",
      { class: "cards", role: "radiogroup", "aria-label": "Water level source" },
      sourceCard("fmi", "FMI forecast", "Finnish Meteorological Institute forecast tied to the nearest tide gauge. Sends the vessel position to FMI; needs internet."),
      sourceCard(
        "signalk-tide",
        "Signal K tide",
        "environment.tide.heightNow from another plugin or instrument.",
        h("small", {}, f.tide ? "seen on this server" : "not seen on this server")
      ),
      sourceCard("manual", "Fixed height", "One height above chart datum that you set and keep current yourself."),
      sourceCard("none", "None", "Chart datum, ± 0.3 m.")
    ),
    source === "manual"
      ? h(
          "div",
          { class: "grid2" },
          h(
            "div",
            { class: "field" },
            h("label", { for: "height" }, "Height above chart datum"),
            h(
              "div",
              { class: "unit" },
              h("input", {
                id: "height",
                inputmode: "decimal",
                value: val("waterLevel.height") ?? 0,
                onchange: (e) => edit("waterLevel.height", M.metres(e.target.value), false)
              }),
              h("span", { class: "hint" }, "m")
            )
          )
        )
      : null,
    h("p", { class: "hint", style: "margin-top:10px" }, "The source is your choice; the plugin never picks one by itself.")
  ];
}

// ── Step 3: warnings ─────────────────────────────────────────────────────

const STYLE_NAMES = { early: "Early", balanced: "Balanced", late: "Late" };

function coneSvg(style) {
  const presets = s.data.presets.warningStyles;
  const px = (d) => 40 + (d / presets.early.distance) * 300;
  const cone = (id) => {
    const x = px(presets[id].distance);
    const half = (x - 40) * 0.13;
    const on = id === style;
    return h("svg:path", {
      d: `M40 100 L${x} ${100 - half} L${x} ${100 + half} Z`,
      fill: on ? "var(--margin)" : "none",
      "fill-opacity": on ? 0.22 : null,
      stroke: on ? "var(--margin)" : "var(--muted)",
      "stroke-width": on ? 2 : 1.2,
      "stroke-dasharray": on ? null : "5 4"
    });
  };
  return h(
    "svg:svg",
    { viewBox: "0 0 382 180", role: "img", "aria-label": `Top view of how far ahead each style looks; ${STYLE_NAMES[style]} selected` },
    h("svg:rect", { x: 0, y: 0, width: 382, height: 180, fill: "var(--water)" }),
    ["late", "balanced", "early"].map(cone),
    h("svg:path", { d: "M26 92 L48 100 L26 108 Z", fill: "var(--ink)" }),
    ["late", "balanced", "early"].map((id, i) =>
      text(px(presets[id].distance) - 70, 140 + i * 14, `${STYLE_NAMES[id]} ${(presets[id].distance / 1852).toFixed(1)} NM`, {
        "font-weight": id === style ? 600 : 400,
        fill: id === style ? "var(--margin-ink)" : "var(--muted)"
      })
    )
  );
}

function warningsStep() {
  const style = val("warningStyle") ?? "balanced";
  const lines = M.styleLines(s.data.presets.warningStyles[style], REFERENCE_KNOTS);
  const custom = ["distance", "alertRisk", "warnRisk", "alarmRisk", "warnWithin", "alarmWithin", "certainWithin"].filter(
    (k) => val(`lookahead.${k}`) !== undefined
  );
  const toggle = (path, label) =>
    h("label", {}, label, h("input", { type: "checkbox", checked: val(path) === true, onchange: (e) => edit(path, e.target.checked, false) }));
  return [
    h("h2", {}, "When to warn you"),
    h(
      "div",
      { class: "seg", role: "radiogroup", "aria-label": "Warning style" },
      Object.entries(STYLE_NAMES).map(([id, name]) =>
        h("button", { type: "button", role: "radio", "aria-checked": style === id, onclick: () => edit("warningStyle", id) }, name)
      )
    ),
    h("div", { class: "drawing", style: "margin-top:10px" }, coneSvg(style)),
    h(
      "div",
      { class: "levels" },
      ["alert", "warn", "alarm"].map((k) =>
        h("div", {}, h("span", { class: "chip", style: `background:${STATE_COLOURS[k][0]};color:${STATE_COLOURS[k][1]}` }, k[0].toUpperCase() + k.slice(1)), lines[k])
      ),
      h("span", { class: "hint" }, lines.ahead),
      custom.length > 0 ? h("span", { class: "hint" }, `Your own values for ${custom.join(", ")} still apply; change them in the admin page.`) : null
    ),
    h("div", { class: "field", style: "margin-top:14px" }, h("label", {}, "Extras")),
    h(
      "div",
      { class: "switches" },
      toggle("livechart.enabled", "Learn from my sounder (living chart)"),
      toggle("wfs.enabled", "Fill chart gaps from Traficom WFS (not for navigation)"),
      toggle("groundingDetector.enabled", "Detect actual grounding")
    ),
    h(
      "div",
      { class: "checks" },
      h("b", {}, "Setup check"),
      s.data.checks.map((c) => h("div", { class: c.level }, `${M.MARK[c.level]} ${c.text}`))
    ),
    h("p", { class: "hint" }, "Other settings: ", h("a", { href: ADMIN_PAGE, target: "_blank", rel: "noopener" }, "the plugin's admin page"))
  ];
}

// ── Navigation and saving ────────────────────────────────────────────────

async function save() {
  s.saving = true;
  renderNav();
  try {
    const res = await fetch(`${M.API}/settings`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(s.patch),
      signal: AbortSignal.timeout(10000)
    });
    const body = await res.json().catch(() => null);
    const result = M.saveMessage(res.status, body);
    message(result.text, result.ok);
    if (result.ok) {
      s.patch = {};
      setTimeout(() => void load(), 4000);
    }
  } catch (err) {
    message(`Not saved: ${err && err.message ? err.message : String(err)}`);
  } finally {
    s.saving = false;
    renderNav();
  }
}

function renderNav() {
  const nav = document.getElementById("nav");
  const last = s.step === STEPS.length - 1;
  const changed = Object.keys(s.patch).length > 0;
  nav.replaceChildren(
    s.step > 0
      ? h("button", { type: "button", class: "link", onclick: () => go(s.step - 1) }, "Back")
      : h("a", { href: ADMIN_PAGE, target: "_blank", rel: "noopener", class: "link" }, "All settings"),
    last
      ? h("button", { type: "button", class: "primary save", disabled: s.saving || !changed, onclick: () => void save() }, s.saving ? "Saving…" : changed ? "Save and restart" : "Nothing changed")
      : h("button", { type: "button", class: "primary", onclick: () => go(s.step + 1) }, `Next: ${STEPS[s.step + 1].toLowerCase()}`)
  );
}

function go(step) {
  s.step = step;
  render();
  window.scrollTo(0, 0);
}

function render() {
  document.querySelectorAll(".progress span").forEach((el, i) => el.classList.toggle("on", i <= s.step));
  document.querySelectorAll(".steps span").forEach((el, i) => el.classList.toggle("on", i === s.step));
  const body = [boatStep, waterStep, warningsStep][s.step]();
  document.getElementById("step").replaceChildren(...body.flat().filter(Boolean));
  renderNav();
}

function blocked(text, link) {
  document.getElementById("step").replaceChildren(
    h("h2", {}, "Under-keel setup"),
    h("p", { class: "lead" }, text),
    link ? h("p", {}, h("a", { href: link, target: "_blank", rel: "noopener" }, "Open the Signal K admin page")) : null
  );
  document.getElementById("nav").replaceChildren();
}

async function load() {
  try {
    const res = await fetch(`${M.API}/settings`, { credentials: "same-origin", signal: AbortSignal.timeout(8000) });
    if (res.status === 401 || res.status === 403) {
      blocked("Log in to Signal K as an administrator to see and change the under-keel settings.", "/admin/");
      return;
    }
    if (!res.ok) {
      blocked(`The plugin did not answer (HTTP ${res.status}). Is it enabled?`, ADMIN_PAGE);
      return;
    }
    s.data = await res.json();
    render();
  } catch (err) {
    blocked(`The plugin did not answer: ${err && err.message ? err.message : String(err)}`, ADMIN_PAGE);
    console.warn("under-keel setup", err);
  }
}

// Opened from the details panel, the page offers the way back to it.
document.getElementById("back").hidden = new URLSearchParams(location.search).get("from") !== "details";
await load();
