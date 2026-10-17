# Changelog

All notable changes to signalk-underkeel are documented here.

## [0.1.0] - Unreleased

### Added

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
