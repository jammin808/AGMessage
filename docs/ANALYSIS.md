# Static analysis, security checks and tests — AGMessage's fences

*0.5.0. The question: what testing environment does AGMessage need, in the same vein as PlayMap and Stagewatch, for a
Node server that runs a live event? The answer is the one Patterns reached in its round 70 and PlayMap inherited: the
analyzers run on every build as **fences** — a named set of rules that stop the build, each with its reason — plus a
banned-call list, a secret scan, CodeQL, a dependency audit with registry signatures, a coverage gate and the browser
smoke on two operating systems. This paper has the baseline counted before anything was fixed, the rules judged and
left out, and the defects the fences found.*

## 1. What runs, and where

| Check | Command | CI job | Fails the build on |
|---|---|---|---|
| ESLint 10 + `eslint-plugin-security` 4 + one house rule | `npm run lint` (in `app/`) | CI · analyze | any finding (§3) |
| Secret scan | `node tools/scan-secrets.js` | CI · analyze | a key, token or private key in a tracked file |
| Version | `node tools/stamp-build.js --print` / `--check-tag <tag> --released <tags> --tags <tags>` | CI · analyze, and again as the release job's first step (one release job at a time) | a release tag that names another version, or a version not above every release already published (`gh release list`) and every other version tagged (the repository's `v` tags): a list that cannot be read, or a tag that names no version, stops it too. `test/version.test.js` holds the release job to its check before anything is attested or published |
| Unit, end-to-end, watchdog, TLS, version, lint-rule tests | `npm test` | CI · Linux (Node 24, 26), Windows | any failure |
| Coverage gate | `npm run coverage` | CI · Linux (Node 24) | lines < 95 %, branches < 84 %, functions < 91 % of `server.js`, `supervise.js`, `launch.js`, `lib/`, `verify/` |
| Browser smoke | `npm run smoke` | CI · Linux (Chrome), Windows (Edge) | a page that does not join, render, or that logs a script error or a CSP violation; a PDF or a Word file the Board's panel does not draw, or a deck a screen does not, in a browser without `Promise.withResolvers` in the page or in pdf.js's worker (as an iPad before 17.4), or a PDF drawn without the worker file defining it in the worker itself (pdf.js's fallback in the page); the hall page wider than a 390 px phone with a touch screen for any seat, a dialog's button off that screen or under something else, Send under 44 px there or not named for where it sends, an icon button under 24 px or under 3:1 or a presence line under 4.5:1 or either faded in either theme, the On stage tag dark in light mode, Help at rest with red in its fill, words or edge, or its words under 4.5:1 or its edge under 3:1, 🔥 Priority not on the fault red while pressed (or on it while not) in either theme, ✨ hidden or usable with AI drafts off, or pressed then without its reason or asking the server, a new message filled or animated, a new message moving a feed scrolled up by 10, or (the divider above the view) moving it by more than a pixel with scroll anchoring or without it, a page back from a drop moving the feed or reading its layout per message it missed, or an untouched page's New divider gone after 30 s; help, tapped on that phone, not in two taps: the dialog opened without its heading focused, with a category chosen for the person or without `enterkeyhint="done"`, Enter in its words sending or not moving to the categories, a category's tap not sending at once with the words, or the page sending another word than the category tapped ("Something else" as anything but `Other`, read on the page's own socket before the server reads it); the Help chip not reading "■ Help asked" (on the fault red), "▶ Pat is on the way" after another page's On my way, "✓ Resolved", and Help again 30 s later, or its change not said to a screen reader; its ask not in place right after the chip (`role=dialog`, not modal), not naming the request and what each answer does, its buttons off the screen or under 44 px, Keep it open not focused, Escape or Tab on to the header's next control not closing it and keeping the request, Cancel request not deleting it for the hall, or It's sorted not resolving it as the asker's; a refused help request changing Help, or its Edit not bringing its words back to the dialog with no category chosen, or a tap then sending it other than once as that category; an On stage page offering ↗ on any message, or a composer holding more than its words, 🔥, Send and its ⋯ (Send, Priority, and Cancel the reply while it replies), or drawing On my way or Resolved on someone else's help request or anything but Resolved on its own, or that Resolved not marking its request resolved as the Board member's, or a backstage page not drawing both on the Board member's request; an old word ("session", "meeting", "director", or "research" alone or in "research team") in the chrome of any of the 13 pages it reads — the hall page On stage and Backstage on a laptop and On stage, Backstage and Observer on a phone, the hall page opened by an account and by a Viewer account, the admin's support view, the sign-in and join page, the halls board, the Accounts page, a screen and the admin page watching a hall — its hidden panes, dialogs, templates, the rows, buttons and selects its script builds, titles, placeholders and labels included, and only what people wrote or named (a message's words and sender, names in a list or a row, help requests' words, halls' names, a document), what happened (the feeds' lines, the audit log's rows) and what another show system said (Stagewatch's context, the show network) left out: a planted word in a closed dialog, a title, a message's own button and a button in the admin's people row is found, and one in the feed's history, a message's words, a sender's name, a person's name and the admin feed's lines is not; a seat named other than On stage, Backstage or Observer on the admin page; the copy deck's words not where the plan puts them (the admin page and its show desk line, the hall page, the join page, the halls board's "1 needs help" and "2 need help", the Accounts page's rights); or a page sent out of its hall or refused at its join without the server's words in place of the hall and Back to sign-in, still offering a dialog, the Help chip's ask, a button of the hall or a chip that opens a menu, or gone by itself within 3 s; on the hall page, an object (a sender's name, a row of People, the composer's Send, the stage chip, the code chip) whose right-click, click or ⋯ and Shift+F10 do not open the catalogue's set or whose bar is not in its menu, a chip or a sender's name under 24 px, or those doors and the composer's ⋯ under 44 px on a phone under a finger, 🔥 Priority not a checked toggle in the composer's menu, the message box not keeping the browser's own menu, Mention not putting the name in the message box, a ⋯ pressed again under an ask it opened leaving the ask open, more than one toast or one that is not a `role=status` region, a skip link that is not the page's first Tab or does not reach the message box (Skip to messages for an observer), a feed that is more than one Tab stop, that ↑ from the empty message box does not reach the newest message and the one before it, or whose Shift+F10 does not open that message's menu or whose Escape does not go back to the box, an observer's question drawn as buttons instead of its options in words with the tally, Speaker's screen… not opening the line box empty, Show the countdown on screens not reaching the hall's screens, Copy join link not copying the join page's link with the code, or, at the floor, Help not opening through the fallback dialog or the Help chip's ask not opening in place; on the admin page, the halls board or the Accounts page, an object (a hall in the admin list and the watched hall's header, a person, a message of the live feed, the internet link's card, "This laptop", a linked Patterns, a hall's row, a help request, an account, an entry of the audit log) whose right-click, ⋯ and Shift+F10 do not open the catalogue's set or whose bar is not in its menu, an ask not named for its object or whose "no" changes something, the admin's Logout, theme or New hall covered at 1440, 1024 or 390 px, a skip link that is not the page's first Tab or does not move the focus to its list, a list that is more than one Tab stop or that ↓ does not move through, a hall's row with another link than its name or whose name's middle click opens no tab, a locked account row whose Edit does not say why on its button, in its menu and when chosen, or that asks the server anything, a disabled act (Check again on an internet link that is off) that does not say why on its button, in its menu and when chosen, or that emits, the audit log not kept to one actor or not given back by Show all, any of the three pages' bars under 24 px, their icons under 3:1, their words under 4.5:1, faded, or their menus' words under 4.5:1 in either theme, or their acts and ⋯ under 44 px on a phone under a finger, or the admin page's socket dropped while the node form is open 30 s; "This laptop" missing a fact, a fact without its words or where it was read, a mark without its shape, a Windows fact read off Windows, or Refresh not reading again; and a native `alert`, `confirm` or `prompt` on any page |
| CodeQL `security-extended` | — | Security · codeql | an alert (shown under the repository's Security tab) |
| Dependency audit | `npm run audit` (`npm audit`, then `tools/vendor-audit.js`) | Security · audit (and weekly) | a high or critical advisory in a shipped package; a package whose registry signature or provenance does not verify; a high or critical advisory against a version `app/public/vendor/VENDOR.json` lists (a vendored file's package or a library bundled in it) that `VENDOR.json` does not assess, or assesses at another severity, or a registry that does not answer |
| Dependency review | — | Security · on a pull request | a new dependency with a moderate or worse advisory |
| The .bat files | `npm test` (`test/startbat.test.js`) | CI · Linux (read as text), Windows (run by cmd) | delayed expansion, a bare program name, the install record read outside the 64-bit view, the preflight after anything started, code 0 and 3 sharing words, a line ending that is not CRLF; on Windows, a missing `node\node.exe` not said or not exit 2, a clean copy made into a folder that exists |
| The module fence | `npm test` (`test/modules.test.js`; health's lane counts in `test/server.test.js`) | CI · Linux (Node 24, 26), Windows | a breach of the server's layers (a pure module that requires anything but the pure core, names an I/O built-in, reads `process.` or imports at run time; a require of `server.js`; a cycle; a require of the HTTP domain or a handler module from anywhere but `server.js`; a require of a file that is not there); a handler module that requires past its row (a built-in, a package, a store or an edge, guard whole or past its pure helpers), reaches past a literal require (`import()`, `process`, the module loader, the global object), makes (`new`) what it requires, or reads its context but once, destructured first in its `register`; a verb in one that does not start with its one gate (`if (!conn.gate(ack, {…})) return;`) answering its own acknowledgement and naming one of the connection's buckets, or says `bucket: null` without why; the takes module naming a room or a broadcast (`io`, `.to(`, `.in(`, `.broadcast`, `.nsp`, `.server`, `.except(`), joining its socket to a room, reaching the room store but through its readers or asking its context for a room or a room's op (`apply`, `systemMessage`, `newSideRoom`, `renameRoom`, `sendGuestsOut`, `codeChanged`), and any handler module asking `rbac.can` under any name, naming `sendTo` but to call it, or writing into `settings` (a method that is not a read included); a new verb registered in `server.js`; `conn` made before a helper it holds, `ctx` before a part it names, or the contexts handed anything but the parts; a wire's word left open (a page send no handler file registers, a verb no page sends, an event no page hears or a listener for one never sent, each exception a row with its reason); a verb registered where or how the fuzz does not read it; the op table out of step (the hall page's against `lib/ops.js`'s, a change to a message of a field outside it, or an op given to `apply()` written so it cannot be read); a write lane made that `saveLanes()` does not name once; a reader of any room (a hall's side rooms too) without its reason (§3.5) |
| The busy line | `npm test` (`test/busy.test.js`; R1's pace in `test/readings.test.js`) | CI · Linux (Node 24, 26), Windows | a socket verb that is neither a person's input nor a page's own read, or is both; a verb a page holds for its person that is not input; a key in the busy line that is not one of its seven counts; reading R1's reconnection pace other than the hall page's own (`public/reconnect.js` `OPTIONS`) |
| What AGMessage loads and runs | `npm test` (`test/loads.test.js`, with `test/resolve-preload.js`) | CI · Linux (Node 24, 26), Windows | a module the watchdog or its server loads from outside `app`, one the portable folder does not ship or the lockfile lists for development only, one asked for that `app` cannot answer, a planted module run; the same of what the shipped scripts' source asks for, followed through every file it reaches, but an ask the register names as never made and a require whose name is made at run time with its row; a call in `app` that starts a program by a bare or relative name, or by an expression the register does not hold, fork's `execPath` named so, a shell; `child_process`, or a function of it that starts one, handed on where no row says, or `child_process` named where the fence does not follow it; a `launch.js` or `machine.js` require that is not a `node:` built-in, or `require` reached another way (§3.7) |
| The stylesheet's tokens | `npm test` (`test/resilience.test.js`) | CI · Linux (Node 24, 26), Windows | a second `:root` or dark token block; more hex colours outside the two than the count (275, only going down); an opacity between 0 and 1 anywhere in `styles.css`, as a number, a percentage or a filter's `opacity()`, or one written so the guard cannot read it (`var()`, `calc()`) (§3.4) |
| The page floor (Safari 14.1, Chrome 84; `docs/DEVICES.md`) | `npm run lint`, `npm test` (`test/lint-rules.test.js`, `test/resilience.test.js`, `test/pagefloor.test.js`) | CI · analyze, Linux (Node 24, 26), Windows | a bare `requestIdleCallback` or `cancelIdleCallback`, a `requestSubmit()` not behind its probe, or a read of the user agent however it is reached (`window.navigator.userAgent`, `userAgentData`, a computed key, a destructuring), in a page script; a syntax newer than ES5 in `theme-init.js`; a `.showModal(` outside `common.js`'s `AGM.openDialog`, or a hall page or admin page that does not load `common.js` before its own script; a feature of `styles.css` above the floor without its fallback; a page with people that does not load `theme-init.js` first, a screen's page that does, or a script of a page with people that does not stop below the floor before it first asks the server anything or opens a socket (but the four named that only define at load); below the floor, a form that is sent |
| The bundle start | — | CI · package | a zip that does not hold one folder, `AGMessage`, at its top; the extracted zip's own Node and watchdog not answering `/api/health` with the stamped build within 30 s |
| Windows' line ends and ports in the tests | `npm run lint` (`agm/test-helpers`, `app/eslint-rules/test-helpers.js`; its cases in `test/lint-rules.test.js`), and `npm test` on a CR LF checkout | CI · analyze, and CI · test-crlf (Linux, Node 24) | a test that reads a file of the checkout as text but through `readSource` (a path naming `__dirname`, `ROOT`, `REPO` or `APP`); a port picker (`free…Port`, `pick…Port`, `find…Port`) outside `test/helpers.js`; any suite that fails with the tree checked out again with CR LF line ends (the vendored files left byte for byte), before the Windows job runs |
| The zip's paths | `node tools/zip-paths.js <bundle.zip>` (`test/zippaths.test.js` holds the check, the clean copy's name to `make-shareable-copy.bat`, and the step) | CI · package, the step after the build | a file whose path reaches 260 characters, or a folder's 248, once Extract All lays the zip under `C:\Users\<20 characters>\Downloads\<the zip's name>\` (MAX_PATH, which Explorer is held to), in its folder `AGMessage` or in a clean copy beside it under the longest name the .bat gives one; a zip it cannot read, or a member named outside its folder. It measures the zip downloaded on its own (a release's, or a CI run's moved out of GitHub's artifact zip, as `README.txt` says), not a profile folder Windows renamed `<name>.<COMPUTERNAME>` |
| The Windows readings (the evidence lane) | `tools/defender-on.ps1`, then `node tools/readings-take.js take …` and `node tools/readings.js judge …` | CI · readings (every push, a `v*` tag, a run asked for by hand; one at a time per ref, never cancelled once it runs; `windows-2025`, every action pinned by its commit), its notes in CI · release | never on a reading, which informs the release and never holds it (a miss is written in the job's summary, its artifact and the release's notes); only on a lane that cannot write or judge its record. `test/readings.test.js` (CI · Linux, Windows) fails on: a reading's words, mark or miss not the plan's U7 table's, a lab line's not the plan's line, or `docs/INSTALL.md`'s not the register's (its Measured and Taken cells a run's record or "not measured" and "not run"); a reading still waiting for a unit whose code is in the tree; a reading met with nothing measured, without Defender on (real-time monitoring and scanning on access, in its Normal mode, neither drive excluded) where its mark needs it, or, for R4, with health answering a build that is not the bundle's; an R10 round counted that did not run to exit 0; an R12 exit 0 watched on the task that exited 1; notes that fail on a file that is not the lane's verdicts; the lane's job not on `windows-2025`, an action in it not pinned by a commit, its checkout keeping a credential, Defender not its first step, a step without its own bound or the steps' bounds past the job's, the GitHub list able to stop it, its readings not kept when it fails, or the release held by it or published without its notes; `take` touching a machine that is not a GitHub-hosted runner, a work folder it did not make, or a `\AGMessage\Server` it did not make |
| The vendored libraries | `npm test` (`test/vendor.test.js`) | CI · Linux, Windows | a file in `app/public/vendor` not in `VENDOR.json`, a listed file missing, bytes that are not its SHA-256, an entry with no licence, notice or copyright, a licence not on the allowed list (Apache-2.0, MIT, BSD-2-Clause, BSD-3-Clause, MIT AND Zlib, MIT OR GPL-3.0-or-later taken as MIT), a `licenses/` folder whose text is not the licence named or lacks the copyright, a folder no entry claims, a listed file no page loads or a page loading one not listed, a `THIRD-PARTY-NOTICES.md` table that is not the list or that leaves out an advisory, an advisory with no assessment or an assessment that applies without saying what bounds it, a version inside jszip's bundle without where it was read, pako not 1.0.5 by its code, a BSD-3-Clause text filed as BSD-2-Clause, a paper that says which browsers draw a PDF without the floor, the portable build, the SBOM step, `npm run audit` or the Security workflow without them; pdf.js not 4.10.38's legacy build, or not defining `Promise.withResolvers` where it is missing |
| SBOM + SHA256SUMS + build provenance | `node tools/vendor-sbom.js <sbom> --tree <bundle>` adds the vendored files, read from the bundle as the zip extracts it, to npm's SBOM, with each advisory's analysis | CI · package, release | a release is published only with them; a shipped vendored file whose bytes are not the ones `VENDOR.json` records, or a bundle without the checkout's `VENDOR.json`, `THIRD-PARTY-NOTICES.md` and every licence folder an entry names, stops the SBOM's step |

Locally: `npm run check` runs the analyzers, the secret scan and the tests with the coverage gate.

## 2. The baseline, counted

Every count is a distinct finding (file, line, rule) from one run over `app/` and `tools/` (the vendored pdf.js,
mammoth and SheetJS excluded) with **every** rule of `@eslint/js` recommended and `eslint-plugin-security` on, before
any fix.

| Rule | Findings | Judged |
|---|---:|---|
| `security/detect-non-literal-fs-filename` | 70 | **Left out.** Every hit is a path the server builds itself (data folder, room code checked by `RoomStore.validCode`, upload names checked by `guard.validUploadUrl`). The real defect class — a path from a request — is fenced where it enters (the upload name allow-list, the room-code shape). |
| `security/detect-object-injection` | 27 | **Left out.** Flags every `obj[key]`; the 27 are lookups in tables keyed by checked values (roles, upload types). Measured noise. |
| `no-restricted-syntax` (HTML sinks, a disabled TLS check) | 26 | **Replaced by `agm/no-unescaped-html`** (§3.3), which reads what reaches the sink: 25 of the 26 were already escaped. |
| `no-promise-executor-return` | 26 | **Adopted for the server, libraries and tools** (0 there); the 26 are tests' `new Promise((r) => setTimeout(r, n))`. |
| `no-undef` | 25 | **Adopted.** All in `admin-plus.js`, which shares `admin.js`'s script scope: now declared (`/* global socket, currentRoom */`). |
| `no-await-in-loop` | 22 | **Left out.** The two in the server are the show desk's poller, sequential on purpose (one request at a time to Stagewatch); the rest are tests' waits. |
| `no-unused-vars` | 11 | **Adopted.** Unused `catch (e)` bindings and leftovers. |
| `no-empty` | 5 | **Adopted, without `allowEmptyCatch`:** a swallowed error now says why in a comment. |
| `security/detect-non-literal-regexp` | 2 | **Adopted.** The server built its cookie reader from a pattern; it is a parser now (`guard.readCookie`). |
| `no-control-regex` | 2 | **Adopted.** Names and file names were stripped of C0 controls only; `guard.cleanText` drops C0, DEL, C1 **and the bidirectional overrides and isolates** (Trojan Source), so a display name cannot read differently from what it is. |
| `no-restricted-properties` (`Math.random`) | 1 | **Adopted.** The redial jitter now comes from `crypto.randomInt`. |
| `security/detect-unsafe-regex` | 1 | **Adopted.** One nested-repetition pattern, in a test. |
| `no-useless-escape`, `no-var`, `prefer-const` | 3 | **Adopted.** |
| every other rule of both sets | 0 | Adopted where listed in `eslint.config.mjs`. |

## 3. The fences

### 3.1 Correctness (`@eslint/js` recommended, plus)

The recommended set, and: `eqeqeq` (smart), `no-var`, `prefer-const`, `no-throw-literal`, `no-self-compare`,
`no-template-curly-in-string`, `no-unmodified-loop-condition`, `strict` (global, server side), `no-promise-executor-return`
(server side), and `no-empty` with no exception for catch blocks. Unused or unexplained disable comments fail too
(`reportUnusedDisableDirectives`), so a silenced rule says why on its line or the build stops. On every page script and
page module, `no-alert`: a native `alert`, `confirm` or `prompt` pauses the page's scripts, and a page paused 20 s drops
its socket (measured, the plan's 5-§16.1), so a question is asked in place (`AGM.ask`) and words go to the toast;
`test/lint-rules.test.js` plants each, called bare or on `window`, in the admin, halls, accounts and hall pages' scripts,
a new one and a module, and asserts the lint refuses it.

### 3.2 Security (`eslint-plugin-security`, and the house's banned calls)

`detect-eval-with-expression`, `detect-non-literal-require`, `detect-child-process`, `detect-unsafe-regex`,
`detect-non-literal-regexp`, `detect-buffer-noassert`, `detect-pseudoRandomBytes`, `detect-new-buffer`,
`detect-bidi-characters`, `detect-invisible-characters`, `detect-possible-timing-attacks`,
`detect-no-csrf-before-method-override`, `detect-disable-mustache-escape`; `no-eval`, `no-implied-eval`, `no-new-func`,
`no-script-url`, `no-proto`, `no-extend-native`, `no-caller`.

The banned calls, each with its reason in the config:

| Call | Why |
|---|---|
| `Math.random` | ids, tokens and jitter come from `node:crypto`: `Math.random` is predictable |
| `child_process.exec` / `execSync`, a bare `exec(…)` | a shell: `spawn` with an argument array, never a command line built from strings |
| `document.write` | markup unescaped |
| `rejectUnauthorized: false` | a certificate is pinned, never ignored — only the pin probe in `lib/tls.js` may read an unverified certificate, on its line, because it sends nothing |
| `process.env.NODE_TLS_REJECT_UNAUTHORIZED = …` | turning certificate checks off for the whole process is never the fix |
| `new Function` | eval |
| `process.exit` in `lib/` | a library never ends the process; `server.js` and `supervise.js` decide, and exit codes carry intent |

Programs are run by their absolute path, never a bare name, which cmd looks for in the current folder first and Node's
`spawn` (libuv) in the current folder and then on `PATH`, an argument array or not: the browser opener spawns
`%SystemRoot%\explorer.exe` with an argument array and no shell, inside the `child_process` fence (`lib/startup.js`),
and runs nothing when `SystemRoot` does not name a folder from its drive; "This laptop" and the power request run
`powershell.exe` the same way, Show the admin token `reg.exe` in the installer's `{sys}`, and the internet link this
copy's own `bin\cloudflared.exe`; the .bat files run `reg.exe`, `timeout.exe`, `robocopy.exe` and `powershell.exe` from
`%SystemRoot%\System32`. `test/startbat.test.js` holds the .bat files to it, with CRLF and ASCII throughout, and
`test/loads.test.js` every call in `app` that starts a program (§3.7).

### 3.3 `agm/no-unescaped-html` (the house rule, `app/eslint-rules/`)

A message, a name or a file name that reaches `innerHTML`, `outerHTML` or `insertAdjacentHTML` unescaped is script in
everyone's browser — the board's iPad included. The rule reads the value: it may be a literal, a call to an escaper
(`escapeHtml`, `sanitizeHtml`, `renderMessageText`, `esc`), a count (`.length`), or a name ending in `Html` (markup
built from escaped parts, said so by its name), joined with `+` or a template or chosen with `?:`/`||`/`??`. The sanitiser's
own parse into an inert `<template>` is the one silenced line. `test/lint-rules.test.js` holds the rule to both sides:
eight unsafe shapes refused, nine safe ones let through.

At the baseline the rule found six values not escaped where written: role names, a room code, socket ids, a reaction's
emoji and count, and a pinned file's icon. Each came from the server's own checked vocabulary, so none was exploitable
today; each is escaped now, so a later change to what the server sends cannot make one so.

### 3.4 The source guard rail (`test/resilience.test.js`)

Unchanged from 0.3 and still a fence: no `eval`, no key in a URL, and the synchronous file calls per file capped, each
with its reason (`lib/version.js` joins the list: the version and its stamp, read once at startup). `lib/audit.js` is
allowed 11 (an append cut back when the disk takes only part of it, the rotation; its check now reads asynchronously),
`lib/resilience.js` 10 (the temporary file of an atomic write that failed is removed, so it does not keep a full disk
full) and `server.js` 16 (removing files went asynchronous).

0.6.0 keys the audit log and keeps its records outside the data folder, at no new synchronous call in `lib/audit.js`
(still 11: the records are read once, at open, through the same read, and written through a lane and the atomic
writer) or in `lib/secretbox.js` (still 3: the machine key read once, or made once in a whole temporary file and
published by a hard link that never replaces one, then the temporary file removed). `lib/resilience.js` goes to 11 for
`placeId`'s one real-path read per place at start, and the guard's pattern now counts `fs.realpathSync.native(`, which
it did not see. A hall's snapshot copied to its backup unread, when the store knows it whole, adds none: the read it
skips and the copy are still the source's two calls, so `lib/resilience.js` stays at 11 and `lib/store.js` at 10, whose
reason now says where a change is when it is answered: appended to its log, in the system's file cache, or kept for the
next snapshot when the disk refuses the append. `verify/` joins the files read, at 0: the audit log's key-free rules
(`verify/auditrules.js`) are pure, and their own ESLint block turns off every Node global the shared block gives (so
`require`, `process`, `Buffer` or `console` there is an undefined name), gives no browser global, and refuses any use of
`module` but `module.exports` and any `import()`: a probe that reads a file there fails the lint.
`verify/` is under the coverage gate with `server.js`, `supervise.js` and `lib/`.

0.6.0's start rules (nothing written before the hold; a secret made only where there is none) move four caps, each with
its reason. `lib/resilience.js` goes to 13: `publishOnce`, the one way a file that must never be written over is made
(whole in a temporary file, then a hard link that refuses one already there), adds its link and the removal of its
temporary file; `readText`, the one read that tells a file not there (ENOENT) from one that could not be read, takes
`readJsonWhole`'s read, so it adds none. `lib/guard.js` (the server secret) and `lib/tls.js` (the certificate) go to 0,
off the list: their reads and writes go through `readText`, `publishOnce` and the atomic writer. `server.js` goes to 15:
its two folder makes at load are one, made once the folder is held, and the watchdog's marker is renamed then too.
`lib/secretbox.js` stays at 3; `lib/store.js` and `lib/audit.js` keep theirs (a store may now be built without making
its folder, and the audit log makes its folder at its first write, not when it is read).

The admin token said only where a person sits moves one timer and no cap. `supervise.js` stays at 3: the installed node's
token file, written once each time its server serves and asks for its banner's Token line, never on a request, goes
through `lib/resilience.js`'s atomic writer (whose `makeDir: false` never makes a folder another program makes), so it is
written whole and that file's count does not move either. Of the timers `server.js` starts (below), one is the Token
line's wait, 2 s for the watchdog to say it, once a start, which keeps no process alive (`unref`). `launch.js`, the installed node's
commands for the person at the PC, is under the server's ESLint block (strict mode) and the coverage gate, and requires
Node's own modules only.

What the console says, kept (the plan's U3), adds `lib/serverlog.js` at 4, with its reason: only the watchdog's process
runs it, never the server, and never on a request. A console line is appended to `server.log` as it is said, so a line
said just before the watchdog ends (a refusal's words, a give-up) is on disk; its folder is made and its size read once,
and it is renamed once it reaches its bound. `supervise.js` goes down from 3 to 2: its record of how it ended
(`watchdog.json`, a give-up or the installed node's refused start) goes through `lib/resilience.js`'s atomic writer, as
its token file does. `server.js` stays at 15: "This laptop"'s read of Windows is one `execFile` with its own `timeout`,
so it starts no timer in a handler file either, and the child is ended by a stop. `lib/laptop.js` runs `powershell.exe`
by its absolute path only (§3.7's fence holds it, `plan.file` in its register); its tests hold the path, the fixed
script (one line, no double quote, `powercfg.exe` by its absolute path, each part on a line of its own, the firewall
last, the firewall's own object asked, the NetSecurity cmdlets only under Constrained Language Mode, each module imported
by its manifest's path under `$PSHOME` before the part that uses it) and an
environment of named Windows folders only (`PASSED`), no secret, `PATH` or module path of the account's; on Windows (the
CI job) a test runs the script itself and holds its answer to its shape, saying when each part's line came. Every
PowerShell AGMessage runs (that script, the power request's in `lib/power.js`, the lane's in `tools/readings-take.js`, `tools/*.ps1`) names its functions,
filters and workflows Verb-Noun or `Agm…` and makes none through the Function: drive (`test/laptop.test.js`): PowerShell
runs an alias before a function of the same name, and Windows PowerShell's aliases are single words (`ac` is
Add-Content).

The data folder's format (the plan's U6) adds `lib/dataformat.js` at 8, with its reason: once a start, never on a
request. Its marker is read through `lib/resilience.js`'s `readText` (only ENOENT reads as none) and written through
the atomic writer, so neither is a call of its own. What it has of its own: the folder read through once to tell a new
folder from a 0.5 one (the watchdog's console and empty folders are no data), and, for a folder of a lower format, its
copy into `backups/`: a copy a stop left part way (`.partial-…`) removed, the folder's size and the disk's free space
read (the copy is refused when it would leave less than the uploads' reserve), the copies' folder made, a `.partial-…`
folder made, each entry copied (the watchdog's beat sent at most every 250 ms while it runs, so a long copy is never
taken for a hang), the whole copy renamed, or the partial copy removed when one failed. A folder of a higher format, or
a marker that cannot be read, stops the start in the watchdog and in the server before either writes anything, and
again once the server holds the folder. `server.js` stays at 15, `supervise.js` at 2 (the marker is read through
`lib/dataformat.js`), and `lib/version.js` at 8: "newer" (`compareBuilds`) and the release order (`releaseRefusal`)
are pure.

The watchdog telling a sleep from a hang (the plan's U9) moves no cap and no timer. `supervise.js` stays at 2: a sleep's
line goes through its own `log()`, which `watchdog.log` already takes, and its judge (`lib/resilience.js` `BeatClock`)
is pure, every time handed to it (the steady clock's and the wall clock's), so the rule is held on a fake clock; the
real watchdog is held by the plan's proxies, both processes frozen and thawed (SIGSTOP, SIGCONT: Linux only), in
`test/sleep.test.js`. `server.js` starts no timer of its own for the power request: it is read again when the halls
board's frame is flushed (a page, a screen, a Stagewatch frame mark it) and in health's 5 s window, which is also where
a child that has not answered within 30 s is read as failed and one that failed is asked again a minute after; its one
clock is handed to it, so those bounds are held on a fake clock. `lib/power.js` runs `powershell.exe` by its absolute
path only, through `lib/laptop.js` `powershellPlan`, the one plan "This laptop"'s read also uses (§3.7's fence holds
it, `p.file` in its register), at 0 synchronous calls; its tests hold the path, the environment of named Windows folders, the
fixed script (one line, no double quote, Constrained Language Mode said before `Add-Type`, held only when the call
returned non-zero, then a wait on its input), and its answer read by type; on Windows (the CI job) a test runs the
script itself.

Running only what it names by its absolute path (the plan's U11) leaves `server.js` at 15. Its look for its own
cloudflared stays one synchronous call, now a `statSync` of `bin/cloudflared(.exe)` beside `app` as the link is asked to
start (Turn on, or a start inside the link's kept end), where it was an `existsSync` followed, when there was none, by
the bare name `cloudflared`: a copy without it is refused with why before anything runs or an end is kept. The look
cannot be left to the spawn: a program that is not there says `error` and `close` and never `exit`, and every Turn on
then left its log's 500 ms poll running for the life of the process, which the spawn's `error` now also ends (§3.7).

A restart that rewrites only the halls that changed (the plan's U4) adds `lib/laststop.js` at 4, with its reason: once
a start, after the hold, the last stop's record moved aside to `last-stop.seen.json` (or removed where it cannot be
moved), and the data and rooms folders listed for the temporary files a stop cut short left (`<file>.<pid>.tmp`), each
removed whose process has ended; the record itself is written at the stop through the atomic writer, and read at the
start through `readText`, so neither is a call of its own. `lib/store.js` keeps its cap: the lines of a log are counted
as the start reads them, and a hall's dirtiness is known from what the store holds (a line in its log, an op the log
refused, a change marked, no whole snapshot), with no call of its own. `server.js` stays at 15. Beside it a fence
(`test/units.test.js`) holds every field a hall's snapshot writes to a row of `SNAPSHOT_FIELDS` (`lib/store.js`), which
names the change that marks the hall dirty (an op, or `markDirty` for a change no op makes: a room's guest code and its
earlier codes, which `setGuestCode` marks and writes at once, are written only when a room holds them, the last two
fields, `SNAPSHOT_OPTIONAL`, so a hall never renewed is 0.5.1's shape), in two halves. The source
half reads `server.js` and `lib/` for a hall's settings, messages, tombstones, guest code or earlier codes written beside the store, reached through
any name and however deep (assigned, counted, deleted, merged into with `Object.assign`, or changed by a mutating call),
and for its name or change number written through the names the server gives a hall (`room`, `hall`, `r`, `h`, `dst`,
`src`; `lib/displays.js`'s `r`, a screen's take result, is the one row of its exceptions). A message changed in place,
taken from `byId`, is no pattern's: the runtime half (`test/snapshot-preload.js`) is loaded into every server the
end-to-end tests start without preloads of their own (`test/helpers.js`, whose `stopServer` fails on what it found), into
the stop's own tests and into the smoke's servers, and holds each hall a start or a stop leaves unwritten to the fields
the store last wrote or loaded, naming the hall and the field that differ. A change on a path no test drives is still
the source half's alone.

The busy line and the stop at loopback (the plan's U8) add `lib/busy.js` (pure: it joins the module fence's pure set,
§3.5) and `lib/machinewire.js`, each at 0 synchronous calls and no timer of a handler file's: the pipe's read and each
of the machine's requests wait on one deadline of their own in `lib/machinewire.js`, for the whole answer (never the gap
between two bytes, which a program that answers a byte at a time would hold open), cleared when it ends, and the stop
goes once its answer has gone (`finish`), on no timer. `server.js` stays at 15 and its timers as they were. Beside them
a fence (`test/busy.test.js`) holds every socket verb a handler file registers to exactly one of `busy.INPUT` (a
person's input, which makes a seated page active) and `busy.READS` (what a page sends by itself, and `disconnect`),
names in neither list only verbs that are registered, and holds every verb a page holds in its outbox for its person to
`INPUT`; and the line's keys are its seven counts, so no name, code, token or path can ride in it. Its two bounds, each
with a deterministic test: the pages whose input is held (`busy.ACTIVITY_MAX`, 10,000, the oldest let go: a join that
names no uid is given a new one, so a flood of joins would grow the list) and the nonces (`NONCES_MAX`, 256: a hello
is asked by anyone on the PC).

The audit log's export adds `lib/auditexport.js` and `lib/zip.js`, and the verifier `verify/verify-audit.js`, each at 0
synchronous calls (the guard names them, so a file that drops out of its list fails it): the export reads, digests and
streams on the thread pool and in slices, and the verifier on another computer reads through `fs.promises` only. Its
speed fence counts that work in a real server (`test/audit-preload.js`), never the time a turn of the event loop takes,
which a busy machine stretches: on the 56,000-entry seed, at most 1,000 lines walked and 1 MiB of the log digested
between two turns, no synchronous read of the log, one read of it and one deflate in flight at a time (two of the thread
pool's four threads, the rest a sign-in's), and a sign-in answered while the export holds its slot, its entry written
and its files open. The
browser verifier's script, `verify/page.js`, has its own ESLint block: browser globals only (every Node global off, as
for the rules), one function scope, and `agm/no-unescaped-html`; it writes with `textContent` alone. It is put inline in
`verify.html` beside `auditrules.js`, under a meta Content-Security-Policy that carries their SHA-256 and allows nothing
else (`connect-src 'none'`): a test holds the hashes to the inline script and style, and holds the page to the same bytes
for the same release. A test also runs `page.js` in Node against a stand-in document, so the page's five states are held
beside the Node verifier's exit codes (a break the laptop named, a file changed after the export, an earlier export that
does not check), not by the smoke alone. The verifier's path rule (`auditrules.js`, `pathProblem`) is the rules' too: a test gives it `../x`,
`/etc/passwd`, `C:\x` and `\\host\share\f` through a recording `fs` and finds nothing opened but `SHA256SUMS`. The
release's `SHA256SUMS` and attestation take in the verifier's own zip, as they take every `dist\*.zip`.

The audit log carried across events adds `lib/auditarchive.js` (the split, its finish at a start, an archive's own
check) at 0 synchronous calls, and the guard names it: it checks, reads, renames and removes through `fs.promises`, and
writes the four small files of a split through the atomic writer, once per split. `lib/audit.js` stays at 11: the
archive point's forced rotation is the rotation it already had, the walk's look at each archive (two small reads and a
size per file) and a split stopped part way are read asynchronously, and the rotated name's time rule keeps the newest
rotated file's time in memory, read once through the listing it already made. The folder check itself (`verifyFolder`)
moved into `verify/auditrules.js`, still pure: the Node verifier and the page each hand it only their way to read a
file, hash it and check a signature, so an export, an archive inside it and an archive alone are checked one way in
both, and the page's test (`page.js` run against a stand-in document) holds the archive's states beside the Node
verifier's codes. The path rule gains an archive's own set (`archive.json`, `signing-key.pem`, `SHA256SUMS`,
`SHA256SUMS.sig`, rotated `log/` files), under `archive/<name>/` in a bundle, the name held to
`audit-<8 hex>-<from>-<to>`: a test gives it `archive/../x`, a name off the pattern and a file off the set, and a link
in an archive's `log/`. The split's speed fence counts its work as the export's does, while the 56,000-entry seed is
split at entry 50,000: at most 1,000 lines walked between two turns of the event loop, no turn hashing more than one
file (each is hashed whole as its read ends, and a file is at most the rotation's size), the log read off the loop one
read at a time, and a sign-in answered while the split holds its slot. It holds an archive's own Check of the 49,999
entries split off to the same counts: the folder check takes a turn of the event loop every 1,000 lines when the reader
hands it one (`io.turn`, which the Node verifier gives and the page needs not), and the MAC walk every 1,000 entries.

0.6.0 adds the pages' message channels to it: every `postMessage` in a page script under `public/` names this origin as
its target, never `'*'`, and every `message` listener's first line returns unless both the sending window and its origin
are the ones expected (the admin's support view hears only the admin page that frames it). A post or a listener written
in a shape the guard does not read, or an `onmessage` handler, fails it too.

The guard reads folders, not a hand list: `lib/` and `verify/` in every folder below them, and every page script
(`pageScripts()` in `test/helpers.js`: each `.js` and `.mjs` under `public/`, `vendor/` left out, whose files are their
packages' bytes and are held by `test/vendor.test.js`). The hand list read four of the ten page scripts:
`audit-export.js`, `common.js`, `display.js`, `halls.js`, `theme-init.js` and `users.js` join, each at 0 synchronous
calls and none with an `eval`, and the guard names them, so one that drops out of the read fails it. A planted folder
holds the read to its rule: a module in a folder below `lib/` and a page's `.mjs` are read, a vendored file and a
stylesheet are not. No cap moved.

The guard counts timers too, the plan's fence (o): every `setTimeout(` and `setInterval(` that a handler file
(`handlerFiles()`: `server.js` and each module in `lib/handlers/`) starts, bare or as a member, a space before its
bracket or not, each with its reason in a list the count must equal. `server.js` starts 16 (health's 5 s tick, the
boot's seats, the uploads' sweep, 0.5.1's pages told to reload once none of 0.5.1's files can still be fresh in a
browser, a tunnel socket's wait to join a room, a drop's grace, three let-go-after-telling
timers, the sign-in sweep, the show desk's loop, the Stagewatch contexts, the tunnel's log and its 30 s, which also
checks a link whose cloudflared never said it was registered, the watchdog's heartbeat, the banner's Token line's 2 s
wait for the watchdog). The internet link's check
starts none: each of its tries carries its own deadline (`AbortSignal.timeout`). A frame of state is never one
of them: it is a `Latest` (`lib/latest.js`), whose timers are its own, and the halls board, the screens console, the
people list, the seen receipts, a hall's rooms (each page's switcher and header) and the rooms a room's pages may send
into (a nudge to ask again) are the six, each named in
`server.js` and in health's `latest` (the guard reads the names). A new tick of a handler file's own moves the list, with its words; one taken away moves it too. A planted source
holds the read to its rule: four forms are counted, and `clearTimeout(`, `resetTimeout(`, a destructured `setTimeout`
and a `Latest` are not. A frame is sent through `sendEach`, each hall (and each board watcher) apart: one that faults
while it is built is refused and counted in health's `handlerFaults`, as `guardHandlers` counts a handler's throw, and
the others still go (`test/units.test.js` holds `sendEach`).

The guard reads the stylesheet too (`public/styles.css`, the one every page with people loads). Its colours, sizes,
spaces, targets and layers are tokens, named once in `:root` and every colour once more under `html[data-theme="dark"]`;
the guard holds each of those to one block, so a second `:root` is a failure, and counts the hex colours written outside
the two: 292 when the token layer landed (327 before it), 281 once the catalogue's menus replaced the five icon-button
variants, the forward and reaction pickers, the observer's hiding rules and the panel's own Pin button, 275 once the
admin page's linked-hall picker and its destructive button style went with its native dialogs, a count that may
only go down, as the coverage gate may only go up. A unit that takes colours out lowers the cap with them; a new colour is a token. Beside it, no opacity between 0
and 1 is written anywhere in the stylesheet, as `opacity:` or a filter's `opacity()`, a number or a percentage, and no
opacity is written as something the guard cannot read as a number (a `var()`, a `calc()`), so another spelling of a fade
never passes: words and icons are muted with `--c-ink-muted` (4.5:1 or more for words, 3:1 for icons, in both themes),
never faded, so a toast or a switch hidden at 0 and shown at 1 is all that remains. A planted sheet holds both reads to
their rules: a colour in a token block, in a comment or in a selector (`#feed`) is not counted, one in a `@media` block
is, a second `:root` is seen, and an opacity of .5 in a keyframe, .35 on an icon, 60 %, `var(--fade)`, `calc(.5)` and a
filter's `opacity(.4)` are found while 0, 1, 100 %, `opacity(1)`, a transition of opacity and a custom property named
for it are not. The smoke holds what the stylesheet draws, on the hall page at 390 × 844 with a touch screen for each
seat, in both themes: computed contrast for a message's acts and its ⋯ (and their size, 44 px under a finger) and the presence lines, the
On stage tag's light colours in light mode, Help at rest neutral and outlined (no red in its fill, words or edge, its
words at 4.5:1 and its edge at 3:1), 🔥 Priority on the fault red only while pressed, and no fade on any of them.

The guard holds the page floor too (the plan's fence (q); `docs/DEVICES.md`): Safari 14.1 (iOS and iPadOS 14.5) and
Chrome 84, below which a page says so in words and does nothing else. A page reaches a feature newer than the floor
through a helper in `common.js` that probes for it, never bare, so `.showModal(` appears only in `AGM.openDialog`, behind
its probe, and the pages that open dialogs (the hall page and the admin page among them) load `common.js` before their
own scripts. The stylesheet is read for each feature above the floor, a declaration a browser cannot read being dropped (the one
before it then holds) and a selector list it cannot read whole being dropped whole: a `dvh`, `svh` or `lvh` value (and
their kin) follows the same property with a value in `vh`; `:focus-visible` and `:has(` never share a selector list
with a selector the floor reads; `color-mix(`, `light-dark(` and `text-wrap` follow a plain declaration of the same
property or sit inside `@supports`, where a rule inside `@container` must sit too; an `inset` follows `top`, `right`,
`bottom` and `left`, and a logical property (`margin-inline`, `padding-block` and the rest, which Chrome 84 to 86 drop)
its physical sides; and no rule is nested. A new feature above the floor joins that list with its fallback, by an edit to
the test that says which browsers drop it. A planted sheet holds the read to each rule, and 0.5.1's sheet fails it eight
times. ESLint is the lint's half, beside it: `no-restricted-globals` refuses a bare `requestIdleCallback` and
`cancelIdleCallback` on a page ("use AGM.idle: Safari has none"; `window.requestIdleCallback` behind a probe is a member
and passes), `no-restricted-syntax` refuses a `requestSubmit()` call (Safari 16), which a page makes only behind its
probe on a line that says so, and any read of the user agent however it is reached (`navigator.userAgent`,
`window.navigator.userAgent`, `userAgentData`, a computed key, a destructuring), and `theme-init.js`, which says the
floor's words, is parsed as ES5 so it parses below the floor. `test/lint-rules.test.js` lints planted sources
through the config itself, so a change to the config cannot drop a rule unseen. `test/pagefloor.test.js` runs
`theme-init.js` and `common.js` as a page runs them (the floor's mark, words and held forms; `AGM.awake`'s causes;
`AGM.idle`'s timer and slice), and holds every page with people to load `theme-init.js` first, a screen's page to load
none, and every script of theirs to stop below the floor before it first asks the server anything or opens a socket,
but the six that only define at load (`common.js`, `outbox.js`, `reconnect.js`, `audit-export.js`, `catalog.js` and `menus.js`), each named with its reason
(`/build.js` and Socket.IO's client are the server's answers, not files of `public/`). The smoke takes the features away in Chromium: at the floor
(no `showModal()`, popover API, Wake Lock, `requestIdleCallback` or `requestSubmit()`), with no `<dialog>` at all, and
below it (no `WeakRef`, every fetch, request, WebSocket and beacon counted: none).

Beside it, `test/reconnect.test.js` fences the pages' sockets: every page script that opens one (`io(`) opens it at the
reconnection's pace, `AGM.reconnect.OPTIONS`, names the build that served it as it connects (`auth:
AGM.reconnect.auth(`), and attaches each socket it opens to `AGM.reconnect`, and every page that loads it loads
`/build.js` and `reconnect.js` first. The four that do are named (the hall page, the halls board, the admin page and the
screen), so a fifth page with a socket, or one that drops out, fails it; `reconnect.js` opens none of its own; and each
of the four hears the build in the answer it reads it from. A page left out would stay dead after a refusal, and one
that named no build would be read as 0.5.1's and never reload onto a new build; it would also keep its connection open
in the browser's back-forward cache once its tab had left it, which `reconnect.js` closes then (`pagehide`) and opens
again when the page is shown again (`pageshow`), each held by its test. The tests' own sockets name this
checkout's build (`test/helpers.js` `connect`; `build: null` is a 0.5.1 page). The watchdog's first restart after 0.5 s
is held by a test only the test-windows job runs (on Windows a killed process's port and named pipe are the system's to
free): a server bound as the show laptop's is (every address) with a page connected from the machine's network address,
killed 20 times in a row, each start 0.5 s later finding both free. It is skipped elsewhere with that reason, as the
`.bat` files' tests are; the step is set back to 2 s if it fails there, and no release is built before that job is
green.

### 3.5 The module fence (`test/modules.test.js`)

The server's layers and the wire's words, read from the source by regex as the input fuzz reads event names: every
`require('…')` with a literal path, `./` and `../` alike, resolved as Node resolves it here (the path, then `.js`,
then its folder's package `main`, so `require('..')` from `test/` is `server.js`, then its folder's `index.js`). A
relative require that resolves to no file fails, from a test too, so a path the resolver reads wrong cannot pass as
nothing. Each rule is a function of the sources it is given, so the tree is held to it and a planted breach of each kind
is shown failing it. dependency-cruiser and the ESLint import and boundaries plugins would
each be a new dev dependency (audit, signatures, SBOM) for rules a node:test reads from `require()` calls.

| Rule | Holds | Fails on |
|---|---|---|
| (a) the pure set | `lib/board.js`, `busy.js`, `context.js`, `deskresults.js`, `gate.js`, `latest.js`, `ops.js`, `rbac.js`, `stagelines.js` and `tunnelend.js`, the pure core, require only each other | a require of anything else, an I/O built-in named (`fs`, `net`, `http`, `https`, `dgram`, `tls`, `os`, `dns`, `child_process`, `ws`), `process.` read, an `import()`, a file the set names that is not there |
| (b) no cycle | among `server.js`, `supervise.js`, `lib/` and `verify/`, no file requires another that leads back to it; no file, a test included, requires `server.js`, by its name or as app/ | each cycle, named once from its first file |
| (c) one root | only `server.js` requires `lib/http-accounts.js` and the handler modules in `lib/handlers/` (a test may, to test one) | any other shipped file that does; a relative require of a file that is not there |
| (d) narrow handler modules | a module in `lib/handlers/` requires only the pure core, `lib/guard.js` by its pure helpers' names (`str`, `cleanText`, `mac`, `Bucket`: `const { … } = require('../guard')`), `lib/ids.js`, and the rows of one module: `lib/handlers/takes.js` takes the pages' pure vocabulary from `lib/pages.js` by name (`cleanPage`, `describePage`, `canShow`, `cleanSnippet`); it reaches nothing past a literal `require`: no `import()`, no `require` named but to require a literal path, no `process`, no `module.` but its exports, no global object; it makes (`new`) nothing it requires, reached by its name, a name given it (`const B = Bucket`, `const { X } = m`) or a `require(` in place. Its `register(socket, conn, ctx)` names `ctx` at most once more, as its first statement, `const { … } = ctx;` with no rest, so that line is the module's list of what it reaches of the server. Read as code: a word in a comment or a string is none. A store or a link reaches a handler module only through its context (`ctx`) | a built-in (`fs`, `child_process`, any `node:`), a package, a store or an edge (`lib/resilience.js`, `lib/store.js` included), each by file and line; guard taken whole (a name bound to it, or `require('../guard').x`) or a name outside its helpers (`readSecret`, a rest element); `import('node:fs')`, `require(name)`, `const load = require`, `require.call`, `process.binding`, `const { env } = process`, `module.constructor`, `globalThis.process`; a `new` of what it requires; `ctx.store` in a verb, the destructuring not first, twice or with a rest, `const parts = ctx`, a `register` of other parameters or none |
| (f) the wire's words, closed both ways | every event a page sends (`socket.emit('x'`, the outbox's `AGM.outbox.hold`, `now` and `self('x'`, and `verb: 'x'` in `public/catalog.js`, where `local` and an HTTP route are no socket's send) is a verb a handler file registers; every verb is sent by some page; every event a handler file sends is heard by some page (`socket.on` or `once`); every event a page hears is one a handler file sends, or Socket.IO's own (`connect`, `connect_error`, `disconnect`) | each word left open, by file; an event named by an expression, on either side, unless a row names what it takes (on the server, `apply()`'s `opEvent`, whose names are the op table's `EVENTS` in `lib/ops.js`, is the one; on the pages, the hall page's listeners made from its op table, `public/app.js: socket.on(event`, named by the table's events, is the one, and the outbox's own send, `public/outbox.js: socket.emit(verb`, whose callers name its verbs where they call it, is the other); a verb registered in a form the fuzz does not read: `socket.on(` with anything but a single-quoted name, or `socket.once`, `addListener`, `prependListener` or `prependOnceListener` for any event but Socket.IO's own (`disconnect`, `disconnecting`); an allow-list row whose reason has gone. A take a handler file sends to pages by their sockets' ids, `sendTo(ids, 'event', …)` (`lib/gate.js`), is an event the server sends, read as code: one no page hears fails, one named by an expression is unread, and a `sendTo(` with no event is one the fence does not read ((j) holds `sendTo` to being named only to be called) |
| (g) one file list | `handlerFiles()` in `test/helpers.js`: `server.js`, then each module in `lib/handlers/`, sorted. The fuzz reads its events from it with its own regex, and so does (f); the guard's timer count, (o), reads its files. No other shipped file (`supervise.js`, `lib/` in every folder below it, a folder below `lib/handlers/` included, `verify/`) listens on a socket, so no verb is registered where neither reads it; and `server.js` registers only the verbs it held when the handler modules came (`SERVER_VERBS` in `test/modules.test.js`, a list that only shrinks: a verb leaves it when a unit rewrites it into a module), so a new verb registers in a handler module, behind its gate | a file of another kind or a folder below read as a handler module (a planted folder); a verb `server.js` registers that the list does not hold, and a row it registers no more; a listener on a socket in any other shipped file, unless a row names its events and why: `lib/tls.js`, the shared port's own TCP socket (its first byte and a reset by its peer), is the one, and fails once its listeners change or go |
| (i) one gate per verb | every listener a handler module adds (`socket.on(`, read as code), but Socket.IO's own `disconnect` and `disconnecting` (no page sends them; they carry no acknowledgement), is written in place with a block body whose first statement is its one gate, `if (!conn.gate(ack, {…})) return;`, handed the listener's own last argument by name, so a refusal answers the sender; its options are written out and the gate's own (`joined`, `bucket`, `admin`, `may`), naming one of the connection's buckets (`conn.writes`, `conn.chatter`, or `writes` / `chatter` taken from `conn` as itself: the source read holds them to `conn`'s, each a `guard.Bucket` the connection makes) or saying `bucket: null` with why in a comment on its line or the line before; the module holds as many gate calls as verbs | a verb whose first statement is not its gate (a gate after a line of its own, a gate under another name), which does not return when the gate refuses, which passes the gate twice, or whose listener is a name or an expression; a gate given `null`, `args`, a function or a name that is not the listener's last argument, or a listener whose last argument is not a name (`{ ok } = {}`, none); options that are a variable, a spread, an option the gate does not take (`addmin`), no bucket, `{ bucket }`, a bucket not the connection's (`undefined`, a call, a module's own `free`, `conn.uploads`, `chatter` not taken from `conn` or taken renamed), `bucket: null` without why; a gate call outside a verb, a `disconnect` listener's included |
| (j) the takes module, and no module's own rights or settings | `lib/handlers/takes.js` reaches a page by its socket's id alone (`ctx.sendTo`) and names none of `io`, `.to(`, `.in(`, `.broadcast`, `.nsp`, `.server`, `.except(`, `socket.join(`, `socket.leave(` or a member by a string (`socket['to']`); it reads the room store only through its readers (`store.get`, `has`, `room`, `hasRoom`, `allRooms`, `roomsOf`, `isMain`, called), never takes the store or the socket under another name, and asks its context for nothing it does not hold (`apply`, `systemMessage`, `newSideRoom`, `renameRoom`, `sendGuestsOut`, `codeChanged`, `setRoomSends`: `lib/gate.js` `ROOM_SENDS`). No handler module asks a right of `rbac.can` (under any name `rbac` is bound to, `rbac[…]`, or `can` taken from it, at the require or later): its connection answers (`conn.allowed`, `mayPost`, `canIn`, `canManageHall`: the room the verb sits in is `allowed`'s, which reads the seat's limit first, and `canIn` answers for another room by rights alone); none names `sendTo` but to call it, or to take it from `ctx` as itself, so (f) reads each take's event; none writes into `settings`, which its context does not freeze: no assignment into a path of it (`settings.x =`, `ctx.settings[k] +=`, `??=`), no `++` or `--`, no `delete`, no `Object.assign`, `defineProperty` or `Reflect.set` of it, no call on a path into it by a method that is not a read (`push`, `splice`, `sort`, `set`, one named by an expression: the reads are a list, `slice`, `includes`, `map`, `get`, …), no hand-off as a function's `this` (`.call(`, `.apply(`), and neither settings nor a part of it taken under another name (`const { settings: s }`, `const s = ctx.settings`, `const sends = settings.roomSends`, `const { roomSends } = settings`; a count, `.length`, `.size`, may be). Read as code, a template's `${…}` included | each such name, call or write, by file and line (while `io`, `apply` and the store's writers in the rooms module, another object's `store`, a setting compared, counted or copied, `settings.roomSends.slice()`, rbac's words and its other questions, and a word in a comment or a string pass) |
| (k) one op table | the hall page's `UPD_EVENTS` (`public/app.js`, field → [event, draw], read from its source) is `lib/ops.js`'s, field by field and event by event, and the page names each of its events once, there; the op of every `apply(` call in the handler files (not a method's `.apply(`, and `apply()` with nothing in it passes none) and every op whose kind is written `upd` wherever it is built (its `o` bare or quoted, its kind in any quotes) is an object written out, of a kind the table holds, and an `upd`'s `f` is written out with each field in the table; every field of the table is one some `upd` sends; `apply()` is the one `server.js` makes with `ops.applier(`, given the store's commit and a refusal that only logs. The ops are read as code (a bracket, a comma or a word inside a string, a template or a comment is not the code's; a call written out in a comment is read as one) | a field in one table and not the other, or under two events; a page with no table, a row not `field: ['event', draw]`, or an event of the table named again beside it; an op given to `apply()` that is not written out (a variable, no op), whose kind is not (`o` from a variable, or none), that holds a spread or a computed key, or of a kind the table does not hold (by file and line); an `upd` of a field outside the table, of no field, or whose fields cannot be read (an `f` not written out as an object, a spread or a computed key in it, an op not an object literal); a field of the table no `upd` sends; another `apply` declared or assigned in a handler file, or a refusal that does more than log |
| (l) the any-room readers | every call in a shipped server file (`server.js`, `supervise.js`, `lib/` and `verify/`) to the store's any-room readers, `store.room`, `hasRoom`, `allRooms` and `roomsOf`, which reach a hall's side rooms as well as its Main room, is counted per file, each with why it reads any room and not a hall (`store.get`, `has`, `rooms`), in `ANY_ROOM`, as the guard rail counts synchronous calls; the store's side rooms are reached through those readers only | a file whose count of those calls is not its reasons' (a reader added, or one gone, without its words moving); `store.side` or `store.sideByHall` (the side rooms by key, and by hall) read outside the store; a row for a file that is not there |

The allow-list of (f), of events no page hears, holds one row: `view`, an account's chat view changed alone, told live to
its pages in a room, which stay open (the plan's Part 1 unit 9); the hall page draws the simple view, and hears it, with
Part 7's unit 20a, which takes the row out. Its row before, `linkedRoomsChanged`, sent to a guest's pages when the admin
lets them forward into another hall or takes it back, went once the hall page heard it, to keep its `forwardable` fact
live (§3.6). A row fails the fence once a page hears it, or once the server stops sending it, and a planted tree holds
both. On the tree before 0.6.0 the fence failed on two words, both `typing`'s: a verb no page sent,
and an event no page heard. `typing` was removed (the owner's answer 26 wants no typing indicator), which lowered the fuzz's count of
events by one, to 55.

(k) holds at build time what `apply()` refuses at run time: a change the table cannot send (a field outside it, no field,
no message, an added message with no id, an op of another kind) is refused before it is committed, in one log line that
names its kind and fields and never a value, and `apply()` answers null rather than throw, since the Stagewatch
followers call it outside the guarded handlers (`test/units.test.js` holds it on a real store: no number taken, nothing
on disk, sent or marked; a change committed, then sent under each of its events, then marked, in that order). A caller
reads the null: a request is answered as refused, never as done, and nothing that follows the change is done for it.
What (k) cannot read it fails rather than pass: an `apply` reached under another name is the one form it does not see,
and the run-time refusal still holds it. The hall page applies a change it reads when it comes back and one it hears live
through the same row of its table, and the smoke holds the two drawing the show desk's answer the same way. On the tree before (k)
the page had no table: the resumed path and the six live listeners were written apart, and drew that answer differently
on a message whose record the page no longer held. A send's mark (`sentTo`, sent as `sentUpdate`) and a reply's quote
(`replyTo`, sent as `replyUpdate`) are the table's seventh and eighth rows, each changed by the rooms module's withdrawal
(unit 15), the mark on the copy kept where the send came from and the quote on each reply that quoted it where it went:
without them, the withdrawal's changes would leave every page of either room with a gap, and each would rejoin. The smoke
holds the page that withdraws drawing the mark heard live with no join again, a page back by resuming drawing it through
`applyOp`, and the room it went to drawing the quote "⊘ withdrawn" with none of its words.

(l) keeps the hall and the room apart. A hall is its Main room: `store.rooms`, `get` and `has` see only halls, so a reader
that means a hall (the halls board, `/api/halls`, the context, screens, Stagewatch and peer links, hall settings) never
sees a side room, and one that should have read any room and was missed answers "Room not found" there, failing closed.
Each reader moved to any room is a row, said once with its reason: a page's room and its seats, a forward's target and
the picker's rooms, the admin's room controls (watch, reset, remove, a message removed, seats, the lock, links, send out,
the summary and its minutes) and the transcript, a state frame's room, uploads in use, the boot's seats and the restart
line in every room, a hall's Stagewatch frames to every room it holds, a send to the speaker's screen or a proposal kept
only while its room is, the power request's pages and the busy line's messages in every room, "This laptop"'s Pages row,
health's `sideRooms`, a stop's halls left unwritten, and a new hall's key, unique among every room's. A side room follows
its hall: a help request answered in its room by its key, Main or side; the halls board's help per room (whole to who
reads the room, without its words to the hall's crew); the followers of a send and of a proposal, which write the
speaker's acknowledgement, a send lost and a proposal's state into the room it came from; the restart's two loops, which
follow the sends and the proposals of every room again; and the show desk's notice, posted into every room of every hall
and counted by its halls. The rooms an account may enter are listed by its hall (`/api/halls` and the halls board, by
`sideRoomsFor`; a hall page's switcher, by `switcherFor`, and told again to each page in any of the hall's rooms when one
changes, `sendHallRooms`), and every side room an account may be given by the Accounts route (`sideRoomNames`); a
move between rooms of a hall, read across its rooms (`movedWithinHall`); and whether the halls page is where an account
answers a side room's help it is not given (`answersOnBoard`). A hall's invite links stay a hall's
(a guest's code names a hall). The 56 calls of `server.js` are the plan's 1-§3.5 and the readers of room state beside
it; a unit that adds one moves the list with its words. A
planted call without its row, a row without its call and `store.side` or `store.sideByHall` read past the store each fail
it.

The rights fence (`lib/rbac.js`, `test/accounts.test.js`) keeps a room's rights apart from a hall's, as (l) keeps the
readers apart, and fails closed at run time rather than at build: seeing, posting and sharing files (`ROOM_SCOPED`) are
answered only by `rbac.canIn(account, cap, scope)`, for a room named by its scope (`{code, hall, main}`, the store's
`scopeOf`), and `rbac.can()` asked one of them with a hall named (a code, or anything in its place) answers no, the
admin's and every hall's accounts included. So a call site left on `can(…, 'hall.post', room.code)` for a side room
refuses where it would have let every account of every hall in; the question with no hall ("in any hall at all?") still
answers. A scope is read whole (a key, a hall, and whether it is the Main room, in agreement) or answers no. The test
holds the fence for every role (accounts of their own halls and of every hall, a Viewer and the admin) and room right,
`canIn` in a Main room to 0.5.1's answer for every role, right and hall, a side room to its members and the admin role,
and a malformed scope to no; handler modules ask a right of their connection, never of `rbac.can` ((j)): what a verb
may do in the room it sits in of `conn.allowed` (the gate's `may`), which reads the seat's limit first, and what it may
do in another room of `conn.canIn`, which answers by rights alone and reads no seat. The escalation fence
(`rbac.mayChange`, `exceeds`, `afterChange`) reads an account's side rooms before every hall, so an account that manages
accounts and is not an admin gives no side room it is not given, every hall's included, and reads its On stage halls as
halls; nobody sets their own side rooms, On stage halls or chat view; the test holds each, with what the Accounts page is
offered (`giveableRooms`) and a value that is no name refused in words rather than thrown.

The handler modules (plan 5-§14.2) are where a new verb registers: `lib/handlers/rooms.js` (the verbs on a hall's rooms)
and `lib/handlers/takes.js` (the takes on people's pages), each one `register(socket, conn, ctx)` the connection calls
on every page's socket but a screen's (the hall page's, the admin page's and the halls board's), after its own verbs.
`conn` is the connection's context, frozen and made after each helper it holds (its room and person are functions, so a
verb never holds a room its page has left); `ctx` is the server's, frozen and built last in `server.js`, after every part
it names is declared and before the copy holds its port; the takes module gets `takesCtx`, the same but the parts that
make a room, a room's op or send to a room, or set which rooms may send into one (`io`, `apply`, `systemMessage`, `newSideRoom`, `renameRoom`, `sendGuestsOut`, `codeChanged`, `setRoomSends`: `ROOM_SENDS`)
and with `sendTo`, which reaches only a socket open now by its id. `contexts()` is handed the parts alone and reads the open sockets from `io` itself, so the
`takesCtx` the server builds is the one `test/units.test.js` holds on a real Socket.IO server: a hall's key given to
`sendTo` reaches no page, a page's socket id reaches that page. A source read in the fence holds each of those orders.
(d), (i) and (j) are what keeps a module narrow: what it requires and reaches, its context read once, that each verb
passes the gate (`lib/gate.js`) first and answers its own sender, that a take is never a room's op or broadcast, and that
no module asks its own rights or writes the settings. The gate itself fails closed at run time on what (i) reads at build
time: an option it does not take, a bucket not named and a right it has no words for throw before anything is read, so
the socket's guard refuses the request rather than let it through with a step left out (`test/units.test.js`). Its
order, joined and the room still here, then the bucket, then the admin, then the rights, takes a token before anything a
client named is looked up: a refused lookup has spent its token. `server.js`'s own `need`, `mayPost` and `admin` are its
steps alone, and `limited` says its bucket's words, so the verbs written there answer in its words. A module that lists
rooms tells their guest codes as its page may be told them (`conn.codeTold`, the one rule every list reads, `codeFor`:
`room:settings`); the fence holds `conn`'s parts by name, `codeTold` among them. Which rooms may send into a room is read
through the context's `sendersOf` and written only through its `setRoomSends` (the one writer of `settings.roomSends`,
which saves the lists a change touches together and refuses settings the run could not read), never by a module into
`settings` itself; the fence holds `ctx`'s parts by name, those two among them.

These reads are of the code as written, comments and strings blanked: a module that hands its store, its settings or its
socket to a function of its own, or mutates a room a reader returned, is past what a read of the source can follow. The
contexts and the gate make the plain way the narrow one; the fences catch each other way the plan and its review named,
each shown failing on a planted breach.

The read is by regex over a socket named `socket`, as the fuzz's is: a socket under another name, a listener added
through a computed property or a `require()` with a computed path (an ESLint error, `security/detect-non-literal-require`)
are not read, and the handler files' own shape (a literal `socket.on('verb', …)`, plan 5-§14.2) is what keeps them read.

`server.test.js` holds a sixth rule, (e) one lane each, end to end after boot, by the object: `WriteLane` counts every
lane the process makes, in any file, and health appends the count as `saves.built`, then `saves.named`, the distinct
write lanes `saveLanes()` names, the lanes a stop or a crash flushes. The test holds `named` to the lanes' names in
`saves.stores` (a lane under two names, or a name given twice, makes them differ) and `built` to `named`: every lane
named is one this process made, so as many named as made is every lane made. A store whose lane is not in `saveLanes()`
fails the build, beside another named twice or not.

### 3.6 The action catalogue (`test/catalog.test.js`, `test/menus.test.js`; the plan's fence (p))

Every act the hall page offers on a message, a file in its panel and a screen of its Screens dialog is an entry of
`public/catalog.js`, data and pure functions of the page's facts (read from the server's answers) and the object, with no
DOM and no socket: its row's acts, its ⋯, its right-click, Shift+F10 and its single keys are drawn from the same entries,
so they cannot drift, and the page binds only what each act does. `test/catalog.test.js` loads it as a page does (a vm
with nothing but the script) and holds: ids shaped `kind.verb`, unique; groups known and in their fixed order (respond,
send, keep, manage, danger), the danger group last, at most two acts in it, each asking first or with an Undo; a key a
single letter or digit that needs no Shift, or Enter or Delete, one per act in a kind (the entries of a fold share one);
no icon a status mark, ↩, ↗ and ⤴ kept to Reply, Send to and Send back, and Show again, and an icon shared only by
entries of one act (Look, Download, Pin, Show on screens in two kinds; 🗑 for Delete and Remove); every verb one a handler
file registers (read as the fuzz reads them), a route the server mounts,
or `local`, with its outbox mode (what a person wrote or answered is held, and Got it, the one reaction held; `local`
sends nothing); "…" ending exactly the
labels of acts that ask first or open a dialog; "screen" only in an act on a `/d/` screen or the speaker's screen; and the
verbs of the kinds landed so far all present (a list each later unit grows). Then, for 16 seats (backstage with every
fact, alone in its hall, without a desk, with the link down, offline; On stage in the full view and in the simple view,
with messages waiting for its answer; an observer, one who may post elsewhere, a Viewer, and a Viewer granted
`hall.post`; Staff; Tech with and without screens; the admin; the support view) and 10 objects, the shown sets, which
must show every act to some seat (so none passes by its absence); none of what an On stage seat is kept from, in either
view; the simple view's sets, which are its buttons, since it has no menu (Got it and Reply on the newest plain message
waiting and on each 🔥 one, "Got all N" for N waiting, a question's answers, a file's Look); the reasons of what is
shown disabled (offline, the link, no screens, the support view's); the inline bar (at most two, the lowest ranks, in
the menu under the same label); the folds (the speaker's screen's line box, which edits the line where Stagewatch keeps
no desk, beside Send now); the menu's caps (12 items, 2 dangers on the richest seat of each kind); and the single keys.
The ids later units' matrices name are these: `msg.speaker` is the speaker's screen's line box, present wherever the
Speaker's screen ▸ door is; a help request's answers are `msg.helpRespond` (On my way) and `msg.helpResolve` (Resolved).
`test/menus.test.js` holds the other half (the plan's R3): on a real server with the hall's Stagewatch linked (so the
speaker's screen is hidden by a seat's rights, never by a link that is not there), seven seats read their facts from
their own join and `display:list` answers through the catalogue's `facts()`, and every act whose rights hide it from a
seat (and whose fit holds, so no view is ever asked of the server) is sent as that seat with its smallest payload: each
is refused with words, not for the rate, the On stage seat's with the words its table names, every verb of that table
sent as it, every verb is refused to some seat, and the hall, its screens and the other hall are as they were. A new
verb an act sends has no payload until its refusal case is written, which fails the test. The source guard
(§3.4) holds `addEventListener('contextmenu'` to `public/menus.js` (its door and a menu's own panel, which keeps the
browser's menu off it) and `.cloneNode(` in `public/app.js` to the message template's one site, so a message is never
copied with its listeners lost (the pinned strip draws each pinned message afresh); `catalog.js` and `menus.js` are page
scripts every fence reads, and `test/pagefloor.test.js` names them as scripts that only define at load. The browser
smoke holds the doors to each other: right-click, ⋯ and Shift+F10 open the catalogue's set for each object, the ⋯
clicked again (a mouse's press and release) closes its menu, the key's menu has the focus on its first enabled item and
Escape gives it back, the row's acts are in the menu under the same names, an open menu keeps its order as its object
changes, a disabled act says why and sends nothing, and a tab fails the run on any native `alert`, `confirm` or
`prompt` (`Page.javascriptDialogOpening`), which it dismisses so the run ends. It walks each act's path: F's Send to ▸
("Looking…", then the hall, then the forward there), E's React ▸ (a check changed elsewhere redrawn in place, then
Enter), D and Enter on a file, Answer in words… as a field, Delete's ask (Escape back to the message, yes on to the
next), Copy text where the page has no clipboard API (the focus back on the ⋯), New link…, an ask about a screen
removed elsewhere, and a pinned copy that keeps the focus while another page's reaction redraws it.

The admin page, the halls board and the Accounts page act from the same catalogue: kinds `adminRoom` (a hall in the
admin list, a side room listed under its hall, and the watched room's header; and a room of a hall's Set up on the halls
board, where a hall's Main room has no Rename… or Close and the admin page's own acts are not drawn, its `fits` reading
the facts' `page`), `person` (the admin's half: a person's row), `adminMsg` (a message of the
admin's live feed), `link` (the default Stagewatch, a show system heard, a Patterns or PlayMap linked), `laptop` ("This
laptop": Refresh, `admin:laptop`, and Copy LAN address ▸, one per address), `tunnel` (the
internet link's card), `hall` (a row of the halls board), `help` (an open help request there), `account` and `audit` (an
account, and an entry of the audit log). Each page reads its facts from the server's answers through the catalogue's
`adminFacts()` (/api/admin/me: whom the admin page's gate admits, "the admin", who manages accounts, AI drafts, the
halls), `boardFacts()` (/api/halls and the board: who sets halls up, the admin, who manages accounts and who drives the
show network) and `accountFacts()` (/api/auth/me's rights,
/api/admin/me's "the admin", and the audit list's filter); an object's own facts (a help request's `canRespond`, an
account's `locked`) are the server's too. Every page binds only its runners: `AGM.acts` (`public/menus.js`) is the one
runner of the bar, the ⋯, right-click, Shift+F10 and the keys for all three, and `AGM.roving` makes each list one tab
stop. The verbs include HTTP routes (`http:PATCH /api/users/:id` and the account's others, `http:GET /api/audit/verify`,
`http:POST /api/audit/export`, `http:POST /api/audit/split`), checked against the routes the server mounts. The ids later
units name: Watch is `adminRoom.watch`, the hall's row's own door in the admin list (absent on the hall watched now), and
Close hall… is `adminRoom.remove` (Remove room… on a side room); New room in this hall… is `adminRoom.create`
(`room:create`, on a hall's row and header only) and Rename… `adminRoom.rename` (`room:update`, a hall's or a room's name
asked in place); Roles & invites is `adminRoom.invites` on a side room too (a Member's link, made with its own guest code);
a room's Members… (Board members… on a hall) is `adminRoom.members` (`http:PATCH /api/users/:id`, one per account, for
whoever manages accounts; `public/members.js`, whose checklist, each tick's change and the words of a save are pure and
held by `test/members.test.js`); a room's May send in… is `adminRoom.sendFrom` (`room:update {sendFrom, sendBack}`, the
admin's, on a hall's Main room as on any other: every hall's rooms by hall, each with "↔ and send back", saved in one
act; `public/sendfrom.js`, whose rows, the change a Save sends and the words of a save are pure and held by
`test/sends.test.js`); a hall's Rooms ▸ is `hall.rooms` (its side rooms this watcher may enter, opened by key),
beside Open Main; a room's Turn the code off… / Turn the code on is `adminRoom.codeToggle` and New code… `adminRoom.newCode` (both
`room:update`, the admin's: off asks the three-way choice, `AGM.ask`'s `choices`, whose answer reaches the runner as
`choice`; on asks nothing; New code says who stays and what stops); a person's Let them forward into ▸ is `person.forward` (`admin:linkRoom`), a hall per
tick, and taking one back is `person.unforward` (`admin:unlinkRoom`), which an unticked hall and a chip's × run; the
default Stagewatch's Set up… is `link.configure` (`admin:settings`), a node's `link.setup`; Propose… reads the drive
right, `canDrive`, which the admin page's facts carry for the socket its gate admits; the internet link's Turn off… is
`tunnel.off`, which the card's toggle asks for too, and its Tunnel until… is `tunnel.until` (`admin:tunnelUntil`, its end
asked in place as a time of day, `AGM.ask`'s `time` field); a hall's Copy link is `hall.copy` and its guest code `hall.code`, shown
only where the server told the watcher the code. A room (kind `room`: a room button on a hall's row, a room under Your
rooms, a room of the hall page's switcher) is its own link, with no bar: `room.open` (Enter; not on the room the page is
in), `room.tab`, `room.copy`, then, a group of their own, `room.code` (where the page is told the room's code: on the
hall page its own room's alone) and `room.setup` (`hall:settings`, the hall's Set up, on the halls board for a hall the
account sees, by `halls.manage`).
`test/catalog.test.js` asserts the three facts' readings, 63 seat-and-object sets (a side room's, listed and watched, Members… to an admin who manages accounts, Set up's rooms to the admin, to one who sets halls up, to one who manages accounts and to a crew, none of the admin page's own acts there, a hall's row with its rooms, and a room on the halls board and on the hall page's switcher among them) and three of "This laptop" (none shown to a page
the admin page's gate does not admit), the reasons of what is disabled (Check again's four, a locked account, the
minutes with no key, a node whose Stagewatch keeps no desk, not connected), the bars, the asks' words, the caps and the
keys, and reads every act's words on an object it fits. `test/menus.test.js`'s second test reads each seat's facts from
the server's answers — a Staff account's and a code guest's sockets on the admin page, a Viewer, a Board account and a
project manager who sets halls up and is not the admin on the halls board (Set up's rooms included: the manager's code,
New code…, Remove room… and Members…, a Members… sent as its own `PATCH` for an account; each seat's help requests its
own board's), and
on the Accounts page a Staff account, a manager and a manager who may manage accounts (but not an admin's) — and sends
each act these pages hide from them, the routes by HTTP with the seat's sign-in: 31 verbs and routes, each refused with
words, and the halls, the people and their forwarding, the link, the default Stagewatch, the accounts and the log as
they were. The smoke holds the doors of each of these objects to the catalogue as on the hall page, and their asks,
skip links and lists, the three pages in both themes and under a finger, and a disabled act that emits and asks nothing
(`docs/DEVICES.md` aside). An HTTP act of the Accounts page not answered in 5 s says "No answer", and its answer, when
it comes, still reaches the act, marked late.

The rest of the hall page acts from the same catalogue: `compose` (the composer's Send, its one act on the row, and its
⋯: ✨ Draft a reply, Send, 🔥 Priority, Attach a file…, Remove the file, Cancel the reply), `chip` (the stage chip:
Speaker's screen…, Show the countdown on screens), `code` (the code chip: Copy guest code, Copy join link) and
`person`'s hall half (@ Mention, from a row of the People panel and a message's sender's name). A kind two pages draw
fits each page's rows only on that page (the facts' `page`: 'hall' or 'admin'), so the hall page never draws a row whose
runner is the admin page's, and none is hidden by a right the server would not refuse (the admin's socket on the hall
page may do what the admin page does). An entry with `checked` (🔥 Priority) is drawn as a menu item checked or not;
a named key may be Escape (Cancel the reply, shown "Esc"), which acts on the composer as R, E or Delete act on a message.
AI drafts off is a state, never a right: ✨ Draft a reply is greyed with why on a message and on the composer alike.
`test/catalog.test.js` asserts 23 sets of these kinds for the hall seats, the simple view's (no menu: Send and 🔥 its
buttons), the bar (Send alone, named for the room), the disabled reasons, the toggle, the caps, and each page shown only
its half of `person`. `test/menus.test.js`'s first test reads the composer, the stage chip, the code chip and the room's
people as objects and sends each act of the rows the hall page draws (those that fit some seat and object there) as
every seat whose rights hide it: `message` among them. The ids later units name: Send is `compose.send` (its label
names the room, as Send's own name does); the stage chip's line box is `chip.speaker` and its countdown `chip.screens`;
the code chip's Copy guest code is `code.code` and Copy join link `code.copy`, and the admin's Turn the code off… / on
`code.toggle` and New code… `code.new` (`room:update`, on a page that names the room by its key: the join's `setsCode`);
the chip's code is the server's (`mayKnowCode` is the join's `guestCode`, then each `guestCode` event), never the page's
address; a person's Mention is `person.mention`. Sending into another room (unit 14): the composer's To ▸ is
`compose.sendTo` (`room:send`, mode `hold`; `may`: the join's `sends`, the facts' `targets` from `room:sendTargets`, by
reference; its values This room, then each room, `menuitemradio`; drawn as the composer's To: button too, whose menu is
those values, run through `act()`), and Send's label follows it ("Send to Legal"); a message's ↗ Send to ▸ is still
`msg.send` (verb `forward`), one list whose runner sends by `room:send` to a room a list allows and by `forward` to the
rest (a forward's row says "a forward — no withdraw" on its second line, an item's `note`); Send back is `msg.sendBack`
(`room:send`), on a message whose `sentFrom` names a room this one may send into, the full view only. ↗ is Send to, Send
back and To ▸, one act (`ONE_ACT`), and `room:send` is a required verb, refused as each seat it is hidden from (On stage
in the table's words). Delete… (`msg.delete`) fits no message another room sent here (`sentFrom`): its sender may not
delete it there, and the server's `delete` refuses it in its words. Withdraw (unit 15) is `msg.withdraw` (`room:withdraw`,
mode `now`, in the danger group before Delete…; its icon 🔙, since ⊘ is the withdrawn line's mark and no act's icon is a
mark): it fits this room's copy of a send not withdrawn yet (`sentTo` without `withdrawn`), the full view only; `may`: its
sender, or the admin's own page (the join's `admin`, never the support view's), and never a seat On stage; it asks first,
naming the room and how long the message has been there by the page's clock when it is asked (`confirm`'s third argument,
`now`, by default the time it asks), and the copy's Delete… says, while it is not withdrawn, that the message stays where it
went. `room:withdraw` is a required verb, refused as each seat it is hidden from (On stage in the table's words), and in
the outbox's `REPEATS`: a copy withdrawn already is answered `already`, to its sender or the admin, before the rate;
every refusal takes a writes token first, as the gate's rule has it (`bucket: null` on its gate, the token taken in the
handler after the repeat), and `test/sends.test.js` holds a burst of refusals to the rate and a repeat answered while the
rate refuses the rest. The seat matrix holds an admin's own page seated On stage to no Withdraw. How long a withdrawn send was there is said alike by
the pages and the server's readers (`AGM.catalog.lasted`, `lib/ops.js` `lasted`, held equal by `test/catalog.test.js`). An ask's verbs are its yes and no, or its `choices` and no (the rule
`test/catalog.test.js` reads of every ask).
The hall page has one toast (`AGM.toast`, `common.js`), a `role=status` region (`test/resilience.test.js` refuses the
toast's class or id named in any other page script, and a second toast class in the stylesheet), and its lists are `AGM.roving`'s: the
feed (from the newest message, a pinned question passed over), the pinned strip, the People panel, the panel's files and
the Screens dialog's screens. The smoke holds each new object's doors to the catalogue (a chip and a sender's name are
their own door: a click, a right-click and Shift+F10 alike) and their targets (24 px, 44 px on a phone), the toast's
role and number, the skip link, the roving feed with ↑ from the empty message box and Escape back, an observer's
question as words, a ⋯ pressed again under its ask answering it no, a page out of its hall offering no chip, the
support view's Help sending nothing, and Help at the floor. Escape lands as far as its order's steps exist (a menu, an
ask, a reply, back to the message box); the take layer's step comes with unit 18 and the simple view's with 20a.

### 3.7 What AGMessage loads and what it runs (`test/loads.test.js`, `test/resolve-preload.js`; the plan's U11)

**Only what it ships.** A `require()` that `app\node_modules` cannot answer makes Node walk every folder above the asking
file to the drive's root, then its global folders (`NODE_PATH`, the account's `.node_modules`, the runtime's
`lib\node`), and load the first it finds. The plan measured it: a `supports-color` and a `bufferutil` planted in a
`node_modules` three folders above the app were loaded by the server's own requires, and a portable folder under
`C:\Tools` walks to `C:\node_modules`, which any authenticated account may be able to make (reading R8). The fence
starts the watchdog and its server, and then the server alone, under a resolve hook (`test/resolve-preload.js`,
preloaded into both processes: Node's `module.registerHooks`, in-thread and synchronous, which only reads each
resolution) with a `supports-color`, a `bufferutil` and a `utf-8-validate` planted where Node looks once `app` has no
answer (`NODE_PATH`, which Node reads only after its walk, as a `C:\node_modules` is reached only at the walk's end),
and asks a page, health, the admin page and a socket over WebSocket of them. Each resolution is judged by
`loadProblems`: a module Node has built in passes; one answered nowhere fails (the walk went to the root, where a
planted module would load); one loaded from outside `app` fails; one in `app` that the portable folder does not ship
(`tools/build-portable.ps1`'s files and folders: a test file, a lint rule) fails; one of a package the lockfile does
not list, or lists for development only (`dev`: `npm ci --omit=dev` leaves it out of the portable folder, so a checkout
would pass where the show laptop walks) fails. The run also holds that no planted module ran, that both processes ran
under the hook (so the fence is not vacuous), that the watchdog starts its server with ws's two switches, and that the
server alone, started without them, sets them itself before its first `require` (read from the source by ESLint's
parser). A control run shows the hook seeing the walk: ws asked for without its switch loads the planted `bufferutil`
(named, its full path outside `app`), with no plant the same ask is named as answered nowhere, and with its switch
nothing is asked. Each kind of judgement is planted (a test file, a development package, a package not in the lockfile,
a URL that is no file). On the tree before U11 the fence named four loads from the plant: `bufferutil` for each of the
three copies of ws (`WS_NO_BUFFER_UTIL` unset) and `supports-color` for `debug` (not shipped, and in a checkout without
it as a development package either).

A run judges only what it reaches, and a run with TLS, the Show Bus, AI drafts and uploads off or unused does not reach
every require: a lazy one, or one inside a package on a path the run never takes. So the source is read too: every ask
of the shipped server-side scripts (`server.js`, `supervise.js`, `launch.js`, `machine.js` once it is there, `lib/` and
`verify/`), a `require` with its name written out, an import, followed through each file it reaches as Node resolves it
from the asking file (`createRequire`), the whole graph of about 590 files, read with ESLint's parser (a package's own
inline configuration ignored, so a require in a comment, as express's `require('ejs')` in its documentation, is no ask).
Each ask is a row in the hook's shape and judged by the same `loadProblems`, but those a register names: `NEVER_ASKED`,
the asks a package writes out that `app` does not answer and that AGMessage never makes (ws's `bufferutil` and
`utf-8-validate`, asked for only without their switches, which the runs above hold), and `MADE_AT_RUN_TIME`, each
require whose name is made at run time, which no reading can judge (express's view engine, `require(mod)` in
`lib/view.js`, reached only by `res.render`: the test also holds that no shipped script renders or sets up an engine).
A row whose ask has gone fails, and so does a require made at run time without its row. Without `supports-color` the
reading names `debug`'s ask; a planted tree shows an ask followed, one in a comment ignored, a name made at run time kept
apart and an ask nothing answers named. The SDK's zod helpers, which ask for a `zod` `app` does not have, are no file the
server reaches.

**Only what it names by its absolute path.** An argument array keeps a shell out, not the search: libuv looks for a bare
name in the current folder and then on `PATH`. The fence reads every script of `app` AGMessage writes (its top
folder's and every folder below but `node_modules`, the data and upload folders and the vendored libraries: the
server, the watchdog, the machine's commands, `lib/`, `verify/`, the pages, the lint rule and the tests) with ESLint's
own parser and its scope analysis, and finds each call that starts a program: `spawn`, `spawnSync`, `execFile`,
`execFileSync`, `fork`, `exec` and `execSync` (the last two banned by the lint already). `child_process` is followed as
it is required (`require('child_process')`, `node:` or not, a template with nothing in it, or `X.require(…)`, as
`module.require` and a `Module`'s), awaited from an `import()`, or imported (its default, its namespace, its named
functions by any local name), and through every name it is then given (a declaration, a default, an assignment, the
rest of a destructuring), followed until none is added. A function that starts a program is one of those read off it by
a name written out (`cp.spawn`, `cp['spawn']`) or destructured from it by any local name, any name one of these is given
(a declaration, a default, an assignment, `this.x =`), and any name of a function's own that is one of theirs (a
parameter called `spawn`). A regular expression's `.exec` and a method of that name on anything else are not theirs.
Each call names its program by `process.execPath`, by a full path written out (from the root, a drive or a network
share), or by an expression the register (`RUNS`) holds for that file, with where its full path is made; anything else
fails, a bare or relative name written out and a template with something in it included. Its options written in place
are read too: `fork`'s `execPath` is judged as its program, and a `shell` that is not `false` fails (a shell is
`cmd.exe` by `ComSpec`, else by its bare name). A program that is a parameter of a function of the file with a name,
a function only ever called, is judged at each call of that function instead (the export README's commands, run by
`run('/bin/sh', …)` and `run('/usr/bin/unzip', …)`, so a later `run('unzip', …)` fails); one handed on as a value needs
a row. Anything that holds `child_process` or one of those functions as a value where the fence does not read its calls
(passed, returned, put in an object or on a member other than `this.x`, put on the exports, destructured into a member
or by a key made at run time, read by a name made at run time, an `import()` not awaited, called through `.call`) is
named in `HANDED` with whose calls it becomes, or fails; and `child_process` handed to a call the fence does not follow
(a `require` given another name, `require.call`, `createRequire`'s) or re-exported fails, so nothing reached through
it goes unread (a name made at run time, as `require(name)`, is outside any reading of the source, as it is for the
module fence). A row whose call or handing has gone fails, so the register cannot grow stale. The register today: the
server's `CLOUDFLARED` (`lib/startup.js` `cloudflaredFile`: `bin` beside the folder `app` is in, by `isFullPath` a
folder named from its drive or a network share, else none) and its `spawn` handed to `openBrowser`; the watchdog's
`CHILD` (`fork`: this `node.exe` on `server.js` beside it, or on a test's stand-in `AGM_CHILD`, which a start refuses
with code 3 unless it is a full path by `isFullPath`, so on Windows never `\server.js` from the current drive's root or
`C:server.js` on a drive's current folder, before anything runs or is written); `launch.js`'s
`path.win32.join(sys, 'reg.exe')`; `lib/laptop.js` and `lib/power.js`'s `powershellPlan` file; `lib/startup.js`'s
`openerPlan` file; and the tests' own (the smoke's browser, the two preloads handing on the server's calls and the
tunnel's stand-in for a cloudflared that is not there, the readings' `icacls.exe` and `cmd.exe` for the .bat files). A
second test holds each place a path is made to give a full path or run nothing, across a `SystemRoot` named from its
drive, relative, from the root, from a drive with no folder, empty or unset, on Windows and off it: `cloudflaredFile`,
`openerPlan`, `windowsPlan`, the power request's `plan` (whose options, handed to the call by name, hold no `shell` and
no `execPath`), `adminName`'s `reg.exe` and `isFullPath` itself. On the tree before U11 the fence named
`resolveCloudflaredBin()`, whose fallback was the bare `cloudflared`; the plant shows each shape it reads failing it.
`tools/` is outside `app` and outside this fence: `tools/scan-secrets.js` runs `git` by its name, on a developer's
machine and CI.

**The machine's own commands require Node's built-ins only.** `launch.js` (and `machine.js`, which the plan's U12
makes and the fence reads once it is there) is a console the person at the PC runs, and `machine.js` runs elevated or
as SYSTEM: neither requires anything but a `node:` module, written out, nor loads code around `require` (an import,
`createRequire`, `dlopen`, `binding`, `linkedBinding`, `Module._load`, any `.require`, as `module.require` and a
`Module`'s) or reaches `require` itself as a value (given another name, `require.call`, `require.resolve`, its cache),
but `require.main`, which loads nothing. A planted relative file, package, built-in without `node:`, computed name,
import, `createRequire`, `dlopen`, `module.require`, a `Module`'s `require`, `require` given another name,
`require.call` and `require.resolve` each fail it.

## 4. Considered and not adopted

- **Type checking (`tsc --checkJs`).** Not measured this release. It would need TypeScript and JSDoc types across the
  server; the step is recorded here so it is decided, not forgotten.
- **Prettier / a house style.** No defect class; the code's own style is consistent.
- **Third-party secret scanners in CI.** The in-tree scan knows the credential shapes this ecosystem uses (`sk-ant-`,
  `swk_`, `agn_`, sealed `enc1:` values, PEM keys, GitHub, AWS and Slack tokens) and needs no account or licence;
  GitHub's own secret scanning and push protection are repository settings, recommended in `SECURITY.md`.
- **Pinning actions by commit SHA.** The workflows use major tags (`@v7`); Dependabot keeps them current. Pinning by SHA
  is the stricter choice and the maintainer's call: the Windows evidence lane takes it (the 0.6.0 plan's U7), each action
  pinned by its commit with its tag beside it, and the readings download in the release job with it; a test holds the
  lane to it. The other jobs stay on major tags.

## 5. Coverage

Measured with Node's own coverage (`--experimental-test-coverage`), which follows the server into the child processes
the end-to-end tests start. Baseline before the 0.5 features: **lines 83.1 %, branches 68.8 %, functions 77.2 %**
(`server.js` 71.9 / 54.4 / 58.3; `lib/ai.js` 40 % — the drafts need a key and the internet, so their network path is
untested by design). The gate sits a little under the measure and is raised as tests are added, never lowered to make
a build green.

At the end of 0.5, with 101 tests (was 53): **lines 89.1 %, branches 71.9 %, functions 81.4 %** (`server.js`
82.2 / 65.1 / 70.6; `supervise.js` 100 / 54.8 / 88.9). The gate went from 80 / 65 / 75 to **85 / 70 / 78**. What the
tests still do not reach in `server.js` is mostly the admin page's own room handlers (link a person to a room, delete
with files, accept a changed certificate), the tunnel, reactions and forwarding between rooms — each exercised by the
browser smoke or by hand, none yet by a test that counts.

After the review below (§6), with 233 tests: **lines 96.7 %, branches 84.4 %, functions 92.8 %**. The gate went to
**92 / 80 / 88**, then **94 / 82 / 90**. The input fence reaches every socket handler, which is most of the rise in
functions. With AG-1 (§6), 237 tests: **96.8 / 84.6 / 92.9**; the gate stays at 94 / 82 / 90. 0.5.1, with 294 tests:
**97.0 / 86.2 / 93.2**; the gate goes to **95 / 84 / 91**.

## 6. The review before release

The fences above catch what a rule can name. Before 0.5 shipped, its changes were also read by people-shaped eyes: an
independent review from six angles (socket inputs, accounts, rights inside a hall, the show network, screens and pages,
persistence and resources), each finding then given to a second reader whose job was to show it was not a defect,
reading the code and, mostly, running a test against it. 77 findings merged to 60; 59 were confirmed. Every one was
fixed with a regression test that failed first for the finding's own reason (units 9 to 15), except the parts a
finding itself marked as a product decision, which are said in the units' commits: a per-hall upload budget (the
free-space floor already keeps the stores safe; a hall cap is a governor with no measured cause), discovery bound to
loopback when AGMessage is, and approved desk notices going only to the desk's own halls.

Units 11 to 15 were worked in parallel and merged; each merge commit says what met where (one case — a field one unit
replaced and another's new code still read — was caught by its test at the merge). A last review then read them
together, four angles and a second reader per finding: 19 findings, all confirmed. Three were the papers lagging the
code (fixed in unit 16); the rest were fixed in units 18 (who is told a hall's code and facts; pages offering what the
server refuses) and 19 (a locked hall's seats across a restart; a stage send whose Stagewatch restarted; a closed hall's
pins; a refused Set up save; a test that passed only in its order; the Viewer tabs the smoke had stopped checking). CI's
Windows job then found what no reader had: on Windows a signal to a child process ends it unsaved (units 17, 17.1).
Later its Edge began to stall the smoke on a page in a background tab (a screenshot waited minutes) and to drop those
pages' live connections ("Page entered Back-Forward Cache.", which Blink logs when it freezes a page, not only for that
cache): a hidden tab is frozen. Each page the smoke drives now has a window of its own, so it is visible and never frozen
(the smoke checks that every page says so), and a DevTools call with no answer in 60 s fails by name (units 22, 22.1).
Left as product decisions: an `audit.read` holder of one hall reads the whole log (the right is node-wide by design);
a node of another hall heard on the network still appears by name in a hall's posted context; the 40 recent events
are one ring shared by every hall.

A review of the Show Bus across the four apps then found one more before the tag (AG-1): a linked Patterns' or
PlayMap's pairing token — full control of that node — went in its header over plain HTTP to a node on another machine
that was neither pinned nor announcing a certificate, and AGMessage drove the node with it. Unit 21: the token goes
only to a loopback address, or over TLS to a certificate pinned for that node or confirmed by a person typing at least
16 characters of its fingerprint from the node's own screen; anything else is refused with words and sent nothing; and
no line is sent to a node directly — it is proposed to the show desk, or refused with words. The direct path waits for
a key the node issues to AGMessage alone (Patterns' `ptk_`, PlayMap's `pmk_`). Unit 21 was then read the same way as
the rest — five angles, two readers set to refute each finding — and unit 21.1 fixed what held: a pin the Stagewatch link
had made on first use, under an id from an unauthenticated hello, counted as a person's confirmation (the Patterns and
PlayMap links now pin under a key of their own, `peer:<id>`); a refusal and the heard-nodes list still put announced
fingerprints on the page; a node on this laptop heard from its LAN address was refused as another machine; and the
tests let two one-line regressions through (a hello vouching for a certificate, a page told 8 to 15 of its characters).
Seven such mutations now fail the tests. The review also weighed the typed minimum: 8 characters are 32 bits of a
fingerprint that is public in the hello, which a certificate made for the purpose matches after about 2^32 signatures;
the owner chose 16 (64 bits, unit 21.2). Left for 0.5.1, from the
cross-app review:
Stagewatch's top-level `ok`/`words` on a proposal's outcome, a result report retried after one failure, the Stagewatch
link dialling with its own Show Bus id, and "connected" only once Stagewatch says it took the key.

0.5.1 closed those four (units 1 to 4), each read first against Stagewatch's own code (2.16, and the newest work on
two branches) and each test shown to fail on the code before it. Three readers then reviewed the units independently,
each given the code and Stagewatch's source rather than the author's conclusions, and proved what they found with
scripts (units 4.1 to 4.3). A second round reviewed those fixes from four angles — key egress and the lockout, the
desk loop, every reader, the tests' power under mutation — with each of 26 findings put to three skeptics (does it
reproduce, is it true of Stagewatch, does it matter); the 22 that two of three upheld were fixed (units 4.4 to 4.7):
Stagewatch's lockout counted as it counts it (every wrong attempt, by the Stagewatch's address, on a monotonic clock),
the desk followed in one read, a re-pointed collect, a refused collect, a read-only key, a changed certificate, and
eleven test gaps. Every mutant either round named now fails a test. The three test files of 0.5.1 assert strictly
(`node:assert/strict`): the loose `deepEqual` passes `[954]` against `[null]`.
Left as the owner's calls: whether AGMessage honours Stagewatch's Screens → Disconnect ("stay off") instead of dialling
again; whether a hall's own Stagewatch's notices reach only its own halls; whether a hall given the default
Stagewatch's address with another key should be refused (Stagewatch binds one key per node); whether keyless links are
kept; and the first dial of several wrong keys at once, the one burst the shared minute cannot see coming.

The fences the review added, beside the tests for each finding:

| Fence | Holds |
|---|---|
| `test/inputs.test.js` | every event a handler file listens to (`handlerFiles()`: `server.js` and each module in `lib/handlers/`, read from their source, so a new handler is held too) is sent every argument shape — null, numbers, strings, lists, an object `String()` cannot convert — from a socket with no sign-in, a crew account, the admin and a screen; the server answers and stays up, and the handler guard has nothing to catch. The shapes carry the outbox's keys too (`cid`, `on` and `heldMs`, null and unconvertible) and a room's code acts and its list of rooms that may send in (`codeOn`, `newCode`, `keepGuests`, `sendFrom`, `sendBack`, null; the last two as lists of an unconvertible value) and a send into another room's (`to`, `replyTo`, null and unconvertible), and the typed cases a room's hall, key and name (`room:create`, `room:update`, `room:settings`), each read as none and refused with its words, a room's code acts by type (`codeOn`, `newCode` and `keepGuests` unconvertible: each refused in its words, nothing switched and no `room.code` row), its list by type (`sendFrom` and `sendBack` not lists of strings: each refused in its words, no list set and no `room.sendFrom` row), and a send by type (`room:send`'s room, message, words, file, kind and client id unconvertible, to a room it may send into and to none: each refused in its words, nothing sent and no `room.send` row; `room:sendTargets` given anything answers its list), and a send taken back by type (`room:withdraw`'s message and client id unconvertible: no message, nothing withdrawn and no `room.withdraw` row) |
| `test/sessions.test.js` | sign-in refusals say nothing more than a wrong password does; a stranger's guesses cannot lock the laptop or the venue out; a session's end reaches its open pages; a page in use keeps its session, under a moved clock |
| `test/uploads.test.js` | uploads stop before the disk fills; files nobody posted are removed; a reset or a deletion removes its own files and no one else's |
| `test/shownet.test.js` | the discovery table is bounded; Stagewatch's numbers never cross a restart or a relink; a node's changed certificate is accepted only by typing the start of its fingerprint, and the page is never told it |
| `test/deskresults.test.js` | what an approved notice did reaches Stagewatch's desk: a 429 holds the whole link for its Retry-After, 401/403 wait for the key, no answer backs off; a result outlives a restart of AGMessage, a hall's link made again and a refused key; after the first post it goes only to the proposal that ran (read back), never to a restarted desk's proposal of the same number, seen or not; a 409 is final; the notice runs once |
| `test/stagekey.test.js` | a Stagewatch link is connected, and a first-use certificate pinned, only once Stagewatch accepted the key (2.18's auth message, or for 2.16 an authenticated read — never a frame); each socket earns its own verdict; a refusal stays the status, lets the socket go, reaches every page, the context and the audit log, and costs Stagewatch's lockout at most two wrong attempts a minute |
| `test/showbus.test.js` (AG-1) | a node's token never leaves on a plain connection to another machine, nor over TLS to a certificate nobody confirmed (every request a link makes is recorded); `send()` and `mode: "send"` are refused with words and nothing is posted to a node |
