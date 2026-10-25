# AGMessage — the server

This folder is the server and its pages: `server.js` (run by the watchdog `supervise.js`), `lib/` (one concern per
file), `public/` (plain scripts, no build step) and `test/`. Node.js 24 LTS.

```
npm ci
npm start            # the watchdog and the server on http://localhost:3023 (PORT to change it)
npm run dev          # the server alone
npm run check        # the analyzers, the secret scan, every test under the coverage gate
npm run smoke        # the browser smoke (AGM_BROWSER=<path to Chrome, Edge or Chromium>)
```

`AGM_DATA_DIR` moves the data folder (the tests use a throwaway one; one server per folder, a second is refused) and
`AGM_UPLOAD_DIR` the uploads; `AGM_UPLOAD_MIN_FREE` (bytes, default 1 GiB) is the free disk below which files pause;
`AGM_UPLOAD_ORPHAN_MS` (default an hour) how long an upload nobody posted is kept; `AGM_TLS=0` turns HTTPS off;
`ANTHROPIC_API_KEY` turns AI drafts on without the admin page. `AGM_SESSION_SWEEP_MS` and `AGM_NODES=0` are for tests.

What it does and how to run it at an event: [../README.md](../README.md) and the portable guide
[../README.txt](../README.txt). Accounts and rights: [../docs/ACCOUNTS.md](../docs/ACCOUNTS.md). Screens:
[../docs/DISPLAYS.md](../docs/DISPLAYS.md). The show network: [../docs/NODES.md](../docs/NODES.md). The fences:
[../docs/ANALYSIS.md](../docs/ANALYSIS.md). Working on the tree: [../CLAUDE.md](../CLAUDE.md).
