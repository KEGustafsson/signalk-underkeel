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

/** The state and envelopeRev come at least every 5 s; one not seen for UKC.STALE_MS is not current. */
const FETCH_TIMEOUT_MS = 8000;
const fresh = UKC.freshness(UKC.STALE_MS);
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
/** When the last envelopeRev stops being current. */
let revFreshUntil = 0;
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
  if (document.hidden) {
    return;
  }
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
    refreshTiles("all");
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
  revFreshUntil = Date.now() + left;
  clearTimeout(watchdog);
  watchdog = setTimeout(clearEnvelope, left);
  if (isDown(engineState)) {
    clearEnvelope();
  } else if (rev !== shownRev) {
    void refreshEnvelope();
  }
};

// ---- UKC tiles: classed at fetch time; the plugin lists the tiles whose classes changed ----
/** The list also covers wave height and a fallback water level, which the stream does not show. */
const TILE_POLL_MS = 15000;
const tiles = UKC.tileRefresh();
let waterLevel;
let tilePolling = false;
let tilePollQueued = false;

function refreshTiles(which) {
  if (!which || which === "poll" || !has("overlays.data")) {
    return;
  }
  const params = { overlayId: "ukc", source: "ukc", ...(which === "all" ? {} : { tiles: which }) };
  client.call("overlay.refresh", params).catch((err) => console.warn("under-keel ukc tiles", err));
}

function onTileLevel(h, sourceKey) {
  const which = tiles.level(h, sourceKey);
  if (which === "poll") {
    void pollTiles();
  } else {
    refreshTiles(which);
  }
}

