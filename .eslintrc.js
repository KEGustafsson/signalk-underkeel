module.exports = {
  env: {
    es2021: true,
    node: true,
    jest: true
  },
  extends: "eslint:recommended",
  plugins: ["@typescript-eslint"],
  overrides: [
    {
      files: ["__tests__/**/*.{js,ts}", "**/*.test.{js,ts}", "**/*.spec.{js,ts}"],
      env: {
        jest: true
      },
      rules: {
        "no-console": "off",
        "require-await": "off"
      }
    },
    {
      files: ["__tests__/benchmarks/**/*.{js,ts}", "scripts/**/*.js"],
      rules: {
        "no-console": "off"
      }
    },
    // ── TypeScript sources ──────────────────────────────────────────────────
    // Type-aware concerns (unused vars, undefined names) are owned by
    // `tsc --noEmit` (check:ts), so the corresponding lint rules are off to
    // avoid double-reporting / false positives on TS syntax. Formatting is
    // owned by Prettier.
    {
      files: ["**/*.ts"],
      parser: "@typescript-eslint/parser",
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module"
      },
      rules: {
        "no-unused-vars": "off",
        "no-undef": "off",
        "no-redeclare": "off"
      }
    },
    // ── Module guardrails ───────────────────────────────────────────────────
    // Small, single-purpose modules. The hot path (spatial queries and the
    // look-ahead tick) must stay readable enough to review for safety.
    {
      files: ["src/**/*.ts"],
      rules: {
        "max-lines": ["warn", { max: 400, skipBlankLines: true, skipComments: true }],
        "max-lines-per-function": ["warn", { max: 80, skipBlankLines: true, skipComments: true }],
        "max-statements": ["warn", 30],
        complexity: ["warn", 15]
      }
    },
    // Import-boundary rule: a module may import only its own layer or layers
    // BELOW it:
    //   foundation < ingest < spatial < model < engine < livechart < api
    // `src/index.ts` (plugin entry) sits above all of them. Patterns for
    // directories that do not exist yet are inert until they are created.
    {
      files: ["src/foundation/**/*.ts"],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            patterns: [
              "**/ingest/**",
              "**/spatial/**",
              "**/model/**",
              "**/engine/**",
              "**/livechart/**",
              "**/api/**"
            ]
          }
        ]
      }
    },
    {
      files: ["src/ingest/**/*.ts"],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            patterns: [
              "**/spatial/**",
              "**/model/**",
              "**/engine/**",
              "**/livechart/**",
              "**/api/**"
            ]
          }
        ]
      }
    },
    {
      files: ["src/spatial/**/*.ts"],
      rules: {
        "no-restricted-imports": [
          "error",
          { patterns: ["**/model/**", "**/engine/**", "**/livechart/**", "**/api/**"] }
        ]
      }
    },
    {
      files: ["src/model/**/*.ts"],
      rules: {
        "no-restricted-imports": [
          "error",
          { patterns: ["**/engine/**", "**/livechart/**", "**/api/**"] }
        ]
      }
    },
    {
      files: ["src/engine/**/*.ts"],
      rules: {
        "no-restricted-imports": ["error", { patterns: ["**/livechart/**", "**/api/**"] }]
      }
    },
    {
      files: ["src/livechart/**/*.ts"],
      rules: {
        "no-restricted-imports": ["error", { patterns: ["**/api/**"] }]
      }
    }
  ],
  ignorePatterns: ["public/**", "node_modules/**", "coverage/**", "lib/**", "fixtures/**"],
  parserOptions: {
    ecmaVersion: "latest",
    sourceType: "module"
  },
  rules: {
    // Error prevention
    "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    "no-console": ["warn", { allow: ["warn", "error"] }],
    "no-prototype-builtins": "error",
    eqeqeq: ["error", "always"],
    "no-var": "error",
    "prefer-const": "error",

    // Security
    "no-eval": "error",
    "no-implied-eval": "error",

    // Best practices
    curly: ["error", "all"],
    "no-throw-literal": "error",
    "require-await": "warn"
  }
};
