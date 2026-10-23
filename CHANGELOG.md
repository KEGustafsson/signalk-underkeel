# Changelog

All notable changes to signalk-underkeel are documented here.

## [0.1.0] - Unreleased

### Added

- S-57 ENC cells are read as delivered: **ENC cells directory** takes `.000` files with their
  `.001`, `.002` … updates, also inside an exchange set's `ENC_ROOT` folders, read in the index
  worker with gdal3.js (GDAL compiled to WebAssembly), now a runtime dependency. No export step
  and no intermediate files. A saved
  index is kept while each cell's files keep their names, sizes and modification times. The
  edition comes from the base cell's DSID, since GDAL reports 0 once NOAA updates are applied.
  The 12 NOAA cells around Miami build in 19 s at leaf zoom 18 on x86.
- App Store screenshots: `package.json` lists six of the docs images under
  `signalk.screenshots`, and the package ships them and the README illustration.
- `GET /status?summary` leaves out `index.cells` and `waterLevel.datums`, which grow with the
  cells: 22.7 kB with 300 cells against 237 B. It keeps every field the Freeboard panel and
  runtime read.
- Freeboard UI as Plotter Extensions contributions, served from `/plotterext/signalk-underkeel/`:
  a background runtime, look-ahead and route-check data overlays, a status widget, a details
  panel and a toolbar button. Freeboard core is unchanged.
- Traficom WFS depths (off by default): depth areas and soundings for a box around the vessel,
  re-downloaded as it moves and indexed in a worker thread, as a band-1 cell flagged
  `NOT_FOR_NAVIGATION`; water it alone covers is never `normal`, `ok` or `clear`.
- Survey quality at zone boundaries: a leaf across the shared edge of two assessed `M_QUAL`
  zones takes the worse zone's σ instead of the unassessed σ and flag, when the zones share
  the edge vertex for vertex. Gaps, overlaps and differently split edges stay `UNASSESSED`.
- Proposal: JSON Schemas `csb-cell.json` and `csb-cell-set.json` and an RFC draft for
  aggregated crowdsourced depth cells. This release adds no crowdsourced-depth ingest.
- Contract (M6): JSON Schemas of the navigation-safety contract in `schemas/navigation-safety/`,
  contract tests for this plugin and a stub second provider, and RFC drafts for the Signal K
  paths and the Plotter Extensions `services` section.
- Route repair and departure window (M5): `POST /route-repair` suggests waypoints around
  failing legs (Theta\* on a lazy cost grid, simplified only where legs still pass);
  `POST /departure-window` returns the departures over the horizon in which every leg is ok.
- Living chart (M5, off by default): own soundings through a quality gate and datum reduction
  update per-cell posteriors; two-pass discrepancies lower the cell for every query and
  become Signal K notes; `GET /livechart/discrepancies` and an IHO CSB export.
- Dynamics (M4): CTRV fan of five members scored as one hull per step, GNSS-based position
  σ, along-track footprint growth, escape heading (`navigation.underKeel.escapeHeading`) and
  state hysteresis.
- Position integrity (M4): dead reckoning from heading, speed through water and a learned
  current against GNSS; divergence, a poor fix or HDOP above 4 inflate σ_pos and raise
  `notifications.navigation.positionIntegrity`.
- Acknowledged passages (`GET/POST/DELETE /acks`) and mooring zones from Signal K regions,
  which publish warn and alarm as alert with the reason (M4).
- Optional grounding detector, off by default, the only writer of `notifications.grounding`
  (M4).
- Probabilistic UKC (M3): P(UKC < 0) per footprint from CATZOC σ, draft, Barrass squat, heel,
  wave allowance and water level; risk thresholds for alert / warn / alarm; an explanation
  object on every notification and route-check leg; `clearanceSigma` and `risk` deltas.
- Water-level sources (M3): manual, Signal K tide and FMI forecast with tide-gauge blending;
  per-cell vertical datum mapping; chart-datum fallback with a reason after 30 minutes stale.
- `POST /query` for point and polygon UKC, and UKC vector tiles with a MapLibre style,
  declared as a `plotterExtensions` data overlay (M3).
- Deterministic look-ahead (M1): straight cone along COG, chart-datum UKC with a fixed margin,
  `navigation.underKeel.*` deltas, `notifications.navigation.underKeel`, `GET /status`,
  `GET /envelope`, and a `plotterExtensions` manifest resource.
- Corridor route check (M2): `POST /route-check` with per-leg `ok` / `marginal` / `fail` /
  `unverified`, ETAs, the shallowest charted depth and hazard, and chart-edition provenance.
- Development plan in `docs/DEVELOPMENT-PLAN.md`.
- Chart index library: S-57 GeoJSON ingest with cell provenance, CATZOC → σ table,
  min-depth pyramid with a fast-check conservativeness property test, hazard R-tree, and
  on-disk index format.

### Changed

