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

- `navigation.underKeel.clearance` is published as `null` when the look-ahead reaches land,
  never `-Infinity`. In-process subscribers such as signalk-to-influxdb received the raw
  value and the database refused the write; no published number is now NaN or infinite.
- Depth queries near the antimeridian also read the tiles at the other end of the world: a
  footprint or position buffer reaching past ±180° used to miss a rock a few hundred metres
  away on the other side, and a footprint drawn wholly past 180° returned no depth and no flag.
- A rock or sounding charted inside a swept area keeps its survey's depth σ. The swept σ of
  0.1 m applied to every tile in the area, so a CATZOC C rock 4 m deep in an 8 m swept fairway
  read P(UKC < 0) = 0.08 % instead of 19 % for a 3 m threshold.
