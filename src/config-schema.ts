import { LOOKAHEAD_LIMITS } from "./engine/lookahead";
import { chartFields } from "./config-charts";

/**
 * JSON schema of the plugin configuration, as shown in the Signal K admin UI.
 *
 * adminSchema() is the one written by hand. Its top level asks for the
 * charts, the boat, the water level, a warning style and the optional
 * features; everything else appears only with "Show expert settings", and a
 * feature's own fields only once it is on, through `dependencies`. SCHEMA is
 * the same schema flattened: every field at once, for admin UIs that drop
 * `dependencies` (Signal K before 2.32) and as the list of all settings.
 */

type Json = Record<string, unknown>;

const ADVISORY =
  "Advisory navigation aid. Not for navigation; does not replace official charts or a proper lookout.";

/** Shown under each field whose empty value follows a preset. */
const FOLLOWS_STYLE = "Empty follows the warning style.";

const SOURCE_DESCRIPTION =
  "none: chart datum with σ 0.3 m. On charts whose datum is not low water (Finnish VERDAT 3, 19 and 26) the level is marked as a guess and the look-ahead is never normal; choose fmi there. manual: the height below; signalk-tide: environment.tide.heightNow, heightLow and timeLow; fmi: Finnish Meteorological Institute forecast and tide gauges (needs internet)";

/** A boolean field `key` that adds `fields` to its object while true. */
function whenOn(key: string, fields: Json): Json {
  return {
    [key]: {
      oneOf: [
        { properties: { [key]: { const: false } } },
        { properties: { [key]: { const: true }, ...fields } }
      ]
    }
  };
}

const HEEL_TABLE = {
  type: "array",
  title: "Heel table",
  items: {
    type: "object",
    properties: {
      heel: { type: "number", title: "Heel (°)" },
      delta: { type: "number", title: "Draft change (m, + deeper)" }
    }
  }
};

const VESSEL_ESSENTIAL = {
  type: "object",
  title: "Boat",
  description:
    "Only the keel's lowest point counts. Squat (Cb·V²/100 m at V knots) and waves (0.4 × wave height, when Signal K has it) are added on top; heel gives no credit unless set under expert settings.",
  properties: {
    draft: {
      type: "number",
      title: "Draft (m)",
      description: "Leave empty to use Signal K design.draft.maximum."
    },
    margin: { type: "number", title: "Safety margin under the keel (m)", default: 0 }
  }
};

const VESSEL_EXPERT = {
  type: "object",
  properties: {
    length: { type: "number", title: "Length overall (m)" },
    beam: { type: "number", title: "Beam (m)" },
    draftSigma: { type: "number", title: "Draft uncertainty 1σ (m)", default: 0.05 },
    blockCoefficient: { type: "number", title: "Block coefficient Cb (squat)", default: 0.4 },
    confined: { type: "boolean", title: "Double squat (narrow channels)", default: false },
    keel: {
      type: "string",
      title: "Heel effect on draft",
      enum: ["none", "fin", "table"],
      default: "none",
      description:
        "none: the keel counts at full depth; fin: draft·(cos φ − 1) at the least roll of the last 10 s; table: heel° → draft change"
    },
    waveFactor: { type: "number", title: "Wave allowance factor c (W = c·Hs)", default: 0.4 }
  },
  dependencies: {
    keel: {
      oneOf: [
        { properties: { keel: { enum: ["none", "fin"] } } },
        { properties: { keel: { const: "table" }, heelTable: HEEL_TABLE } }
      ]
    }
  }
};

const MANUAL_HEIGHT = { type: "number", title: "Manual height above chart datum (m)", default: 0 };
const HEIGHT_SIGMA = {
  type: "number",
  title: "Manual or Signal K tide height uncertainty 1σ (m)",
  default: 0.1
};

const FMI_FIELDS = {
  updateInterval: { type: "number", title: "FMI refresh interval (s)", default: 600 },
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
};

