# Under-Keel Awareness: development plan

**Signal K plugin `signalk-underkeel` + Freeboard-SK core integration**

Status: design sketch v0.1 · 2026-10-17 · target Freeboard-SK ≥ 3.4 · Signal K Server ≥ 2.x

> Advisory navigation aid. Not ECDIS, not a replacement for official charts or a proper lookout.
> Every UI surface and the README must say so, matching Freeboard's existing S-57 disclaimer.

---

## 1. Goal and one-paragraph pitch

Freeboard draws charts but never asks them anything. `safetyDepth`, `DRVAL1` and `DEPARE`
appear only in `s57Style.ts` for colouring. This project turns the chart into a queryable
hazard model on the Signal K server, and gives Freeboard a native UI for it.

The design treats grounding risk as a **probability** rather than a yes/no answer. It
combines three things:

- **Charted depth and its survey quality.** S-57 `CATZOC` zones of confidence.
- **Real water level.** Baltic sea level moves ±0.5–1 m with weather, with no tides.
- **The boat's own state.** Squat, heel, sea state, and GNSS integrity.

The output is a single, explainable number per point, leg and moment:
**P(under-keel clearance < 0)**. The boat also keeps learning, comparing its own soundings
against the chart.

### Design principle (from the earlier discussion)

| Concern                                                                    | Lives in                              | Why                                                                                              |
| -------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------ |
| What is dangerous (index, risk model, look-ahead, route check)             | **Signal K plugin**                   | Runs with every screen asleep; one source of truth across stations; reaches KIP, phones, N2K/MFD |
| How danger looks (envelope layer, leg colouring, alarm popover, editor UX) | **Freeboard core**                    | Core plotter UX; must feel native in the route editor, not an iframe                             |
| The seam between them                                                      | **Provider-neutral service contract** | Freeboard must not hard-depend on one plugin                                                     |

**Decision (Phase 10): the Freeboard UI ships in the plugin.** The plugin serves its own UI
through the Plotter Extensions API instead of changing Freeboard core:

- a background runtime;
- a status widget;
- a details panel;
- a toolbar button;
- two data overlays, the look-ahead envelope and the route legs.

Freeboard core stays unchanged, and the UI ships and versions with the plugin. Any host that
implements the API can show it.

The cost: the UI runs in iframes, so it cannot colour legs inside Freeboard's route editor
while they are dragged. The alarm popover, Suggest fix and departure-window strip of §5.4 are
not built. §5 remains the design for a later core integration; §4.14 lists what is built.

### Correction to the earlier chat answer

The earlier answer said to raise `notifications.grounding`. In the Signal K spec that path is
the standard **emergency alarm for "we have run aground"**, in the same family as `mob`, `fire`
and `sinking`. It is not a look-ahead warning.

This plan uses a new path, **`notifications.navigation.underKeel`**, which follows the existing
`notifications.navigation.closestApproach` pattern Freeboard already handles in
`notification-manager.ts`. `notifications.grounding` is raised only by the optional
actual-grounding detector (§4.9).

---

## 2. What is novel here

Most plotters, TimeZero included, use a **fixed cone** checked against a **fixed safety
depth**. This design differs in eight ways.

1. **Probabilistic UKC with an explanation for every alarm.** Each warning breaks down its
   terms, for example: _charted 2.4 m (CATZOC C, ±1.1 m) + water level −0.31 m (FMI forecast)
   − draft 1.9 m − squat 0.08 m − heel 0.0 m − wave allowance 0.15 m → μ = −0.04 m,
   σ = 0.58 m, P = 53 %_. The crew can see why it is shouting, which is the cure for alarm
   fatigue.
2. **Time-to-shoal (TTS), the seabed's equivalent of TCPA.** The look-ahead is a predicted
   trajectory fan from a constant-turn-rate model (SOG, COG, ROT). It bends with the turn and
   widens with uncertainty over time. The alarm metric is seconds until risk crosses a
   threshold, which is what a helmsman can act on.
3. **Escape fan.** On every alert the engine also evaluates candidate headings within the
   boat's turn-rate limit, and publishes the one with the greatest time-to-shoal. Freeboard
   draws it as a green "way out" arrow. It is never actuated automatically; the autopilot
   "dodge" mode is offered as a one-tap human action.
4. **Navigation integrity coupled to grounding risk.** If GNSS integrity degrades (high HDOP,
   lost fix, or dead-reckoning divergence, i.e. jamming or spoofing in the Baltic), the
   horizontal uncertainty widens and so does the hazard buffer. The system becomes more
   cautious exactly when position becomes untrustworthy. No consumer plotter links these.
5. **Swept-area awareness, a Finland-specific win.** Finnish fairways are swept to a
   guaranteed depth (`SWPARE`, _haraussyvyys_). Inside a swept area depth uncertainty is
   close to zero; outside, many areas rest on old surveys. The model trusts swept fairways
   and becomes conservative off them, matching how local skippers actually think.
6. **Conservative min-depth pyramid.** The data structure is a hierarchical min-pyramid in
   which each parent cell stores the shallowest depth of its children. Queries over a swept
   polygon cull whole subtrees in O(log n), and refine only where the bound is close to the
   threshold. The same pyramid is served as tiles, so Freeboard can show a UKC heat layer with
   no extra processing.
7. **Living chart.** The boat logs its own soundings (echo sounder and Wi-Fish), reduces them
   to chart datum using the water level at the time, and updates each grid cell's depth
   estimate. Where repeated soundings are shallower than charted, it creates a **Signal K
   note** ("suspected shoal") and optionally exports IHO CSB GeoJSON for contribution to the
   IHO DCDB crowdsourced bathymetry archive.
8. **Water-level-conditioned acknowledgements.** When the skipper acknowledges a warning on a
   known passage, the system remembers the geofence, the water level, the draft and the
   heading. The same passage stays quiet next time, unless the water level is lower than when
   it was acknowledged. Alarms learn local knowledge without losing their safety meaning.

Planning features follow from the same model.

- **Corridor route check.** The check covers each leg buffered by the cross-track limit plus
  position uncertainty, not just the leg's line, and evaluates it at that leg's estimated
  arrival time against the water-level forecast.
- **Minimal-repair suggestion.** For a failing leg, the system suggests the fewest inserted
  waypoints that clear it. This is not full auto-routing.
- **Departure window.** The system reports when, over the next 48 h, the whole route clears
  with a chosen probability.

---

## 3. System architecture

```
┌────────────────────────── Signal K Server ───────────────────────────┐
│                                                                       │
│  signalk-charts-provider-simple ──(ENC .000 cells)──┐                 │
│  Traficom ENC / open depth data ────────────────────┤                 │
│                                                       ▼               │
│  ┌──────────────── signalk-underkeel ──────────────────────────────┐  │
│  │ Ingest (GDAL in signalk-container) → FlatGeobuf per cell         │  │
│  │ Index builder (worker) → min-depth pyramid + hazard R-tree      │  │
│  │ Water level (FMI / tide provider / manual) ──┐                   │  │
│  │ Vessel model (draft, heel, squat) ───────────┤                   │  │
│  │ Integrity monitor (GNSS vs DR) ──────────────┤                   │  │
│  │                                               ▼                   │  │
│  │ Risk engine ── Look-ahead (1 Hz) ──→ deltas + notification       │  │
│  │      │       ── Route check / repair / window (REST)              │  │
│  │      │       ── Living chart (soundings → grid posterior → notes) │  │
│  │      └──── UKC tiles (PMTiles-style pyramid) ──→ data overlay     │  │
│  │ Manifest: plotterExtensions["signalk-underkeel"].services        │  │
│  └──────────────────────────────────────────────────────────────────┘ │
└──────────────┬────────────────────────────────┬──────────────────────┘
       WS deltas│ notifications                  │ REST /plugins/signalk-underkeel/v1
               ▼                                ▼
┌──────────────────────────── Freeboard-SK core ───────────────────────┐
│ NavSafetyService (provider discovery, stream, envelope fetch)        │
│ Envelope layer · hazard markers · escape arrow · UKC heat overlay    │
│ Route editor leg colouring · "Suggest fix" · departure window        │
│ Alarm popover with term breakdown · status bar UKC/TTS readout       │
└───────────────────────────────────────────────────────────────────────┘
```

---

## 4. Signal K plugin: `signalk-underkeel`

### 4.1 Repository layout