- `scripts/enc-to-geojson.sh` is removed and **ENC cells directory** no longer reads its GeoJSON
  folders: it reads the original `.000` cells. A folder named like a cell without one is
  reported as skipped. The plugin test fixtures are now S-57 cells written by
  `fixtures/s57/generate.js`.
- Chart position is graded (plan §4.3). A charted object beyond a footprint and its buffer
  counts with its P(UKC < 0) times Φ(−g/σP), the chance the chart is off by its distance g,
  instead of in full within 2σP. The depth reported under a footprint is the depth charted
  there, so a route leg no longer fails on land within 500 m of a CATZOC C shore, and points in
  assessed water are no longer burned as discs. Flags still count within 2σP.
- Land and shoreline objects are placed by their own accuracy: the cell's compilation scale,
  or the survey's σP on edges and nodes whose QUAPOS says they are not surveyed.
  `scripts/enc-to-geojson.sh` exports those records as `QUAPOS.geojson`; cells exported
  without it keep the survey's σP for their shoreline.
- UKC tiles mark cells raised only by a nearby cell's chart position with `reach`, which the
  style draws fainter, so the solid classes follow the chart's own depth areas.
- Explanations of a deciding tile beyond the footprint give its distance, its position σ and
  the chance it lies under the keel.
- A look-ahead footprint scored beyond the warn window covers the hulls of the steps it skips,
  so in a turn its P is never below scoring every step.
- The index splits tiles no finer than 1 mm at each cell's compilation scale: an overview
  cell's coastline stops at z14 instead of z20. The 25 NOAA cells around Miami build in 94 s
  instead of over 15 minutes; a stopped tile takes the shallowest depth it holds.
- Pyramid format version 8: an index built by an earlier version is rebuilt at start.
- A Traficom WFS refresh builds only the z10 index roots that the old or new box reaches, or a
  cell with a new DSID, and copies the other roots from the saved index, which now keeps each
  cell's reach in `reach.json`; the result is byte-identical to a full build. With 16 copies of
  the Nauvo pair (32 cells) and the real 10 km box moved 5 km, the refresh built 4 of 12 roots:
  30.8 → 11.8 s of worker time at leaf zoom 20 and 5.6 → 2.7 s at 18 on x86. Where both boxes
  reach every ENC root, as with the Nauvo pair alone, every root is still built.
- The Traficom WFS download asks each layer's count first (`resultType=hits`), then reads its
  pages sorted by `IDENTIFIER`, up to 4 requests at once across the three layers. A box whose
  count is over 50 000 features is refused before any page is fetched, and a layer whose pages
  hold more or fewer features than the count, or the same feature twice, fails the download.
  Against the live server the same features came in 5.6 s instead of 8.6 s for a 10 km box off
  Helsinki, 13.1 s instead of 19.3 s for 10 km at Nauvo and 30.4 s instead of 81.7 s for 25 km
  at Nauvo.
- The gdal3.js ENC reader converts only the layers the index
  reads, one `ogr2ogr` to in-memory GeoJSON each, with the unsurveyed-edge filter run in GDAL,
  instead of one `ogrinfo -json -features` of every layer: 2.0–2.9× faster on 12 NOAA cells
  with the same features (US5FL61M 4.2 → 1.6 s, 510 → 270 MB RSS). It finds its WebAssembly
  files from the package location rather than the working directory, and a cell GDAL cannot
  open rejects with an `Error`.
- The index built in a worker, at start or for a WFS box, is posted to the main thread with its
  pyramid columns moved, not copied, instead of being read back from disk: the longest
  event-loop block at the handover fell from 52–61 to 21–23 ms for the Nauvo pair and a 10 km
  box at leaf zoom 20, and from 258–292 to 68–97 ms with 32 cells, on x86.
- UKC tiles keep each tile's cells and neighbour reach between requests, in typed arrays up to
  8 MiB, and re-class only the few value kinds of a tile after a water-level move; the cache
  is emptied by a new index and a tile is walked again when an own sounding changes a cell in
  it. A 40-tile z14 view over the Nauvo cells refreshes in 29 ms instead of 86 ms on x86, and
  a tile the change feed lists after a 1 cm fall takes 0.74 ms instead of 2.35 ms (p50).
- `pyramid.bin` (format version 6, rebuilt once) holds the zooms to 15 in one gzip member and the
  finer nodes in one member per z12 tile, and a loaded index reads those blocks when a query
  first reaches them, keeping up to 32 MB of them and those around the vessel and 300 s ahead
  on its course. A block not loaded reads as no coverage with bounds no loaded tile exceeds, so
  no answer is ever safer than with it loaded. 64 copies of the Nauvo pair (13.5 M nodes) on
  x86: RSS after start 579 → 94 MB, a 150 km passage at 10 m/s peaks at 154 MB instead of
  602 MB with identical states on all 15 000 ticks; the first tick reading a block takes 13.5 ms
  (8.5 ms held whole), steady ticks are unchanged.
