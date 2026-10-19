// Background runtime: keeps the look-ahead and route-check overlays current.
import { connectExtension } from "./vendor/plotterext-bus/extension.js";

const UKC = globalThis.UKC;
const client = await connectExtension();
const has = (c) => client.hasCapability(c);

// ---- look-ahead envelope: refetched whenever the plugin bumps envelopeRev ----
let envelopeRev = 0;
let fetching = false;
/** A bump that arrives mid-fetch may be newer than the reply in flight: fetch again after it. */
let refreshQueued = false;

async function refreshEnvelope() {
  if (fetching) {
    refreshQueued = true;
    return;
  }
  fetching = true;
  try {
    const res = await fetch(`${UKC.API}/envelope?rev=${envelopeRev}`, { credentials: "same-origin" });
    if (res.status === 304 || !res.ok) {
      return;
    }
    const body = await res.json();
    envelopeRev = body.rev;
    await client.call("overlay.setData", { overlayId: "lookahead", source: "envelope", data: body.envelope });
  } catch (err) {
    console.warn("under-keel envelope", err);
  } finally {
    fetching = false;
    if (refreshQueued) {
      refreshQueued = false;
      void refreshEnvelope();
    }
  }
}

if (has("signalk.stream")) {
  await client.signalk.subscribe(["navigation.underKeel.envelopeRev"], (ev) => {
    if (ev.value !== envelopeRev) {
      void refreshEnvelope();
    }
  });
}
void refreshEnvelope();

// ---- route check: every visible route, again after each edit ----
const results = new Map();
const timers = new Map();
/** Latest check per route: a reply to an older check, or to a hidden route, is dropped. */
const seq = new Map();

function nextSeq(routeId) {
  const n = (seq.get(routeId) || 0) + 1;
  seq.set(routeId, n);
  return n;
}

async function publish() {
  const features = [...results].flatMap(([id, r]) => UKC.legFeatures(id, r.legs));
  await client.call("overlay.setData", {
    overlayId: "routecheck",
    source: "legs",
    data: { type: "FeatureCollection", features }
  });
  await client.state.set({ routeCheck: Object.fromEntries(results) }, "extension");
}

async function check(routeId) {
  const n = nextSeq(routeId);
  const current = () => seq.get(routeId) === n;
  try {
    const route = await client.call("route.get", { routeId });
    const line = UKC.routeLine(route.points);
    if (!current()) {
      return;
    }
    if (!line) {
      results.delete(routeId);
    } else {
      const res = await fetch(`${UKC.API}/route-check`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ route: line })
      });
      const body = await res.json();
      if (!current()) {
        return;
      }
      results.set(
        routeId,
        res.ok
          ? { name: route.name, rev: route.rev, legs: body.legs, checkedAt: body.checkedAt }
          : { name: route.name, rev: route.rev, legs: [], error: (body.errors || []).join("; ") }
      );
    }
  } catch (err) {
    if (!current()) {
      return;
    }
    const prev = results.get(routeId);
    results.set(routeId, {
      name: prev && prev.name,
      rev: prev && prev.rev,
      legs: [],
      error: `route check failed: ${err && err.message ? err.message : String(err)}`
    });
    console.warn("under-keel route check", err);
  }
  await publish();
}

/** Edits come in bursts while the user drags a point: check once they settle. */
function schedule(routeId) {
  clearTimeout(timers.get(routeId));
  timers.set(routeId, setTimeout(() => void check(routeId), 1000));
}

async function checkAll() {
  const { routes } = await client.call("route.list");
  routes.forEach((r) => schedule(r.routeId));
}

if (has("routes")) {
  await client.subscribe(["route.**"], (name, params) => {
    if (name === "route.hidden") {
      clearTimeout(timers.get(params.routeId));
      nextSeq(params.routeId);
      results.delete(params.routeId);
      void publish();
    } else if (params && params.routeId) {
      // The old legs describe the old geometry: drop them until the check comes back.
      nextSeq(params.routeId);
      const prev = results.get(params.routeId);
      results.set(params.routeId, {
        name: prev && prev.name,
        rev: prev && prev.rev,
        legs: [],
        error: "checking the edited route"
      });
      void publish();
      schedule(params.routeId);
    }
  });
  await client.subscribe(["ukc.checkRoutes"], () => void checkAll());
  await checkAll();
}
