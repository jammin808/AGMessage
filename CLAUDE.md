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
  `test/resilience.test.js`, `test/modules.test.js`, `test/loads.test.js`) apply to tests too: no empty catch without
  its reason, no unused bindings, no `Math.random` (use `node:crypto`), no shell (`spawn` with an argument array), no
  `rejectUnauthorized: false` outside the pin probe, no `process.exit` in `lib/`, no value into `innerHTML` that is not
  a literal, escaped, a count or a name ending in `Html`. Synchronous file calls per file are capped by a test. A
  silenced rule says why on its line.
- **Only what it ships, only by its path.** The server loads nothing from outside `app` and asks for nothing
  `app\node_modules` cannot answer (Node would walk up to the drive's root, `C:\node_modules`): a new dependency that
  looks for an optional module is given it, or told not to, as ws's helpers are (`WS_NO_BUFFER_UTIL`,
  `WS_NO_UTF_8_VALIDATE`, set before `server.js`'s first `require`), and a package's ask `app` leaves unanswered is a row of
  `test/loads.test.js`'s `NEVER_ASKED` with why it is never made. Every call in `app` that starts a program, tests
  included, names it by `process.execPath`, a full path written out, or an expression that is a row of
  `test/loads.test.js`'s register (`RUNS`, with where its full path is made; `HANDED` for `child_process` or one of its
  functions passed on as a value), never a bare name and never a shell; `child_process` is reached by `require` or
  `import` with its name written out. `launch.js` and `machine.js` require `node:` built-ins only, by a plain
  `require`.