```
signalk-underkeel/
├── package.json                  # signalk-node-server-plugin, signalk-category-navigation
├── src/
│   ├── index.ts                  # plugin lifecycle, schema, router registration
│   ├── config.ts                 # JSON schema + defaults
│   ├── ingest/
│   │   ├── enc-reader.ts         # .000 → FlatGeobuf via GDAL (container job)
│   │   ├── open-data-reader.ts   # Traficom/SYKE open vector depth (GeoPackage/WFS)
│   │   ├── coverage.ts           # best-scale mosaic: usage band selection, overlaps
│   │   └── datum.ts              # vertical datum per cell (M_VDAT / M_SDAT, VERDAT)
│   ├── spatial/
│   │   ├── pyramid.ts            # min-depth pyramid build + query
│   │   ├── hazards.ts            # flatbush R-tree of point/line hazards
│   │   ├── quality.ts            # CATZOC / M_QUAL / SWPARE → σ_depth, σ_pos
│   │   └── store.ts              # on-disk format, mmap, versioning
│   ├── model/
│   │   ├── vessel.ts             # draft, heel curve, beam, squat coefficients
│   │   ├── water-level.ts        # provider interface + FMI + tide + manual
│   │   ├── uncertainty.ts        # σ composition, P(UKC<0)
│   │   └── integrity.ts          # GNSS vs DR divergence → σ_pos inflation
│   ├── engine/
│   │   ├── trajectory.ts         # CTRV fan prediction
│   │   ├── lookahead.ts          # 1 Hz loop, TTS, hysteresis, notifications
│   │   ├── escape.ts             # escape-fan search
│   │   ├── route-check.ts        # corridor check per leg
│   │   ├── route-repair.ts       # Theta* on cost grid, constrained simplify
│   │   ├── departure-window.ts   # sweep departure times vs WL forecast
│   │   ├── acks.ts               # water-level-conditioned acknowledgements
│   │   └── grounding-detect.ts   # optional: actual grounding → notifications.grounding
│   ├── livechart/
│   │   ├── soundings.ts          # subscribe depth sources, reduce to datum
│   │   ├── posterior.ts          # per-cell Bayesian update
│   │   ├── discrepancy.ts        # suspected-shoal detection → notes resource
│   │   └── csb-export.ts         # IHO CSB GeoJSON
│   ├── api/
│   │   ├── routes.ts             # REST handlers
│   │   ├── tiles.ts              # UKC tile endpoint
│   │   └── manifest.ts           # plotterExtensions resource contribution
│   └── workers/
│       └── build-index.worker.ts
├── __tests__/                    # jest (ts-jest) + fast-check; replay logs
├── fixtures/enc/                 # synthetic cells + one real Finnish cell (licence permitting)
└── docs/
```

**Stack:**

- TypeScript on Node 22+, matching the `signalk-server` engines floor.
- `flatbush` for the static R-tree.
- `@turf/*`, only for buffers and planning-time geometry. The hot path uses its own
  local-tangent-plane math.
- `better-sqlite3` for soundings and acknowledgements.
- `worker_threads` for the index build. The worker's old-generation heap is capped at a
  quarter of the RAM (256 MB to 2 GB), so a build too large for the machine ends the worker
  with an error in the status and the previous index stays in use, instead of growing until
  the kernel ends the server. A server started with `--max-old-space-size` overrides the cap,
  because V8 flags apply to every isolate in the process.
- GDAL/OGR, run in a container through `signalk-container`, for reading S-57. This keeps the
  same container approach as `signalk-charts-provider-simple`.
- Must run on a Raspberry Pi 4 as well as on the Jetson Orin. Budget: index RAM under 150 MB,
  look-ahead CPU under 5 % of one core.

### 4.2 Ingest

**Sources, in priority order:**

1. **S-57 ENC cells.** Either reuse the `.000` files the user already gave to
   `signalk-charts-provider-simple` (read-only access to its data directory, configured
   path), or point to a folder. Traficom distributes quality-assured S-57 ENCs for Finnish
   waters through its download service.
2. **National vector depth data.** Implemented for Traficom's INSPIRE WFS
   (`DepthArea_A`, `DredgedArea_A`, `Sounding_P`), off by default. Its licence allows
   non-navigational use only, and it has no land, rocks, wrecks, obstructions or `M_QUAL`.
   Decision (safety invariants 3 and 4): the plugin downloads a box of configurable radius
   (default 10 km) around the vessel and a new one once the vessel is more than half the radius
   from its centre, or once the distance to the box edge along COG is under SOG × 1.5 × the
   last download-and-build time plus the look-ahead's reach (the last time is saved with the
   box; 10 minutes until one is measured). Checks run every 10 s, at most once a minute and
   5 minutes after a failed download. The new box is centred SOG × the last time ahead along
   COG, at most 0.8 × the radius, so the vessel is near its centre when it is handed over; at
   25 kn with 10-minute rebuilds the half-radius rule alone handed a box over with the vessel
   5.4 km past the old box's edge. A box centred ahead covers less water astern, which route
   checks of legs behind the vessel see as uncovered (`unverified`, invariant 4). A worker thread downloads the box, parses, clips and writes the cell, rebuilds
   the index and stages it; the main thread moves it into place and swaps it in. Each page is
   read as a stream: more than 64 MB, or 30 s without a byte, fails the download, which then
   waits 5 minutes as after any failure, and the previous index stays. The living chart is
   moved onto the new index in slices of 1 000 cells, each its own turn of the event loop, and
   the index is swapped in during the turn that finishes the move, so no query sees the new
   index without the living chart's adjustments (invariant 5). When only the WFS cell differs
   from the index in use, only the living-chart cells within 1 km and one cell of the old or
   new box are re-judged: the chart prior of any other cell reads the same tiles in both; a
   property test checks that this equals re-judging every cell. The box is one cell
   of usage band 1, so every ENC cell wins where both cover. Water no depth area reaches is
   land. Survey quality is an assumed CATZOC (configurable, default B). Every tile from the cell
   carries `NOT_FOR_NAVIGATION`: the look-ahead is never `normal` there (at most `alert`, with
   the licence notice), route legs are never `ok`, and the overlay never draws `clear`.
3. **Unsurveyed-waterway depth data.** For example, SYKE lake and coastal data, explicitly
   _not for navigation_. Ingest it as **CATZOC U** with large σ, so it can only add caution,
   never confidence.

**S-57 object classes used:**

| Class                        | Attributes                             | Role                                                                            |
| ---------------------------- | -------------------------------------- | ------------------------------------------------------------------------------- |
| `DEPARE`                     | `DRVAL1`, `DRVAL2`                     | depth areas; rasterise with **`DRVAL1`** (shallow bound), which is conservative |
| `DRGARE`                     | `DRVAL1`                               | dredged areas                                                                   |
| `SWPARE`                     | `DRVAL1`                               | swept depth; **guaranteed minimum**, σ_depth ≈ 0.1 m                            |
| `SOUNDG`                     | 3D multipoint                          | spot depths; burn in with position-uncertainty disc                             |
| `UWTROC`, `WRECKS`, `OBSTRN` | `VALSOU`, `WATLEV`, `EXPSOU`, `QUASOU` | point hazards → R-tree, buffered                                                |
| `LNDARE`, `COALNE`, `SLCONS` | —                                      | depth −∞ (hard obstacles)                                                       |
| `PONTON`, `FLODOC`, `HULKES` | —                                      | depth −∞ (hard obstacles)                                                       |
| `UNSARE`                     | —                                      | no depth: `NO_COVERAGE`, so legs are _unverified_ and look-ahead never _normal_ |
| `M_QUAL`                     | `CATZOC`, `POSACC`, `SOUACC`           | survey quality zones                                                            |
| `M_COVR`                     | `CATCOV`                               | coverage; no coverage means _unverified_, not _safe_                            |
| DSID / `M_SDAT`, `M_VDAT`    | sounding / vertical datum              | water-level reduction (§4.5)                                                    |

**Coverage mosaic.** For every location, use the cell from the **largest-scale usage band**
that covers it. Where bands overlap, the larger scale wins, and the smaller scale is used only
to fill gaps.

**Output:** normalised FlatGeobuf per cell, plus `cells.json` recording edition, update
number, issue date and datum. The chart edition is stamped onto every route-check result, so
the user can see what data a result was based on.

### 4.3 Index: min-depth pyramid and hazard tree

**Grid.** Web Mercator tile pyramid; each node is one tile. The default range is z10 to z20
(a z20 tile is about 19 m on a side at 60°N). The pyramid is a sparse quadtree: a tile is
subdivided only where a boundary inside it could change a child's value, so open water and
large uniform areas stay at coarse zooms. Each node stores the following.

```ts
interface Cell {
  dMin: number; // conservative charted depth (m below chart datum), -Inf = land
  sigmaD: number; // 1σ depth uncertainty from CATZOC/SOUACC (m)
  sigmaP: number; // 1σ horizontal uncertainty of the source (m) from CATZOC/POSACC
  surveySigmaP: number; // widest σP of the assessed quality zones reaching it (chart reach)
  flags: number; // SWEPT | NO_COVERAGE | UNASSESSED | DREDGED | LIVECHART_ADJUSTED
  cellRef: number; // index into cells.json (edition provenance)
}
```

**Build rule.** Each parent stores the following, so any query box gets a guaranteed
lower bound from one lookup.

- `dMin` is the minimum of its children's.
- `sigmaD` and `sigmaP` are the maximum of its children's.
- `flags` is the bitwise OR of its children's.

**Burning hazards.** Each point hazard and sounding is rasterised into every cell within
`k·σP_source` of it (k = 2), so the pyramid alone is conservative. The R-tree keeps the exact
geometry for explanations and for refinement near the threshold. A burn disc more than 8 tiles
wide does not by itself subdivide a tile: the tile takes the disc's depth over its whole area,
which is pessimistic by at most one tile width and keeps CATZOC C soundings (σP 250 m) from
splitting every tile down to the leaf zoom.

**Build cost.** Each area polygon keeps its bounding box and, for rings of 64 or more
vertices, a uniform grid of its edges, so a tile test reads only the edges near the tile and
the edges that span the corner's row; one boundary pass and four corner tests decide both "the
area reaches the tile" and "the area contains the tile", and an area containing a tile is
passed to its children as containing them. The tests return exactly what the per-vertex walk
returns (`src/spatial/polygon-index.ts`), so the pyramid is unchanged. The index build in the
worker evaluates one minZoom root at a time from only the cells whose features reach it (a
survey pass keeps each cell's extent and widest burn radius), on up to four threads (one per
core but one and per GiB of RAM), and joins the roots in key order; each root depends only on
the features reaching it, so the pyramid is byte-identical to a build of all cells at once
whatever the thread count, and only one neighbourhood's features are held per thread.

