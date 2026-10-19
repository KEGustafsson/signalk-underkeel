# signalk-underkeel

Under-keel clearance awareness for Signal K. The plugin turns S-57 chart data into a
queryable hazard model on the server and publishes look-ahead grounding risk, route checks
and own-sounding discrepancies for chartplotters such as Freeboard-SK.

> Advisory navigation aid, non-commercial. Not ECDIS, and not a replacement for official charts
> or a proper lookout: always carry and use an official nautical chart, paper or ENC.

With a chart index and a configured draft, the plugin predicts a fan of five tracks from COG,
SOG and rate of turn every second. For each footprint it computes P(UKC < 0) from the charted depth and its survey
uncertainty (CATZOC), the draft, squat, heel, a wave allowance and the water level, and
publishes:

- `navigation.underKeel.state`: `normal`, `alert`, `warn`, `alarm`, `unknown` or `off`;
- `navigation.underKeel.clearance` and `.clearanceSigma` (predicted minimum UKC and its σ),
  `.risk` (highest P(UKC < 0) over the horizon), `.timeToShoal`, `.escapeHeading` (the
  heading with the longest time to shoal, when not `normal`), `.envelopeRev` and
  `.waterLevel` (the level applied above chart datum);
- `notifications.navigation.underKeel`, with an explanation of every term behind the result;
- `notifications.navigation.positionIntegrity` (`warn`) when GNSS leaves dead reckoning from
  heading and speed through water, the fix is not a satellite fix, or HDOP exceeds 4. The
  position uncertainty then widens every footprint.

Stale position, a missing draft or index, no chart coverage or a fallback water level never
produce `normal`.

Water-level sources, set under **Water level** in the plugin configuration:

- `none`: chart datum, with a σ for the unknown tide;
- `manual`: a fixed height above chart datum with its σ;
- `signalk-tide`: `environment.tide.heightNow` for 5 minutes after each reading, then the lower
  of it and `heightLow` until 6 h past `timeLow` (6 h past the reading without `timeLow`), then
  a fallback;
- `fmi`: the Finnish Meteorological Institute sea-level forecast at the vessel, anchored to the
  nearest tide gauge. FMI reports above theoretical mean water and above N2000; each cell's
  S-57 vertical datum is mapped to one of them; the defaults cover the mean-water datums, and
  cells on N2000 need an entry. An unmapped datum widens σ.

A source that stops updating falls back to chart datum, or to its last level when that was
below chart datum, with a wider σ, and the state carries the reason.

**Living chart** (off by default): depth readings that pass a quality gate (good fix, HDOP
under 2, small roll, a real water level) are reduced to chart datum and kept per ~76 m cell.
After five readings on two passes 10 minutes apart that put a cell more than 2σ shallower than
charted, the cell is lowered for every check and a Signal K note marks it. Own soundings never
make a cell deeper. The IHO CSB export is for you to submit; the plugin uploads nothing.

**Mooring zones**: Signal K region ids listed in the configuration suppress warn and alarm
to alert inside them, with the zone named. **Grounding detector** (off by default): a sudden
stop in water as shallow as the keel raises `notifications.grounding`; it is the only part of
the plugin that writes that path.

**Traficom WFS depths** (off by default, needs internet): depth areas and soundings from
Traficom's INSPIRE WFS for a box around the vessel, refreshed as the vessel moves, fill gaps
between ENC cells. The data is **not for navigational purposes** (Traficom hydrographic data
licence) and has no rocks, wrecks or survey quality: water it alone covers is never `normal` in
the look-ahead (at most `alert`, with that notice), never `ok` in a route check and never
`clear` on the overlay; water without a depth area counts as land. `GET /status` shows the box
and the notice.

REST, base `/plugins/signalk-underkeel/v1`, open to readonly users:

- `GET /status`: engine state, chart index and cell editions, look-ahead summary, water-level
  source health and datum mapping.
- `GET /envelope?rev=`: the look-ahead as GeoJSON; 304 when the client already has that rev.
- `POST /route-check`: a route as a GeoJSON LineString or `/resources/routes/<id>`; each leg is
  checked over a corridor of the cross-track limit plus a planning buffer at the lowest water
  level expected while on it, and returned as `ok`, `marginal`, `fail` or `unverified` (no
  coverage, unassessed survey or a fallback water level; never folded into `ok`), with P(UKC < 0),
  its explanation and the cell editions used.
