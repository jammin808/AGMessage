*Master copy: Stagewatch `docs/SHOWBUS.md` (github.com/jammin808/Stagewatch). This copy is AGMessage's reference; where they differ, the master wins.*

# Show Bus 1.2 — the contract between Stagewatch, Patterns, AGMessage and their micro-apps

*Version 1.2, 2026-10-11 (1.1: 2026-10-10; 1.2 adds §10 encrypted connections and §11 the shared approval queue, and
hello `tls`, caps `approvals`). This page is the contract. `docs/ECOSYSTEM.md` is the why and the roadmap; each app's own
remote documentation (Stagewatch `docs/REMOTE.md`, Patterns `docs/REMOTE.md`, AGMessage `docs/NODES.md`) shows how its
endpoints implement this. A copy of this file lives in each repository; this one is the master.*

Everything here works **on the local network with no internet and no AI**. The only parts that need the internet are
the language models (drafting, summaries, answering questions) and AGMessage's optional Cloudflare tunnel for people
off-site. See §9.

## 1. Rules every node follows

1. **Attempts are not facts.** A command is *sent → accepted → applied*. A node answers every command it was given an
   id for with a receipt that says which (§3). "OK" from a socket write is never success.
2. **Durations, not wall clocks, for anything that counts.** Remaining time travels as a duration with a sequence
   number; a receiver counts down from the frame it holds and re-syncs when the sequence moves (§4).
3. **Latest wins for state, nothing is dropped for replies.** A slow peer gets the newest state, never a backlog; a
   reply is never dropped but a peer that stops reading is cut (one writer per connection).
4. **Discovery says what a node is, never what the show is doing.** Show data travels only on authenticated links (§2).
5. **Secrets ride in no URL, no journal line and no beacon.** Keys go in a header or a proof (§7).
6. **The picture is computed, the model only reads it.** Lights and headlines come from facts with rules, so they are
   the same with or without AI (§6, §9).

## 2. Discovery — one channel: the hello on UDP 9928

Every node broadcasts a hello every **2 s** to UDP 9928 (broadcast and loopback), and **every node listens** on 9928
(shared port, `SO_REUSEADDR`). Nothing else is needed to find a peer.

```json
{"t":"main","v":1,"proto":1,"id":"a1b2c3d4","name":"Hall A","host":"FOH-LAPTOP",
 "ports":{"http":9924,"ws":9924},"caps":["timer","cues","messages","context","receipts"],"clock":1760101234567}
```

| field | meaning |
|---|---|
| `t` | node kind: `main` (Stagewatch), `agent` (Stagewatch Slides presenter PC), `patterns`, `messenger` (AGMessage) |
| `v` / `proto` | hello format version (1) / Show Bus version this node speaks (1 = 1.1 contract) |
| `id` | stable per install (random, 8 hex), so a renamed node is still the same node |
| `ports` | where to connect: `http`, `ws`, `wire` (Patterns TCP), `osc` — only those it serves |
| `caps` | what it can do: `timer`, `cues`, `messages`, `video`, `eye`, `context`, `receipts`, `clock`, `slides`, `mcp`, `ai` |
| `clock` | sender's Unix time in ms (for a first, rough offset; the real one is §5) |

A peer is **live** while hellos keep coming, **stale** after 6 s without one, **gone** after 12 s (§5). A node bound
to loopback only does not broadcast. The older beacons (Patterns 9700, Stagewatch rooms 9927) remain for their own
features (Patterns' twin/standby, Stagewatch's multi-room dashboard) and are not used for discovery between apps.

## 3. Commands and receipts

Any command may carry a **request id** (`[A-Za-z0-9_-]{1,32}`). A node that sees an id answers with a receipt for it.

| transport | request | receipt |
|---|---|---|
| Patterns wire (TCP 9697) | `@a1 VIDEO END 10` | `OK @a1 <json?>` · `ERR @a1 <reason>` |
| Stagewatch Companion TCP (9923) | `@a1 START` | `OK @a1` · `ERROR @a1 <reason>` |
| Stagewatch HTTP (`/api/...`) | header `X-Request-Id: a1` | JSON body (below) |
| Stagewatch WS (`/ws`) | `{"cmd":"start","args":[],"id":"a1"}` | `{"type":"receipt", ...}` (below) |
| AGMessage HTTP / Socket.io | `id` field / ack callback | same JSON |

Receipt JSON (HTTP and WS):

