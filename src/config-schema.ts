/** JSON schema of the plugin configuration, as shown in the Signal K admin UI. */
export const SCHEMA = {
  type: "object",
  description:
    "Advisory navigation aid. Not for navigation; does not replace official charts or a proper lookout.",
  properties: {
    indexDir: {
      type: "string",
      title: "Chart index directory",
      description: "Built index. Default: <plugin data dir>/index"
    },
    cellsDir: {
      type: "string",
      title: "Exported ENC cells directory",
      description: "One sub-directory per cell from scripts/enc-to-geojson.sh"
    },
    rebuildIndex: { type: "boolean", title: "Rebuild index at start", default: false },
    leafZoom: {
      type: "number",
      title: "Index leaf zoom",
      default: 20,
      minimum: 14,
      maximum: 22
    },
    vessel: {
      type: "object",
      title: "Vessel (overrides Signal K design.*)",
      properties: {
        draft: { type: "number", title: "Draft (m)" },
        length: { type: "number", title: "Length overall (m)" },
        beam: { type: "number", title: "Beam (m)" },
        draftSigma: { type: "number", title: "Draft uncertainty 1σ (m)", default: 0.05 },
        margin: { type: "number", title: "Extra safety margin under keel (m)", default: 0 },
        blockCoefficient: { type: "number", title: "Block coefficient Cb (squat)", default: 0.4 },
        confined: { type: "boolean", title: "Double squat (narrow channels)", default: false },
        keel: {
          type: "string",
          title: "Heel effect on draft",
          enum: ["none", "fin", "table"],
          default: "none",
          description: "none: ignore heel; fin: draft·(cos φ − 1); table: heel° → draft change"
        },
        heelTable: {
          type: "array",
          title: "Heel table",
          items: {
            type: "object",
            properties: {
              heel: { type: "number", title: "Heel (°)" },
              delta: { type: "number", title: "Draft change (m, + deeper)" }
            }
          }
        },
        waveFactor: { type: "number", title: "Wave allowance factor c (W = c·Hs)", default: 0.4 }
      }
    },
    waterLevel: {
      type: "object",
      title: "Water level",
      properties: {
        source: {
          type: "string",
          enum: ["none", "manual", "signalk-tide", "fmi"],
          default: "none",
          description:
            "none: chart datum with σ 0.3 m; manual: the height below; signalk-tide: environment.tide.heightNow; fmi: Finnish Meteorological Institute forecast and tide gauges (needs internet)"
        },
        height: { type: "number", title: "Manual height above chart datum (m)", default: 0 },
        sigma: {
          type: "number",
          title: "Manual or Signal K tide height uncertainty 1σ (m)",
          default: 0.1
        },
        updateInterval: {
          type: "number",
          title: "FMI refresh interval (s)",
          default: 600
        },
        datums: {
          type: "array",
          title: "Chart datum mappings (FMI)",
          description:
            "Which FMI series each S-57 VERDAT code is measured from. Codes 3, 19 and 26 map to theoretical mean water by default; cells on N2000 need an entry here. Unmapped datums use σ 0.5 m.",
          items: {
            type: "object",
            properties: {
              verdat: { type: "number", title: "VERDAT code" },
              series: { type: "string", enum: ["mw", "n2000"], title: "FMI series" },
              sigma: { type: "number", title: "Datum match 1σ (m)", default: 0.05 }
            }
          }
        }
      }
    },
    lookahead: {
      type: "object",
      title: "Look-ahead",
      properties: {
        distance: { type: "number", title: "Look-ahead distance (m)", default: 555.6 },
        minHorizon: { type: "number", title: "Minimum horizon (s)", default: 60 },
        positionBuffer: { type: "number", title: "Position buffer (m)", default: 10 },
        alertRisk: { type: "number", title: "Alert at P(UKC<0) ≥", default: 0.01 },
        warnRisk: { type: "number", title: "Warn at P(UKC<0) ≥", default: 0.05 },
        alarmRisk: { type: "number", title: "Alarm at P(UKC<0) ≥", default: 0.2 },
        warnWithin: { type: "number", title: "Warn when within (s)", default: 120 },
        alarmWithin: { type: "number", title: "Alarm when within (s)", default: 60 },
        certainWithin: {
          type: "number",
          title: "Alarm on negative mean UKC within (s)",
          default: 30
        }
      }
    },
    routeCheck: {
      type: "object",
      title: "Route check",
      properties: {
        speed: { type: "number", title: "Planning speed (m/s)", default: 2.5 },
        xteLimit: { type: "number", title: "Cross-track limit (m)", default: 30 },
        probability: { type: "number", title: "Accept a leg at P(UKC<0) <", default: 0.01 }
      }
    }
  }
} as const;
