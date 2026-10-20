# @signalk/navigation-safety-schema

JSON Schemas (draft 2020-12) of the provider-neutral navigation-safety contract in plan §5.1:
what a plotter may call on any provider that declares `services.navigationSafety` in its
Plotter Extensions manifest. `signalk-underkeel` is the first provider.

| Schema                           | Message                                                           |
| -------------------------------- | ----------------------------------------------------------------- |
| `service.json`                   | the manifest's `services.navigationSafety` section                |
| `route-check-request.json`       | body of `POST /route-check`, `/route-repair`, `/departure-window` |
| `route-check-response.json`      | `POST /route-check`                                               |
| `route-repair-response.json`     | `POST /route-repair`                                              |
| `departure-window-response.json` | `POST /departure-window`                                          |
| `query-request.json`             | body of `POST /query`                                             |
| `query-response.json`            | `POST /query`                                                     |
| `envelope-response.json`         | `GET /envelope`                                                   |
| `ack-request.json`               | body of `POST /acks`                                              |
| `ack.json`                       | one entry of `GET /acks`, and the `POST /acks` response           |
| `notification.json`              | the value of `notifications.navigation.underKeel`                 |
| `defs.json`                      | shared definitions                                                |
| `csb-cell.json`                  | one cell of aggregated crowdsourced depth soundings (proposal)    |
| `csb-cell-set.json`              | a published set of those cells: area extract or tileset           |

`csb-cell.json` and `csb-cell-set.json` are a data format for crowdsourced bathymetry
publishers, outside the HTTP contract above and outside the plugin's configured inputs; see
[the RFC draft](../../docs/rfcs/crowdsourced-depth-cells.md).

Errors are `{ "errors": [string, …] }` with a 4xx or 5xx status (`defs.json#/$defs/errors`).

The request schemas bound each field by what it means: speeds, drafts, buffers, the
cross-track limit, the acceptance probability, the acknowledgement sector and lifetime. A
provider may still answer a request that validates with a 400 when it is too large to serve.
signalk-underkeel's limits of that kind:

| Request                                     | Limit                                                             |
| ------------------------------------------- | ----------------------------------------------------------------- |
| `route` (route-check, route-repair, window) | 2..1000 positions, at most 500 km                                 |
| `route` (route-check, route-repair, window) | route km × corridor width ≤ 200 km²                               |
| `departure`                                 | within a year of now                                              |
| `POST /departure-window`                    | `horizon` ≤ 7 days, at most 1000 departures                       |
| `POST /departure-window`                    | departures × corridor area ≤ 1600 km², departures × legs ≤ 20 000 |
| `geometry` of `POST /query`                 | Polygon: 4..500 positions, no holes, bounding box ≤ 50 km across  |
| `geometry` of `POST /query`                 | bounding box widened by the buffer ≤ 25 km²                       |
| `polygon` of `POST /acks`                   | 4..500 positions, closed, no holes, ≤ 50 km across                |
| every position                              | longitude within ±180°, latitude within ±85°                      |

The package is private until the contract is accepted upstream (plan §8, M6).

## License

Copyright (c) 2026 Karl-Erik Gustafsson. These schemas are licensed under the
[Apache License 2.0](LICENSE), so that any plotter or provider, open or closed source, can adopt
the contract. The rest of signalk-underkeel is licensed under EUPL-1.2.