**Query: `minDepthOver(polygon, zoomCap)`.**

1. Start at the coarsest tiles that cover the polygon's bounding box.
2. If the tile's bound already clears by a margin, stop. That part is safe.
3. If the tile's bound is already hopeless, stop. That part fails, with the worst cell as
   evidence.
4. Otherwise descend into the children, and at the leaves intersect them with the exact
   polygon. A tile that lies wholly within the buffer of the polygon (inside it, or with all
   four corners within the buffer of one vertex or edge) passes that to its children, which
   are then taken without distance tests.

Expected cost is about 50 to 300 cell visits per look-ahead footprint.

**Chart position in the query.** Depth areas and lines are not burned, so the look-ahead
(k = k_p), a route check, a repair cost cell, `POST /query` and the UKC tiles (k = 2) count
each tile within the query buffer plus `k·σP` of that tile's own survey, at most 1000 m
(`spatial/chart-position.ts`). A drying area drawn 60 m off a footprint in CATZOC B water
(σP 25 m) is therefore in reach, while an A1 rock beside it is not widened by C water
elsewhere in the query. A leaf's reach comes from `surveySigmaP`, the widest σP of the
assessed, non-advisory quality zones reaching it, so a leaf only partly assessed (at a coverage
edge or between a B and a U zone) keeps the reach of its assessed part; `sigmaP` would also hold
the unassessed guess. A split tile stores the widest of its leaves and prunes its subtree by
it, so the walk descends wherever any leaf may reach and nowhere else. Unassessed water and
Traficom WFS water add no reach: their flags already make a leg `unverified`, a query
never `clear` and the look-ahead never `normal`, and the unassessed σP of 500 m would make
nearly every leg over WFS water `fail` on land within 1 km that the data does not put there. A
point hazard is counted twice this way, burned and reached, which errs on the shallow side: a
CATZOC C sounding counts up to 1 km from its position.

**Storage.**

- `pyramid.bin`: a JSON header line, then one typed column per node field (depth, σ, flags,
  cell reference, tile key, zoom, split bit), the columns together gzip-compressed at level 1
  (7.5 MB → 0.56 MB for two Nauvo cells at z20; the CRC also refuses a torn body). Nodes are
  written by zoom and then tile key, so at start the inflated columns are the store as they
  are, and a lookup bisects its zoom's key column: 36 bytes per node resident, against
  110–160 with a Map per zoom (which V8 also caps at 16.7 M entries). `dMin` stays a 64-bit
  float, so a stored depth is never rounded deeper. Loading only the leaf blocks near the
  vessel and the route is the follow-up if the full Finnish coast exceeds the RAM budget.
- `cells.json` (provenance) and `hazards.json` (exact hazard geometry) sit beside it. The
  hazard R-tree is rebuilt from `hazards.json` at load, packed in typed arrays (about 47 bytes
  per hazard).
- The index is built in a worker thread, at start as for a new WFS box (§4.2); until the
  worker hands it over the look-ahead is `off` with the reason `building chart index`, and the
  WFS box starts only after the handover, so this build never replaces a newer box's index.
  A saved `pyramid.bin` over 1 MB is read and inflated off the event loop the same way, `off`
  with `loading chart index` meanwhile; a smaller one loads within `start()` (22 ms on x86 for
  two Nauvo cells).
- A save writes and fsyncs the three files and their staging directory, renames the staging
  directory into place and fsyncs the parent. A saved index that fails to read or parse at
  start (a power cut can still leave a file short) is rebuilt from the configured cells, with
  the read error in the index reason; without cells the read error is the reason.
- The same data is also exported as UKC tiles (§4.10).

**Invariant, tested by property-based tests:** for any polygon,
`pyramid.minDepthOver(poly) ≤ min(source feature depths intersecting poly ⊕ σP buffer)`.
The pyramid may be pessimistic but must never be optimistic.

### 4.4 Survey quality → uncertainty

CATZOC accuracy table, from the S-57 specification (values to verify against the S-57
Appendix A text during implementation):

| CATZOC   | Position (±) | Depth (±)                  |
| -------- | ------------ | -------------------------- |
| A1       | 5 m          | 0.50 m + 1 % d             |
| A2       | 20 m         | 1.00 m + 2 % d             |
| B        | 50 m         | 1.00 m + 2 % d             |
| C        | 500 m        | 2.00 m + 5 % d             |
| D        | worse than C | worse than C → use 2× C    |
| U / none | unassessed   | configurable, default 2× C |

These are treated as ~95 % bounds, so σ ≈ value / 2.

Two overrides apply on top of the table:

- **Swept areas.** `SWPARE` caps `dMin` at the swept depth and sets `sigmaD = 0.1 m` where the
  swept depth is the tile's `dMin`. A rock or sounding charted shallower inside the swept area
  keeps the survey's σ, since the sweep guarantees only its own depth.
- **Own soundings.** Where the living-chart posterior has enough samples, it replaces the
  table values (§4.11).

**Zone boundaries.** A leaf that no single `M_QUAL` zone contains is still assessed when the
assessed zones reaching it cover it together, which holds where they share the boundary vertex
for vertex. It takes the worst σ of those zones. A boundary split differently on each side, an
overlap or a gap leaves the leaf `UNASSESSED`.
Coverage follows the same rule per usage band: a leaf on the shared edge of two `M_COVR`
polygons of one band is covered when they match vertex for vertex, and `NO_COVERAGE` otherwise.

### 4.5 Water level

```ts
interface WaterLevelProvider {
  id: string;
  /** Height of water surface above the CHART DATUM of `cellRef` at `t`, with 1σ. */
  levelAt(
    lon: number,
    lat: number,
    t: Date,
    cellRef: number
  ): Promise<{ h: number; sigma: number; source: string }>;
  health(): { ok: boolean; lastUpdate?: Date; message?: string };
}
```

**Providers:**

- **`manual`.** A constant offset, with σ set by the user.
- **`signalk-tide`.** Reads `environment.tide.heightNow` and the forecast from whatever tide
  provider is installed. This is the right choice in tidal waters.
- **`fmi`.** Finnish Meteorological Institute open data: tide-gauge observations and the
  sea-level forecast, with the nearest station interpolated by distance along the coast.
  WFS stored-query ids to be confirmed during the spike. σ grows with forecast lead time,
  calibrated from FMI forecast-versus-observation history.
- **`composite`.** Uses the observation now, the forecast for later, and blends the two near
  the current time.

**Datum reduction.** Finnish charts are moving to the N2000 height system, while older cells
use mean-water based datums. FMI publishes sea level relative to N2000 and to theoretical
mean water. `datum.ts` maps each cell's vertical datum (`M_VDAT` / `VERDAT`) to the matching
FMI series. **An unknown datum sets σ_wl = 0.5 m and flags the cell.**

**Fail-safe.** If the provider is stale for more than 30 minutes, the engine falls back to
`h = min(0, last level)` with σ = 0.3 m, and publishes the reason. It never stays silent. The
last level is the provider's at its newest data; Baltic levels are often below chart datum,
and `h = 0` would then assume more water than was last observed.

**As built (M3).**

- `levelAt` is synchronous and answers from data the provider already holds; FMI refreshes
  itself every 10 minutes (configurable), when the vessel moves 10 km from the forecast
  point, and once the held forecast is 25 minutes old, retrying each minute until a fetch
  succeeds, so neither a 30-minute interval nor one failed request lets it go stale. The
  1 Hz loop never waits on the network.
- FMI stored queries, checked against `opendata.fmi.fi` on 2026-10-17:
  `fmi::forecast::sealevel::point::simple` (SeaLevel, SeaLevelN2000; centimetres, hourly
  for 48 h) and `fmi::observations::mareograph::instant::simple` (WATLEV,
  WLEVN2K_PT1S_INSTANT; millimetres) at the nearest of the 14 coastal gauges, used when it
  is within 60 km. The gauge's offset from the forecast decays with a 6 h time constant.
- σ defaults are not yet calibrated: gauge 0.03 m + 0.002 m/km to the gauge, forecast
  0.1 m, both + 0.02 m per hour of lead, capped at 0.5 m. Calibration against FMI history
  remains open.
- Datum table: VERDAT 3, 19 and 26 → theoretical mean water, σ 0.1 m for the epoch
  difference. N2000 has no VERDAT code, so cells on it are mapped in the configuration.
- A cell's datum is the DSID's (`DSPM_SDAT`, else `DSPM_VDAT`). `M_SDAT` / `M_VDAT` areas
  on another VERDAT make the whole cell unknown (σ 0.5 m); a datum per area is a follow-up.
- The engine applies one level per tick. When the index holds cells on different datums,
  it takes the lowest level and the widest σ among them, which can only raise P(UKC < 0).
  Per-cell levels are a follow-up.
- `signalk-tide` reads `heightNow`, `heightLow` and `timeLow`. `heightNow` applies for 5 min
  after the reading; after that the tide may be falling, so the lower of `heightNow` and
  `heightLow` applies until 6 h past `timeLow`, when the next flood has turned. Without
  `timeLow` that bound ends 6 h after the reading, since the low may be due at once. Without
  `heightLow`, or past the bound, there is no level and the engine falls back.
