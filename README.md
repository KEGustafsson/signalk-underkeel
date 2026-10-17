# signalk-underkeel

Under-keel clearance awareness for Signal K. The plugin turns S-57 chart data into a
queryable hazard model on the server and publishes look-ahead grounding risk, route checks
and own-sounding discrepancies for chartplotters such as Freeboard-SK.

> Advisory navigation aid. Not ECDIS, and not a replacement for official charts or a proper
> lookout.

**Status:** skeleton. The plugin starts, publishes `navigation.underKeel.state` = `off` with a
reason, and serves `GET /plugins/signalk-underkeel/v1/status`. No risk engine exists yet.

## Documentation map

- [Development plan](docs/DEVELOPMENT-PLAN.md): architecture, risk model, APIs, Freeboard
  integration and milestones.
- [Release checklist](docs/release-checklist.md): commands to run before publishing.

## Development

Requires Node.js 20.9 or newer.

```sh
npm install
npm run verify          # type-check + lint + tests
npm run verify:ci-local # everything CI gates, including coverage, format and build
```

Contributor and AI-agent guidance is in [AGENTS.md](AGENTS.md).

## License

MIT
