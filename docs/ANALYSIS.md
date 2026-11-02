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
| Version | `node tools/stamp-build.js --print` / `--check-tag` | CI · analyze | a release tag that names another version |
| Unit, end-to-end, watchdog, TLS, version, lint-rule tests | `npm test` | CI · Linux (Node 24, 26), Windows | any failure |
| Coverage gate | `npm run coverage` | CI · Linux (Node 24) | lines < 95 %, branches < 84 %, functions < 91 % of `server.js`, `supervise.js`, `lib/`, `verify/` |
| Browser smoke | `npm run smoke` | CI · Linux (Chrome), Windows (Edge) | a page that does not join, render, or that logs a script error or a CSP violation; a PDF or a Word file the Board's panel does not draw, or a deck a screen does not, in a browser without `Promise.withResolvers` in the page or in pdf.js's worker (as an iPad before 17.4), or a PDF drawn without the worker file defining it in the worker itself (pdf.js's fallback in the page) |
| CodeQL `security-extended` | — | Security · codeql | an alert (shown under the repository's Security tab) |
| Dependency audit | `npm run audit` (`npm audit`, then `tools/vendor-audit.js`) | Security · audit (and weekly) | a high or critical advisory in a shipped package; a package whose registry signature or provenance does not verify; a high or critical advisory against a version `app/public/vendor/VENDOR.json` lists (a vendored file's package or a library bundled in it) that `VENDOR.json` does not assess, or assesses at another severity, or a registry that does not answer |
| Dependency review | — | Security · on a pull request | a new dependency with a moderate or worse advisory |
| The .bat files | `npm test` (`test/startbat.test.js`) | CI · Linux (read as text), Windows (run by cmd) | delayed expansion, a bare program name, the install record read outside the 64-bit view, the preflight after anything started, code 0 and 3 sharing words, a line ending that is not CRLF; on Windows, a missing `node\node.exe` not said or not exit 2, a clean copy made into a folder that exists |
| The bundle start | — | CI · package | the extracted zip's own Node and watchdog not answering `/api/health` with the stamped build within 30 s |
| The vendored libraries | `npm test` (`test/vendor.test.js`) | CI · Linux, Windows | a file in `app/public/vendor` not in `VENDOR.json`, a listed file missing, bytes that are not its SHA-256, an entry with no licence, notice or copyright, a licence not on the allowed list (Apache-2.0, MIT, BSD-2-Clause, BSD-3-Clause, MIT AND Zlib, MIT OR GPL-3.0-or-later taken as MIT), a `licenses/` folder whose text is not the licence named or lacks the copyright, a folder no entry claims, a listed file no page loads or a page loading one not listed, a `THIRD-PARTY-NOTICES.md` table that is not the list or that leaves out an advisory, an advisory with no assessment or an assessment that applies without saying what bounds it, a version inside jszip's bundle without where it was read, pako not 1.0.5 by its code, a BSD-3-Clause text filed as BSD-2-Clause, a paper that says which browsers draw a PDF without the floor, the portable build, the SBOM step, `npm run audit` or the Security workflow without them; pdf.js not 4.10.38's legacy build, or not defining `Promise.withResolvers` where it is missing |
| SBOM + SHA256SUMS + build provenance | `node tools/vendor-sbom.js <sbom> --tree <bundle>` adds the vendored files, read from the bundle as the zip extracts it, to npm's SBOM, with each advisory's analysis | CI · package, release | a release is published only with them; a shipped vendored file whose bytes are not the ones `VENDOR.json` records, or a bundle without the checkout's `VENDOR.json`, `THIRD-PARTY-NOTICES.md` and every licence folder an entry names, stops the SBOM's step |

Locally: `npm run check` runs the analyzers, the secret scan and the tests with the coverage gate.

`npm test` runs the test files in parallel, and the end-to-end ones each start real servers through `test/helpers.js`
`startServer()`, on a throwaway data folder and a port `freePort()` chose. That port is free only when it is chosen
(the system's choice, let go before the server binds it), so another file's server or connection can take it in
between: once, on Linux, a test failed with "AGMessage 0.6.0 (build …) is already running on port …". A server that
says its port is held (`lib/startup.js` `portHolderWords`, whoever holds it) has stopped before writing anything, so the
helper starts it again on the same data folder and a fresh port, 5 ports in all, and only for that reason: a server
that stops for any other, or does not serve within 15 s, fails the test with its own words as soon as it has gone. A
port a test names (`PORT`, as `restartServer()` does) is tried once and never moved. `test/helpers.test.js` holds it
with ports held on purpose, so every run is the same: a port held by another program and one held by a running
AGMessage, then a fresh one that serves; a port held on every try, refused after 5; a named port refused once with the
holder's words; a held data folder refused at once, on one port.

A test run leaves the temp folder as it found it. Left there, the tests' folders filled a development machine's disk
(some 70,000 `agm-*` folders, about 30 GB), and below 1 GB free the server pauses uploads, so the uploads test failed
with 507 whatever the code. A data folder `startServer()` makes is its server's: `stopServer()` removes it, with the
`-keys` and `-uploads` beside it, once the server has exited, and `restartServer()` keeps it for the restart. Every
other folder is made with `tmpDir(t, prefix)` and is its test's: removed when the test ends, but never while a server
runs in it (each server is counted in every throwaway holding its folders or a file its env names; a test that spawns
a process itself counts it with `occupy()`). A test that starts a server on a folder again, or reads one after its
server has stopped, makes the folder with `tmpDir`, and `startServer()` refuses a folder already removed rather than
serve it empty. Whatever a test that failed part way leaves, and a folder made again by a save still pending in a store
in the test's own process, is removed when that file's process exits. The browser smoke removes its folders and the
browser's profile once the browser (closed with `Browser.close`) and every server it started have gone.
`test/helpers.test.js` holds it: a server's folder gone at its stop and kept across a restart, a test's kept while its
server runs and gone once the test ends, a removed folder refused.

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
(`reportUnusedDisableDirectives`), so a silenced rule says why on its line or the build stops.

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
`spawn` on `PATH`: the browser opener spawns `%SystemRoot%\explorer.exe` with an argument array and no shell, inside the
`child_process` fence (`lib/startup.js`), and runs nothing when `SystemRoot` does not name a folder from its drive; the
.bat files run `reg.exe`, `timeout.exe`, `robocopy.exe` and `powershell.exe` from `%SystemRoot%\System32`.
`test/startbat.test.js` holds the .bat files to it, with CRLF and ASCII throughout.

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
it did not see. `verify/` joins the files read, at 0: the audit log's key-free rules (`verify/auditrules.js`) are pure,
and their own ESLint block turns off every Node global the shared block gives (so `require`, `process`, `Buffer` or
`console` there is an undefined name), gives no browser global, and refuses any use of `module` but `module.exports` and
any `import()`: a probe that reads a file there fails the lint.
`verify/` is under the coverage gate with `server.js`, `supervise.js` and `lib/`.

The audit log's export adds `lib/auditexport.js` and `lib/zip.js`, and the verifier `verify/verify-audit.js`, each at 0
synchronous calls (the guard names them, so a file that drops out of its list fails it): the export reads, digests and
streams on the thread pool and in slices, and the verifier on another computer reads through `fs.promises` only. The
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
in an archive's `log/`. The speed fence beside the split's (a page asking `/api/auth/me` waits at most 300 ms while the
56,000-entry seed is split at entry 50,000) holds an archive's own Check of the 49,999 entries split off to the same
bound: the folder check takes a turn of the event loop every 1,000 lines when the reader hands it one (`io.turn`, which
the Node verifier gives and the page needs not), and the MAC walk every 1,000 entries.

0.6.0 adds the pages' message channels to it: every `postMessage` in a page script under `public/` names this origin as
its target, never `'*'`, and every `message` listener's first line returns unless both the sending window and its origin
are the ones expected (the admin's support view hears only the admin page that frames it). A post or a listener written
in a shape the guard does not read, or an `onmessage` handler, fails it too.

## 4. Considered and not adopted

- **Type checking (`tsc --checkJs`).** Not measured this release. It would need TypeScript and JSDoc types across the
  server; the step is recorded here so it is decided, not forgotten.
- **Prettier / a house style.** No defect class; the code's own style is consistent.
- **Third-party secret scanners in CI.** The in-tree scan knows the credential shapes this ecosystem uses (`sk-ant-`,
  `swk_`, `agn_`, sealed `enc1:` values, PEM keys, GitHub, AWS and Slack tokens) and needs no account or licence;
  GitHub's own secret scanning and push protection are repository settings, recommended in `SECURITY.md`.
- **Pinning actions by commit SHA.** The workflows use major tags (`@v7`); Dependabot keeps them current. Pinning by SHA
  is the stricter choice and the maintainer's call.

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
| `test/inputs.test.js` | every event `server.js` listens to (read from its source, so a new handler is held too) is sent every argument shape — null, numbers, strings, lists, an object `String()` cannot convert — from a socket with no sign-in, a crew account, the admin and a screen; the server answers and stays up, and the handler guard has nothing to catch |
| `test/sessions.test.js` | sign-in refusals say nothing more than a wrong password does; a stranger's guesses cannot lock the laptop or the venue out; a session's end reaches its open pages; a page in use keeps its session, under a moved clock |
| `test/uploads.test.js` | uploads stop before the disk fills; files nobody posted are removed; a reset or a deletion removes its own files and no one else's |
| `test/shownet.test.js` | the discovery table is bounded; Stagewatch's numbers never cross a restart or a relink; a node's changed certificate is accepted only by typing the start of its fingerprint, and the page is never told it |
| `test/deskresults.test.js` | what an approved notice did reaches Stagewatch's desk: a 429 holds the whole link for its Retry-After, 401/403 wait for the key, no answer backs off; a result outlives a restart of AGMessage, a hall's link made again and a refused key; after the first post it goes only to the proposal that ran (read back), never to a restarted desk's proposal of the same number, seen or not; a 409 is final; the notice runs once |
| `test/stagekey.test.js` | a Stagewatch link is connected, and a first-use certificate pinned, only once Stagewatch accepted the key (2.18's auth message, or for 2.16 an authenticated read — never a frame); each socket earns its own verdict; a refusal stays the status, lets the socket go, reaches every page, the context and the audit log, and costs Stagewatch's lockout at most two wrong attempts a minute |
| `test/showbus.test.js` (AG-1) | a node's token never leaves on a plain connection to another machine, nor over TLS to a certificate nobody confirmed (every request a link makes is recorded); `send()` and `mode: "send"` are refused with words and nothing is posted to a node |