- Route checks take the lowest level over each leg's ETA interval at both of its ends, sampled
  every 10 minutes and at every FMI forecast point inside it. FMI answers only within 30 km of
  the point its forecast was fetched for, so a leg farther from the vessel gets the chart-datum
  fallback and is at best `unverified`. Applying the vessel's forecast to every leg took the
  level at Kemi (+0.62 m) for legs off Vaasa (+0.23 m) with no degraded flag. A fallback level
  makes every `ok` leg `unverified`.

### 4.6 Vessel model

Read from Signal K where available (`design.draft.maximum`, `design.beam`, `design.length`),
with plugin configuration overriding.

| Term               | Model                                                  | Notes                                                                                                          |
| ------------------ | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Static draft `T`   | config / `design.draft.maximum`                        | plus load allowance                                                                                            |
| Heel `Δh(φ)`       | user curve: table of heel° → draft change              | fin keel ≈ `T·(cos φ − 1)` (reduces draft); bilge/wing keels can _increase_ it; use `navigation.attitude.roll` |
| Squat `S`          | Barrass, open water: `S = Cb·V²/100` (V in kn, S in m) | ×2 when the check is inside a narrow-channel geofence or `FAIRWAY` width < k·beam; σ = 30 % of S               |
| Wave allowance `W` | `c·Hs`                                                 | Hs from `environment.water.waves.significantHeight` or weather provider; c ≈ 0.3–0.5 (config), σ = 50 % of W   |
| Transducer offset  | `environment.depth.transducerToKeel`                   | for the living chart                                                                                           |

Heel uses the range of absolute roll over the last 10 s: a fin keel takes the least roll, a
table its largest change over the range. Roll above 60° or stale is no roll, which gives a fin
keel no lift and a table its largest change.

### 4.7 Risk model (core math)

For a footprint `F` at time `t`:

```
d   = pyramid.minDepthOver(F ⊕ buffer(k_p · σ_pos(t)))       // charted, conservative
h   = waterLevel.levelAt(F.center, t)
UKC = d + h.h − T − Δh(φ) − S(V) − W
σ²  = σ_d² + h.σ² + σ_S² + σ_W² + σ_T²                        // independent terms
P   = Φ(−UKC / σ)                                            // P(UKC < 0)
```

- `σ_pos(t)` combines the following, root-sum-square:
  - the GNSS horizontal error, from `navigation.gnss.horizontalDilution` and fix type;
  - the integrity monitor's inflation (§4.8);
  - prediction spread that grows with look-ahead time.
- The chart's `σP` is added to the buffer per tile, `k_p·σP` of that tile's survey (§4.3),
  which is never narrower than taking it root-sum-square.
- `k_p` is 2 by default, and acts as the "how far off do I believe my position" knob.
- **Explanation object:** every result carries all terms, their sources, the worst cell's
  `cellRef` and its exact R-tree hazard (with LNAM), so the UI can render the breakdown
  sentence.

**Thresholds** (configurable, defaults chosen to be quiet in swept fairways):

| State    | Condition (within horizon)                                           |
| -------- | -------------------------------------------------------------------- |
| `normal` | P < 1 % everywhere in the fan                                        |
| `alert`  | P ≥ 1 % and TTS > 120 s                                              |
| `warn`   | P ≥ 5 % and TTS ≤ 120 s, or `NO_COVERAGE` ahead                      |
| `alarm`  | P ≥ 20 % and TTS ≤ 60 s, or deterministic UKC < 0 at P50 within 30 s |

**Hysteresis.** Raising a state needs 2 consecutive ticks. Lowering it needs 5 consecutive
ticks below the threshold minus 20 %, with P taken over the footprints inside the held state's
window (`alarmWithin` for `alarm`, `warnWithin` for `warn`, the whole horizon for `alert`).

### 4.8 Look-ahead engine (1 Hz)

**Inputs:**

- `navigation.position` and `navigation.courseOverGroundTrue`
- `navigation.speedOverGround` and `navigation.rateOfTurn`
- `navigation.headingTrue` and `navigation.attitude`
- `navigation.gnss.*`
- Water level and the vessel model

**Trajectory (CTRV fan).** The engine predicts M = 5 member tracks over a horizon
`H = max(60 s, D / SOG)`, where D is a configurable distance, default 0.3 NM.

- **Central member:** constant SOG and ROT.
- **The other four:** ROT ± σ_ROT and COG ± σ_COG.

Footprint at each step (Δt = 3 s) is a rectangle of hull length × beam, inflated by `σ_pos(t)`.
Δt shrinks at speed so that consecutive footprints, hull length plus the position buffer at
both ends, still touch: a fast boat must not skip a rock between two samples. A tick scores at
most 400 footprints: Δt grows toward that touching limit when the horizon would need more, and
the horizon is cut only past it. Configuration caps D at 5 NM and the minimum horizon at 600 s.

**Decision (step rule): coarser steps beyond the warn window.** Footprints are scored every Δt
out to `warnWithin` (120 s), the widest window `classify` and the hysteresis raise a state in.
Beyond it only every k-th Δt step is scored, with k the largest whole number for which k·Δt
still leaves consecutive footprints touching, (L + 2 · positionBuffer) / SOG; footprint length
and buffer only grow with t, so the union of the coarse footprints still covers the swept hull.
Where a coarse footprint is the first to reach the warn or alert level or a coverage gap, the
Δt steps it skipped are scored, so `timeToShoal` and the reason keep the Δt time. At 1 kn a
tick scores 57 footprints instead of 361. The escape fan scores the same coarse times, so a
heading's time to shoal beyond 120 s is known to k·Δt.

**Output per tick.**

- Min UKC μ and σ along the central member.
- Maximum P over all members.
- TTS: the first t at which P ≥ the warn threshold.
- Worst cell and worst hazard.
- The envelope GeoJSON, rebuilt only when it changes and versioned by `rev`.

**Escape fan** (only in alert, warn or alarm). Evaluate headings at ±5° steps out to ±90°,
using arcs limited by the boat's configured maximum turn rate. Publish the heading with the
greatest TTS, breaking ties by the smallest heading change. TTS counts from the first step
after t = 0, since the footprint under the vessel is common to all headings; when every heading
has the same TTS, or none is clear past the first step, publish null.

**Integrity monitor** (`model/integrity.ts`).

1. Run dead reckoning from heading, speed through water, and an estimated current. The
   current is learned as a low-pass of COG/SOG minus heading/STW during stable periods.
2. Compare the DR position with GNSS every tick.
3. If the divergence exceeds k·σ_DR, inflate σ_pos to the divergence and raise
   `notifications.navigation.positionIntegrity` (warn).
4. Also inflate σ_pos on lost fix, fix type below 3D, or HDOP above 4.

This is cheap, and it directly addresses Baltic jamming and spoofing, the same gap that
TimeZero 5.4's "Ghost Ship" now fills.

**Decision (buffer ceiling): k_p · σ_pos is capped at 500 m.** σ_pos has no upper bound: a
2 km GNSS jump made each footprint read the chart 4 km around it, 0.4 to 3.2 s per tick (x86)
in water without land. The buffer stops at `MAX_POSITION_BUFFER` (500 m). A tick whose
k_p · σ_pos exceeds it is at least `warn`, with the reason "position uncertainty N m" and the
integrity monitor's reasons, never `normal` or `alert`, since a shoal beyond 500 m may be under
the boat; `alarm` from the capped footprints stays `alarm`. The escape fan is not searched.

**Suppression rules.** None of these is ever silent; each publishes the reason it is
suppressing.

| Rule                  | Behaviour                                                      |
| --------------------- | -------------------------------------------------------------- |
| SOG < 0.5 kn          | Suppressed, unless already at P ≥ 20 % (drifting onto a rock). |
| Mooring zones         | User-drawn regions, for example the home berth.                |
| Acknowledged passages | §4.12.                                                         |

**As built (M4).**

- Each step is scored over the convex hull of the five members' hull footprints, one query per
  step. Scoring members one by one would leave the water between them unchecked; the hull is
  never less conservative than the members.
- A rate of turn, measured or ± σ_ROT (default 0.1°/s), is held for at most 60 s and the
  member then runs straight. At low speed the horizon reaches minutes, and a turn held that
  long sweeps the fan across water the boat is not steering for.
- σ_pos combines GNSS (HDOP × 3 m, 5 m without HDOP) and, from the integrity monitor, its
  inflation. The buffer is max(10 m, k_p · σ_pos). Speed error (σ_SOG 0.1 m/s) lengthens each
  footprint by k_p · σ_SOG · t fore and aft instead of widening it, since it moves the boat
  along its track. The chart's σP widens the buffer per tile by k_p·σP of the tile's own
  assessed survey (§4.3), on top of the burn around point hazards.
- The escape fan uses the maximum turn rate (default 3°/s) and stops at the first heading,
  smallest change first, that stays clear over the whole horizon. The monitor searches it at
  most every 3 s and holds the heading in between. The search runs after the tick's deltas are
  published (`setImmediate`), so the event loop is blocked in two shorter pieces, and its heading
  is published when it is found. After a tick or a search longer than 250 ms the next search is
  skipped, the heading is null, and the plugin status says so.
