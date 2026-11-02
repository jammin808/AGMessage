# AGMessage — the agent brief

Read this before any change. The papers people read are `README.md`, `README.txt` (the portable guide) and `docs/`;
this file is for whoever works the tree.

## What this is

AGMessage is the messenger of the show network (Stagewatch, Patterns, PlayMap): messages, files, help requests and
screens for every hall of a live event, on any browser on the venue network. One Node.js server (`app/server.js`, run by
the watchdog `app/supervise.js`) shipped as a portable Windows folder with its own Node runtime and cloudflared; no
install, no database. Crew, project managers and admins sign in with accounts; presenters and guests join with a hall's
6-character code. Each hall is a venue space with its Main room, its own Stagewatch link, its screens (`/d/<token>`
capability URLs) and its help requests; the halls board shows every hall an account may see. It speaks Show Bus 1.2 (`docs/SHOWBUS.md`,
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
  `test/resilience.test.js`, `test/modules.test.js`) apply to tests too: no empty catch without its reason, no unused
  bindings, no `Math.random` (use `node:crypto`), no shell (`spawn` with an argument array), no
  `rejectUnauthorized: false` outside the pin probe, no `process.exit` in `lib/`, no value into `innerHTML` that is not
  a literal, escaped, a count or a name ending in `Html`. Synchronous file calls per file are capped by a test. A
  silenced rule says why on its line.
- **Client input** reaches a socket handler through `guardHandlers` (a throw refuses that request, never the process)
  and is read by type: `guard.str`, never `String()` on a client value. `test/inputs.test.js` reads the event names
  from `handlerFiles()` (`server.js` and each module in `lib/handlers/`) and sends each every shape, so a new handler is
  held to it; `test/modules.test.js` holds every verb to a page that sends it and every event to a page that hears it,
  and fails on a socket listener in any other shipped file or in a form the fuzz does not read.
- **Every store** on disk goes through a `WriteLane` that is in `saveLanes()` (flushed at stop and crash, named in
  health; health's `saves.built` counts the lanes made and `saves.named` the distinct lanes in that list, and a test
  holds them equal); one server per data folder (the folder lock), and nothing is written before the lock and the port
  are held.
