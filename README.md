# signalk-underkeel

Under-keel clearance awareness for Signal K. The plugin turns S-57 chart data into a
queryable hazard model on the server and publishes look-ahead grounding risk, route checks
and own-sounding discrepancies for chartplotters such as Freeboard-SK.

> Advisory navigation aid. Not ECDIS, and not a replacement for official charts or a proper
> lookout.

With a chart index and a configured draft, the plugin checks a straight cone along COG every
second against the chart with a fixed safety margin, and publishes:

- `navigation.underKeel.state`: `normal`, `alert`, `warn`, `alarm`, `unknown` or `off`;
- `navigation.underKeel.clearance`, `.timeToShoal`, `.envelopeRev` and `.waterLevel` (the
  water level applied above chart datum; 0 with no water-level source);
- `notifications.navigation.underKeel`, with the charted depth, draft and margin behind it.

Stale position, a missing draft or index, or no chart coverage never produce `normal`.

REST, base `/plugins/signalk-underkeel/v1`: `GET /status` and `GET /envelope?rev=` (the
look-ahead as GeoJSON; 304 when the client already has that rev). The plugin also registers a
`plotterExtensions` resource declaring the experimental `navigationSafety` service.

## Documentation map

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