- Integrity: dead reckoning runs on each fix's own timestamp, so a GNSS feed slower than the
  1 Hz tick is not read as divergence. σ_DR = √(σ_anchor² + σ_GNSS² + (0.2 m/s · run)²);
  a consistent run re-anchors every 60 s; a diverged one is not re-anchored, and clears
  only when the growing σ_DR covers the offset. The current is learned with a 120 s low-pass
  while |ROT| < 0.01 rad/s. A fix whose `methodQuality` is not a satellite fix sets
  σ_pos ≥ 50 m. Without speed through water the check reports itself unavailable in the
  notification and in `/status`.
- Hysteresis applies between `normal`, `alert`, `warn` and `alarm`. `unknown` and `off` pass
  through at once, so stale input is never held as an earlier state. The risk state before
  them stays held: after the gap a lower state still needs the 5 lowering ticks, and a higher
  one is taken at once.
- A footprint stops reading the chart at the first charted land at P = 1: no later tile can
  change its depth, P or worst tile. Its flags then hold only the tiles read, so where the state
  turns on coverage (no warn or alarm from risk) such a footprint is read again in full, and a
  coverage gap next to land is still reported. Route checks always read every tile.
- Measured on the synthetic archipelago at leaf z20 (`npm run bench`, x86, plain Node):
  median 1.2 ms and p95 4 ms per tick, escape fan included. Under Jest the same run is about
  15× slower.

**Stale data.** If position is older than 10 s, the state becomes `UNKNOWN` and the plugin
raises a `notifications.navigation.underKeel` alert with the message "UKC monitoring
degraded: position stale". It never reports `normal` on stale input.

### 4.9 Optional: actual-grounding detector

The plugin raises `notifications.grounding` as an emergency when all of the following hold:

- SOG drops by more than 70 % in under 5 s;
- there is no engine-reverse or gear-change event (the servo gear shifter's state is a
  useful input here);
- measured depth is within 0.3 m of draft, or a P ≥ 80 % cell is under the boat;
- an IMU deceleration spike is present.

Off by default. This is the only code path that touches the standard emergency alarm.

**As built (M4).** SOG must fall by more than 70 % within 5 s from at least 0.5 m/s; a
`propulsion.*.transmission.gear` change in the last 10 s vetoes it. Signal K has no standard
IMU path, so the deceleration condition is tested only when `imuPath` is configured. Once
fired, the notification holds until SOG stays above 0.5 m/s for 10 s.

### 4.10 Signal K data model and REST API

**Deltas.** These are published by the plugin, use plugin-scoped units in SI, and are
proposed for the Signal K spec later. `state` and `envelopeRev` go out every tick; the other
values when they change and at least every 10 s, and the plugin status when its text changes.
`notifications.navigation.underKeel` goes out at once on a new state, kind of reason or named
hazard, and with only its countdown or terms changed at most every 30 s.

| Path                                         | Unit         | Meaning                                                |
| -------------------------------------------- | ------------ | ------------------------------------------------------ |
| `navigation.underKeel.state`                 | enum         | `normal \| alert \| warn \| alarm \| unknown \| off`   |
| `navigation.underKeel.clearance`             | m            | predicted min UKC (μ) over horizon                     |
| `navigation.underKeel.clearanceSigma`        | m            | σ of the above                                         |
| `navigation.underKeel.risk`                  | ratio        | max P(UKC < 0) over horizon                            |
| `navigation.underKeel.timeToShoal`           | s            | null if none in horizon                                |
| `navigation.underKeel.escapeHeading`         | rad          | true heading, null when normal or no heading is better |
| `navigation.underKeel.envelopeRev`           | int          | bump → client fetches `/envelope`                      |
| `navigation.underKeel.waterLevel`            | m            | applied level above chart datum                        |
| `notifications.navigation.underKeel`         | notification | state + message + `data.explanation`                   |
| `notifications.navigation.positionIntegrity` | notification | GNSS/DR divergence                                     |

This follows the "lightweight signal, then fetch the snapshot" pattern from the Plotter
Extensions route API (`route.dirty` → `route.get`). Deltas stay small, and the GeoJSON is
pulled only on change.

**REST, base `/plugins/signalk-underkeel/v1`:**

| Method          | Path                         | Purpose                                                                             |
| --------------- | ---------------------------- | ----------------------------------------------------------------------------------- |
| GET             | `/status`                    | index coverage, cell editions, water-level health, engine state                     |
| GET             | `/envelope?rev=`             | look-ahead FeatureCollection (fan, footprints coloured by P, hazards, escape arrow) |
| POST            | `/route-check`               | per-leg result (§4.11)                                                              |
| POST            | `/route-repair`              | suggested geometry for failing legs                                                 |
| POST            | `/departure-window`          | safe departure intervals over a horizon                                             |
| POST            | `/query`                     | point or polygon UKC with explanation (cursor readout, popovers)                    |
| GET             | `/tiles/ukc/{z}/{x}/{y}.pbf` | vector tiles: cells classed by P at current water level and draft                   |
| GET             | `/tiles/ukc/changes`         | the served tiles to fetch again since a cursor (§4.14)                              |
| GET/PUT         | `/vessel`                    | vessel model                                                                        |
| GET/POST/DELETE | `/acks`                      | acknowledged passages                                                               |
| GET             | `/livechart/discrepancies`   | suspected shoals                                                                    |
| GET             | `/livechart/csb.geojson`     | IHO CSB export                                                                      |

All writes go through Signal K's normal authentication: the security strategy and an
admin or readwrite token.

### 4.11 Route check, repair and departure window

**`POST /route-check`, request:**

```jsonc
{
  "route": {
    "type": "LineString",
    "coordinates": [
      [22.1, 60.2],
      [22.2, 60.25]
    ]
  },
  "routeRef": "/resources/routes/<id>", // optional alternative to geometry
  "departure": "2026-10-18T07:00:00Z", // optional; default now; within a year of now
  "speed": { "default": 3.1 }, // m/s, or per-leg array
  "xteLimit": 30, // m; default from course settings
  "probability": 0.01, // accept threshold
  "vessel": { "draft": 1.9 } // optional override (e.g. lifting keel up)
}
```

**Algorithm per leg:**

1. Build the corridor `buffer(leg, xteLimit + k_p·σ_pos_plan)`, where `σ_pos_plan` uses a
   typical GNSS σ rather than the live value.
2. Compute the arrival time at the start and end of the leg; take the water level at the
   worst instant in that interval, since the forecast is evaluated on a 15-minute grid.
3. Query the pyramid to get the worst cells, then refine them against the R-tree hazards.
4. Classify the leg as one of:
   - `ok` — P below the threshold;
   - `marginal` — P between 1× and 5× the threshold;
   - `fail` — worse than that;
   - `unverified` — the corridor touches `NO_COVERAGE` or `UNASSESSED`.

   `unverified` is shown in its own colour and is never folded into `ok`.

**Response:**

```jsonc
{
  "checkedAt": "…",
  "charts": [{ "cell": "FI5ABCDE", "edition": 12, "update": 3 }],
  "waterLevelSource": "fmi:composite",
  "legs": [
    { "index": 0, "status": "ok", "minUkc": 1.42, "sigma": 0.21, "risk": 0.0001 },
    {
      "index": 1,
      "status": "fail",
      "minUkc": -0.3,
      "sigma": 0.55,
      "risk": 0.71,
      "worst": {
        "position": [22.15, 60.22],
        "hazard": { "class": "UWTROC", "lnam": "…", "valsou": 1.6 }
      },
      "explanation": {
        "charted": 1.6,
        "catzoc": "C",
        "waterLevel": -0.21,
        "draft": 1.9,
        "squat": 0.06,
        "wave": 0.12
      }
    }
  ]
}
```

**Repair** (`/route-repair`). For each failing leg:

1. Build a local cost grid around the leg, at the zoom that fits the bounding box with a
   margin. Cost is infinite where P is at or above the threshold, and otherwise
   `1 + α·P/threshold`, so the path keeps away from the margin.
2. Run **Theta\*** (any-angle A\*) from the leg's start point to its end point.
3. Simplify with Douglas–Peucker, rejecting any simplification that makes a leg fail.
4. Return the inserted waypoints only. Existing points are never moved without consent.

The result is a **suggestion**. Freeboard applies it as a dirty draft, and the user decides
whether to save.

**Departure window.** Step the departure time every 15 minutes over the next 48 hours (or
the full forecast horizon), re-checking only the legs whose water level changed. Return the
intervals in which every leg passes. In Finnish waters this matters during low-water episodes
with high pressure and easterly winds; in tidal waters it becomes a full tide-gate planner.

**As built (M2).** A leg is checked in pieces of about max(1 km, 4r), r the corridor half-width,
taken at equal fractions of the rhumb line, the line a Mercator chart plotter draws between the
waypoints, so the corridor follows the leg as drawn and the last piece ends on its end point.
Each piece's rectangle reaches r past both ends, so 1 km pieces of a ±2 km corridor queried the
same water about five times. A course computer may steer the great circle instead: where the
great circle strays more than max(10 m, r/4) from the rhumb line, its own pieces are checked
too, widened by how far it strays from their chords; below that the rhumb corridor is widened
by the gap. Every rectangle is 1/256 wider than asked, since the Mercator chart and the tangent
plane the rectangle is drawn in drift apart over a piece (up to 0.15 % of r, measured to 84°);
a fast-check property holds every point exactly r from either line inside the corridor
(invariant 4).

