# Changelog

All notable changes to signalk-underkeel are documented here.

## [0.1.0] - Unreleased

### Added

- Freeboard UI as Plotter Extensions contributions, served from `/plotterext/signalk-underkeel/`:
  a background runtime, look-ahead and route-check data overlays, a status widget, a details
  panel and a toolbar button. Freeboard core is unchanged.
- Traficom WFS depths (off by default): depth areas and soundings for a box around the vessel,
  re-downloaded as it moves and indexed in a worker thread, as a band-1 cell flagged
  `NOT_FOR_NAVIGATION`; water it alone covers is never `normal`, `ok` or `clear`.
- Survey quality at zone boundaries: a leaf across the shared edge of two assessed `M_QUAL`
  zones takes the worse zone's σ instead of the unassessed σ and flag, when the zones share
  the edge vertex for vertex. Gaps, overlaps and differently split edges stay `UNASSESSED`.
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

- The navigation-safety contract schemas in `schemas/navigation-safety/` are licensed under
  Apache-2.0, so other plotters and providers can adopt the contract; the plugin stays EUPL-1.2.

### Fixed

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
- A Traficom WFS page that has not arrived within 120 s fails the download with that reason in
  `GET /status`, and the download is retried as after any failure. A stalled server left the
  download busy for good, with no error.
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
