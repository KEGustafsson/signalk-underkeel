# Release Checklist

Run this sequence before publishing a package or changing release automation.

1. `npm run lint`
2. `npm run format:check`
3. `npm run check:ts`
4. `npm run build`
5. `npm test`
6. `npm run check:release-docs`
7. `npm pack --ignore-scripts`

`npm run verify:ci-local` runs steps 1–6 in one command, with tests under coverage.

The release documentation check (`scripts/check-release-truth.js`) verifies that:

- `CHANGELOG.md` has a section for the version in `package.json`;
- `package.json` publishes `lib/` and `CHANGELOG.md`, points `main` at `lib/index.js` and
  carries the `signalk-node-server-plugin` keyword;
- the publish workflow builds and runs the release check before `npm pack`.

Before a release, also run the **SignalK Plugin CI** workflow manually with
"Run armv7 (Cerbo GX) tests via QEMU" ticked; the automatic runs skip armv7.