**As built (M5).** The repair grid has at most 120 cells on its longer side, at least 10 m
each, and reaches half the leg's length (at least 300 m) beyond it. A cell is blocked when the
corridor around it has P at or above the accept threshold, or touches `NO_COVERAGE`,
`UNASSESSED` or `NO_DEPTH`: a repair must not route through water it cannot check. Costs are
evaluated lazily as Theta* expands. Simplification replaces a span with its chord whenever the
chord passes the corridor check, so no simplification makes a leg fail; a path that still fails
is reported with a reason and no waypoints. Legs are repaired in route order, each checked at
the arrival time the detours before it give, and the response's `route` is the whole route with
every suggested waypoint inserted, checked again. Both `/route-repair` and `/departure-window` take
the `/route-check` body; the window adds `horizon` (default 48 h, at most 7 days) and `step`
(default 15 min, at least 5 min, at most 1000 departures). Each leg takes the lowest level from
its arrival until one step after it leaves, so a sampled `ok` departure also holds for every
departure until the next sample and a coarse step cannot skip a low water. Leg results are reused across
departures for the same water level rounded down to the centimetre (σ rounded up), and a
departure's legs after its first `fail` are not checked, since `fail` already decides its status.
Decision (invariant 2): with `probability` at least 1e-3, a leg's result is also reused across
levels with the same σ and fallback reason: `ok` at a level holds at any higher level and `fail`
at any lower one. A query may stop at a tile whose P bound is below 1e-4 (`RISK_STOP_BELOW`), so
a direct check can overstate P by up to that much; from 1e-3 up the reused status is the one a
direct check gives, and below it every level is checked directly. One request
repairs at most 10 legs, and the rest are listed with a reason. A corridor query costs about
its area, so a route check, repair or window is refused when the route's length times its
corridor width (2 × (xteLimit + planning buffer)) exceeds 200 km², and a window when its
departures times that area exceed 1600 km² or its departures times legs exceed 20 000, since a
leg check costs a corridor query however short the leg is. All three yield to the event loop
after each corridor query (the route check and the repaired route's re-check), each leg check
or each departure, and route repair also every 256 cells its search expands and after each
simplification check, so look-ahead ticks keep running during a long request. They and
`POST /query` run through one queue after validation: one at a time, at most 4 waiting, and 503
with `Retry-After: 2` beyond that, so concurrent requests do not interleave their slices. A
request is aborted at its next pause when its client disconnects or the plugin stops, and
answers 503 with the reason, never a partial result. On a laptop a
corridor over 3000 shoals costs 1–3.5 ms per km². `POST /query` is refused when its bounding
box widened by the buffer exceeds 25 km², or when its vertices times that area exceed 150 km²:
every tile is tested against every vertex, and a 499-vertex ring over 25 km² took 0.47 s on a
laptop over the Nauvo cells, against at most 16 ms within both limits. Measured under Jest on the synthetic archipelago: 52 ms per
repaired leg.

### 4.12 Acknowledged passages

On acknowledge, Freeboard POSTs to `/acks` with:

- the notification id;
- the current footprint polygon;
- the heading sector (±20°);
- the water level `h_ack` and draft `T_ack`;
- an optional expiry.

**Later warnings are suppressed when all of these hold:**

- the footprint lies inside the acknowledged polygon;
- the heading is inside the sector;
- the current water level is at least `h_ack − 0.05` and is not a fallback (a fallback level
  neither honours nor records an acknowledgement);
- the current draft is no deeper than `T_ack`.

Suppression is published as `state: alert` with the message "acknowledged passage". It is
never `normal`.

Acknowledgements are kept per vessel and exported as Signal K **notes**, so they appear on
the chart and can be deleted there.

**As built (M4).** `POST /acks` takes an optional GeoJSON Polygon (default: the hull of the
current look-ahead footprints), checked like a `/query` polygon: a closed ring, no holes, at
most 50 km across and not across ±180°; `sector` in degrees (default 20), `ttl` in seconds and
`notificationId`; heading, water level and draft are taken from the plugin's current state.
`GET /acks` is readonly; `POST` and `DELETE /acks/:id` need readwrite. They are stored in
`acks.json` in the plugin data directory, so no database dependency is added; each write
goes to a temporary file that is fsynced before the rename, with the directory fsynced after
it, so a power cut leaves the old list or the new one. Export as
Signal K notes is a follow-up. Suppression applies to the published state after hysteresis,
because it changes the state, not P. It never suppresses a negative mean UKC within
`certainWithin`: an acknowledgement covers an uncertain chart, not a charted depth shallower
than the keel. Mooring zones are Signal K `regions` resources named in the configuration and
suppress the same way, with the zone's name in the reason.

### 4.13 Living chart

**Inputs.** Any of these, configured per source:

- `environment.depth.belowTransducer`;
- `environment.depth.belowSurface`;
- the Wi-Fish sonar depth output.

**Each sample goes through these steps:**

1. **Quality gate.** Keep the sample only if fix type is 3D, HDOP < 2, the depth is valid,
   and |roll| < 15°.
2. **Datum reduction.** `z_datum = depth_belowSurface − waterLevel(t)`, using the
   observation, not the forecast.
3. **Position correction.** Correct for transducer lever arm and heading.
4. **Cell update.** Update the z18 cell's running posterior:
   - Normal–Normal conjugate update;
   - the prior comes from the chart (`dMin`, `sigmaD`);
   - measurement σ = 0.1 m + 1 % of depth + water-level σ.
5. **Discrepancy check.**
   - **Trigger:** after at least N = 5 samples, on at least 2 separate passes, the posterior
     mean is shallower than charted `dMin` by more than 2σ.
   - **Action:** create the note `/resources/notes/underkeel-shoal-<quadkey>` with the
     evidence.
   - **Effect on the model:** the cell gains the `LIVECHART_ADJUSTED` flag and its
     `dMin` is lowered (never raised).
6. **Export.** Optional IHO CSB GeoJSON, with a vessel identifier and sensor metadata. The
   user decides whether to submit it; nothing is uploaded automatically.

**As built (M5).** The living chart is off by default and reads one depth path
(`belowSurface`, or `belowTransducer` plus the configured transducer depth). The gate needs a
known HDOP below 2, a satellite `methodQuality`, |roll| < 15°, a depth of 0.3–200 m, a
position measured within 2 s of the depth and a water level that is not a fallback. Cells are the pyramid's z18 tiles (z = leaf zoom when the
leaf is coarser); the prior is the cell's charted depth and σD without adjustments, and a pass
starts after a 10-minute gap. A confirmed discrepancy sets a z18 adjustment that every query
takes beside the chart, through `minDepthOver` and the UKC tiles, so look-ahead, route check,
`/query` and the overlay all see it. Adjustments only ever lower a cell; later deeper
readings leave it as it is. Notes are written with `resourcesApi.setResource("notes", …)`.
A note is rewritten when the cell's adjusted depth drops to a lower 5 cm step or its σ rises
to a higher 1 cm step, at most once per cell every 5 minutes: a change inside the 5 minutes is
written with the latest values once they are over, and on stop. The note shows the depth
floored to 5 cm and σ raised to the next cm, so it never shows the cell deeper or surer than
the posterior; the adjustment itself keeps the exact values. Posteriors and adjustments are kept
in `livechart.json` beside the index and the last 20 000 accepted soundings in
`soundings.ndjson` (no database dependency). Decision (user, PL1): the save schedule is no
longer "at most once a minute" for one file holding everything, which rewrote 3.2 MB per save
once the soundings filled, 192 MB/h of SD-card writes. Soundings are appended to
`soundings.ndjson`, one per line, every minute; once the file would hold more than 40 000 lines
it is rewritten with the newest 20 000. `livechart.json` (cells and adjustments) is written
every 10 minutes, and within 10 s of an adjustment being added or moving a 5 cm depth or 1 cm σ
step; everything is written on stop. The saves run on a 10 s timer, not in the depth-delta
callback. A power cut can lose up to 10 minutes of posterior evidence that is not yet a
discrepancy and up to 1 minute of soundings, and an adjustment's lowering within its 5 cm step,
never an adjustment added or moved a step more than 10 s before. Each write is fsynced, file
then directory. A `livechart.json` from a version that kept the soundings in it still loads; its
soundings move to `soundings.ndjson` at the next save. A failed save is reported and retried at
the next scheduled one, and a malformed file is skipped entry by entry rather than stopping the
plugin; a file that did not load whole (bad JSON, another version, malformed entries, cells at
another zoom, malformed `soundings.ndjson` lines) is first renamed to `<name>.bad-<ms>` and
reported, so no save overwrites it, and if it cannot be renamed it is not saved over at all. A
last `soundings.ndjson` line cut short by a power cut is skipped and reported, and the file is
rewritten whole at the next save. `livechart.json` records its living-chart zoom; after a leaf-zoom
change the adjustments are mapped onto the new zoom (a coarser cell takes the lowest `dMin` and largest
σ of the cells in it, a finer cell copies its parent's) and the posteriors are dropped. The CSB export
(`GET /livechart/csb.geojson`) is B-12 GeoJSON of depths below the transducer, with the
transducer depth as the sounder's `draft`; it is never uploaded.

**Rule:** own soundings may make the chart _shallower_. They make it _deeper_ only after the
user confirms, per cell group, in the UI. A faulty transducer must never be able to switch
off a hazard.

### 4.14 Plotter Extensions manifest contribution

The plugin contributes a `plotterExtensions` resource. Two parts of it already exist in the
API:

- an **`overlays.data`** layer for the UKC heat tiles, which needs nothing new in Freeboard;
- a **config panel** (iframe) for vessel model, water-level source and thresholds.

The plugin also declares the **new `services` section** described in §5.1.

```jsonc
{
  "signalk-underkeel": {
    "name": "Under-Keel Awareness",
    "version": "0.1.0",
    "apiVersion": "1",
    "requires": [],
    "optional": ["overlays.data", "panels.iframe", "x-freeboard.services.navigationSafety"],
    "panels": [
      {
        "id": "settings",
        "title": "Under-Keel Settings",
        "type": "iframe",
        "url": "/plotterext/signalk-underkeel/settings.html",
        "lifecycle": "onOpen"
      }
    ],
    "overlays": [
      {
        "id": "ukc",
        "title": "Under-keel risk",
        "type": "data",
        "band": "aboveCharts",
        "visible": false,
        "opacity": 0.6,
        "minZoom": 11,
        "configPanel": "settings",
        "style": "/plotterext/signalk-underkeel/ukc-style.json"
      }
    ],
    "services": {
      "navigationSafety": {
        "apiVersion": "1",
        "base": "/plugins/signalk-underkeel/v1",
        "provides": ["lookahead", "routeCheck", "routeRepair", "departureWindow", "query", "acks"],
        "statePath": "navigation.underKeel",
        "notificationPath": "notifications.navigation.underKeel"
      }
    }
  }
}
```

**As built (M3).** The overlay's `style` points at `/plugins/signalk-underkeel/v1/ukc-style.json`,
which the plugin serves; the `/plotterext/...` paths above are placeholders until the settings
panel exists. Tiles below zoom 11 are empty. Each tile is drawn from at most 64 × 64 pyramid
cells; a cell coarser than that is classed by its bound (shallowest depth, widest σ), so the
overlay never shows water safer than any point in it. A fallback water level draws no cell as
`clear`.

**As built (Phase 10).** The manifest declares the UI of the Phase 10 decision (§1). Its pages
are served from `public/` at `/plotterext/signalk-underkeel/`: the `/plugins/*` paths need an
admin login, and an extension page must load without one. The bus client is copied from
`signalk-plotterext-bus` into `public/vendor/` at build time.

| Contribution                       | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| background `live` (runtime.html)   | fetches `/envelope` on each new `envelopeRev`, clears it after 10 s without one, on `off`/`unknown` or a failed fetch, and polls every 3 s without a Signal K stream; checks the routes on the chart on each `route.*` event (debounced 1 s), every 60 s and after a plugin restart, one route at a time with a 30 s timeout and again after `Retry-After` when the server answers 503 busy, and writes the results to host state in compact form (per leg index, status, minimum UKC and P) once per re-check of all routes; refreshes the `ukc` tiles the plugin's change list names, polled every 15 s and after each 1 cm water-level move, all of them when the state enters or leaves `off`/`unknown` and after a restart, and while the list does not answer all of them on a 1 cm fall or 10 cm rise of the water level or a change of its source; fetches nothing while the page is hidden, and on return withdraws the envelope until a current one arrives and asks for tile changes and route checks at once |
| overlay `lookahead`                | envelope fill, outline, dashed central track and the worst footprint, coloured by state                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| overlay `routecheck`               | route legs coloured `ok` / `marginal` / `fail` / `unverified`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| overlay `ukc`                      | the M3 UKC tiles, off by default                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| widget `status` (2×1)              | state colour, minimum clearance in the host's depth unit, time to shoal and the reason; a tap opens the panel                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| panel `details`                    | advisory note, state, water level, the WFS notice when that source is on, and a leg table per route with its age and re-check; a result older than 3 min reads "out of date"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| button `open-details` (mapToolbar) | toggles the panel                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

`requires` is empty: on a host without a capability, the page that needs it shows less and
says so.

**UKC tile refresh.** A tile's classes hold over a range of the threshold depth: each cell's
class changes only where P crosses the alert or warn level, and P rises with the threshold
(invariant 2). The tile route records, per tile served, the range over which every copy
served is right (to 1 µm short of each crossing). `GET /tiles/ukc/changes?epoch=&rev=` lists
the tiles whose range the current threshold has left, or in which an own sounding changed a
cell, since the client's cursor; any other tile input (σ, risk levels, a fallback water
level, the index) changing, a restarted server or a cursor older than the 4096 tiles kept
answers `all`. The runtime refreshes exactly those tiles. A tile left unlisted is byte for
byte the tile the server draws now (`__tests__/ukc-tile-feed.test.ts`).