- The index build in the worker builds the pyramid one z10 root at a time, from only the cells
  reaching it, on up to four threads, with output byte-identical to a build of all cells at
  once. Sixteen copies of the Nauvo pair (3.3 M nodes) on x86: peak RSS 817 → 481 MB on one
  thread; 27.6 → 13.4 s on three threads (974 MB). The default is one thread per core but one,
  at most four and at most one per GiB of RAM.
- The hazard R-tree is packed in typed arrays: 1 M soundings take 47 MB of tree instead of
  289 MB and build in 1.3 s instead of 3.1 s on x86. Hazards at the same depth and distance from
  a query are listed in catalogue order.
- The pyramid's node store is a sorted tile-key column per zoom level instead of a `Map`, and
  `pyramid.bin` is written in that order, so loading uses the inflated
  columns in place. Two Nauvo cells: load 101 → 22 ms, resident +43 → +16 MB; the same 16
  times over (3.3 M nodes): load 2.4 s → 0.24 s, +490 → +148 MB, lookup 524 → 135 ns. A store
  is no longer limited to the 16.7 M nodes of a V8 `Map`.
- `pyramid.bin` stores its columns gzip-compressed, 13× fewer bytes written to the SD card per
  rebuild (7.5 MB → 0.56 MB for two Nauvo cells at leaf zoom 20); an index saved by an earlier
  version of the plugin is rebuilt once at start.
- The index build tests each area against a tile through a per-polygon box and edge grid and
  decides "reaches" and "contains" in one boundary pass, with the same nodes byte for byte:
  two Nauvo cells at leaf zoom 20 build in 1.9 s instead of 23.4 s on x86.
- The living chart moves onto a rebuilt WFS index in slices of 1 000 cells, one turn of the
  event loop each, with the index swapped in during the turn that finishes the move; when only
  the WFS cell changed, only the cells near the old and new box are re-judged. With 19 574
  cells the handover blocked the event loop for 123–153 ms on x86 at leaf zoom 18; the longest
  block is now 53–71 ms.
- The next Traficom WFS box is fetched once the edge ahead is closer than SOG × 1.5 × the last
  download-and-build time plus the look-ahead's reach, as well as at half the radius, and is
  centred that far ahead along COG (at most 0.8 × the radius). With 10-minute rebuilds at
  25 kn the vessel was 5.4 km past the old box when the new one was handed over; it is now
  2.3 km inside it. The last refresh time is saved in `box.json`.
- The Traficom WFS download, parse, clip and cell write run in the index build worker with the
  build, so the main thread only moves the staged index into place and loads it. With the
  10 km box (one 22 MB page) the server's event loop was blocked for 336–420 ms and 209–277 ms
  per refresh on x86; now the longest block is the 67–83 ms handover.
- Living-chart saves: the accepted soundings are appended to `soundings.ndjson` every minute
  (rewritten with the newest 20 000 when it reaches twice that), and `livechart.json` holds the
  cells and adjustments, written every 10 minutes and within 10 s of an adjustment being added
  or moving a 5 cm or 1 cm σ step. Saves run on a timer instead of inside the depth-delta
  callback. Before, `livechart.json` with all 20 000 soundings was rewritten every minute:
  192 MB/h of SD-card writes and a 20–46 ms save in the delta callback. A `livechart.json`
  that still holds soundings loads, and they move to `soundings.ndjson` at the next save.
- Living-chart notes are rewritten when the cell's adjusted depth drops a 5 cm step or its σ
  rises a 1 cm step, at most once per cell every 5 minutes (the latest values after that, and
  on stop), and show the depth floored to 5 cm and σ raised to the next cm. Before, every
  change of the adjustment rewrote the note: 6 240 note writes in a 2 h simulated run.
- UKC vector tiles of 1 kB or more are sent gzipped with `Content-Encoding: gzip` when the client
  accepts it, and every tile carries `Vary: Accept-Encoding`; Signal K's compression skips the
  vector-tile type. A 40-tile z14 viewport over the Nauvo cells went from 279 kB to 52 kB, at
  0.19 ms of gzip per tile on a laptop.
- Route checks, repairs, departure windows and `POST /query` run one at a time, with at most four
  waiting and 503 with `Retry-After` beyond that; a request whose client disconnects, or that is
  running when the plugin stops, is abandoned at its next pause. Ten concurrent repairs of a
  100-leg route over the Nauvo cells delayed the event loop by up to 264 ms on a laptop (about
  1 s on a Raspberry Pi 4) and now by at most 28 ms; abandoned requests ran to the end, holding
  the old chart index after a stop.
- Route repair yields to the event loop every 256 cells its search expands and after each
  simplification check, not only between legs. A search that exhausts its grid around an
  enclosed goal blocked the server for 105–109 ms on a laptop (about 0.4 s on a Raspberry Pi 4);
  its longest slice is now 3.4–5.2 ms.
