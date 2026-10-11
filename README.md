# AGMessage

Private messaging for AGMs and board meetings: the directors on stage and the research team backstage, on any phone,
tablet or laptop on the venue network (or remotely through the built-in Cloudflare tunnel). One portable Windows
folder, no install.

- **Board, research, observer** roles; action prompts with tap-to-answer buttons; documents (PDF, Word, Excel,
  images) pushed straight onto the directors' "On stage" panel; pins, replies, reactions, priority, seen receipts.
- **Built for live events:** every change is numbered and written to an append-only log, so a phone that drops off the
  Wi-Fi catches up with just what it missed, and a crash or power cut loses nothing. A watchdog restarts the server
  after a crash or a hang (heartbeat), with backoff, and the admin page shows why; saves are crash-safe and saved keys
  are encrypted with a key kept outside the folder.
- **Secure by default:** server-issued identities, optional invite-only roles, allow-listed uploads checked by content,
  a strict Content-Security-Policy, rate limits and lockouts, admin only on the host laptop.
- **AI drafts (optional, Claude):** answers for the research team from the thread and the document on stage, buttons
  for action prompts, and the minutes — always a draft a person edits and sends.
- **Show network (Show Bus 1.2, [docs/SHOWBUS.md](docs/SHOWBUS.md), [docs/NODES.md](docs/NODES.md)):** links to
  [Stagewatch](https://github.com/jammin808/Stagewatch) for the live stage timer and "send to the speaker's confidence
  monitor" with receipts and the speaker's acknowledgement on the message; or proposes it to Stagewatch's show desk for
  the show caller to approve; finds Stagewatch, Patterns and presenter PCs on the network; shares a privacy-safe status
  (`/api/context`) with other show systems and their AI. Everything but the AI drafts works offline.
- **Encrypted connections:** HTTPS on the same port with the app's own certificate (`/tls` says how to trust it once
  per device), an optional "Require HTTPS", and a pinned, encrypted link to Stagewatch.

## Run it

Download the portable zip from a release (or a CI run's artifacts), unzip, double-click `start-agmessage.bat`.
Full instructions: [README.txt](README.txt).

## Develop

```
powershell -ExecutionPolicy Bypass -File tools\fetch-runtime.ps1   # Node + cloudflared, pinned and checksum-verified
cd app
npm ci
npm test          # unit, watchdog and end-to-end tests (a real server on a throwaway data folder)
npm run smoke     # browser smoke test in headless Microsoft Edge
```

`tools\build-portable.ps1` builds `dist\AGMessage-Portable-Windows-<version>.zip`. CI (GitHub Actions) runs the tests
and the smoke test and builds the zip on every push; a `v*` tag publishes a release.

Meeting data (`app/data`, `app/uploads`) is never committed or packaged. Changes: [CHANGELOG.md](CHANGELOG.md).
