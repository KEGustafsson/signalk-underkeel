# signalk-underkeel

Under-keel clearance awareness for Signal K. The plugin turns S-57 chart data into a
queryable hazard model on the server and publishes look-ahead grounding risk, route checks
and own-sounding discrepancies for chartplotters such as Freeboard-SK.

> Advisory navigation aid. Not ECDIS, and not a replacement for official charts or a proper
> lookout.

**Status:** the chart index exists; the risk engine does not. The plugin starts, publishes
`navigation.underKeel.state` = `off` with a reason, and serves
`GET /plugins/signalk-underkeel/v1/status`. The library can read S-57 cells exported to GeoJSON
and answer conservative minimum-depth queries over a footprint.

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

The index reads ENC cells that GDAL has exported to GeoJSON, one directory per cell:

```sh
scripts/enc-to-geojson.sh FI5ABCDE.000 data/cells/FI5ABCDE
```

Only unencrypted S-57 cells are supported. Chart data and built indexes stay out of git
(`data/`, `*.000`, `*.fgb` are ignored); `fixtures/enc/` holds small synthetic cells written by
`scripts/make-synthetic-enc.js`.

Contributor and AI-agent guidance is in [AGENTS.md](AGENTS.md).

## License

MIT