```json
{"type":"receipt","id":"a1","ok":true,"stage":"applied","effect":"Message on the speaker screen","refs":{"messageId":12}}
```

`stage` is `accepted` (queued; the node could not confirm within its deadline, normally 3 s) or `applied` (run on the
show thread; `effect` says what changed). `ok:false` carries `error`. `refs` names what the command made — a message's
signal id (so the sender can follow its acknowledgement), a proposal id (an AI agent's command waiting for the
operator). A command without an id behaves exactly as before.

## 4. State frames

Every state stream carries `v` (frame format version), `seq` (increases with every published change; a receiver
seeing a smaller `seq` after a reconnect knows the sender restarted) and the node's `id`. Counting values are durations
(`seconds`, `remainingMs`) plus a `seq` that changes on every discontinuity (seek, pause, nudge, loop, item change).

Liveness, the same everywhere: a state stream sends at least one frame or beat every **2 s**; a receiver marks the
link **stale after 6 s** of silence (show "?" / grey) and **drops and redials after 12 s**. Redial backoff: 0.5 s
doubling to 5 s, with jitter. A node never queues commands while a link is down: a command to a dead link fails at once
with a receipt saying so.

## 5. Clock offset

Links that can ping carry timestamps, NTP-style: the client sends its time `t1`, the server answers with its receive
time `t2` and send time `t3`, the client notes `t4` on arrival.

| transport | ping | pong |
|---|---|---|
| Patterns wire | `PING 1760101234567` | `OK PONG 1760101234567 <t2> <t3>` |
| Stagewatch WS | `{"cmd":"ping","t":1760101234567}` | `{"type":"pong","t":...,"t2":...,"t3":...}` |
| Stagewatch Companion | `PING 1760101234567` | `PONG 1760101234567 <t2> <t3>` (after the existing words) |

`offset = ((t2 − t1) + (t3 − t4)) / 2`, `rtt = (t4 − t1) − (t3 − t2)`; keep the sample with the smallest rtt of the
last 8. A node shows **CLOCKS APART** when a peer's offset exceeds **2 s** — timers on two machines then disagree on
what time "14:30" is, even though durations stay right.

## 6. Context — what an AI (or the Eye) needs to understand a node

Every node answers **`GET /api/context`** (HTTP, authenticated read) and Patterns also **`CONTEXT`** on the wire, with
one shape:

```json
{"v":1,"node":{"t":"main","id":"a1b2c3d4","name":"Hall A"},"at":1760101234567,
 "light":"amber","headline":"Keynote — Ana · 12:30 left · 2:10 behind · Lighting, Sound standing by",
 "items":[
   {"id":"timer","kind":"timer","label":"Keynote — Ana","light":"green","state":"running, 12:30 left"},
   {"id":"cue:lighting","kind":"department","label":"Lighting","light":"amber","state":"standing by: LX 12"},
   {"id":"link:patterns","kind":"link","label":"Patterns (VT)","light":"green","state":"clip 0:42 left"}],
 "links":[{"from":"timer","to":"link:patterns","kind":"follows","light":"green"}],
 "recent":[{"at":1760101230000,"text":"GO Lighting: LX 11 (done by Sam)"}],
 "commands":[{"verb":"signal go all","risk":"high","words":"GO every department standing by"}],
 "peers":[{"t":"patterns","id":"9f8e7d6c","name":"Patterns FOH","light":"green","headline":"Programme: VT1 · 3 screens green"}]}
```

- `light` is the worst light of the node's items: `red` (wrong now: overtime, curfew missed, unanswered cue, link
  down that the show needs), `amber` (needs attention: behind schedule, standing by, not paired), `green`, `grey`
  (unknown / not verified). Unknown stays unknown: never guessed.
- `headline` is one line computed from the facts — no model. It is what a Stream Deck key, the Eye's node card or a
  dashboard shows, and what an AI reads first.
- `items` and `links` use the Eye's vocabulary (kind, light, state; link kinds `feeds`, `shows`, `drives`, `controls`,
  `follows`, `hears`, `sends`), so Patterns' Eye can draw any node's insides as nodes on its CONTROL plane.
- `recent` is the last ≤ 20 journal lines in plain words; `commands` the verbs a peer (or an AI) may propose, each with
  its risk (`low`, `review`, `high` — high is never pre-ticked by any assistant).
- `peers` is one hop only: the peers this node hears, with their light and headline (never their peers), so a node
  that can reach only one other still sees the room.