- Route checks split a leg into pieces of max(1 km, 4 × corridor half-width) instead of 1 km,
  and check the great circle separately only where it strays more than max(10 m, r/4) from the
  rhumb line. A 12 km leg at xteLimit 2000 took 129 ms on a laptop and takes 39 ms; four such
  legs 402 → 115 ms. Corridors at the default width are unchanged in number.
- The departure window stops checking a departure at its first failing leg, whose status the
  remaining legs cannot change. On a 100-leg route over the Nauvo cells that fails early,
  9 991 leg checks and 1.9 s became 91 checks and 54 ms on a laptop, with the same steps.
- The departure window reuses a leg's `ok` at any higher water level and its `fail` at any lower
  one, with the same σ, when `probability` is at least 1e-3; below that each level is checked
  directly. A 60-leg route over a 24 h ramp went from 3 793 leg checks and 347 ms to 2 219 and
  212 ms on a laptop, with the same steps.
- The navigation-safety contract schemas in `schemas/navigation-safety/` are licensed under
  Apache-2.0, so other plotters and providers can adopt the contract; the plugin stays EUPL-1.2.
- The request schemas bound `sector` (1..90°), `ttl` (1 s..30 days), `notificationId` (200
  characters), speeds, drafts, `bufferMetres`, `xteLimit` and `probability` as the plugin
  does, so a request that validates is no longer refused for those fields; size budgets are
  listed in `schemas/navigation-safety/README.md`.
- Look-ahead and query tile walks measure distances with `Math.sqrt` instead of `Math.hypot`,
  widen every reach by 1e-12 so a 1-ulp rounding can only add a tile, and reuse one tile
  rectangle and result per walk. On the Nauvo test route at 6 kn the tick median fell from
  2.6 to 1.7 ms and p95 from 7 to 3.9 ms (x86), with the same states, risks and footprints on
  all 2296 ticks.
- A look-ahead footprint stops reading the chart once it finds charted land at P = 1, and is
  read again in full only where the state turns on its coverage. Alarm ticks on the Nauvo route fell from 2.6
  to 2.2 ms median, and a tick after a 2 km GNSS jump from 770 to 270 ms (x86).
- Look-ahead hull rectangles compute each point's ellipsoid scale and each bearing's sine and
  cosine once instead of in six `project()` calls, with the same coordinates: footprint geometry
  0.25 → 0.21 ms per 6 kn tick (x86).
- Beyond the 120 s warn window the look-ahead scores only every k-th step, the most that still
  leaves neighbouring footprints touching (every 3rd at 6 kn, every 20th at 1 kn), and scores the
  skipped steps where one of those footprints is the first to reach P 5 %, P 1 % or a coverage
  gap, so `timeToShoal` and the reason keep the 3 s time. On the Nauvo route at 1 kn a tick
  scores 57 footprints instead of 361, the median fell from 30 to 2.7 ms and the envelope from
  17 to 5 kB (x86); states, risks, clearances, times to shoal, reasons and escape headings were
  the same on every tick at 1 kn, 6 kn and with a 5 NM horizon (90 → 20 ms).
- `GET /envelope` drops outline vertices within 1 cm of the line through their neighbours. With
  a 5 NM horizon (400 footprints) the envelope fell from 19.5 to 3.5 kB median and 21.4 to
  5.6 kB at most, back within the 15 kB budget; at 6 kn from 4.1 to 2.5 kB.
- The escape heading is searched after the tick's deltas are published, so a tick blocks the
  server in two shorter pieces; after a tick or search over 250 ms the next search is skipped
  and the plugin status says so. With a 5 NM horizon the longest tick fell from 264 to 185 ms
  (x86), the search following in up to 27 ms.
- `notifications.navigation.underKeel` is sent at once when its state, the kind of reason or the
  named hazard changes, and while those hold its message with a new countdown at most every 30 s.
  The countdown in the message made it go out every 3 s: on the Nauvo route at 6 kn 365
  notifications in 2296 ticks with 28 state changes, now 77.
- `navigation.underKeel.*` values other than `state` and `envelopeRev` are sent when they change
  and at least every 10 s, and the plugin status only when its text changes. On the Nauvo route
  at 6 kn the values sent fell from 18 733 to 7 063 in 2296 ticks (507 → 203 B per tick), and
  `setPluginStatus` calls from 2297 to 329.
- Below the low speed `navigation.underKeel.envelopeRev` no longer bumps while GPS noise moves
  the drawn envelope less than 5 m and no class or number in it changes. At rest with 1 m of
  position noise it bumped on 599 of 600 ticks, so every Freeboard fetched the envelope and
  redrew its overlay once a second; now 0 (153 with 2 m of white noise).
- The look-ahead buffer k_p · σ_pos stops at 500 m. Beyond that the state is at least `warn`
  with the reason "position uncertainty N m" and the integrity monitor's reasons, and no escape
  heading is searched. After a 2 km GNSS jump in water without land a tick took 0.4 to 3.2 s
  (x86) and could still read `normal`; it now takes 3 to 27 ms and reads `warn`.
