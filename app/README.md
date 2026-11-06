# AGMessage — the server

This folder is the server and its pages: `server.js` (run by the watchdog `supervise.js`), `lib/` (one concern per
file), `public/` (plain scripts, no build step), `verify/` (the audit log's rules that need no key, and the verifier an
export carries to another computer: `node verify/verify-audit.js <folder> --fingerprint <key>`, or its page) and
`test/`. Node.js 24 LTS.

```
npm ci
npm start            # the watchdog and the server on http://localhost:3023 (PORT to change it)
npm run dev          # the server alone
npm run check        # the analyzers, the secret scan, every test under the coverage gate
npm run smoke        # the browser smoke (AGM_BROWSER=<path to Chrome, Edge or Chromium>)
```

`AGM_DATA_DIR` moves the data folder (the tests use a throwaway one; one server per folder, a second is refused) and
`AGM_UPLOAD_DIR` the uploads; `AGM_UPLOAD_MIN_FREE` (bytes, default 1 GiB) is the free disk below which files pause;
`AGM_UPLOAD_ORPHAN_MS` (default an hour) how long an upload nobody posted is kept; `AGM_PUSH_LINE_MS` (default a minute)
how long after a push its line may go to the speaker's screen with it; `AGM_TLS=0` turns HTTPS off;
`ANTHROPIC_API_KEY` turns AI drafts on without the admin page; `AGM_OPEN=1` (set by `start-agmessage.bat`) opens the
browser on Windows once the first start serves, in the portable channel only (`AGM_RUNS` unset or `portable`), on
`/admin` when the audit log asks the person at the laptop. `AGM_KEY_DIR` moves the key folder (the machine key, the
certificate and the audit log's records; the tests use a throwaway one), and the black window then names it.
`AGM_SESSION_SWEEP_MS`, `AGM_OLD_CACHE_MS` (how long after a start 0.5.1's pages are told to reload; 5 minutes, 0.5.1's
cache life), `AGM_LEAVE_GRACE_MS` (how long a page that went may come back before "left" is said; 8 s) and
`AGM_NODES=0` are for tests.

What it does and how to run it at an event: [../README.md](../README.md) and the portable guide
[../README.txt](../README.txt). Accounts and rights: [../docs/ACCOUNTS.md](../docs/ACCOUNTS.md). Screens:
[../docs/DISPLAYS.md](../docs/DISPLAYS.md). The show network: [../docs/NODES.md](../docs/NODES.md). The fences:
[../docs/ANALYSIS.md](../docs/ANALYSIS.md). Working on the tree: [../CLAUDE.md](../CLAUDE.md).
