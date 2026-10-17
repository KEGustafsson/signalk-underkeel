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
- `notifications.navigation.underKeel`, with an explanation of every term behind the result.

Stale position, a missing draft or index, no chart coverage or a fallback water level never
produce `normal`.

Water-level sources, set under **Water level** in the plugin configuration:

- `none`: chart datum, with a σ for the unknown tide;
- `manual`: a fixed height above chart datum with its σ;
- `signalk-tide`: `environment.tide.heightNow`, bounded ahead by `heightLow`;
- `fmi`: the Finnish Meteorological Institute sea-level forecast at the vessel, anchored to the
  nearest tide gauge. FMI reports above theoretical mean water and above N2000; each cell's
  S-57 vertical datum is mapped to one of them; the defaults cover the mean-water datums, and
  cells on N2000 need an entry. An unmapped datum widens σ.

A source that stops updating falls back to chart datum with a wider σ, and the state carries
the reason.

REST, base `/plugins/signalk-underkeel/v1`, open to readonly users:

- `GET /status`: engine state, chart index and cell editions, look-ahead summary, water-level
  source health and datum mapping.
- `GET /envelope?rev=`: the look-ahead as GeoJSON; 304 when the client already has that rev.
- `POST /route-check`: a route as a GeoJSON LineString or `/resources/routes/<id>`; each leg is
  checked over a corridor of the cross-track limit plus a planning buffer at the lowest water
  level expected while on it, and returned as `ok`, `marginal`, `fail` or `unverified` (no
  coverage, unassessed survey or a fallback water level; never folded into `ok`), with P(UKC < 0),
  its explanation and the cell editions used.
- `POST /query`: a GeoJSON Point or Polygon, with an optional buffer, draft and speed; returns
  the class, P(UKC < 0), the deciding hazard and the explanation, for cursor readouts.
- `GET /tiles/ukc/{z}/{x}/{y}.pbf`: Mapbox vector tiles from zoom 11, one `ukc` layer of cells
  classed `clear`, `caution`, `danger`, `unverified` or `land` for the current draft and water
  level. `GET /ukc-style.json` is a MapLibre style for them.

The plugin also registers a `plotterExtensions` resource declaring the UKC data overlay and the
experimental `navigationSafety` service.

## Documentation map

- [How it works](docs/HOW-IT-WORKS.md): the plugin step by step for users, with flowcharts and
  screenshots.
- [Development plan](docs/DEVELOPMENT-PLAN.md): architecture, risk model, APIs, Freeboard
  integration and milestones.
- [Release checklist](docs/release-checklist.md): commands to run before publishing.

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
the first start and saved under the plugin data directory. The saved index is used until
**Rebuild index at start** is enabled, so enable it once after cells in that directory change. The
index reads ENC cells that GDAL has exported to GeoJSON, one directory per cell:

```sh
scripts/enc-to-geojson.sh FI5ABCDE.000 data/cells/FI5ABCDE
```

Only unencrypted S-57 cells are supported. In this repository, keep chart data and built
indexes under `data/`, which git ignores along with `*.000` and `*.fgb`. `fixtures/enc/` holds
small synthetic cells written by `scripts/make-synthetic-enc.js`.

Contributor and AI-agent guidance is in [AGENTS.md](AGENTS.md).

## License

MIT