- A depth query no longer tests the tiles under a tile that lies wholly within its buffer of
  the footprint or polygon. A 499-vertex `POST /query` polygon of 500 m radius with a 2 km
  buffer took 198 ms, now 48 ms (x86); jagged polygons gain nothing (124 → 128 ms).
- The status widget changes the page only when a value it shows changes. With three Signal K
  values a second and steady readings it made 549 DOM changes and 99 layouts a minute; now
  none.
- The extension pages, scripts and styles under `/plotterext/signalk-underkeel/` carry an ETag
  and are answered 304 when the browser holds them, still with `Cache-Control: no-cache`. A
  Freeboard reload fetched 56.2 kB of them and now 12.7 kB; a first load 57.5 kB and now
  36.3 kB, since the three pages share four scripts.

### Fixed

- The chart index is built in a worker thread at start too, as it already was for Traficom
  WFS boxes; meanwhile the engine is `off` with the reason `building chart index`. `start()`
  built it on the main thread, which froze the whole Signal K server for 24 s with two Nauvo
  cells at leaf zoom 20 on x86 (about 1.5 min on a Raspberry Pi 4) on the first start, after a
  cell or format change and when the WFS source was toggled. A saved index over 1 MB is read
  and inflated off the event loop too (`off` with `loading chart index`): 3.3 M nodes blocked
  `start()` for 2.2 s, now 6 ms and at most 50 ms per event-loop turn.
- A saved chart index whose files cannot be read or parsed is rebuilt from the configured
  cells at start, with the read error in the index reason. An index left empty by a power cut
  during a save kept the engine `off` with "chart index failed: Unexpected end of JSON input"
  on every later start until **Rebuild index at start** was set. Index files and their
  directories are now fsynced before and after the rename that commits them.
- The index build worker runs with a heap limit of a quarter of the RAM (256 MB to 2 GB);
  its root threads, on machines with 2 GiB or more, share a second limit of the same size.
  An oversized build fails with "index build stopped at the N MB worker heap limit" in the
  WFS status and the previous index stays in use; before, it could grow until the kernel ended
  the Signal K server on a 1 GB Pi 3 or Cerbo GX. A worker that exits without a result now
  fails the build instead of leaving the WFS refresh busy for good.
- `acks.json` and `livechart.json` are flushed to the disk before the rename that replaces
  them, and their directory after it. Without the fsync a power cut could leave an empty
  `livechart.json` on filesystems that do not flush on rename, and the plugin then started
  without its confirmed shoals.
- Route-check corridors contain every point within the corridor half-width of the leg. They
  were drawn with a spherical bearing in the ellipsoid's tangent plane and missed points at the
  edge by up to 0.3 % of the width (0.12 m at the default ±40 m at the equator); they are now
  drawn on the ellipsoid's bearing and 1/256 wider. Over the Nauvo cells 1 of 609 legs at the
  default width went from `marginal` to `fail` (a 0 m depth area now in reach).
- `POST /query` is also refused when the polygon's vertices times its box widened by the buffer
  exceed 150 km². A 499-vertex ring with a 2 km buffer fitted the 25 km² limit and blocked the
  server for 0.47 s on a laptop (about 2 s on a Raspberry Pi 4); within both limits the slowest
  query measured over the Nauvo cells took 16 ms.
- An index build stopped mid-write, by an abort or a crash, no longer leaves its half-written
  staging directory beside the chart index for good: an aborted WFS build removes its own once
  the worker has exited, and loading an index removes any staging directory left by a
  process that has exited.
- Route check: long legs are checked along the rhumb line as the chart draws it, and along
  the great circle where that strays more than 10 m from it. Pieces were stepped on a fixed
  flat-earth bearing, which drifted 75 m off the drawn line on a 78 km leg at 60° N and left a
  12.9 km last piece on a 485 km leg.
- The look-ahead, route check, route repair and `POST /query` count each index tile within
  their buffer plus k·σP of that tile's assessed survey (k = k_p for the look-ahead, 2 for the
  rest, at most 1 km), since depth areas and lines are not widened when the index is built;
  unassessed and not-for-navigation water adds none and stays `unverified`. A drying area 60 m
  off a leg or a footprint in CATZOC B or C water returned `ok` or `normal` with P = 0, and a
  poor survey anywhere in reach no longer widens the buffer for a well-surveyed rock. A leaf
  only partly in an assessed survey, at a coverage edge or between a B and a U zone, keeps the
  reach of its assessed part.
- UKC tiles draw each cell at least as bad as any cell within 2·σP of its assessed survey, the
  reach a route check counts: water 60 m from a drying area in CATZOC B or C water was drawn
  `clear` while a route check there failed.
- `GET /envelope` and own soundings keep longitudes in [-180, 180]: near the antimeridian the
  look-ahead track and segments ran past 180° and are now cut there into features with the same
  properties (RFC 7946), and a transducer lever arm across 180° stored 180.00004° E, which the
  living chart counted in the cell west of 180° instead of the one east of it.
