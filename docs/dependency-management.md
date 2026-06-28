# Dependency Management & Supply-Chain Security

This document describes how `lumina-backend` keeps its dependency trees
(JavaScript/TypeScript via npm, and Rust/Soroban via Cargo) free of known
vulnerabilities, and how Software Bills of Materials (SBOMs) are produced for
compliance (SOC 2, ISO 27001) and incident response. (Issue #12.)

## Tooling overview

| Tool | Scope | Where it runs | Blocking? |
| --- | --- | --- | --- |
| **Dependabot** | npm (`/backend`), Cargo (`/contracts`, `/contracts/merkle_vault`), GitHub Actions | Scheduled PRs | n/a (opens PRs) |
| **Snyk** | npm dependency tree | `vulnerability-scan.yml` (`snyk-scan`) + local `npm run snyk:test` | Non-blocking until `SNYK_TOKEN` is configured |
| **npm audit** | npm dependency tree | `vulnerability-scan.yml` (`npm-audit`) + `npm run audit:ci` | Non-blocking (transitive advisories tracked separately) |
| **cargo audit** | Cargo / RustSec advisories | `vulnerability-scan.yml` (`cargo-audit`) + `contracts/build.{sh,ps1}` | Non-blocking in CI; **blocking** in the build scripts |
| **SBOM (CycloneDX)** | npm + Cargo | `vulnerability-scan.yml` (`sbom`) → uploaded artifact | n/a |

> **Why Snyk runs via the GitHub Action / `npx` rather than as a vendored
> `devDependency`:** this repository commits its `node_modules/` tree, so adding
> Snyk's large dependency graph as a `devDependency` would bloat the committed
> tree by thousands of files. Instead, CI uses the pinned official
> `snyk/actions/node` action, and local runs use `npx snyk` — both honour the
> `backend/.snyk` policy file. The SBOM uses the built-in `npm sbom` command,
> which needs no extra dependency.

## Scanning schedule

- **On every push & pull request** to `main` / `develop`: Snyk, npm audit,
  cargo audit and SBOM generation run via `.github/workflows/vulnerability-scan.yml`.
- **Daily at 03:00 UTC**: the full scan re-runs on a cron to catch CVEs
  published after a PR merged.
- **Weekly (Mondays 06:00 UTC)**: Dependabot opens update PRs for npm, Cargo and
  GitHub Actions (`.github/dependabot.yml`).

## Software Bill of Materials (SBOM)

SBOMs are generated in CycloneDX JSON format on every CI run and published as the
`sbom-cyclonedx` artifact (90-day retention). Generate them locally with:

```bash
# npm production SBOM -> reports/sbom/lumina-backend.cdx.json
cd backend && npm run sbom

# Cargo SBOM (optional)
cargo install cargo-cyclonedx
cd contracts && cargo cyclonedx --format json
```

Generated SBOM files live in [`reports/sbom/`](../reports/sbom/) and are
git-ignored (they are build artifacts). The directory is kept via its README.

## Handling a flagged vulnerability

1. **Triage** — confirm the advisory applies (reachable code path, affected
   versions). Record CVSS severity.
2. **Remediate** — bump to the patched version. For npm let Dependabot's PR
   drive it; for Cargo bump the crate in the relevant `Cargo.toml`.
3. **If no fix exists yet** — apply a mitigation and, only if justified, add a
   *time-boxed* exemption (see below).
4. **Verify** — re-run the relevant scan (`npm run snyk:test`, `npm run
   audit:ci`, or `cd contracts && cargo audit`).

## Exemption (false-positive / accepted-risk) policy

Exemptions are a last resort and must be **time-boxed and justified**:

- **npm/Snyk** — add an entry to [`backend/.snyk`](../backend/.snyk) with a
  `reason` and an `expires` date. Never add an open-ended ignore.
- **cargo audit** — add the advisory ID to an `[advisories.ignore]` list in a
  `contracts/audit.toml` (create it when first needed) with a comment linking
  the tracking issue and a review date.
- Every exemption requires reviewer approval in the PR and a linked tracking
  issue. Re-evaluate at each expiry; do not blindly extend.

## Escalation path for critical vulnerabilities

| Severity | Action | Timeline |
| --- | --- | --- |
| **Critical** | Page the maintainers; open a private advisory; ship a hotfix release | Patch within **72h** |
| **High** | Open a tracking issue labelled `security`; prioritise in the current cycle | Patch within **7 days** |
| **Medium** | Tracked via the normal Dependabot/Snyk PR flow | Within **30 days** |
| **Low** | Addressed in the next scheduled dependency update | Next release |

For vulnerabilities in our **own** code (not a dependency), follow the private
reporting process in [`SECURITY.md`](../SECURITY.md).