- No secrets, no private content (AGMessage never puts message text or documents in its context — only counts, the
  room's state and action prompts' titles).

## 7. Keys and pairing

- **Stagewatch**: scoped keys (`swk_…`) in `Authorization: Bearer`, hashed at rest, rate-limited. Scopes: `read`,
  `control`, `mcp`, and **`node`** (1.1): read + post a stage message + post its own context — what a messenger app
  needs, nothing more. Keys are accepted wherever the PIN is (a key never counts as a wrong PIN).
- **Patterns**: the pairing token is never sent in clear on the wire in 1.1: `AUTH` becomes a challenge — the server
  sends `NONCE <hex>` on connect, the client answers `AUTH-PROOF <hex>` = HMAC-SHA256(token, nonce + client name). Plain
  `AUTH <token>` stays accepted only on loopback. HTTP keeps `X-Patterns-Token` (local network, behind the bind
  address).
- **AGMessage**: holds the Stagewatch key encrypted at rest (Windows DPAPI where available, else AES with a machine key
  file outside `data/`), sends it in a header — never `?pin=` in a WebSocket URL — and asks for a `node`-scope key.
  It reads Stagewatch's `/ws` as itself: `?node=<its id>&t=messenger&cid=<its id>`, each key once (Stagewatch keeps the
  last value of a repeated key), the id from its hello and context — never a shared name, a per-hall id or a secret.
  It is linked only once Stagewatch accepted the key (2.18's first `{"type":"auth","ok":true}` on the socket, or a 200
  to an authenticated read on 2.16, whose frames go to any key); a refused key is asked again only after a minute.
  A Patterns' or PlayMap's pairing token it holds the same way, and sends only to a loopback address or over TLS to a
  certificate pinned for that node or confirmed by a person (at least 16 characters of its fingerprint typed); it never
  drives them with it — its lines are proposals (§11) — until they issue it a scoped key.

## 8. What each node publishes and consumes

