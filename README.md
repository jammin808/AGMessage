# AGMessage

Messages, files and screens for every hall of a live event — the crew in each operating room, the project managers
who look after every hall, the presenters and board members on stage — on any phone, tablet or laptop on the venue
network (or remotely through the built-in Cloudflare tunnel). One portable Windows folder, no install. Part of the
show network with [Stagewatch](https://github.com/jammin808/Stagewatch), Patterns and PlayMap.

- **Halls.** Each hall has its own message room and, if it has one, its own Stagewatch: its countdown in the header,
  sends to its speaker's screen. The **halls board** shows every hall an account may see — countdown, who is in, the
  last message, open help requests, its screens and its Patterns / PlayMap — live. **Help requests** (Sound, Vision,
  Lighting, Stage, Presenter, IT) stay red until someone is on the way and on the board until resolved.
- **Accounts and codes.** Crew, project managers and admins sign in as themselves; presenters and guests join with a
  hall's 6-character code. Roles (admin, project manager, senior tech, tech, staff, viewer), halls per person, and
  single rights an admin can add or remove. A hash-chained **audit log** of every sign-in, change of rights and screen.
  [docs/ACCOUNTS.md](docs/ACCOUNTS.md)
- **Screens.** Every hall's screens — projector PC, lectern monitor, foyer TV — each with its own link to open in any
  browser: holding image, a message (note / soon / urgent), an image or PDF page from the hall, the hall's countdown
  with a message under it (the speaker's comfort monitor), the clock, or black. Each screen confirms what it showed.
  [docs/DISPLAYS.md](docs/DISPLAYS.md)
- **Messages that land.** Action prompts with tap-to-answer buttons; documents (PDF, Word, Excel, images) shared and
  pushed to the on-stage panel or to screens; pins, replies, reactions, priority, seen receipts. Every change is
  numbered and written to an append-only log: a phone that drops off the Wi-Fi catches up with just what it missed,
  and a crash or power cut loses nothing. A watchdog restarts the server after a crash or a hang.
- **The show network (Show Bus 1.2).** Send to Stagewatch — straight to the speaker's screen, or to the operator to
  approve and pass on to the confidence monitor, a moderator, backstage or interpreter screen, a department, or keep.
  Patterns and PlayMap linked: their state on the board, and the verbs they list sent or proposed to the show desk.
  [docs/NODES.md](docs/NODES.md)
- **AI drafts (optional, Claude).** Answers for the backstage team from the thread and the document on stage, buttons
  for action prompts, the minutes — always a draft a person edits and sends. Everything else works offline.
- **Secure by default.** Encrypted connections (HTTPS on the same port, `/tls` to trust it), pinned links between show
  systems, sealed keys, a strict Content-Security-Policy, uploads checked by content, rate limits and lockouts.
  [SECURITY.md](SECURITY.md) · [docs/DESIGN.md](docs/DESIGN.md)

## Run it

Download the portable zip from a release (or a CI run's artifacts), unzip, double-click `start-agmessage.bat`, and open
`http://localhost:3023` on that laptop to make the first admin account. Full instructions: [README.txt](README.txt).

## Versions

One scheme for every build (`app/lib/version.js`): `app/package.json` names the version, CI stamps the build number and
commit. A release reads `0.5.0+17.abc1234`, a CI development build `0.5.0-dev.17+abc1234`, a local copy
`0.5.0-dev+abc1234`. The console window, `/api/health`, the admin page and the Show Bus hello say which build runs; the
zip is named by it. A tag `vX.Y.Z` publishes a release only when it names `app/package.json`'s version. Changes:
[CHANGELOG.md](CHANGELOG.md).

## Develop

Node.js 24 LTS (`app/package.json` → `engines`).

```
powershell -ExecutionPolicy Bypass -File tools\fetch-runtime.ps1   # Node 24 + cloudflared, pinned and checksum-verified
cd app
npm ci
npm run check     # the analyzers, the secret scan, every test with the coverage gate
npm test          # the tests alone (a real server on a throwaway data folder for the end-to-end ones)
npm run smoke     # the browser smoke: Edge, Chrome or Chromium (AGM_BROWSER=<path>)
npm run audit     # the shipped packages' advisories and registry signatures
```

The analyzers are fences: ESLint with the security rules, a banned-call list and a rule that refuses unescaped values
on their way into a page's HTML ([docs/ANALYSIS.md](docs/ANALYSIS.md)). CI runs them, the tests on Linux (Node 24 and
26) and Windows, the browser smoke on both, CodeQL and the dependency audit; it builds the stamped zip with its SBOM
and SHA256SUMS on every push, and a `v*` tag publishes a release with a build-provenance attestation.
`tools\build-portable.ps1` builds the zip locally.

Meeting data (`app/data`, `app/uploads`) is never committed or packaged. The agent brief for working on this tree is
[CLAUDE.md](CLAUDE.md).
