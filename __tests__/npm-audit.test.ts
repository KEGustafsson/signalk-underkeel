import { execFileSync } from "child_process";
import path from "path";

const ROOT = path.resolve(__dirname, "..");

// Audits the third-party code the package ships, through scripts/audit-shipped.js:
// the runtime dependency tree and the vendored signalk-plotterext-bus client
// in public/vendor/. Build/test tooling never reaches an operator, so a
// dev-tree advisory must not gate `npm test`; dev-tree advisories are
// surfaced by the CI audit job instead.
//
// `npm audit` queries the registry, so the report can be unavailable offline.
// That case is reported explicitly rather than coerced to "zero
// vulnerabilities" — a missing report is absent evidence, not a clean result.
//
// The Signal K plugin registry harness runs this suite inside `firejail
// --net=none` and sets SIGNALK_REGISTRY_TEST=1. The registry is unreachable
// there by construction, so the audit is skipped outright.

type Report = {
  packages: string[];
  vulnerabilities: Record<string, number>;
  advisories: { name: string; severity: string }[];
};
type AuditResult = { ok: true; report: Report } | { ok: false; reason: string };

const SCRIPT = path.join(ROOT, "scripts", "audit-shipped.js");

function parse(stdout: string): AuditResult {
  try {
    return { ok: true, report: JSON.parse(stdout) as Report };
  } catch (err) {
    return { ok: false, reason: `audit-shipped did not print JSON: ${(err as Error).message}` };
  }
}

function runAudit(): AuditResult {
  if (process.env.SIGNALK_REGISTRY_TEST === "1") {
    return { ok: false, reason: "SIGNALK_REGISTRY_TEST=1 — sandboxed run has no registry access" };
  }
  try {
    return parse(
      execFileSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: "utf8", stdio: "pipe" })
    );
  } catch (err) {
    // Exit 1: advisories found, report on stdout. Exit 2: no report.
    const e = err as { status?: number; stdout?: string; stderr?: string; message: string };
    if (e.status === 1 && e.stdout) {
      return parse(e.stdout);
    }
    return { ok: false, reason: e.stderr?.trim() || e.message };
  }
}

describe("npm audit (shipped dependencies)", () => {
  let report: Report | null = null;
  let unavailable: string | null = null;

  beforeAll(() => {
    const result = runAudit();
    if (result.ok) {
      report = result.report;
    } else {
      unavailable = result.reason;
    }
  });

  test("audit report is available and covers the vendored client", () => {
    if (unavailable) {
      console.warn(`npm audit unavailable, advisory assertions skipped: ${unavailable}`);
      return;
    }
    expect(report?.packages).toContain("signalk-plotterext-bus");
  });

  test("no high or critical severity vulnerabilities", () => {
    if (unavailable) {
      return;
    }
    expect(report?.vulnerabilities.high).toBe(0);
    expect(report?.vulnerabilities.critical).toBe(0);
  });

  test("no advisory against any shipped package", () => {
    if (unavailable) {
      return;
    }
    expect(report?.advisories).toEqual([]);
  });
});
