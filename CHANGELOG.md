# Changelog

All notable changes to signalk-underkeel are documented here.

## [0.1.0] - Unreleased

### Added

- Plugin skeleton: publishes `navigation.underKeel.state` = `off` with a reason, and serves
  `GET /plugins/signalk-underkeel/v1/status`. The risk engine is not implemented yet.
- Development plan in `docs/DEVELOPMENT-PLAN.md`.
- Chart index library: S-57 GeoJSON ingest with cell provenance, CATZOC → σ table,
  min-depth pyramid with a fast-check conservativeness property test, hazard R-tree, and
  on-disk index format.
