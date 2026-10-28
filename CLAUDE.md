# AGMessage — the agent brief

Read this before any change. The papers people read are `README.md`, `README.txt` (the portable guide) and `docs/`;
this file is for whoever works the tree.

## What this is

AGMessage is the messenger of the show network (Stagewatch, Patterns, PlayMap): messages, files, help requests and
screens for every hall of a live event, on any browser on the venue network. One Node.js server (`app/server.js`, run by
the watchdog `app/supervise.js`) shipped as a portable Windows folder with its own Node runtime and cloudflared; no
install, no database. Crew, project managers and admins sign in with accounts; presenters and guests join with a hall's
6-character code. Each hall is a room with its own Stagewatch link, its screens (`/d/<token>` capability URLs) and its
help requests; the halls board shows every hall an account may see. It speaks Show Bus 1.2 (`docs/SHOWBUS.md`,
`docs/NODES.md`).

## The standing brief (the owner's)

Stability, resilience, speed, security and a clear, quick workflow — above all for the people on stage, who read a
message once, at a glance, under lights. Every change is followed down every chain it affects: the server, the pages
(hall, halls board, accounts, admin, screen), the right-click and button paths, the Show Bus (hello, context, links),
the AI's brief, the audit log, the tests and the papers. Gaming and medical practice for speed, security and
reliability (`docs/DESIGN.md` says which practice lives where). Every build is versioned (`app/lib/version.js`).

## The doctrine (Patterns')

- **Attempts are not facts.** Sent → accepted → applied → observed. A screen is "on screen" only when it confirms the
  numbered take; a send to Stagewatch reads its receipt and then the speaker's acknowledgement. Tests assert fields and
  published state, never words alone.
- **The server is the authority.** Identities and rights are issued and checked on the server; a client never names its
  own role or rights. Deny by default; nobody widens their own rights.
- **Fail closed.** An unknown verb, role, right, destination or content kind is refused, never defaulted. Secrets ride
  in no URL, no log line, no audit row, no hello, no context.
- **Latest wins for state.** Boards and frames carry the newest state; nothing builds a backlog for a slow client.
- **Measured, then governed.** No limit or governor lands without a measured cause and a deterministic test.

## Constraints that bite

- **The fences** (`docs/ANALYSIS.md`, `eslint.config.mjs`, `app/eslint-rules/`, `tools/scan-secrets.js`,
  `test/resilience.test.js`) apply to tests too: no empty catch without its reason, no unused bindings, no
  `Math.random` (use `node:crypto`), no shell (`spawn` with an argument array), no `rejectUnauthorized: false` outside
  the pin probe, no `process.exit` in `lib/`, no value into `innerHTML` that is not a literal, escaped, a count or a
  name ending in `Html`. Synchronous file calls per file are capped by a test. A silenced rule says why on its line.
- **Client input** reaches a socket handler through `guardHandlers` (a throw refuses that request, never the process)
  and is read by type: `guard.str`, never `String()` on a client value. `test/inputs.test.js` reads the event names
  from `server.js` and sends each every shape, so a new handler is held to it.
- **Every store** on disk goes through a `WriteLane` that is in `saveLanes()` (flushed at stop and crash, named in
  health); one server per data folder (the folder lock), and nothing is written before the lock and the port are held.
- **Test fixtures that look like keys** carry `// secret-scan: fixture` on their line.
- **The audit log** gets a row for every security-relevant action, never a secret, token or screen link.
- **The coverage gate** (`npm run coverage`) is raised as tests are added, never lowered to make a build green.
- **Node 24 LTS** (`engines`); CI also runs Node 26. CommonJS on the server, plain scripts in `app/public` (no build
  step, no inline script: the Content-Security-Policy forbids it).
- **Comments state the invariant**, not the history. No model or tool identifiers in anything pushed.
- **Never** skip, disable or quarantine a test to get green; never rewrite pushed history.

## The loop

```
cd app
npm ci
npm run check        # ESLint fences, the secret scan, every test under the coverage gate — must exit 0 before a commit
npm test             # the tests alone; end-to-end tests start a real server on a throwaway data folder
node --test test/displays.test.js                     # one file
AGM_BROWSER=<chrome or edge> npm run smoke            # the browser smoke (every page, sign-in, a hall, a screen)
npm run audit        # shipped packages' advisories and registry signatures
node ../tools/stamp-build.js --print                  # the version this checkout would carry
```