- `POST /route-repair`: the same body; for each failing or marginal leg, waypoints to insert
  that route around the shoal and pass the same check. Existing points are never moved.
- `POST /departure-window`: the same body plus `horizon` and `step` (seconds); the departure
  intervals in which every leg is `ok` at the forecast water level.
- Both bound the work one request may cost; the limits are in
  [plan §4.11](docs/DEVELOPMENT-PLAN.md).
- `POST /query`: a GeoJSON Point or Polygon, with an optional buffer, draft and speed; returns
  the class, P(UKC < 0), the deciding hazard and the explanation, for cursor readouts.
- `GET /acks`, `POST /acks`, `DELETE /acks/:id`: acknowledged passages. Inside one, with the
  heading within ±20° and no less water or more draft than when acknowledged, warn and alarm
  are published as alert with the reason "acknowledged passage". A fallback water level
  honours none, and `POST /acks` answers 409 while the level is a fallback. Adding and
  deleting need a readwrite user.
- `GET /livechart/discrepancies` and `GET /livechart/csb.geojson`, with the living chart on
  (see above).
- `GET /tiles/ukc/{z}/{x}/{y}.pbf`: Mapbox vector tiles from zoom 11, one `ukc` layer of cells
  classed `clear`, `caution`, `danger`, `unverified` or `land` for the current draft and water
  level, sent with `Cache-Control: no-cache` because they change with both.
  `GET /ukc-style.json` is a MapLibre style for them.

The plugin also registers a `plotterExtensions` resource. A chart plotter with the Plotter
Extensions API, such as Freeboard-SK, shows it with no change of its own:

- the look-ahead envelope, route-check leg colours and UKC tiles as data overlays;
- a status widget with the state, minimum clearance and time to shoal;
- a details panel with the route-check legs, opened from a toolbar button.

The pages are served from `/plotterext/signalk-underkeel/`. The resource also declares the
experimental `navigationSafety` service.

## Documentation map

- [How it works](docs/HOW-IT-WORKS.md): the plugin step by step for users, with flowcharts and
  screenshots.
- [Development plan](docs/DEVELOPMENT-PLAN.md): architecture, risk model, APIs, Freeboard
  integration and milestones.
- [Release checklist](docs/release-checklist.md): commands to run before publishing.
- [Navigation-safety schemas](schemas/navigation-safety/README.md): JSON Schemas of the
  provider-neutral contract, checked by `__tests__/contract/`.
- RFC drafts: [`navigation.underKeel.*` paths](docs/rfcs/signalk-navigation-underkeel.md) and
  [Plotter Extensions `services`](docs/rfcs/plotter-extensions-services.md).

## Development

Requires Node.js 22 or newer, the same floor as Signal K server (`signalk-server` 2.33 declares
`engines.node: ">=22"`).

```sh
npm install
npm run verify          # type-check + lint + tests
npm run verify:ci-local # everything CI gates, including coverage, format and build
```

`npm run bench` prints pyramid build and query cost on a synthetic archipelago.

## Chart data

Set **Exported ENC cells directory** in the plugin configuration; the index is built from it at
the first start and saved under the plugin data directory. Each start compares the saved index
with the `DSID` of every cell directory (name, edition and update) and rebuilds it, with the
reason in `/status`, when a cell was added, removed or updated. **Rebuild index at start**
rebuilds it on every start. A cell directory may be a symbolic link. An index saved by an older
plugin version whose index format differs is also rebuilt. The index reads ENC cells that GDAL
has exported to GeoJSON, one directory per cell:

```sh
scripts/enc-to-geojson.sh FI5ABCDE.000 data/cells/FI5ABCDE
```

The script ships with the plugin, in `node_modules/signalk-underkeel/scripts/` under the
Signal K server's configuration directory (usually `~/.signalk`).

Only unencrypted S-57 cells are supported. In this repository, keep chart data and built
indexes under `data/`, which git ignores along with `*.000` and `*.fgb`. `fixtures/enc/` holds
small synthetic cells written by `scripts/make-synthetic-enc.js`.

Contributor and AI-agent guidance is in [AGENTS.md](AGENTS.md).

## License

Copyright (c) 2026 Karl-Erik Gustafsson. Licensed under the
[European Union Public Licence v. 1.2](LICENSE) (EUPL-1.2), except the navigation-safety
contract schemas in [`schemas/navigation-safety/`](schemas/navigation-safety/), which are
licensed under the [Apache License 2.0](schemas/navigation-safety/LICENSE) so that other plotters
and providers can adopt the contract.
