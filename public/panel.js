// Details panel: the look-ahead explanation, water level, data notices and
// the route-check result of each route on the chart.
import { connectExtension } from "./vendor/plotterext-bus/extension.js";

const UKC = globalThis.UKC;
const THEME = globalThis.UKC_THEME;
/** The host's night mode as this page shows it; setup opens in the same scheme. */
let scheme = null;
// Setup opens in this panel rather than one of its own, so the toolbar keeps one button.
document.getElementById("open-setup").addEventListener("click", () => {
  location.assign(`setup.html?from=details${scheme ? `&scheme=${scheme}` : ""}`);
});
const client = await connectExtension();
// Not awaited: a host that offers night mode but never answers must not hold back the status.
void THEME.followHost(client, document, (s) => (scheme = s));
let unit = "m";

if (client.hasCapability("units")) {
  const { units } = await client.call("units.get");
  unit = units && units.depth ? units.depth : "m";
}

function text(id, value) {
  document.getElementById(id).textContent = value;
}

/** The state chip: its label, and its colours from theme.css for the state. */
function showState(state) {
  const chip = document.getElementById("state");
  chip.textContent = UKC.stateStyle(state).label;
  chip.dataset.state = UKC.stateKey(state);
}

function showUnknownStatus(why) {
  showState("unknown");
  text("source", `Under-keel status unavailable: ${why}`);
}

/** The poll and the notification can overlap: only the latest request may update the panel. */
let statusRequest = 0;
const STATUS_TIMEOUT_MS = 8000;
/** Two missed polls; requests superseded before their timeout never report a failure. */
const STATUS_MAX_AGE_MS = 20000;
let statusAt = 0;

async function refreshStatus() {
  const id = ++statusRequest;
  try {
    const res = await fetch(`${UKC.API}/status?summary`, {
      credentials: "same-origin",
      signal: AbortSignal.timeout(STATUS_TIMEOUT_MS)
    });
    if (id !== statusRequest) {
      return;
    }
    if (!res.ok) {
      showUnknownStatus(`HTTP ${res.status}`);
      return;
    }
    const s = await res.json();
    if (id !== statusRequest) {
      return;
    }
    statusAt = Date.now();
    showState(s.engine.state);
    text("source", UKC.statusLines(s, unit).join(" · "));
  } catch (err) {
    if (id !== statusRequest) {
      return;
    }
    showUnknownStatus(
      err && err.name === "TimeoutError" ? "no answer from the plugin" : err && err.message ? err.message : String(err)
    );
    console.warn("under-keel status", err);
  }
}

function renderRoutes(entries) {
  const el = document.getElementById("routes");
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
      const status = UKC.routeBadge(r, Date.now(), UKC.ROUTE_MAX_AGE_MS);
      title.append(`${r.name || "Unsaved route"}: `);
      const badge = document.createElement("b");
      badge.className = status.cls;
      badge.textContent = status.text;
      title.append(badge);
      box.append(title);
      if (r.error || r.pending) {
        box.append(r.error || "");
        return box;
      }
      const age = document.createElement("div");
      age.className = "muted";
      age.textContent = UKC.checkedAgo(r.receivedAt, Date.now());
      box.append(age);
      const table = document.createElement("table");
      table.innerHTML = "<tr><th>Leg</th><th>Status</th><th>Min UKC</th><th>P(UKC&lt;0)</th></tr>";
      r.legs.forEach((leg) => {
        const tr = document.createElement("tr");
        UKC.legRow(leg, unit).forEach((v, i) => {
          const td = document.createElement("td");
          td.textContent = v;
          if (i === 1) {
            td.className = leg.status;
          }
          tr.append(td);
        });
        table.append(tr);
      });
      box.append(table);
      // Why a leg is unverified when its status alone does not say, as outside the chart box.
      r.legs
        .filter((leg) => leg.reason)
        .forEach((leg) => {
          const note = document.createElement("div");
          note.className = "muted";
          note.textContent = `Leg ${leg.index + 1}: ${leg.reason}`;
          box.append(note);
        });
      return box;
    })
  );
}

async function refreshRoutes() {
  try {
    const { routeCheck } = await client.state.get(["routeCheck"], "extension");
    const visible = client.hasCapability("routes") ? (await client.call("route.list")).routes : null;
    renderRoutes(UKC.routeEntries(routeCheck, visible));
  } catch (err) {
    // A result left on screen would never age out, so it is replaced, not kept.
    text("routes", "Route results unavailable: the chart host did not answer.");
    console.warn("under-keel routes", err);
  }
}

/** The notification's message, which the background page keeps in the extension state. */
async function refreshNotice() {
  try {
    const { ukcNotice } = await client.state.get(["ukcNotice"], "extension");
    text("message", ukcNotice && typeof ukcNotice.message === "string" ? ukcNotice.message : "");
  } catch (err) {
    // An old message left on screen could say normal over a warning; the poll reads it again.
    text("message", "Under-keel message unavailable: the chart host did not answer.");
    console.warn("under-keel notice", err);
  }
}

// No Signal K subscription of its own: the host would unsubscribe it path by path when the
// panel closes, which Signal K refuses and logs as an error. The background page relays it.
await client.subscribe(["state.changed"], (_name, params) => {
  if (!params || params.scope !== "extension") {
    return;
  }
  if (params.keys.includes("routeCheck")) {
    void refreshRoutes();
  }
  if (params.keys.includes("ukcNotice")) {
    void refreshNotice();
    if (!document.hidden) {
      void refreshStatus();
    }
  }
});
void refreshNotice();
// The background runtime answers the button, over an event the host must carry.
const recheck = document.getElementById("recheck");
recheck.hidden = !["events.publish", "routes", "background.iframe"].every((c) => client.hasCapability(c));
recheck.addEventListener("click", () => {
  void client.publish("ukc.checkRoutes", {}, "extension");
});
await refreshStatus();
await refreshRoutes();
function checkStatusAge() {
  if (Date.now() - statusAt > STATUS_MAX_AGE_MS) {
    showUnknownStatus("no status from the plugin for over 20 s");
  }
}

/** Notifications arrive only on change and the stream is optional, so the panel also polls. */
function poll() {
  void refreshStatus();
  void refreshRoutes();
  void refreshNotice();
}

// A hidden page polls nothing; back on screen an old status reads unknown until the poll answers.
setInterval(() => {
  if (!document.hidden) {
    checkStatusAge();
  }
}, 1000);
setInterval(() => {
  if (!document.hidden) {
    poll();
  }
}, 10000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    checkStatusAge();
    poll();
  }
});
