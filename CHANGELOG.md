# Changelog

## 0.5.1 — 2026-10-25 — the show desk and the Stagewatch link, as Stagewatch states them

From the cross-app review of the Show Bus (the four items it left for after 0.5.0), each read against Stagewatch's own
code (2.16 and its newest work) before it was changed.

**The show desk**
- A proposal's outcome is read as Stagewatch states it: `ok` and `words` at the top level, `result` a string. 0.5.0
  looked for `ok` inside an object `result` that Stagewatch never sends, so every outcome read as unknown (the page's
  "done" or "failed" came from the state alone), and a result object would have been read as success whatever it said.
  A settled state without its boolean `ok`, or a state AGMessage does not know, is shown as unknown (never done, never
  waiting) and asked again. Only a proposal the desk lists as approved for this AGMessage is run. "Not delivered" shows
  Stagewatch's own words.

## 0.5.0 — 2026-10-24 — halls, accounts, screens and the testing environment

For a venue with several halls at once (the ICC in Birmingham, say): each hall its own message room and its own
Stagewatch, crews with their own logins, project managers seeing every hall, screens driven from the operating room.

**Accounts beside the codes**
- Individual sign-in (username and password) for crew, project managers and admins; presenters and guests still join
  a hall with its 6-character code. Roles: admin, project manager, senior tech (every hall), tech, staff, viewer (their
  halls); an admin grants or removes single rights per person and picks their halls (Accounts page).
- Passwords: scrypt (N=2^15, r=8, p=3), NIST 800-63B policy, one-time passwords for new people changed at first
  sign-in. Sessions: HttpOnly, SameSite=Strict, Secure over HTTPS, stored only as hashes, 14 h idle / 7 days, ended at
  once by a password change, turning an account off or "sign out everywhere" — open pages reconnect with the rights the
  account has now. Admin rights do not sign in through the tunnel unless the admin allows it.
- A hash-chained audit log of sign-ins, rights, halls, screens, sends to Stagewatch and commands to other show
  systems; the Accounts page checks its chain. Never a password, token, key or screen link.
- A code guest cannot take the name of someone with an account; account messages carry a ✓ mark.

**Halls**
- Each hall may follow its own Stagewatch (Set up on the halls board; Stagewatches heard on the network are offered);
  the default one serves the rest. Countdowns, sends, acknowledgements and proposals stay in their own hall.
- The halls board: every hall an account may see — its countdown, who is in, the last message, open help, its
  screens and its linked Patterns / PlayMap — live.
- Help requests: Sound, Vision, Lighting, Stage, Presenter, IT / network or Other, with a few words; red until someone
  is "On my way", on the board until "Resolved", from the hall or the board.

**Screens (display URLs)**
- Every hall can have screens, each with its own unguessable link (`/d/…`) to open in any browser: holding image,
  a message (note / soon / urgent, in a shape and a band), an image or a PDF page from the hall, the hall's countdown
  with a message strip under it (the speaker's comfort monitor), the clock, or black; identify flashes its name.
- A screen confirms what it showed: ✓ on screen, … sending, △ couldn't, ✕ offline. A link can be replaced at once.
- From the hall: Screens (tick screens, then take), and ⧉ on any message or image/PDF to show it on screens.

**Show network (Show Bus 1.2)**
- Send to Stagewatch with a destination: the speaker's screen under the countdown (sent now or asked of the
  operator), the moderator / backstage / interpreter screens, a department, or only the operator — the show caller
  approves it in Stagewatch's Copilot.
- Fixed: 0.4 proposed `message "…" <urgency> ack`, which Stagewatch refused ("flash must be off|slow|fast"); the line
  is now `… <urgency> off ack`, and every line is held to a port of Stagewatch's own parser.
- PlayMap's hellos are heard (they were dropped). Patterns and PlayMap can be linked with their own tokens: their
  light, headline and attention items on the halls board and in the AI's brief; their listed verbs proposed to the
  show desk with the node's own risk, where a person approves them and the node collects them with its own key.