- Route legs take the water level at their own ends: with FMI, a leg more than 30 km from the
  forecast point gets the fallback level (chart datum, or the last level when lower) and is
  never `ok`, instead of taking the level forecast at the vessel.
- Departure window: each leg takes the lowest water level until one step after it is sailed,
  so a coarse step no longer reports a window across a low water it did not sample (a 12 h
  step over a semidiurnal tide returned a 24 h window in which a +6 h departure failed).
- Route repair checks each leg at the time the detours before it bring the boat there, and
  returns the whole repaired route re-checked as `route`. A detour delays the later legs, which
  were reported with their old status although a falling tide could make them fail.
- Route checks yield to the event loop after each corridor query and are refused above 200 km²
  of corridor (route length × 2 × (xteLimit + planning buffer)); the departure window budgets
  departures × corridor area (1600 km²) instead of departures × length; `POST /query` is refused
  above 25 km² of box and buffer. A 1000-point, 490 km route at xteLimit 2000 blocked the
  server for 2.8 s, and a 500-vertex query with a 2 km buffer for about 1 s.
- A route request's `departure` must be within a year of now; a far-future time such as
  `+275760-09-13T00:00:00.000Z` parsed and then failed with a `RangeError` message.
- `navigation.underKeel.clearance` is published as `null` when the look-ahead reaches land,
  never `-Infinity`. In-process subscribers such as signalk-to-influxdb received the raw
  value and the database refused the write; no published number is now NaN or infinite.
- Two cells meeting at ±180° now cover the index leaves on that edge; read as a shared edge,
  every leaf there was `NO_COVERAGE` and `UNASSESSED`, so any leg or footprint touching 180° was
  `unverified` and a repair across it found no path. A cell ending at 180° with nothing past it
  still leaves a gap. Route repair also takes longitudes the short way round, so its search grid
  across 180° covers the leg instead of the whole world, and `POST /route-check`,
  `/route-repair` and `/departure-window` accept legs across ±180° instead of refusing them.
- Depth queries near the antimeridian also read the tiles at the other end of the world: a
  footprint or position buffer reaching past ±180° used to miss a rock a few hundred metres
  away on the other side, and a footprint drawn wholly past 180° returned no depth and no flag.
- A rock or sounding charted inside a swept area keeps its survey's depth σ. The swept σ of
  0.1 m applied to every tile in the area, so a CATZOC C rock 4 m deep in an 8 m swept fairway
  read P(UKC < 0) = 0.08 % instead of 19 % for a 3 m threshold.
- A footprint on the shared edge of two adjacent cells of one usage band is covered. Each cell's
  `M_COVR` alone held only part of the index tile on the edge, so the tile read `NO_COVERAGE`
  and route legs along every seam came back unverified.
- Position buffers, burn discs and footprint offsets reach their full distance on the WGS84
  ellipsoid. They were sized on a sphere and fell short north–south below about 55° latitude,
  by up to 0.7 % at the equator (a 100 m buffer reached 99.3 m).
- Pontoons, floating docks and hulks (`PONTON`, `FLODOC`, `HULKES`) are read as land, and
  unsurveyed areas (`UNSARE`) as having no depth, so a route leg there is unverified and the
  look-ahead is never normal. `scripts/enc-to-geojson.sh` exports these layers. Before, such an
  area inside a cell's coverage took the depth of any nearby sounding's burn disc; now any
  covered place no depth area reaches has no depth.
- The saved pyramid format is now version 3, with a column for each node's assessed survey σP,
  and a saved index of an older version is rebuilt at start when cells are configured, so an
  index built before the fixes above is not reused.
- A rock, wreck or obstruction without `VALSOU` that covers and uncovers (`WATLEV` 4) or is
  subject to inundation (`WATLEV` 6) counts as land, like `WATLEV` 1 and 2. It was taken as
  0 m at chart datum, deeper than a hazard that dries at low water.
- A cell directory that is a symbolic link is indexed; it was skipped without a word, at start
  and in Traficom WFS rebuilds. Entries in the cells directory named like a cell that are not a
  directory, such as an unexported `.000` file or a dangling link, are named in the index reason
  in `/status`.
- A saved index is rebuilt at start when a cell in the cells directory was added, removed or
  given a new edition or update, with the cells named in the index reason. It was reused until
  **Rebuild index at start** was ticked, so an added cell's rocks were missing from it.
- `M_SDAT` and `M_VDAT` datum areas are read. A cell with an area on another `VERDAT` than its
  `DSID` datum is matched as an unknown datum (σ 0.5 m), listed with `datumAreas` in the
  `/status` datum mapping. Only the `DSID` datum was read, so such a cell's water level could
  be applied on the wrong datum.
- `scripts/enc-to-geojson.sh` exits non-zero when the source is unreadable, GDAL is missing or
  cannot open the source, or the export has no `M_COVR`. Each of these ended in an empty or
  unusable directory with exit status 0.
