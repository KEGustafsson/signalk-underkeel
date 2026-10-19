// Background runtime: keeps the look-ahead, route-check and UKC overlays current.
import { connectExtension } from "./vendor/plotterext-bus/extension.js";

const UKC = globalThis.UKC;
const client = await connectExtension();
const has = (c) => client.hasCapability(c);

/** A host may lack data overlays, or refuse one whose style is still loading. */
async function setOverlay(overlayId, source, data) {
  if (!has("overlays.data")) {
    return false;
  }
  try {
    await client.call("overlay.setData", { overlayId, source, data });
    return true;
  } catch (err) {
    console.warn(`under-keel ${overlayId} overlay`, err);
    return false;
  }
}

/** The plugin publishes every second; a path silent this long is no longer current. */
const STALE_MS = 10000;
const FETCH_TIMEOUT_MS = 8000;
const fresh = UKC.freshness(STALE_MS);
/** Handlers per Signal K path, called only with values the plugin published recently. */
const onPath = {};
const isDown = (state) => state === "off" || state === "unknown";

// ---- look-ahead envelope: fetched on each new envelopeRev, withdrawn when the plugin is not live ----
/** Without a Signal K stream the runtime polls; `?rev` makes an unchanged envelope a 304. */
const POLL_MS = 3000;
const EMPTY = { type: "FeatureCollection", features: [] };
/** The rev the overlay shows; null while it shows nothing. */
let shownRev = null;
/** Bumped on each clear, so a reply that was in flight cannot bring the envelope back. */
let generation = 0;
let engineState;
let lastRev;
let watchdog;
let fetching = false;
/** A bump that arrives mid-fetch may be newer than the reply in flight: fetch again after it. */
let refreshQueued = false;

function clearEnvelope() {
  generation++;
  if (shownRev !== null) {
    shownRev = null;
    void setOverlay("lookahead", "envelope", EMPTY);
  }
}

async function refreshEnvelope() {
  if (fetching) {
    refreshQueued = true;
    return;
  }
  fetching = true;
  const g = generation;
  try {
    const query = shownRev === null ? "" : `?rev=${shownRev}`;
    const res = await fetch(`${UKC.API}/envelope${query}`, {
      credentials: "same-origin",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    if (res.status === 304) {
      return;
    }
    if (!res.ok) {
      console.warn(`under-keel envelope: HTTP ${res.status}`);
      clearEnvelope();
      return;
    }
    const body = await res.json();
    if (g === generation && (await setOverlay("lookahead", "envelope", body.envelope)) && g === generation) {
      shownRev = body.rev;
    }
  } catch (err) {
    console.warn("under-keel envelope", err);
    clearEnvelope();
  } finally {
    fetching = false;
    if (refreshQueued) {
      refreshQueued = false;
      void refreshEnvelope();
    }
  }
}

onPath["navigation.underKeel.state"] = (state) => {
  const wasDown = engineState === undefined || isDown(engineState);
  if (engineState === "off" && state !== "off") {
    onRestart();
  } else if (engineState !== undefined && isDown(engineState) !== isDown(state)) {
    refreshTiles();
  }
  engineState = state;
  if (isDown(state)) {
    clearEnvelope();
  } else if (wasDown) {
    void refreshEnvelope();
  }
};

onPath["navigation.underKeel.envelopeRev"] = (rev, left) => {
  if (UKC.revJumped(lastRev, rev)) {
    onRestart();
  }
  lastRev = rev;
  clearTimeout(watchdog);
  watchdog = setTimeout(clearEnvelope, left);
  if (isDown(engineState)) {
    clearEnvelope();
  } else if (rev !== shownRev) {
    void refreshEnvelope();
  }
};

// ---- UKC tiles: classed at fetch time, so fetched again when what classed them changes ----
const LEVEL_STEP_M = 0.01;
const WATER_SOURCE_EVERY_MS = 60000;
let levelSeen = false;
let tileLevel;
let tileWaterSource;

function refreshTiles() {
  if (!has("overlays.data")) {
    return;
  }
  client
    .call("overlay.refresh", { overlayId: "ukc", source: "ukc" })
    .catch((err) => console.warn("under-keel ukc tiles", err));
}

onPath["navigation.underKeel.waterLevel"] = (h) => {
  if (!levelSeen) {
    levelSeen = true;
    tileLevel = h;
  } else if (UKC.levelMoved(tileLevel, h, LEVEL_STEP_M)) {
    tileLevel = h;
    refreshTiles();
  }
};

/** A fallback can keep the same height while it marks clear water unverified; only /status shows it. */
async function checkWaterSource() {
  try {
    const res = await fetch(`${UKC.API}/status`, {
      credentials: "same-origin",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    if (!res.ok) {
      return;
    }
    const key = UKC.waterSourceKey(await res.json());
    if (tileWaterSource !== undefined && key !== tileWaterSource) {
      refreshTiles();
    }
    tileWaterSource = key;
  } catch (err) {
    console.warn("under-keel status", err);
  }
}

if (has("overlays.data")) {
  void checkWaterSource();
  setInterval(() => void checkWaterSource(), WATER_SOURCE_EVERY_MS);
}

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

/** The panel reads the results from state, so they go there first, whatever the overlay does. */
async function publish() {
  await client.state.set({ routeCheck: Object.fromEntries(results) }, "extension");
  const features = [...results].flatMap(([id, r]) => UKC.legFeatures(id, r.legs));
  await setOverlay("routecheck", "legs", { type: "FeatureCollection", features });
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
          ? {
              name: route.name,
              rev: route.rev,
              legs: body.legs,
              checkedAt: body.checkedAt,
              receivedAt: new Date().toISOString()
            }
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
  try {
    const { routes } = await client.call("route.list");
    routes.forEach((r) => schedule(r.routeId));
  } catch (err) {
    console.warn("under-keel route list", err);
  }
}

/**
 * A restarted plugin may run with a new draft or water-level source, and the
 * tide moves on: results are only as current as their last check.
 */
const RECHECK_MS = 60000;

function onRestart() {
  refreshTiles();
  if (has("routes")) {
    void checkAll();
  }
}

// The host persists extension state across sessions: results from an earlier one are not current.
await publish();

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
  setInterval(() => void checkAll(), RECHECK_MS);
}

if (has("signalk.stream")) {
  await client.signalk.subscribe(Object.keys(onPath), (ev) => {
    const left = fresh(ev.path, ev.timestamp, Date.now());
    if (left > 0) {
      onPath[ev.path](ev.value, left);
    }
  });
} else {
  setInterval(() => void refreshEnvelope(), POLL_MS);
  void refreshEnvelope();
}
