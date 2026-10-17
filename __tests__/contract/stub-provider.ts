/**
 * A second navigation-safety provider, as small as the contract allows
 * (plan §8, M6 exit). It has no chart, so it answers honestly: every leg
 * and every query is `unverified`, the engine is `unknown`, never `ok` or
 * `normal`.
 */

type LonLat = [number, number];

const NOW = "2026-10-18T07:00:00Z";

export function stubProvider() {
  return {
    service: {
      apiVersion: "1",
      base: "/plugins/stub-safety/v1",
      provides: ["lookahead", "routeCheck", "query"],
      statePath: "navigation.underKeel",
      notificationPath: "notifications.navigation.underKeel"
    },
    routeCheck: (coordinates: LonLat[]) => ({
      checkedAt: NOW,
      charts: [],
      waterLevelSource: "none",
      legs: coordinates.slice(1).map((to, index) => ({
        index,
        status: "unverified",
        from: coordinates[index] as LonLat,
        to,
        length: 0,
        eta: { start: NOW, end: NOW },
        minUkc: null,
        sigma: 0,
        risk: 0,
        charted: null,
        flags: ["NO_COVERAGE"]
      }))
    }),
    query: () => ({
      class: "unverified",
      charted: null,
      mean: null,
      sigma: 0,
      risk: 0,
      flags: ["NO_COVERAGE"],
      cells: []
    }),
    envelope: () => ({ rev: 0, envelope: { type: "FeatureCollection", features: [] } }),
    notification: () => ({
      state: "alert",
      method: ["visual"],
      message: "UKC monitoring degraded: stub provider has no chart",
      data: {
        engineState: "unknown",
        clearance: null,
        clearanceSigma: null,
        risk: null,
        timeToShoal: null
      }
    })
  };
}