- Saving the index names its staging and backup directories by process, thread and a random
  suffix. A WFS rebuild in the worker thread and a save on the main thread shared the process
  id, so one save could delete the other's staging directory or its backup of the last index.
- The published package includes `scripts/enc-to-geojson.sh`, which the README and the
  configuration tell users to run; it was left out of `files`.
- The `signalk-tide` source applies `heightNow` only for 5 minutes after the reading; after that
  it takes the lower of `heightNow` and `heightLow` until 6 h past `environment.tide.timeLow`
  (6 h past the reading without it), then falls back. It held `heightNow` for 30 minutes on a
  falling tide and answered `heightLow` for any time past the next low water.
- A water-level fallback uses the source's last level when that is below chart datum, instead
  of chart datum: in the Baltic the level is often negative, and a stale feed lowered P(UKC < 0).
- FMI is refetched once the held forecast is 25 minutes old, and retried each minute until a
  fetch succeeds. With a 30-minute interval the level was a fallback for a few seconds every
  30 minutes, and one failed refetch made it a fallback for a whole interval.
- The lowest water level over a leg's ETA interval is also sampled at every FMI forecast point
  inside it. Samples every 10 minutes from the start could miss a forecast trough by up to
  half a sample step of its slope (−0.375 m for a −0.40 m trough at 30 cm/h).
- A Traficom WFS response or page body that sends nothing for 30 s fails the download with
  that reason in `GET /status`, and the download is retried as after any failure. A stalled
  server left the download busy for good, with no error. A slow link that keeps sending is read
  to the end; a page over 64 MB fails the download.
- A WFS index build aborted by plugin stop no longer overlaps the next build: the next worker
  starts only after the aborted one has exited. Stop still returns at once.
- The WFS build worker only stages its index; the main thread moves it into the index
  directory, and never for an aborted build. A worker still exiting after stop could otherwise
  replace the index the next start had just saved, or move it away while that start read it.
- After the plugin is stopped every REST route answers 503 `plugin not started`. Before,
  `/query`, `/route-check`, `/route-repair`, `/departure-window` and the UKC tiles kept
  answering on the old index at chart datum, so a rock could read `clear` and a route `ok`.
- The notification published when the plugin stops carries `data` with `engineState: "off"`
  and null values, as `schemas/navigation-safety/notification.json` requires.
- Stopping the plugin publishes `navigation.underKeel.waterLevel` and `.envelopeRev` as `null`
  as well; they kept their last values before.
- A mooring-zone load still running from an earlier start no longer writes its zones or
  errors into the current start's status.
- A null or invalid navigation value from one `$source` clears the input only when that
  source set it. With two GNSS receivers, one without a fix sending a null position every
  second kept every tick `unknown` although the other had a good fix.
- A failed chart-index load stays shown as the plugin error in the server's plugin list; the
  first look-ahead tick replaced it with an ordinary status line.
- Acknowledged passages are not honoured while the water level is a fallback, and `POST /acks`
  answers 409 then. A stale tide feed fell back to 0 m, which compared as more water than an
  acknowledgement made at −0.4 m and turned a warn into "acknowledged passage".
- `POST /acks` checks its polygon like `POST /query`: the ring must be closed, have no holes and
  fit in 50 km without crossing ±180°. An unclosed ring lost a vertex, a hole was dropped so
  the acknowledgement covered it, and a ring across ±180° became a band around the world.
- An acknowledgement that cannot be saved answers 500 `could not save acknowledgements` and is
  logged to the server log. `DELETE /acks/:id` threw into express, which answered with an HTML
  stack trace, and `POST /acks` answered 400 with the raw file-system error and its absolute
  path. Other REST failures that are not a bad request body are a generic 500 as well.
- The envelope `rev` starts at the plugin's start time in ms instead of 0, so after a restart
  `GET /envelope?rev=N` no longer answers 304 to a client holding a rev from the earlier run.
- UKC tiles are sent with `Cache-Control: no-cache`, as the Plotter Extensions spec asks for
  tiles that change, so a browser revalidates them when the water level or draft changes.
- Holes in a mooring-zone region are kept: a footprint reaching into a hole, such as water cut
  out around a rock, is outside the zone and its alarm is no longer demoted to alert. Only the
  outer ring was read before.
- The living-chart quality gate drops a sounding whose position was measured more than 2 s
  from the depth. Any fresh position counted before, up to 10 s old: about 30 m at 6 kn on
  76 m cells.
- Living-chart shoals survive a change of leaf zoom: saved adjustments are mapped onto the new
  zoom instead of being dropped, which let the next save overwrite them. A `livechart.json`
  that is unreadable, of another version or partly malformed is renamed to
  `livechart.json.bad-<ms>` and reported instead of being overwritten at the next save.
- The grounding detector no longer treats a repeated, unchanged
  `propulsion.*.transmission.gear` value as a gear change. Servers that publish the gear every
  second vetoed every grounding.
