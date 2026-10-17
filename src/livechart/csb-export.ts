import type { Sounding } from "./soundings";

/**
 * IHO crowdsourced bathymetry export (B-12, GeoJSON). Depths are as
 * measured below the surface; the water level and datum stay with the
 * recipient. Nothing is uploaded: the user downloads the file and decides.
 */

export interface CsbPlatform {
  /** Vessel identifier, e.g. an MMSI or an anonymous id. */
  id: string;
  idType: "MMSI" | "IMO" | "Other";
  name?: string;
  sounderMake?: string;
  sounderModel?: string;
  /** Transducer depth below the surface, metres. */
  transducerDepth: number;
}

export function csbGeoJson(samples: readonly Sounding[], platform: CsbPlatform): object {
  return {
    type: "FeatureCollection",
    crs: { type: "name", properties: { name: "EPSG:4326" } },
    properties: {
      convention: "CSB 3.0",
      platform: {
        uniqueID: platform.id,
        type: "Ship",
        name: platform.name,
        IDType: platform.idType,
        IDNumber: platform.id,
        sensors: [
          {
            type: "Sounder",
            make: platform.sounderMake,
            model: platform.sounderModel,
            draft: platform.transducerDepth,
            draftUnit: "metres"
          }
        ],
        soundSpeedDocumented: false,
        positionOffsetsDocumented: true,
        dataProcessed: false
      },
      providerContactPoint: { orgName: "signalk-underkeel" }
    },
    features: samples.map((s) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [s.position[0], s.position[1]] },
      properties: {
        depth: Math.round(s.belowSurface * 100) / 100,
        time: new Date(s.at).toISOString()
      }
    }))
  };
}
