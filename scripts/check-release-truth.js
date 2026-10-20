#!/usr/bin/env node
"use strict";

// Release truth gate: the package that gets packed must match what the docs
// and workflows say about it. Run after `npm run build` by CI and by the
// package workflow before `npm pack`. With --publish (prepublishOnly) the
// changelog section must also carry a release date, not "Unreleased".

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const publishing = process.argv.includes("--publish");
const failures = [];

function fail(message) {
  failures.push(message);
}

function readText(relativePath) {
  try {
    return fs.readFileSync(path.join(root, relativePath), "utf8");
  } catch (err) {
    fail(`Cannot read ${relativePath}: ${err.message}`);
    return "";
  }
}

let packageJson = {};
try {
  packageJson = JSON.parse(readText("package.json"));
} catch (err) {
  fail(`Cannot parse package.json: ${err.message}`);
}

const version = packageJson.version;
if (typeof version !== "string" || !version) {
  fail("package.json is missing a valid version field");
} else {
  const changelog = readText("CHANGELOG.md");
  const heading = changelog.split("\n").find((line) => line.startsWith(`## [${version}]`));
  if (heading === undefined) {
    fail(`CHANGELOG.md must contain a "## [${version}]" section for the package version.`);
  } else if (publishing && !/^## \[[^\]]+\] - \d{4}-\d{2}-\d{2}$/.test(heading.trim())) {
    fail(
      `CHANGELOG.md "${heading.trim()}" must be dated "## [${version}] - YYYY-MM-DD" to publish.`
    );
  }
}

const packageFiles = Array.isArray(packageJson.files) ? packageJson.files : [];
for (const requiredFile of ["lib/", "public/", "CHANGELOG.md"]) {
  if (!packageFiles.includes(requiredFile)) {
    fail(`package.json files must include "${requiredFile}".`);
  }
}

// The plugin entry and the vendored Plotter Extensions client are build output.
for (const builtPath of ["lib/index.js", "public/vendor/plotterext-bus/extension.js"]) {
  if (!fs.existsSync(path.join(root, builtPath))) {
    fail(`${builtPath} is missing: run npm run build first.`);
  }
}

if (packageJson.main !== "lib/index.js") {
  fail(`package.json main must be "lib/index.js" (got "${packageJson.main}").`);
}

const keywords = Array.isArray(packageJson.keywords) ? packageJson.keywords : [];
if (!keywords.includes("signalk-node-server-plugin")) {
  fail('package.json keywords must include "signalk-node-server-plugin".');
}

const packageWorkflow = readText(".github/workflows/package-tarball.yml");
const buildIndex = packageWorkflow.indexOf("npm run build");
const packIndex = packageWorkflow.indexOf("npm pack");
const releaseCheckIndex = packageWorkflow.indexOf("npm run check:release-docs");

if (buildIndex === -1) {
  fail(".github/workflows/package-tarball.yml must run npm run build.");
}
if (packIndex === -1) {
  fail(".github/workflows/package-tarball.yml must run npm pack.");
}
if (buildIndex !== -1 && packIndex !== -1 && buildIndex > packIndex) {
  fail(".github/workflows/package-tarball.yml must build before packing.");
}
if (releaseCheckIndex === -1) {
  fail(".github/workflows/package-tarball.yml must run npm run check:release-docs.");
}
if (releaseCheckIndex !== -1 && packIndex !== -1 && releaseCheckIndex > packIndex) {
  fail(".github/workflows/package-tarball.yml must check release docs before packing.");
}

if (failures.length > 0) {
  process.stderr.write("Release truth check failed:\n");
  for (const failure of failures) {
    process.stderr.write(`- ${failure}\n`);
  }
  process.exit(1);
}

process.stdout.write("check-release-truth: release docs and package truth look consistent\n");