function waterLevel(sourceHint: string | undefined): Json {
  const source = (name: string, fields: Json = {}) => ({
    properties: { source: { const: name }, ...fields }
  });
  return {
    type: "object",
    title: "Water level",
    properties: {
      source: {
        type: "string",
        title: "Source",
        enum: ["none", "manual", "signalk-tide", "fmi"],
        default: "none",
        description: sourceHint ? `${sourceHint} ${SOURCE_DESCRIPTION}` : SOURCE_DESCRIPTION
      }
    },
    dependencies: {
      source: {
        oneOf: [
          source("none"),
          source("manual", { height: MANUAL_HEIGHT, sigma: HEIGHT_SIGMA }),
          source("signalk-tide", { sigma: HEIGHT_SIGMA }),
          source("fmi", FMI_FIELDS)
        ]
      }
    }
  };
}

const WARNING_STYLE = {
  type: "string",
  title: "Warnings",
  default: "balanced",
  oneOf: [
    { const: "early", title: "Early: looks 0.5 NM ahead, warns sooner and more often" },
    { const: "balanced", title: "Balanced: looks 0.3 NM ahead" },
    { const: "late", title: "Late: looks 0.2 NM ahead, quiet in swept fairways" }
  ]
};

const LIVECHART_FIELDS = {
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
  forward: { type: "number", title: "Transducer forward of the GNSS antenna (m)", default: 0 },
  starboard: {
    type: "number",
    title: "Transducer to starboard of the GNSS antenna (m)",
    default: 0
  },
  writeNotes: { type: "boolean", title: "Write suspected shoals as Signal K notes", default: true },
  vesselId: { type: "string", title: "CSB export: vessel identifier", default: "" },
  vesselIdType: {
    type: "string",
    enum: ["MMSI", "IMO", "Other"],
    default: "Other",
    title: "CSB export: identifier type"
  },
  sounderMake: { type: "string", title: "CSB export: sounder make" },
  sounderModel: { type: "string", title: "CSB export: sounder model" }
};

const WFS_FIELDS = {
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
};

const GROUNDING_FIELDS = {
  imuPath: { type: "string", title: "Longitudinal acceleration path (m/s²), optional" },
  decelThreshold: { type: "number", title: "Deceleration spike at or above (m/s²)", default: 2 }
};

/** An optional feature: an Enabled box that shows the feature's fields when ticked. */
function feature(title: string, fields: Json, description?: string): Json {
  return {
    type: "object",
    title,
    ...(description ? { description } : {}),
    properties: { enabled: { type: "boolean", title: "Enabled", default: false } },
    dependencies: whenOn("enabled", fields)
  };
}