- A linked node's pairing token is full control of it, so it goes only to this laptop, or over HTTPS to a certificate
  that is pinned or that a person confirmed by typing the first 16 or more characters of the fingerprint the node shows
  on its own screen (when linking, or with Confirm certificate on the admin page). A node on another machine with no
  HTTPS, or whose certificate nobody confirmed, shows red with the reason and is sent nothing. A node's hello (anyone
  can send one), and a certificate the Stagewatch link trusted on first use, confirm nothing; no page shows a fingerprint
  to copy; a node on this laptop heard from its network address is linked on the laptop itself. AGMessage never drives
  a node directly with that token: driving it waits for a key the node issues to AGMessage alone (Patterns' `ptk_`,
  PlayMap's `pmk_`). Found by a review of the Show Bus across the four apps (AG-1, units 21 and 21.1).

**Versions** — one scheme for every build (`app/lib/version.js`): `package.json` names the version; CI stamps the build
number and commit (`tools/stamp-build.js`). A release reads `0.5.0+17.abc1234`, a CI development build
`0.5.0-dev.17+abc1234`, a local copy `0.5.0-dev+abc1234`. The console banner, `/api/health` (`build`), the admin page
and the Show Bus hello (`build`) say it; the portable zip is named by it; a release tag that names another version is
refused.

**Runtime** — Node.js 24.22.1 LTS (pinned by SHA-256; CI also runs Node 26, LTS from 2026-10-28), Express 5.3,
multer 2.5, socket.io 4.8.4, ws 8.22, Anthropic SDK 1.3 (API version 2026-10-21, Apache 2.0; drafts opt into the
server-side refusal fallback); nanoid replaced by `node:crypto`.

**The testing environment** (`docs/ANALYSIS.md`, `SECURITY.md`) — ESLint 10 with the security rules, a banned-call
list and a house rule that refuses unescaped values on their way into a page's HTML, as build fences; an in-tree
secret scan; a coverage gate; the browser smoke on Linux (Chrome) and Windows (Edge); CodeQL, `npm audit` with registry
signatures, dependency review and Dependabot; releases with a CycloneDX SBOM, SHA256SUMS and build provenance. The
fences found and fixed six unescaped values, a pattern-built cookie reader, names stripped of C0 controls only (now
also C1 and bidi overrides) and a predictable jitter.

**Found by independent reviews before release, and fixed** (`docs/ANALYSIS.md` §6: 59 findings confirmed by a second
reader, then 19 more when the fixes were read together — every one fixed or answered; units 9 to 19)
- *Nothing a client sends stops the event.* A socket that never signed in could end the process with `null` or an
  object `String()` cannot convert (0.4's handlers had the same shape); every event now reaches its handler through one
  guard, and client values are read by their type. A fence sends every event every shape.
- *Rights.* The first admin is made only from the laptop itself (a page under another name that leads back to it is
  refused). Only an admin changes an account that manages accounts or settings, and a non-admin with `users.manage`
  hands out nothing past its own rights and halls. Forwarding is judged by the person's rights in the hall it lands in;
  read-only members no longer pin, react or answer action prompts; a node linked for every hall is driven only by those
  with `nodes.control` in every hall; a hall's commands are proposed only to its own Stagewatch's desk.
- *Who is told what.* A hall's join code reaches only those who may open it (not a one-hall manager's Accounts page,
  not a screen, not everyone in a hall the admin linked one guest from); a hall's AI brief and the context posted to
  its Stagewatch carry its own halls' facts and events, never another hall's; pages offer no button the server would
  refuse (Show network, send to stage, an untouched Save of one's own account).
- *Sessions.* Signing out, a session that ends and "admin rights only on the venue network" now reach open pages, not
  only the next sign-in. A page in use keeps its session past 14 hours idle; seven days still ends it. An account keeps
  its 20 newest sessions. The admin token's sign-in survives a watchdog restart and ends after a day.
- *Sign-in.* A stranger's wrong passwords no longer lock the laptop or the venue network out of an account; a refusal
  never says a password was right; a password typed into the username box is never written to the audit log; a flood
  of guesses through the tunnel cannot hold sign-ins on the venue network. Two quick clicks make one account, not two.
- *Screens.* A take reaches every ticked screen as one request (a 16-screen "Black" was partly refused); with two
  browsers on one link the console says what each shows; an older slide that loads late never paints over a newer one;
  a deck stepped through keeps one pdf.js worker; the clock shows AGMessage's time zone; the message under the countdown
  never covers it on an upright tablet.
- *The show network.* Each Stagewatch gets only the context of its own halls; a pinned node is never spoken to over
  plain HTTP again, and a changed certificate can be accepted; Stagewatch's and our numbers never cross after a restart
  or a relink; a silent Stagewatch is redialled after 12 s as documented; PlayMap's own rules rate a line before it
  reaches the show desk (high until they are read); a command's secret is never written to the audit log; the discovery table is bounded.
- *Data.* On Windows, Ctrl+C, closing the console window and the watchdog's own stop now let the server save first:
  a signal sent to a child process there ends it at once, so the last half-second of saves and any audit entries still
  waiting were lost (CI's Windows job found it). The stop is asked over IPC. A server whose watchdog has gone saves and
  leaves; on Windows, Windows ends it with the watchdog — either way no copy is left holding the folder. A locked
  hall's seats survive the watchdog's restart; a stage send whose Stagewatch restarted reads "lost", never "sent"
  waiting for an acknowledgement that cannot come. A second copy on the same data folder is refused before it writes
  anything (it used to rewrite the running copy's rooms); a save the disk cuts short fails and is retried instead of replacing a whole file; the audit check reads
  every rotated file as one chain, off the event loop; uploads stop before the disk fills, and files nobody posted are
  removed.

Tests: 237 (was 53) plus the browser smoke (61 checks, was 7).

## 0.4.0 — 2026-10-11 — encrypted connections and the show desk (Show Bus 1.2)

**Encrypted connections** (Show Bus §10)
- HTTPS on the same port as HTTP: one listening port, the first byte decides; the same pages, Socket.io and API.
- A per-install self-signed certificate (ECDSA P-256), made with node:crypto — no new dependency and nothing written to
  the Windows certificate store — kept outside the app folder with its private key sealed. 825 days (Apple devices
  refuse longer), renewed automatically 30 days before it ends; Admin → "New certificate" on demand.
- `/tls`: the fingerprint and how to trust the certificate on Windows, macOS, iOS and Android; `/tls.cer` to download it.
- Admin → **Require HTTPS**: plain HTTP and Socket.io refused from other devices (pages redirect to https://), kept
  for this laptop and the Cloudflare tunnel (which connects locally).
- The Stagewatch link uses https/wss when Stagewatch announces a certificate, the address is https://, or a fingerprint
  is typed — pinned per node: checked before anything is sent, pinned on first authenticated use, a change refused as
  CERTIFICATE CHANGED until the admin accepts it.
- The hello carries `tls` and `ports.https`.

**The show desk** (Show Bus §11)
- When Stagewatch keeps the shared approval queue, the research team can propose a message for the speaker's screen
  (📝) instead of sending it; the show caller approves it in Stagewatch and its state shows on the message.
- AGMessage takes one verb from the desk — `notice <text>`, a notice to every open meeting — collected when approved,
  run once, and its result reported. Listed in AGMessage's context with its risk.

Tests: 53 (was 43) plus the browser smoke.

## 0.3.0 — 2026-10-10 — resilience and Show Bus 1.1

**Resilience**
- A watchdog (`app/supervise.js`) runs the server: restarts it after a crash or a hang (heartbeat from the event loop,
  10 s), backing off 2/4/8/15/30 s, resetting after a 5-minute run; gives up after 6 crashes in 10 minutes and leaves
  a marker the admin page shows. Exit codes carry intent (0 stopped, 3 can't start as configured, 70 crash, 82 restart).
  The admin token survives restarts.
- An uncaught error saves the rooms, records the crash (admin → Health) and exits for the watchdog; an unhandled
  rejection is logged and counted.
- Crash-safe saves: tmp → fsync → rename, a `.bak` kept only of a whole file, a torn file falls back to its backup;
  settings go through one coalescing write lane flushed at shutdown.
- Saved keys (Stagewatch, Anthropic) sealed with AES-256-GCM and a machine key outside the folder; 0.2's clear keys
  are migrated on first start.
- Event-loop delay and send-to-stage round trip measured (admin → Health). Guard-rail test: no eval, no key in a URL,
  synchronous file calls capped per file with reasons.

**Show Bus 1.1** (`docs/SHOWBUS.md`)
- One discovery channel (UDP 9928 hellos, every kind heard, stable node id); Patterns' 9700 beacon no longer used.
- Stagewatch link: key in the Authorization header (never `?pin=`), a node-scope key, liveness 2/6/12 s with jittered
  redial, clock offset with CLOCKS APART.
- Receipts on send-to-stage; the speaker's acknowledgement shows on the message that was sent; a down link refuses at
  once.
- `GET /api/context` (read-only token) and context pushed to Stagewatch; Stagewatch's context read back for the admin
  page and the AI drafts' brief. The context never carries message text, names, room names or documents.
- AI drafts get the show network as facts (unknown stays unknown, a person sends); the app says plainly that everything
  but the drafts works offline.

Tests: 43 (was 25) plus the browser smoke.
