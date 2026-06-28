# Security Policy

`lumina-backend` manages sensitive financial data — vesting schedules, token
allocations, KYC/PII information and legal documents. We take the security of
the platform and its dependency supply chain seriously.

## Supported versions

Security fixes are applied to the `main` branch and the most recent release.
Older releases are not maintained.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Report privately through one of the following channels:

1. **GitHub Private Vulnerability Reporting** (preferred) — open the repository's
   **Security** tab and click **"Report a vulnerability"**. This opens a private
   advisory visible only to maintainers.
2. **Email** — send details to the maintainers at the address listed on the
   repository's organization profile, with `[SECURITY]` in the subject line.

Please include:

- A description of the vulnerability and its impact.
- Step-by-step reproduction (PoC, affected endpoint/contract, versions).
- Any known mitigations or suggested fixes.

## Disclosure process / playbook

| Stage | Target time | Owner |
| --- | --- | --- |
| Acknowledge receipt | within **48 hours** | Maintainers |
| Initial severity triage (CVSS) | within **5 business days** | Security reviewer |
| Fix developed & validated | depends on severity (see below) | Maintainers |
| Coordinated disclosure / advisory published | after a fix is released | Maintainers + reporter |

### Severity-based remediation targets

| Severity | Remediation target |
| --- | --- |
| Critical (CVSS 9.0–10.0) | Patch within **72 hours**; hotfix release |
| High (7.0–8.9) | Patch within **7 days** |
| Medium (4.0–6.9) | Patch within **30 days** |
| Low (< 4.0) | Next scheduled release |

We aim to keep reporters informed at each stage and to credit them in the
published advisory unless they request to remain anonymous. We do not currently
operate a paid bug-bounty program.

## Dependency vulnerabilities

Automated scanning (Dependabot, Snyk, `npm audit`, `cargo audit`) and SBOM
generation are documented in
[`docs/dependency-management.md`](docs/dependency-management.md). If you find a
vulnerable dependency, you may open a normal issue/PR referencing the advisory —
private reporting is only required for vulnerabilities in **our own** code or
configuration.
