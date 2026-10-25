# How AGMessage is built — speed, security and reliability

AGMessage runs a live event: a dropped message, a wrong screen or a leaked link happens in front of a room. It borrows
from two fields that live with that: **games** (many clients, unreliable networks, an authoritative server that must
never stall) and **medical device software** (every action traceable, every hazard tested, nothing claimed that was
not observed). This page says which practice is used where, so a change can keep it.

## From games: an authoritative server on an unreliable network

| Practice | Where |
|---|---|
| **Sequence numbers and deltas.** Every change to a room is an operation with a per-room number; a phone that drops off the Wi-Fi resumes with just what it missed, or a full snapshot when the gap is too old. | `lib/store.js` (`opsSince`, the ring), `public/app.js` (`bump`, `rejoin`) |
| **The server is the authority.** Identities are issued and signed by the server; a client never names itself, its role or its rights. Accounts' rights are read at connect and re-read when they change. | `lib/guard.js` (identities), `lib/rbac.js`, `server.js` (`accountChanged`) |
| **Latest wins for state, never a backlog.** The halls board is pushed at most every 300 ms with the newest state; Stagewatch frames replace each other; a slow phone gets the newest board. | `server.js` (the board tick), `lib/nodes.js` (`_set`) |
| **Liveness from silence.** A link is stale after 6 s without a frame and redialled after 12 s with jittered backoff; a screen's countdown dims to `--:--` rather than show a confident stale time. | `lib/nodes.js`, `public/display.js` |
| **Rate limits and lockouts per client.** Token buckets for messages, chatter, uploads, AI and screen reports; lockouts for guessing codes, tokens and passwords. | `lib/guard.js` (`Bucket`, `Lockout`) |
| **Nothing heavy on the game loop.** Password hashing runs on libuv's pool, two at a time; synchronous file calls are counted per file and capped by a test; the event loop's delay is measured and shown. | `lib/accounts.js`, `test/resilience.test.js` (guard rails), `server.js` (health) |

## From medical device software: traceable, observed, fail-safe

| Practice | Where |
|---|---|
| **Attempts are not facts.** A command is sent → accepted → applied → observed. A send to Stagewatch reads its receipt and then the speaker's acknowledgement; a screen says "on screen" only when the screen confirms the numbered take it rendered. | `lib/nodes.js` (`readReceipt`), `lib/displays.js` (`shown`, `status`) |
| **An audit trail that shows tampering.** Every security-relevant action is appended, flushed to disk before it is acknowledged, and hash-chained; a check names the first broken line. | `lib/audit.js` |
| **Fail closed.** An unknown verb, role, right, destination or content kind is refused, never defaulted; a screen's connection is heard for nothing but its reports; a high-risk command to another show system only ever goes to a person to approve. | `lib/rbac.js`, `lib/stagelines.js`, `lib/peerlinks.js`, `server.js` (`serveDisplay`) |
| **Every hazard has a test.** Escalation, revocation under a live socket, tokens in files and logs, same-numbered acknowledgements and proposals from two Stagewatches or one restarted, a refused grammar, a tampered audit line — each is a test that fails the build. | `app/test/*.test.js` |
| **The software of unknown provenance is listed.** Every release carries a CycloneDX bill of materials, the zip's SHA-256 and a build-provenance attestation; dependencies are audited with registry signatures weekly. | `.github/workflows/ci.yml`, `security.yml` |
| **Every build is identified.** One version scheme; the build a laptop runs is on its health page, its admin page and its hello. | `lib/version.js`, `tools/stamp-build.js` |
| **Recover, don't stop.** A watchdog restarts a crashed or hung server with backoff; saves are atomic with a backup of the last whole copy; sessions, rooms, screens and settings survive the restart. | `supervise.js`, `lib/resilience.js` |

## Security in one list

Sealed secrets at rest (AES-256-GCM, a machine key outside the app folder) · scrypt passwords · hashed session tokens in
`HttpOnly`/`SameSite=Strict`/`Secure` cookies · an `Origin` check on every state change · a strict Content-Security-Policy
with no inline script · uploads allow-listed and checked by content, served so they cannot run script · HTML built only
from escaped parts (a lint rule) · names stripped of control and bidirectional characters · pinned certificates
between show systems, keys in headers and never in URLs · capability links for screens · CodeQL, a dependency audit and
a secret scan on every change. Details: `SECURITY.md`, `docs/ACCOUNTS.md`, `docs/DISPLAYS.md`, `docs/ANALYSIS.md`.
