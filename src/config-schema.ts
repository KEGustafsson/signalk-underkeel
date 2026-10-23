import { LOOKAHEAD_LIMITS } from "./engine/lookahead";

/** JSON schema of the plugin configuration, as shown in the Signal K admin UI. */
export const SCHEMA = {
  type: "object",
  description:
    "Advisory navigation aid. Not for navigation; does not replace official charts or a proper lookout.",
  properties: {
    cellsDir: {
      type: "string",
      title: "ENC cells directory",
      description:
        "S-57 ENC cells as delivered: .000 files with their .001, .002 … updates, also in sub-folders such as ENC_ROOT. Read directly with GDAL (WebAssembly); nothing is converted."
    },
    indexDir: {
      type: "string",
      title: "Chart index directory (optional)",
      description:
        "Where the depth index built from the cells is kept between restarts. Default: <plugin data dir>/index"
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
            "none: chart datum with σ 0.3 m; manual: the height below; signalk-tide: environment.tide.heightNow, heightLow and timeLow; fmi: Finnish Meteorological Institute forecast and tide gauges (needs internet)"
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
        distance: {
          type: "number",
          title: "Look-ahead distance (m)",
          default: 555.6,
          minimum: 0,
          maximum: LOOKAHEAD_LIMITS.distance
        },
        minHorizon: {
          type: "number",
          title: "Minimum horizon (s)",
          default: 60,
          minimum: 0,
          maximum: LOOKAHEAD_LIMITS.minHorizon
        },
        positionBuffer: { type: "number", title: "Least position buffer (m)", default: 10 },
        kp: {
          type: "number",
          title: "Position buffer in σ",
          description: "Footprints grow by this many σ of position uncertainty",
          default: 2
        },
        sigmaCog: { type: "number", title: "Fan spread: COG 1σ (°)", default: 5 },
        sigmaRot: { type: "number", title: "Fan spread: rate of turn 1σ (°/s)", default: 0.1 },
        maxTurnRate: {
          type: "number",
          title: "Maximum rate of turn for escape headings (°/s)",
          default: 3
        },
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
    livechart: {
      type: "object",
      title: "Living chart (own soundings)",
      properties: {
        enabled: { type: "boolean", title: "Enabled", default: false },
        source: {
          type: "string",
          enum: ["belowSurface", "belowTransducer"],
          default: "belowSurface",
          title: "Depth path (environment.depth.*)"
        },
        transducerDepth: {
          type: "number",
          title: "Transducer depth below the surface (m), for belowTransducer",
          default: 0
        },
        forward: {
          type: "number",
          title: "Transducer forward of the GNSS antenna (m)",
          default: 0
        },
        starboard: {
          type: "number",
          title: "Transducer to starboard of the GNSS antenna (m)",
          default: 0
        },
        writeNotes: {
          type: "boolean",
          title: "Write suspected shoals as Signal K notes",
          default: true
        },
        vesselId: { type: "string", title: "CSB export: vessel identifier", default: "" },
        vesselIdType: {
          type: "string",
          enum: ["MMSI", "IMO", "Other"],
          default: "Other",
          title: "CSB export: identifier type"
        },
        sounderMake: { type: "string", title: "CSB export: sounder make" },
        sounderModel: { type: "string", title: "CSB export: sounder model" }
      }
    },
    mooringZones: {
      type: "array",
      title: "Mooring zones",
      description:
        "Signal K region ids. Inside one, warn and alarm are published as alert with the reason.",
      items: { type: "string" }
    },
    groundingDetector: {
      type: "object",
      title: "Grounding detector (raises notifications.grounding)",
      properties: {
        enabled: { type: "boolean", title: "Enabled", default: false },
        imuPath: {
          type: "string",
          title: "Longitudinal acceleration path (m/s²), optional"
        },
        decelThreshold: {
          type: "number",
          title: "Deceleration spike at or above (m/s²)",
          default: 2
        }
      }
    },
    wfs: {
      type: "object",
      title: "Traficom WFS depths (not for navigational purposes)",
      description:
        "Downloads Traficom INSPIRE WFS depth areas and soundings around the vessel and fills gaps between ENC cells. Licensed for non-navigational use only; it has no rocks, wrecks or survey quality, so water it alone covers is never shown as clear and the look-ahead is never normal there. Needs internet.",
      properties: {
        enabled: { type: "boolean", title: "Enabled", default: false },
        catzoc: {
          type: "string",
          title: "Survey quality to assume (the WFS states none)",
          enum: ["A1", "A2", "B", "C", "D", "U"],
          default: "B",
          description:
            "Sets each sounding's danger radius (2 × position σ: B 50 m, C 500 m, U 1000 m) and the depth σ. U is the most cautious and alarms almost everywhere in an archipelago."
        },
        radiusKm: {
          type: "number",
          title: "Box half-width around the vessel (km)",
          default: 10,
          minimum: 2,
          maximum: 25
        },
        url: {
          type: "string",
          title: "WFS URL",
          default: "https://julkinen.traficom.fi/inspirepalvelu/rajoitettu/wfs"
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