| | publishes | consumes |
|---|---|---|
| **Stagewatch** (`main`) | hello; `/ws` frames (`v`,`seq`); receipts; `/api/context`; pong with times | Patterns STATE + context (clip end, `seq` re-sync, Eye headline); AGMessage context (action prompts, room) via `POST /api/peers/context`; Slides agents |
| **Patterns** (`patterns`) | hello; wire STATE; receipts `@id`; `CONTEXT` + `/api/context` (the Eye's headline, problems, programme) | Stagewatch frames (its stage timer page follows Stagewatch when one is linked) and context (drawn on the Eye) |
| **AGMessage** (`messenger`) | hello; `/api/context` (room, counts, action-prompt titles — no content); posts its context to Stagewatch | Stagewatch frames (timer, message ack by message id, VT) and context |
| **Slides agent** (`agent`) | hello; slide feed (already `seq`'d) | — |

## 9. With and without AI

| Works with no internet and no AI | Needs the internet |
|---|---|
| Discovery, links, commands, receipts, state, clock offset, liveness | Claude: copilot plans, the assistant's cloud advice, drafting messages and recaps, ASK in the Eye |
| Every node's context, lights and headline; the Eye drawing every node and device | AGMessage's Cloudflare tunnel (people off-site) |
| Rule-based advice (Stagewatch's advisor, Patterns' Super Check), problems queues, triggers | Time from pool.ntp.org (the LAN clock offset still works) |
| Cross-app automation: clip end → next item, ALL GO → lights, action prompt → producer | |

With AI available, each app's assistant gets its own context **plus its peers' contexts** in its brief, under the same
rule as the Eye: the facts are evidence, unknown stays unknown, verbs are proposed and a human approves.

## 10. Encrypted connections (1.2)

Show data and keys cross the local network; from 1.2 every web endpoint can be reached over TLS.

- **One certificate per install.** On first run each node makes a self-signed certificate (ECDSA P-256, five years;
  subject = the node's name; SANs = the host name, `localhost` and the machine's LAN addresses at the time) and keeps
  its private key protected at rest (Windows DPAPI where available). It is never copied between machines.
- **Its fingerprint is public.** The hello carries `"tls":"sha256:<64 hex>"` (SHA-256 of the certificate's DER) and
  `ports.https`. Stagewatch serves HTTP and HTTPS **on the same port** (9924: a connection whose first byte is a TLS
  handshake is TLS); Patterns and AGMessage may use the same trick or a second port, as `ports.https` says.
- **App-to-app: pinned, not trusted by name.** A client that connects to another node over TLS checks the server's
  certificate fingerprint, never its name or a certificate authority: the fingerprint from the node's hello (or typed by
  the operator) is pinned per node id on first successful authenticated use — for a Stagewatch link, Stagewatch accepting
  the key (its auth message, or a 200 to an authenticated read; frames are not, since Stagewatch sends them to anyone
  when no viewing code is set, and a link without a key never pins) — and a later change is refused with
  "CERTIFICATE CHANGED" until the operator accepts it (as SSH does). The hello is unauthenticated, so the pin — not the
  hello — is the trust. AGMessage's links to a Patterns or PlayMap on another machine trust no hello and no first use: the
  certificate is pinned only once a person types the start of its fingerprint from the node's own screen (§7).
- **Browsers.** A self-signed certificate shows a browser warning. Each node serves `GET /tls` (a page with the
  fingerprint, how to trust it on Windows, macOS, iOS and Android) and `GET /tls.cer` (the certificate, DER), so a show
  laptop's screens can trust it once. Plain HTTP keeps working unless the operator turns on **Require HTTPS**, which
  refuses plain HTTP and plain WebSockets from anything but this machine (loopback).
- **Line protocols.** Patterns' wire (TCP 9697) and Stagewatch's Companion port (9923) may offer `STARTTLS` (answered
  `OK STARTTLS`, then the TLS handshake on the same socket, pinned as above). Pairing by proof (§7) already keeps tokens
  off the wire; TLS adds privacy for show data.

## 11. The shared approval queue (1.2)

Every app's AI proposes; a human approves — in **one place**. When a node with the `approvals` cap is on the bus (a
Stagewatch: the show caller's desk), the other apps send their AI's proposals there instead of keeping their own queues.
With no desk on the bus, each app approves its own (as in 1.1).

- **A proposal** names who proposes and which node is to act, in that node's own grammar:
  `POST /api/proposals` (a `node`, `mcp` or `control` key, or the PIN)
  `{"from":{"t":"patterns","id":"9f8e7d6c","name":"Patterns FOH"},"target":{"t":"patterns","id":"9f8e7d6c"},"line":"EYE FOCUS screen 2",
  "reason":"Projector 1 is on the wrong mode","risk":"review"}` → `{"id":"p17","state":"pending"}`.
  Target `{"t":"main"}` (or the desk's own id) means the desk itself.
- **Risk is the target's call.** The desk uses the risk the target lists for that verb in its context's `commands`
  (§6); the desk's own verbs use its own rules; anything unknown is `high` — never pre-ticked, always shown in red.
- **States:** `pending` → `approved` / `rejected` (by whom, when) → for an approved one: `done` / `failed` (with the
  target's receipt words) or `undelivered` (the target didn't collect it within 60 s). `GET /api/proposals/<id>` reads
  one; `GET /api/proposals?from=<node id>` the proposer's own.
- **Delivery is by the target, pulled:** each node polls `GET /api/proposals?target=<its id>&state=approved` (its `node`
  key; a key is bound to the node id it first posted its context under, so it can only collect its own), runs the line
  through its own command path — its own checks and fences still apply — and reports
  `POST /api/proposals/<id>/result {"ok":true,"words":"…"}`. The desk never holds another app's credentials. The desk
  runs proposals aimed at itself directly, with a receipt.
- **What the desk answers** (Stagewatch 2.16): a collect hands each approved proposal over once and never lists it
  again; a result is due within 5 minutes of the collect, after which the proposal is `undelivered` — and a result for
  it is still taken. The result endpoint answers 200 when taken; 400 for a body that is not `{"ok":bool,"words":…}`; 409
  for every refusal (`no such proposal`, `this key speaks for another node`, `proposal pN is <state>`); 401 and 403 for
  the key; 429 with `Retry-After` past the key's 600 requests a minute (every route spends them). `GET` of an unknown id
  answers 404, as does a Stagewatch with no desk. The queue and its numbers live in memory: a restarted desk numbers from
  `p1` again, so a target reads a proposal back (its line, its target, its `created`) before it reports again.
- **Everything is journalled** on the desk (asked, approved or rejected by whom, the result) and each target journals
  what it ran, so the report shows what each AI suggested, who decided and what happened.
- **Offline:** the queue is plain LAN traffic; it works with no internet (proposals made by a person's own rules, or
  by an AI earlier, still queue and run).