async function pollTiles() {
  if (!has("overlays.data") || document.hidden) {
    return;
  }
  if (tilePolling) {
    tilePollQueued = true;
    return;
  }
  tilePolling = true;
  const h = waterLevel;
  try {
    const res = await fetch(`${UKC.API}/tiles/ukc/changes${tiles.query()}`, {
      credentials: "same-origin",
      cache: "no-store",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    refreshTiles(tiles.polled(await res.json(), h));
  } catch (err) {
    console.warn("under-keel ukc tile changes", err);
    refreshTiles(tiles.lost());
    await levelFromStatus();
  } finally {
    tilePolling = false;
    if (tilePollQueued) {
      tilePollQueued = false;
      void pollTiles();
    }
  }
}

/** Without the change list the level rule decides, from /status when there is no stream. */
async function levelFromStatus() {
  try {
    const res = await fetch(`${UKC.API}/status?summary`, {
      credentials: "same-origin",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    if (res.ok) {
      const status = await res.json();
      const applied = status.waterLevel && status.waterLevel.applied;
      onTileLevel(applied ? applied.h : null, UKC.waterSourceKey(status));
    }
  } catch (err) {
    console.warn("under-keel status", err);
  }
}

onPath["navigation.underKeel.waterLevel"] = (h) => {
  waterLevel = h;
  onTileLevel(h);
};

if (has("overlays.data")) {
  void pollTiles();
  setInterval(() => void pollTiles(), TILE_POLL_MS);
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

/**
 * The panel reads the results from state, so they go there first, whatever the overlay does.
 * The host may persist every state write, so state gets the compact form, once per change.
 */
let publishedState;
let publishedLegs;
let publishTimer;
const PUBLISH_DELAY_MS = 250;

async function publish() {
  clearTimeout(publishTimer);
  const routeCheck = Object.fromEntries([...results].map(([id, r]) => [id, UKC.compactResult(r)]));
  const state = JSON.stringify(routeCheck);
  if (state !== publishedState) {
    try {
      await client.state.set({ routeCheck }, "extension");
      publishedState = state;
    } catch (err) {
      console.warn("under-keel route state", err);
    }
  }
  // An old result's legs turn unverified, as its panel badge says out of date.
  const now = Date.now();
  const legs = {
    type: "FeatureCollection",
    features: [...results].flatMap(([id, r]) => UKC.overlayLegs(id, r, now, UKC.ROUTE_MAX_AGE_MS))
  };
  const json = JSON.stringify(legs);
  if (json !== publishedLegs) {
    publishedLegs = (await setOverlay("routecheck", "legs", legs)) ? json : undefined;
  }
}

/** Edits and single checks arrive one by one: write them together once they pause. */
function publishSoon() {
  clearTimeout(publishTimer);
  publishTimer = setTimeout(() => void publish(), PUBLISH_DELAY_MS);
}

/** A stalled reply would hold one of the browser's few connections to the server. */
const ROUTE_CHECK_TIMEOUT_MS = 30000;
const checking = UKC.oneAtATime();
/** A busy server answers 503 with Retry-After; the old result ages out meanwhile. */
const BUSY_RETRIES = 5;

/** POST /route-check, again after Retry-After while the server is busy; null once superseded. */
async function postCheck(line, current) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${UKC.API}/route-check`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ route: line }),
      signal: AbortSignal.timeout(ROUTE_CHECK_TIMEOUT_MS)
    });
    const wait = res.status === 503 ? UKC.retryAfterMs(res.headers.get("retry-after")) : null;
    if (wait === null || attempt >= BUSY_RETRIES) {
      return res;
    }
    await new Promise((resolve) => setTimeout(resolve, wait));
    if (!current()) {
      return null;
    }
  }
}

async function check(routeId) {
  if (!checking.start(routeId)) {
    return;
  }
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
      const res = await postCheck(line, current);
      const body = res && (await res.json());
      if (!res || !current()) {
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
    const why =
      err && err.name === "TimeoutError"
        ? `no answer within ${ROUTE_CHECK_TIMEOUT_MS / 1000} s`
        : err && err.message
          ? err.message
          : String(err);
    results.set(routeId, {
      name: prev && prev.name,
      rev: prev && prev.rev,
      legs: [],
      error: `route check failed: ${why}`
    });
    console.warn("under-keel route check", err);
  } finally {
    if (checking.end(routeId)) {
      schedule(routeId);
    }
  }
}

/** Edits come in bursts while the user drags a point: check once they settle. */
function schedule(routeId) {
  clearTimeout(timers.get(routeId));
  timers.set(routeId, setTimeout(() => void check(routeId).then(publishSoon), 1000));
}

/** One route at a time: the server queues at most five heavy requests and refuses more. */
async function checkAll() {
  if (!checking.start(checkAll)) {
    return;
  }
  try {
    const { routes } = await client.call("route.list");
    // A route no longer listed keeps no legs on the chart, whichever check left them there.
    const listed = new Set(routes.map((r) => r.routeId));
    [...results.keys()].filter((id) => !listed.has(id)).forEach((id) => results.delete(id));
    routes.forEach((r) => clearTimeout(timers.get(r.routeId)));
    for (const r of routes) {
      await check(r.routeId);
    }
    await publish();
  } catch (err) {
    console.warn("under-keel route list", err);
  } finally {
    if (checking.end(checkAll)) {
      void checkAll();
    }
  }
}

/**
 * A restarted plugin may run with a new draft or water-level source, and the
 * tide moves on: results are only as current as their last check.
 */
const RECHECK_MS = 60000;

function onRestart() {
  refreshTiles("all");
  if (has("routes")) {
    void checkAll();
  }
}

// The host persists extension state across sessions: results from an earlier one are not current.
await publish();

// A host call that fails here must not stop the look-ahead below from starting.
if (has("routes")) {
  try {
    await client.subscribe(["route.**"], (name, params) => {
      if (name === "route.hidden") {
        clearTimeout(timers.get(params.routeId));
        // An edit during the running check must not bring the route back after it.
        checking.forget(params.routeId);
        nextSeq(params.routeId);
        results.delete(params.routeId);
        publishSoon();
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
        publishSoon();
        schedule(params.routeId);
      }
    });
    await client.subscribe(["ukc.checkRoutes"], () => void checkAll());
  } catch (err) {
    console.warn("under-keel route events", err);
  }
  void checkAll();
  // A hidden page checks nothing, so its results age, and their legs turn unverified.
  setInterval(() => {
    publishSoon();
    if (!document.hidden) {
      void checkAll();
    }
  }, RECHECK_MS);
}

/** Without the Signal K stream, or when subscribing to it fails, the envelope is polled. */
let streaming = false;
if (has("signalk.stream")) {
  try {
    await client.signalk.subscribe(Object.keys(onPath), (ev) => {
      const left = fresh(ev.path, ev.timestamp, Date.now());
      if (left > 0) {
        onPath[ev.path](ev.value, left);
      }
    });
    streaming = true;
  } catch (err) {
    console.warn("under-keel Signal K stream", err);
  }
}
if (!streaming) {
  setInterval(() => void refreshEnvelope(), POLL_MS);
  void refreshEnvelope();
}

/**
 * A hidden page fetches nothing. Back on screen, the envelope shown is
 * withdrawn until a current one arrives, route legs too old to trust turn
 * unverified, and tiles and routes are asked for at once.
 */
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    return;
  }
  clearEnvelope();
  if (!streaming || (!isDown(engineState) && Date.now() < revFreshUntil)) {
    void refreshEnvelope();
  }
  void pollTiles();
  if (has("routes")) {
    void publish();
    void checkAll();
  }
});
