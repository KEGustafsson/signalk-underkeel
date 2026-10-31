import { COLLECTION_CHOICE_PATTERN } from "./shared-enc";

/**
 * The admin form's chart fields: a directory of S-57 cells, or the cells
 * signalk-charts-provider-simple shares (`shared-enc.ts`).
 */
export function chartFields(sharedNow: string | undefined): Record<string, unknown> {
  return {
    cellsDir: {
      type: "string",
      title: "ENC cells directory",
      description:
        "S-57 ENC cells as delivered: .000 files with their .001, .002 … updates, also in sub-folders such as ENC_ROOT. Read directly with GDAL (WebAssembly); nothing is converted."
    },
    chartsProviderEnc: {
      type: "string",
      pattern: COLLECTION_CHOICE_PATTERN,
      title: "ENC from Charts Provider",
      description:
        "Or read the ENC cells signalk-charts-provider-simple keeps: the name of an ENC Charts set there (Gulf of Finland is Gulf_of_Finland) or of a converted chart whose cells it keeps, or * for all of them. Used instead of the ENC cells directory; the index is rebuilt when the cells change." +
        (sharedNow ? ` ${sharedNow}` : "")
    }
  };
}

/** The expert field asking Charts Provider for the cells around the vessel (`shared-enc.ts`). */
export const CHART_AREA_FIELD = {
  chartsProviderArea: {
    type: "boolean",
    title: "Ask Charts Provider for the ENC around the vessel",
    description:
      'With ENC from Charts Provider set to * and Charts Provider\'s "Download the ENC cells around the vessel" on, each new index box asks it to download the free ENC cells of that area; they arrive in its chart set "Around the vessel" and the index is rebuilt with them. Off: only the cells already shared are read.',
    default: false
  }
};
