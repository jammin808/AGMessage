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
| Coverage gate | `npm run coverage` | CI · Linux (Node 24) | lines < 85 %, branches < 70 %, functions < 78 % of `server.js`, `supervise.js`, `lib/` |
| Browser smoke | `npm run smoke` | CI · Linux (Chrome), Windows (Edge) | a page that does not join, render, or that logs a script error or a CSP violation |
| CodeQL `security-extended` | — | Security · codeql | an alert (shown under the repository's Security tab) |
| Dependency audit | `npm run audit` | Security · audit | a high or critical advisory in a shipped package; a package whose registry signature or provenance does not verify |
| Dependency review | — | Security · on a pull request | a new dependency with a moderate or worse advisory |
| SBOM + SHA256SUMS + build provenance | — | CI · package, release | a release is published only with them |

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
