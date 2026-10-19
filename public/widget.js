// Status widget: engine state, predicted clearance, time to shoal and reason.
import { connectExtension } from "./vendor/plotterext-bus/extension.js";

const UKC = globalThis.UKC;
const client = await connectExtension();
const view = { state: "unknown", clearance: null, timeToShoal: null, message: "", stale: false };
let unit = "m";
/** The plugin publishes every second; a silent stream for this long is shown as unknown. */
const STALE_MS = 10000;
let staleTimer;
/** Latest timestamp seen per path, epoch ms. */
const seen = {};

function armStale(ms) {
  clearTimeout(staleTimer);
  staleTimer = setTimeout(() => {
    view.stale = true;
    render();
  }, ms);
}

function render() {
  const s = UKC.stateStyle(view.stale ? "unknown" : view.state);
  document.body.style.background = s.colour;
  document.getElementById("state").textContent = `UKC ${s.label}`;
  const tts = view.stale ? "" : UKC.timeToShoal(view.timeToShoal);
  document.getElementById("line").textContent =
    `min ${UKC.depth(view.stale ? null : view.clearance, unit)}` + (tts ? ` · shoal ${tts}` : "");
  document.getElementById("reason").textContent = view.stale
    ? "no data from the under-keel plugin"
    : UKC.reason(view.message);
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
      const left = UKC.freshFor(ev.timestamp, seen[ev.path], Date.now(), STALE_MS);
      const t = Date.parse(ev.timestamp);
      if (isFinite(t)) {
        seen[ev.path] = Math.max(t, seen[ev.path] ?? t);
      }
      if (left === 0) {
        return;
      }
      view[KEYS[ev.path]] = ev.value;
      view.stale = false;
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
render();
