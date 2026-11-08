import { CHARTS_PROVIDER_ID } from "./shared-enc";

/**
 * The admin form's chart field: the chart provider service whose ENC cells the plugin reads
 * (`shared-enc.ts`). The plugin reads every cell that service shares, and no ENC of its own.
 */

/** A chart provider service the plugin can read ENC cells from. */
export interface ChartProvider {
  id: string;
  name: string;
}

/** The services whose ENC store the plugin reads. */
export const CHART_PROVIDERS: readonly ChartProvider[] = [
  { id: CHARTS_PROVIDER_ID, name: "Charts Provider (signalk-charts-provider-simple)" }
];

/** Which of CHART_PROVIDERS run in this server now, as the admin form lists them. */
export interface ProviderChoices {
  running: readonly string[];
  /** What Charts Provider shares now, in a sentence (`collectionsHint`). */
  shared?: string;
}

const DESCRIPTION =
  "The chart provider service whose ENC cells the index is built from. Every ENC cell it shares is read in place with GDAL, and the index is rebuilt when its cells change. Empty: no charts.";

/**
 * The chart field: a pulldown of CHART_PROVIDERS. With `choices`, each is marked running or
 * not, and the description says what Charts Provider shares now.
 */
export function chartFields(choices?: ProviderChoices): Record<string, unknown> {
  const running = new Set(choices?.running ?? []);
  return {
    chartsProvider: {
      type: "string",
      title: "Charts provider",
      description: choices?.shared === undefined ? DESCRIPTION : `${DESCRIPTION} ${choices.shared}`,
      enum: CHART_PROVIDERS.map((p) => p.id),
      enumNames: CHART_PROVIDERS.map((p) =>
        choices === undefined || running.has(p.id) ? p.name : `${p.name}: not running`
      )
    }
  };
}