- Hysteresis lowers a held `alarm` or `warn` once P inside that state's window (60 s, 120 s)
  is clear. Risk further ahead held the state and its reason indefinitely, for example after
  the vessel slowed.
- After `unknown` or `off`, a held risk state is lowered by the usual 5 clear ticks; before, the
  first `normal` after the gap was published at once.
- The escape heading no longer recommends holding course when the vessel's own footprint is
  already over shoal water. The footprint at the vessel is common to every heading and is not
  scored; when no heading does better, `escapeHeading` is null.
- Heel no longer trusts one roll sample. A fin keel is lifted only by the least roll of the last
  10 s, and roll above 60° counts as no roll; before, a roll past 90° made a deeper draft
  safer, and a boat rolling on alternate ticks never reached alarm.
- A `table` heel model without a fresh roll applies the table's largest draft change instead of
  its smallest, and takes the largest change over the rolls seen; route checks, which have no
  roll, use the largest change too.
- Look-ahead cost is bounded: the distance is capped at 5 NM and the minimum horizon at 600 s,
  and a tick scores at most 400 footprints, lengthening the step while footprints still touch.
  A 10 NM distance at 0.3 m/s took about 20 000 footprints and 10 s per 1 Hz tick.
- Squat uses the higher of SOG and STW, and is applied when COG is stale; before, it used SOG
  only and was 0 whenever course or speed was stale.
- The look-ahead envelope draws water from an advisory (WFS) source, with unassessed survey
  quality or against a fallback water level as `unverified`, never `clear`, as the README
  states; before, those footprints were green while the state was `alert`.
- Route-check results reach the details panel on a chart host without data overlays, or while
  the host is still loading the overlay style; the runtime stored them only after the overlay
  call, which failed there. A visible route without a result reads "not checked yet" instead of
  "No route on the chart."
- The runtime clears the stored route-check results when it starts. The host keeps extension
  state across sessions, so the panel listed results from an earlier session as current.
- The status widget judges a value by its timestamp. Signal K replays its cached values on
  every subscribe, so after a reconnect a normal state from a stalled plugin showed green for
  up to 10 s. While stale, the widget shows no clearance or time to shoal under Unknown.
- The look-ahead overlay is withdrawn when the plugin goes quiet: after 10 s without an
  `envelopeRev` delta, when the state is `off` or `unknown`, and when the envelope fetch fails.
  Without a Signal K stream the runtime polls `/envelope` every 3 s; it fetched it once before.
- Route checks are re-run every 60 s and after a plugin restart, not only after a route edit,
  so an ok leg no longer stays ok after the tide falls, the draft changes or the water-level
  source falls back. The panel shows the age of each result and reads "out of date" past 3 min.
- The runtime refreshes the UKC tiles when the water level moves over 1 cm, the applied
  water-level source or its degraded reason changes, the state enters or leaves `off` or
  `unknown`, and after a plugin restart. Tiles stayed classed for the conditions at fetch time.
- The details panel shows Unknown when `/status` does not answer within 8 s or no answer has
  arrived for 20 s. A request that hung left the chip on its last state, such as Normal.
- The details panel names the water-level source the engine applies and the reason it is
  degraded, such as an FMI fallback, instead of the configured source.
- "Check routes again" is hidden on a chart host without `events.publish`, `routes` or
  `background.iframe`, where pressing it did nothing.
- The background runtime writes route-check results to host state in a compact form (per leg
  only index, status, minimum UKC and P), once per re-check of all routes instead of once per
  route. Freeboard keeps that state in localStorage: one 30-leg route wrote 17.6 kB a minute
  and three routes 158 kB; one route now writes 1.9 kB.
- A route check from the background runtime times out after 30 s and reads "not checked",
  and a route is checked once at a time: a re-check asked for meanwhile runs after it. A hung
  reply had no timeout, and each re-check opened another connection beside it.
- The runtime checks the visible routes one after another and, when the server answers 503
  busy with `Retry-After`, checks again after it (at most five times). With six routes it
  sent six checks at once, and those the server queue refused showed "busy" as the result.
- The details panel and the runtime poll `GET /status?summary`, which leaves out the cell
  catalogue and datum mappings.
- The extension pages fetch nothing while Freeboard is in a hidden tab or minimised window.
  On return the runtime withdraws the look-ahead envelope until a current one arrives and
  asks for tile changes and route checks at once; the widget reads Unknown if its data aged
  out meanwhile, even when its timer fired late. With the panel open they made 139 requests
  in 65 s hidden.
- UKC tiles follow the wave allowance and the water level also without a Signal K stream: the
  runtime asks the new `GET /tiles/ukc/changes` which tiles changed class, every 15 s and
  after each 1 cm water-level move. A wave height change left tiles drawn for calmer water,
  and without a stream the tiles never followed the tide. Freeboard now fetches only the tiles
  whose classes changed: 2 tile fetches a minute instead of 108 with the tide rising 2 mm/s.
  When that list does not answer, every tile is fetched again on a 1 cm fall or a 10 cm rise.