**UKC tile geometry cache.** The cells of a tile and the reach-grid slots each reaching cell
covers do not depend on the water level, draft or σ, so the tile route keeps them per tile in
typed arrays (`UkcTileCache`, least recently used first out beyond 8 MiB) and a request only
classes the tile's value kinds and draws. The cache holds for one `NodeStore`: another store
(a handover or a WFS rebuild) empties it. Every write to `NodeStore.adjustments` bumps its
`revision` in the same call; an entry whose revision is behind compares the living-chart
cells in its tile with those it was walked with and is walked again when they differ, so a
cached tile never shows water deeper than an own sounding (invariant 5). Cached and uncached
tiles equal the walk they replaced byte for byte (`__tests__/engine/ukc-tile-cache.test.ts`).

**Decision (BR3a, approved).** When the change list does not answer, the runtime refreshes
every tile on a 1 cm fall of the water level but only on a 10 cm rise. A tile kept stale by a
rise was drawn for lower water, so it shows equal or more danger than the truth.

---

## 5. Freeboard-SK core

Not started. The Phase 10 decision (§1) put the UI in the plugin first.

### 5.1 The provider-neutral contract (`x-freeboard.services.navigationSafety`)

This is a new idea for the Plotter Extensions API: **service contributions**. Every existing
section (`widgets`, `panels`, `overlays`) runs extension UI. A service contribution goes the
other way: it declares an **HTTP contract that the host calls itself**, so the host can build
native UX on top of it.

- **Experimental first.** It ships under the vendor prefix (`x-freeboard.…`), as the API doc
  allows.
- **Then upstream.** It is proposed for extension API v2 once a second provider exists, for
  example an OpenCPN-derived checker or a commercial provider.
- **What the host needs.** Freeboard depends on the _contract_ only. Any plugin that
  implements `/route-check` with the response schema in §4.11 lights up the same UI.
- **Selecting a provider.** If several providers are present, the user picks one in
  Settings, with the first provider found as the default.

The contract schemas (request/response JSON Schema) live in a small shared package,
`@signalk/navigation-safety-schema`, consumed by both sides. Contract tests run in both
repositories.

**As built (M6).** The schemas live in `schemas/navigation-safety/` as a private package
until the contract is accepted upstream. `__tests__/contract/` validates this plugin's
responses and a stub second provider's against them with a validator that refuses any
keyword it does not implement. The RFC drafts are in `docs/rfcs/`; opening them upstream is
the maintainers' step.

### 5.2 New module layout

```
src/app/modules/navsafety/
├── index.ts
├── navsafety.service.ts          # provider discovery from plotterExtensions, stream subs,
│                                 # envelope fetch on envelopeRev, REST client, health
├── navsafety.facade.ts           # signals for components (state, ukc, tts, explanation)
├── route-check.service.ts        # debounce + cancel; caches results keyed by route rev
├── components/
│   ├── ukc-status.component.ts   # status-bar readout (UKC ± σ, TTS) — like cursor-eta
│   ├── explanation.component.ts  # breakdown sentence + bar of terms
│   ├── route-check-panel.ts      # per-leg table, "Suggest fix", departure window
│   └── no-provider-hint.ts       # shown once if contract absent
src/app/modules/map/ol/lib/navsafety/
├── envelope-layer.component.ts   # fan, footprints (colour by P), hazard markers, escape arrow
├── leg-style.ts                  # style function for route legs by check status
└── hazard-popover.component.ts   # S-57 hazard + explanation (reuse s57-popover parts)
```

### 5.3 Integration points in existing code

| Existing file / area                                          | Change                                                                                                                                                                               |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `alarms/notification-manager.ts`                              | add `notifications.navigation.underKeel` and `…positionIntegrity` beside `closestApproach`; route to new popover; ack → `POST /acks`                                                 |
| `skstream/stream-api.ts`                                      | subscribe `navigation.underKeel.*` when provider present                                                                                                                             |
| `map/fb-map.component.*`                                      | add envelope layer; layer order: envelope `aboveCharts` under resources; alarm hazard highlight above AIS, same band as collision alarm display; extend `fb-map.layer-order.spec.ts` |
| `map/route-modify-leg.ts`, `route-extend.ts`, Modify flow     | on geometry change → `route-check.service` (debounced 250 ms, abort previous); colour legs via `leg-style.ts` while editing                                                          |
| `plotterext/route-methods.ts`                                 | apply repair suggestion via the same path as `route.replace` (draft becomes dirty, user saves)                                                                                       |
| `modules/course` (route following)                            | on route activation → full check at ETA; re-check when `waterLevel` forecast changes by > 5 cm                                                                                       |
| `modules/autopilot`                                           | in warn/alarm with escape heading → show one-tap "Dodge to 075°"; never auto-engage                                                                                                  |
| `settings/settings.facade.ts`                                 | `safetyDepth` / `shallowDepth` / `deepDepth`: when a provider is present, offer "Use server vessel model", deriving S-57 colouring from draft + margin so colouring and alarms agree |
| `modules/experiments`                                         | gate the whole feature behind an experiment flag for 3.5.x                                                                                                                           |
| `features/under-keel-awareness.md`, `features/changelog.json` | Feature Browser entry with screenshots, following repo conventions                                                                                                                   |
| `package.json` `signalk.recommends`                           | add `signalk-underkeel`                                                                                                                                                              |

