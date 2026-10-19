// Details panel: the look-ahead explanation, water level, data notices and
// the route-check result of each route on the chart.
import { connectExtension } from "./vendor/plotterext-bus/extension.js";

const UKC = globalThis.UKC;
const client = await connectExtension();
let unit = "m";

if (client.hasCapability("units")) {
  const { units } = await client.call("units.get");
  unit = units && units.depth ? units.depth : "m";
}

function text(id, value) {
  document.getElementById(id).textContent = value;
}

function showUnknownStatus(why) {
  const style = UKC.stateStyle("unknown");
  const chip = document.getElementById("state");
  chip.textContent = style.label;
  chip.style.background = style.colour;
  text("source", `Under-keel status unavailable: ${why}`);
}

async function refreshStatus() {
  try {
    const res = await fetch(`${UKC.API}/status`, { credentials: "same-origin" });
    if (!res.ok) {
      showUnknownStatus(`HTTP ${res.status}`);
      return;
    }
    const s = await res.json();
    const style = UKC.stateStyle(s.engine.state);
    const chip = document.getElementById("state");
    chip.textContent = style.label;
    chip.style.background = style.colour;
    const wl = s.waterLevel && s.waterLevel.applied;
    const parts = [];
    if (wl) {
      parts.push(`Water level ${UKC.depth(wl.h, unit)} (${s.waterLevel.source})`);
    }
    if (s.wfs && s.wfs.notice) {
      parts.push(s.wfs.notice);
    }
    text("source", parts.join(" · "));
  } catch (err) {
    showUnknownStatus(err && err.message ? err.message : String(err));
    console.warn("under-keel status", err);
  }
}

function renderRoutes(routeCheck) {
  const el = document.getElementById("routes");
  const entries = Object.entries(routeCheck || {});
  if (!client.hasCapability("routes")) {
    el.textContent = "This chart host does not share its routes, so none is checked here.";
    return;
  }
  if (entries.length === 0) {
    el.textContent = "No route on the chart.";
    return;
  }
  el.replaceChildren(
    ...entries.map(([, r]) => {
      const box = document.createElement("div");
      const title = document.createElement("div");
      const worst = UKC.worstStatus(r.legs);
      title.append(`${r.name || "Unsaved route"}: `);
      const badge = document.createElement("b");
      badge.className = r.error ? "unverified" : worst;
      badge.textContent = r.error ? "not checked" : worst;
      title.append(badge);
      box.append(title);
      if (r.error) {
        box.append(r.error);
        return box;
      }
      const table = document.createElement("table");
      table.innerHTML = "<tr><th>Leg</th><th>Status</th><th>Min UKC</th><th>P(UKC&lt;0)</th></tr>";
      r.legs.forEach((leg) => {
        const tr = document.createElement("tr");
        [String(leg.index + 1), leg.status, UKC.depth(leg.minUkc, unit), `${(leg.risk * 100).toFixed(1)} %`].forEach(
          (v, i) => {
            const td = document.createElement("td");
            td.textContent = v;
            if (i === 1) {
              td.className = leg.status;
            }
            tr.append(td);
          }
        );
        table.append(tr);
      });
      box.append(table);
      return box;
    })
  );
}

async function refreshRoutes() {
  const { routeCheck } = await client.state.get(["routeCheck"], "extension");
  renderRoutes(routeCheck);
}

if (client.hasCapability("signalk.stream")) {
  await client.signalk.subscribe(["notifications.navigation.underKeel"], (ev) => {
    text("message", ev.value && typeof ev.value === "object" ? ev.value.message : "");
    void refreshStatus();
  });
}
await client.subscribe(["state.changed"], (_name, params) => {
  if (params && params.scope === "extension" && params.keys.includes("routeCheck")) {
    void refreshRoutes();
  }
});
document.getElementById("recheck").addEventListener("click", () => {
  void client.publish("ukc.checkRoutes", {}, "extension");
});
await refreshStatus();
await refreshRoutes();
/** Notifications arrive only on change and the stream is optional, so the panel also polls. */
setInterval(() => void refreshStatus(), 10000);
