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
│  │ Ingest (gdal3.js, in the index worker) → cells read in place     │  │
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
│   │   ├── enc-wasm.ts           # .000 + updates read in place with gdal3.js
│   │   ├── open-data-reader.ts   # Traficom/SYKE open vector depth (GeoPackage/WFS)
│   │   ├── coverage.ts           # best-scale mosaic: usage band selection, overlaps
│   │   └── datum.ts              # vertical datum per cell (M_VDAT / M_SDAT, VERDAT)
│   ├── spatial/
│   │   ├── pyramid.ts            # min-depth pyramid build + query
│   │   ├── hazards.ts            # flatbush R-tree of point/line hazards
│   │   ├── quality.ts            # CATZOC / M_QUAL / SWPARE → σ_depth, σ_pos
│   │   └── store.ts              # on-disk format, blocks, versioning
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
  quarter of the RAM (256 MB to 2 GB), and the root threads it starts share a second such
  cap, so the build's old-generation heaps total at most half the RAM; the threads run only
  with at least 2 GiB, one per GiB (`defaultThreads`). These caps bound the V8 heaps, not the
  process RSS (buffers and typed arrays sit outside them). A build whose heap outgrows them
  ends the worker with an error in the status and the previous index stays in use, rather
  than growing the heap until the kernel ends the server. A server started with
  `--max-old-space-size` overrides the cap, because V8 flags apply to every isolate in the
  process.
