# Security

AGMessage runs on a show laptop and carries what a board, a crew and a venue say to each other, and what their screens
show. This page says how to report a problem, which builds are supported, and what the project checks on every change.

## Reporting a vulnerability

Please report it privately: GitHub → this repository → **Security → Report a vulnerability** (private advisory), or
email the maintainer. Say what you found, the build (`/api/health` → `build`, e.g. `0.5.0+17.abc1234`) and how to see
it. Please do not open a public issue for a vulnerability. You will hear back within a week; a fix for a confirmed
problem ships as a patch release, with credit if you want it.

## Supported builds

| Build | Supported |
|---|---|
| The newest release (`vX.Y.Z` on GitHub Releases) | yes |
| The release before it | security fixes only, for 90 days after the newer one |
| Development builds (`X.Y.Z-dev.N+sha`) and local copies (`X.Y.Z-dev`) | no — they are previews of the next release |

## What is checked on every change

`docs/ANALYSIS.md` has the detail. In short: ESLint with the security rules and the house's banned calls as build
fences; a rule that refuses unescaped values on their way into a page's HTML; an in-tree secret scan; CodeQL
(`security-extended`); `npm audit` with registry signatures and provenance; dependency review on pull requests; the
tests, the coverage gate and the browser smoke on Linux and Windows. A release carries its SBOM (CycloneDX),
`SHA256SUMS` and a build-provenance attestation (`gh attestation verify <zip> --repo <owner>/AGMessage`).

## Recommended repository settings

Turn on GitHub's secret scanning with push protection, Dependabot alerts and security updates, private vulnerability
reporting, and branch protection on `main` requiring the CI and Security checks.

## The design, briefly

- Identities are issued and signed by the server; accounts' passwords are hashed with scrypt; sessions are random,
  stored only as hashes, `HttpOnly`, `SameSite=Strict` and `Secure` over HTTPS; logins are rate limited and locked out.
- Saved keys and tokens are sealed at rest (AES-256-GCM) with a machine key kept outside the app folder.
- Uploads are allow-listed by type and checked by content; they are served so they cannot run script.
- Pages carry a strict Content-Security-Policy with no inline script.
- Links to Stagewatch, Patterns and PlayMap pin each peer's certificate; keys travel in headers, never in a URL. A
  Stagewatch certificate is pinned only once Stagewatch accepted the link's key, and a refused key is asked again at
  most once a minute, so it never locks this machine's other links out of Stagewatch.
- A Patterns or PlayMap pairing token is full control of that node: it goes only to a loopback address, or over TLS to
  a certificate that is pinned or that a person confirmed by typing at least 16 characters of its fingerprint from the
  node's own screen; AGMessage never drives a node with it — lines are proposed to the show desk (Show Bus §11).
- Security-relevant actions (sign-ins, permission changes, what a display was told to show) are written to a
  hash-chained audit log that shows tampering.
- Display URLs are capability links: unguessable, revocable, never logged, and only able to show — not to send.
