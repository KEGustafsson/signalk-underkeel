// Status widget: engine state, predicted clearance, time to shoal and reason.
import { connectExtension } from "./vendor/plotterext-bus/extension.js";

const UKC = globalThis.UKC;
const client = await connectExtension();
const view = { state: "unknown", clearance: null, timeToShoal: null, message: "", stale: false };
let unit = "m";
/** The plugin publishes every second; a silent stream for this long is shown as unknown. */
const STALE_MS = 10000;
let staleTimer;
const fresh = UKC.freshness(STALE_MS);

function armStale(ms) {
  clearTimeout(staleTimer);
  staleTimer = setTimeout(() => {
    view.stale = true;
    render();
  }, ms);
}

/** What the page shows now: three values arrive each second, mostly unchanged. */
const shown = {};

function render() {
  if (document.hidden) {
    return;
  }
  const next = UKC.widgetView(view, unit, Date.now());
  if (next.colour !== shown.colour) {
    document.body.style.background = next.colour;
  }
  for (const id of ["state", "line", "reason"]) {
    if (next[id] !== shown[id]) {
      document.getElementById(id).textContent = next[id];
    }
  }
  Object.assign(shown, next);
}

if (client.hasCapability("units")) {
  const { units } = await client.call("units.get");
  unit = units && units.depth ? units.depth : "m";
}

const KEYS = {
  "navigation.underKeel.state": "state",
  "navigation.underKeel.clearance": "clearance",
  "navigation.underKeel.timeToShoal": "timeToShoal"
};

if (!client.hasCapability("signalk.stream")) {
  view.message = "this chart host gives no Signal K stream";
} else {
  view.stale = true;
  await client.signalk.subscribe(
    [...Object.keys(KEYS), "notifications.navigation.underKeel"],
    (ev) => {
      // A notification is sent only when it changes, so its age says nothing about the plugin.
      if (ev.path === "notifications.navigation.underKeel") {
        view.message = ev.value && typeof ev.value === "object" ? ev.value.message : "";
        render();
        return;
      }
      const left = fresh(ev.path, ev.timestamp, Date.now());
      if (left === 0) {
        return;
      }
      view[KEYS[ev.path]] = ev.value;
      view.stale = false;
      view.freshUntil = Date.now() + left;
      armStale(left);
      render();
    }
  );
}

document.body.addEventListener("click", () => {
  if (client.hasCapability("ui")) {
    void client.call("ui.togglePanel", { panel: "details" });
  }
});
// Values that arrived while hidden were not drawn, and an aged-out reading reads Unknown on return.
document.addEventListener("visibilitychange", render);
render();