- **Client input** reaches a socket handler through `guardHandlers` (a throw refuses that request, never the process)
  and is read by type: `guard.str`, never `String()` on a client value. A new verb registers in a handler module
  (`lib/handlers/rooms.js`, `lib/handlers/takes.js`), never in `server.js`: a literal `socket.on('verb', …)` whose first
  statement is its one gate, `if (!conn.gate(ack, {joined, bucket, admin, may})) return;` (`lib/gate.js`: joined and its
  room still here, then its bucket, then the admin, then its rights, so a token is taken before anything a client names
  is looked up), handed the listener's own acknowledgement and naming one of the connection's buckets (`conn.writes`,
  `conn.chatter`) or saying `bucket: null` with why on its line; it reads the connection through `conn` and the server
  through `ctx` (`takesCtx` for takes: no `io`, `apply` or `systemMessage`, the room store through its readers only, a
  page reached by its socket's id through `sendTo`, named only to be called), that context destructured once, as the
  first statement of its module's `register`; it requires nothing but what (d) allows, by a literal path, never
  `rbac.can` and never a write into `settings`. The verbs already in `server.js` stay there until a unit rewrites one,
  and none is added there (`SERVER_VERBS` only shrinks).
  `test/inputs.test.js` reads the event names from `handlerFiles()` (`server.js` and each module in `lib/handlers/`) and
  sends each every shape, so a new handler is held to it; `test/modules.test.js` holds every verb to a page that sends
  it and every event to a page that hears it, and fails on a socket listener in any other shipped file or in a form the
  fuzz does not read.
- **Every store** on disk goes through a `WriteLane` that is in `saveLanes()` (flushed at stop and crash, named in
  health; health's `saves.built` counts the lanes made and `saves.named` the distinct lanes in that list, and a test
  holds them equal); one server per data folder (the folder lock), and nothing is written before the lock and the port
  are held: a store is read at load and written only once `serving` (`firstWrites` makes the folders, keys and secret; a
  save asked earlier waits; a stop or crash before then saves nothing). A secret or key file is made only where there is
  none (`readText`'s ENOENT, then `publishOnce`), never over one that could not be read; a settings file that could not be
  read (EBUSY, EACCES) is never saved over nor stood in for by its `.bak`, and an act that would save it is refused with
  why. The one exception is the internet link's Turn on (`admin:tunnelStart`), whose act is the link itself: it still
  turns the link on, its end held for that run only and its answer saying a restart would not turn it on again
  (`notKept`); Tunnel until… is refused like every other setting. A record a step of the life cycle writes once (the
  stop's `last-stop.json`, after the lanes and the halls; a crash's `last-crash.json`) is no store: it goes through the
  atomic writer, never a lane.
- **A page's write goes through the outbox** (`app/public/outbox.js`): `AGM.outbox.hold('x', …)` for what a person
  wrote or answered (never anything secret: it is kept in the tab's `sessionStorage`), `AGM.outbox.now('x', …)` for an
  act on something, never a bare `socket.emit` of a write; a read or a page's own sync may still be a plain emit. A verb
  that can be asked twice answers a repeat with what it did (the original answer, or ok and `already`), never a refusal
  for something that succeeded; a new verb in `hold` answers a repeat of its `cid`.
- **A new act on an object is a catalogue row** (`app/public/catalog.js`): its id `kind.verb`, label, icon, key, group,
  verb (a socket verb, `http:METHOD /path` or `local`), outbox mode, `may` (rights, each matched to a refusal the server
  words) and `fits`, and a state of the moment (the link down, AI drafts off, no screens, not connected) is `ready`'s:
  greyed with its reason, never hidden by `may`; the page binds only its runner (`RUN` in `app.js`, `ADMIN_RUN` on the admin page, `RUN` in
  `halls.js` and `users.js`, the last three through `AGM.acts`), and the object's bar, its ⋯, right-click, Shift+F10 and
  keys draw from the row, never a button of their own; a control that does the act anyway (Send, 🔥, ✨) runs it through
  the page's one checked path (`act()`). A kind two pages draw (`person`) fits each page's rows only on that page (the
  facts' `page`). A page's facts come from the server's answers (`facts()`,
  `adminFacts()`, `boardFacts()`, `accountFacts()`), never from what the page names for itself. A verb a row sends has a
  refusal case in `test/menus.test.js` and a place in `test/catalog.test.js`'s seat matrix. A right-click is heard only in
  `public/menus.js` (`AGM.menu.door`), a message is never copied (`cloneNode` only at the template), and no page opens a
  native `alert`, `confirm` or `prompt` (ESLint's `no-alert` on every page script; the smoke fails on one): it asks in
  place with `AGM.ask` (a field, a password, a tick, a pick list or a time of day, or several ways to say yes) and says
  the rest in its one toast, `AGM.toast` (`common.js`, a `role=status` region, with Undo where an act can be taken back).
- **A page that opens a socket** opens it with `AGM.reconnect.OPTIONS` and attaches it (`AGM.reconnect.attach`), its
  HTML loading `app/public/reconnect.js` first, so it comes back by itself; a refusal at connect carries `retryMs` and
  what it refused (`why`, with words that name the wait), or `retry: false` when no wait lifts it. It names the build
  that served it as it connects (`auth: AGM.reconnect.auth()`, its HTML loading `/build.js` first too) and hears the
  server's build in the answer it reads it from (`AGM.reconnect.build.heard`), reloading itself onto a new build only at
  its own quiet moment (`AGM.reconnect.QUIET`); a page that names no build is 0.5.1's. `test/reconnect.test.js` names the
  pages that do, and the tests' own sockets name this checkout's build (`test/helpers.js` `connect`).
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
- **A test reads the checkout's text through `readSource`** (`test/helpers.js`: LF line ends on a Windows checkout too)
  **and takes a free port from `freePort` (TCP) or `freeUdpPort` (UDP)**, never a picker of its own; `agm/test-helpers`
  (`app/eslint-rules/test-helpers.js`) refuses the rest, and CI's `test-crlf` runs the suites on a CR LF checkout.
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
Chrome smoke), `test-crlf` (the suites on Linux on a checkout with Windows' CR LF line ends), `test-windows` (tests, Edge
smoke), `package` (the stamped portable zip, also an artifact of its own unwrapped, CycloneDX SBOM, SHA256SUMS),
`readings` (the Windows evidence lane on `windows-2025`, for every push, a `v*` tag and a run asked for by hand, one
at a time per ref and never cancelled once it runs, a newer push's waiting its turn; each other job is cancelled by a
newer push of its ref through a group of its own, never the whole run's; its actions pinned by commit:
Defender turned back on first, then the readings of that zip, judged against their marks; they inform and never hold) and, on a `v*` tag that names
`app/package.json`'s version, above every release already published and every other version tagged (asked again as its
first step, one release job at a time), `release` with a build-provenance attestation, waiting for the lane and never
held by it, its notes saying each reading that missed its mark.
`.github/workflows/security.yml`: CodeQL `security-extended`, the dependency audit (npm's packages and the vendored libraries), dependency review on pull requests.

## Where things live

A sentence and the files; the detail is the code's and the CHANGELOG's. A test named `x` is `app/test/x.test.js`.

| What | Where |
|---|---|
| The server: routes, sockets, rooms, the board tick, links, screens | `app/server.js` |
| The watchdog: the server's start and restart, its beat, a sleep told from a hang, the console tee | `app/supervise.js` |
| Rooms: a hall is its Main room, its side rooms kept beside it (`data/rooms/<HALL>.<KEY>.*`); the op log, snapshots and atomic saves; the stop's order and its record; which rooms may send into a room (`settings.roomSends`, set by the admin with May send in…), and a message or a file sent into one of them with a copy kept here (`room:send`, `room:sendTargets`), and withdrawn from there (`room:withdraw`) | `app/lib/store.js`, `app/lib/resilience.js`, `app/lib/laststop.js`, `app/lib/handlers/rooms.js`, `app/public/sendfrom.js`; tests `units`, `laststop`, `halls`, `sends` |
| Each room's guest code: on, off and renewed by the store; who is told it | `app/lib/store.js`, `app/lib/handlers/rooms.js`, `app/lib/rbac.js` (`mayKnowCode`), `app/public/join.js`; test `codes` |
| State frames, latest wins: the one primitive for the halls board, screens, people lists, seen receipts and a hall's rooms | `app/lib/latest.js` |
| The op table: the event each change is sent under, and the hall page's table that draws a change missed or heard live | `app/lib/ops.js`, `app/public/app.js` (`UPD_EVENTS`) |
| The action catalogue: every act a page offers on an object, as data, and what draws it (menus, asks in place, doors, roving lists); each page's runner | `app/public/catalog.js`, `app/public/menus.js`, `app/public/members.js` (Members…); runners in `app.js`, `admin.js`, `admin-plus.js`, `halls.js`, `users.js`; tests `catalog`, `menus`, `members` |
| The outbox: every write a page makes, held or sent now, and the server's answer to a repeat | `app/public/outbox.js`, `app/lib/store.js`; test `outbox` |
| Pages back by themselves: one reconnection pace, refusals' waits, a page on another build reloading at its quiet moment | `app/public/reconnect.js`, `/build.js` in `app/server.js`; test `reconnect` |
| Identities, rate limits, lockouts, text cleaning, the per-network key and the tunnel's places | `app/lib/guard.js` |
| Remote phones through the tunnel: the connection's gate, the link's check, the tunnel's end kept across a restart | `app/lib/tunnelend.js`, `app/lib/peaks.js`, `app/server.js`; test `tunnel` |
| Rights and roles (pure), checked per room behind a fence; a code guest's rights; the escalation fence | `app/lib/rbac.js`; tests `accounts`, `halls` |
| What a seat may do on its page, on the server (the seat read before any right; a Board account held to On stage where its halls seat it) | `app/server.js` (`allowed()`); test `onstage` |
| Accounts (with their side rooms, On stage halls and chat view), password hashing, sessions, their routes; the Accounts page (its tree of halls and rooms) | `app/lib/accounts.js`, `app/lib/http-accounts.js`, `app/public/users.js`; test `accounts` |
| The audit log, chained with a key; its check and Accept; its work counted in tests, never timed | `app/lib/audit.js`, `app/test/audit-preload.js` |
| The audit log's rules that need no key, shared with a checker on another computer | `app/verify/auditrules.js` |
| The audit log's signed export and the zip it streams | `app/lib/auditexport.js`, `app/lib/zip.js`, `app/public/audit-export.js` |
| The audit log carried across events: a split at an archive point into a signed archive | `app/lib/auditarchive.js` |
| The verifier on another computer: Node and the browser page | `app/verify/` |
| The halls board and help requests; a hall's rooms on its row, Your rooms, and Set up's Rooms | `app/lib/board.js`, `app/public/halls.js`; test `halls` |
| The room choice and the switcher: an account with one room goes straight into it; a hall page names its room ("Hall 2 › Legal") and moves between its hall's rooms | `app/public/halls.js` (`waysIn`), `app/public/app.js` (the switcher), `app/server.js` (`switcherFor`, `frames.rooms`); test `halls` |
| Uploads: a token per page's join, checked again at use; a file message posted only in the room it was made for, reaching another only by a forward | `app/server.js` (`/api/upload`, `fileRefusal`), `app/lib/guard.js`; test `uploads` |
| Screens (display URLs) | `app/lib/displays.js`, `app/public/display.*` |
| Stagewatch links, peers, hello; what a send says (Stagewatch's grammar as the oracle) | `app/lib/nodes.js`, `app/lib/stagelines.js` |
| Patterns and PlayMap links; the context other show systems read | `app/lib/peerlinks.js`, `app/lib/context.js` |
| HTTPS and certificate pins; the machine key, sealed secrets and the keys derived from it | `app/lib/tls.js`, `app/lib/secretbox.js` |
| Health's readings and a show day's peaks | `app/lib/peaks.js` |
| What a start opens, says and may write: nothing before the folder and the port are held; a secret made only where there is none | `app/lib/startup.js`, `app/lib/resilience.js`; test `startrules` |
| Where the admin token is said, only where a person sits; Show the admin token | `app/supervise.js`, `app/launch.js`; test `admintoken` |
| What the console says, kept (`server.log`), and "This laptop" | `app/lib/serverlog.js`, `app/lib/laptop.js`; test `laptop` |
| A sleep told from a hang; a live show kept awake (the power request) | `app/lib/power.js`, `app/lib/resilience.js` (`BeatClock`); test `sleep` |
| How busy it is, and a stop that saves, asked at loopback with a proof of the token | `app/lib/busy.js`, `app/lib/machinewire.js`; test `busy` |
| AI drafts and their brief | `app/lib/ai.js` |
| The version, "newer" and the release order | `app/lib/version.js`, `tools/stamp-build.js`; test `version` |
| The data folder's format marker, and its upgrade copy | `app/lib/dataformat.js`; test `dataformat` |
| The pages | `app/public/` (`index` sign-in and codes, `halls` the board, `users` accounts and audit, `app` a hall, `admin`, `display`) |
| The browser libraries the pages load, byte for byte as published, their list, licences and notices; the SBOM's vendored part | `app/public/vendor/`, `VENDOR.json`, `THIRD-PARTY-NOTICES.md`, `licenses/`, `tools/vendor-sbom.js`, `tools/vendor-audit.js`; test `vendor` |
| The page floor (Safari 14.1, Chrome 84): its probe, the helpers for what a browser may lack, every page's one toast | `app/public/theme-init.js`, `app/public/common.js`, `docs/DEVICES.md`; test `pagefloor` |
| What AGMessage loads and runs: only what it ships, only by its absolute path | `app/test/loads.test.js`, `app/test/resolve-preload.js` |
| The house lint rules: an unescaped value into a page's HTML; a test's own text read of the checkout or port picker | `app/eslint-rules/`; test `lint-rules` |
| The module fence: the server's layers, the handler modules held narrow, no new verb in `server.js` | `app/test/modules.test.js` |
| The one gate, and the contexts a handler module is given | `app/lib/gate.js`, `app/lib/handlers/` |
| The portable build: `AGMessage-Portable-<version>.zip` holding one folder, `AGMessage`; every path it makes held under MAX_PATH | `tools/fetch-runtime.ps1`, `tools/build-portable.ps1`, `tools/zip-paths.js`, `start-agmessage.bat`, `make-shareable-copy.bat`; test `zippaths` |
| The Windows evidence lane: the readings and the lab lines, judged against their marks | `tools/readings.js`, `tools/readings-take.js`, `tools/defender-on.ps1`, `docs/INSTALL.md`; test `readings` |
| Test helpers: a server on a throwaway folder, `readSource`, `freePort` / `freeUdpPort`, the files the fences read | `app/test/helpers.js` |
| Papers | `README.md`, `README.txt`, `CHANGELOG.md`, `SECURITY.md`, `docs/` (`ACCOUNTS`, `DISPLAYS`, `NODES`, `SHOWBUS`, `DESIGN`, `ANALYSIS`, `DEVICES`, `INSTALL`) |
| The 0.6.0 plan: what to build, in which order, and the owner's answers it rests on | `docs/plan/0.6.0/PLAN.md`, `docs/plan/0.6.0/DECISIONS.md`, `docs/plan/0.6.0/board-view/` |

## How a change closes

One commit per unit, subject `AGMessage X.Y.Z, unit N: <what landed>`, the reasoning in the body; `npm run check` green
and the browser smoke run before each commit. The papers move with the change: `CHANGELOG.md` (newest first, the
version's heading), `README.md` / `README.txt` where the product changed, `docs/NODES.md` where the wire changed,
`docs/ANALYSIS.md` where a fence or the gate changed, this file's table where a thing's home changed (a sentence and
the files, never the detail: every agent reads this file whole). A release bumps `app/package.json`'s version and is
tagged `vX.Y.Z`.

## House words

**a hall** — a venue space with its Main room, its own code, Stagewatch link, screens and help requests; **the halls
board** — every hall an account may see; **a screen** — a browser holding a screen's link; **a take** — what a screen is
told to show, numbered; **the desk** — Stagewatch's approval queue, where a proposal waits for the operator; **a link**
— AGMessage's connection to a Stagewatch, Patterns or PlayMap; **a fence** — a test or lint rule that fails the build
when an invariant breaks; **a seat limit** — what a seat allows at all, whatever the rights behind it, read before any
right and the admin's too (On stage: reading and writing messages, nothing else); **the air** — what the audience and
the speaker see; **the outbox** — what holds a page's send until the server answers it, so it is never lost and never
made twice; **a catalogue entry** — an act, drawn as a button and a menu item from one row, absent where a seat may never
do it and disabled with its reason where it cannot now; **a fold** — catalogue entries of one kind drawn as one item when
both are shown (Speaker's screen ▸: Ask the operator… · Send now), flat when one is.

**One word per thing** (the smoke's word check holds the pages to it): a hall (never "meeting", "session" or "room");
a room — Main, Legal, Media, named "Hall 2 › Legal" (never "hall"): the Main room is the hall itself, its key the hall's, and a side room one of its other rooms, kept beside it and reached by its key; a code — what guests type, each room its own, a hall's its key until New code ("guest code" in the
admin's words); a seat — On stage · Backstage · Observer · Member ("role" only in code); the Board — everyone seated On
stage in Main (never "directors"); the backstage team (never "research team" or "Support Team" on a page); Chat view —
By seat · Simple · Full; screens — `/d/` links (never "displays" on a page); the speaker's screen — Stagewatch's
confidence monitor; Show people (📺 Show the Board, Show Ana, under Send to stage; undone by Take down or Back to chat),
Show on a thing, Send into a room. Stagewatch's "meetings" stay, as Stagewatch reads them.