### 5.4 UX specification

**Envelope layer.**

- The predicted fan is shown as thin translucent lines.
- Footprints are coloured green, amber or red by P.
- The worst hazard pulses.
- The escape heading is a green chevron from the bow.
- It is visible in `alert` and above; in `normal` it hides, unless the user pins it in
  Settings.

**Status bar.** Reads `UKC 1.4 m ±0.2 · TTS —`. In warn, it turns amber and shows
`TTS 84 s`.

**Alarm popover.**

1. A headline, for example "Shoal ahead in 84 s".
2. The breakdown sentence (§2.1), with a horizontal stacked bar showing which term dominates.
3. Buttons: **Acknowledge passage**, **Dodge to 075°** (only if an autopilot is present),
   **Show on chart**.

**Route editor.**

- Legs are coloured live while dragging: green, amber, red, and a grey-hatched style for
  _unverified_.
- Tapping a red leg opens the hazard with its explanation.
- The **Suggest fix** button shows the repair as a dashed ghost route, with Accept and
  Dismiss.
- The **Departure window** strip appears above the route info, as a timeline of passable
  intervals.

**Cursor readout.** This extends the existing cursor bearing/distance/ETA readout with
"UKC at cursor 0.8 m (P 3 %)", using `/query` with a 200 ms debounce. Touch devices are
supported, as cursor-eta already is.

**Split view.** The second pane can permanently show the look-ahead zoomed to the horizon,
which is a natural use for the feature merged today.

**Night mode.** All colours come from the theme tokens, respecting `nightMode` and its red
palette.

### 5.5 Failure presentation, so it is never silently off

| Condition                                   | Freeboard shows                                                                                    |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| No provider installed                       | one-time hint in Settings → Navigation with install link                                           |
| Provider present, `state: off` or `unknown` | grey "UKC monitoring off: <reason>" chip in status bar, always visible while underway (SOG > 1 kn) |
| Envelope fetch fails 3×                     | chip turns amber "UKC data stale"                                                                  |
| Route check unavailable                     | legs uncoloured + banner "Not checked", never green                                                |

---

## 6. Performance budgets

| Operation                       | Budget (Pi 4)      | Notes                                       |
| ------------------------------- | ------------------ | ------------------------------------------- |
| Look-ahead tick                 | < 20 ms            | 5 members × ~40 footprints; pyramid culling |
| Envelope payload                | < 15 kB            | quantised coordinates, only on `rev` change |
| Route check, 30 legs            | < 300 ms           | parallel legs in worker                     |
| Interactive leg re-check        | < 80 ms p95        | only the edited legs; abort on new input    |
| Repair, one leg                 | < 1.5 s            | bounded window                              |
| Index build, full Finnish coast | < 15 min, one-time | worker thread; incremental on ENC updates   |
| Index RAM                       | < 150 MB           | mmap'd pyramid levels                       |

---

## 7. Testing and validation

**Unit and property tests (plugin: Jest + fast-check; Freeboard: vitest, per its repo).**

- Pyramid conservativeness invariant (§4.3).
- Monotonicity checks: deeper draft never lowers P; a lower water level never lowers P;
  a larger σ_pos never lowers P.
- CTRV trajectory against analytical arcs.
- Datum reduction tables.

**Synthetic ENC fixtures.** Generated cells covering these cases:

- a rock inside a swept fairway (must alarm);
- a CATZOC C bank;
- a coverage gap;
- overlapping usage bands.

**Replay.**

- Recorded Signal K delta logs from Arabella's passages are replayed through the plugin at
  10× speed, and the alarms are compared against annotated known shoals.
- Golden files of alarm timelines.
- **Target:** zero missed alarms on annotated hazards. False-positive rate is tracked per
  hour underway, with < 1 alert per hour inside swept fairways.

**Water-level tests.** A mocked FMI provider covers a stale feed, a datum mismatch, and
forecast lead-time σ growth.

**Contract tests.** The shared schema package is used to validate the plugin's responses and
Freeboard's parser in CI in both repositories.

**Freeboard tests.** Spec files follow repository conventions, for example
`fb-map.navsafety-layer.spec.ts`, `notification-manager.underkeel.spec.ts` and
`route-check.service.spec.ts`. They cover debounce and abort, the "never green when
unchecked" rule, and layer order.

**Field trial.** Arabella over one season, with a shadow mode at first: the plugin logs
alarms but raises no notifications. Promote to active alerts after the false-positive review.

---

## 8. Milestones

| M                              | Scope                                                                                                                                                                                                             | Exit criteria                                                              |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **M0 Spike** (1–2 wk)          | ingest one Finnish ENC cell via GDAL container; build pyramid; benchmark queries; confirm FMI stored queries + datum mapping                                                                                      | query < 1 ms per footprint on Pi 4; datum table documented                 |
| **M1 Deterministic MVP**       | plugin: straight-line cone, deterministic UKC (draft + fixed margin), `notifications.navigation.underKeel`, `/status`, `/envelope`; Freeboard: notification path, envelope layer, status chip, behind Experiments | replay passes zero-miss on fixtures                                        |
| **M2 Route check**             | corridor check, `/route-check`, Freeboard leg colouring live in editor, route-activation check                                                                                                                    | interactive p95 < 80 ms                                                    |
| **M3 Probabilistic**           | CATZOC/SWPARE σ, water level (manual/tide/FMI), squat/heel/wave, explanation object + popover breakdown, UKC heat data overlay                                                                                    | explanation renders for every alarm; monotonicity tests green              |
| **M4 Dynamics**                | CTRV fan, TTS, escape fan + dodge action, integrity monitor, hysteresis, acknowledged passages                                                                                                                    | false positives < 1/h in swept fairways on replay                          |
| **M5 Living chart + planning** | soundings ingest (incl. Wi-Fish), posterior, suspected-shoal notes, CSB export, `/route-repair`, `/departure-window`                                                                                              | discrepancy detected on synthetic shoal after 2 passes                     |
| **M6 Upstream**                | propose `navigation.underKeel.*` + notification to Signal K spec; propose `services` section for Plotter Extensions API v2; publish schema package                                                                | RFCs opened; second provider prototype (even a stub) passes contract tests |

---

## 9. Safety, liability and data licensing

**Advisory only.** Show "Not for navigation; does not replace official charts" in:

- the plugin's About text;
- the Settings section;
- the first-run hint.

**Never silent.** Every degraded state is visible (§5.5). The rule "never green when
unchecked" is tested in CI.

**No automatic actuation.** Course changes go only through an explicit, one-tap user action
on the autopilot.

**Own soundings can only add caution without confirmation** (§4.13).

**Data licences.** Traficom open data is CC BY 4.0, so attribution must appear in the overlay
and in the About text. ENC licence terms must be checked per source. Only unencrypted ENCs are
supported; S-63 is out of scope, matching Freeboard's current stance.

**Chart edition provenance.** Every result carries the edition and update, so users can tell
when a check was made against out-of-date cells.

**CRA angle.** Under the EU Cyber Resilience Act this is a product with digital elements once
it is distributed. Needed from the start:

- an SBOM;
- a vulnerability disclosure contact;
- signed releases;
- authenticated write endpoints only.

---

## 10. Open questions

1. Can the plugin read `signalk-charts-provider-simple`'s stored `.000` files directly, or is
   a small "export source cells" API needed from that plugin? Coordinate with its author.
2. What are the exact FMI WFS stored-query ids and station metadata for sea level? Does FMI
   publish forecast error statistics, or must we calibrate σ ourselves?
3. Finnish ENC vertical datum coding during the N2000 transition: is `M_VDAT` reliable
   per cell?
4. Should the envelope go over the WebSocket as a structured delta value instead of REST
   fetch-on-rev? Measure on a slow boat Wi-Fi link.
5. Is the `services` contribution better upstreamed as a Signal K **server API**, like the
   Course and Radar APIs (e.g. `/signalk/v2/api/navigation/safety`), than as a Plotter
   Extensions section? A server API would let KIP and others use it without the extension
   host. **Current leaning: start as a Plotter Extensions service for speed, migrate to a
   server API at M6.**
6. Heel-to-draft curves for common keel types: ship presets, or require user entry?

---

## 11. First tasks (ready to open as issues)

**Plugin**

- [ ] `signalk-underkeel`: scaffold the plugin and JSON-schema config. `/status` returns the
      engine state `off`.
- [ ] GDAL container job: `.000` → FlatGeobuf, with `cells.json` provenance.
- [ ] `pyramid.ts`: build and query, with the fast-check conservativeness property test.
- [ ] `lookahead.ts`: a straight cone with a deterministic margin; publish the
      `navigation.underKeel.*` deltas and the notification.
- [ ] `/envelope` GeoJSON, plus the `envelopeRev` delta.
- [ ] `plotterExtensions` manifest with the `services.navigationSafety` stub.

**Freeboard**

- [ ] `modules/navsafety`: provider discovery from manifests, behind the Experiments flag.
- [ ] `notification-manager.ts`: handle `notifications.navigation.underKeel`, with a spec.
- [ ] `envelope-layer.component.ts`, with a layer-order spec.
- [ ] Status chip, including the never-silent states.

**Shared**

- [ ] Draft `@signalk/navigation-safety-schema` v0 covering `route-check` and `envelope`.
