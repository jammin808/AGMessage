# Changelog

## 0.5.0 — 2026-10-24 — halls, accounts, displays and the testing environment

**Versions** — one scheme for every build (`app/lib/version.js`): `package.json` names the version; CI stamps the build
number and commit (`tools/stamp-build.js`). A release reads `0.5.0+17.abc1234`, a CI development build
`0.5.0-dev.17+abc1234`, a local copy `0.5.0-dev+abc1234`. The console banner, `/api/health` (`build`) and the Show Bus
hello (`build`) say it; the portable zip is named by it; a release tag that names another version is refused.

**Runtime** — Node.js 24.22.1 LTS (pinned by SHA-256), Express 5.3, multer 2.5, socket.io 4.8.4, ws 8.22, Anthropic SDK
1.3 (API version 2026-10-21, Apache 2.0); nanoid replaced by `node:crypto`.

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
