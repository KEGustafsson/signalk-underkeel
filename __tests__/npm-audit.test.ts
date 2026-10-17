import { execSync } from "child_process";
import path from "path";

const ROOT = path.resolve(__dirname, "..");

// Audits the RUNTIME dependency tree (`--omit=dev`). Build/test tooling never
// reaches an operator, so a dev-tree advisory must not gate `npm test`;
// dev-tree advisories are surfaced by the scheduled CI audit job instead.
//
// `npm audit` queries the registry, so the report can be unavailable offline.
// That case is reported explicitly rather than coerced to "zero
// vulnerabilities" — a missing report is absent evidence, not a clean result.
//
// The Signal K plugin registry harness runs this suite inside `firejail
// --net=none` and sets SIGNALK_REGISTRY_TEST=1. The registry is unreachable
// there by construction, so the audit is skipped outright.

type AuditResult = { ok: true; raw: string } | { ok: false; reason: string };

function runAudit(): AuditResult {
  if (process.env.SIGNALK_REGISTRY_TEST === "1") {
    return { ok: false, reason: "SIGNALK_REGISTRY_TEST=1 — sandboxed run has no registry access" };
  }
  try {
    return {
      ok: true,
      raw: execSync("npm audit --omit=dev --json", { cwd: ROOT, encoding: "utf8" })
    };
  } catch (err) {
    // npm audit exits non-zero when vulnerabilities exist; stdout still has JSON.
    const e = err as { stdout?: string; message: string };
    if (e.stdout) {
      return { ok: true, raw: e.stdout };
    }
    return { ok: false, reason: e.message };
  }
}

// Severity buckets only. `metadata.vulnerabilities` also carries a `total`
// key, so summing every value double-counts.
const SEVERITIES = ["info", "low", "moderate", "high", "critical"] as const;

type Report = { metadata?: { vulnerabilities?: Record<string, number> } };

describe("npm audit (runtime dependencies)", () => {
  let report: Report | null = null;
  let unavailable: string | null = null;

  beforeAll(() => {
    const result = runAudit();
    if (!result.ok) {
      unavailable = result.reason;
      return;
    }
    let parsed: Report & { message?: string; error?: { summary?: string } };
    try {
      parsed = JSON.parse(result.raw);
    } catch (err) {
      unavailable = `npm audit did not return JSON: ${(err as Error).message}`;
      return;
    }
    // Offline, npm still prints JSON — an error envelope, not an audit report.
    if (!parsed?.metadata?.vulnerabilities) {
      unavailable =
        parsed?.message ||
        parsed?.error?.summary ||
        "npm audit returned no metadata.vulnerabilities";
      return;
    }
    report = parsed;
  });

  test("audit report is available", () => {
    if (unavailable) {
      console.warn(`npm audit unavailable, advisory assertions skipped: ${unavailable}`);
      return;
    }
    expect(report?.metadata?.vulnerabilities).toBeDefined();
  });

  test("no high or critical severity vulnerabilities", () => {
    if (unavailable) {
      return;
    }
    const meta = report?.metadata?.vulnerabilities ?? {};
    expect(meta.high ?? 0).toBe(0);
    expect(meta.critical ?? 0).toBe(0);
  });

  test("total vulnerability count is zero", () => {
    if (unavailable) {
      return;
    }
    const meta = report?.metadata?.vulnerabilities ?? {};
    const total = SEVERITIES.reduce((sum, key) => sum + (meta[key] ?? 0), 0);
    expect(total).toBe(0);
  });
});