const LOOKAHEAD = {
  type: "object",
  title: "Look-ahead",
  description: `The fields the warning style sets have no default: ${FOLLOWS_STYLE}`,
  properties: {
    distance: {
      type: "number",
      title: "Look-ahead distance (m)",
      description: `${FOLLOWS_STYLE} Each second the look-ahead scores footprints out to this distance, at most 400; a longer one costs more CPU per tick, which counts on a Raspberry Pi 3 or Cerbo GX.`,
      minimum: 0,
      maximum: LOOKAHEAD_LIMITS.distance
    },
    minHorizon: {
      type: "number",
      title: "Minimum horizon (s)",
      description:
        "The look-ahead reaches at least this far in time at speed. A longer horizon scores more footprints each second, at most 400, so more CPU per tick.",
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
    alertRisk: { type: "number", title: "Alert at P(UKC<0) ≥", description: FOLLOWS_STYLE },
    warnRisk: { type: "number", title: "Warn at P(UKC<0) ≥", description: FOLLOWS_STYLE },
    alarmRisk: { type: "number", title: "Alarm at P(UKC<0) ≥", description: FOLLOWS_STYLE },
    warnWithin: { type: "number", title: "Warn when within (s)", description: FOLLOWS_STYLE },
    alarmWithin: { type: "number", title: "Alarm when within (s)", description: FOLLOWS_STYLE },
    certainWithin: {
      type: "number",
      title: "Alarm on negative mean UKC within (s)",
      description: FOLLOWS_STYLE
    }
  }
};

/** A chart box half-width field, km. */
const BOX_KM = { type: "number", minimum: 0, maximum: 50 };
const boxKm = (title: string, def: number, description: string): Json =>
  Object.assign({ title, description, default: def }, BOX_KM);

const CHART_INDEX = {
  indexDir: {
    type: "string",
    title: "Chart index directory (optional)",
    description:
      "Where the depth index built from the cells is kept between restarts. Default: <plugin data dir>/index"
  },
  rebuildIndex: {
    type: "boolean",
    title: "Rebuild index at start",
    description:
      "Builds the index again at every start, with the CPU, memory and flash writes of a first build. The index is rebuilt anyway when a cell changes; leave this off.",
    default: false
  },
  leafZoom: {
    type: "number",
    title: "Index leaf zoom",
    description:
      "Size of the smallest index tile: about 19 m across at 20 and 38 m at 19 at 60° N. Each step down needs fewer tiles, so less memory, disk and build time. A tile keeps the shallowest depth inside it, so a coarser index warns more, never less. Consider 19 on a 1 GB Raspberry Pi 3 or Cerbo GX. Changing it rebuilds the index.",
    default: 20,
    minimum: 14,
    maximum: 22
  },
  boxRadiusKm: boxKm(
    "Index box around the vessel (km)",
    10,
    "Half-width of the area the index is built in around the vessel; it is rebuilt as the vessel moves. Outside it the plugin reports no coverage, and the reason says the vessel is outside the chart box. At speed the box grows past this radius, up to the largest index box, so the vessel cannot reach its edge, less the look-ahead, before the next box is built: a box must hold 1.5 times the distance run during the last build (grown with the build area) plus the look-ahead and a 2.4 km band. It grows at once when too small, and shrinks only at the next rebuild once the speed needs under 70% of it. 0 indexes every cell (slow for large chart sets); a radius under 2 km is raised to 2. With the Traficom WFS on, its radius is used, and the box grows to 25 km at most."
  ),
  boxMaxRadiusKm: boxKm(
    "Largest index box at speed (km)",
    0,
    "The box around the vessel grows up to this half-width at speed. 0 sizes it from the RAM the system reports: 10 km on a 1 GB Raspberry Pi or Cerbo GX, about 19 km on a 4 GB Raspberry Pi 4, about 27 km with 8 GB. The status says when even this box is too small for the speed and build time."
  )
};

const EXPERT = {
  ...CHART_INDEX,
  vessel: VESSEL_EXPERT,
  lookahead: LOOKAHEAD,
  mooringZones: {
    type: "array",
    title: "Mooring zones",
    description:
      "Signal K region ids. Inside one, warn and alarm are published as alert with the reason.",
    items: { type: "string" }
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
};

/** What the plugin found at run time, shown beside the fields it concerns. */
export interface SchemaHints {
  /** One line per setup check, shown at the top of the form. */
  checks?: string[];
  /** The draft Signal K states, metres. */
  signalkDraft?: number;
  /** A sentence naming the charts' vertical datums and the source to choose. */
  source?: string;
  /** A sentence naming the ENC collections signalk-charts-provider-simple shares now. */
  encCollections?: string;
}

function draftField(signalkDraft: number | undefined): Json {
  return signalkDraft === undefined
    ? VESSEL_ESSENTIAL.properties.draft
    : {
        ...VESSEL_ESSENTIAL.properties.draft,
        description: `Leave empty to use Signal K design.draft.maximum: ${signalkDraft} m.`
      };
}

/** The form as written: the essentials, with expert settings behind a checkbox. */
export function adminSchema(hints: SchemaHints = {}): Json {
  const checks = hints.checks?.length ? ` Setup check: ${hints.checks.join(" · ")}` : "";
  return {
    type: "object",
    description: `${ADVISORY}${checks}`,
    properties: {
      ...chartFields(hints.encCollections),
      vessel: {
        ...VESSEL_ESSENTIAL,
        properties: { ...VESSEL_ESSENTIAL.properties, draft: draftField(hints.signalkDraft) }
      },
      waterLevel: waterLevel(hints.source),
      warningStyle: WARNING_STYLE,
      livechart: feature("Living chart (own soundings)", LIVECHART_FIELDS),
      wfs: feature(
        "Traficom WFS depths (not for navigational purposes)",
        WFS_FIELDS,
        "Downloads Traficom INSPIRE WFS depth areas and soundings around the vessel and fills gaps between ENC cells. Licensed for non-navigational use only; it has no rocks, wrecks or survey quality, so water it alone covers is never shown as clear and the look-ahead is never normal there. Needs internet."
      ),
      groundingDetector: feature(
        "Grounding detector (raises notifications.grounding)",
        GROUNDING_FIELDS
      ),
      showExpert: {
        type: "boolean",
        title: "Show expert settings",
        description:
          "Chart index, squat, heel and waves, look-ahead geometry and thresholds, mooring zones and route-check defaults.",
        default: false
      }
    },
    dependencies: whenOn("showExpert", EXPERT)
  };
}

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Two object schemas as one: `b`'s fields after `a`'s, a field in both merged the same way. */
function mergeObjects(a: Json, b: Json): Json {
  const properties: Json = { ...(a.properties as Json) };
  for (const [key, value] of Object.entries(b.properties as Json)) {
    const prev = properties[key];
    if (prev === undefined) {
      properties[key] = value;
    } else if (isObject(prev) && isObject(value) && isObject(prev.properties)) {
      properties[key] = mergeObjects(prev, value);
    }
  }
  const dependencies = { ...(a.dependencies as Json), ...(b.dependencies as Json) };
  return { ...a, properties, ...(Object.keys(dependencies).length ? { dependencies } : {}) };
}

/**
 * The schema with every field shown at once: the fields of every
 * `dependencies` branch merged into `properties`, all but the field that
 * switches the branch, and without showExpert, which then shows nothing.
 */
export function flatten(schema: Json): Json {
  if (!isObject(schema.properties)) {
    return schema;
  }
  const { dependencies, ...rest } = schema;
  let merged: Json = rest;
  for (const [key, dep] of Object.entries(isObject(dependencies) ? dependencies : {})) {
    for (const branch of (isObject(dep) && Array.isArray(dep.oneOf) ? dep.oneOf : []) as Json[]) {
      const { [key]: _switch, ...fields } = (branch.properties ?? {}) as Json;
      merged = mergeObjects(merged, { properties: fields });
    }
  }
  const properties = Object.fromEntries(
    Object.entries(merged.properties as Json)
      .filter(([key]) => key !== "showExpert")
      .map(([key, value]) => [key, isObject(value) ? flatten(value) : value])
  );
  const { dependencies: _left, ...flat } = merged;
  return { ...flat, properties };
}

/** Every setting at once, as the admin UI of Signal K before 2.32 shows it. */
export const SCHEMA = flatten(adminSchema()) as {
  description: string;
  properties: Record<string, unknown>;
};

/** Layout hints for the admin form: the warning style as radio buttons. */
export const UI_SCHEMA = { warningStyle: { "ui:widget": "radio" } } as const;

/**
 * Whether the admin UI of Signal K `version` forwards `dependencies` to its
 * form (2.32 and later). An unknown version gets the flat schema, which
 * hides nothing.
 */
export function formsFollowDependencies(version: unknown): boolean {
  const m = typeof version === "string" ? /^(\d+)\.(\d+)\./.exec(version) : null;
  if (!m) {
    return false;
  }
  const major = Number(m[1]);
  return major > 2 || (major === 2 && Number(m[2]) >= 32);
}
