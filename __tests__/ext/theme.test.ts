import fs from "fs";
import path from "path";
import THEME = require("../../public/theme.js");

/**
 * The extension pages' colours (public/theme.css): readable in every scheme, the night scheme
 * dim enough to keep the eyes adapted to the dark, and used through their tokens only.
 */

const PUBLIC = path.resolve(__dirname, "..", "..", "public");
const CSS = fs.readFileSync(path.join(PUBLIC, "theme.css"), "utf8");

/** The `--name: #rrggbb` declarations of the block that opens with `selector {`. */
function tokens(selector: string): Record<string, string> {
  const at = CSS.indexOf(`${selector} {`);
  if (at < 0) {
    throw new Error(`theme.css has no block ${selector}`);
  }
  const body = CSS.slice(at, CSS.indexOf("}", at));
  return Object.fromEntries(
    [...body.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})\s*;/gi)].map((m) => [m[1], m[2]])
  ) as Record<string, string>;
}

const DAY = tokens(":root");
const SCHEMES: Record<string, Record<string, string>> = {
  day: DAY,
  dusk: tokens(':root[data-scheme="dusk"]'),
  night: tokens(':root[data-scheme="night"]')
};

const channel = (c: number): number => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
/** WCAG 2 relative luminance. */
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * channel(n >> 16) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Each text colour and the surfaces the pages draw it on. */
const TEXT_ON: [string, string[]][] = [
  ...["ink", "muted", "accent", "ok", "warn", "todo", "unverified", "margin-ink"].map(
    (t): [string, string[]] => [t, ["page", "panel"]]
  ),
  ["note-ink", ["note"]],
  ["on-accent", ["accent", "ok"]],
  ...["normal", "alert", "warn", "alarm", "unknown"].map((s): [string, string[]] => [
    `on-st-${s}`,
    [`st-${s}`]
  ])
];

describe("theme colours", () => {
  test("every scheme sets every token, and dark-mode dusk is the dusk scheme", () => {
    const names = Object.keys(DAY).sort();
    const checked = TEXT_ON.flatMap(([text, surfaces]) => [text, ...surfaces]);
    expect(checked.filter((n) => !names.includes(n))).toEqual([]);
    for (const t of Object.values(SCHEMES)) {
      expect(Object.keys(t).sort()).toEqual(names);
    }
    // The OS preference and the page's own choice give the same colours.
    expect(tokens(":root:not([data-scheme])")).toEqual(SCHEMES.dusk);
  });

  test("every text colour reads at WCAG AA (4.5:1) on its surfaces, in every scheme", () => {
    const low: string[] = [];
    for (const [scheme, t] of Object.entries(SCHEMES)) {
      for (const [text, surfaces] of TEXT_ON) {
        for (const s of surfaces) {
          const r = contrast(t[text] as string, t[s] as string);
          if (!(r >= 4.5)) {
            low.push(`${scheme}: ${text} on ${s} ${r.toFixed(2)}:1`);
          }
        }
      }
    }
    expect(low).toEqual([]);
  });

  test("night is black with nothing brighter than a dim grey, so eyes stay dark-adapted", () => {
    const night = SCHEMES.night as Record<string, string>;
    expect(night.page).toBe("#000000");
    const bright = Object.entries(night)
      .filter(([, hex]) => luminance(hex) > 0.3)
      .map(([name, hex]) => `${name} ${hex}`);
    expect(bright).toEqual([]);
    // The brightest night colour is a fraction of the day page's white.
    const top = Math.max(...Object.values(night).map(luminance));
    expect(top).toBeLessThan(luminance(DAY.page as string) / 3);
  });
});

describe("pages use the theme's tokens only", () => {
  const pages = ["panel.html", "setup.html", "widget.html"];
  const scripts = ["panel.js", "setup.js", "widget.js", "ukc-shared.js"];

  test("each page loads the theme, and every token it uses is defined", () => {
    const missing: string[] = [];
    for (const page of pages) {
      const html = fs.readFileSync(path.join(PUBLIC, page), "utf8");
      expect(html).toContain('<link rel="stylesheet" href="theme.css" />');
      expect(html).toContain('<script src="theme.js"></script>');
      for (const [, name] of html.matchAll(/var\(--([\w-]+)\)/g)) {
        if (!(name! in DAY)) {
          missing.push(`${page}: --${name}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  test("no page or script writes a colour of its own", () => {
    const hex = /#[0-9a-f]{6}\b|#[0-9a-f]{3}\b/i;
    const found = [...pages, ...scripts].filter((f) =>
      hex.test(fs.readFileSync(path.join(PUBLIC, f), "utf8"))
    );
    expect(found).toEqual([]);
  });
});

/** A document with the one attribute the theme sets. */
function fakeDoc() {
  const attrs = new Map<string, string>();
  return {
    attrs,
    documentElement: {
      setAttribute: (k: string, v: string) => attrs.set(k, v),
      removeAttribute: (k: string) => attrs.delete(k)
    }
  };
}

/** A host bus offering night mode when `night` is given. */
function fakeClient(night?: { enabled: boolean; auto?: boolean } | Error) {
  const handlers: ((name: string, params: unknown) => void)[] = [];
  return {
    hasCapability: (c: string) => c === "nightMode" && night !== undefined,
    subscribe: (patterns: string[], h: (name: string, params: unknown) => void) => {
      expect(patterns).toEqual(["nightMode.changed"]);
      handlers.push(h);
      return Promise.resolve(() => Promise.resolve());
    },
    call: (method: string) => {
      expect(method).toBe("nightMode.get");
      return night instanceof Error ? Promise.reject(night) : Promise.resolve(night);
    },
    emit: (params: unknown) => handlers.forEach((h) => h("nightMode.changed", params))
  };
}

describe("the scheme a page shows", () => {
  test("the host's night mode shows night, and off follows the OS again", async () => {
    const doc = fakeDoc();
    const seen: (string | null)[] = [];
    const client = fakeClient({ enabled: true, auto: false });
    await expect(THEME.followHost(client, doc, (s: string | null) => seen.push(s))).resolves.toBe(
      "night"
    );
    expect(doc.attrs.get("data-scheme")).toBe("night");
    client.emit({ enabled: false, auto: true });
    expect(doc.attrs.has("data-scheme")).toBe(false);
    client.emit({ enabled: true, auto: true });
    expect(doc.attrs.get("data-scheme")).toBe("night");
    expect(seen).toEqual(["night", null, "night"]);
  });

  test("a host without night mode, or one that fails to answer, leaves the OS's scheme", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      for (const client of [fakeClient(), fakeClient(new Error("no answer"))]) {
        const doc = fakeDoc();
        await expect(THEME.followHost(client, doc)).resolves.toBeNull();
        expect(doc.attrs.has("data-scheme")).toBe(false);
      }
    } finally {
      warn.mockRestore();
    }
  });

  test("setup takes the panel's scheme from its URL, and nothing else", () => {
    expect(THEME.schemeFromUrl("http://h/setup.html?from=details&scheme=night")).toBe("night");
    expect(THEME.schemeFromUrl("http://h/setup.html?from=details")).toBeNull();
    expect(THEME.schemeFromUrl("http://h/setup.html?scheme=neon")).toBeNull();
    expect(THEME.schemeFromUrl("not a url")).toBeNull();
    const doc = fakeDoc();
    THEME.applyScheme(doc, "dusk");
    expect(doc.attrs.get("data-scheme")).toBe("dusk");
    THEME.applyScheme(doc, "neon");
    expect(doc.attrs.has("data-scheme")).toBe(false);
  });
});
