#!/usr/bin/env node
"use strict";

// Audits the third-party code the package ships: its runtime dependencies and
// the browser client that scripts/vendor-bus.js copies into public/vendor/.
// That client is a devDependency, so `npm audit --omit=dev` never sees it.
//
// Prints { packages, vulnerabilities, advisories } as JSON on stdout, where
// vulnerabilities counts the shipped packages' advisories by severity.
// Exits 1 when one is at or above --audit-level (default low), and 2 when
// npm returns no audit report (offline, registry error).

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const VENDORED = ["signalk-plotterext-bus"];
const SEVERITIES = ["info", "low", "moderate", "high", "critical"];

const levelArg = process.argv.find((a) => a.startsWith("--audit-level="));
const level = levelArg ? levelArg.slice("--audit-level=".length) : "low";
if (!SEVERITIES.includes(level)) {
  process.stderr.write(`audit-shipped: unknown --audit-level ${level}\n`);
  process.exit(2);
}

const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

/** Lockfile paths of the shipped packages and everything they depend on. */
function shippedPaths() {
  const seen = new Set();
  // Node resolves a dependency in the nearest node_modules up from its dependent.
  const resolve = (name, from) => {
    for (let dir = from; ; dir = dir.slice(0, Math.max(dir.lastIndexOf("/node_modules/"), 0))) {
      const at = dir === "" ? `node_modules/${name}` : `${dir}/node_modules/${name}`;
      if (lock.packages[at] || dir === "") {
        return at;
      }
    }
  };
  const visit = (name, from) => {
    const at = resolve(name, from);
    const entry = lock.packages[at];
    if (!entry) {
      throw new Error(`${name} (needed by ${from || "the package"}) is not in package-lock.json`);
    }
    if (seen.has(at)) {
      return;
    }
    seen.add(at);
    for (const dep of Object.keys({ ...entry.dependencies, ...entry.optionalDependencies })) {
      visit(dep, at);
    }
  };
  for (const name of [...Object.keys(pkg.dependencies ?? {}), ...VENDORED]) {
    visit(name, "");
  }
  return seen;
}

function runAudit() {
  try {
    return execFileSync("npm", ["audit", "--json"], { cwd: root, encoding: "utf8" });
  } catch (err) {
    // npm audit exits non-zero when any advisory exists; stdout still has the report.
    if (err.stdout) {
      return err.stdout;
    }
    process.stderr.write(`audit-shipped: npm audit failed: ${err.message}\n`);
    process.exit(2);
  }
}

const paths = shippedPaths();
let report;
try {
  report = JSON.parse(runAudit());
} catch (err) {
  process.stderr.write(`audit-shipped: npm audit did not return JSON: ${err.message}\n`);
  process.exit(2);
}
if (!report || typeof report.vulnerabilities !== "object" || !report.metadata) {
  const reason = report?.message || report?.error?.summary || "no audit report";
  process.stderr.write(`audit-shipped: ${reason}\n`);
  process.exit(2);
}

const advisories = Object.values(report.vulnerabilities)
  .filter((v) => (v.nodes ?? []).some((n) => paths.has(n)))
  .map((v) => ({ name: v.name, severity: v.severity, range: v.range }));
const vulnerabilities = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
for (const a of advisories) {
  vulnerabilities[a.severity] = (vulnerabilities[a.severity] ?? 0) + 1;
}

const packages = [...paths].map((p) => p.slice(p.lastIndexOf("node_modules/") + 13)).sort();
process.stdout.write(`${JSON.stringify({ packages, vulnerabilities, advisories }, null, 2)}\n`);
const blocking = SEVERITIES.slice(SEVERITIES.indexOf(level));
process.exit(advisories.some((a) => blocking.includes(a.severity)) ? 1 : 0);
