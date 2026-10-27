# RFC draft: `navigation.underKeel.*` and `notifications.navigation.underKeel`

Status: draft for the Signal K specification.

## Motivation

Several plugins and plotters estimate under-keel clearance ahead of the vessel. Without shared
paths each plotter needs per-plugin code, and alarms land on `notifications.grounding`, which
the specification reserves for an actual grounding. This RFC proposes paths for predicted
clearance and a separate notification.

## Paths

| Path                                  | Units | Meaning                                                       |
| ------------------------------------- | ----- | ------------------------------------------------------------- |
| `navigation.underKeel.state`          | —     | `normal`, `alert`, `warn`, `alarm`, `unknown` or `off`        |
| `navigation.underKeel.clearance`      | m     | predicted minimum mean UKC over horizon; null over land       |
| `navigation.underKeel.clearanceSigma` | m     | 1σ of `clearance`                                             |
| `navigation.underKeel.risk`           | ratio | highest P(UKC < 0) over the horizon                           |
| `navigation.underKeel.timeToShoal`    | s     | seconds until P reaches the warn level; null when none        |
| `navigation.underKeel.escapeHeading`  | rad   | true heading with the longest time to shoal; null when normal |
| `navigation.underKeel.envelopeRev`    | —     | integer bumped when the provider's look-ahead GeoJSON changes |
| `navigation.underKeel.waterLevel`     | m     | water level above chart datum the estimate used               |

`unknown` means the inputs are stale or missing; `off` means the provider cannot run (no chart).
A provider must not publish `normal` from stale or missing input. A provider may send a value
only when it changes, but sends `state` at least every 5 s; a consumer shows a `state` not
received for 15 s as unknown.

## Notifications

`notifications.navigation.underKeel` carries the state with `message` and `data`:
`engineState`, `clearance`, `clearanceSigma`, `risk`, `timeToShoal` and an optional
`explanation` object with every term (charted depth and σ, water level and source, draft,
heel, squat, wave allowance, margin, mean, σ, P). The JSON Schema is
`schemas/navigation-safety/notification.json`.

`notifications.navigation.positionIntegrity` (`warn`) reports GNSS that leaves dead reckoning,
a fix that is not a satellite fix, or HDOP above 4.

`notifications.grounding` stays reserved for an actual grounding. A look-ahead warning never
uses it.

## Open questions

- Whether `risk` and `timeToShoal` belong in the specification or only in provider data.
- A standard path for longitudinal acceleration, which grounding detection needs.