- **A page's write goes through the outbox** (`app/public/outbox.js`): `AGM.outbox.hold('x', …)` for what a person
  wrote or answered (never anything secret: it is kept in the tab's `sessionStorage`), `AGM.outbox.now('x', …)` for an
  act on something, never a bare `socket.emit` of a write; a read or a page's own sync may still be a plain emit. A verb
  that can be asked twice answers a repeat with what it did (the original answer, or ok and `already`), never a refusal
  for something that succeeded; a new verb in `hold` answers a repeat of its `cid`.
- **A page that opens a socket** opens it with `AGM.reconnect.OPTIONS` and attaches it (`AGM.reconnect.attach`), its
  HTML loading `app/public/reconnect.js` first, so it comes back by itself; a refusal at connect carries `retryMs` and
  what it refused (`why`, with words that name the wait), or `retry: false` when no wait lifts it.
  `test/reconnect.test.js` names the pages that do.
- **A per-address bound keys on `guard.limitKey`** (a network: a tunnel IPv6 address by its /64, every other address
  whole), in a `guard.Buckets` or a `guard.Lockout`, both bounded and never cleared whole; the full address stays in
  `socket.data.ip` and the audit rows. The one exception is the sign-in's own bounds per address (`lib/http-accounts.js`),
  which keep the full address: through the tunnel its lockout per name holds for the whole tunnel. The tunnel's places (`guard.Places`) bound
  what is open through it; a refusal is counted in health (`tunnel.refused`, `refused.venue`) and the day's peaks,
  never audited.
- **A new frame of state is a `Latest`** (`app/lib/latest.js`): never a timer or a polled flag of its own, and never a
  volatile emit. `test/resilience.test.js` counts the timers each handler file starts, each with its reason, so a tick
  of its own moves that list with its words.
- **The stylesheet draws with its tokens** (`app/public/styles.css`: sizes, spaces, targets, layers and colour roles
  named once in `:root`, every colour once more under `html[data-theme="dark"]`): a new colour is a token, and a rule a
  unit touches reads tokens instead of carrying colours and a dark rule of its own (a dark rule left beside a state's rule
  outranks it in dark: `html[data-theme="dark"] .x` beats `.x.on`, so a state's colours are tokens too).
  `test/resilience.test.js` counts the hex colours outside the two token blocks, a count that only goes down (a unit that
  takes some out lowers it), and refuses an opacity between 0 and 1 however it is written: muted words and icons take
  `--c-ink-muted`, never a fade.
- **A page holds the page floor** (Safari 14.1, iOS and iPadOS 14.5, Chrome 84; `docs/DEVICES.md`): a feature newer
  than it is reached through its helper (`AGM.openDialog`, `AGM.awake`, `AGM.idle` in `app/public/common.js`) or its
  fallback, never bare, and no page reads the user agent; a stylesheet rule above the floor follows the one it falls back
  to. `theme-init.js` stays ES5 and first on every page with people, and a page script stops below the floor before it
  asks the server anything or opens a socket. ESLint, `test/resilience.test.js` and `test/pagefloor.test.js` hold it.
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
                     # (test, coverage and smoke run through test/run-tests.js: a temporary folder of their own,
                     # removed when the run ends, so no run leaves its data folders behind)
node --test test/displays.test.js                     # one file
AGM_BROWSER=<chrome or edge> npm run smoke            # the browser smoke (every page, sign-in, a hall, a screen)
npm run audit        # shipped packages' advisories and registry signatures; the vendored libraries' (tools/vendor-audit.js)
node ../tools/stamp-build.js --print                  # the version this checkout would carry
```

CI (`.github/workflows/ci.yml`): `analyze` (lint, secret scan, version), `test-linux` (Node 24 and 26, coverage,
Chrome smoke), `test-windows` (tests, Edge smoke), `package` (the stamped portable zip, CycloneDX SBOM, SHA256SUMS) and,
on a `v*` tag that names `app/package.json`'s version, `release` with a build-provenance attestation.
`.github/workflows/security.yml`: CodeQL `security-extended`, the dependency audit (npm's packages and the vendored libraries), dependency review on pull requests.

## Where things live

| What | Where |
|---|---|
| The server: routes, sockets, rooms, the board tick, links, screens | `app/server.js` |
| The watchdog | `app/supervise.js` |
| Rooms, the op log and snapshots, atomic saves | `app/lib/store.js`, `app/lib/resilience.js` |
| State frames, latest wins: the one primitive the halls board, a hall's screens, its people list and its seen receipts go through, each sent at once after a quiet window and at most once per window in a burst, each hall's frame sent apart so one that faults holds back no other | `app/lib/latest.js`, `app/server.js` (`frames`) |
| The op table: the event each change is sent under (`apply()`), and the hall page's table that draws a change it missed and one it hears live alike (a new field of a change to a message is a row of both) | `app/lib/ops.js`, `app/public/app.js` (`UPD_EVENTS`) |
| The outbox: every write a page makes, in the mode of what the person does (`hold` what a person wrote or answered, held with its client id until the server answers it, kept in the tab across a reload; `now` an act on something, never sent late; `self`; `local`), and the server's half: a send's client id answered with what it became (`byCid`), the newest 500 removals remembered (`gone`) | `app/public/outbox.js` (its tests: `app/test/outbox.test.js`), `app/lib/store.js` (`sentAs`, `removed`), `app/server.js` (`readSend`) |
| Pages back by themselves: every page's socket at one reconnection pace, a refusal tried again at the wait the server names (`retryMs`) and said, a page shown again or back online started afresh, the strip and the dot's words while it is down; the server's half: the refusal's wait (`Bucket.waitMs`), and a page back in the restart's first seconds not announced | `app/public/reconnect.js` (`AGM.reconnect`; its tests and fence: `app/test/reconnect.test.js`), `app/server.js` (the connection's refusal, `join`) |
| Identities, rate limits, lockouts, text cleaning; the key a per-address bound counts by (`limitKey`) and the tunnel's places (`Places`) | `app/lib/guard.js` |
| Remote phones through the tunnel: the connection's gate (per network, the places, the join's wait, the refusals' words), the link's check from the laptop, health's `tunnel`; their tests, with cloudflared and its address stood in for | `app/server.js` (the connection's gate, `checkTunnel`), `app/lib/peaks.js` (`Refusals`, `linkCheck`), `app/test/tunnel.test.js`, `app/test/tunnel-preload.js` |
| Rights and roles (pure), and each seat's limit: On stage holds messages only (`SEAT_LIMITS`, `seatAllows`); the admin's link, a set of its own (`LINKED_CAPS`); who answers a hall's help requests as its crew (`answersHelp`: may post there and does not sit On stage there), read by `help:respond` and the halls board's `canRespond` alike | `app/lib/rbac.js` |
| What a seat may do on its page, on the server: the socket's seat (`socket.data.seat`, `onStage()`), read first by `allowed()`, by the checks that do not call it (screens, a hall's set-up, the show network, drafts, forward and its picker, `myRooms`, whose `why` names a source rule) and by `help:respond`'s On stage rule, read before `allowed()` and any right, which takes only the seat's own request's Resolved, and by an upload token at use, which `admin:setRole`'s move to a seat that shares no file ends; a code guest's rights by seat (`GUEST_CAPS`); their tests | `app/server.js` (`onStage()`, `allowed()`, `GUEST_CAPS`, `rightsIn`, `myRooms`, `help:respond`), `app/test/onstage.test.js` |
| Accounts, password hashing, sessions; their routes | `app/lib/accounts.js`, `app/lib/http-accounts.js` |
| The audit log (chained with a key; its records beside the machine key, outside the data folder; the check and Accept) | `app/lib/audit.js` |
| The audit log's rules that need no key (whole lines, links, runs and boundaries, archive points and splits, an export's and an archive's paths, `SHA256SUMS`, manifest and `archive.json`) and the folder check itself, shared with a checker on another computer | `app/verify/auditrules.js` |
| The audit log's signed export, the zip it streams, and its dialog on the pages | `app/lib/auditexport.js`, `app/lib/zip.js`, `app/public/audit-export.js` |
| The audit log carried across events: the admin's split at an archive point into a signed archive (`data/audit-archive/`), a split finished at the next start, an archive's own check | `app/lib/auditarchive.js` (the archive point and the walk from it are `app/lib/audit.js`'s) |
| The verifier on another computer: Node (`verify-audit.js`, which also assembles the page) and the browser page (`page.html`, `page.js`, `page.css`) | `app/verify/` |
| The halls board and help requests | `app/lib/board.js` |
| Screens (display URLs) | `app/lib/displays.js`, `app/public/display.*` |
| Stagewatch links, peers, hello | `app/lib/nodes.js` |
| What a send to Stagewatch says (and Stagewatch's grammar, ported as the oracle) | `app/lib/stagelines.js` |
| Patterns and PlayMap links | `app/lib/peerlinks.js` |
| The context other show systems read | `app/lib/context.js` |
| HTTPS and certificate pins | `app/lib/tls.js` |
| The machine key (never replaced), sealed secrets, the keys derived from it | `app/lib/secretbox.js` |
| Health's readings and a show day's peaks | `app/lib/peaks.js` |
| What a start opens and says: the browser opener, the port's holder | `app/lib/startup.js` |
| AI drafts | `app/lib/ai.js` |
| The version | `app/lib/version.js`, `tools/stamp-build.js`, `app/package.json` (`version`, `agmessage.runBase`) |
| The pages | `app/public/` (`index` sign-in and codes, `halls` the board, `users` accounts and audit, `app` a hall, `admin`, `display`) |
| The browser libraries the pages load (pdf.js 4.10.38's legacy build, mammoth, SheetJS), byte for byte as published, and their list: each file's package, version, build, licence, copyright, source and SHA-256, its floor, what it bundles and the advisories assessed against each | `app/public/vendor/`, `app/public/vendor/VENDOR.json` (held to the folder by `app/test/vendor.test.js`) |
| Their licences and notices, shipped at the portable folder's top, with the advisories against their versions and each one's assessment; the SBOM's vendored components, read from the bundle that ships; the vendored libraries' advisory audit | `THIRD-PARTY-NOTICES.md`, `licenses/<package>/`, `tools/vendor-sbom.js`, `tools/vendor-audit.js` |
| The page floor: its probe and its words below it, the helpers for what a browser above it may lack (a dialog without `showModal()`, the wake lock's words by cause, idle work), the stylesheet's fallbacks, the device matrix and the walk | `app/public/theme-init.js`, `app/public/common.js` (`AGM.openDialog`, `AGM.awake`, `AGM.idle`), `app/test/pagefloor.test.js`, `docs/DEVICES.md` |
| The house lint rule | `app/eslint-rules/no-unescaped-html.js` |
| The module fence: the server's layers (the pure core, no cycle, one composition root), the wire's words closed both ways and the op table's two halves in step; the one list of the files that register socket verbs, and of the page scripts, that the fences read | `app/test/modules.test.js`, `app/test/helpers.js` (`handlerFiles()`, `pageScripts()`) |
| The portable build | `tools/fetch-runtime.ps1`, `tools/build-portable.ps1`, `start-agmessage.bat`, `make-shareable-copy.bat` |
| Papers | `README.md`, `README.txt`, `CHANGELOG.md` (fenced by a test), `SECURITY.md`, `docs/ACCOUNTS.md`, `docs/DISPLAYS.md`, `docs/NODES.md`, `docs/SHOWBUS.md`, `docs/DESIGN.md`, `docs/ANALYSIS.md`, `docs/DEVICES.md`, `docs/INSTALL.md` (the installed node, as far as it is built) |
| The 0.6.0 plan: what to build, in which order, and the owner's answers it rests on | `docs/plan/0.6.0/PLAN.md` (Part 0: the decisions register and the global build order, whose numbers the unit commits use), `docs/plan/0.6.0/DECISIONS.md`, `docs/plan/0.6.0/board-view/` (the Board view's mock) |

## How a change closes

One commit per unit, subject `AGMessage X.Y.Z, unit N: <what landed>`, the reasoning in the body; `npm run check` green
and the browser smoke run before each commit. The papers move with the change: `CHANGELOG.md` (newest first, the
version's heading), `README.md` / `README.txt` where the product changed, `docs/NODES.md` where the wire changed,
`docs/ANALYSIS.md` where a fence or the gate changed. A release bumps `app/package.json`'s version and is tagged
`vX.Y.Z`.

## House words

**a hall** — a venue space with its Main room, its own code, Stagewatch link, screens and help requests; **the halls
board** — every hall an account may see; **a screen** — a browser holding a screen's link; **a take** — what a screen is
told to show, numbered; **the desk** — Stagewatch's approval queue, where a proposal waits for the operator; **a link**
— AGMessage's connection to a Stagewatch, Patterns or PlayMap; **a fence** — a test or lint rule that fails the build
when an invariant breaks; **a seat limit** — what a seat allows at all, whatever the rights behind it, read before any
right and the admin's too (On stage: reading and writing messages, nothing else); **the air** — what the audience and
the speaker see; **the outbox** — what holds a page's send until the server answers it, so it is never lost and never
made twice.

**One word per thing** (the smoke's word check holds the pages to it): a hall (never "meeting", "session" or "room");
a room — Main, Legal, Media, named "Hall 2 › Legal" (never "hall"); a code — what guests type ("guest code" in the
admin's words); a seat — On stage · Backstage · Observer · Member ("role" only in code); the Board — everyone seated On
stage in Main (never "directors"); the backstage team (never "research team" or "Support Team" on a page); Chat view —
By seat · Simple · Full; screens — `/d/` links (never "displays" on a page); the speaker's screen — Stagewatch's
confidence monitor; Show people (📺 Show the Board, Show Ana, under Send to stage; undone by Take down or Back to chat),
Show on a thing, Send into a room. Stagewatch's "meetings" stay, as Stagewatch reads them.