- GDAL/OGR compiled to WebAssembly (gdal3.js, GDAL 3.8.4, about 40 MB installed), for reading
  S-57. Decision: the plugin reads the cells as delivered, each `.000` with its updates,
  down to three folders deep under the cells directory (an exchange set's `ENC_ROOT` included), and writes
  nothing beside them and no intermediate files; only the built index is saved. GDAL runs only
  in the index build's worker thread: it reads each cell once per build, its layers as GeoJSON
  held in one SharedArrayBuffer that the region threads read without a copy, and its 512 MB
  WebAssembly memory goes when the worker exits. Whether a saved index still matches is told on
  the main thread without GDAL, by a hash of each cell's files' names, sizes and modification
  times (`CellInfo.files`). The hash covers the base cell and the updates in the folder of its
  resolved path, where GDAL applies them to a linked `.000`, and a build takes it just before
  GDAL opens the cell, so an update added during the read leaves a hash that differs. GDAL
  reports the last update's `DSID_EDTN` once updates are
  applied (0 in NOAA updates), so the edition is read from the base cell's DSID record. The container approach
  it replaces needed `signalk-container` and an export step per cell. The 12
  NOAA cells around Miami (6.8 MB) build in 19 s at leaf zoom 18 on x86; reading US5FL61M
  (1.5 MB) takes 1.6 s of that.
- Must run on a Raspberry Pi 4 as well as on the Jetson Orin. Budget: index RAM under 150 MB,
  look-ahead CPU under 5 % of one core.

### 4.2 Ingest

**Index box around the vessel (decision, 2026-10-23).** S-57 cells are no longer indexed
whole: the index is built in a box of `boxRadiusKm` (default 10 km, half-width) around the
vessel, and rebuilt as the vessel moves by the same rules as the Traficom WFS box below (more
than half the radius from the centre, or the edge along COG closer than SOG × 1.5 × the last
build time plus the look-ahead's reach and the no-coverage band inside the edge). A whole build
of the 698-cell NOAA US East and Gulf set at z20 ran for over 15 minutes on 4 threads without
finishing; the 10 km box around Bal Harbour reads 21 of the cells and builds in 22 s (x86).
Cells are chosen by their extent, read from the SG2D/SG3D coordinates of the `.000` and its
updates without GDAL (`ingest/enc-bounds.ts`, 3.3 s for the 698 cells, in the build worker); a
cell whose extent
cannot be read is always taken. Tiles are built out to the box grown by `BOX_REACH`, the widest
chart position reach rounded up to 2 km, and a tile crossing the edge of the box or of that
area splits to the leaf zoom, so no coarse tile carries a value past what was read. Every tile
not wholly inside the box keeps its depth and σ but carries `NO_COVERAGE`: a hazard just
outside the box still spreads its graded risk inward (invariant 1), nothing outside reads as
covered, and a footprint within `FLAG_SIGMAS`·σP of the edge reads `NO_COVERAGE` as at any
coverage gap (invariants 3 and 4). Cells are read to `BOX_MARGIN_KM` = 6 km past the box: the
2 km reach, a z14 leaf across the edge (2.4 km) and the widest burn radius (1 km).

The box, the cell stamps it was chosen from and the leaf zoom are saved beside the index
(`box.json`). A start loads the saved index while they match and rebuilds in the saved box
when they do not, also when the saved index cannot be read; it never falls back to a build of
every cell. With no saved box it stays `off` with "waiting for the vessel position to build
the chart box" until the first position. The refresh worker scans `cellsDir` and stamps the
cells off the event loop. A refresh is due, besides the WFS rules, whenever no index of the
service's box is in use; whether the saved index was built in the saved box is read at the
first check, after the start plan has moved a crash-left index back or built one, so a
recovered index is not rebuilt at the berth. A `cellsDir` that exists but holds no S-57 cell
while the index in use or the catalogue saved in `indexDir` holds S-57 cells (`cellsMissing`) is
read as an unmounted drive, whose mount point stays as an empty directory: a start loads the
saved index with the reason "no S-57 cell found in <cellsDir>; using the saved index", as for
a missing directory, and a refresh fails and keeps the index in use, also with no index in use
or one of WFS depths alone; with no index in use the failure is the published reason. Taking
the empty directory at face value would replace an index of charted hazards with WFS depths
alone, or drop it. A saved WFS cell whose DSID no longer reads, or that is missing, is left out
of the start plan and downloaded again at the first check; the box start plan leaves that
cell's stamp out of its comparison, so the saved box index, which still holds the cell's
depths, is loaded meanwhile. With the WFS on, its box is the one the ENC cells are built in.
`boxRadiusKm: 0` keeps the whole build (an index built in a box is then rebuilt whole); a radius
between 0 and 2 km is raised to 2.

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
   box; 10 minutes until one is measured) and the band inside the edge where a footprint reads
   no coverage: the widest position buffer and chart reach (500 m + 1860 m), as the block
   keeper keeps. A tile across the edge carries `NO_COVERAGE` and keeps its survey σ, so its
   flag reaches 2σ (1 km in CATZOC D) past the footprint's buffer; without the band a vessel
   in CATZOC C or D water read no coverage for the last 0.5–1.5 km before each handover. A box
   too small to hold the band can at best be kept around the vessel, so the band counts only
   up to half the radius (the look-ahead's reach counts in full); past that the half-radius
   rule decides, and a drifting vessel does not rebuild a 2 km box every minute. Checks run
   every 10 s, at most once a minute and 5 minutes after a failed download or handover; a box
   whose index could not be put in use stays due. The new box is
   centred SOG × the last time ahead along COG, at most 0.8 × the radius, so the vessel is near
   its centre when it is handed over; at
   25 kn with 10-minute rebuilds the half-radius rule alone handed a box over with the vessel
   5.4 km past the old box's edge. A box centred ahead covers less water astern, which route
   checks of legs behind the vessel see as uncovered (`unverified`, invariant 4). A worker
   thread downloads the box, parses, clips and writes the cell (each layer and then the folder
   fsynced before it is swapped in, the old cell moved back if the swap fails, so a power cut
   leaves the old cell, the new one or none, never a torn layer), rebuilds the index and stages
   it; the main thread moves it into place and swaps in the index the worker posts, its pyramid
   columns moved rather than copied, so the handover reads nothing
   back from disk (the read-back held the event loop 52–61 ms at z20 with two Nauvo cells and
   258–292 ms with 32; the handover now 21–23 and 68–97 ms, on x86). The rebuild
   builds only the z10 roots that the WFS cell reaches in the saved index or now, and copies
   the others from the saved index (§4.3). Each layer's count comes from a `resultType=hits`
   request; its pages are sorted by `IDENTIFIER` and read up to 4 at a time across the three
   layers, since the server sends one response at about 1 MB/s (a 25 km box at Nauvo: 30 s
   instead of 82 s). A count over 50 000 is refused before any page, and pages holding more or
   fewer features than the count, or one feature twice, fail the download. Each page is
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
4. **Crowdsourced depth cells** (proposal, not implemented). IHO CSB soundings aggregated by a
   publisher into Web Mercator cells with counts, dates and σ
   (`schemas/navigation-safety/csb-cell.json`, `docs/rfcs/crowdsourced-depth-cells.md`). A cell
   is used only with `reduction` other than `none`, `nPlatforms ≥ 2` and `nDays ≥ 2`; a set
   whose `verdat` does not map to the water-level source is rejected with a reason on
   `/status`. A used cell sets the leaf to `min(current dMin, dShoal)` (flag `CSB_ADJUSTED`),
   never raises it, and never adds coverage.

**S-57 object classes used:**

| Class                         | Attributes                             | Role                                                                            |
| ----------------------------- | -------------------------------------- | ------------------------------------------------------------------------------- |
| `DEPARE`                      | `DRVAL1`, `DRVAL2`                     | depth areas; rasterise with **`DRVAL1`** (shallow bound), which is conservative |
| `DRGARE`                      | `DRVAL1`                               | dredged areas                                                                   |
| `SWPARE`                      | `DRVAL1`                               | swept depth; **guaranteed minimum**, σ_depth ≈ 0.1 m                            |
| `SOUNDG`                      | 3D multipoint                          | spot depths; graded by the survey's σP (burned only in unassessed water)        |
| `UWTROC`, `WRECKS`, `OBSTRN`  | `VALSOU`, `WATLEV`, `EXPSOU`, `QUASOU` | point hazards → R-tree, buffered                                                |
| `LNDARE`, `COALNE`, `SLCONS`  | —                                      | depth −∞ (hard obstacles)                                                       |
| `PONTON`, `FLODOC`, `HULKES`  | —                                      | depth −∞ (hard obstacles)                                                       |
| `UNSARE`                      | —                                      | no depth: `NO_COVERAGE`, so legs are _unverified_ and look-ahead never _normal_ |
| `M_QUAL`                      | `CATZOC`, `POSACC`, `SOUACC`           | survey quality zones                                                            |
| `M_COVR`                      | `CATCOV`                               | coverage; no coverage means _unverified_, not _safe_                            |
| DSID / `M_SDAT`, `M_VDAT`     | sounding / vertical datum              | water-level reduction (§4.5); `DSPM_CSCL` compilation scale (§4.4)              |
| Edge, nodes (GDAL primitives) | `QUAPOS`, `POSACC`                     | spatial records not surveyed: the drawing they bound widens to 4× its σ (§4.3)  |

**Coverage mosaic.** For every location, use the cell from the **largest-scale usage band**
that covers it. Where bands overlap, the larger scale wins, and the smaller scale is used only
to fill gaps.

**Output:** the index (§4.3), plus `cells.json` recording edition, update number, issue date,
datum and the cell's files' hash. The chart edition is stamped onto every route-check result, so
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
  surveySigmaP: number; // widest σP of the assessed quality zones reaching it (chart position)
  topoSigmaP: number; // widest σ of its land and shoreline objects' own positions (§4.4), 0 if none
  bathyDMin: number; // shallowest depth its survey places: dMin without those objects
  flags: number; // SWEPT | NO_COVERAGE | UNASSESSED | DREDGED | LIVECHART_ADJUSTED; proposed: CSB_ADJUSTED (§4.2 item 4)
  cellRef: number; // index into cells.json (edition provenance)
}
```

**Build rule.** Each parent stores the following, so any query box gets a guaranteed
lower bound from one lookup.

- `dMin` is the minimum of its children's.
- `sigmaD` and `sigmaP` are the maximum of its children's.
- `flags` is the bitwise OR of its children's.

**Burning hazards.** A point hazard or sounding in assessed water falls in the leaves it
touches; the query spreads it by its survey's σP like an area (graded chart position,
below). One in unassessed water, where no σP is spread, is rasterised into every cell within
`k·σP` of it (k = 2, σP the unassessed 500 m). The R-tree keeps the exact geometry for
explanations and for refinement near the threshold. A burn disc more than 8 tiles wide does
not by itself subdivide a tile: the tile takes the disc's depth over its whole area, which is
pessimistic by at most one tile width.

**Split depth by compilation scale.** Nothing a cell draws is placed finer than 1 mm at its
compilation scale (`DSPM_CSCL`), so a tile stops splitting once it is that narrow at the
equator (and narrower nearer the poles) for every feature and coverage it holds: z14 for a
1:3 500 000 overview, z16 for 1:1 200 000, z19 for 1:80 000, the leaf zoom from about 1:45 000.
A tile that stops takes the shallowest depth of all it holds, as a leaf does, so it is never
deeper than a full-resolution build (`__tests__/spatial/scale-split.test.ts`). Without it the
one NOAA overview cell of the Gulf of Mexico, 6 537 features, was cut along every coastline and
contour into z20 tiles: 145 005 tiles at z14 took 55 s, 709 861 at z16 256 s, and the 25 cells
around Miami built for over 15 minutes; with it they build in 94 s (717 465 tiles), the overview
cell in 48 s. A source with no stated scale (the Traficom WFS cell) splits to the leaf zoom.
`M_CSCL` areas widen the drawing σ (§4.4) but never the split depth, which follows each cell's
features and coverage at `DSPM_CSCL`.

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

**Chart position in the query.** A charted object may lie off its drawn position by the
accuracy of its source. Depth areas and lines are not widened when the pyramid is built, and
neither are points in assessed water, so the look-ahead, a route check, a repair cost cell,
`POST /query` and the UKC tiles carry it (`spatial/chart-position.ts`).

**Decision (graded chart position, invariants 1 and 2).** The chart's offset is read as a shift
of the chart against the vessel, N(0, σ²) per axis. A tile charted g metres beyond the
footprint and its buffer lies under the footprint only if the shift towards it exceeds g,
which has probability Φ(−g/σ). Its P(UKC < 0) counts with that weight, out to 3.72σ (beyond it
Φ is below `RISK_STOP_BELOW`). A tile within the buffer counts in full, as before, and only
those tiles set `dMin`, `coveredDMin` and the worst tile: the depth reported under a
footprint is the depth charted there. Flags and cell references still count within 2σ of a
tile's survey, as the hard reach did, so a gap or an unassessed survey within reach still
keeps a footprint from reading as safe (invariant 4).

Before this, every tile within `k·σP` (k = 2) counted in full and a point was also burned
within `k·σP`, so a CATZOC C shoal counted at full weight up to 1 km away. Over NOAA cells
of Florida, where much water is zone C (surveyed 1930–1939), that drew the ocean red for a
kilometre off every beach, set `coveredDMin` to land and so failed every route leg within
500 m of the shore, and reported "land" under a vessel in a navigable inlet: water the ENC
shows at 3.3–5.4 m. A shoal at the edge of the old reach and one just past it now differ by
their weights (2.3 % and slightly less) rather than by 100 % and 0. The weight rises with σ and
falls with g, and a wider buffer brings tiles closer, so a deeper draft, a lower water level,
a larger position uncertainty or a worse survey never lowers P (invariant 2). Invariant 1 is
restated accordingly (below and in AGENTS.md).

**Topography is placed by its own accuracy.** CATZOC rates the hydrographic survey. Land and
shoreline objects (`LNDARE`, `COALNE`, `SLCONS`, `PONTON`, `FLODOC`, `HULKES`) come
from the shoreline compilation, so they spread by their own σ (§4.4), kept per node in `topoSigmaP`, and the depth the survey
spreads (`bathyDMin`) leaves them out. A leaf on a spatial record that is not surveyed
(QUAPOS other than 1, 10 or 11) reads them as drawn from a source four times smaller in
scale (`NOT_SURVEYED_SCALE`, 24 m at 1:12 000), or by its survey's σP (the unassessed one
where it has none) in a cell with no compilation scale; a stated POSACC widens the σ to half
of it.

**Decision (depth areas placed by the drawing, 2026-10-23, invariant 1).** CATZOC's position
accuracy rates where the survey put its soundings and dangers. A cell's depth areas
(`DEPARE`, `DRGARE`) are contours compiled at its scale and fitted to its shoreline, so in a
cell with a compilation scale and positional quality they are placed by the drawing like land:
σ = 0.5 mm at the compilation scale (6 m at 1:12 000), kept per node with the shallowest
depth the drawing places (`topoDMin`, −∞ for land; pyramid version 9). Soundings, rocks,
wrecks and obstructions keep the survey's σP, and the survey's depth accuracy stays in σD
(C: ±2 m + 5 %). A spatial record that is not surveyed (QUAPOS 4 approximate and the like)
widens the drawing's σ to 4 × its compilation σ, as if drawn from a source four times smaller
in scale (24 m at 1:12 000), rather than to the survey's σP. Sources with no compilation
scale (Traficom WFS, synthetic) and cells without positional quality are placed by the survey
as before. Over NOAA US5MIAEC (zone C, surveyed 1939) the survey's 250 m spread drawing and
land had closed Bakers Haulover Inlet (charted 3.6 m) to a 0.9 m draft: every water cell
within about 300 m of a drying contour or the shore read `danger`. Placed by the drawing,
the inlet and the water off the beach read by their charted depths, and `danger` remains
within a few hundred metres of the zone's charted obstructions (0 m and 1.8 m, ±500 m by the
survey) and `unverified` within 500 m of its zone U. A deeper draft, a lower water level or a
wider σ still never lowers P (invariant 2): the weight and P(UKC < 0) both rise with each.
The compilation scale is the cell's `DSPM_CSCL` for every feature. An `M_CSCL` area whose
`CSCALE` is smaller, in a cell with positional quality, is kept as a feature of its own (role
`scale`): a leaf it reaches spreads its drawing by at least that scale's σ (40 m for a
1:80 000 area in a 1:12 000 cell), and a record not surveyed there by four times it (160 m).
A leaf it does not reach keeps the cell's σ, even where a cell-wide depth area or land polygon
runs through both; applied to every feature whose box met the area, a 1:80 000 area spread
every contour and shoreline of a 1:12 000 cell by 40 m. An area at a larger scale than
`DSPM_CSCL` would only narrow σ and is not kept. Pyramid version 10 holds these σ. A split tile
passes a partial depth feature to its children unless a feature containing the whole tile dominates
it in depth and placement (survey-placed against survey-placed, drawn against drawn with a σ
at least as wide), so a sounding inside a shallower drawn area keeps its survey spread.

A leaf's survey σP comes from `surveySigmaP`, the widest σP of the assessed, non-advisory
quality zones reaching it, so a leaf only partly assessed keeps the reach of its assessed part.
A split tile stores the widest σ and shallowest `bathyDMin` of its leaves, which bound the
weighted P of any leaf under it; the walk skips a subtree whose bound cannot raise the
footprint's P and whose flags, if they count, need no locating. Unassessed water and Traficom
WFS water spread no depth: their flags already make a leg `unverified`, a query never
`clear` and the look-ahead never `normal`, and the unassessed σP of 500 m would make nearly
every leg over WFS water `fail` on land within 1 km that the data does not put there. The
widest σ modelled is 500 m.

**Storage.**

- `pyramid.bin`: a JSON header line, then gzip members (level 1) of typed columns, one column
  per node field (depth, σ, flags, cell reference, tile key, zoom, split bit). The first member
  holds the block table and the resident nodes, zoom 15 and coarser; each further member holds
  one block, the finer nodes under one z12 tile. Within a member nodes are written by zoom and
  then tile key, so the inflated columns are the store as they are, and a lookup bisects its
  zoom's key column: 38 bytes per node, against 110–160 with a Map per zoom (which V8 also
  caps at 16.7 M entries). `dMin` stays a 64-bit float, so a stored depth is never rounded
  deeper. On 64 copies of the Nauvo pair (13.5 M nodes, 448 blocks) the resident nodes are
  34 k (1.6 MB) and a block at most 50 k nodes (1.9 MB inflated, 140 kB compressed); a whole z10
  root reaches 505 k nodes (19 MB), too much to hold the four a look-ahead can straddle.
- Blocks are read when a query first reaches them (`spatial/block-cache.ts`): one compressed to
  256 kB or less is read and inflated on the spot, about 1 ms on x86, so the query answers from
  it; a larger one is read off the event loop. Loaded blocks are dropped, least recently used
  first, once they exceed 32 MB inflated (about 27 dense blocks, a 25 km square), but never
  within the turn of the event loop that read them, so a walk never loses a block midway, and
  never while kept: the blocks within the look-ahead's reach of the vessel (its distance or
  horizon at SOG, the widest position buffer and chart reach) and the same reach 300 s ahead
  along COG, updated at most every 2 s (`block-keeper.ts`). Blocks of checked routes, served
  tiles and queries stay while they are used.
- A block not loaded (larger than 256 kB and on its way, or refused as damaged) never reads as
  clear water (safety invariant 3). A walk reaching a split node at zoom 15 whose block is not
  loaded takes the node as a stand-in: its own shallowest depth, widest σ and flags plus
  NO_COVERAGE, the shallowest charted depth of the leaves under it, and a P(UKC < 0) at least
  any of those leaves' (at their narrowest σD where that depth is shallower than the
  threshold, at the widest where deeper). A look-ahead footprint over it is therefore at least
  `warn` ("no chart coverage"), a leg at least `unverified`, a query or a UKC tile cell at least
  `unverified`, and each at least as severe as with the block loaded; with every block loaded
  every answer equals that of the store held whole. `loadChartIndex(dir, { whole: true })` joins every block back into the store's own columns, in file order, for code that reads a store's levels directly (an incremental rebuild copying unchanged roots). A store's `loadRevision` counts block
  loads and drops, and `blocksChangedSince(revision)` names the block tiles, for caches of
  answers that may have read a stand-in.
- `cells.json` (provenance) and `hazards.json` (exact hazard geometry) sit beside it. The
  hazard R-tree is rebuilt from `hazards.json` at load, packed in typed arrays (about 47 bytes
  per hazard).
- `reach.json` holds each cell's reach: the box of its features, its widest burn radius and
  its coverage box. A build told which cells changed (the WFS cell after each download) copies
  from the saved index every z10 root that none of them reaches, by the saved reach or the new
  one, nor any cell whose DSID differs from `cells.json`: the features reaching such a root are
  those of the saved build. The result is byte-identical to building every root (tested for
  boxes moved within a root, across root edges, over ENC cells and out of or back into the
  roots of the ENC cells). Every root is built when the saved
  index holds other cells or another order, another leaf zoom, no `reach.json`, or fails to
  read. As at start, a cell with the same DSID edition, update, issue date and datum areas is
  taken as unchanged.
- The index is built in a worker thread, at start as for a new WFS box (§4.2), and posted
  to the main thread with its pyramid columns moved; until the worker hands it over the
  look-ahead is `off` with the reason `building chart index`, and the WFS box starts only
  after the handover, so this build never replaces a newer box's index.
  A saved `pyramid.bin` over 1 MB is read off the event loop the same way, `off` with
  `loading chart index` meanwhile; a smaller one loads within `start()` (22 ms on x86 for two
  Nauvo cells). Either way every block is inflated once at load and dropped, so a damaged
  file is refused and rebuilt at start rather than when a query first reaches the damage.
- `indexDir` belongs to the plugin: a save replaces it whole, so it must be new, empty or an
  earlier index, and a directory holding anything else is refused with the entry named
  rather than overwritten. A trailing separator is resolved away first. The start plan and the
  box service ask the same check (`indexDirProblem`) before they build: a refused `indexDir`
  fails the start with the reason before any build, and the box service reports it once and
  downloads and builds nothing, asking again every 5 minutes, until it is set right; the build
  would otherwise be refused only once done, minutes on a Pi 4.
- A save writes and fsyncs the three files and their staging directory, renames the staging
  directory into place and fsyncs the parent. A failed save removes its staging and keeps the
  previous index; staging left under this process id by an earlier run (a container restart
  reuses ids) is removed at start, and moved-aside `.old-*` copies once a whole index is in
  place. A saved index that fails to read or parse at
  start (a power cut can still leave a file short) is rebuilt from the configured cells, with
  the read error in the index reason; without cells the read error is the reason.
- The same data is also exported as UKC tiles (§4.10).

**Invariant, tested by property-based tests:** for any polygon and buffer,
`pyramid.minDepthOver(poly).dMin ≤ min(source feature depths intersecting poly ⊕ buffer)`,
the buffer being the query's (the vessel's position uncertainty) widened by a point's burn
radius in unassessed water; and with chart position on, its P is at least
`P(f) · Φ(−g/σP)` for any feature f of the survey g metres beyond that buffer. The pyramid
may be pessimistic but must never be optimistic.

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

**Topographic accuracy.** CATZOC rates the hydrographic survey, not the shoreline
compilation. Land and shoreline objects are placed by the plotting accuracy of the cell's
compilation scale (`DSPM_CSCL`), 1 mm on the chart read as a ~95 % bound: σ = 6 m at
1:12 000, 22.5 m at 1:45 000, capped at 500 m for overview cells. Where the cell's `M_CSCL`
declares a part compiled from a smaller-scale source (`CSCALE` larger than `DSPM_CSCL`), the
reader keeps that polygon as an area of its own and leaves every feature at `DSPM_CSCL`; a leaf
the area reaches spreads what the drawing places there by σ at `CSCALE` (§4.3). QUAPOS lives
on the spatial records (edges and nodes), not on the objects: the reader takes those not surveyed
(QUAPOS other than 1 surveyed, 10 precisely known, 11 calculated) or with a POSACC from GDAL's
primitive layers, with the connected nodes each edge ends at, since GDAL's Edge geometry holds
only the interior vertices, and rebuilds every edge whole. Land, shoreline and depth areas
on such a record are read as drawn from a source four times smaller in scale, or by half the
stated POSACC where that is wider (§4.3). An absent QUAPOS means
surveyed (S-52 draws such lines solid).

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
  makes every `ok` leg `unverified`. A fallback anywhere in a leg's interval, or at one of its
  ends, makes the leg's level degraded, at the lowest level found over the interval and both
  ends, never the fallback's alone: the fallback is min(0, last level), which can sit well above
  a level the source forecast earlier in the interval or at the other end.
- Decision (invariant 3): UKC tiles and `POST /query` take the level where they are, not the
  vessel's.
  - A provider whose answer depends on position states its reach (`reach()`): `levelAt` gives
    the same value at every position within it and none beyond. FMI's reach is 30 km
    (`FORECAST_REACH_METRES`) around the point its forecast was fetched for; manual, Signal K
    tide and none have no reach, so their level holds everywhere.
  - `WaterLevelService.regimes()` resolves two levels per request: the level inside the reach
    and, for anything else, the lower of that level and the fallback beyond, with the
    fallback's σ 0.3 m and degraded reason, which is what a route leg spanning both would get.
    A tile wholly beyond the reach takes this rather than the fallback alone, which is never
    wetter and needs no third level or distance test.
  - A tile is inside when all four of its corners are within the reach. Along a parallel the
    distance from the reach's centre grows with the longitude difference, so the tile's top and
    bottom edges are inside too, and the cap holds every meridian arc between them. Any other tile
    is drawn at the beyond level and shows no `clear` cell. `POST /query` applies the same test
    to its ring's lon/lat box plus its buffer, so a reach cutting an edge between two outside
    vertices, or reached only by the buffer, counts too.
  - A stale or unusable source, or FMI before its first forecast, gives one fallback
    everywhere. Look-ahead, notifications and `navigation.underKeel.waterLevel` keep the level
    at the vessel.
  - Applying the vessel's FMI level to every tile drew water off Vaasa with Kemi's +0.62 m surge
    and no degraded flag wherever the index reached more than 30 km from the forecast point
    (`boxRadiusKm` 0 or a large box).
- Decision (invariant 3): with no water-level source, chart datum (σ 0.3 m) applies as a
  measured level only where every cell's stated datum, and every datum-area code, is a low-water
  datum (VERDAT 1, 2, 4–15, 22, 23, 27), on which the tide seldom leaves less water than charted.
  Where one is not (mean water 3, 19 and 26, high water, local), the level is degraded, since the
  Baltic is often 0.3–0.8 m below mean water; the look-ahead is then at best `alert`, legs,
  queries and tiles never `ok` or `clear`, and neither acknowledgements nor own soundings are
  taken. The reason names the datums that are not low water and the source to set: `fmi`
  (Finnish waters) when one of those datums is mapped to an FMI series, otherwise
  `signalk-tide` or `manual`; it never suggests adding a datum mapping. A cell that states no
  datum, in practice the Traficom WFS cell whose water is never `normal` anyway, keeps chart
  datum. The check runs over the whole catalogue, so one mean-water cell anywhere in an
  otherwise low-water index degrades the level everywhere; per-cell levels are the follow-up
  above.
- Decision (no automatic water-level source): there is no `auto` source, and `none` stays the
  default. A default `auto` would send the vessel position to FMI without the user opting in
  (FMI open data is CC BY 4.0, and neither the README nor the About text attributes it yet),
  would change configurations that store no source without a warning, and would decide on its
  own to apply Signal K `environment.tide.*`, whose datum Signal K does not state, or a sea
  level near inland waters. The degraded no-source reason names the source to configure
  instead. An `auto` added with per-cell levels must be opt-in, use FMI only for FMI-mapped
  datums within FMI's reach (30 km forecast, 60 km gauge), use chart datum for low-water cells,
  never choose Signal K tide by itself, and degrade with the same named reason elsewhere.

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
- The chart's own position uncertainty is not added to the buffer: a tile beyond it counts
  with its P weighted by Φ(−g/σP), the chance the chart is off by its distance g (§4.3).
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
most 400 footprints. Δt stays the plan step out to `warnWithin`; when the horizon would need
more, only the spacing of the coarse footprints beyond it grows, toward the touching limit
(L + 2 · positionBuffer) / SOG, and may leave the Δt grid. The horizon is cut only past that,
and Δt itself grows only when `warnWithin` alone would need more than 400 footprints. Growing
Δt over the whole horizon would score the alarm and warn windows coarsely too: a 5 NM
look-ahead at 0.3 m/s would put the footprints at 0 s and 77 s, and a rock 30 s ahead would
read as a warn 77 s ahead, never an alarm. Configuration caps D at 5 NM and the minimum horizon
at 600 s.

The tracks start at the position fix, which may be up to `staleAfter` (10 s) old. The footprint
t seconds from now is placed t + age along them, age being now minus the fix's time, so every
footprint, the time to shoal and the window checks count from now, and the fan's spread and
along-track growth since the fix are kept. The footprint at t = 0 is the hull from the fix to
now, sampled at the touching step: the age includes any skew between the source's clock and the
server's, so the boat may still be at the fix, and a hull only where the age projects it left
the water just ahead of the bow unread (46 m of it with the server clock 8 s ahead at 8 m/s).
Escape tracks run straight for that age before they turn, since no turn can start before now.

**Decision (step rule): coarser steps beyond the warn window.** Footprints are scored every Δt
out to `warnWithin` (120 s), the widest window `classify` and the hysteresis raise a state in.
Beyond it only every k-th Δt step is scored, with k the largest whole number for which k·Δt
still leaves consecutive footprints touching, (L + 2 · positionBuffer) / SOG; footprint length
and buffer only grow with t, so the union of the coarse footprints still covers the swept hull.
Where a coarse footprint is the first to reach the warn or alert level or a coverage gap, the
Δt grid steps between the footprint before it and it are scored (a coarse footprint spaced for
the budget may lie off the grid), so `timeToShoal` and the reason keep the Δt time. A coarse
footprint is the convex hull of the hulls of every step it stands for: in a turn the steps
between two coarse ones bulge outside their hulls, and under graded chart position (§4.3) a tile
that much farther weighs less, so a coarse tick read up to 0.12 points of P below the plan
steps. The hull takes in the footprints at every grid time j·Δt after the previous scheduled
time, the grid the plan steps and `firstTime` use, also where the coarse footprint lies off it,
so every plan step's footprint is in some coarse hull. The covering hull reads every tile at
least as near, so P is never lower than with every step scored
(`__tests__/engine/lookahead-cost.test.ts`, and off the grid in a turn with `warnWithin` 30 s,
`__tests__/engine/coarse-grid.property.test.ts`). At 1 kn a
tick scores 57 footprints instead of 361. The escape fan scores the same coarse times, so a
heading's time to shoal beyond 120 s is known to k·Δt.

**Output per tick.**

- Min UKC μ and σ along the central member.
- Maximum P over all members.
- TTS: the first t at which P ≥ the warn threshold.
- Worst cell and worst hazard.
- The envelope GeoJSON, rebuilt only when it changes and versioned by `rev`.

**Escape fan** (only in alert, warn or alarm). Evaluate headings at ±5° steps out to ±90°,
using arcs limited by the boat's configured maximum turn rate. Each heading is scored as a fan
with the spread the state is scored with: its escape track, the same track at COG ± σ_COG, and
with a ROT ± σ_ROT spread held for `turnFor` on top of the turn. A heading scored on its track
alone is narrower than the fan that raised the state, so holding course could pass a shoal the
COG + σ member hits and be offered as the way out. Publish the heading with the greatest TTS,
breaking ties by the smallest heading change. TTS counts from the first step after t = 0, since
the footprint under the vessel is common to all headings. Publish null when holding a steady
course (|ROT| ≤ σ_ROT) does best, since there is nothing to dodge to, or when no heading is
clear past the first step. A boat turning faster than σ_ROT whose straight candidate does best
gets its current heading: the state fan follows the turn, and steadying on the current heading
stops it.

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
the boat; `alarm` from the capped footprints stays `alarm`. The escape fan is not searched. The
result carries `capped`, which hysteresis carries from the raw tick, so acknowledgements and
mooring zones (§4.12) never lower a capped tick, warn or alarm alike, whatever reason a held
state keeps.

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
  along its track. A tile beyond the buffer counts with its P weighted by Φ(−g/σP) of its
  chart position, and its flags within 2σP of its survey (§4.3), on top of the burn around
  point hazards.
- The escape fan uses the maximum turn rate (default 3°/s) and stops at the first heading,
  smallest change first, that stays clear over the whole horizon; when that heading is holding
  course and |ROT| ≤ σ_ROT, the escape heading is null. Each heading scores five tracks, up to
  37 headings a search. The monitor searches it at most every 3 s and holds the heading in
  between. The search runs after the tick's deltas are published (`setImmediate`), so the event
  loop is blocked in two shorter pieces, and its heading is published when it is found. After a
  tick longer than 250 ms (`SLOW_TICK_MS`) the next search is skipped and the heading is null,
  and the plugin status names the skip until a search runs. A search that slow keeps its
  heading, no staler than one held between any two searches, and pushes the next search back
  3 s (`ESCAPE_EVERY_MS`); the status says the searches are slow until a fast one runs. Either
  restarts the 3 s wait, so a search that is always slow runs less often, not more. A state held
  by hysteresis publishes the current tick's heading, null when it has none, never the one held
  from the tick that raised it: that heading was found from an earlier position and course and
  may point at the shoal.
- Integrity: dead reckoning runs on each fix's own timestamp, so a GNSS feed slower than the
  1 Hz tick is not read as divergence. σ_DR = √(σ_anchor² + σ_GNSS² + (0.2 m/s · run)²);
  a consistent run re-anchors every 60 s; a diverged one is not re-anchored, and clears
  only when the growing σ_DR covers the offset. The current is learned with a 120 s low-pass
  while |ROT| < 0.01 rad/s, during a divergence too. Decision: frozen while diverged, a current
  the estimate has not caught up with (a stream met at start, or a step into one) above
  k · 0.2 m/s = 0.6 m/s would move the fix away faster than k · σ_DR grows, and the check would
  never pass again: σ_pos would reach kilometres within the hour with GNSS correct. Learned, the
  offset stops growing and σ_DR covers it; a 1 m/s step clears in about 2 minutes. The cost: a
  spoofer that drags the position at a steady velocity, or ramps it inside σ_DR, is flagged for
  minutes rather than for good, and so is a GNSS velocity bias, since without an independent
  reference it reads as a current; a jump stays flagged until σ_DR covers it. The learned current
  is bounded at 3 m/s (5.8 kn, `maxCurrent`): a drag or bias faster than that is never explained
  away and stays flagged, and in a stream faster than that the check stays failed, the safe way.
  The low-pass lags a drag just above the bound (3.01 m/s reads under 3 m/s for about 11
  minutes), so a failed run clears only once the latest unfiltered difference is within the
  bound too. A fix whose `methodQuality` is not a satellite fix sets σ_pos ≥ 50 m. Without speed through water the
  check reports itself unavailable in the notification and in `/status`.
- Hysteresis applies between `normal`, `alert`, `warn` and `alarm`. `unknown` and `off` pass
  through at once, so stale input is never held as an earlier state. The risk state before
  them stays held: after the gap a lower state still needs the 5 lowering ticks, and a higher
  one is taken at once.
- A footprint stops reading the chart at the first charted land at P = 1: no later tile can
  change its depth, P or worst tile. Its flags then hold only the tiles read, so where the state
  turns on coverage (no warn or alarm from risk) such a footprint is read again in full, and a
  coverage gap next to land is still reported. Route checks always read every tile.
- Measured on the synthetic archipelago at leaf z20 (`npm run bench`, x86, plain Node):
  median 1.2 ms and p95 4 ms per tick, escape fan included. Under Jest's stock environment the
  same run was about 15× slower; in the test environment of §7 (Test runtime) it measured median
  1.5 ms and p95 6.3 ms with the escape fan on an i5-8350U laptop.

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
`notifications.navigation.positionIntegrity` follows the same rule (`NOTIFY_REFRESH_MS`): at once
on a new state or kind of reason, and with only its divergence or HDOP changed at most every
30 s.

| Path                                         | Unit         | Meaning                                                                     |
| -------------------------------------------- | ------------ | --------------------------------------------------------------------------- |
| `navigation.underKeel.state`                 | enum         | `normal \| alert \| warn \| alarm \| unknown \| off`                        |
| `navigation.underKeel.clearance`             | m            | predicted min UKC (μ) over horizon                                          |
| `navigation.underKeel.clearanceSigma`        | m            | σ of the above                                                              |
| `navigation.underKeel.risk`                  | ratio        | max P(UKC < 0) over horizon                                                 |
| `navigation.underKeel.timeToShoal`           | s            | null if none in horizon                                                     |
| `navigation.underKeel.escapeHeading`         | rad          | true heading, null when normal or no heading is better, held state included |
| `navigation.underKeel.envelopeRev`           | int          | bump → client fetches `/envelope`                                           |
| `navigation.underKeel.waterLevel`            | m            | applied level above chart datum                                             |
| `notifications.navigation.underKeel`         | notification | state + message + `data.explanation`                                        |
| `notifications.navigation.positionIntegrity` | notification | GNSS/DR divergence                                                          |

This follows the "lightweight signal, then fetch the snapshot" pattern from the Plotter
Extensions route API (`route.dirty` → `route.get`). Deltas stay small, and the GeoJSON is
pulled only on change.

**REST, base `/plugins/signalk-underkeel/v1`:**

| Method          | Path                         | Purpose                                                                                             |
| --------------- | ---------------------------- | --------------------------------------------------------------------------------------------------- |
| GET             | `/status`                    | index coverage, cell editions, water-level health, engine state                                     |
| GET             | `/envelope?rev=`             | look-ahead FeatureCollection (fan, footprints coloured by P, hazards, escape arrow)                 |
| POST            | `/route-check`               | per-leg result (§4.11)                                                                              |
| POST            | `/route-repair`              | suggested geometry for failing legs                                                                 |
| POST            | `/departure-window`          | safe departure intervals over a horizon                                                             |
| POST            | `/query`                     | point or polygon UKC with explanation (cursor readout, popovers)                                    |
| GET             | `/tiles/ukc/{z}/{x}/{y}.pbf` | vector tiles: cells classed by P at the water level valid at each tile (§4.5) and the current draft |
| GET             | `/tiles/ukc/changes`         | the served tiles to fetch again since a cursor (§4.14)                                              |
| GET/PUT         | `/vessel`                    | vessel model                                                                                        |
| GET/POST/DELETE | `/acks`                      | acknowledged passages                                                                               |
| GET             | `/livechart/discrepancies`   | suspected shoals                                                                                    |
| GET             | `/livechart/csb.geojson`     | IHO CSB export                                                                                      |

All writes go through Signal K's normal authentication: the security strategy and an
admin or readwrite token.

Reads and notifications are open to any readonly client, so they keep the server's directories
and raw errors off the wire. `GET /status` reports no index directory. Its reasons
(`index.reason`, `engine.reason`, `wfs.lastError`, `chartBox.lastError`), a 5xx reply's reasons
and every notification message go through one sanitizer, `publicReason`
(`src/foundation/public-text.ts`): the text after `failed:` becomes "failed (see the server
log)", where the plugin error already holds it, and each absolute POSIX, Windows (`C:\`, `C:/`)
or UNC path becomes `<path>`, keeping an S-57 cell file's name (`<path>/US5MA22M.000`). A
quoted path ends only at a quote followed by the end or a space whose next word holds no path
separator, so a name holding an apostrophe or a space is hidden whole. URLs,
relative paths, cell names and numbers are kept, and why a saved index could not be read stays
in the index reason with its paths hidden, since that reason is the only place it is reported.
A 4xx reply describes the request and goes out as it is. The plugin status and the server log
keep the full reasons.

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

**As built (M5).** The repair grid has at most 120 cells on its longer side. Each cell is at
least 10 m and at least half the corridor half-width r (xteLimit + planning buffer), and the grid
reaches half the leg's length beyond the leg, and at least 300 m and 2r. A cell is blocked when
the corridor around it has P at or above the accept threshold, or touches `NO_COVERAGE`,
`UNASSESSED` or `NO_DEPTH`: a repair must not route through water it cannot check. Costs are
evaluated lazily as Theta* expands. A cell is scored at its centre with the corridor plus half a
cell, so cells much smaller than r read the same water many times: a 10 km leg at ±2 km took
2.5 s on a laptop with 167 m cells. The start and goal cells are scored at the leg's ends with
the corridor alone since the path starts and ends there: on a 30 km leg the cells are 500 m, and
a shoal a few hundred metres from a waypoint, outside its corridor, would otherwise block the
whole search. Opened on that score, they could hide a shoal elsewhere in the cell under the
path's first or last line, so a line out of the start cell or into the goal cell is checked as
a corridor from the end itself over its first 1.5 cells, past the end's cell from whatever
corner of it the end lies in, and blocks when it fails; where the water within 1.5 cells + r of
an end is clear, one query stands for all of that end's lines. The grid's water level is the
lowest at the leg's two ends from the leg's start until the boat could have sailed the grid's
width plus height: a detour is longer than the leg, and on a falling tide the final check reads
its last pieces in less water than the leg's own window. The final check samples the level at
the detour's waypoints, so where the grid's two samples miss a lower level the check refuses
the path rather than passing it.
Simplification replaces a span with its chord whenever the chord passes the corridor check at
the time the boat reaches the chord's start along the path kept before it, at the leg's speed
with the millisecond-truncated chained times of the final check, so no simplification makes a
leg fail, also on a changing water level; it never re-checks the leg's own chord, already
checked as `fail` or `marginal` from that time. A path that still fails is reported with a
reason and no waypoints. Legs are repaired in route order, each checked at the arrival time the
detours before it give, and the response's `route` is the whole route with
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
repairs at most 10 legs, and the rest are listed with a reason.

Decision (§6 budget, bounded repair): the 200 km² corridor admission bounds a route check but
not a repair: a 47 km leg at ±2 km over 135 000 near-threshold soundings took 2.2–3.4 s on a
laptop. Repair work is therefore counted, never timed (`src/engine/work.ts`), so a request gives
the same answer on any machine.

- The unit is a tile that `minDepthOver` examines (`visits`), plus 32 per query and one per 5
  Theta\* line samples.
- One leg may do 600 000 units (`maxWork`), sized for about 1.5 s on a Raspberry Pi 4. Its
  search stops at 80 % of that and the leg is refused; simplification stops removing waypoints
  at 90 % and keeps the rest. The final check of the path is counted too: a leg whose final
  check cannot start a leg within the limit is refused.
- A refused leg gets no waypoints and a reason naming its worst position as the place to add a
  waypoint, and its own status stays in the re-checked route (invariant 4).
- A request searches no further leg once its repairs have done 1 800 000 units
  (`maxRequestWork`); later legs are listed as "not searched: this request has used its repair
  work limit". Every searched leg runs with the full limit, so its outcome does not depend on the
  other legs in the request.
- A leg can go past its limit by the line checks of one expanded cell (two for each of its up to
  8 neighbours), one chord check or one final-check leg; the corridor admission bounds each of
  these.
- `npm run bench` times an adversarial synthetic chart (135 000 soundings at 3.2–5.2 m over 25 m
  water and a drying wall with a gap) on the built `lib/` in a plain node child process, outside
  Jest's module sandbox. The 47 km leg is repaired at ±40 m in 382 138 units, and refused at
  ±500 m after 480 003 units (1 016 537 without a limit) and at ±2 km after 481 104 (3 593 390
  without a limit). The 10 km leg across the wall's end is repaired at ±500 m in 329 031 units
  and at ±2 km in 238 025. On an i5-8350U laptop a unit took 0.34–0.66 µs over two runs, so a
  leg's 600 000 units take at most 0.4 s there; the Pi 4 is assumed 3–5× slower (§10).

A corridor query costs about
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
laptop over the Nauvo cells, against at most 16 ms within both limits.

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
A ring given in the request has at most 64 vertices, and at most 100 unexpired
acknowledgements are kept (`POST` answers 409 beyond that), since every warn and alarm tick
tests the footprint against each one's polygon. `GET /acks` is readonly; `POST` and
`DELETE /acks/:id` need readwrite, and `POST` a `Content-Type` of `application/json` or another
`+json` type, answering 415 otherwise. Signal K's `express.json()` turns a body of any other
type into `{}`, a valid request for the default acknowledgement, so a cross-site form could
otherwise store one with no expiry; an empty JSON body still asks for the default. They are
stored in `acks.json` in the plugin data directory, so no database dependency is added; each
write goes to a temporary file that is fsynced before the rename, with the directory fsynced
after it, so a power cut leaves the old list or the new one. A write keeps only the unexpired
acknowledgements. Export as Signal K notes is a follow-up. Suppression applies to the published
state after hysteresis, because it changes the state, not P. It never suppresses a negative mean
UKC within `certainWithin`: an acknowledgement covers an uncertain chart, not a charted depth
shallower than the keel. Nor does it suppress a warn or alarm on a tick whose position buffer is
capped (`capped` on the result, §4.8), whether the chart or the cap raised it: the capped
footprints understate where the vessel can be, so the rings an acknowledgement or zone is
tested on do too, and an acknowledgement covers an uncertain chart, not an untrusted position.
On other ticks a warn or alarm the chart raises is suppressed by the rules above. Mooring zones
are Signal K `regions` resources named in the configuration and suppress the same way, with the
zone's name in the reason. A zone matches the footprint rings alone, so it applies without a fresh
heading or COG, as at a berth; acknowledgements hold for a heading sector, so without a heading none
matches. A region whose ring is not closed is reported and not loaded: reading its last point as the
closing repeat would drop a vertex and could enlarge the zone.

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
starts after a 10-minute gap. On an index read block by block the prior is read only from a
loaded block, never from a block's stand-ins (§4.3), which can put it metres too shallow or
leave the cell uncharted. A cell whose block is not loaded is left unsettled: one restored or
rebased while unsettled has no prior and is not judged, and one first sounded while unsettled
keeps the stand-ins' prior, which is never deeper than the chart's. A background settler loads
those blocks one at a time, rebases the cells onto their chart priors in slices of 1 000, gives
their adjustments the current cell reference and judges them again; a block that cannot be read
is tried again at the next save check, and a rebind or stop ends the run. Its first slice runs
in the next turn of the event loop, never in the start, rebind or sounding that asked for it. A
rebind prepared in slices waits for each cell's block. Until a cell is settled it has no prior
and no cell reference (−1), so its adjustment names no ENC cell rather than the cell that number
had in another catalogue; its suspected-shoal note waits, and once a cell with an adjustment is
settled its note is brought up to date, which after a start rewrites each note once.
`GET /status` counts the unsettled cells (`livechart.unsettled`). A confirmed discrepancy sets a
z18 adjustment that every query takes beside the chart, through `minDepthOver` and the UKC tiles,
so look-ahead, route check, `/query` and the overlay all see it. Adjustments only ever lower a
cell; later deeper readings leave it as it is. Notes are written with
`resourcesApi.setResource("notes", …)`. A note is rewritten when the cell's adjusted depth drops
to a lower 5 cm step or its σ rises to a higher 1 cm step, at most once per cell every 5 minutes:
a change inside the 5 minutes is
written with the latest values once they are over, and on stop. The note shows the depth
floored to 5 cm and σ raised to the next cm, so it never shows the cell deeper or surer than
the posterior; the adjustment itself keeps the exact values. Adjustments are kept in
`livechart.json` beside the index, the cell posteriors in `cells.ndjson` and the last 20 000
accepted soundings in `soundings.ndjson` (no database dependency). Decision (user, PL1): the
save schedule is no longer "at most once a minute" for one file holding everything, which
rewrote 3.2 MB per save once the soundings filled, 192 MB/h of SD-card writes. Soundings are
appended to `soundings.ndjson`, one per line, every minute; once the file would hold more than
40 000 lines it is rewritten with the newest 20 000. Cells and adjustments are saved every
10 minutes, and within 10 s of an adjustment being added or moving a 5 cm depth or 1 cm σ step;
everything is saved on stop.

Decision (PL1 amendment, 2026-10-24): the cells are appended and bounded. With every cell
rewritten at each save and none ever dropped, a boat at anchor rewrote every cell it had ever
sounded every 10 minutes, and a start read a chart prior for each of them, which for a long
history blocked a Raspberry Pi 4 for seconds. One cell per line is appended to `cells.ndjson`
for each cell sounded since the last save, the last line for a cell holding it, and
`livechart.json` (zoom and adjustments) is rewritten only when those change, so a boat at
anchor writes about one line per 10 minutes. Once `cells.ndjson` would hold more than twice as
many lines as the larger of its cell count and 1 000, or after cells are dropped, it is
rewritten with the current cells. The posteriors are bounded: once more than 10 000 cells could
be dropped, the ones last sounded longest ago are dropped until 9 000 such cells remain, at the
10 s save check. A cell is never dropped while it has an adjustment, while it waits for its
chart block, or once it has read 1σ or more shallower than a chart prior it was judged against
(`PROTECT_Z`; a shoal waiting for its samples or its second pass), even after the index box has
moved away from it. Dropping a posterior never makes a query deeper: the adjustment is kept on
its own and only ever lowers the cell, and a dropped cell sounded again starts from the chart
prior (invariant 5). The one cost is that a later, deeper chart edition is not compared with
soundings that were dropped for agreeing with the chart. `GET /status` counts the dropped cells
(`livechart.dropped`).

The saves run on a 10 s timer, not in the depth-delta callback. A power cut can lose up to
10 minutes of posterior evidence that is not yet a discrepancy and up to 1 minute of soundings,
and an adjustment's lowering within its 5 cm step, never an adjustment added or moved a step
more than 10 s before. Each write is fsynced, file then directory, and a rewrite goes through a
temporary file and a rename. At start the adjustments apply at once; the cells are read without
computing any chart prior and wait, like cells whose chart block is not loaded, for the
settler, which moves them onto the current chart and judges them. `livechart.json` stays
version 1, so an older version still loads its adjustments and starts its posteriors afresh. A
`livechart.json` that holds cells (from a version that kept them there, or written while
`cells.ndjson` could not be) still loads; for a cell in both files the copy with more samples
is kept, and the cells stay in `livechart.json` until `cells.ndjson` has been rewritten whole.
A `livechart.json` from a version that kept the soundings in it still loads; its soundings move
to `soundings.ndjson` at the next save, and are written back into `livechart.json` with the
state until a log save holds them, since that file is their only copy until then. A failed save
is reported and retried at the next scheduled one, and a malformed file is skipped entry by
entry rather than stopping the plugin; a file that did not load whole (bad JSON, another
version, malformed entries, cells at another zoom, malformed `soundings.ndjson` or
`cells.ndjson` lines) is first renamed to `<name>.bad-<ms>` and reported, so no save overwrites
it, and if it cannot be renamed it is not saved over at all: a `cells.ndjson` that cannot be
renamed has its cells saved in `livechart.json` instead, and if `livechart.json` cannot be
renamed neither file is saved. A last `soundings.ndjson` or `cells.ndjson` line cut short by a
power cut is skipped and reported, and the file is rewritten whole at the next save. An empty
rewrite writes an empty file, not a lone newline that would read back as a malformed line.
`livechart.json` and each `cells.ndjson` line record their living-chart zoom; after a leaf-zoom
change the adjustments are mapped onto the new zoom (a coarser cell takes the lowest `dMin` and
largest σ of the cells in it, a finer cell copies its parent's) and the posteriors are dropped.
`GET /livechart/discrepancies` gives `charted: null`, and the note reads "(not charted)", for a
cell the index in use gives no depth, as after a rebind onto an index that does not chart it;
the adjustment stays. A cell still waiting for its chart block is marked `pending: true`
instead, its `charted` null because the chart is not read yet. The CSB export
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
admin login, and an extension page must load without one. A path that decodes to a NUL byte
names no page and goes on to the next handler, as any unknown path does. The bus client is
copied from `signalk-plotterext-bus` into `public/vendor/` at build time.

| Contribution                       | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| background `live` (runtime.html)   | fetches `/envelope` on each new `envelopeRev`, clears it after 10 s without one, on `off`/`unknown` or a failed fetch, and polls every 3 s without a Signal K stream or when subscribing to it fails; checks the routes on the chart on each `route.*` event (debounced 1 s), every 60 s and after a plugin restart, one route at a time with a 30 s timeout and again after `Retry-After` when the server answers 503 busy, drops the results of routes the host no longer lists and, for a hidden route, a re-check queued behind the running one, and writes the results to host state in compact form (per leg index, status, minimum UKC and P) once per re-check of all routes, the overlay still drawn when that write fails; refreshes the `ukc` tiles the plugin's change list names, polled every 15 s and after each 1 cm water-level move, all of them when the state enters or leaves `off`/`unknown` and after a restart, and while the list does not answer all of them on a 1 cm fall or 10 cm rise of the water level or a change of its source; fetches nothing while the page is hidden, and on return withdraws the envelope until a current one arrives and asks for tile changes and route checks at once |
| overlay `lookahead`                | envelope fill, outline, dashed central track and the worst footprint, coloured by state                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| overlay `routecheck`               | route legs coloured `ok` / `marginal` / `fail` / `unverified`; every leg of a result older than 3 min, or without a receipt time, `unverified`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| overlay `ukc`                      | the M3 UKC tiles, off by default                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| widget `status` (2×1)              | state colour, minimum clearance in the host's depth unit, time to shoal and the reason; a tap opens the panel                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| panel `details`                    | advisory note, state, water level, the WFS notice when that source is on, and a leg table per route with its age and re-check; a result older than 3 min reads "out of date"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| button `open-details` (mapToolbar) | toggles the panel                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

`requires` is empty: on a host without a capability, the page that needs it shows less and
says so.

**UKC tile refresh.** A tile's classes hold over a range of the threshold depth: each cell's
class changes only where P crosses the alert or warn level, and P rises with the threshold
(invariant 2). The tile route records, per tile served, the range over which every copy
served is right (to 1 µm short of each crossing). Each tile is drawn at one of two water levels,
inside the level source's reach or beyond it (§4.5). `GET /tiles/ukc/changes?epoch=&rev=` lists,
since the client's cursor:

- the tiles whose range the threshold of their own level has left;
- the tiles in which an own sounding changed a cell;
- the tiles that a moved forecast point carried across the reach edge;
- the tiles within the store's widest chart reach of a pyramid block loaded or dropped after
  the tile was drawn (a tile drawn while its block was out read the block's stand-ins, §4.3). A
  small block the tile's own drawing read on the spot loaded before the tile was served, so it
  does not list that tile; a large block read off the event loop finishes later and does.

Any other tile input changing answers `all`: σ, risk levels or the fallback flag of either
level, the reach appearing or going, or the index. A restarted server, or a cursor older than
the 4096 tiles kept, also answers `all`. The runtime refreshes exactly those tiles. A tile left
unlisted is byte for byte the tile the server draws now (`__tests__/ukc-tile-feed.test.ts`).

**UKC tile chart position.** A slot takes the class a query there would give it from the cells
around it: each cell's P weighted by Φ(−g/σP) for its gap g to the slot (§4.3), and an
unverified cell's flags within 2σ of its survey. Each cell beyond a slot's own is a source;
when a tile is drawn, a source of risk P raises to danger the slots where P·Φ(−g/σP) reaches
the warn level, and to caution where it reaches the alert level. Along a row the gap is the
larger of a rising and a falling term, so each such set is one run, found from its ends. A
slot raised above its own cell's class carries `reach`, and the style draws it fainter: the
solid classes are the chart's own, the faint ones its position uncertainty. The threshold
range of a drawn tile (below) also keeps each source's P between the levels that would move
a run end: at least level / Φ(−g_in/σ) for the widest gap raised, below level / Φ(−g_out/σ)
for the narrowest left.

Of nine or more sources of one kind, σ and scale, one whose ring of slots all round is covered
by the others of its group is left out, since it raises no slot they do not. That pass holds
only the slots within the group's chart reach of the tile, at most `EDGE_MARGIN` = 1024 slots
past each edge, so a coarse leaf beside fine ones costs no more than the tile's reach: held
whole, the slots of an unsplit z10 leaf beside a z18 tile would take about 300 MB. A source
whose ring leaves that window is kept, which never lowers a slot.

**UKC tile geometry cache.** The cells of a tile, its sources and the flag-reach slots of each
unverified cell do not depend on the water level, draft or σ, so the tile route keeps them per tile in
typed arrays (`UkcTileCache`, least recently used first out beyond 8 MiB) and a request only
classes the tile's value kinds and draws. The cache holds for one `NodeStore`: another store
(a handover or a WFS rebuild) empties it. Every write to `NodeStore.adjustments` bumps its
`revision` in the same call; an entry whose revision is behind compares the living-chart
cells in its tile with those it was walked with and is walked again when they differ, so a
cached tile never shows water deeper than an own sounding (invariant 5). A block loaded or
dropped since the last request drops every entry within the store's widest chart reach of it.
A walk that itself reads small blocks on the spot keeps its own entry, which saw them loaded,
and drops the other entries over those blocks, which saw their stand-ins. Cached and uncached
tiles equal the walk they replaced byte for byte (`__tests__/engine/ukc-tile-cache.test.ts`).

**Decision (BR3a, approved).** When the change list does not answer, the runtime refreshes
every tile on a 1 cm fall of the water level but only on a 10 cm rise. A tile kept stale by a
rise was drawn for lower water, so it shows equal or more danger than the truth. The rule reads
`navigation.underKeel.waterLevel`, the level at the vessel, not the level beyond the source's
reach (§4.5).

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

| Operation                       | Budget (Pi 4)      | Notes                                                                                                                                                 |
| ------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Look-ahead tick                 | < 20 ms            | 5 members × ~40 footprints; pyramid culling                                                                                                           |
| Envelope payload                | < 15 kB            | quantised coordinates, only on `rev` change                                                                                                           |
| Route check, 30 legs            | < 300 ms           | parallel legs in worker                                                                                                                               |
| Interactive leg re-check        | < 80 ms p95        | only the edited legs; abort on new input                                                                                                              |
| Repair, one leg                 | < 1.5 s            | bounded window; 600 000 work units per leg, 1 800 000 per request (§4.11); calibrate µs per unit on a Pi 4 with `npm run build`, then `npm run bench` |
| Index build, full Finnish coast | < 15 min, one-time | worker thread; incremental on ENC updates                                                                                                             |
| Index RAM                       | < 150 MB           | pyramid blocks read on demand, 32 MB cache                                                                                                            |
| Living-chart start              | < 200 ms sync      | ≤ ~20 000 `cells.ndjson` lines; no chart prior; cells settled in slices (§4.13)                                                                       |

---

## 7. Testing and validation

**Unit and property tests (plugin: Jest + fast-check; Freeboard: vitest, per its repo).**

- Pyramid conservativeness invariant (§4.3).
- Monotonicity checks: deeper draft never lowers P; a lower water level never lowers P;
  a larger σ_pos never lowers P.
- CTRV trajectory against analytical arcs.
- Datum reduction tables.

**Test runtime (decision).** `npm test` stays hermetic and under 120 s in band, because the
Signal K plugin registry runs it with no network, `SIGNALK_REGISTRY_TEST=1` and a 240 s cap. No
safety test is skipped or given fewer fast-check runs for speed: every property test, the replay
and the invariant suites run at full depth in every run, the registry's included.

- Jest runs each test file in a vm context. The stock `jest-environment-node` builds that
  context from a Proxy, so every global lookup in the chart and engine hot paths (`Math`,
  `Number`, typed arrays) passes through an interceptor: the replay test took about 70 s for
  code that runs in about 4 s in plain Node, and the suite about 4.5 minutes. The tests run in
  `__tests__/helpers/node-realm-environment.js`, the same environment built on a
  `vm.constants.DONT_CONTEXTIFY` context (Node 22.8 or later; on an older Node it is the stock
  environment). It throws if Jest stops building its context with one `vm.createContext` call,
  and `__tests__/test-environment.test.ts` checks that it is active. `jest-environment-node` is
  a direct dev dependency. On an i5-8350U laptop the suite's 1086 tests take about 51 s and the
  replay test about 3 s.
- A test may make at most 20 000 `expect()` calls (`__tests__/helpers/assertion-budget.ts`),
  since each costs about 30 µs. Per-element checks inside property loops are collected and
  asserted once, with the same predicate, so a violation still fails inside the property and
  shrinks. The target is 5 000; six property tests still assert per element (up to 13 640
  calls in `node-store.test.ts`, about 9 600 in `envelope-notify.test.ts` and
  `geometry.test.ts`) and must be rewritten before the limit drops.
- `__tests__/helpers/budget-reporter.js` prints the ten slowest files and the wall time. When
  `UNDERKEEL_TEST_BUDGET_S` is set it fails the run past that many seconds; CI sets 120 on
  `npm run verify`.

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
7. Do the route repair work limits hold on a Raspberry Pi 4? `maxWork` 600 000 and
   `maxRequestWork` 1 800 000 (§4.11) come from laptop rates (0.34–0.66 µs per unit in plain
   Node on an i5-8350U) and an assumed 3–5× Pi 4 slowdown, so on a Pi 4 600 000 units may take
   0.6–2.0 s. `docs/release-checklist.md` runs `npm run build` and then `npm run bench` on a
   Pi 4 before a release that changes route repair, the pyramid or the corridor check, and
   lowers both limits together, in the same ratio, if the worst µs per unit × `maxWork` exceeds
   1.5 s.
8. How should the living chart weigh soundings against the chart (§4.13)? Two faults found in
   review are not fixed yet:
   - The update treats each sample's error as its own. A sounding's σ is
     `0.1 + 0.01 · depth + σ_water level`, but the transducer offset, sound speed and water
     level errors are shared by a pass's samples. So the posterior σ shrinks as √N within a
     pass. A steady 0.1 m forecast error then marks a cell protected after one pass, which
     breaks the retention bound on a flat bottom at its charted depth. Over enough passes it
     also raises a suspected-shoal note.
   - A tight chart prior swamps the soundings. Against an 8 m ± 0.1 m chart, six readings at
     6 m move the posterior only to 7.56 m. That is what an adjustment would apply, although
     the soundings say 6 m.
   - Candidate, to be decided here before any change: judge a cell by its soundings' own
     evidence against the chart, with the shared error not averaging below one sounding's σ
     over √passes. Adjust to the evidence, never deeper than the chart.

---

## 11. First tasks (ready to open as issues)

**Plugin**

- [ ] `signalk-underkeel`: scaffold the plugin and JSON-schema config. `/status` returns the
      engine state `off`.
- [x] S-57 ingest: `.000` and updates read in place with gdal3.js, with `cells.json` provenance.
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
