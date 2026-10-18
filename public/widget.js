// Status widget: engine state, predicted clearance, time to shoal and reason.
import { connectExtension } from "./vendor/plotterext-bus/extension.js";

const UKC = globalThis.UKC;
const client = await connectExtension();
const view = { state: "unknown", clearance: null, timeToShoal: null, message: "" };
let unit = "m";

function render() {
  const s = UKC.stateStyle(view.state);
  document.body.style.background = s.colour;
  document.getElementById("state").textContent = `UKC ${s.label}`;
  const tts = UKC.timeToShoal(view.timeToShoal);
  document.getElementById("line").textContent =
    `min ${UKC.depth(view.clearance, unit)}` + (tts ? ` · shoal ${tts}` : "");
  document.getElementById("reason").textContent = UKC.reason(view.message);
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
      if (ev.path === "notifications.navigation.underKeel") {
        view.message = ev.value && typeof ev.value === "object" ? ev.value.message : "";
      } else {
        view[KEYS[ev.path]] = ev.value;
      }
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
