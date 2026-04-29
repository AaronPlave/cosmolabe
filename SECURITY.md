# Security Policy

## Supported Versions

This project is in early development (pre-1.0). Only the latest commit on `main` is supported. There is no LTS branch.

## Reporting a Vulnerability

If you discover a security issue, please **do not** open a public GitHub issue.

Instead, use GitHub's [private vulnerability reporting](https://github.com/AaronPlave/cosmolabe/security/advisories/new) for this repository. You can also contact the maintainer directly at the email on [@AaronPlave](https://github.com/AaronPlave)'s GitHub profile.

Please include:

- A description of the issue and its impact
- Steps to reproduce, or a proof-of-concept
- The affected package(s) and version(s)

You should expect an initial response within a few days. Once the issue is confirmed, a fix will be prepared and disclosed alongside a release.

## Scope

In-scope:

- The published `@cosmolabe/*` packages
- The viewer apps (`apps/viewer`, `apps/cesium-viewer`)
- The build/release pipeline

Out-of-scope:

- Vulnerabilities in upstream dependencies (please report those upstream — e.g. `cesium`, `three`, `timecraftjs`)
- Issues that require physical access to a user's machine
- Self-XSS or social-engineering scenarios
