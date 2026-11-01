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
`SHA256SUMS` and a build-provenance attestation (`gh attestation verify <zip> --repo <owner>/AGMessage`). The SBOM lists
npm's packages and the browser libraries vendored in `app/public/vendor`, each of those with its file's SHA-256 and the
libraries bundled in it, read from the bundle as the zip extracts it. Each vendored file is its package's file byte for
byte, listed in `app/public/vendor/VENDOR.json` with where it came from, its package's digest and its SHA-256; a test
fails the build on a file not listed, bytes that differ, a file no page loads, or a licence that is not one of those
allowed, and the SBOM's job stops on a shipped file whose bytes are not the ones listed, or a bundle without the list,
the notices and every licence text. Their licences ship in `THIRD-PARTY-NOTICES.md` and `licenses/`.

`npm audit` cannot see the vendored libraries, which are in no lockfile. `tools/vendor-audit.js` (part of `npm run
audit`, and a step of the Security workflow's weekly run) asks npm's registry for the advisories against every version
`VENDOR.json` lists, the libraries bundled inside each file included, and fails on a high or critical one `VENDOR.json`
does not assess. Each assessment says whether the advisory applies here, why, and what bounds it, and the SBOM carries
it as that vulnerability's analysis. The one that applies today: the XML parser inside mammoth (xmldom 0.8.6, which
mammoth 1.13.0, its newest release, still bundles) can be kept busy for a long time, or run short of memory, by a
crafted Word file, which holds the page that draws it (the panel of whoever opens it, and the Board's panels, where a
file sent into the hall opens itself) until it is reloaded; the server and other pages are not affected. Until 0.6.0's
readers run mammoth in a worker with a deadline, the upload cap and who may send into a hall are what bound it.
`THIRD-PARTY-NOTICES.md` lists each advisory and its assessment.

## Recommended repository settings

Turn on GitHub's secret scanning with push protection, Dependabot alerts and security updates, private vulnerability
reporting, and branch protection on `main` requiring the CI and Security checks.

## The design, briefly

- Identities are issued and signed by the server; accounts' passwords are hashed with scrypt; sessions are random,
  stored only as hashes, `HttpOnly`, `SameSite=Strict` and `Secure` over HTTPS; logins are rate limited and locked out.
  A browser signed in to an account is refused a code join, so an account never seats itself as a guest with rights
  its own do not hold; a join's role that the page does not offer is refused.
- One person's pages relay to each other only the settings a page applies, each read by its type and rebuilt; the
  admin's support view acts only on what the admin page that frames it sends (its parent, from this origin).
- Saved keys and tokens are sealed at rest (AES-256-GCM) with a machine key kept outside the app folder.
- Uploads are allow-listed by type and checked by content; they are served so they cannot run script.
- Pages carry a strict Content-Security-Policy with no inline script.
- Links to Stagewatch, Patterns and PlayMap pin each peer's certificate; keys travel in headers, never in a URL. A
  Stagewatch certificate is pinned only once Stagewatch accepted the link's key; the key goes in no request but the one
  that asks for that verdict until then; and refused keys are asked again at most once a minute, shared by every link
  of this machine to that Stagewatch, so they never lock this machine out of it.
- A Patterns or PlayMap pairing token is full control of that node: it goes only to a loopback address, or over TLS to
  a certificate that is pinned or that a person confirmed by typing at least 16 characters of its fingerprint from the
  node's own screen; AGMessage never drives a node with it — lines are proposed to the show desk (Show Bus §11).
- Security-relevant actions (sign-ins, permission changes, the admin's room controls, the proposals Stagewatch's show
  desk takes, the lines sent straight to the speaker's screen, what kind of thing a display was told to show) are
  written to an audit log chained with a key (HMAC-SHA256 under a key derived from the machine key) that shows
  tampering, never with a message's text or a file's name (screen takes logged by 0.5.1 and earlier quote a message's
  first words and name the file). Its records (the newest entry on disk, the log written last and where) are kept
  beside the machine key, outside the data folder, so entries removed or a whole log replaced while AGMessage is
  stopped are found at the next start. Entries this laptop cannot check (0.5.1's, another key's) read △ until the
  person at the laptop accepts them by typing the admin token into the dialog: never a sign-in, which is a record in
  the data folder anyone who can write it could add.
- The audit log is exported signed, to be checked on another computer: the files byte for byte, the laptop's own check
  of them, `SHA256SUMS` and its Ed25519 signature. The signing key is derived from the machine key when an export signs
  and is never stored; its fingerprint is printed in the black window and on Admin → Health, and an auditor checks an
  export against their own record of it, never against the export (anyone can sign a bundle with a key of their own).
  Whoever holds `machine.key` can sign exports. Exporting is the right `audit.export`, admin-only (an account holding it
  signs in through the tunnel only when admins may), or the token at the laptop signed in by this run; from another
  device only over HTTPS. The export is an audit row, keeps no copy on the server, and carries personal data (names,
  addresses, what each did), which the dialog says. The verifier treats the bundle as untrusted input: only its fixed
  paths are read, a path that leaves the folder, a link or a file not listed ends the check before it is read, and its
  words are printed with control characters escaped; the browser verifier is one page whose policy lets it load nothing
  and send nothing.
- The audit log carries on across events as one chain. The admin (the token, or an account whose role is admin; never a
  manager granted `settings.manage`) may split it at an archive point: the older files move, never copied and never
  deleted, into a signed archive in `app\data\audit-archive\`, pinned by the SHA-256 of its `SHA256SUMS` in a keyed entry
  written before anything moves. A split is refused while anything before the point is open or broken, so it can never
  make the log read better than it did, and the check's mark is the worst of the live log's and each archive's. An archive
  moved off the laptop or changed (a file cut, removed or resized, `archive.json` or `SHA256SUMS` changed) reads ✕ until
  the token accepts it; a byte changed in place is found by the archive's own Check and by every export, which hash each
  file in full. That Check reads no better than what pins the archive: its `SHA256SUMS` must be the one the split
  pinned, and an archive under this laptop's key id must be signed by this laptop's key (one re-signed by anyone else
  reads ✕); one the live log no longer reaches reads ◇ at best. An entry once chained is never withdrawn, so a split
  whose own entry the disk refused keeps its folder and waits, and a folder left by a split is never removed on a check
  that did not walk the log to its end. Whoever holds `machine.key` can sign archives as they can exports.
- What the keyed log cannot show: anything done by someone who can change AGMessage's code, its Node or its start
  script, or holds this machine's key. In the portable layout `app\data` sits beside `app\lib` and the start script under
  the same rights, so whoever can write the data folder can usually change the code too; keep the folder where only the
  show's Windows account can write it, never on a USB stick or a shared folder. A machine key that cannot be read is never
  replaced: that run is keyless, seals nothing and says so.
- A copy that cannot take its port reads who holds it once, from loopback, sending no token, and takes only the
  version, the build and whether it is the installed node, cleaned, to choose its words; nothing is decided on the
  answer. The browser is opened only by the portable copy, in the person's own session, through `explorer.exe` by its
  absolute path. The clean copy for giving the bundle away goes to a new folder each time and is deleted if anything of
  `app\data` or `app\uploads` is in it, so a copy handed on carries no accounts, keys or audit log.
- Display URLs are capability links: unguessable, revocable, never logged, and only able to show — not to send.
- Health's detail is for the admin and this laptop only (anyone else reads up or down, the version and the uptime). Its
  readings and the show day's peaks it keeps in `peaks.json` are numbers and days: the most sockets from one address
  and through the tunnel are counts, and no reading names an address, a hall or a person.
