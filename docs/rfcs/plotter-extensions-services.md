# RFC draft: a `services` section for the Plotter Extensions API

Status: draft for Plotter Extensions API v2, not yet submitted. Shipped today under the vendor
prefix as `x-freeboard.services.navigationSafety` by `signalk-underkeel` 0.1.0; a stub second
provider passes the same contract tests (`__tests__/contract/`).

## Motivation

`widgets`, `panels` and `overlays` contribute extension UI. A navigation-safety check is
different: the host plotter wants to call it from its own route editor, notification centre
and cursor readout. A service contribution declares an HTTP contract that the host calls, so the
host builds native UX on it and any provider that implements the contract lights it up.

## Manifest section

```jsonc
"services": {
  "navigationSafety": {
    "apiVersion": "1",
    "base": "/plugins/signalk-underkeel/v1",
    "provides": ["lookahead", "routeCheck", "routeRepair", "departureWindow", "query", "acks"],
    "statePath": "navigation.underKeel",
    "notificationPath": "notifications.navigation.underKeel"
  }
}
```

`provides` lists the capabilities served under `base`:

| Capability        | Endpoint                                 | Schema                           |
| ----------------- | ---------------------------------------- | -------------------------------- |
| `lookahead`       | `GET /envelope?rev=` and the state paths | `envelope-response.json`         |
| `routeCheck`      | `POST /route-check`                      | `route-check-response.json`      |
| `routeRepair`     | `POST /route-repair`                     | `route-repair-response.json`     |
| `departureWindow` | `POST /departure-window`                 | `departure-window-response.json` |
| `query`           | `POST /query`                            | `query-response.json`            |
| `acks`            | `GET/POST /acks`, `DELETE /acks/:id`     | `ack.json`                       |

Requests to the route endpoints share `route-check-request.json`; errors are `error.json`.

## Rules every provider follows

- `unverified` (no coverage, unassessed survey, fallback water level) is a status of its own
  and is never reported as `ok`.
- Write endpoints (`POST/DELETE /acks`) require Signal K readwrite access; the rest are
  readonly.
- When several providers declare the same service, the user picks one; the first found is the
  default.

## Open questions

- Versioning: whether `apiVersion` is per service or per manifest.
- Whether the schema package is published by Signal K or by the first provider.
