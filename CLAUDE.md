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
  it and every event to a page that hears it (one no page uses yet only by an allow-list row with its reason, which fails
  once a page uses it), and fails on a socket listener in any other shipped file or in a form the
  fuzz does not read.
- **A store that holds a way in** (accounts, sign-ins) is keyed through `lib/keyedstore.js`, and only ENOENT means it is
  absent: a file that fails its check is never trusted record by record, and one that cannot be read is never written over.
- **Every store** on disk goes through a `WriteLane` that is in `saveLanes()` (flushed at stop and crash, named in
  health; health's `saves.built` counts the lanes made and not closed (a removed hall's stage record closes its lane) and
  `saves.named` the distinct lanes in that list, and a test holds them equal); one server per data folder (the folder
  lock), and nothing is written before the lock and the port are held: a store is read at load and written only once
  `serving` (`firstWrites` makes the folders, keys and secret; a save asked earlier waits; a stop or crash before then
  saves nothing). A secret or key file is made only where there is
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
  asks the server anything or opens a socket. Every page script and module parses as ES2020 (no class field, static
  block, `||=`, numeric separator or top-level await). ESLint, `test/resilience.test.js` and `test/pagefloor.test.js`
  hold it.
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
`installer` (the installer built from that zip on `windows-2025`, Inno Setup pinned and checked, never run there),
`lifecycle` (the installer's life cycle run for real on `windows-2025`, elevated, Defender back on first: the release order
asked, the build before this one and one that does not start made from the same payload, `installer/test/*.test.js` run
and every test they declare counted; a gate, which the release waits for),
`readings` (the Windows evidence lane on `windows-2025`, for every push, a `v*` tag and a run asked for by hand, one
at a time per ref and never cancelled once it runs, a newer push's waiting its turn; each other job is cancelled by a
newer push of its ref through a group of its own, never the whole run's; its actions pinned by commit:
Defender turned back on first, then the readings of that zip, judged against their marks; they inform and never hold) and, on a `v*` tag that names
`app/package.json`'s version, above every release already published and every other version tagged (asked again as its
first step, one release job at a time), `release` with the zip, the installer and a build-provenance attestation of the zips, the
installer and `SHA256SUMS.payload`, each verified before it publishes and the release read back for `immutable` once it
has (immutable releases are the repository's setting, on since 2026-11-07), once the life cycle passed, waiting for
the lane and never held by it, its notes saying each reading that missed its mark and each of the show laptop's readings
that triggered its change (`docs/DESIGN.md`).
`.github/workflows/security.yml`: CodeQL `security-extended`, the dependency audit (npm's packages and the vendored libraries), dependency review on pull requests.

## Where things live

A sentence and the files; the detail is the code's and the CHANGELOG's. A test named `x` is `app/test/x.test.js`.

| What | Where |
|---|---|
| The server: routes, sockets, rooms, the board tick, links, screens | `app/server.js` |
| The watchdog: the server's start and restart, its beat, a sleep told from a hang, the console tee | `app/supervise.js` |
| Rooms: a hall is its Main room, its side rooms kept beside it (`data/rooms/<HALL>.<KEY>.*`); the op log, snapshots and atomic saves; the stop's order and its record; which rooms may send into a room (`settings.roomSends`, set by the admin with May send in…), and a message or a file sent into one of them with a copy kept here (`room:send`, `room:sendTargets`), and withdrawn from there (`room:withdraw`) | `app/lib/store.js`, `app/lib/resilience.js`, `app/lib/laststop.js`, `app/lib/handlers/rooms.js`, `app/public/sendfrom.js`; tests `units`, `laststop`, `halls`, `sends` |
| Each room's guest code: on, off and renewed by the store; who is told it; its invite links, numbered, which an On stage seat needs in every hall (New On stage link), the hall page dropping them from its address | `app/lib/store.js`, `app/lib/handlers/rooms.js`, `app/lib/rbac.js` (`mayKnowCode`), `app/lib/guard.js`, `app/server.js`, `app/public/join.js`, `app/public/app.js`, `app/public/admin-plus.js`; tests `codes`, `server` |
| State frames, latest wins: the one primitive for the halls board, screens, people lists, seen receipts, a hall's rooms and a room's news | `app/lib/latest.js` |
| Pins: for the room (the message's own, made from backstage, never On stage) or for oneself (every seat's, kept by person and room, told to their own pages alone); every pinned place holds both, the room's first, a first open carrying them however old: the pinned strip, the panel's pinned files and the simple view's pinned bar, where a pinned question is answered | `app/lib/pages.js`, `app/lib/store.js`, `app/lib/handlers/takes.js` (`pin:mine`), `app/server.js` (`pin`), `app/public/app.js` (`PinBar`), `app/public/catalog.js`; test `pins` |
| The op table: the event each change is sent under, which of them are a room's news for the switcher's dot, and the hall page's table that draws a change missed or heard live | `app/lib/ops.js`, `app/public/app.js` (`UPD_EVENTS`) |
| A room's first open, bounded: its newest messages and what a page keeps in view from before them, drawn the newest first and the rest as the page is idle; earlier ones read back on request (Show earlier, a reply's Show it), and one pinned since read by its id | `app/lib/store.js`, `app/lib/handlers/rooms.js`, `app/public/app.js` (`Earlier`), `app/public/catalog.js` (kind `earlier`); tests `units`, `server` |
| The action catalogue: every act a page offers on an object, as data, and what draws it (menus, asks in place, doors, roving lists); each page's runner | `app/public/catalog.js`, `app/public/menus.js`, `app/public/members.js` (Members…); runners in `app.js`, `admin.js`, `admin-plus.js`, `halls.js`, `users.js`; tests `catalog`, `menus`, `members` |
| The outbox: every write a page makes, held or sent now, and the server's answer to a repeat | `app/public/outbox.js`, `app/lib/store.js`; test `outbox` |
| Pages back by themselves: one reconnection pace, refusals' waits, a page on another build reloading at its quiet moment | `app/public/reconnect.js`, `/build.js` in `app/server.js`; test `reconnect` |
| Identities, rate limits, lockouts, text cleaning, the per-network key and the tunnel's places; the pages' policies, pdf.js's worker's its own | `app/lib/guard.js` |
| Remote phones through the tunnel: the connection's gate, the link's check, the tunnel's end kept across a restart | `app/lib/tunnelend.js`, `app/lib/peaks.js`, `app/server.js`; test `tunnel` |
| Rights and roles (pure), checked per room behind a fence; a code guest's rights; the escalation fence | `app/lib/rbac.js`; tests `accounts`, `halls` |
| What a seat may do on its page, on the server (the seat read before any right; a Board account held to On stage where its halls seat it) | `app/server.js` (`allowed()`); test `onstage` |
| Accounts (with their side rooms, On stage halls and chat view), password hashing, sessions, their routes; the Accounts page (its tree of halls and rooms) | `app/lib/accounts.js`, `app/lib/http-accounts.js`, `app/public/users.js`; test `accounts` |
| The keyed stores: the accounts and both kinds of sign-in kept in files keyed to the machine key, each save recorded outside the data folder, what a start decides of a folder, the accounts held aside and adopted with the token at the laptop (Admin → Accounts held aside), and an event archive's claim and pins | `app/lib/keyedstore.js`, `app/lib/accounts.js`, `app/lib/http-accounts.js`, `app/public/admin-plus.js`, `app/public/join.js`, `app/public/catalog.js` (kinds `accounts`, `heldAccount`); tests `keyedstore`, `keyedsignins` |
| The audit log, chained with a key; its check and Accept; its work counted in tests, never timed | `app/lib/audit.js`, `app/test/audit-preload.js` |
| The audit log's rules that need no key, shared with a checker on another computer | `app/verify/auditrules.js` |
| The audit log's signed export and the zip it streams | `app/lib/auditexport.js`, `app/lib/zip.js`, `app/public/audit-export.js` |
| The audit log carried across events: a split at an archive point into a signed archive | `app/lib/auditarchive.js` |
| Events: the current one archived, never deleted silently, into the data folder's archive, by the server in one turn behind the busy check (a stop part way finished at the next start), the next one a copy of an event's settings and structure, an archived event continued, or a fresh one; what the node holds kept, every sign-in ended; an archive's contents deleted only with the token typed at the laptop; Admin → Event | `app/lib/events.js`, `app/server.js`, `app/public/admin-plus.js`, `app/public/catalog.js` (kinds `event`, `archive`), `app/test/eventmove-preload.js`; test `events` |
| The verifier on another computer: Node and the browser page | `app/verify/` |
| The halls board and help requests; a hall's rooms on its row, Your rooms, and Set up's Rooms | `app/lib/board.js`, `app/public/halls.js`; test `halls` |
| The room choice and the switcher: an account with one room goes straight into it; a hall page names its room ("Hall 2 › Legal") and moves between its hall's rooms, a dot on each with a message the person has not read | `app/public/halls.js` (`waysIn`), `app/public/app.js` (the switcher), `app/server.js` (`switcherFor`, `frames.rooms`), `app/lib/store.js`; test `halls` |
| Uploads: a token per page's join, checked again at use; a file message posted only in the room it was made for, reaching another only by a forward | `app/server.js` (`/api/upload`, `fileRefusal`), `app/lib/guard.js`; test `uploads` |
| A file shared is a download for the seats that may take it, by the server's single-use ticket, and never opens by itself; an observer's or a Viewer account's page is sent no file's link; the files only ever transferred, a password-protected Office file known by its compound file's directory | `app/lib/downloads.js`, `app/lib/cfbcheck.js`, `app/lib/pages.js`, `app/lib/handlers/rooms.js`, `app/server.js`, `app/public/app.js`; test `downloads` |
| The confidential mark: one record a file, given to every page with its messages and its change told to each room holding it; where a marked file is in use, and where it goes only confirmed; never on a screen or to the AI; named only where it is in use; its line only to a hall's own Stagewatch over https, and the hold that keeps it from every other reader of that Stagewatch's frame | `app/lib/pages.js`, `app/lib/handlers/rooms.js` (`file:mark`), `app/lib/handlers/takes.js`, `app/server.js`, `app/public/app.js`, `app/public/catalog.js`, `app/public/pagelayer.mjs`; test `confidential` |
| An upload checked before anyone opens it, and again at a file's first take on the stage: which check a type has; an Office file's archive read by one core written for the server and the page's document worker alike, the directory the pages' readers open; a picture's size from its header, by one reader the server, the page and its worker share; a refusal audited; the file types the stage can show | `app/lib/uploadcheck.js`, `app/public/zipcore.js`, `app/lib/zipcheck.js`, `app/public/imagecore.js`, `app/lib/imagesize.js`, `app/lib/pages.js`; tests `zipcheck`, `imagesize` |
| A document drawn in a page: bounded readers into one block model (text, CSV, Markdown, a deck's outline, HTML parsed in one place and never put in the page), the drawing with its page box, zoom, find and kept place, one pdf.js worker and a deadline, Office files read in the document worker under a deadline, Word's pages and hidden text, what each seat draws of hidden parts; what the backstage team picks in it (a PDF's text layer and structure tree, a grid's cells and labels, a region) and the Preview's bars that show it; words pasted or typed into ❝ Quote, a paste read for its structure through the same one parse | `app/public/docview.mjs`, `app/public/docmodel.mjs`, `app/public/docworker.js`, `app/public/wordpages.js`, `app/public/zipcore.js`, `app/public/app.js` (`PickBar`, `PreviewBar`, `QuoteTab`), `app/test/fixtures/`; tests `docmodel`, `wordpages`, `zipcore`, `catalog`, the browser smoke |
| Screens (display URLs) | `app/lib/displays.js`, `app/public/display.*` |
| People's pages: what a person's hall page is shown over its chat in two layers, the show and information drawn over it (a web page, a document, a picture, a quote), and a researcher's information kept beside the operator's (numbered takes to the Board or one person, their answers, the status read from each page's report, the hall's Earlier list; a web page's address sealed at rest; where a file shown may come from; the stage's files, kept while a take names them; what ends a take) and guests' chat views, kept in `pages.json` through the `pages` lane; the take verbs (a push, a page's report, a console's read, a withdrawal), each take sent to a page by its socket's id, who may push, who may show information by a right of its own (`canShow`, `stage.show`) and who may show a web page (`stage.web`; a locked hall's guests by the admin's switch, `admin:guestWeb`) | `app/lib/pages.js`, `app/lib/handlers/takes.js`, `app/lib/handlers/rooms.js`, `app/server.js`; tests `pages`, `takes` |
| What was shown on people's pages, hall by hall (the stage record): an entry per take and take-down with a quote's words, the line sent with it and what its pages reported, one lane a hall, cleared by a reset and gone with its hall; the transcript that interleaves it and the minutes given it | `app/lib/stagerecord.js`, `app/lib/handlers/takes.js`, `app/server.js`, `app/lib/ai.js`; test `stagerecord` |
| A take on the hall page: drawn over it by a module that holds no socket (a document and a picture through the documents' reader, kept by no device; a quote drawn from data), information over the show (held under blank, or arriving in the side bar, beside the operator's too), minimised as a card in its side bar, Earlier there and its Look, the page saying what it drew of each; a web page in the one frame a page makes, which only the hall page's policy allows (`CSP_HALL`); the Board chip and the console's People's pages that show it and take it down | `app/public/pagelayer.mjs`, `app/public/app.js`, `app/public/app.html`, `app/public/catalog.js`, `app/lib/guard.js`; tests `catalog`, `menus`, `modules`, `server`, the browser smoke |
| Stagewatch links, peers, hello; what a send says (Stagewatch's grammar as the oracle); the one line a push carries to the speaker's screen, by one core the server and the hall page share (＋ the speaker's screen) | `app/lib/nodes.js`, `app/lib/stagelines.js`, `app/public/linecore.js`, `app/public/app.js`; tests `showbus`, `server` |
| Patterns and PlayMap links; the context other show systems read | `app/lib/peerlinks.js`, `app/lib/context.js` |
| HTTPS and certificate pins; the machine key, sealed secrets and the keys derived from it | `app/lib/tls.js`, `app/lib/secretbox.js` |
| Health's readings and a show day's peaks | `app/lib/peaks.js` |
| What a start opens, says and may write: nothing before the folder and the port are held; a secret made only where there is none | `app/lib/startup.js`, `app/lib/resilience.js`; test `startrules` |
| Where the admin token is said, only where a person sits; Show the admin token; the installed node's console commands (serve, the task's action; status, the person's reader; open, the Start menu's launcher; start, stop, upgrade, Go back and Who may run, the person's requests to their own control task; export and forget-keys, the portable import's steps as the person) | `app/supervise.js`, `app/launch.js`; tests `admintoken`, `machine`, `installer`, `control`, `import`, `upgrade` |
| The installed node's machine-level commands, run elevated or as SYSTEM (the race-free folder, the server task, the firewall rules, the HKLM record, uninstall, preinstall-check, upgrade-stop, status, restore, whose it is, the start and its verify, the first admin account, the portable import's elevated steps, the checked upgrade's runner; Node's built-ins only, every program by its absolute path, the machine's own wire half) | `app/machine.js`; tests `machine`, `installer`, `import`, `upgrade` |
| The portable import, once, before the installed node's first start: the installer's page, the export as the person into their inbox, the elevated copy and its verify (counts, keys, sealed values, fingerprint, chain, and what the node's own start refuses), each side's facts read by one reader that writes nothing, then the old copies of the keys removed and the portable folder marked as moved, which it no longer starts on; no copy of the bundle kept once an import ends | `app/lib/importfacts.js`, `app/launch.js`, `app/machine.js`, `app/lib/dataformat.js`, `installer/AGMessage.iss`; test `import` |
| The laptop's admin and the rights it gives (token, start, stop, upgrade): one control task per account, run as SYSTEM, which reads that account's request and the record's rights and acts; the machine's events, appended by the machine and written by the server as audit rows, each once | `app/machine.js` (`control`), `app/launch.js`, `app/lib/machineevents.js`, `app/server.js` (`/api/machine/events`); test `control` |
| The checked upgrade, with no administrator: an installer the person names or the newest release, staged and checked by their control task against its immutable release on GitHub (the repository the build was stamped from, the asset's digest, newer only, not busy), then run by a runner of its own (a task, outside Program Files), one at a time, once their console has closed; Go back to build N from the kept installer and the upgrade's backup; each outcome a machine event once it is seen | `app/machine.js` (`control`, `upgrade`), `app/launch.js`, `installer/AGMessage.iss` (`/UPGRADEBY`), `tools/stamp-build.js`; test `upgrade`, GitHub's answer for one release in `app/test/fixtures/` |
| The installer's life cycle in CI, run for real on an elevated Windows runner and refusing any other machine: installed, upgraded from the build before, refused, rolled back, gone back from and uninstalled, each step's words held to the code's on Linux, every test it declares counted; the release order it asks first; the other two builds made from one payload; the release's attestations, their check, and its immutability read back | `installer/test/` (`lifecycle.test.js`, `hands.js`, `expect.js`, `as-account.js`), `tools/lifecycle.js`, `tools/provenance.js`, `.github/workflows/ci.yml` (`lifecycle`, `release`); tests `lifecycle`, `provenance` |
| The installer: one per-machine Inno Setup script (its pages, refusals, silent switches, Start menu, the way back and the uninstall, every machine-level act a `machine.js` command), built by CI from the portable zip's stage without its .bat files, with the defines read from that stage; the licence texts of the two programs the folder and the installer ship | `installer/AGMessage.iss`, `installer/build-installer.ps1`, `tools/installer-defines.js`, `licenses/nodejs/`, `licenses/cloudflared/`, `THIRD-PARTY-NOTICES.md`; tests `installer`, `vendor` |
| The way back's backup of the data folder, made at an upgrade's stop (hard links and copies, two kept) | `app/lib/upgradebackup.js`; test `machine` |
| What the console says, kept (`server.log`, in the logs folder `AGM_LOG_DIR` names under the task), and "This laptop" | `app/lib/serverlog.js`, `app/lib/laptop.js`; test `laptop` |
| A sleep told from a hang; a live show kept awake (the power request) | `app/lib/power.js`, `app/lib/resilience.js` (`BeatClock`); test `sleep` |
| How busy it is, and a stop that saves, asked at loopback with a proof of the token | `app/lib/busy.js`, `app/lib/machinewire.js`; test `busy` |
| AI drafts and their brief | `app/lib/ai.js` |
| The version, "newer" and the release order; the repository a build was stamped in | `app/lib/version.js`, `tools/stamp-build.js`; test `version` |
| The data folder's format marker, its upgrade copy, and an import's mark on a folder moved into the installed node | `app/lib/dataformat.js`; tests `dataformat`, `import` |
| The pages | `app/public/` (`index` sign-in and codes, `halls` the board, `users` accounts and audit, `app` a hall, `admin`, `display`) |
| The browser libraries the pages load, byte for byte as published, their list, licences and notices; the SBOM's vendored part | `app/public/vendor/`, `VENDOR.json`, `THIRD-PARTY-NOTICES.md`, `licenses/`, `tools/vendor-sbom.js`, `tools/vendor-audit.js`; test `vendor` |
| The page floor (Safari 14.1, Chrome 84): its probe, the helpers for what a browser may lack, every page's one toast; the walk on the owner's Board devices, which holds the tag | `app/public/theme-init.js`, `app/public/common.js`, `docs/DEVICES.md`; test `pagefloor` |
| The document floor (Safari 16.4, Chrome 103): the hall page's probe at its join, a document's stand-in for a device below it, made by the pusher's page and drawn in the document's place, and Show them a picture | `app/public/app.js` (`DOCS`, `Show`), `app/public/pagelayer.mjs`, `app/lib/pages.js`, `docs/DEVICES.md`; tests `pages`, `takes`, the browser smoke |
| Every status's mark: one table, each mark one meaning and one colour, drawn by name as one status chip or a status line; the server's marks named from it | `app/public/common.js` (`AGM.MARKS`), `app/lib/pages.js`, `app/lib/displays.js`, `eslint.config.mjs`; tests `modules`, `catalog`, `lint-rules` |
| The hall page's header: the room's name, its status, Help and a ⋯ at every width, the switcher under it | `app/public/app.html`, `app/public/app.js`, `app/public/catalog.js` (kind `header`) |
| The Board's chat view (the simple view): the chat first, one response place per screen, its ⋯ sheet, laid out by the screen's size and dark first; the admin's Chat view for a person; the clock or countdown beside the hall's name, chosen on the device and by the admin, who may lock it | `app/public/app.js` (`Simple`), `app/public/styles.css`, `app/public/theme-init.js`, `app/public/catalog.js` (kind `sheet`), `app/lib/views.js`, `app/lib/handlers/takes.js` (`admin:setView`, `admin:setClock`), `docs/DEVICES.md`; tests `takes`, `catalog`, `units`, `pagefloor`, the browser smoke |
| What the admin lets a seat On stage do (each off by default, the admin's alone): a message also on a countdown screen's line or beside the chat of everyone On stage (a card in a place of the Board's own, which supersedes nothing), saying where it went as the people and screens it went to confirm, and Got it clearing the message from the person's own feed | `app/lib/views.js`, `app/lib/pages.js` (the `line` place), `app/lib/handlers/takes.js` (`admin:setOnStage`), `app/server.js` (`message`'s `also`), `app/public/app.js` (`Also`, `Cleared`, `Takes`), `app/public/catalog.js`, `app/public/admin.js`, `app/public/users.js`; tests `also`, `pages`, `catalog`, `units`, the browser smoke |
| What AGMessage loads and runs: only what it ships, only by its absolute path; what the machine's commands run of it elevated, only `app\lib`, `app\verify` and Node's own | `app/test/loads.test.js`, `app/test/resolve-preload.js` |
| The house lint rules: an unescaped value into a page's HTML; HTML parsed anywhere but its one place in the documents' modules; a test's own text read of the checkout or port picker | `app/eslint-rules/`; test `lint-rules` |
| The module fence: the server's layers, the handler modules held narrow, no new verb in `server.js` | `app/test/modules.test.js` |
| The one gate, and the contexts a handler module is given | `app/lib/gate.js`, `app/lib/handlers/` |
| The portable build: `AGMessage-Portable-<version>.zip` holding one folder, `AGMessage`; every path it makes held under MAX_PATH | `tools/fetch-runtime.ps1`, `tools/build-portable.ps1`, `tools/zip-paths.js`, `start-agmessage.bat`, `make-shareable-copy.bat`; test `zippaths` |
| The Windows evidence lane: the readings and the lab lines, judged against their marks; the release's notes on them and on the show laptop's readings as `docs/DESIGN.md` records them | `tools/readings.js`, `tools/readings-take.js`, `tools/defender-on.ps1`, `docs/INSTALL.md`, `docs/DESIGN.md`; test `readings` |
| Test helpers: a server on a throwaway folder, `readSource`, `freePort` / `freeUdpPort`, the files the fences read, Office files built from XML and the document worker run as a browser runs it | `app/test/helpers.js` |
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
board** — every hall an account may see; **a screen** — a browser holding a screen's link; **a take** — what a screen,
or a person's page, is told to show, numbered; **the desk** — Stagewatch's approval queue, where a proposal waits for
the operator; **a link** — AGMessage's connection to a Stagewatch, Patterns or PlayMap; **a fence** — a test or lint
rule that fails the build when an invariant breaks; **a seat limit** — what a seat allows at all, whatever the rights
behind it, read before any right and the admin's too (On stage: reading and writing messages, nothing else); **the air**
— what the audience and the speaker see; **the simple view** — the Board's chat view, which a page seated On stage draws
unless the admin chooses Full for that person; **the outbox** — what holds a page's send until the server answers it, so it is
never lost and never made twice; **a catalogue entry** — an act, drawn as a button and a menu item from one row, absent
where a seat may never do it and disabled with its reason where it cannot now; **a fold** — catalogue entries of one
kind drawn as one item when both are shown (Speaker's screen ▸: Ask the operator… · Send now), flat when one is; **a
transfer** — a file shared for download (a file message), never opened on anyone's page by itself; **a download ticket**
— the server's single-use leave to download one file; **confidential** — a mark on a file (one record a file) that keeps
it where it is in use or sent, off screens and away from the AI; **a quote** — words or cells picked in a file (or pasted or typed), shown on
the stage as data (a `snippet` take) and never as HTML; **the stage record** — what was shown on people's pages, hall by
hall, for the transcript and the minutes.

**One word per thing** (the smoke's word check holds the pages to it): a hall (never "meeting", "session" or "room");
a room — Main, Legal, Media, named "Hall 2 › Legal" (never "hall"): the Main room is the hall itself, its key the hall's, and a side room one of its other rooms, kept beside it and reached by its key; a code — what guests type, each room its own, a hall's its key until New code ("guest code" in the
admin's words); a seat — On stage · Backstage · Observer · Member ("role" only in code); the Board — everyone seated On
stage in Main (never "directors"); the backstage team (never "research team" or "Support Team" on a page); Chat view —
By seat · Simple · Full; screens — `/d/` links (never "displays" on a page); the speaker's screen — Stagewatch's
confidence monitor; Show people (📺 Show the Board, Show Ana, under Send to stage; undone by Take down or Back to chat),
Show on a thing, Send into a room. Stagewatch's "meetings" stay, as Stagewatch reads them.
