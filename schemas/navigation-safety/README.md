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

Errors are `{ "errors": [string, …] }` with a 4xx or 5xx status (`defs.json#/$defs/errors`).

The package is private until the contract is accepted upstream (plan §8, M6).
