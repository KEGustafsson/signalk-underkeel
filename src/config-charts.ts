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
      title: "ENC from Charts Provider",
      description:
        "Or read the ENC cells signalk-charts-provider-simple keeps: the name of an ENC Charts set there (Gulf of Finland is Gulf_of_Finland) or of a converted chart whose cells it keeps, or * for all of them. Used instead of the ENC cells directory; the index is rebuilt when the cells change." +
        (sharedNow ? ` ${sharedNow}` : "")
    }
  };
}