CI (`.github/workflows/ci.yml`): `analyze` (lint, secret scan, version), `test-linux` (Node 24 and 26, coverage,
Chrome smoke), `test-windows` (tests, Edge smoke), `package` (the stamped portable zip, CycloneDX SBOM, SHA256SUMS) and,
on a `v*` tag that names `app/package.json`'s version, `release` with a build-provenance attestation.
`.github/workflows/security.yml`: CodeQL `security-extended`, the dependency audit, dependency review on pull requests.

## Where things live

| What | Where |
|---|---|
| The server: routes, sockets, rooms, the board tick, links, screens | `app/server.js` |
| The watchdog | `app/supervise.js` |
| Rooms, the op log and snapshots, atomic saves | `app/lib/store.js`, `app/lib/resilience.js` |
| Identities, rate limits, lockouts, text cleaning | `app/lib/guard.js` |
| Rights and roles (pure) | `app/lib/rbac.js` |
| Accounts, password hashing, sessions; their routes | `app/lib/accounts.js`, `app/lib/http-accounts.js` |
| The audit log (hash chain) | `app/lib/audit.js` |
| The halls board and help requests | `app/lib/board.js` |
| Screens (display URLs) | `app/lib/displays.js`, `app/public/display.*` |
| Stagewatch links, peers, hello | `app/lib/nodes.js` |
| What a send to Stagewatch says (and Stagewatch's grammar, ported as the oracle) | `app/lib/stagelines.js` |
| Patterns and PlayMap links | `app/lib/peerlinks.js` |
| The context other show systems read | `app/lib/context.js` |
| HTTPS and certificate pins | `app/lib/tls.js` |
| Sealed secrets | `app/lib/secretbox.js` |
| AI drafts | `app/lib/ai.js` |
| The version | `app/lib/version.js`, `tools/stamp-build.js`, `app/package.json` (`version`, `agmessage.runBase`) |
| The pages | `app/public/` (`index` sign-in and codes, `halls` the board, `users` accounts and audit, `app` a hall, `admin`, `display`) |
| The house lint rule | `app/eslint-rules/no-unescaped-html.js` |
| The portable build | `tools/fetch-runtime.ps1`, `tools/build-portable.ps1`, `start-agmessage.bat`, `make-shareable-copy.bat` |
| Papers | `README.md`, `README.txt`, `CHANGELOG.md` (fenced by a test), `SECURITY.md`, `docs/ACCOUNTS.md`, `docs/DISPLAYS.md`, `docs/NODES.md`, `docs/SHOWBUS.md`, `docs/DESIGN.md`, `docs/ANALYSIS.md` |
| The 0.6.0 plan: what to build, in which order, and the owner's answers it rests on | `docs/plan/0.6.0/PLAN.md` (Part 0: the decisions register and the global build order, whose numbers the unit commits use), `docs/plan/0.6.0/DECISIONS.md`, `docs/plan/0.6.0/board-view/` (the Board view's mock) |

## How a change closes

One commit per unit, subject `AGMessage X.Y.Z, unit N: <what landed>`, the reasoning in the body; `npm run check` green
and the browser smoke run before each commit. The papers move with the change: `CHANGELOG.md` (newest first, the
version's heading), `README.md` / `README.txt` where the product changed, `docs/NODES.md` where the wire changed,
`docs/ANALYSIS.md` where a fence or the gate changed. A release bumps `app/package.json`'s version and is tagged
`vX.Y.Z`.

## House words

**a hall** — a room with its own code, Stagewatch link, screens and help requests; **the halls board** — every hall an
account may see; **a screen** — a browser holding a display link; **a take** — what a screen is told to show, numbered;
**the desk** — Stagewatch's approval queue, where a proposal waits for the operator; **a link** — AGMessage's
connection to a Stagewatch, Patterns or PlayMap; **a fence** — a test or lint rule that fails the build when an
invariant breaks; **the air** — what the audience and the speaker see.
