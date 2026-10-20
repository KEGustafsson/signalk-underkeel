# Release Checklist

Run this sequence before publishing a package or changing release automation.

1. `npm run lint`
2. `npm run format:check`
3. `npm run check:ts` and `npm run check:ts:tests`
4. `npm run build`
5. `npm test`
6. `npm run check:release-docs`
7. `npm pack --ignore-scripts`

`npm run verify:ci-local` runs steps 1–6 in one command, with tests under coverage.

The release documentation check (`scripts/check-release-truth.js`) verifies that:

- the changelog has a section for the package version;
- the package publishes the compiled plugin, the browser pages and the changelog, and declares
  the entry point and keyword the Signal K server needs to load it;
- the build output, including the vendored browser bus, exists;
- the package workflow builds and runs the release check before packing.

Before `npm publish`, date the version's changelog heading (`## [0.1.0] - 2026-10-19`, not
`Unreleased`). `npm publish` runs `prepublishOnly`, which builds and runs the check with
`--publish`; that mode refuses an undated heading.

Before a release, also run the **SignalK Plugin CI** workflow manually with
"Run armv7 (Cerbo GX) tests via QEMU" ticked; the automatic runs skip armv7.
