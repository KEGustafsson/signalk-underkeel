// Status widget: engine state, predicted clearance, time to shoal and reason.
import { connectExtension } from "./vendor/plotterext-bus/extension.js";

const UKC = globalThis.UKC;
const client = await connectExtension();
const view = { state: "unknown", clearance: null, timeToShoal: null, message: "", stale: false };
let unit = "m";
/** The plugin publishes every second; a silent stream for this long is shown as unknown. */
const STALE_MS = 10000;
let staleTimer;

function armStale() {
  clearTimeout(staleTimer);
  staleTimer = setTimeout(() => {
    view.stale = true;
    render();
  }, STALE_MS);
}

function render() {
  const s = UKC.stateStyle(view.stale ? "unknown" : view.state);
  document.body.style.background = s.colour;
  document.getElementById("state").textContent = `UKC ${s.label}`;
  const tts = UKC.timeToShoal(view.timeToShoal);
  document.getElementById("line").textContent =
    `min ${UKC.depth(view.clearance, unit)}` + (tts ? ` · shoal ${tts}` : "");
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
  await client.signalk.subscribe(
    [...Object.keys(KEYS), "notifications.navigation.underKeel"],
    (ev) => {
      view.stale = false;
      armStale();
      if (ev.path === "notifications.navigation.underKeel") {
        view.message = ev.value && typeof ev.value === "object" ? ev.value.message : "";
      } else {
        view[KEYS[ev.path]] = ev.value;
      }
      render();
    }
  );
  armStale();
}

document.body.addEventListener("click", () => {
  if (client.hasCapability("ui")) {
    void client.call("ui.togglePanel", { panel: "details" });
  }
});
render();
