# Changelog

## 0.6.0 — 2026-11-08 — rooms within halls, people's screens and the Board's view

Built from `docs/plan/0.6.0/PLAN.md`, one commit per unit in its global build order, opened on 2026-10-31 and closed on
2026-11-08 by its last unit (#81, "0.6.0 closes", below). 80 of its 81 units are in it; the group commit (#79) is
0.6.x's, since the reading it waits for has not been taken. Its evidence: the owner's answers
(`docs/plan/0.6.0/DECISIONS.md`); the code with its tests and the browser smoke, run on Linux before each unit's
commit; CI's runs on Linux and Windows at each push, the last three before the close not whole (below); and CI's
Windows readings of run 101. Nothing in it is measured on the show laptop or walked on a Board device yet
(`docs/DESIGN.md`, `docs/DEVICES.md`). The tag `v0.6.0` and its release are the owner's, and wait for that walk and
for a CI run that passes whole, the installer's life cycle among it.

**The audit log**
- The admin's room controls are audited, one row for each change, written before the admin page is answered: a hall made
  from the admin page (`hall.create`, as one made over HTTP already was), a hall's session reset (`room.reset`, with how
  many files left the disk), a message removed (`message.remove`: whose it was and its kind), a guest's role set
  (`seat.role`), roles locked or unlocked (`room.lock`, with the seats kept), a guest let forward into another hall or
  no longer (`room.link`, `room.unlink`), a person sent out (`seat.kick`, with the pages closed) and the AI's minutes
  posted (`minutes.post`). Each row's target is the hall's code (none for a page sent out before it joined a hall), and
  its words name people and halls, never a message's text, a file's name or a token; the hall a guest may forward into
  is named by its name ("another hall" when it has none), never by the code its guests join with. A control that
  changes nothing (a role set to the one already held, roles locked again on the same seats or unlocked again, a link
  the guest already has, one that is not there taken back) writes no row. In 0.5.1 none of these was recorded.
- Each proposal Stagewatch's show desk takes from a hall is one `stagewatch.propose` row: who asked (the account, or a
  code guest by name), for which screen, how many characters and the desk's proposal number, never the words. The
  papers said these proposals were audited; in 0.5.1 they were not. A proposal the desk refuses writes no row (its
  refusal's words could repeat the text).
- A screen take's row (`display.take`) says which screen and what kind of thing went on it — "a warning (28
  characters)", "an urgent message (19 characters)", "a PDF at p. 3", "an image", "the countdown with words (8
  characters)" — never the message's words or the file's name. 0.5.1 wrote a message's first 60 characters and the
  file's name; rows already written keep what they say. The console and the halls board still quote and name them.

**Health, and a show day's peaks** (the code and its tests; nothing in it is measured on the show laptop yet)
- Health reads the loop's true delay: each 5 s window's p99 less the sampler's own 10 ms resolution, which 0.5.1 counted
  as delay, so an idle server showed about 10 ms it did not have. The reading is lower than before. The admin page's
  health line reads "loop delay p95 … ms (max …) · busy … %".
- Appended to `/api/health`'s detail (the admin and this laptop only), at its end: `elu` (how busy the loop was, 0 to 1,
  per 5 s window over the last 10 minutes), `rssMb`, `maxSocketsPerAddress` and `tunnelSockets` (counts of the sockets
  open now, never an address), `largestHall {messages, kb}` (the snapshot's size, kept as each snapshot is written, so
  no file is read for it), `latest` (what the halls board's and the screens' coalescing saves: changes marked, frames
  sent), `peaks` and `showDay`. A screen's socket is counted as through the tunnel as a page's is.
- A show day's peaks are kept for the last 14 show days. A show day runs from 06:00 to 06:00 by the laptop's clock and
  is named by the date it starts, so an evening that runs past midnight is one day's. Each keeps the highest loop delay
  and busy share of a 5 s window, the most sockets from one address, the most through the tunnel, the largest hall's
  messages and size, the most people seated in one hall in any 5 s (read at each join, so a storm the 5 s tick falls
  in is read whole), the longest snapshot write with its hall's message count, and every audit append's time (open,
  write, fsync, close: what an audited action already waits for) as a count, a p99 and a max. They are saved in
  `peaks.json` through a write lane of their own, named in health like the others, at the end of each 5 s window in
  which one rose; a stop, or a crash the server catches, writes them at once, the audit's last appends included. A hang
  the watchdog ends, or a power cut, can lose that last window's. They are read back at start, so a restart keeps the
  day, and written only once this copy holds its data folder. They hold numbers and days, never a hall, a name or an
  address. The admin page reads "today's peaks: …", today being the show day the server names (`showDay`), not the
  browser's. They are the readings `docs/DESIGN.md`'s new table, "Measured on the show laptop", waits for; each of its
  rows says "not measured" until a show or a rehearsal fills it.
- Timing a snapshot or an audit append never reaches what it times: a fault in health's bookkeeping leaves the snapshot
  written and the audit entry on disk.
- Rolling back: 0.5.1 ignores `peaks.json` and the new health keys.

**Joining fails closed, and a page hears only who may speak to it**
- A join whose role is not one the page offers (`admin`, `7`, `Board`, a list) is refused: "Choose On stage, Backstage
  or Observer.", and nobody is seated. 0.5.1 seated it as an observer. No role is still an observer (the page's
  default), `director` (the old name) is still On stage, and an account's role is still its rights', whatever it sends.
- A browser signed in to an account is refused a code join: "You are signed in as Ana: open the room from your halls, or
  sign out to join with a code." In 0.5.1 a Viewer or Staff account that had a hall's code could seat itself backstage
  as a guest, with the stage its account does not hold. An account with a one-time password not yet changed counts as
  signed in. The refusal is not a guess at a code, so it spends nothing of the code lockout. The admin's support view,
  and the host token's admin (who has no account), are unaffected. The sign-in page, opened from a code link in a
  signed-in browser, says the same and offers "Open your halls" or "Sign out", after which the code is there to use. A
  guest's hall page refused this way leads back to that code link, keeping the code and an invite's role. A one-time password
  not yet changed is asked for first, a code link included.
- One person's pages (their devices, and the admin's support view of them) are kept in step with only what a page
  applies: the theme, the text size, the On stage panel folded, the split and the document open, each read by its type
  and sent on as rebuilt. 0.5.1 sent on whatever a page sent, up to 4 KB.
- The admin's support view resyncs only when the admin page that frames it asks: its parent, from this origin. In 0.5.1
  any window could ask it, a frame inside it included. The admin page's Resync is sent to this origin only. A source
  guard holds both: a page's `postMessage` never targets `'*'`, and a `message` listener first checks who sent it.
- Rolling back: nothing is stored; 0.5.1 joins and relays as it did.

**Starting a copy says what is wrong, and the browser opens on the copy that serves** (the owner's report from the show
laptop, 2026-10-26, with the start window's text; the .bat files are first run by cmd in CI's Windows job, and the
browser opening is not yet seen on a Windows desktop)
- What the window said: "The system cannot find the path specified.", then "Server stopped.", and the browser opened on
  a working AGMessage all the same. It was cmd failing to find `node\node.exe` beside the .bat: most likely the .bat
  was started from inside the zip (Explorer copies out only the file opened), else from a checkout (which has no
  `node\`), or an antivirus removed it. cmd's "path not found" is code 3, which the .bat read as AGMessage's "cannot
  start as configured" and called "Server stopped". The browser opened because the .bat opened `http://localhost:3023`
  after 2 s whether or not this copy started, so whatever already served on 3023 answered: an AGMessage left running
  from an earlier start, possibly an older build.
- `start-agmessage.bat` first checks that `node\node.exe`, `app\supervise.js`, `app\server.js` and `app\node_modules`
  are beside it, and names the one missing with its likely cause: "This copy is missing node\node.exe. Download the
  portable zip again and Extract All. If it keeps going missing, your antivirus may be removing it.", or, from a folder
  under `%TEMP%`, "AGMessage was started from inside the zip. Close this window, right-click the zip, choose Extract
  All, and run start-agmessage.bat from the extracted folder." It then ends with a code of its own (2) and opens
  nothing.
- The window says why it ended: code 0 "Server stopped.", code 3 "AGMessage did not start - the reason is above." (the
  server's or the watchdog's words). Its banner names the folder it starts from, and on a PC where AGMessage is
  installed (`HKLM\SOFTWARE\AGMessage`'s `Version`, read by `reg.exe`'s absolute path, in the 64-bit view whatever cmd
  runs it) it says "AGMessage <version> is installed on this PC and starts with Windows. This window starts a separate
  portable copy." Delayed expansion is gone: a folder whose name held a "!" lost it, and with it the path.
- The browser opens on this copy, and only once it serves. The .bat asks (`AGM_OPEN=1`) and the server opens
  `http://localhost:<PORT>` after it listens, through `explorer.exe` by its absolute path under `%SystemRoot%`, with an
  argument array and no shell: once per start of the window, never on a watchdog restart, never in the installed
  node's channel (`AGM_RUNS` anything but `portable`), whatever `AGM_OPEN` holds. A failure to open is one console
  line, and the copy keeps serving.
- Not yet seen: no test starts `explorer.exe` (each stands in for it and records the call), so the browser coming up in
  front, started with `windowsHide` as the plan gives it, is the first thing to check on the show laptop's next start of
  the .bat. If it does not open, `http://localhost:3023` opened by hand is the same page.
- A port in use names its holder. The copy reads `http://127.0.0.1:<PORT>/api/health` once, within a second, sending no
  token, and takes only the version, the build and whether it is the installed node (`install.runs`), cleaned of
  control characters: "AGMessage 0.5.1 (build …) is already running on port 3023. Use its window, or close it and start
  this copy again.", "The AGMessage installed on this PC (0.6.0, build …) is serving on port 3023. Open it from Start →
  AGMessage → Open AGMessage, or set PORT to another number to run this copy beside it.", or "Another program is using
  port 3023. Close it, or set PORT to another number." The installed node (`AGM_RUNS=task`, which no build sets yet)
  has words of its own: "Another copy of AGMessage, 0.6.0 (build …), holds port 3023. Close its window: AGMessage
  takes the port back on its next try." or "Another program is using port 3023. AGMessage tries again; AGMessage
  status names the program's process." The answer only chooses the words. 0.5.1 said "Close the other AGMessage
  window" whoever held the port. A copy refused at the port first stops its Stagewatch, hall and peer links and its
  discovery, started before the port was known, so it says nothing more on the show network while it reads the holder,
  and it stops (code 3) whatever the read does.
- `docs/INSTALL.md` is begun with what the server and the .bat already do about an installed AGMessage: it opens no
  browser and has no window, its words for a port in use, and what a portable copy says beside it. The installer's
  units write the rest; no build installs AGMessage yet.
- CI runs the shipped bundle: the package job extracts the zip, starts its own `node.exe` and watchdog, and
  `/api/health` must answer within 30 s with the build the run stamped. Until now CI built the zip and never ran it.
  The release notes and `README.txt` say Extract All, and the .bat files are run by cmd in the Windows job.
- The portable zip is `AGMessage-Portable-<version>.zip` and holds one folder, `AGMessage`, whatever the build (the
  owner's answers, 2026-11-03: the top folder "AGMessage", and the zip "AGMessage-Portable-<version>.zip"). 0.5's zip was
  `AGMessage-Portable-Windows-<version>.zip` holding a folder of the same name, so Extract All, which makes a folder named
  after the zip, said the build's name twice in every path: 47 characters each time for a CI build. A clean copy
  (`make-shareable-copy.bat`) is now `AGMessage-Portable-clean-<date>-<time>`. Upgrading: extract the new zip into a new
  folder, as Extract All proposes; every build's folder is now called AGMessage, so extracting into the folder that holds
  the old copy would lay the new build's files over the old one's (`README.txt` says so). CI checks that the zip holds
  that one folder and starts it from there, and the release's notes and the readings lane read both names (the lane
  takes the release a zip is from its name, `releaseOf`, as the folder no longer says it).
- CI holds every path the zip makes once extracted under Windows' limit (the owner's ask, 2026-11-03: "a CI check that
  the longest path inside the portable zip, plus a realistic extraction base like a Downloads folder and the zip's own
  name, stays under 260"). The package job's step after the build (`tools/zip-paths.js`, new) lays each member as
  Extract All does, under `C:\Users\<20 characters>\Downloads` (the profile folder of the longest user name Windows
  takes), then the folder named after the zip, then `AGMessage`; and again as a clean copy beside `AGMessage`, under the
  longest name the .bat gives one (numbered -99). A file's path must stay under 260 characters and a folder's under 248
  (MAX_PATH, and CreateDirectory's room for an 8.3 name: Explorer is not long-path aware), or the job fails naming each.
  Measured on CI run 83's zip laid out as now: the longest file in `AGMessage` is 208 of 259, 51 to spare (254, 5 to
  spare, with the zip's name said twice), and the longest anywhere is that file in a clean copy, 240 of 259, 19 to spare;
  the longest folder, the SDK's `src` copy of its folder in a clean copy, is 211 of 247. The longest is a file of the
  Anthropic SDK's. What is not covered, and said: a profile folder Windows renames `<name>.<COMPUTERNAME>` because one of
  that name was there already (up to 36 characters: today 256 of 259 there, 3 to spare), and a CI run's zip extracted
  inside the artifact zip GitHub wraps it in (every path longer by its 59-character name: 300, over). `README.txt` and
  `README.md` now say to move the inner zip to Downloads first. `--base` takes an absolute folder only.
- A CI run's development build is an artifact of its own, `AGMessage-Portable-<version>.zip`, the zip itself
  (upload-artifact's `archive: false`, named after the file), so it is extracted as a release's is and the path check
  above measures it as it lands. The run's other artifact, `agmessage-portable-<commit>`, a zip around the zip, stays
  for the readings and the release. Run 86's, downloaded, is the zip itself: `AGMessage-Portable-0.6.0-dev.86_b25ab0c.zip`,
  one folder, `AGMessage`, its 5,222 members. `README.txt` keeps its words for the other artifact.
- The Windows readings are never cancelled once they run (the owner's choices, 2026-11-03: not to lose a lane to a
  newer push, and then for a regression to show on a push, not only on a tag or a run asked for by hand). The
  workflow has no group for the whole run any more: each job has its own. The tests and the zip of a newer push or
  pull request cancel the older run's, as before (a run asked for by hand has groups of its own, which a push never
  touches); the readings run for every push, a tag and a run by hand, never a pull request, one at a time per branch or
  tag, and a newer push's wait their turn, the newest waiting taking the place of an older one still waiting. Every
  lane runs whole: a push to the branch cancelled one half-taken, which cost a whole run once. The release still waits
  for the lane and is never held by it.
- Windows-only test failures show on Linux first (the owner's choice, 2026-11-03): CI's red Windows runs included tests
  that read a source with its CR LF line ends and matched LF, and a UDP port taken from a free TCP port, each found one
  20-minute run at a time. A new job, `test-crlf`, checks the tree out again on Linux with Windows' line ends
  (the vendored files left byte for byte, and both said if not so) and runs the suites, and the zip waits for it. Every
  test reads the checkout's text through one helper, `readSource` (LF on every checkout), and takes a port from
  `freePort` (TCP) or `freeUdpPort` (UDP, new); a house lint rule, `agm/test-helpers`, refuses a test's own text read of
  the checkout (followed back through what a name in its path was made from, a const's initialiser or a parameter's
  default, so `(f, root = ROOT) => …` is caught too) and a port picker of its own (`free…Port`, never `findExport`). 53
  reads in 18 test files and three port pickers moved to them; one of them, `loads.test.js`'s check that `server.js`
  switches ws's helpers off before its first require, matched nothing on a CR LF checkout and passed whatever the file
  said. Nothing that
  ships changed.
- Rolling back: nothing is stored; 0.5.1's .bat and server start as they did.

**The audit log is keyed** (the owner's list, 2026-10-26: "Switch the audit chain to HMAC"; the owner's answers B, "Yes",
Accept belongs to the laptop's token, and C, "First start should ask", with questions 2 and 4 at their defaults)
- Each entry is chained to the one before it as before, and carries its own HMAC-SHA256 under a key derived from this
  laptop's machine key (HKDF, one label per use), with the log's id (`l`) and the key's id (`k`, which is not part of
  the key). 0.5.1's SHA-256 needed no secret, so anyone who could write the data folder could write the whole chain
  again and it checked; now an entry written, rewritten or relabelled without the key does not. A line is an entry only
  when it is exactly what it parses to, with exactly its fields in their order: a repeated key, an extra field or a
  reordered or upper-cased one is "not a whole entry". The rules that need no key are one file,
  `app/verify/auditrules.js`, which a checker on another computer will run as the laptop does.
- The key changes only at a boundary entry that names the run before it: `audit.keyed` (0.5.1's plain entries, from
  entry 1), `audit.rekey` (another computer or Windows account's key, or a run without this laptop's key),
  `audit.unkeyed` (plain entries after keyed ones: 0.5.1 again, or anyone who could write the folder) and
  `audit.keyless`. Entries not under this laptop's key are a span, said in this laptop's own words, never in the
  words the entries carry.
- Its records live outside the data folder, beside the machine key (`<key folder>\audit\`, MACed under a second derived
  key): the newest entry on disk (counted once its fsync returned, so the head never claims what a power cut can take),
  the log this laptop wrote last and where, which log each file path last held, and whether this laptop has keyed a log.
  Read once at each start and compared with the log, they find what 0.5.1's chain could not: entries removed while
  AGMessage was stopped ("entries 1201 to 1630 are missing: this machine recorded entry 1630; the log ended at entry
  1200"), a fork, the whole log removed or another put in its place (also across a move to a new folder), and a head
  changed, missing or under another key. Each is an entry of its own (`audit.cut`, `audit.head`), a line in the black
  window and in health (`saves.stores.audit.attention`), and a finding of every check until it is accepted. The entry
  this laptop recorded last, found with the hash it recorded but under another key id (the newest entries relabelled,
  or cut and padded to look like another computer's), is a changed entry: ✕ at every check from then on, never a span
  and never accepted. A record that cannot be read (a backup tool holding the head, `keyed.json` or the keyless marker)
  leaves that start △ and is never written over; while the head cannot be read, its lane stays off for the run. The
  records are written once the log holds an entry on disk that carries its id: a copy started and stopped before anyone
  signed in records nothing, so its next start, or a 0.5.1 log copied in after it, is not read as a log removed. A log moved to a new folder
  (a portable upgrade) is followed by its id, and `audit.moved` says where it was. A half-written last line is kept aside
  (`audit-torn-<time>.bin`) before it is cut. The head's lane (`auditHead`) is named in health with the other stores,
  and a stop puts the waiting entries on disk first, then the head that covers them, then every other store (0.5.1
  saved the stores first, and its last entries were in no head).
- The check answers with one of four marks, each a shape beside its colour: ✓ Intact, ◇ Linked (entries this laptop
  cannot check, accepted on it: never ✓), △ Not vouched for, ✕ Broken. Each row of Accounts → Audit log carries its
  mark too; a line that is not whole is listed as one. `ok` is true only for ✓, and every other answer carries its
  words as `error`, so a page cached from 0.5.1 shows "Not checked" rather than ✓. The whole log is checked once at
  each start, beside the show, so health and the rows read what the log holds from the first minute. What that check
  finds that the start itself did not (a finding an earlier start left open, a line changed while AGMessage was
  stopped) is said in the black window once it answers, and the browser opens only then, on the admin page when
  anything needs the person at the laptop. A check broken at a line is what health, the black window and Admin → Health
  read (✕, with its line, and nothing offered to accept) until a whole check replaces it.
- The first start of 0.6.0 on a 0.5.1 log asks, under the token in the black window: "entries 1–811 have plain hashes,
  as AGMessage 0.5.1 and earlier wrote them; anyone who could write this folder could have rewritten them. If this log
  has been in your hands, accept them … Until then the log reads △. Nothing waits for this." The browser opens on the
  admin page, where Health asks the same. The words name the running version and say "0.5.1 and earlier", never where
  the entries came from.
- Accept is the laptop's token, typed into the dialog on Admin → Health at the laptop (`POST /api/audit/accept`): never a
  sign-in, which is a record in the data folder anyone who can write it could add, and never an account. Each open
  finding has its own tick, △ ticked and ✕ unticked, a ✕ accepted only with a second tick that says what accepting it
  means. The request carries the digest of the check it was shown, refused when the log changed since. A wrong token
  counts toward the token sign-in's lockout and writes `login.token.fail` "a wrong admin token (at Accept)". The
  acceptance is an entry (`audit.accept`, the ids as its target) and takes effect once it is on disk; until then the
  answer says "not accepted yet". An admin account sees the findings and "Accept this on the AGMessage laptop", with no
  button. `/api/admin/me` gains `token` at its end: true only for a token sign-in made by this run at this laptop. The
  token at the laptop may run the check (`/api/audit/verify`).
- The machine key is never replaced. 0.5.1 made a new one on any read error and wrote over the old, which lost the
  sealed Stagewatch and AI keys. A missing key is made in a whole temporary file and published by a hard link that
  never replaces one (two first starts at once keep one key). A key that cannot be read (EBUSY, EACCES), one that is not
  a key, or a key folder that cannot hold a link ("the key folder … cannot publish the machine key (EPERM): it needs an
  NTFS drive") makes a keyless run: it starts and signs in, opens its log with `audit.keyless` under a key of its own,
  marks the run in the key folder so the next start says "written here while this machine had no machine key", seals
  nothing (a key or token typed is refused with the reason, and so are a new screen and a screen's new link, whose links
  are kept sealed; the context token lives in memory for the run, and New token replaces that one and says it lasts this
  run only), and says so in the black window and health. The key that will sign exports is derived each time it signs,
  never kept.
- The data folder is held under two names when they differ: 0.5.1's (its path as given), so 0.5.1 and this version on
  one folder refuse each other, and the folder's own, from its real path, so two paths to one folder (a link, a
  junction, a `subst` drive) are one folder.
- What it still cannot show is said in `docs/ACCOUNTS.md`, `SECURITY.md`, `README.txt` and the header of `audit.js`:
  above all, anything done by someone who can change AGMessage's code or holds the machine key, which in the portable
  layout is anyone who can write the AGMessage folder. `README.txt` says where to keep the folder, and what a "Key
  folder:" line in the black window means.
- Rolling back: 0.5.1 reads a keyed log as "✕ Broken at line 812: entry 812 was changed after it was written" (its
  first keyed entry's number) and writes on with plain hashes; it ignores the records. Back on 0.6.0, the entries it
  wrote are a span (`audit.unkeyed`), △ until accepted.

**The audit log is exported, signed, and checked on another computer** (the owner's answer A, 2026-10-26: "The log must
be exportable"; answers 1 and 3 of 2026-10-27 at their defaults: the admin and the laptop's token export, others by an
admin's grant, and an export at the end of each show day)
- Export… (Accounts → Audit log, and Admin → Health) makes one zip as it streams, `POST /api/audit/export`, and keeps no
  copy: every file of the log byte for byte, up to and including the export's own entry; `manifest.json` (the log, the
  key id, the range, the head, and the laptop's own check run through those bytes, its mark, words and findings);
  `SHA256SUMS` over every file; its Ed25519 signature by this laptop's signing key, derived from the machine key when it
  signs and never stored; the public key; a README that says how to check it and what it proves and does not; and the
  verifier. Each entry keeps its HMAC: the MACs are checked on the laptop, and the export carries that check, signed.
- Its own entry first: `audit.export` (the range and the key's short form) is on disk before any file is listed, then
  `audit.export.sent` with the zip's SHA-256 once the last byte was handed to the system ("sent", never "received"), or
  `audit.export.fail` with why (the browser went away, a file changed while it was exported, the disk would not take
  the entry). What is sent is what was checked: the files are listed once and opened, the check reads through those
  handles, and each file's SHA-256 is taken again as it streams. A rotation between the listing and the opens lists
  and opens them again (at most three times), and the export ends at the file its own entry was rotated into. One
  export at a time ("an export is being made for Ana since 14:02: try again when it ends"). Cancel (or Escape) while it
  is made stops it: the request is aborted, the log says it was not sent whole, and nothing is saved. A run without the
  machine key, or a copy with no verifier to ship, is refused with the reason and writes nothing.
- Who: the right `audit.export`, admin-only: the admin role holds it, the manager preset does not, only an admin grants
  it, and an account holding it is changed only by an admin and signs in through the tunnel only when admins may (its
  words say so). The account needs `audit.read` too. The laptop's token at the laptop exports, its sign-in made by this
  run ("Sign in again with the token (Admin login): a sign-in from before the restart cannot export."). From another
  device only over HTTPS ("Export over HTTPS: open https://<address>:3023 (trust this AGMessage's certificate once:
  /tls)."); never a code guest, a screen, a node or the context token.
- The signing key's fingerprint is printed in full in the black window ("Signing key: fe97 b845 …", 16 groups), on Admin
  → Health with Copy, and under Accounts → Audit log; the crew copies it into the show's paperwork. An auditor checks an
  export against that record, never against the export. Health also says "Last export: entries 1–1702, sent whole at
  18:40 on 26 Oct (Ana). Export at the end of each show day." once that row is on disk, read again from the log at each
  start, or "No export in the log's newest file". Appended to `/api/health`'s `saves.stores.audit`: `signKey`, then
  `lastExport` (the archive's fields will go between them); to `/api/audit`: `key {kid, fingerprint}`, both `''` in a
  run with no machine key ("Not keyed this run" under Accounts → Audit log, as on Health).
- The verifier runs offline, from the release (`agmessage-audit-verifier-<version>.zip`, published, hashed and attested
  with the bundle): `node verify-audit.js <the extracted folder> --fingerprint <64 hex>` on the Node a bundle carries or
  any from 22, or `verify.html` in a browser (Chrome or Edge 137, Firefox 129, Safari 17 or newer), one file that loads
  nothing and sends nothing. Exit 0 signed by the expected key and whole, and the laptop said ✓; 1 ◇ or △; 2 ✕ (also
  when every file matches its signed digest and the entries break where the laptop's own signed check said they do,
  as an archive's failure its verdict names does); 3 a step failed, a file was changed, removed or added since, or
  another key; 4 no key given to compare with. Every listed file, the log's included, is checked against its digest
  before any entry is walked. The bundle is untrusted input: only its fixed paths are read, a path holding `..`, a
  backslash, a drive letter or a NUL ends the check before anything else is opened, a link or a file not listed is
  named and never read, and a bundle's words are printed with control characters escaped. `--earlier`
  compares with an export kept off the laptop: every entry it held must be in the later one byte for byte, which holds
  even against whoever holds the machine key; an earlier export whose entries break is refused as one that does not
  check. By hand, OpenSSL and `sha256sum -c` check the signature and the files. A file the bundle does not list ends
  the check (exit 3), so the README says to check it before browsing the folder (macOS Finder writes `.DS_Store`).
- Older entries hold what they held: screen takes written before 0.6.0 can carry a message's first words and a file's
  name, and an export carries them. The dialog says so; this version's rows never write them (unit 1).
- CI: the package job exports the bundle's own audit log with the token, extracts it with Expand-Archive and checks it
  with the release's verifier on the bundle's `node.exe` (exit 0); the Linux tests check a bundle with `unzip -tq`,
  OpenSSL and `sha256sum -c`, word for word as its README gives them; the browser smoke saves an export through
  Chrome's own download, checks its bytes against the zip the log names, and opens `verify.html` from disk.
- Not yet: "Export the log…" in the audit list's right-click menu (unit 24).
- Rolling back: 0.5.1 has no export and ignores the new rows; a bundle already made stays checkable with the release's
  verifier.

**The audit log carries on across events** (the owner's answer 45, 2026-10-27: "Carry on audit log with an archive point
an entry in it. Admin can choose to split the audit log and archive the older part."; answer 29, "wrap into 0.6.0")
- The log stays one chain from event to event. An archive point, `audit.archive`, is the first line of a file of its own:
  what waits is put on disk first, then the current file is set aside. Its target names the event archive's folder and
  the run it stands in (`2026-10-27T14-02-00-000Z;9c01ab23cd45ef67:812`, from the head's `run` across a restart, or
  `…:?` when this start could not know it). While the disk refuses entries the point is written where it falls, and no
  split is made at it. Two rotated files never share a name: each is named by the later of now and 1 ms after the newest
  rotated file, since a rename replaces what it lands on. Archiving an event, which writes the point, comes with the
  installed node's events (unit 76); until then nothing in AGMessage writes one, and the split is there for when it does.
- The admin may split the log at a point: Admin → Health → **Split the audit log…** lists the points, newest first, each
  with its event and what a split there would move or why not; choose one, type the word "split". "The admin" is the
  laptop's token or an account whose role is admin (`theAdminReq`), through the tunnel only when admins may sign in
  there: never a manager, even one an admin granted `settings.manage`, never Staff or a code guest ("Only an admin may
  split the audit log."). `GET` and `POST /api/audit/split {seq}`; `/api/admin/me` gains `admin` at its end. In order:
  the check through the files' handles; the archive made aside, `app\data\audit-archive\.<name>.partial\`, with
  `archive.json`, `signing-key.pem`, `SHA256SUMS` over them and the files to move, and its Ed25519 signature;
  `audit.split`, pinning the archive by the SHA-256 of its `SHA256SUMS`, on disk before anything moves; the files before
  the point renamed in, oldest first (one volume, no byte copied); the folder renamed `audit-<log id>-<from>-<to>`; the
  head saved at once. "✓ Split: entries 1–2003 are in the archive audit-7c3e91d2-1-2003 (3 files, signed). The check
  starts at entry 2004." Nothing is deleted, and AGMessage has no act that removes an archive.
- Refused before anything is written, with its words: a run without the machine key (503); an export streaming or a
  split running (409, who and since when); an entry that is no archive point under this laptop's key in the live log,
  or its first entry; a point not the first line of its file, or that says `:?`; anything open before the point ("Accept
  them first") or broken; a head that could not be read or saved; entries waiting for the disk ("Not split: 1 entry
  waits for the disk (ENOSPC): split once the log has written it.", 503); an archive of that name already there. An
  export or a check asked while a split runs waits for it.
- An entry once chained is never withdrawn: when the disk refuses the split's own entry, the folder made aside is kept
  and the answer is "The split waits … nothing has moved" (△ on the dialog, never "Not split"). The entry is written
  ahead of the next one, and then pins a split not finished, which Finish the split or the next start completes; it
  never reads as an archive gone. Should it never reach the disk, no split pins the folder and the next start removes it.
- After a split the check starts at the point and names every archive back to entry 1 (each pinned by its split, each
  naming the one before it): a keyed `audit.split` under the point's own key must name the live log's first entry, or
  "entries 1 to 2003 are missing: no split names entry 2004" (✕, as files removed by hand always read). Each archive is looked at, not read
  again: its `SHA256SUMS` against the pin, its `archive.json` against its line there, each file's size. One gone reads ✕
  "not where the split put it", one changed ✕ "not what was split off"; each is a finding (`a<the split's entry>`)
  accepted with the token and its own confirmation, ◇ after. A split never changes the mark: it is the worst of the
  live log's and each archive's recorded one, so an accepted 0.5.1 range stays ◇ archived. The answer gains `from` and
  `archives` at its end; health's `saves.stores.audit` gains `from` and `archives` (a count) before `lastExport`;
  `/api/audit` gains `archives` and `unreached` (folders the chain no longer reaches) at its end; the black window says
  "Audit log: keyed (key …) · from entry 2004, 1 archive · Admin → Health" once the check at start answers (a line of
  its own after the banner, whose first audit line is printed before any file is read), and Health's audit line "· from
  entry 2004, 1 archive".
- A stop part way is read whole: a `.partial` folder a keyed split pins is walked first, then the live files, and reads
  △ "the split at entry 2010 is not finished: 1 file still to move (EBUSY)" (or, every file moved, "its folder is not
  renamed yet"), a condition; an export is refused until it is finished ("finish it first (Admin → Health)"), so a
  bundle never holds a half-moved split. The next start finishes it (`audit.split.finished`), as does Finish the split
  on the same dialog. One no split pins, which holds no log file, is removed at the next start (`audit.split.fail`,
  "nothing was moved"); one holding a log file no split pins is left as it is, and said in the window and on Health.
  Whether a split pins a folder is read only from a check that walked the log to its end: after one that broke, every
  such folder is left as it is, and said, never removed.
- Accounts → Audit log lists each archive with its mark and its own Check (`GET /api/audit/verify?archive=<name>`): its
  signature by its own key, its files against its `SHA256SUMS`, its entries from the one its first follows, each entry
  under this laptop's key by MAC, then what pins it (its `SHA256SUMS` the one the split pinned, and under this laptop's
  key id this laptop's signing key: otherwise ✕, as the routine check reads it), and the point after it here. One the
  chain no longer reaches reads ◇ at best under this laptop's key, △ under another. Two Checks of one archive asked
  together share one walk, which turns the event loop every 1,000 entries, walked and MAC-checked alike (a test counts
  them on a 49,999-entry archive, never the time a turn takes). A byte changed in place is found there and by every
  export, which hash each archive file in full; the routine check sees a file's size, not its bytes.
- The Accept dialog for an archive gone or changed says what goes with it: "Entries 1–811 are in an older archive this
  one named: Accounts then lists it as not reached from the live log, with its own Check."
- Every export carries the archives byte for byte (`archive/<name>/…`, each file in the bundle's `SHA256SUMS` too), and
  `manifest.json` lists them (`archives`, at its end, each with its pin and whether it is in the bundle); the export's row
  says "entries 1–3630 (1–2003 from 1 archive)". The verifier reads the archives first, then `log/`, as one chain from
  entry 1: each archive's own signature (another key is named, not failed), files, pin and the archive before it; one the
  laptop's verdict names as changed is exit 2, any other failure 3. An archive accepted as gone is listed with its pin,
  and the bundle then begins at the point after it (exit 1, "entries 1–2003 are not in this bundle"). `--earlier` finds an
  earlier export's entries in the later one's archives. An archive's folder is checked alone by the same verifier (Node
  or the page): 0 or 1 by its verdict at the split, 3, or 4; the README's three commands work in it. The Node verifier and
  the page now run one folder check, in `app/verify/auditrules.js`, each handing it only their own way to read, hash and
  check a signature.
- The audit list wraps a long target (a split's is 75 characters) instead of running it into the words beside it.
- Not yet: the split tick in Archive this event… (unit 76), and "Split the log here…" in the audit list's right-click menu
  (unit 24).
- Rolling back: after a split 0.5.1 reads "✕ Broken at line 1 of audit-<time>.jsonl: entries 1 to 2003 are missing
  before entry 2004" and writes on in the live log, never touching `audit-archive`; back on 0.6.0 its entries are a span
  (`audit.unkeyed`), △ until accepted, and the archive is named as before.

**A line for the speaker's screen reads as it was typed, names a department as Stagewatch does, and is audited**
- Every line sent or proposed to Stagewatch is cut where Stagewatch cuts it, in UTF-16 units as it counts them (a
  message 500, a role screen's or a department's message 200, a note for the operator 300), at the last whole character
  within the limit, so no line ends in half an emoji; a lone surrogate (half an emoji pasted on its own) is sent as
  U+FFFD. A line asked of the show desk is still held whole within the desk's 400 or refused with the room left
  ("at most 377 characters", and "an emoji counts two" when it holds one), never cut. Send now drops control characters
  as a proposal does.
- `{` and `}` reach Stagewatch as `(` and `)` in the words of every line, sent or proposed: Stagewatch reads `{TIME}`,
  `{REMAINING}`, `{NEXT}` and the like in a message as its own placeholders and fills them in on every frame, so "back
  at {time}" would have reached the speaker as the clock. A department's name is Stagewatch's own and is kept as it is.
- A department is named as Stagewatch names a signal's target: cut at 32 UTF-16 units on a whole character, trimmed, and
  its first letter capitalised as `char.ToUpperInvariant` does (one letter for one: "ßound" stays), its spaces as
  Stagewatch gave them and its control characters dropped, as the desk drops them. 0.5.1 kept 40 characters, made a run
  of spaces one (another target to Stagewatch) and left the rest to Stagewatch, which cuts and capitalises a target
  itself (and can cut an emoji in half): the destination offered, the line the desk kept, the hall's line and the
  audit row named the department otherwise than Stagewatch shows it. A label Stagewatch would make one of its own role
  targets ("speaker" with a control character in it) is no department, as a role's own label is not.
- The words for Stagewatch's speaker screen are "the speaker's screen": the refusal for a seat without the right ("The
  speaker's screen is for the backstage team."), the hall's line ("Kim sent to the speaker's screen: “…”", quoting what
  reached it, braces as parentheses, cut at 120 on a whole character, as a proposal's line now is too) and the recent
  event in AGMessage's context ("research sent a message to the speaker's screen (applied)"; 0.5.1 said "the stage
  screen"; a reader matching those words reads the new ones).
- Each line Stagewatch takes for the speaker's screen is one `stagewatch.send` audit row, target the hall's code: who
  sent it (the account, or a code guest by name) and "a line (27 characters) on the speaker's screen, sent now", never
  the words. A send Stagewatch does not take writes no row. In 0.5.1 these sends were not recorded. Characters are
  counted as a person counts them, an emoji as one, in this row and in a desk proposal's `stagewatch.propose` row, which
  counted UTF-16 units.
- Rolling back: nothing stored changes shape; 0.5.1 reads the new rows and lines as they are.

**The libraries the pages use: each listed with its licence, and the stale or fragile ones gone** (the owner's answers 22,
"Board will use a mixture of devices", and 29, "wrap into 0.6.0"; the libraries' own packages, read and hashed; npm's
registry's advisories, read on 2026-11-01; the browser smoke takes `Promise.withResolvers` away in the page and in
pdf.js's worker, as older iPads lack it, and no iPad was walked)
- PDFs draw on older iPads. pdf.js is 4.10.38's legacy build, on the hall's panel and on the screens, in place of the
  same version's modern build, which calls `Promise.withResolvers` with nothing in its place where it is missing: Safari
  and iPadOS have it only from 17.4 (Chrome from 119, Firefox from 121), so an iPad before iPadOS 17.4 drew no PDF, on
  the panel or as a screen. The legacy build's module and its worker each define it where it is missing and are
  compiled for Chrome 103, Firefox ESR and Safari 16.4, its build's own targets: from iPadOS 16.4 an iPad draws them, and
  before 16.4 it still draws none. That floor is recorded with the files. They are larger: the module 398 KB and the
  worker 1.42 MB, from 353 KB and 1.38 MB.
- pdf.js 3.11.174's worker (`vendor/pdf.worker.min.js`) is gone. Nothing loaded it, yet every bundle shipped it, from a
  release before CVE-2024-4367's fix.
- mammoth 1.13.0, from 1.11.0, reads Word files in the page: since 1.12.2 a crafted document's styles cannot pollute
  object prototypes (which could turn on its `externalFileAccess`), and since 1.12.3 an unterminated string in one no
  longer makes mammoth's own reader backtrack for long. 1.13.0 uses the browser's own promises (the file is 405 KB, from
  636 KB), reads the text inside `w:customXml` elements, which 1.11.0 left out, and handles paragraphs and runs moved
  under tracked changes. The XML parser it bundles is not fixed by it: see the advisories below.
- Every file in `app/public/vendor` is listed in `app/public/vendor/VENDOR.json`: its package, version, build, where it
  runs, licence and copyright, its package's address and digest, the path inside it, the file's SHA-256, and the 21
  libraries bundled inside the four files (core-js in both pdf.js files, OpenJPEG in its worker for JPEG 2000 images;
  jszip, pako, xmldom and thirteen more in mammoth; SheetJS's own codepage, CRC-32 and CFB). The four that come inside
  jszip's own bundle, which names no versions, are the versions jszip's lockfile pins at its tag, and pako's is held to
  its code (1.0.5). `THIRD-PARTY-NOTICES.md` says the same in words, and each licence's text, with the copyright notice
  it asks to be kept, is in `licenses/<package>/`. The portable folder carries both at its top. 0.5.1 shipped none of
  these libraries' licences.
- The advisories against the bundled libraries are listed and assessed, since `npm audit` cannot see them. mammoth
  1.13.0, its newest release, still bundles xmldom 0.8.6, underscore 1.13.1 and jszip 3.7.1, which carry 17 published
  advisories between them. `VENDOR.json` records each with whether it applies here and why, `THIRD-PARTY-NOTICES.md` and
  `SECURITY.md` say so, and the release's SBOM carries each as an analysed vulnerability. Twelve do not apply: mammoth
  never serializes or builds an XML DOM, never writes a zip's entries anywhere, and flattens only lists of its own.
  Four of xmldom's apply: a crafted Word file can keep the page that draws it busy for a long time, or short of memory,
  until it is reloaded (the panel of whoever opens it, and the Board's panels, where a file sent into the hall opens
  itself); the server and other pages are not affected, and until 0.6.0's readers run mammoth in a worker with a
  deadline, the upload cap and who may send into a hall are what bound it. A fifth applies harmlessly: a part that is
  not well-formed is read instead of refused.
- `tools/vendor-audit.js`, part of `npm run audit` and a step of the Security workflow's weekly run, asks npm's
  registry for the advisories against every version `VENDOR.json` lists, the bundled libraries included, and fails on a
  high or critical one that is not assessed, or is assessed at another severity than the registry now gives it, and on
  a registry that does not answer.
- `test/vendor.test.js` fails the build on a vendored file that is not listed, a listed file that is missing, bytes that
  are not the listed SHA-256, an entry with no licence, notice or copyright, a licence a vendored library may not carry,
  a licence folder whose text is not the licence named (a BSD-3-Clause text filed as BSD-2-Clause included) or lacks the
  copyright, a file no page loads (as the 3.11.174 worker was), a notices table that is not the list, an advisory with
  no assessment, a bundled version its code does not bear out, and a paper that says which browsers draw a PDF without
  the floor. It also opens a PDF through both pdf.js files in a Node with no `Promise.withResolvers`.
- The browser smoke runs the Board's panel and a projector screen as an iPad before 17.4 would: `Promise.withResolvers`
  is taken away before the page's scripts and before pdf.js's worker starts, and each must have it again once a PDF is
  drawn, through the worker file itself, not pdf.js's fallback in the page. A Word file built in the smoke draws on the
  Board's panel, its bold kept.
- The release's SBOM (`agmessage-sbom.cdx.json`) lists the vendored files beside npm's packages, each with its SHA-256,
  its package's digest, the libraries bundled in it and the analysis of each advisory against them
  (`tools/vendor-sbom.js`). It reads them from the bundle as the zip extracts it, and the job stops on a shipped file
  that is not the one `VENDOR.json` records, or a bundle without the list, `THIRD-PARTY-NOTICES.md` and every licence
  text as the checkout has them. 0.5.1's SBOM listed npm's packages only.
- A Windows checkout, where the bundle is built, keeps the vendored files as their packages published them: git no
  longer turns their line endings into CRLF there.
- Not yet: the portable folder does not carry the licence texts of the Node.js runtime and cloudflared it ships;
  `THIRD-PARTY-NOTICES.md` says where they are.
- Rolling back: nothing stored changes; 0.5.1's bundle carries its own libraries.

**A module fence, and the unused `typing` verb gone** (the owner's answer 26, "no typing indicator"; the tree as the
fence reads it)
- `typing` is gone. The server took it from anyone in a hall who may post and sent it on to everyone else there, and no
  page sent it or listened for it: a rebroadcast nothing used. Sent now, it reaches nobody. The input fuzz sends one
  event fewer, 55: the one time its count falls; from here it only grows.
- `test/modules.test.js` fails the build on a breach of the server's layers, read from every `require()` in
  `server.js`, `supervise.js`, `lib/`, `verify/` and the tests: a module of the pure core (`lib/board.js`, `context.js`,
  `deskresults.js`, `rbac.js`, `stagelines.js`) that requires anything but another of them, names an I/O built-in,
  reads `process.` or imports at run time; a file that requires `server.js`, a test included, and `require('..')` from a
  test with it (Node takes app/ to its package's `main`, `server.js`); a cycle among the server's files; a file other
  than `server.js` that requires `lib/http-accounts.js` or a handler module in `lib/handlers/`; a relative require of a
  file that is not there.
- The same fence closes the wire's words both ways: every event a page sends is a verb a handler file registers, every
  verb is sent by some page, every event the server sends is heard by some page, and every event a page listens for is
  one the server sends (or Socket.IO's own). An event named by an expression fails it unless a row says which names it
  takes and why; the op table's events, which `apply()` sends, are the one row (below). `linkedRoomsChanged`,
  which the server sends a guest's pages when the admin lets them forward into another hall and no page hears yet, is
  allowed by a row that says so, and the fence fails on that row once a page hears it or the server stops sending it. A
  page that names an event by an expression fails it too, unless a row names the events it carries and why (the op
  table's listeners on the hall page are one, below; the outbox will be another).
- No verb escapes the fuzz. A verb registered in a form the fuzz does not read fails the fence: `socket.on(` with
  anything but a single-quoted name, and `socket.once`, `addListener`, `prependListener` or `prependOnceListener` for
  any event but Socket.IO's own (`disconnect`, as the AI's draft listens for). A shipped file outside the handler files
  that listens on a socket fails it, a module in a folder below `lib/handlers/` included; `lib/tls.js`'s shared port,
  which listens on its own TCP socket for the first byte and a reset, is the one row, held to those two events.
- The fuzz and the fence read the verbs from one list of files, `handlerFiles()` in `test/helpers.js`: `server.js`,
  then each module in `lib/handlers/`. A verb registered in a handler module is sent every argument shape, from every
  kind of socket, as one in `server.js` is.
- The source guard rail of `test/resilience.test.js` (no `eval`, no key in a URL, the synchronous file calls per file
  capped) reads `lib/` and `verify/` in every folder below them and every page script, in place of a hand list that
  left six of the ten page scripts out (`audit-export.js`, `common.js`, `display.js`, `halls.js`, `theme-init.js`,
  `users.js`). Each is read at 0 synchronous calls, and no cap moves. The vendored libraries are their packages' bytes,
  which `test/vendor.test.js` holds, and are not read.
- Health's `saves` ends with `built`, how many write lanes this run of the server made in any file, and `named`, how
  many distinct lanes `saveLanes()` names, the lanes a stop or a crash flushes. A test holds `built`, `named` and the
  lanes' names in `saves.stores` equal, so a store whose lane nothing flushes fails the build, and so does a lane under
  two names, which a count of names alone would let pass beside one left out. Eight are made and eight named.
- Rolling back: nothing is stored; 0.5.1 takes `typing` again, and no page sends it.

**One op table sends every change's event, on the server and in the page** (the plan's Part 5, unit O; the tree as the
fence reads it, and the hall page in Chromium)
- `apply()` sends each change from one table, `app/lib/ops.js`: an added message under its kind (`message` or
  `system`), each field of a change to a message under its event (`responses` → `actionUpdate`, `pinned` → `pinUpdate`,
  `reactions` → `messageReact`, `stage` → `stageAck`, `proposal` → `proposalUpdate`, `help` → `helpUpdate`), each
  carrying `{messageId, <field>, seq}` as before, then a removal, a reset and a hall's new name. The events, their
  payloads and their order are 0.5.1's.
- A change the table cannot send is refused before it is committed: a field outside the table, a change of no field or
  to no message, an added message with no id, an op of another kind. Nothing is numbered, saved, sent or marked, the
  server says so in one line (`[ops] refused, nothing saved or sent: a change of …, a field outside the op table`, which
  names the kind and the fields, never a value), and `apply()` answers null; it throws for none of them, so a Stagewatch
  follower, outside the guarded handlers, cannot end the process with one. In 0.5.1 such a field was numbered, saved and
  sent under no event, and every page of the hall saw a gap in the numbers and rejoined. No change the server makes today
  is refused; were one refused, its request is answered as refused (`That change could not be made: nothing was
  saved.`), never as done, and what follows the change is not done for it (a removed message's files are kept, no audit
  row is written, no send or proposal is followed on a line that was not saved, and the show desk's notice counts only
  the meetings it was saved in).
- The hall page draws a change through one table too, `UPD_EVENTS` in `public/app.js` (field → its event and how it is
  drawn): the changes a page reads when it comes back (`applyOp`) and the ones it hears live (one listener per row, made
  from the table, in place of six written by hand) go through the same row. They had drifted: the show desk's answer to a
  proposal, on a message drawn on the page whose record it no longer held, was drawn by a live page and left as
  "waiting" by one that came back after it. Both draw it now, as a proposal's own line was already drawn.
- `test/modules.test.js` fails the build when the two tables are out of step (a field in one and not the other, or one
  field under two events), when a change to a message in a handler file names a field outside the table or writes its
  fields so they cannot be read (an `f` that is not an object written out, a spread or a computed key in it), and when a
  row of the table is a field no change sends. It reads the op of every `apply(` call in the handler files, and every op
  whose kind is written `upd` wherever it is built, its key or kind in any quotes: an op given to `apply()` that is not
  written out, whose kind is not (a kind from a variable), that holds a spread or a computed key (either could bring an
  `f` of its own), or whose kind the table does not hold fails it too, so no change reaches the table unread. It holds
  `apply()` to the one `server.js` makes from `lib/ops.js`, its refusal a log line and nothing more, and the hall page to
  naming each of the table's events once, in its table, in whatever quotes. `lib/ops.js` joins the pure core. The wire's words fence reads the
  server's events from the table (`EVENTS`) and the hall page's listeners from its table, one row on each side in place
  of the row for `apply()`'s `message` or `system`. The smoke has a page that hears the desk's answer live and one that
  comes back after it draw it the same way, with one listener for each row.
- Rolling back: nothing is stored; 0.5.1 sends the same events.

**State frames go out latest wins, through one primitive, and are no longer deflated** (the plan's Part 5, unit C; the
tree's tests and the hall page in Chromium. No number from the plan's bench is quoted: its rerun, reading 0, is not
taken yet, and its row in `docs/DESIGN.md` still says "not measured")
- The WebSocket's frames are not deflated (`perMessageDeflate: false`): a handshake that offers `permessage-deflate`, as
  every browser does, is answered without it. A broadcast is framed once and that frame written to every socket in the
  hall, where each socket compressed it again before. HTTP long-polling keeps engine.io's HTTP compression. A first open
  of a large hall now goes uncompressed; the first open is bounded later in 0.6.0 (unit 32).
- One primitive for four frames of state, `Latest` (`app/lib/latest.js`, in the pure core): a change after a quiet
  window is sent on the next turn, the changes inside a window fold into one frame at its end, each with its newest
  state, and none is dropped (no frame is volatile; a page that stops reading is still let go by the heartbeat). The
  halls board (300 ms) and a hall's screens console (150 ms) are moved onto it: a lone change now goes at once, where
  0.5.1 waited for the board's 300 ms interval and sent the screens' change 150 ms after it. `nodes:changed` (the nodes
  heard on the network told by their own 500 ms coalescer, a link's change at once) and Stagewatch's view (sent when it
  changes) are as in 0.5.1. The people list and the seen receipts join the board and the screens:
- The people list (`users`) goes to a hall at most once per 100 ms, not once per join, leave or role change to every
  page in it, so a join storm of N pages is no longer N lists to up to N pages. A join, a leave and the admin's role
  change only mark the hall; the frame keeps 0.5.1's split, one broadcast without the guests' links and each admin
  page's own copy with them. After a burst the list may come up to 0.1 s later.
- Seen receipts go to a hall in one frame per second at most, `seen {seen: [{uid, name, role, seq}…]}`, holding the
  receipts that moved since the last. 0.5.1 sent each report to the whole hall, so a lone message brought N reports and
  N² frames, each making every page look again at its messages. The hall page applies the batch, then draws its "Seen
  by" lines once. After a burst a receipt may show up to 1 s later. The join's `seen` is unchanged.
- Health's `latest` holds all four, `board`, `screens`, `people` and `seen`, each `{marks, flushes}`: the changes marked
  and the frames sent for them.
- A frame that faults while it is built is refused and counted in health's `handlerFaults`, as a socket handler's
  throw is, and the rest of its batch still goes: each hall's frame, and each watcher's board, is sent apart
  (`sendEach`). A frame only reads the state, so the one refused changed nothing. In 0.5.1 the people list and a
  receipt were built inside their handlers, where a throw refused that one request; the board's interval and the
  screens' timer had no guard, so a throw there ended the server for the watchdog to restart.
- `test/resilience.test.js` counts the timers `server.js` and each handler module start (`setTimeout(` and
  `setInterval(`), each with its reason: 13 in `server.js`, the board's interval and the screens' timer gone into
  `Latest`. A new tick of its own moves the list, with its words; a new frame of state is a `Latest`. `lib/latest.js`
  joins the module fence's pure core.
- Two tests sent to Stagewatch as soon as the fake Stagewatch's socket opened, before AGMessage had the key's verdict,
  which AGMessage waits for and refuses a send without. `shownet.test.js` C18 sent at once, and with frames no longer
  deflated its send came first every time; `halls.test.js` C53 sends after a join's round trip and did not race in three
  runs, but can likewise. Both now wait for AGMessage's own link status, which reads connected only once the key is
  accepted. The halls board's own tests in `halls.test.js`, and `displays.test.js`, are unchanged.
- Rolling back: nothing is stored; 0.5.1 deflates again and sends a list and a receipt per event. A 0.5.1 hall page
  cached across the upgrade reads the batched `seen` frame as one with no `uid` and ignores it, so it draws no new "Seen
  by" until it is reloaded; its people list and board are as before.

**A send never vanishes and never doubles: the outbox** (the plan's Part 5, unit Q; the owner's answer 27, "sent when
back, marked with how long it waited"; the tree's tests, the outbox in a page's own runtime, and the hall page and the
halls board in Chromium)
- What a person writes is held until AGMessage has it. In 0.5.1 a message sent while the Wi-Fi was down went out
  before the page had joined again, was answered "Not joined", and its text was cleared: lost, and nothing said so. Each
  page now sends every write through one outbox (`public/outbox.js`, loaded by the hall page, the halls board and the
  admin page), in the mode of what the person does:
  - **What a person wrote or answered** (a message of any kind: text, an action prompt, a file, a help request; a
    forward; an answer to a prompt; an answer to a help request) gets a client id, `cid`, 16 random bytes from the
    browser's `getRandomValues` (a page on the venue network over plain HTTP has no `randomUUID`). It is held while the
    page is not connected and joined, sent after the join's answer, one at a time in the order written, and sent again
    with the same `cid` after a drop until the server answers it. There is no time limit, and the person is not asked
    first. Its composer keeps its words, held, until the server has it, and empties only then; the message is drawn below
    the hall's messages as "◷ Sending", or "◷ Waiting — it goes when the connection is back". A refusal keeps the words
    and says the server's ("△ Not sent: …") with Retry and Edit; an answer to a prompt shows its option marked ◷ until it
    is taken. Held sends are kept in the tab's own `sessionStorage`, under the hall and the person, so a reload keeps
    them and sends them with their `cid`, and one the reloaded page already has in its history (it landed before the
    reload) is matched to it, never sent or offered again; another person's are dropped, never sent as them; being sent
    out of the hall drops them all, and nothing held is sent then or later in that tab. A file's bytes are held in
    memory only: after a reload a file not yet uploaded reads "Not sent — choose the file again", and one uploaded goes
    by its link with its `cid` (and reads so only if the laptop no longer has the upload). A file not yet uploaded is
    uploaded with the message once the connection is back, and uploaded once more if its upload token was renewed at a
    join or the laptop no longer has it. Edit on a refused message puts back its 🔥 and the message it replied to with
    its words.
  - **What a person does to something** (pin, react, delete, a screen's take and its set-up, the stage, the admin's acts
    on the admin page and the halls board) is refused at once while the page is not connected — "Not connected —
    AGMessage is reconnecting." — so it is never sent late, as 0.5.1's pages did; an answer not back in 5 s is "No
    answer — check the connection.", and the server's own answer, when it comes after that (a line Stagewatch is slow to
    take, a desk proposal, a hall closed with its files), is shown too, once, so its receipt or its refusal is never
    lost; after a drop it is sent again, with its `cid`, only where the server answers a repeat (a pin, a reaction set
    with `on`, a delete), and otherwise the person is told to check it was done. Pins and reactions, which had no answer
    on the hall page, now say when they were refused.
- The server says a send once. A message keeps its `cid` (1 to 40 characters of letters, digits, `-` and `_`; any other
  shape is refused: "That message's id could not be read."), and the room's store indexes it by who sent it: the same
  `cid` again from that person is answered with what the first one became, `{ok, id, seq}`, and commits nothing, before
  any rate or right is read, so a send that landed is never answered "Slow down". A forward's copy keeps it in the hall
  it went to, so a repeat posts nothing there; a forward that is no repeat takes from the sender's rate before its
  hall's code is looked up, so whether a code names a hall is told no faster than a send goes. A message removed
  (deleted, or a session reset) leaves a tombstone: the newest 500 per hall are kept, in the snapshot too (`gone`), so
  after a restart a repeat of a removed send answers `{ok: true, id, seq, gone: true}` ("That message was removed.")
  and a second delete by its author answers `{ok: true, already: true}`. A message now carries its seq in the log as
  well as in memory, so one replayed after a restart has it.
- A message written offline is marked with its wait. A held send carries `heldMs`: of the time since it was written,
  the page's own count of what it spent not connected and joined, a reload included (at most 24 hours; any other shape
  is refused: "That message's wait could not be read."), so a send that only queued behind another or behind the rate
  is not marked; the server keeps it on the message as `held` in whole seconds when it is one or more. Every reader
  sees "written 14:02 · sent 14:06 (offline)": the hall page under the message, the halls board's help strip (so a
  five-minute-old "Sound" request reads as one), the admin's view of the hall and the transcript; the AI's brief (its
  drafts and the minutes) dates the line as written and as sent.
- Every act that can be asked twice answers a repeat with what it did: `react` takes `on` (true sets the reaction,
  false takes it away; without it the reaction toggles, as a page cached across the upgrade expects; any other value is
  refused), and a reaction already as asked answers `already`; the same answer to a help request from the same person
  answers `already`, never "Already resolved". A file whose upload the laptop no longer has is refused with
  `reupload` ("That file is no longer on the AGMessage laptop: choose it again."), and "Slow down a little." carries
  `busy`, which the outbox reads as "send it again shortly" rather than a refusal.
- `test/outbox.test.js` runs `outbox.js` as a page loads it, with a `crypto` that has `getRandomValues` and no
  `randomUUID`, and drives each mode with a socket, a clock and a session store of its own; end to end, the same `cid`
  twice commits once and answers the same, after a restart and after a removal too, each repeatable act answers its
  repeat, and forwards to codes that name no hall reach "Slow down a little." within the rate's burst. The input fuzz
  sends `cid`, `on` and `heldMs` in every shape, a reaction's `on` to a message that is there; the wire's words fence
  reads a page's sends where it calls the outbox, `AGM.outbox.hold('x'`, `now('x'` and `self('x'`. The smoke drops a
  hall page's socket, sends, and sees it land once; refuses one, keeps it and Retries it; reloads with one held; holds a
  help request for a minute and reads its words on the item and on the halls board; and sends a person out with one
  held, which is never sent.
- Rolling back: 0.5.1 keeps the messages with `cid` and `held`, which it ignores, and drops the snapshot's `gone` at
  its own next compaction. A 0.5.1 page cached across the upgrade sends no `cid` and toggles reactions as before; a 0.6
  page talking to a 0.5.1 server sends keys 0.5.1 ignores. Harmless both ways.

**Pages come back by themselves after a refusal, a drop or a restart, and a restart announces nobody** (the plan's
Part 5, unit B; the tree's tests, `reconnect.js` in a page's own runtime, and the hall page in Chromium. The watchdog's
0.5 s first step rests on a test only the Windows job runs, whose first run is this change's; nothing here is seen on
the show laptop yet)
- A refused connection is tried again, at the pace the server gives. The connection rate per address (3 a second,
  bursts of 30) refused with "Too many connections — wait a moment." and nothing more, and no page tried again: a page
  refused at a busy moment stayed dead until someone reloaded it. The refusal now carries `retryMs`: the time until the
  address's bucket holds its next token (`guard.Bucket.waitMs`), at least 1 s, plus up to 2 s more chosen at random, so
  the pages behind one address do not all come back in the same instant. The hall page, the halls board and the admin
  page say "Busy — trying again in 3 s." (the real seconds, rounded up) in a strip under their header and try again
  then, never sooner, without a reload; a screen (`/d/`) tries again in silence and keeps its picture meanwhile. The
  refusal for HTTPS required carries `retry: false`: it is never tried again, and the hall page, the halls board and the
  admin page now give its words as the screen already did.
- Back sooner after a drop: every page's socket tries again from 0.5 s, doubling to 2 s at most (Socket.IO's own 1 s to
  5 s before), each ±50 %. A page that is not connected when it is shown again (a phone woken, a tab brought to the
  front) or when the browser is back online starts afresh at once, instead of waiting out its backoff; a refusal's wait
  still holds then.
- Saying so: on the hall page, 2 s after a drop a strip reads "Reconnecting… what you write waits here until we're
  back.", and 5 s after it the dot in the header gains the words "Offline · reconnecting"; both go at the join's answer,
  and a page back within 2 s says nothing. The dot has a name for a screen reader, from what is true: "Connecting"
  while the page is connected and its join's answer is out, "Connected" at the answer, "Offline · reconnecting" while
  it is not connected and tries again, "Offline" once it is not brought back (in 0.5.1 it was colour only). A page the
  server sent out, or that closed its own socket, is not brought back and says nothing of reconnecting. One script does all of this, `public/reconnect.js` (`AGM.reconnect`),
  loaded by the four pages that open a socket, and a test holds each of them to its pace and to it.
- A restart announces nobody. In the restart's first 30 s (`AGM_BOOT_SEAT_MS`, as for the seats it keeps), a page that
  comes back naming a change the hall holds (its `since`, from 0 to the hall's newest) is a page coming back: no "Ana
  joined as research" line is written. 0.5.1 wrote one per page, each a broadcast to the hall and a line in its
  history, though the restart's own line ("Session restored") already says what happened. A newcomer, a page naming a
  change the hall never made, and a page back after the 30 s are announced as before. Only the words: no right reads it.
- The watchdog's first restart after a crash or a hang waits 0.5 s, not 2 s, if the Windows test passed (then 4, 8, 15
  and 30 s as before; six crashes in ten minutes still give up). A start that found the port or the folder still held
  would end with code 3, which stops the watchdog for good, so the step is gated by a test the Windows job runs: a
  server bound as the show laptop's is (every address) with a page connected from the machine's network address is
  killed 20 times in a row, and each start 0.5 s after must find both free and say it is running. The step lands with
  its gate, whose first run is this change's own Windows job, and no release is built until that job is green
  (`package` needs `test-windows`). Run by hand on Linux it passed 20 of 20 (there it is skipped, as the `.bat` tests
  are); if the Windows job does not pass 20 of 20, the step goes back to 2 s.
- `test/reconnect.test.js` runs `reconnect.js` as a page loads it, with a socket and a clock of its own: a refusal's
  wait kept and said, never tried sooner; a refusal for good said and never tried; the strip at 2 s and the dot at 5 s,
  counted from the drop and gone at the answer; the dot's name in each state, "Connecting" while the join is out; shown again or online, a page not connected starts afresh, unless the
  server's wait holds; a page sent away left alone. End to end: 40 connections at once from one address, the refused
  ones each carrying a `retryMs` from 1 s to 3 s and a third, not all the same, and one of them let in once it waited;
  HTTPS required, a plain connection from this machine's network address carries `retry: false`. A fence holds every
  page that opens a socket to the pace and to `AGM.reconnect`, its page loading `reconnect.js` first.
  `test/resilience.test.js`: a 3-page hall restarted writes no "joined" line while a newcomer, a page naming a change
  the hall never made and one back after the window are announced; and the 20 kills (Windows). `test/units.test.js`:
  `Bucket.waitMs`. The smoke drains a fourth AGMessage's connections while a hall page connects, sees "Busy — trying
  again in N s." and the page back without a reload; stops that AGMessage and reads the strip at 2 s and the dot's words
  at 5 s; starts it again and shows the page, whose backoff was made to wait 15 s or more, which comes back at once;
  and finds the page announced once in all.
- Rolling back: nothing is stored. 0.5.1 refuses with no `retryMs`, announces every page after a restart and waits 2 s
  before its first restart; a 0.6 page it refuses tries again after 3 s. A 0.5.1 page cached across the upgrade
  ignores `retryMs` and stays as it was.

**Compaction trusts the snapshot it wrote, and the papers say what a power cut can lose** (the plan's Part 5, unit D;
the owner's answer 28, "a power cut can lose the last few seconds" until the show laptop's disk is measured; the tree's
tests. No number is quoted: the plan's bench of a snapshot's stall is not rerun, and the stall on the show laptop is
health's `peaks.compactMs`, reading 4 of `docs/DESIGN.md`, not measured yet)
- A hall's snapshot (every 500 changes, at a start and at a stop) no longer reads back and parses the snapshot it
  replaces before keeping it as the backup. 0.5.1 read the whole old file and parsed it every time, so that a torn file
  would never replace a good `.bak`, though the file was the one it had written itself; the server waited for that read,
  every hall's work with it, and the read grows with the hall. The store now knows its own snapshot (`snapWhole`): once
  it has written one, or loaded one that parsed, the next snapshot copies it to `.bak` unread. After a start that found
  the snapshot torn and loaded its `.bak`, the file on disk is read and parsed first, as before, so a torn snapshot
  still never replaces a good backup; a snapshot that fails leaves `snapWhole` as it was, the file on disk being still
  the one before. No file call is added, so the synchronous-call caps hold. `writeFileAtomic` takes `knownWhole`, and
  `readJsonWhole` says whether the file itself parsed or its `.bak` was read; every other save is as it was.
- What a power cut can lose, said as it is. A change is appended to its hall's log before it is answered, and is then in
  the system's file cache: AGMessage does not flush it to the disk. A crash of AGMessage or of a browser loses nothing;
  a power cut can lose the last few seconds, and a crash of the laptop itself counts as one. An append the disk refuses
  (a full disk, a log another program holds) is kept in memory, named on the admin page's health and put in the hall's
  next snapshot, and a crash of AGMessage before that snapshot lands loses it; the papers now say that too. `README.md`
  said "a crash or power cut loses nothing", `README.txt` "even a power cut loses nothing but the last instant", and
  `lib/store.js` that an acknowledged message was on disk; they, and `docs/DESIGN.md` (its "Nothing heavy on the game
  loop" row for the snapshot, "Recover, don't stop" for the power cut), now say what is true. Whether every answered
  change goes to the disk at once (a group commit) waits for the show laptop's fsync reading (reading 3,
  `peaks.auditPutMs`).
- `test/units.test.js`: a file known whole is kept as `.bak` without a read of it, and one not known is read and kept
  only when it parses; a read with its backup says whether the file itself parsed; a hall made, or loaded whole,
  compacts without reading its snapshot, and a snapshot that fails then leaves it known whole, so the next still copies
  it unread; a load from a torn snapshot clears `snapWhole`, a snapshot that fails leaves it cleared, and the next one
  reads the torn file and keeps the good `.bak`. A source read holds `README.md`, `README.txt` and `lib/store.js` to the
  words, and none of them may say a power cut loses nothing.
- Rolling back: nothing is stored; 0.5.1 reads the old snapshot before each backup again.

**The hall page fits a phone, on a small token layer, and a new message is marked, not flashed** (the plan's Part 5,
unit P; the owner's ask (E), "a simple but rich and efficient service"; WCAG 2.2 read from the computed colours and
the layout in Chromium at 390 × 844 with a touch screen, by the smoke. Not yet walked on a phone or an iPad: that is
`docs/DEVICES.md`'s, before the tag)
- The hall page fits a phone. At 390 px it laid out 610 px wide for the Board, 644 backstage and 456 for an observer
  (the plan's walk): the header's controls, the composer's row and a message's header never wrapped, so a presenter on
  a phone read one message at a time and the help dialog's Send was off the screen's edge. Each of them wraps now, and
  the compose tabs keep to the composer's edge; a long name or file name breaks rather than widens its message (with
  `word-break: break-word` before `overflow-wrap: anywhere`, which Safari reads only from 15.4). The composer's text box
  takes its row, its buttons at its end (and below it when the row is too narrow for both); below 540 px Send is a 44 px
  button that shows ➤, and at every width its label names where it sends ("Send to Hall 2"); under a finger (a coarse
  pointer) the header's controls and the composer's buttons are 44 px. A dialog is held inside the screen, never wider
  or taller than it, its content scrolling inside it.
- "AI drafts off — everything else works offline" leaves the composer's row. While AI drafts are off, ✨ Draft answer
  and ✨ Suggest stay where they are, drawn as not usable now (a dashed edge, muted words, `aria-disabled`), with the
  reason as their title: "AI drafts are off: they need an Anthropic key (admin) and the internet. Everything else works
  without them." Pressed, they say it in the line under the composer (or as a note), where a finger can read it, and ask
  the server for nothing. 0.5.1 hid them, and only the composer's line said why. `README.txt` says it too.
- A new message is marked, not flashed. 0.5.1 filled every new message yellow for 30 s, so after a burst the whole feed
  was yellow, and moved the feed to the bottom at every message, so a reader scrolled up lost their place and a menu
  open on a message lost its anchor. The fill is gone (a reply's quote, followed to the message it quotes, rings that
  message for a moment instead). A **New** divider sits above the first message from someone else that arrived since
  the person last touched the page (a tap, a key, or a scroll of their own, while the page was shown); it moves only
  when one arrives after their next touch, and no timer takes it away. The feed follows the newest message only while
  the reader is within a line of its end and no menu is open on a message; otherwise it stays where they left it, and
  a 44 px "↓ 3 new" says how many came below and takes them to the end. When the divider moves from above what the
  reader sees, the page puts the first message in view back where it was, so the view holds still in a browser that does
  not anchor scrolling (Safari before 27, every iPad the Board uses today) as in one that does. A message one sends
  still goes to the end. A page back from a drop marks and counts what it missed the same way, in one pass: where the
  reader was is read once before it and the feed moved at most once after it, never once per message missed.
- A small token layer. Every size, space, target, layer and colour is named once in `:root` and every colour once more
  under the dark theme: the type on one scale of about 1.2 (`--fs-xs` to `--fs-stage`), spaces on a 4 px base,
  `--target-min` 24 px and `--target-touch` 44 px, the layers (`--z-header` to `--z-toast`) and the colour roles
  (surface, ink, muted ink, border, action, ok, warn, info, off, fault and the words on it, a question's, the three
  seats, another room), the plan's list with the Board's additions. 0.5's second pair of blocks (the stage's colours,
  warn and ok) is merged in, and the names the components read (`--bg`, `--ink`, `--muted`, `--danger` and the rest)
  read the roles. Two colours move with them: muted words from #6b7280, 4.47:1 on the page and under the 4.5:1 words
  need, to #545d6b (6.16:1); and the red from #dc2626 to #b91c1c in light (white words on it 6.47:1) and from #f87171
  to #fca5a5 in dark, where its words are dark (9.69:1). White on #f87171 was 2.77:1: the dark theme's 🔥 badge and the
  halls board's help count. A button's surface, ink and border are the tokens', so the dark theme carries no rule of its
  own for every button, nor for a message; the rules that leaned on those read tokens too, so each draws in dark as it
  did: 🔥 Priority (outlined, and filled with the fault red while pressed, which it now also says with `aria-pressed`),
  the admin page's Reset and Close (outlined in red, filled under the pointer; the close's confirm stays a primary
  button), and one's own 🔥 message, whose name stays red. Two things do look different in dark: ✨'s indigo edge, which
  the dark rule for every button had hidden, and the AI's line under the composer, now in the info colour of each theme
  (its indigo read 2.05:1 on the dark composer; the words need 4.5:1).
- No opacity for words or icons. The presence lines ("Ana joined as board", 2.23:1 at opacity .6) and a message's icon
  buttons (2.42:1 in light and 2.78:1 in dark at .35; 🖥, 📝 and ⧉ at .7, the Board's 📌 at .55) read in muted ink, 4.5:1
  and 3:1 or more in both themes, and the icon buttons are 24 px or more; a pinned message's 📌 says so with a ring in
  the action colour and its state (pressed, "Unpin"), not by being brighter. The other fades go the same way: a
  resolved help request, one someone is on the way to on the halls board, a turned-off account's row, a linked hall's
  code beside its name, a stale countdown in the hall's chip and on the halls board (which keeps Stagewatch's colour
  only while it is live), and an option an observer cannot press (a dashed edge, its words at full ink).
- The three faults the walk found are gone: the On stage tag drew its dark colours in light mode (the dark rule's second
  selector was not scoped to dark); Help lost its red in dark mode (the dark theme's rule for every button outranked it;
  Help is red now only while a request is open, below), and so did a danger button; and muted words were made with
  opacity. The same unscoped list put the Board's own rules (`display: flex`, half the width, opacity .55 among them) on
  the whole page of a link that says `role=director`, the Board's old name, until its join was answered; each is scoped
  to what it styles.
- `test/resilience.test.js`: the stylesheet's token blocks, one `:root` and one dark, and its hex colours outside them
  counted, 292 now (327 before), a count that only goes down; no opacity between 0 and 1 anywhere in it, however it is
  written (a number, a percentage, a filter's `opacity()`), and none the guard cannot read as a number (a `var()`, a
  `calc()`); a planted sheet holds both reads to their rules. The smoke opens a hall of its own on a 390 × 844 phone
  with a touch screen as On stage, backstage and an observer, and finds each page as wide as the screen, every button of
  each of the hall page's three dialogs on the screen and reached by a tap at its centre, Send a 44 px button named
  "Send to Phone hall", the header's controls 44 px; in both themes the icon buttons 24 px or more at 3:1 or more and
  the presence lines at 4.5:1 or more, neither faded, the On stage tag light in light mode and dark in dark, Help on the
  fault red (from unit E, below, only while a request is open), and 🔥 Priority on it only while pressed (and saying so);
  backstage, with no AI key, ✨ marked not usable with its reason, which a press shows under the composer while nothing
  is sent. A new message has the divider above it and is drawn as an older one is, unfilled and still; scrolled up by 10
  messages with the mouse wheel, a new one leaves what the reader sees where it was, "↓ 1 new" appears, 44 px tall, then
  "↓ 2 new", and the button takes the feed to its end, where the next message is followed; with the divider above the
  view, the next message moves it and what the reader sees stays within a pixel of where it was, with scroll anchoring
  and without it (as Safari before 27 draws); a page away while 25 messages are sent draws them on its return with the
  feed moved to the end once and its layout read a few times in all; and the observer's page, which nothing touches,
  still has its divider above the first new message 30 s and every message later.
- Rolling back: nothing is stored; 0.5.1's stylesheet and hall page come back as they were.

**One word per thing: hall, room, code, seat, the Board, screens** (the plan's Part 5, unit W, its copy deck and
glossary, and the row it shares with unit 2: a failed join and being sent out; the owner's answers 23, "Backstage", 24,
"Show the Board" / "Show Ana", and 30, keep "meetings" in the words Stagewatch reads. Read in Chromium by the smoke, on
the 13 pages named below)
- The admin page said "room", "session" and "meeting" for one thing, a hall. It now reads: "Halls, rooms and people, for
  the admin." under its sign-in; **New hall** for "+ Start new session"; **Halls** for "Active rooms", and "No halls
  yet. Choose New hall to make one."; **Code** for "SESSION CODE"; **Clear messages…** for "Reset session"; **Close
  hall…**, "Close hall …?" and "the files shared only in this hall" for the meeting's; **People in this room** for
  "Users in this session"; **May forward to** for "Linked rooms"; "Choose a hall on the left, or New hall." and "Each
  room has a 6-character guest code: share it with the people who join without an account." when no hall is open; and,
  for the tunnel, "AGMessage is reachable only on the venue's network now.", a room's guest code and "When the show is
  over". The show desk's line says the backstage team proposes and notices are shown in every room. Its native dialogs
  (which the menus' unit replaces) say the same words: "Clear every message in Hall 2?", "Hall name (for example Hall
  2)", "Log this person out of the hall?", "Delete this message for everyone in this hall?".
- A seat has one name, On stage, Backstage or Observer, wherever a page shows it. The presence line reads "Ana joined
  Backstage", "Ben joined On stage", "Wes joined as an observer" (0.5.1: "Ana joined as research"), and a seat the admin
  changes "The admin moved Kim from Backstage to Observer." (0.5.1: "Kim role changed from research to observer by
  admin"); lines already in a hall's history keep their words, and the presence lines among them still fold with the
  rest. The audit log's row keeps its own words ("Kim: research → observer"). The admin page's people list offers the
  seats by those names (the values it sends are unchanged), names an account's seat so, and its live feed tags each
  message so (0.5.1 drew "research" in all three). Roles & invites reads "On stage and Backstage seats need an invite
  link", its title "Lock the On stage and Backstage seats to invite links", its links **On stage link** and **Backstage
  link** (for "Board link" and "Research link"), and an open hall "anyone with the code can join in any seat". A page
  moved by the admin reads "The admin changed your seat to Backstage". The join page's choice of seat is named "Where
  you are" for a screen reader, as its heading reads (it was "Role").
- The hall page: the code's title is "Guest code", and once the page has joined, the room as its header names it ("Hall
  2"), not "Meeting: Hall 2 (CODE)"; **In this room** for "In this meeting"; **Question for the Board** for "Question /
  suggestion for the directors"; the Board's message field asks "Message everyone here…" (the board addendum's words for
  it, which say who reads it), as its placeholder and its label. The join page asks for "The 6-character code for your
  room." and a code no room has reads "No room has that code. Check it with whoever gave it to you."; the halls board
  counts "1 needs help" and "2 need help".
- A page sent out of its hall (logged out by an admin, or the hall closed), or one whose join is refused, shows the
  server's words where the hall was, with **Back to sign-in** (**All halls** on a page opened by an account), and stays
  until the person takes it: 0.5.1 put the words in a toast and left by itself after 2.5 s, before a phone's reader had
  finished them. The page lets its connection go and does not come back by itself, and offers nothing of the hall: an
  open dialog or menu closes, and Help, Screens and People go with the hall. A refusal with no words reads "This code
  doesn't open a room now. Check it with whoever gave it to you." A guest's hall link refused because the browser is
  signed in (above) leads back to its code link the same way. A hall that asks for a sign-in still opens the sign-in
  page.
- What the server says: "Join a room to share files.", "This room needs an invite link for that seat — you joined as an
  observer.", "That name is already in use in this room. …", "— Messages cleared by the admin —" (for "— Session reset
  by admin: messages and documents cleared —"), "This hall was closed by the admin.", and a person logged out reads "An
  admin sent you out of Hall 2." ("of this hall" for a hall with no name; "Removed by admin" before). A transcript of a
  hall with no name is headed "AGMessage transcript", not "AGMessage Session". The restart's own line in each hall reads
  "— AGMessage restarted · 412 messages kept —", not "— Session restored (412 messages preserved) —"; lines already
  written keep their words. The start window reads "Keep this window open while the show runs.", and a clean copy "has
  no hall history, files, keys or settings."
- "research team" leaves every page: the backstage team, in the admin page's AI and Stagewatch lines, the join page's
  Backstage seat ("Crew or the backstage team"), the On stage panel's empty state, the prompt for a reply in words and
  the server's refusal of a draft ("Drafting is for the backstage team."). The admin page calls Stagewatch's confidence
  monitor the speaker's screen, as every other page does.
- The rights and the roles say **screens** for "displays" (`hall.view`, `display.control`, `display.manage`, and the
  project manager's, senior tech's and tech's words), on the Accounts page, and the audit log's line names a screen.
- The AI's prompts say "a Board member on stage" and "the backstage team" for "a director" and "the research team", and
  name the summary's hall as a hall: they shape the drafts the Board reads. Each prompt says how the conversation's
  lines name a writer's seat ("(research) the backstage team"), so a draft does not take the old word from them.
- Unchanged, as the owner answered: the words Stagewatch reads. The context still counts "meetings" ("1 meeting · 2
  people", "no meeting open", a notice "to everyone in every open meeting"), and a notice the show desk runs is still
  "shown in 1 meeting". The pinned self-change words of the Accounts page are unchanged too.
- Left to the units that build what they name: the admin page's other "room" for a hall goes when rooms nest inside
  halls there (#44), its Role column becomes **Seat** with the menus (3b, #24), the join page asks **Your seat** with
  its code-first form (#41), "Reply with text" becomes **Answer in words…** (#55), "Forward to another room" becomes
  **Send to…** (#48), and the stage's own empty states and file hint come with the stage (#62). Their words, and the
  ones this release has not built yet (the Member seat, Chat view, a room beside Main named "Hall 2 › Legal", 📺 Show
  the Board, the laptop's admin, accounts held aside), join `README.txt`'s glossary with them.
- `test/browser-smoke.js` reads 13 pages for an old word ("session", "meeting", "director", or "research" alone or in
  "research team"): the hall page On stage and Backstage on a laptop, and On stage, Backstage and Observer on a phone;
  the hall page opened by an account (Backstage) and by a Viewer account (Observer); the admin's support view of an On
  stage page; the sign-in and join page; the halls board; the Accounts page; a screen; and the admin page watching a
  hall. It reads each page whole — hidden panes, closed dialogs, the message template, the rows, buttons and selects its
  script builds, titles, placeholders, labels — and leaves out only what people wrote or named, what happened and what
  another show system said: a message's words and its sender (a message's own buttons are read), the feeds' lines,
  people's names in a list or a row, help requests' words, the audit log's rows, halls' and rooms' names, a document on
  stage, Stagewatch's context and the show network. A word planted in a closed dialog, a title, a message's button and a
  button in the admin's people row is found; one in the feed's history, a message's words, a sender's name, a person's
  name in the people list or a row, and the admin feed's lines is not. It finds none, and the copy deck's words where
  the plan puts them: the admin page's, its seats and its show desk line, the hall page's, the join form's, the halls
  board's two counts (a hall with one request beside one with two), the rights' words, and a page sent out or refused,
  in place, its open help dialog (from unit E, the Help chip's ask) closed and nothing of the hall offered, still there
  3 s later and gone only by its button. `test/server.test.js` holds the server's words end to end (the closed hall's
  moved on purpose, with the name taken, a file refused, the locked room's note, each seat's presence line, Clear
  messages, a person logged out of a named hall and of one with none, the transcript's title, and the restart's line
  counting the messages its hall kept); `test/resilience.test.js` reads the new restart and presence lines, and
  `test/halls.test.js` the presence and seat-change lines (each moved on purpose); `test/accounts.test.js` holds the
  rights' and roles' words; `test/units.test.js` reads what each AI prompt sends a stand-in model.
- Rolling back: nothing stored changes shape. 0.5.1 shows the lines 0.6.0 wrote into a hall's history ("AGMessage
  restarted", "Messages cleared by the admin", "Ana joined Backstage", "The admin moved Kim …") as they were written,
  and writes its own again; its pages draw a presence line of 0.6.0's as an ordinary line, unfolded.

**Help in two taps, and the asker sees what happened** (the plan's Part 5, unit E, with the board addendum's Help chip;
the owner's answer 25, "a help category sends at once". Read in Chromium by the smoke on a 390 × 844 phone with a touch
screen; not yet walked on a phone or an iPad: that is `docs/DEVICES.md`'s, before the tag)
- Help is two taps: Help, then what it is about. Each category is one large button (Sound, Vision, Lighting, Stage,
  Presenter, IT / network, Something else) that sends at once, and none is chosen for the person. 0.5.1 preselected
  Sound, then asked for the category, the words and Send, which on a phone sat off the screen's edge. "Something else"
  is sent as `Other`, the category the halls board, the transcript and the AI's brief already know. The words come first
  and are optional ("What's wrong? optional"). The heading takes the focus when the dialog opens, so a phone's keyboard
  does not rise over the categories, and Enter in the words moves to the categories and sends nothing (in 0.5.1 it sent
  the preselected Sound); the dialog's one other button is Close. It says who sees a request: "Everyone in this room and
  the hall's crew see it until it's resolved." A request refused comes back in the dialog by its Edit, with its words
  and no category chosen, and a category's tap sends it again.
- Help is neutral and outlined at rest, so red means something: 🔥, open help and a fault. While the person's request is
  open the button is its status chip: "■ Help asked" on the fault red, "▶ Ana is on the way" in the info colour once
  someone says so, and "✓ Resolved" in the ok colour for 30 s after it is resolved, then Help again. The chip reads the
  request as the hall's record of it changes (the `helpUpdate` the feed draws), never what was only sent, and a screen
  reader is told each change ("Your help request: Ana is on the way"). A tap on the chip asks in place, not as a menu,
  naming the request and what each answer does for everyone ("It's sorted marks it resolved for everyone. Cancel request
  takes it away from everyone. Neither can be undone."): **It's sorted** (the asker marks it resolved), **Cancel
  request** (the asker's own delete) or **Keep it open**, where the focus starts; Escape, a tap outside it and Tab on to
  the header's next control close the ask and keep the request. The ask follows the chip in the header, so Tab runs from
  the chip through it, and draws in the top layer where the browser has popovers (fixed in the header's layer, over the
  feed and the composer, where it has not). It goes when its request is resolved or removed, and with the hall when the
  page is sent out. The ask is the hall page's own: the shared in-place ask (`AGM.ask`) arrives with the action
  catalogue, and unit 3c moves it there.
- Nothing changes on the server or the wire: a request is still `message {type: 'help'}`, It's sorted is `help:respond
  {state: 'resolved'}` and Cancel request is `delete`, each as the server already took them from the request's author.
- `test/halls.test.js` holds the chip's two acts as the asker's own, end to end: an On stage seat's request, sent as
  `Other`, cancelled by its author (the hall hears `messageDeleted` and the halls board drops it), and another, with a
  project manager on the way, marked resolved by its author (the hall hears On my way, then the asker's own resolved,
  however the two are delivered on its socket, and the board drops it). The smoke, on a 390 × 844 phone with a touch
  screen as On stage, each step a tap at the control's centre: Help opens the dialog with its heading focused, the seven
  categories, none chosen, and `enterkeyhint="done"`; Enter in the words sends nothing and moves to Sound; a tap on
  Sound sends at once with the words; Help reads "■ Help asked" on the fault red, then "▶ Pat is on the way" after
  another page's On my way; a tap on the chip opens the ask right after it (`role=dialog`, not modal, described by the
  request's words and the answers' consequence, its three buttons on the screen and 44 px, Keep it open focused); Cancel
  request deletes the request for the hall and puts Help back; "Something else" is sent by the page as `Other` (read on
  its own socket, before the server, which keeps a category it does not know as `Other`, reads it) and arrives so;
  Escape closes the ask and keeps the request, and so does Tab from Keep it open, which lands on the header's next
  control; It's sorted resolves it as the asker's, Help reads "✓ Resolved", and Help again 30 s later. On a laptop seat,
  a help request refused leaves Help as it was, and Edit brings its words back to the dialog, heading focused and no
  category chosen, where one tap sends it once as that category. In both themes, On stage and Backstage, Help at rest
  has no red in its fill, words or edge, its words at 4.5:1 or more and its edge at 3:1 or more (computed colours). A
  page sent out with the chip's ask open closes it with the hall.
- Rolling back: nothing is stored; 0.5.1's dialog and its red Help come back as they were.

**Remote phones through the tunnel: bounded per network and in all, and every refusal says what it refused** (the plan's
Part 5, unit X; the owner's answer 33, "Yes they can, Unknown quantities"; the tunnel's limits from Cloudflare's own pages,
mobile addressing from the IETF's RFCs; the tree's tests, the bounds made small, and the hall page in Chromium with
Cloudflare's headers. No number is measured: reading 0's tunnel row (whether an open WebSocket counts against a Quick
Tunnel's 200 in-flight requests) has not been taken, and reading 7, the link before doors, waits for the first show
with remote phones)
- Every per-address bound counts a network (`guard.limitKey`). Through the tunnel an IPv6 address counts as its /64: a
  mobile network gives each phone a /64 of its own and the phone changes its address within it (RFC 6459 §5.2, RFC
  8981), so by the whole address one phone stepped out of every bound. A tunnel IPv4 address and every venue address are
  kept whole (a venue's IPv6 LAN is one /64 for every device on it). The connections (3 a second, bursts of 30), the
  room lookups (2 a second, bursts of 10) and their lockout, the uploads (0.5 a second, bursts of 8, beside each
  connection's own), the wrong-code lock at `join` and the wrong context tokens at `/api/context` count by it. One kind
  keeps the full address, as the plan says: the sign-in's own bounds per address, because through the tunnel its lockout
  per name already holds for the whole tunnel, so a phone's next address is a new allowance but never a way past that
  lock. The audit
  rows keep the full address, and health names none, as before.
- The buckets are never reset. The connection, lookup and upload buckets were cleared whole once they held 5,000
  addresses, so 5,000 new addresses (cheap through the tunnel) handed every drained one its burst back. They are
  `guard.Buckets` now, 5,000 networks at most, the fullest going first, so a flood of new networks leaves a drained one
  drained.
- The tunnel has 150 places (`AGM_TUNNEL_MAX`): at most 150 sockets through it at once, the hall pages, halls boards,
  admin pages and screens that come through it, one network half of them at most (75). Their cause is Cloudflare's 200
  in-flight requests per Quick Tunnel, past which Cloudflare answers 429 and AGMessage never hears of it: on the
  cautious reading that an open page holds one for as long as it lives, until reading 0's tunnel row says, 150 keeps 50
  for page loads, files and uploads. The share is for the places, a
  resource one network could otherwise fill at 3 connections a second, and still seats 75 phones behind one carrier's
  address. The venue never waits for the tunnel: its sockets take no place, and none is refused because the tunnel is
  full.
- A place is for a page in a room. A tunnel socket that within 20 s (`AGM_TUNNEL_JOIN_MS`) has neither joined a room nor
  carries an account, the admin's token or a screen's link is let go and counted: a hall page joins as it connects, so
  one that has not is a probe or a stuck page, and connected again it is counted afresh.
- Every refusal says what it refused. At connect the page is told `{retryMs, why}` with words that name the wait, and
  the hall page, the halls board and the admin page show the server's words in their strip and try again by themselves
  then: "Busy — many phones are connecting from your network. Trying again in 3 s." (`rate`; on the venue "Busy —
  trying again in 3 s.", where 0.5.1 said "Too many connections — wait a moment."), "Many phones from your network are
  already connected through the internet (75). Trying again in 31 s." (`share`, a wait of 30 to 40 s) and "AGMessage's
  internet link is full (150 phones). Trying again in 34 s. On the venue's Wi-Fi there is room." (`full`, 30 to 40 s).
  A screen still tries again in silence. Through the tunnel the wrong-code lock says "Too many wrong codes from your
  network — wait a minute.", so a phone behind a carrier's shared address knows it is the network's; on the venue its
  words are as they were.
- Counted, never named. Health appends `tunnel: {places, max, share, networks, refused: {rate, share, full, idle,
  wrongCode}}` (the refusals are the show day's, from 06:00; `networks` is how many hold a place, never which) and
  `refused: {venue: {rate}}`. The plan also names the tunnel's count `refused.tunnel.full` once, in a test's line; its
  definition (`tunnel.refused`) is the one built, and `refused` holds the venue's only. `tunnelSockets` counts the
  sockets the places count (Cloudflare's address read from loopback), `maxSocketsPerAddress` is kept per lane (`{venue,
  tunnel}`, the tunnel's per network), and a show day's peaks keep `socketsPerAddress` per lane and `tunnelRefused`, the
  day's refusals through the tunnel by kind (`{rate, share, full, idle, wrongCode}`), added up across a restart; at a
  start health's tunnel counts carry on from them, so the card's "refused today" survives a watchdog restart mid-show
  (the venue's count is from the start). Reading 7's "any refusal" reads `rate`, `share` and `full`, the link's
  capacity; `idle` (a probe or a stuck page) and `wrongCode` (a guesser) are counted beside them. A `socketsPerAddress`
  saved by an earlier 0.6.0 build is read as the venue's. The log says at most one line a minute while the tunnel
  refuses: "[tunnel] refused 12 in the last minute: 10 full, 2 one network's share". There is no audit row: a refusal is
  no person's act.
- The admin page's tunnel card reads "Internet link: 37 of 150 places · 12 networks · refused today: 4 full, 1 one
  network's share", and the link's check. The card now hears the tunnel's status at all: it listened before the admin
  page's socket existed, so the address never appeared on it without a reload.
- The internet link is checked from the laptop: once cloudflared says its connection to Cloudflare is registered (its
  banner gives the address before "it may take some time to be reachable", so a check at the address alone would find
  a link not yet up; a cloudflared that words that line otherwise is checked when its 30 s wait for the address is over,
  so the check never rests on that wording, and the reading of its log ends then too), the server asks its own address's
  `/api/health` five times, one at a time, each within 5 s, out to Cloudflare and back through cloudflared, and counts an
  answer only when it is this copy's build. A check is of one tunnel: one stopped or started again meanwhile finds
  nothing, every check's end is said on `tunnel:status` (so no card is left on "Checking…"), and a tunnel that came up
  while another's check ran is checked as that one ends. The card reads "Checked 14:02 · round trip 85 ms (max 140 ms)", or "△ The
  internet link did not answer: remote phones cannot join." ("answered 3 of 5 tries: remote phones may not join." when
  some did). **Check again** asks for another (`admin:tunnelStatus`, as the page already asked on load; no verb is
  added), answered at once with the newest check while the new one comes on `tunnel:status`, whose payload appends
  `checking` and `check: {at, ok, p50Ms, maxMs, words}`; within a minute of the last check, or before the link is up,
  it starts none, and the button says "Checked 20 s ago.", and with the tunnel off "The internet link is off."; an ask
  the server could not answer keeps its words until the next status. It measures the laptop's side of the link, never a
  phone's: reading 7's walk (one phone on mobile data opening the largest hall) is that.
- `test/units.test.js`: `limitKey` cuts the full, compressed, upper-case and dotted forms of one tunnel IPv6 address to
  one /64, keeps a tunnel IPv4 address (an IPv4-mapped one as its IPv4), a venue IPv4 and a venue IPv6 address whole, and
  what is not an address is its own key; `Buckets` past its cap keeps a drained network drained and its own `waitMs`;
  `Places` at a max of 4 (two from one network then its share, four then full, a drop freeing one); the refusals by lane
  and by day and the log's line at most once a minute; the link's check from its tries; the sockets and peaks per lane.
  `test/tunnel.test.js`, end to end with 4 places and a 300 ms wait for a join: the fifth tunnel page refused in the
  full words with `why: 'full'` and a wait of 30 to 40 s while a venue page connects; a third page from one /64 refused
  for its share while the next /64 connects; a freed place taken; a page that never joins let go and counted (again
  when it connects again) while one that joined, one with an account and the admin's stay; eleven wrong codes through
  the tunnel answered in the network's words, a neighbour on that network held too, and the venue still joining; a
  burst from one network refused for the rate in the tunnel's words, and 5,001 other networks leaving it drained (the
  old reset passes 28 of 30 there); wrong context tokens from ten addresses of one /64 locking that network and not the
  next; the day's refusals carried across a restart; with cloudflared (an address of its own per start, as Quick Tunnels
  have) and the link stood in for by a preload and a local server, the check's facts on `tunnel:status`, no second check
  within a minute, a link that does not answer said so, a tunnel stopped and started during a slow check checked as that
  one ends with "under way" never the last word (the old code left it so), and a cloudflared that never says it is
  registered checked at its wait's end and not before. `test/uploads.test.js`: three addresses of one /64 through the
  tunnel share one network's eight uploads (the old keying let them have twelve), and the next /64 has its own.
  `test/reconnect.test.js`: the server's words with `why` shown and their wait kept, a page's own words without it; the
  venue's rate refusal carries `why: 'rate'` and is counted in the venue's lane. The timer count gains the join's wait,
  one per tunnel socket. The smoke: a hall page through the tunnel, its two places taken, shows the full words in its
  strip and comes back by itself once a place frees, without a reload; then that AGMessage's admin page reads the
  card's places and today's refusals, turns the tunnel on (cloudflared and the link stood in for) and shows the link's
  check with Check again held for the minute.
- Rolling back: nothing is stored but the peaks' new keys, which 0.5.1 ignores with the file. A 0.5.1 page cached
  across the upgrade and refused at connect shows nothing and does not retry, as before, until it is reloaded.

**The pages hold on the Board's mixture of devices: a floor, said in words below it, and a fallback for each newer
feature above it** (the plan's Part 5, unit M; the owner's answers 22, "Board will use a mixture of devices", and 4 of
2026-10-31, "Keep these as mim"; browser versions from MDN's compatibility data; walked in Chromium with the features
taken away, not yet on the owner's devices: every row of `docs/DEVICES.md`'s walk reads "not walked")
- The page floor is Safari 14.1 (iOS and iPadOS 14.5) and Chrome 84, read by a probe in `theme-init.js`, the first
  script of every page with people: `WeakRef`, which arrived in those versions with the flex `gap` the layout needs.
  Below it the page says "This browser is too old for AGMessage. Update this device (iPadOS or iOS 14.5, or Chrome 84,
  or later), or use another." and shows nothing else, and no page script opens a socket or asks the server anything, so
  a guest's page never joins the hall it was opened on (the hall page's script ends by throwing at its first line; its
  one console error says why; the admin page asks nothing and polls nothing). No form is sent there either:
  `theme-init.js` holds every submit at the window, so a sign-in form whose script stopped never goes to the page's own
  address with its password in it, whether or not the stylesheet that hides it arrived. 0.5.1 read no floor: a browser
  below it drew what it could and failed where it could not. `theme-init.js` keeps to ES5, held there by a lint block of
  its own. A screen's page reads no floor and never shows the words. No page reads the user agent.
- Dialogs open where the browser has no `showModal()` (Safari before 15.4). `AGM.openDialog` (`common.js`) calls it
  where it exists; elsewhere it opens the dialog as the page's own: fixed in the viewport and centred as a browser
  centres a modal dialog (no transform, so a menu fixed inside it is placed by the viewport), above a backdrop in the
  backdrop's colour, the focus on its first control and kept there, Escape closing it, the rest of the page hidden from
  a screen reader while it is open, and the focus back on what opened it when it closes, however it closes: also when it
  is opened again before the close event of a `<dialog>`'s own `close()` or `method="dialog"` form has come (a task
  later), which then ends nothing of the new opening; one the browser closed itself ends as the next begins. A browser
  with no `<dialog>` at all is also given the dialog's `close()`, `open` and `returnValue`, its forms' `method="dialog"`
  closing, which it would otherwise answer by sending the form to the page's address (a Cancel reloaded the page), and
  the submit event's `submitter`, without which a page cannot tell which button sent its form. A closed dialog draws nothing there:
  0.5.1 drew every one in place on the page. The halls board's four dialogs, the Accounts page's two and the audit log's
  Export…, and the admin page's Accept and Split open through it; the admin page now loads `common.js`. The hall page's
  three (Help, Screens & pages, the Stagewatch dialog) move when the hall page loads `common.js` (the plan's unit 3c):
  until then they need `showModal()`.
- Return in the hall page's composer sends on every device from the floor. It called `requestSubmit()`, which Safari has
  only from 16, so on iPadOS and iOS 14.5 to 15 Return did nothing (and threw); where it is missing, Send's own click
  submits the form the same way.
- `AGM.awake` and `AGM.idle` (`common.js`) are the helpers the Board's view and a first open's older messages will use.
  The first keeps the screen on where the Wake Lock is, asked again each time the page is shown, and where it is not
  says why: "This device may sleep: open AGMessage over HTTPS.", "This device may sleep: set its screen to stay on in
  its own settings (Auto-Lock or Screen timeout).", or, refused by the device or taken back while the page is shown,
  "This device would not stay awake (its battery may be low): plug it in.". The second runs work through
  `requestIdleCallback` where it is (Safari has none) or a timer, each chunk held to 8 ms. Nothing draws the wake
  lock's words yet: the Board's simple view's sheet will.
- The stylesheet's newer rules each follow one every browser from the floor reads: the hall page's height in `vh`
  before `dvh` (below Safari 15.4 and Chrome 108 the page took its content's height and scrolled whole, the composer
  with it); the fields' `:focus` ring in a rule of its own beside the buttons' `:focus-visible`, in both themes (a
  browser that did not know `:focus-visible` dropped the fields' ring with it); the halls board's help strip on the
  card's colour, and its rows' border on the border token, before `color-mix()` (below Safari 16.2 and Chrome 111 the
  strip lost its fill and its rows their lines); and `top`, `right`, `bottom` and `left` before `inset` on the Shown to
  you panel's rail, the support view's backdrop and the Help chip's ask (Chrome 84 to 86 drop `inset`: the rail's
  button had no size there).
- The fences. ESLint refuses a bare `requestIdleCallback` or `cancelIdleCallback` on a page ("use AGM.idle: Safari has
  none"), a `requestSubmit()` not behind its probe, and any read of the user agent however it is reached
  (`window.navigator.userAgent`, `userAgentData`, a computed key, a destructuring), and parses `theme-init.js` as ES5; `test/lint-rules.test.js` holds the
  config to each. `test/resilience.test.js`: `.showModal(` only in `common.js`, behind its probe, and the hall page's
  three counted with the unit that moves them; `styles.css` read for each feature above the floor (`dvh` and its kin
  after the same property in `vh`, `:focus-visible` and `:has(` never sharing a selector list with a selector the floor
  reads, `color-mix(`, `light-dark(` and `text-wrap` after a plain declaration of the same property or inside
  `@supports`, `@container` only inside `@supports`, `inset` after its four sides and a logical property after its
  physical ones, no nested rule), with a planted sheet; 0.5.1's sheet fails it eight times. `test/pagefloor.test.js`
  runs `theme-init.js` and `common.js` as a page runs them: the floor's mark and words (storage blocked or not) and
  nothing above it, every submit held below it; `AGM.awake`'s cause and words for each case, the lock asked again when
  the page is shown, a lock taken back said, `stop()` letting it go; `AGM.idle`'s timer and slice; and it holds every
  page with people to load `theme-init.js` first, a screen's page to load none, and every script of theirs to stop below
  the floor before it first asks the server anything or opens a socket (the four that only define at load named, each
  with its reason). The smoke: at the floor (no `showModal()`, popover API, Wake Lock, `requestIdleCallback` or
  `requestSubmit()`), the halls board's New hall opens through the fallback, fixed in view above its backdrop with the
  focus in it and the page hidden from a screen reader, Escape closes it with the focus back on New hall, and Enter in
  its name makes the hall and closes it; Escape and New hall again in one task, the late close event ending nothing (one
  backdrop, the focus in the name), then Enter, the focus back on New hall; `AGM.idle` runs on its timer and `AGM.awake` says the settings words; the hall
  page in that hall sends by Return, taken once, with no script error; with no `<dialog>` at all beside that, the
  Accounts page's Add a person opens, its Cancel closes it on the page and saves nothing, Escape closes it, Enter in a
  field submits through Save with Save as its submitter, and Export… opens and closes; below the floor (no `WeakRef`)
  the sign-in page, the halls board, the Accounts page, the admin page and the hall page each show the words and
  nothing else, ask nothing (no fetch, request, WebSocket or beacon) while health's `clients` holds and the hall never
  hears of the guest, and the sign-in form, sent, goes nowhere. No script error but the hall page's own one below the
  floor.
- `docs/DEVICES.md` (new): the device matrix (D1 to D7 and CI), the page floor, each feature above it with its fallback
  and where it stands, what CI proves, and the walk on the owner's devices before the tag, every row "not walked" so
  far. A Board device below the floor is not supported: it is a ✕ in the walk until the owner retires it from the
  Board or replaces it, and the floor is not lowered for it.
- Rolling back: nothing is stored; 0.5.1's pages come back as they were.

**An On stage seat chats, answers and asks for help; it shares no file, asks no question and forwards nothing** (the
plan's Part 7, unit G; the owner's ask of 2026-10-26, "The Boards chat view doesn't need to let them add file attachments
or create action prompts. They can chat and respond", and answer B2, "Anyone in that same room sees the messages";
probed in 0.5.1 on a throwaway server, where an On stage guest's upload, file message, question and forwards into
another hall, through the admin's link too, were each accepted)
- On stage seats are no longer given an upload token, and cannot share files, post questions, or forward anything into
  another room. A seat now has a limit, read before any right (`rbac.SEAT_LIMITS`, `seatAllows`): On stage holds
  reading and writing messages and nothing else, and the server refuses the rest by the seat, whatever the page sends.
  A file message is refused with "On stage seats send messages, not files.", a question with "Questions for the Board
  come from the backstage team.", and every forward, text included, whatever hall it names and whatever link the admin
  gave, with "Messages from On stage stay in this room.", before the message is read or the rate taken, in the same
  words whatever hall the code names (only a repeat of the person's own earlier forward, made before the seat moved, is
  answered with what it did); the forward picker offers no room. Screens, a hall's set-up and the show network are refused from an On stage page with "Do that from a
  backstage page." (the show network's list too, never an empty list), and drafts with "Drafting is for the backstage
  team.". A text, a reply, 🔥 Priority (stored as priority), a help request, a reaction and an answer to a question, in
  words up to 200 characters, are taken as before.
- The admin seated On stage from the token is held to the seat on that page: no upload token, no file, no question, no
  forward, no speaker's screen, no drafts, no screens or set-up. Its admin verbs answer as from any of its pages, and
  its pages in no hall are not limited. The seat is the page's: a guest On stage in one hall and backstage in another
  keeps backstage's rights on that page.
- An upload token is checked again when it is used, and the admin's move of a page to a seat that shares no file ends
  it in the same tick, without waiting for the page's reload: its next use is refused in that seat's words ("On stage
  seats send messages, not files.", "Observers can read but not post.") and it is gone, and a page moved back before
  using it uploads nothing more with it (its join after the reload takes a new one). In 0.5.1 a token uploaded for as
  long as its page stayed open.
- Forwarding from a backstage page keeps two rules of the room a message comes from: a file moves only from a seat that
  may share files there ("Files are moved by the backstage team."; in 0.5.1 a guest who only reads one hall and sits
  backstage in another could take the first hall's files into the second), and a file or a question goes only where the
  forwarder sits backstage, never into a room where the same person sits On stage ("You may not share files in that
  hall.", "Questions for the Board come from the backstage team."), which the picker no longer offers for either. A
  picker emptied by a rule of the room the message comes from says that rule in the forward's words (`myRooms`' `why`),
  and the page shows them instead of asking for a hall the person may already have open. A guest seated both On stage
  and backstage in one room forwards into it as backstage, whichever page joined first (0.5.1 took the first seat that
  could post). With no seat there, the admin's link posts and shares files as before, by a set of its own
  (`rbac.LINKED_CAPS`).
- The hall page offers no ↗ on any message On stage, and none on a file from a page given no upload token (an observer,
  a Viewer account), which the server would refuse. The Board's composer already held the words, 🔥 and Send only.
- `test/onstage.test.js` (new), end to end: an On stage guest given no token and refused a backstage upload as a file
  message and a question; its text, reply, 🔥, help request, 👍 and an answer of 201 characters stored (at 200); its
  forwards of a text, a file and a question refused with hall B's number unchanged, and no room offered for either; its
  screens (every `display:*` verb), set-up (every `hall:*` verb), show network and draft refused in their words; a
  backstage guest's question and file refused into a hall where it sits On stage, and not offered, the question's
  picker saying why; one seated On stage and backstage in a room, On stage first, forwarding a question into it stamped
  backstage; a backstage guest forwarding a file through the admin's link and an On stage guest forwarding nothing
  through one; an observer's file refused into a hall where it sits backstage, its picker saying why, while a text
  still goes; a token moved On stage refused and gone, one moved to observer refused, one moved On stage and back
  refused, its page's new token taking a file, and another backstage token still taking one; the admin On stage from
  the token refused each in its words while `admin:setRole`, `admin:watchRoom` and `nodes:link` answer in theirs, and
  the same token's page in no hall listing the hall's screens. `test/accounts.test.js`: `seatAllows('board', …)` true
  for `hall.view` and `hall.post` alone of every right, and every right for backstage and observer.
  `test/server.test.js`'s join now holds a backstage token and an On stage seat's `null`. The smoke: an On stage page
  shows no ↗ on a text, a file or a question, and its composer the words, 🔥 and Send; a backstage page offers a file's
  ↗ and a Viewer's page does not.
- Rolling back: nothing is stored; 0.5.1 gives On stage seats files, questions and forwards again.

**An On stage seat answers only its own help request** (the plan's Part 7, unit G2; the owner's answer B1, "they don't
need to answer other people's help requests other than interact with the usual chat"; the tree before it took an On
stage guest's On my way on someone else's request, the new test's first step)
- Help requests are answered by the backstage team. An On stage page marks its own request resolved (It's sorted on its
  Help button, or Resolved on the request) and nothing else: On my way or Resolved on someone else's request, and On my
  way on its own, are refused with "Help requests are answered by the backstage team.", whatever hall the request's code
  names, before any right is read, and for the admin seated On stage too. The request and its hall are left as they
  were. The same person's backstage page in that hall, the backstage team and the admin's pages in no hall answer as
  before, and the Board's own Resolved said again is done already, never refused.
- The hall page On stage draws no On my way or Resolved on someone else's request, and Resolved alone on its own.
- An account answers a hall's help requests as its crew only where it may post and does not sit On stage
  (`rbac.answersHelp`), its own request's Resolved excepted, and the halls board's On my way and Resolved (`canRespond`)
  read the same. Accounts are not seated On stage yet, so this changes nothing until they are; from then a Board account
  answers none of its hall's requests from any page, the halls board included.
- `test/onstage.test.js`, end to end: an On stage guest refused On my way and Resolved on a backstage guest's request,
  with no code, its own hall's and another hall's where the same person sits backstage, each request still open and
  neither hall's number moved; the admin On stage from the token refused the same, while the token's page in no hall
  answers from the board; a backstage guest answering both, on the Board's request too; the Board's On my way on its own
  refused, its Resolved stored as its own and answered `already` when said again; its own request in another hall
  refused from the On stage page as from any page outside that hall, and answered from its backstage page there.
  `test/accounts.test.js`: `answersHelp` true only where the account may post and is seated backstage. The smoke: an On
  stage page draws no On my way or Resolved on a backstage request and Resolved alone on its own, whose press marks it
  resolved by the Board member, and a backstage page draws both on the Board's request.
- Rolling back: nothing is stored; 0.5.1 lets On stage seats answer anyone's help request again.

**One action catalogue draws a message's buttons and its right-click, ⋯ and Shift+F10 menus** (the plan's Part 5, unit
3a; the owner's ask that right-click menus and the buttons be in step; measured on a VM in Chromium, the plan's §16.1: a
`confirm()` left open 20 s dropped the page's socket, and 30 s told the whole hall its person had left and joined again;
the tree before it had no context menu, a pinned message whose 🖥, 📝, ⧉ and help buttons did nothing, and native
dialogs on a message's and a screen's acts)
- Every act the hall page offers on a message, on a file in its panel and on a screen of its Screens dialog is one entry
  of one catalogue (`app/public/catalog.js`): its label, icon and key, its group, the server verb it sends and in which
  of the outbox's modes, the rights that show it (each matched to a refusal the server words) and what it fits. A
  message's row keeps at most two acts and a ⋯: ↩ Reply, and the seat's main act — 📝 Ask the operator… where the hall's
  Stagewatch keeps a desk, else 🖥 Send now to the speaker's screen, else ⧉ Show on screens…. Right-click, ⋯ and
  Shift+F10 (or the menu key) open the same list, in groups — respond, send, keep, then the danger last — with each
  key beside its act. Speaker's screen ▸ holds Ask the operator… (Edit, then send… where Stagewatch keeps no desk: the
  same box, to change the line and choose its urgency before it goes) and Send now; React ▸ the eight reactions, yours
  checked; Answer ▸ a question's answers; Send to ▸ the halls the server says would take the message ("Looking…" until
  it answers, its words when there is none). Pin, Look, Download, Copy text and Delete… are in the menu. A screen keeps
  Identify on its row, and Tick only this one, Copy link, Open, Rename…, New link… and Remove… in its ⋯. A file in the
  panel's pinned list keeps 👁 Look and 📌 Unpin, and the file open in the panel 📌 Pin and Close (it read "✕ Dismiss"),
  each with its ⋯.
- An act the seat may never do is absent. One it may do but not now is shown disabled and focusable, its reason on a
  second line, which choosing it says again, sending nothing: not connected ("Not connected — AGMessage is
  reconnecting.", for an act on something; a send the outbox holds stays live, "◷ sent when the connection is back"),
  the hall's Stagewatch not connected (in its words), no screens yet. An observer's and a Viewer's menu holds Copy text,
  and Send to on words where they may post in another hall: no pin, reaction, answer, Look or Download (a Viewer account
  granted posting neither). On stage: no Download, Send to, Show on screens or speaker's screen. Download is kept off
  those pages by the menu alone for now: the server withholds a file's link from them with the stage's units. The admin's support view draws the person's menus with every
  item disabled — "This is Chair's view — act from your own page." — and sends nothing.
- Keys on a message that has the focus (click it): R reply, E react, F send to, P pin, D download, Enter look, Delete or
  Backspace delete…. A pin or an unpin says so with Undo for 10 s ("Pinned. · Undo"). Shift+right-click, a text field
  and a text selection inside a message keep the browser's own menu.
- No act on a message, a file or a screen opens a native dialog. Delete…, New link… and Remove… ask in place, naming
  what they act on and what follows, the safe answer focused and Escape its "no"; Rename… and Answer in words… (it read
  "Reply with text") are a field in place; a link the browser will not copy (a page over plain http has no clipboard
  API) is copied with the browser's own copy, else shown in a field to copy by hand. Inside the Screens dialog a menu and
  its asks open in the dialog, and Escape closes them, not it.
- The pinned strip draws each pinned message from its record, so its 📝, 🖥, ⧉, answers and On my way act as in the
  feed (it copied the feed's message, which lost them), and draws it again in place: a reaction from another page keeps
  the focus on a pinned message, and a menu opened from it gives the focus back to it. An open menu keeps its items and
  their order while its message changes: Pin reads Unpin in place, React ▸'s and Answer ▸'s checks follow, an act no
  longer possible turns disabled ("Not available any more."), and a message or a screen removed closes its menu or its
  ask ("That message is gone.", "That screen is gone."). The feed does not move while a menu or an ask is open, and a
  menu's ⋯ stays where it was when a line is drawn into a message above it (a seen receipt) or a strip is shown above the
  feed; where it cannot stay, the menu follows it. A menu with no room for all its rows under or above its ⋯ takes the
  side with more room and scrolls, never over it. The ⋯ opens its menu and closes it again. An ask opened by a key gives
  the focus back to the message the key was pressed on; a menu says what it acts on to a screen reader ("Message
  actions: Message from Kim · 14:02").
- The join's answer appends `forwardable` at its end: whether a message here could be sent to another hall, by the
  rule Send to ▸ lists halls by (`myRooms`, both read through `forwardTargets`), and false On stage. The page asks again when the admin lets it forward into
  another hall or takes that back (`linkedRoomsChanged`, which no page heard before) and when it is shown again, since
  another hall may have been opened in another tab. ↗ Send to is offered only then.
- One line above the feed on the first open in each browser: "Delete, Ask the operator and Show on screens are now in ⋯
  — or right-click, or Shift+F10.", gone for good with Got it.
- The catalogue knows the Board's simple view, which no page draws yet: there no object has a menu, and its acts are its
  buttons — 👍 Got it (a held 👍, "Got all N" for N plain messages waiting, one each) and ↩ Reply on the newest plain
  message from backstage waiting and on each 🔥 one, a question's answers, a file's Look. The facts gain `view`, the
  messages that wait for the person's answer, whether the account is a Viewer, and `ask` and `respondHelp` (a question
  and an answer to others' help come from backstage). A draft of a reply is refused at once while the page is down.
- The fences (`docs/ANALYSIS.md` §3.6): `test/catalog.test.js`, pure, holds the entries' shape, groups, keys, icons,
  verbs (each one the server registers, or local) and modes, the one-word rules, one icon for one act (↩, ↗ and ⤴
  kept to theirs; a screen's Open, Tick only this one and Rename… have icons of their own), and for 16 seats (the Board
  in both views among them) and 10 objects the shown sets, the inline bar, the disabled reasons, the folds, the caps (12
  items, 2 dangers) and Got it; `test/menus.test.js`, with the hall's Stagewatch linked, sends every act each of seven
  seats is not offered, as that seat, to a real server, and holds each refused with words (the On stage seat's, the
  words its table names) and nothing changed, and the join's `forwardable` to the rule Send to ▸ lists halls by
  (`myRooms`: alone, with another hall, On stage, the admin's link given and taken back, the support view); `test/resilience.test.js` holds `contextmenu` to `menus.js` and `cloneNode` in the hall page to
  its message template; the module fence reads the catalogue's verbs and keeps no event unheard. The smoke:
  right-click, ⋯ and Shift+F10 open the catalogue's set for ten messages on three seats, a file in the panel's list and
  open, and a screen inside its dialog, the key's menu focused on its first enabled item and Escape giving the focus
  back, and the ⋯ clicked twice closing it; the row's acts are in the menu under the same names; the pinned strip's
  acts, and its focus kept through another page's reaction; a disabled act says why and sends nothing; an open menu
  keeps its order; P and Undo; F's Send to ▸ ("Looking…", the hall, the forward), E's React ▸, D and Enter on a file,
  Answer in words…, Delete's ask and the focus after it, Copy text with no clipboard API, New link…, an ask about a
  screen removed elsewhere; the support view; a menu's words at 4.5:1 in both themes; a message's acts 44 px under a
  finger; and every page fails the run on a native dialog.
- The stylesheet loses the five icon-button variants, the forward and reaction pickers, the observer's hiding rules
  (which offer is the catalogue's) and the panel's own Pin button: 11 hex colours fewer, 281.
- Rolling back: nothing is stored but the browser's `agm.moved`; 0.5.1's page ignores `forwardable`.

**The admin page, the halls board and the Accounts page act from the catalogue, and no page uses a native dialog** (the
plan's Part 5, unit 3b; the owner's ask that right-click menus and the buttons be in step; the measured cause is unit
3a's, the plan's §16.1: a native dialog left open 20 s dropped the page's socket; the tree before it had 30 native
dialogs on these pages — the admin page's 29, three of them the prompts that linked a Patterns or PlayMap, and the
Accounts page's one — and the theme toggle drawn over the admin's Logout at every width)
- Every act of these three pages on a thing is an entry of the catalogue, drawn by the one runner every page now shares
  (`AGM.acts` in `app/public/menus.js`): the thing's bar, its ⋯, right-click, Shift+F10 (or the menu key) and its key
  open the same list, absent where the seat may never do it and disabled, with its reason on a second line, where it
  cannot now. On the admin page: a hall in the list and the watched hall's header (kind `adminRoom`: Watch, Transcript,
  ✨ Minutes, Roles & invites, then Clear messages… and Close hall… last); a person (`person`: Seat ▸ for a code guest,
  Let them forward into ▸ — every other hall, ticked where they may now — No longer forward into ▸ — the halls they may
  forward into now, which an unticked hall and a chip's × are doors to — Open their view, then Log out…); a message of
  the live feed (`adminMsg`: Copy text, then Delete for everyone…); the default Stagewatch, each show system heard and
  each Patterns or PlayMap linked (`link`: Propose… (the drive right's), Use this address, Copy address, Set up… — the
  default Stagewatch's address, node key and fingerprint in one form, as on the page — Link… or Set up… for a node,
  Accept certificate… or Confirm fingerprint…, then Unlink…); and the internet link's card (`tunnel`: Check again, Copy
  address, Turn on, then Turn off…). On the halls board: a hall's row (`hall`: Open, Open in a new tab, Copy link, Copy
  guest code, Set up…, Show network…) and an open help request (`help`: On my way and Resolved as its bar, and Open its
  hall). On the Accounts page: an account (`account`: Edit… as its bar, New one-time password…, Sign out everywhere…,
  then Turn off… or Turn on, and Remove…) and an entry of the audit log (`audit`: Copy this row — its mark with it —
  Only this actor, Only this target, Show all, then Check the log, Export the log… and, on an archive point and for the
  admin alone, Split the log here…).
- No page opens a native `alert`, `confirm` or `prompt`. A question is asked in place, named for its object, its buttons
  verbs, the safe one focused and Escape its "no": Clear every message in Hall 2? [Clear messages] [Keep them]; Close
  hall Hall 2? with its tick for the files shared only there [Close and delete] [Keep it open] (it was a panel of its
  own); Delete this message for everyone in Hall 2? [Delete for everyone] [Keep it]; Log Kim out of Hall 2?, saying by
  case whether Kim can come back (a code guest with the code; an account still has the hall, and how to keep it out);
  Turn the internet link off? (the toggle asks too, and shows the link on until it is off); a new certificate, a
  Stagewatch certificate accepted, an account's new one-time password, signing it out everywhere, turning it off or
  removing it. New hall's name is a field in place. A Patterns or PlayMap is linked or set up through one form of three
  fields — its pairing token (a password field the browser keeps nothing of), the hall from a pick list of the halls
  (it was a typed code; a hall it is linked for that the page does not list stays chosen, "· not listed here now", so a
  Save never moves it to every hall), its certificate's fingerprint — and a node's certificate is confirmed through one
  field. A refusal or a result is said in the page's toast. The admin's page stays connected while a form is open. A
  code guest's Seat select shows the seat the server keeps until it answers (a choice made offline, or refused, puts it
  back). The default Stagewatch's address and fingerprint fields keep what a person typed, or what Use this address
  put there, until it is saved: the settings read every 5 s no longer write over them.
- The admin page's header holds New hall, the theme and Logout as ordinary buttons in its row: nothing is drawn over
  Logout at any width (the theme toggle was fixed over it). The people's table names its column Seat. The watched hall's
  header keeps its code, people and messages, and the rest of its acts are on its ⋯; Roles & invites and ✨ Minutes open
  under it (watching the hall first when it is another). The linked-hall picker, the Close panel and the destructive
  button style go.
- The halls board: a hall's name is its row's one link, covering the row (a click, a middle click or a Ctrl+click
  anywhere on it opens the hall, and a screen reader reads a link), its ⋯ above it; its right-click is AGMessage's menu,
  which offers Open in a new tab. A hall with no Stagewatch says "○ No Stagewatch linked" quietly, without the dark
  "--:--" box. Set up is on the row's ⋯. Rows and help requests are drawn again in place, so a frame every second keeps
  the focus and an open menu. The row's chips sit above its link, so a screen chip's and a node's state words are read
  on hover, and each says them to a screen reader beside its name.
- The Accounts page: a row the viewer may not change keeps Edit, disabled with the server's reason, readable on its
  button, in its menu (on a touch screen too) and in the toast when it is chosen (it was a disabled "Locked" button
  whose reason only a mouse could read). An act's answer not back in 5 s, the editor's Save included, says "No answer —
  check the connection." (in the editor when it is open), and the answer that comes later is still the act's, said as
  late: a new one-time password that comes late is shown all the same, and a Save is held, never sent twice, until it is
  answered. Split the log here… runs as long as the split takes, saying "Splitting…" meanwhile, then what it moved and
  the log read again. The audit log can be kept to one actor's or one target's entries, said above it with how many are
  shown, and Show all brings the rest back.
- Each of these pages has a skip link as its first Tab ("Skip to the halls", "Skip to the accounts", or "Skip to the
  audit log" for one who reads only that), and its lists are one tab stop each (`AGM.roving`): ↑ and ↓ between the
  halls, the people, the messages of the admin's live feed, the links, the help requests, the accounts and the entries,
  Home and End, Tab into the one with the focus. Under a finger, the text buttons of these bars are 44 px, as the icon
  buttons and the ⋯ were.
- The fences (`docs/ANALYSIS.md` §3.6): ESLint's `no-alert` on every page script and page module, with a test that a
  planted `alert`, `confirm` or `prompt` fails the lint; `test/catalog.test.js` holds the nine new kinds to the rules
  (their verbs among the required ones, the HTTP routes the Accounts page sends included) and asserts each page's facts,
  39 seat-and-object sets, the disabled reasons (Check again's four, a locked account, the minutes with no key, a node
  whose Stagewatch keeps no desk, not connected), the bars, the asks and their words (a node's hall kept when it is not
  listed), the caps and the keys; every act's words are read on an object it fits. `test/menus.test.js` sends every act
  of these pages each seat is not offered — as a Staff account and a code guest on the admin page, a Viewer on the halls
  board, and on the Accounts page a Staff account, a manager and a manager who may manage accounts but not an admin's —
  29 verbs and routes in all, and holds each refused with words and nothing changed (a guest's forwarding and the
  default Stagewatch included). The smoke: right-click, ⋯ and Shift+F10 open the catalogue's set on a hall in the admin
  list and the watched hall's header, a person, a message of the feed, the internet link's card, a linked Patterns, a
  hall's row and a help request on the board, an account and an entry of the log; the asks named and answered "no" with
  nothing changed; Logout, the theme and New hall not covered at 1440, 1024 and 390 px; the skip links; the halls one
  tab stop with ↓; a hall's menu kept open, in order, through a board frame that redraws its row; Let them forward into
  ▸'s ticks, No longer forward into ▸ offered once linked, an untick and a chip's × each taking it back; a hall's name
  its row's one link and a middle click opening a tab; the log kept to one actor and back; a locked row's reason on its
  button, in its menu and in the toast, and no request made for it; Check again on an internet link that is off saying
  why on its button and in its menu and sending nothing (the page's emits counted); the three pages in both themes
  (their bars 24 px or more, icons at 3:1, words at 4.5:1, none faded, their menus' words at 4.5:1) and on a phone
  (their acts and ⋯ 44 px under a finger); a Patterns set up through the one form held open 30 s with the admin page's
  socket connected throughout. A step of the export's smoke that read an answer's body no longer stops the whole run
  when the request it paused has none.
- The stylesheet loses the linked-hall picker and the destructive button's rules: 6 hex colours fewer, 275.
- Rolling back: nothing is stored.

**The rest of the hall page acts from the catalogue, and the hall page has no blocking dialog** (the plan's Part 5, unit
3c; the measured cause is unit 3a's, the plan's §16.1: a native dialog left open 20 s dropped the page's socket; the tree
before it opened the hall page's three dialogs with a bare `showModal()`, which a browser below Safari 15.4 does not
have, drew a forward's result in a toast of its own that no screen reader heard, drew an observer's answers to a question
as buttons that did nothing, and had no skip link, five Tab stops a message and no menu on a person, the composer or the
header's chips)
- The rest of the hall page's acts are entries of the catalogue, each drawn by its bar, its ⋯, right-click and
  Shift+F10 (or the menu key) alike: a person (`person`, the hall page's half: @ Mention, which puts "@Kim " in the
  message box where the cursor is), from a row of the People panel or a message's sender's name, which is a button that
  opens that person's menu wherever the seat has an act on them (one's own name stays words); the composer (`compose`:
  Send is its one act on the row, named for where it sends, and its ⋯ holds ✨ Draft a reply, Send, 🔥 Priority — a
  toggle, checked while pressed — Attach a file…, Remove the file once one is chosen, and Cancel the reply (Esc) while
  replying: Escape anywhere in the composer takes a reply back, the composer's catalogue key); the stage chip (`chip`: Speaker's screen…, the line
  box opened empty, and Show the countdown on screens, the screens Screens has ticked); and the code chip (`code`: Copy
  guest code, Copy join link — the join page's link with the code). A chip with an act for this seat is a button whose
  click opens its menu; one without stays words. A chip and a sender's name are targets of 24 px, 44 px under a finger,
  as the header's buttons are; a page sent out of its hall, or refused at its join, offers neither chip. Send, Enter, 🔥, ✨, the reply's × and the file's Remove each run
  their act through the one checked path, so a send the page cannot make says why ("Choose a file first." where Send
  was greyed with nothing said), and the admin's support view sends nothing from its composer, its Help's categories or
  its Help chip's answers either ("This is Kim's view — act from your own page."); its banner reads "what Kim sees.
  Nothing here acts: act from your own page.", where it read "acting as Kim". ✨ Draft a reply with AI drafts off is
  greyed with why in a message's menu as in the composer's (it was left out of the message's): AI off is the laptop's
  state, not a right. The text field keeps the browser's own menu. A kind two pages draw (`person`: the
  hall page's half here, the admin's on the admin page) fits each page's rows only on that page, by the page's facts.
- One toast on every page (`AGM.toast` in `common.js`, which the hall page now loads): a `role=status` region, so a
  screen reader hears what an act did or why not; its Undo held 10 s while hovered or focused. A forward's "Forwarded
  to …" had a toast of its own, with no role, drawn over the other; and a problem's toast read white in dark, a dark
  rule outranking its colour: it is on the fault colour in both themes. The stylesheet's three toasts are one.
- The hall page's Help, Screens and Stagewatch dialogs open through `AGM.openDialog`, so they open below Safari 15.4 too
  (they did not); no page script calls `showModal()` itself. The Help chip's ask is the pages' one ask in place
  (`AGM.ask`), with its words, its three answers (It's sorted, Cancel request, Keep it open, the last focused) and its
  place right after the chip, so Tab runs from the chip through it and on; a tap on the chip closes it, as its own
  door. Any other ask opened from a ⋯ (Delete…, Log out…) is answered no by that ⋯ pressed again, as by any press
  outside it, so no ask is left open beneath the menu the ⋯ opens.
- The first Tab on the hall page is a skip link: "Skip to message box" takes the focus to the composer, and "Skip to
  messages", for a seat with no composer, to the newest message. The feed is one Tab stop, the newest message until the
  focus has been in another: ↑ and ↓ between messages, Home and End, Tab into the one focused, its keys and Shift+F10 on
  it; a question pinned (answered in the pinned strip) is passed over. ↑ in the empty message box goes to the newest
  message and Escape on a message back to the box. The pinned strip, the People panel, the panel's files and the
  Screens dialog's screens are one Tab stop each. A list's rows are set as they are drawn, each once (the list is read
  once for each batch of changes, to place its stop, and never set whole again), and a control left out of the tab
  order gets its own tabindex back. Escape follows the plan's order as far as its steps exist: an open menu closes, then
  an open ask is answered no, then in the composer a reply begun is taken back, and on a message the focus goes back to
  the message box; the take layer's step (minimised, before the reply) comes with the take layer (unit 18), and the
  simple view's with its unit (20a).
- An observer, or a Viewer, reads a question's answers as words, "Options: Yes · No", with the live tally, where it had
  buttons that did nothing. The action and file panes' "Send to stage" read Send, as the message box's does (one word
  per thing: a chat message is sent), and ✨ reads "✨ Draft a reply", as the message's menu does.
- The fences: `test/catalog.test.js` holds the four kinds to the rules (`message` among the required verbs; the facts gain
  `page` and `mayKnowCode`) and asserts 23 seat-and-object sets of the composer, the chips and a person, the simple
  view's (no menu; Send and 🔥 its buttons), the bar (Send alone, named for the room), the reasons (no file chosen, AI
  drafts off, the link down, no screens, not connected, a held send live, the support view), the toggle and the caps,
  and that each page is shown only its own half of `person`. `test/menus.test.js` sends every act of these kinds each
  hall seat is not offered — a message as an observer or a Viewer, a draft as an On stage seat, the speaker's screen and
  the countdown as a seat without their rights — and holds each refused with words and the hall as it was, reading only
  the rows the hall page draws. `test/resilience.test.js` holds `showModal()` to `common.js` alone (the hall page's
  three counted sites are gone) and the hall and admin pages to load `common.js` before their scripts, and no page script
  but `common.js` to name the toast's class or id (a toast of its own), the stylesheet's one toast class `.agm-toast`.
  `test/catalog.test.js` also holds Cancel the reply's Escape and ✨'s one rule with AI drafts off. The smoke: one
  toast, a `role=status` region; a sender's name, a People row, the composer's Send, the stage chip and the code chip,
  each opened by its every door to the catalogue's set; Mention; 🔥 checked in the menu; the text field's own menu; the
  feed one stop, ↑ from the box, ↑ again, Shift+F10 and Escape twice; Speaker's screen… empty, the countdown on the
  hall's screens; Copy join link; the skip link on a fresh page and an observer's, whose question reads as words; a ⋯
  pressed again under the Delete… it opened, which answers it no; the chips and a sender's name 24 px or more, and those
  and the composer's ⋯ 44 px on a phone; a page out of its hall with no chip that opens a menu; the support view's Help
  sending nothing and its banner's words; and at the floor, Help opening through `AGM.openDialog`'s own, its Close (the
  form's own) and Help again in one task leaving one opening and one backdrop, the focus back on Help once a category
  sends it, and its chip's ask in place.
- The stylesheet loses the hall page's two extra toasts, the Help chip's own ask and the disabled answer's rules: 10 hex
  colours fewer, 265.
- Rolling back: nothing is stored.

**A folder or a key that cannot be used stops the start with words; nothing is written before the folder is held; nothing
secret is made again over one that could not be read** (the plan's Part 6, unit U1, with the owner's answers 34 and 35;
the plan's readings on Linux, which this unit's tests take again: a data folder that could not be made ended the server
with exit 1 after 42 ms, and the watchdog started it again 7 times and gave up, about 89 s; a copy refused at the data
folder had already written `machine.key` and `tls.json`; and the code made a new `secret.key` on any read error, a new
certificate over a `tls.json` whose key did not open or that did not parse, and a new context token over one that did
not open. Nothing of it is run on Windows yet)
- Nothing is written before the copy holds its data folder and its port. Every store is read first, and only then are
  made: the rooms and uploads folders (multer made the uploads folder as it was built, before any hold); the machine
  key, the certificate and `secret.key` where there are none; the settings' saves asked meanwhile (a new node id, the
  0.2 keys kept in clear, now sealed with a machine key made at the same start); and the watchdog's give-up marked as
  seen. A copy refused at the folder or the port has written nothing, in its data folder or its key folder; a stop or a
  crash before the hold saves nothing and writes no crash record (another copy may own those files); a Stagewatch link
  that answers before the hold has its `stagewatch.key` row written once the log is open. A data folder not made yet is
  held by its path as given, without a word.
- A folder that cannot be used stops the start with code 3, which no watchdog starts again, and its words: "AGMessage
  cannot start: the uploads folder … cannot be made (ENOTDIR). Choose a folder this Windows account can write to
  (AGM_UPLOAD_DIR), or fix that one's permissions." The watchdog says it of the data folder, the server of its rooms
  and uploads folders, in either channel, and of a rooms folder that is there but cannot be read ("the rooms folder …
  cannot be read (ENOTDIR)", a file in its place, or a folder this account may not list), before anything is written.
  It was exit 1, a crash to the watchdog, seven times and a give-up. The server writes nothing first; its watchdog has
  made the data folder and adds its line to `watchdog.log`.
- `AGM_RUNS` names the channel: unset or empty, the portable folder; `portable`; `task`, the installed node. Any other
  word (`service`, `session`, `Portable`) is refused, by the watchdog and the server, before anything is written. Under
  `task` the data, uploads and key folders are each named (`AGM_DATA_DIR`, `AGM_UPLOAD_DIR`, `AGM_KEY_DIR`), a full path,
  and outside the program's folder (the one that holds `app\` and `node\`, where an upgrade replaces files), read as
  written: a folder named `..data` is inside, and a `\\?\` or `\\.\` prefix, another spelling of the same folders, is not
  a full path; else code 3 with which and why, before any write. No build sets `task` yet: the installer's units do.
- The installed node never runs without its keys. A `machine.key`, `secret.key` or `tls.json` that cannot be read, a
  machine key missing while values sealed with one are in the data folder (or while `settings.json` or `displays.json`,
  which hold them, cannot be read, so none can be ruled out), or a sealed value that does not open with
  it (the AI key, the Stagewatch key, the context token, a hall's Stagewatch key, a Patterns or PlayMap link's token, a
  screen's link, the certificate's key) is code 3 before anything is made, its words naming the kinds and never a
  value: "1 sealed value in … does not open with the machine key in … (the context token). Nothing was changed: the
  installed node does not run without its keys, and never makes new ones over them." Its port in use, or its data
  folder held, is code 75: the watchdog starts it again on its ladder (0.5, 4, 8, 15, 30 s, the last repeating) for as
  long as it is held, never counted as a crash and never given up, so whatever holds the port or takes the folder
  pipe's name during a restart cannot keep the node down; each try is said on its console, and `watchdog.log` takes the
  first of such a run and every hundredth after it, with its count (2,880 tries a day at the last step otherwise). A
  certificate in date whose renewal fails is kept, said and served, as in the portable folder; only one that cannot be
  made at all is code 3. A portable copy still stops with code 3 at a held port or folder, where a person reads its
  words.
- Each secret is made only where there is none (ENOENT). `secret.key` is published whole and never over one (on a
  drive with no hard links, by the atomic writer's rename in the folder the copy holds); `tls.json` by a hard link that
  refuses one another start made at the same moment, which is then taken; the machine key as unit H made it. Any other
  failure, in the portable folder, and this run goes without and says so in the window, the file left as it is: a
  secret of its own ("Secret: … could not be read (EISDIR). This run signs guests and invite links with a secret of its
  own, …"); HTTPS off with why ("HTTPS: off — the private key in … does not open with this laptop's machine key. It is
  left as it is"), a TLS handshake ended until a certificate is there; a context token kept as it is, every token read
  refused with 503 and the words ("This AGMessage's context token does not open with its laptop's machine key, so no
  context token answers. Its admin makes a new one: New token, on the admin page."), never counted as a guess, and the
  admin page saying the same under the token until New token makes one. A certificate near its end, whose key opens, is
  still renewed. A `settings.json` that cannot be read (EBUSY, EACCES) is never written over that run, and its `.bak`,
  a save behind, is never taken for it (a token or link saved since is only in the file): the run goes without its
  settings and says so ("Settings: … could not be read (EBUSY). Nothing is saved over it this run, …"), makes no context
  token (token reads 503 with why), and refuses every setting changed with why ("Not saved: … could not be read (EBUSY),
  so this run saves no setting over it. Start AGMessage again once nothing else holds it …": the admin's settings, a
  Patterns or PlayMap link, a hall's own Stagewatch with its name), never answering it as done. Its `.bak` is read only
  for a file not there or not whole; one not whole, with no `.bak` that parses, is kept the same way, with words to put
  a copy back or move it aside. 0.5.1 loaded the `.bak`, or nothing, and saved a new node id and token over it.
- An error on the port once it listens no longer ends a serving copy. It is one Node meets taking a connection (EMFILE,
  out of file handles): the connection is lost, the port still listens, the copy serves on, and the error is counted in
  health (`acceptErrors`, `{count, last}`, at the end of `/api/health`'s detail) and said (the first 20, then each 100th).
  A port that stops listening saves and ends as a crash (70), which the watchdog starts again. It ended with code 3,
  unsaved and never started again (found beside unit 4). The data folder's hold, likewise, keeps holding through an
  error of its own.
- The fences: `test/startrules.test.js` (new) holds a copy refused at its folder, in each channel, to a data and key
  folder byte for byte as they were, settings with a 0.2 key and no node id included; a first start to its folders,
  keys, certificate, secret and settings, the 0.2 key sealed; a data, uploads or key folder that cannot be made, under
  the watchdog, to code 3 with the folder named and no restart; each unknown channel and each unset, relative or inside
  folder to code 3 from the watchdog and the server with nothing made; each key the installed node cannot use to code 3
  with nothing changed; a portable copy without its secret or certificate to serving, HTTPS off in health, each left as
  it was; a context token that does not open to 503s with the words, no lockout, kept across a save, until New token; a
  port held under `task` to eight starts and more without a give-up, then serving once it is free; and an EMFILE on the
  port (raised through `test/accept-preload.js`) to serving on, counted, and a port that stopped listening to a save and
  code 70. Files another program holds are stood in by `test/busy-preload.js` (a read of a real file throws EBUSY or
  EACCES, or a rename onto it EBUSY): the installed node held to code 3, nothing made, for each of `machine.key`,
  `secret.key` and `tls.json` held, and for no machine key beside a `settings.json` or `displays.json` held; a portable
  copy whose secret, certificate and settings are held to serving, each said, and each byte for byte after a start, a
  setting asked and a stop; a held `settings.json` beside a `.bak` a save behind to no token made, 503s, every setting
  change refused and both files byte for byte; a file missing beside a held `.bak`, and one not whole with no `.bak`, to
  both kept as they were with their words, and one missing beside a `.bak` not whole to new settings, the `.bak` as it
  was; and a certificate in date whose renewal fails to HTTPS on with it. A rooms folder that cannot be read, under the
  watchdog, in each channel, to code 3 and no restart. `test/startup.test.js` holds `channelOf` (a `..data` folder, and
  the device and long-path prefixes, included) and the port held under `task` to 75; `test/resilience.test.js` the
  watchdog's ladder for 75 and its bounded log; `test/tls.test.js` and `test/units.test.js` the certificate, the secret,
  `publishOnce` and `readText` never writing over what is there. The synchronous-call caps move with their reasons:
  `lib/resilience.js` 11 → 13 (`publishOnce`'s link and its temporary file), `server.js` 16 → 15, `lib/guard.js` 3 → 0
  and `lib/tls.js` 4 → 0 (their reads and writes go through `readText`, `publishOnce` and the atomic writer).
- Rolling back: nothing stored changes form. 0.5.1 reads the same `secret.key`, `tls.json` and settings, and would make
  again what this build keeps.

**The admin token is said only where a person sits** (the plan's Part 6, unit U2, with the owner's answers 38 and 40, and
Part 3's 3-K.7 for the first admin account in both channels; the plan's reading on Linux, which this unit's tests take
again: the watchdog run with its output captured, as a redirect, a log or a scheduled task keeps it, wrote `Token: …` into
the capture. Nothing of it is run on Windows yet)
- A server its watchdog runs never says the token. The watchdog, which makes it, says the banner's Token line once its
  server serves, in its place under the admin URL: in a console window (the .bat's black window) the token, as before;
  in output that is not a console (a file, a log, a task's capture) never the token, but "Token: not shown here, since
  this output is not a window a person reads and may be kept. Start AGMessage in its own window to see it, or set
  ADMIN_TOKEN, 16 or more random letters and digits, before it starts." The server asks over its channel to the watchdog and goes on once the line is written,
  so the banner keeps its order; with no answer within 2 s it says "Token: not shown here: the watchdog that keeps it did
  not answer." and goes on. Each restart says it again, the same token. A server run alone, without its watchdog, prints
  it as it always has.
- The installed node (`AGM_RUNS=task`) writes its token into `admin-token` in a token folder of its own
  (`AGM_TOKEN_DIR`, the installer's `%ProgramData%\AGMessage\token`, which this PC's AGMessage admin and the accounts it
  gives `token` read), and its Token line names that file, never the token. It is written only once its server serves,
  so a copy whose port or folder is held never writes over the token of the copy that serves, and written whole (a
  temporary file renamed over the old one), so Show the admin token reads the old token or the new, never a file cut
  short; it is left when the node stops, a token nothing answers to until the next start. The folder is a full
  path, outside the program's folder, and neither another of the node's folders, inside one, nor holding one: whoever is
  given the token reads that folder, and nothing else of the node. Else the watchdog stops with code 3 and why, before
  anything is written; the node never makes the folder. A token that cannot be written there leaves the node serving
  without it (guests, screens and accounts need none), said on its console and in `watchdog.log`. An `ADMIN_TOKEN` or
  `ANTHROPIC_API_KEY` in the installed node's environment stops its watchdog with code 3 and words that never hold the
  value: whatever starts the node, a scheduled task's definition, can be read by every account allowed to read that
  task, so the token is the watchdog's own and the AI key is added on the admin page, sealed. A portable copy may still
  be given both.
- The first admin account is made only with the token, in both channels: typed into the sign-in page's new Admin token
  field ("Type the token from the AGMessage window (installed: Start → AGMessage → Show the admin token)."; the page
  always asks for it, of any length), or, when none is typed, by the token's sign-in made by this run, at the laptop (a
  request made without the page's field); a token typed is judged whatever sign-in is beside it. Loopback alone made one in 0.5.1, which a second Windows account on
  the laptop reaches too, as does a writer who empties `accounts.json` in a copied folder before its first start. The
  typed token is judged first: a wrong one is refused ("That is not the token in the AGMessage window."), the field
  chosen again, counted toward the token's lockout and written as `login.token.fail` "a wrong admin token (at setup)";
  while the lock holds a wrong one is refused 429 and not written again, and the right one is still taken, so nobody
  else at the laptop can keep its person out by typing wrong tokens. That leaves guessing there bounded by the token
  alone until the first admin exists: the watchdog's is 64 random bits, and the Token line, README.txt, `SECURITY.md` and
  `docs/ACCOUNTS.md` ask a token chosen by `ADMIN_TOKEN` to be 16 or more random letters and digits. None typed is told
  to type it, nothing counted. A token sign-in read back after a restart does not count (it is a record in the data
  folder). The `setup` row says which way the token came.
- The admin page names the token where the setup pane does: Admin login says "Type the token from the AGMessage window
  (installed: Start → AGMessage → Show the admin token).", Health's "Accept this on the AGMessage laptop: sign in there
  with its token (Admin login in the AGMessage window; installed: Start → AGMessage → Show the admin token).", the Accept
  dialog's field "The token from the AGMessage window", and Accept's refusal "That is not the token in the AGMessage
  window.", as the setup's: the installed node has no black window, and the server terminal is no longer where the
  token is.
- What the check at start says (a split finished or left at start, a check that did not finish) waits for the banner to
  be whole, so no line of it falls between the admin URL and the Token line the watchdog is asked for.
- Show the admin token: `app/launch.js` (new), the installed node's commands for the person at the PC, each run as that
  person and never elevated. This unit gives it `token --machine <folder> [--sys <folder>]`, which the Start menu's Show
  the admin token (the installer's units, passing `{commonappdata}` and `{sys}`) runs: it prints the token from
  `<folder>\token\admin-token` ("It holds while AGMessage serves; each start makes a new one"), or, when this Windows
  account may not read it, "This PC's AGMessage admin has not given you the token: ask LAPTOP\ana", the name the install
  record keeps (`HKLM\SOFTWARE\AGMessage`, `AdminName`, read by `reg.exe` by its absolute path in the `--sys` folder,
  run from there; without `--sys` the words name no one, and no machine path is read from the environment), with words
  for a node that has not served yet and a file that holds no token (never what it holds). Any other word, a word twice
  or a `--sys` not named from its drive is refused (64); in a console window it waits for Enter. It requires Node's own
  modules only, and ships in the portable bundle's `app\` for the installer's stage. The installer's source fence (U11)
  names its `reg.exe` beside its `schtasks.exe`. `--out`, the installer's log and the machine's events, where the plan
  also keeps the token out, are the installer's units' (U12, U17), whose tests hold them.
- The fences: `test/admintoken.test.js` (new) holds the Token line's words and the installed node's secrets and token
  folder (pure); the watchdog with its output captured to a banner whose Token line is in its place and holds no token,
  and, as a console (`test/tty-preload.js` stands one in), to the token there once; a server under a watchdog that does
  not answer to its 2 s and its words, and one run alone to the token in its banner; each secret in the installed
  node's environment, and each token folder not its own, to code 3 with nothing written; the installed node's token
  file written only once it serves, never by a copy whose port is held, the capture and `watchdog.log` without it, and
  the file's token signing in, no temporary file beside it; a token file that cannot be written to serving on, said;
  the check at start's words after the banner while the Token line is awaited (a split's folder planted aside).
  `/api/setup` with no token, a
  token of the wrong type, a wrong token five times (five rows, then 429 and no row), off the host, and the right token
  while the lock holds; the token's sign-in made by this run (a wrong token typed beside it refused), and one read back
  after a restart refused; and under `AGM_RUNS=task`, loopback without the token refused and the token taken.
  `launch.js`'s `token` with a stubbed read (the token, EACCES and EPERM with and without the admin's name, ENOENT,
  EBUSY, a file that holds no token), its `reg.exe` read stubbed (from the `--sys` folder, never from `SystemRoot`), its
  words for the command line, and run as a process, a read refused through `test/busy-preload.js`. Every test that makes the first admin account types the token; the browser smoke
  types a wrong one first, in a browser that holds the token's sign-in, and reads the refusal in place, and reads
  Health's new words. The synchronous-call cap of `supervise.js` stays at 3: the token file goes through
  `lib/resilience.js`'s atomic writer, whose `makeDir: false` never makes a folder another program makes (tested), so
  no cap moves; `server.js`'s timers gain the Token line's 2 s wait, which keeps no process alive.
- Rolling back: nothing stored changes form. 0.5.1's server prints the token in every banner again, takes loopback
  alone for the first admin account, and leaves the token file as it is.

**What the console says reaches the admin page, a bounded log and "This laptop"** (the plan's Part 6, unit U3, with the
owner's answer 38 for the laptop's admin and its grants; the plan's reading, which this unit's tests take again: what the
window said, the LAN addresses, why HTTPS was off and why a start was refused, was said only on the console, which the
installed node has none of. Its Windows readings are taken by a PowerShell script that no show laptop has run yet: the
Windows CI job runs it at every push and checks its answer's shape, on Linux its answers are stood in for, and each fact
it cannot read says unknown, with why)
- The watchdog reads its server's output through a pipe and says each line on its own console as before, and keeps it,
  with its time, in `data/logs/server.log` (`lib/serverlog.js`), with the watchdog's own lines, and no blank line.
  Bounded: once a line would take it past 2 MB it becomes `server.1.log`, replacing the one before, and a new one begins,
  so the folder holds about 4 MB of it at most. A show day's console is a few hundred lines; an installed node whose port
  stays held is tried 2,880 times a day, measured at 139 bytes a try (the server's words, and the watchdog's line only
  where `watchdog.log` takes it: the first try of a run and every hundredth), about 390 KB a day, so the two files hold
  some ten days of it (447 bytes a try, about 1.3 MB a day, with every line kept). A line past 16 KB goes on as the next.
  It never holds the admin token: the Token line is said on the console alone, and every line is searched for the token
  by value and written with `[the admin token]` instead, before a long line is cut, so no token is written in two
  halves. A log that cannot be written (a full disk, a folder in its way) stops nothing: said once on the console, each
  line tried again, and the first that lands says how many were not written. The Token line still keeps its place in the
  banner: the server writes where it goes, and the watchdog says it once it has read that far and been asked, whichever
  comes first. A console that goes away no longer ends the watchdog, and one nobody reads holds at most 1 MB waiting:
  the lines past it are in `server.log` alone.
- A server that cannot start as configured, or whose port or folder is held, says why as it ends, and the watchdog's
  line now carries those words: "server stopped: cannot start as configured (code 3): the uploads folder … cannot be
  made (ENOTDIR). Choose a folder …", in `watchdog.log`, `server.log` and on its console; a held port's tries, "server
  could not take its port or data folder, which another program holds (code 75): Another program is using port 3023.
  AGMessage tries again; …". The watchdog hands a restart its line for the run before (`AGM_BEFORE`). The installed node,
  which has no window, also records a start refused as configured in `data/watchdog.json` (`refused: true`), where a
  give-up is recorded, so the next start, from the next boot's watchdog or a person's Start, says it: "This laptop"'s
  Before this start, "the start at 2026-11-02 13:00 UTC was refused: cannot start as configured (code 3): …" (a give-up:
  "the watchdog gave up at …: …"), and the admin page's health, "the start before this one was refused at …", once,
  since the file is renamed `watchdog.seen.json` once it serves. Health's `watchdog` gains `refused`, at its end, and its
  `reason` is cut at 700 characters (was 200). A portable copy's refusal is read in its window and records nothing: one
  refused because another copy holds its folder must leave nothing in that copy's folder. The watchdog's line said only
  "(code 3)" before.
- The admin page's settings answer gains `addresses` (the LAN addresses, as the banner's LAN lines say them; none while
  the system will not list its adapters) and `port`, at its end, and its `tls`, health's too, gains `off` (why HTTPS is
  off, as the banner's "HTTPS: off — …" says it: "AGM_TLS=0 turned it off for this run", a certificate that could not be
  read or opened, none made) and `renewal`. The admin page's Encrypted connections line reads "HTTPS is off: …" with why.
- A certificate due for renewal (30 days or fewer to run) is renewed at start only while a network has given this laptop
  an address (an address an adapter gives itself, 169.254/16, is none): one made before the network gives one would name
  none of the addresses devices reach it by, for the 825 days it runs. It serves on with the one it has, said ("[tls] the
  certificate, which ends …, is due for renewal and not renewed at this start, which has no network address: it serves
  on; New certificate on the admin page renews it once this laptop has one, as does a start that has one") and in
  `tls.renewal`, in words true when they are read: "… which has no network address yet: New certificate renews it once
  this laptop has one, as does a start that has one", and once the laptop has one, "… which had no network address: New
  certificate renews it now". New certificate clears it. It is never renewed behind a person's back, since every device
  that trusted the old one would be asked again at its next connection. A first certificate is still made at once. Not
  measured: under the installed node a start at boot, before the network, is the common case, and an adapter that is
  always up (a virtual switch, a VPN) gives the laptop an address that devices may not reach it by.
- **This laptop** on the admin page: what AGMessage knows and what Windows says, each fact with its mark (✓, △, ✕ or ○,
  its shape beside its colour) and where it was read. AGMessage's own: the serving build and how it runs (the portable
  folder, or installed); the addresses; HTTPS, and why it is off; how many sealed values open (a count, never which);
  the screens that confirmed what they show; the Stagewatch links connected; the internet link; before this start (the
  watchdog's line for the run it restarted, or its record of a refused start or a give-up); and what this start goes
  without (a secret or settings it could not read). Should reading them fail (an adapter list the system refuses), one
  row says so and the rest of the admin page's answer is drawn. Windows', read by one `powershell.exe` by its absolute
  path under `SystemRoot`, from System32, with a fixed script, once the server serves and again at Refresh, one read at a
  time, within 5 s (then ended), and ended when the server stops. Its environment is named, never the server's: Windows'
  folders and the machine's names, Windows' own module path and this `node.exe`'s path, so no secret whatever the case
  of its name, no `PATH` and no module of the account's own. It says each part on a line of its own as soon as it is
  read, the cheap ones first and the firewall's rules last, so a read ended at its time keeps what it said and only the
  rest read "unknown (Windows did not answer within 5 s)": sleep and the lid on mains; the server task
  `\AGMessage\Server`, its state and last result; the laptop's admin and the rights given, from the install record
  (`HKLM\SOFTWARE\AGMessage`: `AdminName`, and under `Grants` one value per account's SID, its rights); the active
  network's profile; and whether a rule names this `node.exe` on it, every rule judged (a block rule wins, as the
  firewall's own order says; past 512 such rules the reach is unknown, never guessed), read from the firewall's own
  object (`HNetCfg.FwPolicy2`), each rule's program compared in turn, and through the NetSecurity cmdlets only under
  Constrained Language Mode, which allows no COM object (the cmdlets fetch every application filter before they compare
  one). Each module a part uses is imported by its manifest's path under `$PSHOME`, Windows' own, never found by name: a
  command found by name had PowerShell look through the modules on its module path first, which on CI's Windows runner
  took 44 s before the first line, so the read took 57 s on one run and did not end within 60 s on another. Measured
  there since: the whole read 863 ms (`powershell.exe` started at 124 ms, the server task's line at 724 ms, the
  firewall's rules at 841 ms), and `powershell.exe` started and ended with nothing to do in 119 to 139 ms in the plan's
  environment and in the test's alike; the 5 s it is given is not measured on a show laptop. Networks and rights past 32
  are counted ("and 3 more"). What the firewall's read does not see: a rule set by a domain's policy, a rule by port alone,
  and a profile whose firewall is off. Off Windows each reads "unknown (AGMessage is not running on Windows)". Its acts
  are the catalogue's (kind `laptop`): Refresh (`admin:laptop`, the admin page's alone; its read's facts come on
  `laptop:facts`) and Copy LAN address ▸, one per address. Only the admin page's answers carry it: never health over
  HTTP, the context, the hello or the AI's brief. The last stop, sleeps and the power request, and the internet link's
  end time are later units' rows. The plan's test row reads the laptop's admin and grants "from a stubbed `reg.exe`":
  they are read by the one `powershell.exe` the unit names, whose answer the tests stand in for.
- The fences: `test/laptop.test.js` (new) holds the log's lines and its bound, rotation and failure, and a token across
  the cut, in one line or arriving in two pieces, never written in halves (pure); the watchdog's console kept in a log
  under its bound, rotated, every line of it said on the console in order, and neither the token (a console stood in, so
  the Token line holds it), the Token line nor its marker in either file; a log that cannot be written said once while
  the node serves; a console closed under a watchdog that then stops as asked, saved, with exit 0, and the stop's lines
  in the log; a refusal's words in the watchdog's line, in both logs; a held port's words in `server.log` at each try,
  the watchdog's line once, no blank line, and the words in "This laptop" once it serves; the installed node's refused
  start recorded and said by the next start from another watchdog, on "This laptop" and in health, once; a give-up's
  record said so, once; the addresses and the port in the admin's answer as the banner says them, and why HTTPS is off as
  the banner says it, for `AGM_TLS=0` and for a certificate that is not one (this laptop's adapters stood in for by
  `test/network-preload.js`, read at each look from a file, so an address can come while it serves, or the list be
  refused); a certificate due for renewal kept byte for byte at a start with only a 169.254 address, its words changing
  when an address comes, then renewed naming the address at the next start, or at once by New certificate; the admin's
  answer drawn while the adapter list is refused; Windows asked by its absolute path with the fixed script and an
  environment of the named folders only, one read at a time, a read that does not answer ending in time with every
  Windows fact unknown, one that ends part way keeping what it said, a stop ending the read, and an answer stood in for
  (`test/windows-preload.js`) read into the network, the firewall on it, sleep, the lid, the task, the laptop's admin and
  the rights given, none of them in the context; the plan, the script's order, the run, the answer's lines read by type
  (a line cut short passed over, no key but the parts' taken), every rule judged, the lists counted past 32, and every
  row's words (pure); every PowerShell AGMessage runs (the script, the power request's, the lane's, `tools/*.ps1`) naming its functions
  Verb-Noun or `Agm…`, never a single word that Windows PowerShell keeps as an alias, which runs before a function of the
  same name (the script's `Ac` was Add-Content's alias: on CI's runner it wrote two files into System32 and read neither
  power setting); and, on Windows only (the Windows CI job), the script itself run, its answer in its own shape, each
  part read or refused with Windows' reason, the task and the install record missing on a runner, and how long the read
  took, with when each part's line came (the first needs no module, so it says when `powershell.exe` had started) and
  how long `powershell.exe` takes to start with nothing to do, in the plan's environment and in the test's. `test/catalog.test.js` and `test/menus.test.js` hold the new kind (Refresh refused to a Staff account's and a
  code guest's sockets); the browser smoke holds its doors, each row's words and where it was read, and Refresh.
  `test/startrules.test.js`'s refused folders read the server's words in the watchdog's line, and the installed node's
  refusal record (none for a portable copy). The synchronous-call caps gain `lib/serverlog.js` at 4, with its reason;
  `supervise.js`'s goes down to 2, since its record goes through the atomic writer.
- Rolling back: nothing stored changes form. 0.5.1 leaves `data/logs/` as it is, says nothing of it, renews a
  certificate at any start, and reads a `watchdog.json` that records a refused start as a give-up, once.

**"Newer" is defined, and the data folder says which build and format last wrote it** (the plan's Part 6, unit U6, with
the owner's answer 29, "wrap into 0.6.0": there is no 0.5.2; the plan's reading of three version orders over seven
composed builds, which this unit's tests take again, and the code; the copy's time on a show laptop is not measured)
- "Newer" is one rule across the show network, PlayMap's: MAJOR.MINOR.BUILD. `tools/stamp-build.js` writes it into
  `build.json` as `installVersion` (`0.6.41` for build 41 of 0.6.x), within an MSI ProductVersion's bounds, MAJOR and
  MINOR up to 255 and BUILD up to 65535 (`INSTALL_MAX`): a version past them is never stamped. A local copy has none and
  is ordered against nothing. A stamp whose install version is missing or not its own is no stamp, and the build reads
  as local. `lib/version.js` reads a build back from its name (`parseBuild`) and orders two (`compareBuilds`). Over seven
  builds (21 pairs) SemVer's order disagrees with MAJOR.MINOR.BUILD on 3 pairs and the four-part MAJOR.MINOR.PATCH.BUILD
  on 2; MAJOR.MINOR.BUILD and the four-part order on 1, a 0.6.0 built after a 0.6.1 development build. So a release is
  published only when its SemVer is above every release already published and every other version tagged, released or
  not: `stamp-build.js --check-tag <tag> --released <tags> --tags <tags>` refuses ("v0.6.0 is not above the last
  release, v0.6.1: … nothing is released"; "v0.6.0 is not above the tag v0.6.1, which the repository holds: …"). The
  analyze job asks it first (`gh release list`, and the repository's `v` tags), and the release job asks it again as its
  first step, before anything is attested or published, one release job at a time across every tag
  (`concurrency: release-<repository>`, none cancelled): two tags pushed side by side never both pass on a list read
  before either published, and since a tag's run number is given when it is pushed, a release published later than
  another always carries the higher build. A list that cannot be read stops the release, and a tag that names no
  version is refused by name, never passed over. Among releases the orders then agree; development builds of one
  MAJOR.MINOR order by their build number alone.
- **`data/format.json`** (`lib/dataformat.js`): `{format, build, at}`, and `backup` after a move. 0.6.0 writes format 2;
  a folder without one is format 1 (0.5 and earlier), unless it holds nothing a server wrote (the watchdog's console
  and empty folders only), which is new. It is read before anything else of the folder, by the watchdog and by the
  server, and read again and written only once this copy holds its folder and its port, before anything else is
  written in it (what was read before the hold is never trusted past it):
  - a new folder is marked;
  - a lower format is copied whole, but `backups\` and the console in `logs\`, into
    `data\backups\format-1-<time>-<suffix>\` (made as `.partial-…` and renamed once whole, so a copy that did not finish
    never reads as one; a `.partial-…` a stop left, killed or the power gone, is removed before the next copy), then each
    step up to format 2 runs (from 1 nothing is rewritten: 0.6 reads a 0.5 folder as it is), then the marker is written
    last, naming the copy. The disk's free space is read first: a copy that would leave less than the uploads' reserve
    (1 GB, `AGM_UPLOAD_MIN_FREE`) beside it is refused with words ("…its disk has 600 MB free: the copy needs 75 MB, and
    1024 MB is kept free beside it for the saves and the logs. Nothing in the folder was changed. …"). While it runs the
    server sends the watchdog its beat at most every 250 ms, so a copy longer than the watchdog's start window (30 s) or
    its hang limit (10 s) is never taken for a hang and killed up the restart ladder. A copy that fails (the partial copy
    removed), a step that fails or a marker that cannot be written after the move stops the start with code 3 and words
    naming the copy where there is one; the marker is as it was, so the next start begins again. The folder is copied
    once per format, before AGMessage serves: 75 MB (20 halls of 10,000 messages, each snapshot with its `.bak`, and
    20,000 audit entries) took 40 to 60 ms on Linux here, from the system's file cache; on the show laptop, with
    Defender, it is not measured;
  - a higher format stops the start with code 3, in either channel, before anything is written: "this data folder (…)
    was last written by AGMessage 0.7.0+52 in format 3, and this build (…) reads format 2 and older. Nothing was
    changed. Start 0.7.0+52 or a newer build on this folder. To go back to this build, start it on the copy that build
    kept of the folder before it changed it: …\backups\format-2-…", or that the copy is no longer there, or that none is
    named. A marker that cannot be read (EBUSY, EACCES) or holds no format is refused the same way, never taken for
    none. The watchdog asks before it opens its console's log, so nothing is written in that folder, `logs\server.log`
    and `watchdog.log` included: the words are on its console (its error output) alone;
  - a marker that cannot be written stops the start with code 3 and its words in every case, a new folder ("the new data
    folder's marker … could not be written, so the folder would not say which build and format wrote it. No hall,
    account or setting was written in it. …") and another build of the format ("… would go on naming 0.6.0+45.… as the
    build that last wrote it …") as after a move: a copy never serves a folder that does not say which build last wrote
    it, so the next start never reads a 0.6 folder as a 0.5 one, and the import's "same build" rule never reads a stale
    one. The next start, once the marker can be written, marks it;
  - the same format written by another build is marked as this build's; a newer one before it is said: health's
    `format` (`{format, was, before, newer, backup}`, at its end; `newer` is `null` when no build was named before, or
    the two are not ordered), the admin page's Health line ("⚠ the data folder was last written by a newer build, …:
    this one reads its format and writes it now"), "This laptop"'s new Data folder row (△) and the window's "Data
    folder:" line, which also says a move;
  - a marker whose build changed is one `server.upgraded` audit row, written once the log opens: "from a folder with no
    marker (format 1, as 0.5 and earlier leave it) to 0.6.0+41.…: the folder moved from format 1 to 2, and the folder as
    it was is kept in backups/format-1-…", or "from 0.6.0+45.… to 0.6.0+41.… (format 2, an older build than the one
    before it)". The same build again writes nothing and no row. `docs/ACCOUNTS.md` and README.txt name the row.
  - 0.5.1 reads no marker, so it still opens a 0.6 folder (design §1.8), with the losses README.txt names.
- The papers: README.txt gains "Upgrading" (between shows: extract a new folder, copy `app\data` and `app\uploads` before
  its first start, start it from the same Windows account; the copy kept at the first start of 0.6 and the space it
  needs; newer is the build number; going back) and the firewall's case: a new folder is a new program to Windows
  Firewall, whose Allow access a standard account cannot give without an administrator, and a network Windows calls
  Public that the rule does not cover; and Troubleshooting's lines for a higher format, a marker that cannot be read or
  written, and a disk too full for the copy. `docs/INSTALL.md` says the version number and its bounds, the release
  order the installer's units read, and the data folder's format; `docs/NODES.md` names health's `format`.
- The fences: `test/dataformat.test.js` (new) holds the marker read by type and each refusal's words (pure, on disk); a
  new folder marked; a 0.5 folder copied byte for byte (the console left out), marked last with its copy, and the same
  build again writing nothing, file times included; another build of the format marked, newer, older or neither (a
  local build, one number); the marker read again at the settle, a higher one written since refused; a copy whose
  folder cannot be made, one that fails part way (no partial left), a partial a stop left removed by the next copy, a
  disk short of the copy and its reserve (nothing written), a step that fails, and a marker that cannot be written
  after a move, for a new folder and for another build, each leaving the folder unmarked or as it was; the copy's beat,
  at most every 250 ms on a clock that moves; the Data folder row's words and marks; and on a real server and its
  watchdog, a higher format, a marker held by another program and a torn one refused with code 3 in both channels,
  through `supervise.js` and `server.js` alike, with no file's time or bytes changed (the watchdog's logs included), a
  copy refused at its held folder writing no marker or copy, a first start marked, a 0.5 folder moved with its window
  line, health, row and one audit row and a restart writing none of them again, a newer and an older build before a
  stamped one (`test/stamp-preload.js`, new: the server runs as a CI build without a file in the tree), a marker that
  cannot be written stopping the start in both channels and the next start marking it, and a copy slowed past the
  watchdog's hang limit (`test/slowcopy-preload.js`, new: each file the copy takes waits, and each beat is counted as
  the server sends it and as its watchdog hears it) served with no kill, its boot inside the watchdog's own start
  window (30 s) and each file it took one beat the watchdog heard while the copy still held the loop: a beat not sent,
  or not heard until the loop lets go, fails it, and beats too sparse are killed up the ladder. `test/version.test.js`
  holds the 21 pairs, the three orders' disagreements, a build read back in each channel and refused in any other
  shape, the install version's MSI bounds, the release order (0.6.0 after 0.6.1 refused though its build is newer, the
  same version, 0.10 above 0.9, a tag that names no version, a higher version tagged and not yet released),
  `stamp-build.js`'s `installVersion`, `--released`, `--tags` and a version past 255 refused, and the release job: its
  check before the attestation and the publish, one job at a time. `test/server.test.js` holds `format` at the end of
  health's detail. The browser smoke reads the Data folder row, and its folder from 0.5.1 now holds one
  `server.upgraded` row (keyed, ✓) after its first start, and none after the next. The synchronous-call caps gain
  `lib/dataformat.js` at 8, with its reason; `server.js` stays at 15 and `supervise.js` at 2 (the marker goes through
  the atomic writer and `lib/dataformat.js`).
- Rolling back: 0.5.1 never reads `format.json` or `data\backups\`, and leaves both as they are.

**The Windows evidence lane, and the lab lines** (the plan's Part 6, unit U7, with the owner's answer 34, "Installer in
0.6.0": the readings inform the release and never hold it; the code and its tests, on Linux, and the PowerShell the lane
asks run by CI's Windows job; the lane itself runs first on CI's windows-2025 with the push that carries it, so no
reading is recorded yet, and every lab line is the show laptop's and not run)
- **A CI job of its own, `readings`**, on `windows-2025`, every action in it pinned by its commit (its tag beside it),
  after the package job; its checkout keeps no credential, since the stand-in tasks run the bundle's code from that
  folder. Its first step after the checkout, `tools/defender-on.ps1` (new), turns Defender's real-time monitoring back
  on, which GitHub's image turns off, removes the image's exclusions of `C:\` and `D:\`, and records whether that took,
  read back from Defender itself and read again when the readings end: on means real-time monitoring and scanning on
  access on, in Defender's Normal mode (passive and EDR block modes scan nothing in real time), and neither drive
  excluded; the image's other Defender settings stay as it left them, which lab 3 is for. It never fails the job for
  Defender. Then the newest release published is named and its zip downloaded, a step whose failure stops nothing.
  Every step has a bound of its own and together they end inside the job's, so the job ends passed or failed, never
  cancelled by its own timeout.
- **The readings** (`tools/readings-take.js`, new) lay the zip the package job built and take each reading this build
  can, each on its own, so one that fails is written with why and the rest are taken: R2, the newest release's payload
  laid whole and this build (about 5,120 files and 188 MB, as the plan counted them) laid over it, three times, each
  file inflated to a name of its own beside the one it replaces and renamed over it (over its own when that release's
  zip could not be had, said so); R10, `node.exe` extracted alone into `%TEMP%` and run once, five times, a round
  counted only when it ran to exit 0; R5, Windows' verdict on `node.exe`'s and `cloudflared.exe`'s signatures; R8, the
  access lists of `C:\` and `%ProgramData%`, read by SID from `icacls /save`, and whether a standard account may make
  `C:\node_modules` or `%ProgramData%\AGMessage`; R4 and R7 under a stand-in for the server task (`\AGMessage\Server`:
  LocalService under its own SID, `SeChangeNotifyPrivilege` alone, no time limit, RestartOnFailure 3 × 1 min), whose
  action starts the bundle's own watchdog in the installed channel: the token's privileges and groups (read by the
  task's action, whose token the watchdog and the server inherit), the task's SID, `LOCALAPPDATA` and the home folder,
  health answering with the build the bundle's stamp names (an answer from anything else on the port is not its
  server), UDP 9928 heard, a quick tunnel and the account's profile before and after, a firewall rule by program,
  protocol and port made and read back, and, while it serves, its folder pipe's access list and whether a client
  reaches the pipe through SMB at the runner's own names (a network logon, on one machine); R12, two stand-ins with the
  server task's settings, each with a folder of its own, one whose action exits 1, measured and removed, then one
  whose action exits 0, so a restart the first still has queued is never counted for the second; R13, GitHub's release
  answer for the newest release published, read from a stand-in task as SYSTEM holding no token. Every stand-in task
  and the rule are removed at the end, every program is run by its absolute path, the admin token the stand-in server
  makes is taken out of anything kept (by value, and anything of its shape), and a quick tunnel's address is not kept.
  The record is written before the first reading and after each, and marked whole at the end; a reading not begun
  within the lane's own 20 minutes reads "not run". It is CI's alone: before it makes or removes anything it refuses a
  machine that is not a GitHub-hosted runner, a work folder it did not make and a `\AGMessage\Server` task it did not
  make (the installed node's); lab 3 is taken on the laptop by hand. R1, R3′, R6, R9 and R11, and the parts of R5, R8
  and R13 that measure the installer, the tasks and U18's words, read "not run", naming the unit whose code they
  measure; each adds its step when it lands.
- **The verdicts** (`tools/readings.js`, new): each reading against the plan's mark, as met, missed, recorded, open
  (R2's mark waits for R9's backup) or not run with why; R3 retired. A reading is judged only on what was measured: one
  taken without what its mark needs (Defender on, for R2, R9 and R10) is never met, and is missed only when it is over
  its mark anyway; R4 is met only when health named the bundle's build. GitHub's refusal of the runner's address for its
  rate limit reads "not run", not a miss. A lane cut short says so, and each reading it had not reached reads "not
  run". The job's summary is the table, and its artifact, `agmessage-readings-<commit>`, holds the measurements and the
  verdicts. Only a lane that cannot write or judge its readings fails the job; a reading never does.
  `readings.js record <readings.json>` writes a run's verdicts into `docs/INSTALL.md`'s Measured column, each with its
  day and build, and keeps what the run did not take.
- **The release's notes** carry them: the release job waits for the lane to end and publishes whatever it found, once
  the package job has (`!cancelled()`, `needs.package.result == 'success'`), and its notes say each reading that missed
  its mark with the fallback its unit names, those met, recorded, open and not run, and the lab lines as
  `docs/INSTALL.md` records them. A lane that wrote nothing leaves the notes saying the readings were not taken, and a
  file that is not its verdicts, that they could not be read; the notes exit 0 whatever the file holds, and the step
  writes words of its own if they still fail, so nothing in the lane can hold the release.
- The papers: `docs/INSTALL.md` gains "The Windows readings and the lab lines": the lane, its bounds, why it is CI's
  alone, what it stands in for, the verdicts, R1-R13 with what each is, its mark, what a miss means, what this build's
  lane takes and a Measured column that reads "not measured" until a run is recorded in it; and the lab lines 1-7, each
  the plan's line word for word with the pass it names ("recorded" where it names none) and a Taken column that reads
  "not run" until the show laptop takes them. The hour-before-doors card takes each miss when the installer's papers
  write it. `docs/ANALYSIS.md` names the lane, its fences and the pinned actions; `README.md` names the lane in CI;
  `docs/DESIGN.md`'s readings 0-9 point to these.
- The fences: `test/readings.test.js` (new) holds the register to the plan's U7 table and lab lines word for word and
  `docs/INSTALL.md` to the register; a reading that still waits for a unit whose code is in the tree fails; nothing
  measured is nothing met; each reading's verdict on its edges (R2 over the previous payload or its own, with and
  without R9 and Defender; Defender with scanning on access off, in passive or EDR block mode, or a drive still
  excluded in a list of one as Windows PowerShell may write it; R4's token with
  SeImpersonatePrivilege or another privilege, a server that did not serve, an answer naming another build or none,
  and a stamp its server would not take; R5's untrusted file named; R7's and R8's access lists read from SDDL by SID
  with an inherit-only entry, a deny first, generic rights and an entry it does not read, and R7's SMB reach; R10 over
  5 s, and rounds that did not run to exit 0, fast or slow; R12's two misses, and as the lane takes it, a scheduler
  whose queued restarts land during the exit 0's watch; R13's rate limit and an answer not read); the notes and the
  summary, and notes on files that parse but are not the verdicts; the command line's exits (a miss 0, a record that
  is not the lane's 2, the notes always 0); `record` on a copy of the paper; the payload laid over an earlier build's
  from a zip, node.exe extracted alone, a member outside its folder, torn bytes or a bundle that is not one folder
  refused; the stand-in task's principal, privileges and settings and Windows' reading of its arguments; the probes (a
  start and its code, a profile's change, UDP heard, health waited for and its build read, a quick tunnel seen and
  ended, GitHub's answer and a refusal read); what is kept (an access list from `icacls /save`, a drive root's
  included, a server's last whole lines with the token taken out, a pipe reached or not); the lane's refusals of a
  machine, a work folder and a server task it did not make; the job (windows-2025, pinned actions, no credential kept,
  Defender first, every step bounded inside the job, the GitHub list unable to stop it, the readings kept whatever they
  say, one token for one step) and the release (waits, never held, its notes from the readings, words of its own if
  they fail). On Windows, the PowerShell the lane asks (a signature, a pipe's access list, Defender) and `icacls /save`
  on a folder and on `C:\` are run and read.
- Rolling back: nothing ships; the lane and its tools are CI's.

**The watchdog tells a sleep from a hang, and a live show keeps the laptop awake** (the plan's Part 6, unit U9: the
plan's proxies, both processes frozen and thawed on Linux, made tests on the real watchdog; the code and its tests, with
`powershell.exe` stood in for on Linux and the script itself run by CI's Windows job; nothing in it is measured on a
laptop that sleeps: lab 1 is the show laptop's, and reads "not run")
- **A late tick is a sleep, never a hang.** The watchdog ticks every half second and measures its server's silence on a
  steady clock (`performance.now()`, which a change to the laptop's clock does not move; `lib/resilience.js`
  `BeatClock`). A tick of its own that comes more than 2 s late (`AGM_LATE_MS`), on that clock or on the wall clock,
  means it did not run itself (the laptop slept, or both processes were frozen), so it judges nothing of that gap: the
  beat clock starts again at that tick, and the gap is never counted as a crash. Either clock, because a steady clock
  may stop while the machine sleeps (Linux's monotonic clock does; whether Windows' does is lab 1's) and would see no
  gap there, while the wall clock does. A hang is the watchdog ticking on time with no beat for 10 s, as before, and is
  still killed and restarted. Until now the watchdog compared the wall clock with the last beat, which jumps across a
  sleep: every wake from a sleep longer than 10 s killed the server unsaved and wrote "AGMessage restarted" in every
  hall, and a laptop's standby that lets a process run a second at a time made it kill seven times, give up and stay
  down. The first tick is judged from when the ticks began, so a freeze before it is a sleep too. What the rule cannot
  tell from a sleep, and records as one (`docs/INSTALL.md` says so): a step of the laptop's clock forward by more than
  2 s, and the watchdog itself held from running for more than 2.5 s while the laptop is awake (swapping, a disk that
  holds its log's write), during which a server that hangs is not killed until the watchdog runs on time for 10 s.
- **The sleeps recorded.** "asleep from 2026-11-02 14:02:03 to 14:20:11 UTC (18 min 8 s): the watchdog did not run, so
  it judged nothing of the server for that time" goes to the watchdog's console, `data/watchdog.log` and `server.log`
  once it has run on time for 10 s after it, or as it stops; sleeps with it awake less than that between (a standby that
  lets it run a moment at a time) are one sleep, "…, 24 times in a row, awake a moment between". The server is told
  each (now, at the next server's first beat, the newest 20 waiting, or, for one the watchdog stops in, ahead of the
  stop, so the stop saves it), reads it by type and keeps it with the show day's peaks: each day's record gains `sleeps`
  (how many woke in it) and `sleptMs` (the longest), and `peaks.json` keeps the newest 20 whole (`asleep`), so a restart
  keeps them. Appended to `/api/health`'s detail (the admin and this laptop only), at its end: `sleeps` (`watched`:
  whether a watchdog runs this server; `list`: the newest kept, oldest first, each `{from, to, parts}`). The admin
  page's peaks read "asleep 2 times (the longest 18 min)", and "This laptop" gains **Sleeps**: "once today · the last
  asleep from … UTC (18 min 8 s)" (△), "none recorded" (✓), or, for a server run alone, "none recorded: no watchdog
  runs this server, so a sleep goes unseen".
- **A live show keeps the laptop awake.** While a hall is live the server holds a power request (`lib/power.js`). A hall
  is live while it has an open page seated in it, idle or not (a Board reading quietly through a long session is a live
  show: a page left open holds the request until it is closed, and "This laptop" says what makes the halls live); a
  screen on which a browser confirmed a take other than holding (another browser on the same link that could not show
  it takes nothing from it); or its Stagewatch countdown counting, as Stagewatch says now: running, or past zero and
  counting on into overtime, never held at zero. The default Stagewatch, which every hall without its own follows, is
  one countdown and makes one hall live, never each. The request is held through one `powershell.exe` child, run by its
  absolute path under `SystemRoot`, from System32, in an environment of named Windows folders only (`lib/laptop.js`
  `powershellPlan`, which "This laptop"'s read uses too), with a fixed script of one line: it declares
  `SetThreadExecutionState` with `Add-Type` (which Windows PowerShell 5.1 compiles with the .NET Framework's `csc.exe`,
  run as its child on files in the `TEMP` folder passed, then loads and removes), calls it with `ES_CONTINUOUS |
  ES_SYSTEM_REQUIRED` and waits on its standard input, so the request ends when the server ends it (no hall live) or
  the server ends (its input closes; on Windows the job every child is in ends it too). It reads "held" only when the
  call returned non-zero; under Constrained Language Mode, where `Add-Type` is refused, it says so before it asks. It is
  read again whenever the halls board is marked (a page seated or gone, a screen's take or its report, a Stagewatch
  frame) and every 5 s, and started only once this copy serves. A request refused is said ("[power] not held: …" on
  the console) and asked again only when the halls have gone quiet and are live again; one that failed (the call
  returned 0, `powershell.exe` could not be run, did not answer within 30 s, or ended while it was wanted) is asked
  again a minute after while a hall stays live, never sooner, and the same failure again is said once. It keeps off
  idle sleep only: the lid and the power button stay the power plan's, as Microsoft says of the call, and on battery a
  laptop with Modern Standby keeps the request 5 minutes at most. Appended to `/api/health`'s detail, after `sleeps`:
  `power` (`state`: off, asking, held, refused, failed or unavailable; `live`, how many halls; `why`; `since`; `what`,
  the open pages, screens showing and countdowns running that make the live halls live). "This laptop" gains **Kept
  awake**: "held while 1 hall is live (1 page open): Windows took the request to keep off idle sleep, which on battery
  a laptop with Modern Standby keeps 5 minutes at most · the lid and the power button still do what the power plan
  says" (✓), "not asked: no hall is live", or "not held while …: why", with when it is asked again (△; off Windows,
  "AGMessage is not running on Windows"); the admin page's health line says "kept awake while 1 hall is live", or "⚠
  not kept awake: …". Until now nothing kept a laptop on mains from its idle sleep during a show.
- The tests: on a fake clock, on-time ticks with no beat kill at the hang's limit, a late tick starts the beat clock
  again and is a sleep (also before the first tick, and one only the wall clock saw, after which the hang's limit still
  holds), a wall clock set back is no sleep and hides no hang, a tick exactly at the late limit is not late, and the
  plan's throttle proxy (a second awake in every fifteen for six minutes) is one sleep of 24 parts, never a kill. On the
  real watchdog (Linux; each fails on the watchdog before it): both processes frozen past the hang's limit three times,
  never killed, each sleep said in `watchdog.log`, `server.log` and on the console, and told to the server, and one it
  is stopped in moments after the wake told ahead of the stop; frozen most of the time eight times, past the crash
  count, never killed or given up, one sleep said; the server frozen alone with the watchdog on time, still killed at
  the hang's limit, and no sleep said; the real server keeps the sleep in health, the day's peaks and "This laptop", and
  across a restart; a sleep the server is told that does not read is kept nowhere. The power request on a fake clock
  and with its child stood in for: held only on its word, refused not asked again while live, a failure asked again a
  minute after and never sooner, a child silent for 30 s failed and ended, the same failure said once, an answer it
  cannot read or past 4 KB not taken. On a server with `powershell.exe` stood in for (`test/power-preload.js`): nothing
  asked while no hall is live; started when a page is seated, a screen confirms a message (a screen holding is not live;
  a second browser on its link that could not show it takes nothing from it) and a Stagewatch countdown runs or counts
  into overtime (held at zero is not live), the default Stagewatch two halls follow making one live; ended when each
  stops and when the server stops or is killed (its input closes); refused under Constrained Language Mode, said on
  "This laptop" and never asked again while live. On Windows the script itself answers held and ends when its input
  closes.
- The papers: `docs/INSTALL.md` gains "Sleep, the power request and the lid"; `docs/DESIGN.md`, `SECURITY.md` (the
  child, what it runs, `csc.exe` and the temporary library included, and its environment), `docs/ANALYSIS.md`,
  `README.md` and `README.txt` (the watchdog, This laptop, health) say the rest.
- Rolling back: 0.5.1 ignores the new health keys and `peaks.json`, and its watchdog kills the server at a wake again.

**The internet link is kept on until an end time, and comes back after a restart** (the plan's Part 6, unit U10; the
code and its tests, with cloudflared and its address stood in for; nothing in it is measured through a real tunnel)
- **On until its end.** Turning the internet link on keeps it on until the end of the show day, the next 06:00 by the
  laptop's clock (the show day the peaks already keep, so an evening that runs past midnight keeps its link), or the
  next day's when that 06:00 is under an hour away, so a load-in that turns it on at 05:50 is not cut ten minutes later
  (`tunnelend.defaultEnd`); Turn on's toast says the end ("The internet link is turning on, until 06:00 tomorrow
  (Tunnel until… moves its end)."). The end is kept in the settings (`tunnelUntil`, through the settings lane: no new
  store). **Tunnel until…** (the tunnel card's ⋯, a catalogue row, `tunnel.until`; `admin:tunnelUntil`, the admin's)
  moves it, asked in place with a time of day by the laptop's clock, filled with the end it has: a time already past
  today is tomorrow's, and the end it has, confirmed unchanged, stays where it is (Turn on's 06:00 at 05:30 is
  tomorrow's). Its answer is the end it kept, with its words, and every admin page hears it. A payload that names no
  time of day is refused with words ("Give the end as a time of day, HH:MM by this laptop's clock (for example
  23:30).") whether or not the link runs, and with the link off, "The internet link is off: turn it on first.". At its
  end the link is turned off within a 5 s health window, read against the wall clock (so a sleep or a moved clock never
  lets it outlive its end), and stays off: "[tunnel] its end, 06:00 today, has come: the internet link is off" on the
  console. Until now it ran until someone turned it off or AGMessage stopped; under the installed node's task, with no
  window to close, that could be days.
- **By the laptop's clock, on every page.** The end and the start that turned the link on again come from the server in
  the laptop's words and time of day (`untilWords`, `untilClock`, `againWords`), sent again when they change ("tomorrow"
  become "today" at midnight), so an admin page set to another zone shows, fills and confirms the laptop's time, never
  its own (a page in New York filled the field with 01:00 for the laptop's 06:00, and confirming it unchanged would have
  moved the end).
- **Back after a restart, with its new address said once it has one.** A start inside the end (a watchdog restart, a
  crash, an upgrade, a wake, a boot under the task) turns the link on again once the start's banner is whole, at the
  same end. A quick tunnel's address is new at every start, so once cloudflared gives it the admin is told: the tunnel
  card says "△ New address: AGMessage started again at 14:02 today and turned the internet link on again. Send this
  address to remote people; the one before no longer works." with the new address, "This laptop"'s Internet link row
  says "turned on again as AGMessage started at 14:02 today: a new address, so remote people need this one", and the
  console says "[tunnel] on again until …". **A start that cannot turn it on again says so**: a cloudflared that
  cannot start, or ends before it gives an address (one that cannot reach Cloudflare, as at a boot before the network
  is up), is "Not turned on again as AGMessage started at 08:02 today: cloudflared exited (code 1)." on the card and in
  "This laptop", and "[tunnel] not turned on again: … It was to stay on until …: Turn on on the admin page, or a start
  of AGMessage before then, tries again." on the console; never "on again". Its end is kept, so the next start inside it
  (or Turn on, which keeps that end) brings the link back; nothing tries again by itself. A link a person turned on while
  the start's banner was said is theirs, and nothing is said of it as turned on again.
- **What forgets the end.** Turn off forgets it at once (so a stop before cloudflared has gone does not bring the link
  back), as do the end coming, a start past it or with an end no act could have set (further ahead than a day and two
  hours: a clock set back, a file written by hand; said on the console), and a Turn on whose cloudflared ended before it
  gave an address (nothing was on). A stop or a crash keeps it, and so does a cloudflared that ends of its own once it
  gave its address: the card then says "It was to stay on until 23:30 today. Turn on starts it again until then, as
  does a start of AGMessage before then; Turn off… keeps it off.", Turn off… (asked as "Keep the internet link off?")
  forgets it, and "This laptop" says the same with △. A crash ends cloudflared with the server, its end kept for the
  restart. On Windows a cloudflared already ended with its server however the server ended (libuv puts each child Node
  starts, unless detached, in a job object that ends it with its parent: read in libuv's source, not measured here);
  elsewhere a crash could leave it running, and a server the watchdog kills as hung still can, its address working
  until that cloudflared is ended by hand.
- **Where it is said.** `tunnel:status` and `admin:tunnelStatus`'s answer gain, at their end, `until` (the end kept, ms
  since the epoch; null when none is), `untilWords`, `untilClock`, `again` (when a start turned it on again),
  `againWords` and `notKept`; Turn on's answer gains `until`, `untilWords` and `notKept`, Tunnel until…'s is `{ok,
  until, untilWords}`. Appended to health's `tunnel`, at its end: `until`. The tunnel card says "On until 06:00
  tomorrow, then off and it stays off. If AGMessage starts again before then, the link is turned on again, with a new
  address." and "This laptop" says "on: … · until 06:00 tomorrow, then off". The context's `recent` gains "the internet
  link was turned on again as AGMessage started, with a new address", "the internet link was not turned on again as
  AGMessage started" and "the internet link ended at its end time"; the context's tunnel item, the hello and the AI's
  brief are unchanged.
- **Audited.** The link opened to the internet is now an audit row, never its address: `tunnel.on` (the person who
  turned it on and its end, written once cloudflared gives the address, so one that never opened is no row),
  `tunnel.until` (its end moved; asked again with the same time, no row), `tunnel.off` (the person; "kept off" when
  cloudflared had ended and only its end was forgotten), and system rows `tunnel.again` (turned on again by a start,
  with its end) and `tunnel.ended` (turned off at its end).
- **Settings that could not be read.** Tunnel until… is refused with the settings' own "Not saved: …" words, as every
  setting is. Turn on is the one act that still runs: what it does is the link itself, which never waited on the
  settings, so it turns the link on with its end held for this run only, and its answer, the card and "This laptop" (△)
  say why a restart would not turn it on again (`notKept`); nothing is written over the file.
- **A named tunnel for shows with remote people.** The card's instructions and the papers recommend a named Cloudflare
  Tunnel, run by the admin beside AGMessage, which keeps one address across restarts; the built-in quick tunnel stays.
- The tests: the end read by type (inside, past, none, beyond any end an act sets, not a number), Turn on's end an hour
  or more away (05:50 keeps the next day's 06:00, each such end one a start reads as inside its time), a time of day as
  its next minute (this minute's is tomorrow's; the end kept, named again, stays), as a time field holds it and in
  words by the laptop's clock, and the show day's end at 06:00. On a server with cloudflared stood in for (each start's
  addresses its own): turned on, the end of the show day kept and said in its answer, on `tunnel:status` with its
  laptop words and time of day, in health and "This laptop"; Tunnel until… kept, heard, the same answer and no second
  row asked twice, refused with words for every payload that names no time and with the link off; stopped and started
  again inside the end, the link on again at the same end with a new address, `again` set, "This laptop", the console
  (after the address, never before) and the audit log saying so, and the new address checked from the laptop; turned
  off, the end forgotten and the next start leaving it off; a start past the end, and one with an end no act sets,
  leaving it off, forgetting it and saying so, with nothing through the link; a link turned off as its end comes,
  audited, and off at the next start; unread settings turning it on with its end said not kept, refusing Tunnel until…,
  writing nothing over the file, and the next start leaving it off; a start whose cloudflared ends before its address
  (a stand-in that cannot reach Cloudflare) never said on again, said not turned on again on the card, "This laptop"
  and the console, its end kept and nothing audited; Turn on then keeping that end, and its own failure forgetting it;
  Turn off… with the link off forgetting a kept end, audited, and the next start leaving it off; and a crash with the
  link up (an error nothing catches) ending its cloudflared (each kill recorded) and keeping the end, the next start
  turning it on again. The browser smoke opens the card on a page set to another zone than the laptop's: it says the
  end by the laptop's clock, Tunnel until… is filled with the laptop's 06:00 and, confirmed unchanged, keeps the end,
  then moves it; stopped and started, the server turns the link on again and the card says "△ New address: …" with
  the new address, at the same end.
- The papers: `README.md`, `README.txt` (Remote participants), `docs/DESIGN.md` (The internet link), `docs/INSTALL.md`,
  `docs/NODES.md` (health), `docs/ACCOUNTS.md` (the audit log's rows), `SECURITY.md` (and the settings rule's one
  exception, Turn on) and `docs/ANALYSIS.md` (the pure set gains `lib/tunnelend.js`; 31 verbs refused by right).
- Rolling back: 0.5.1 ignores `tunnelUntil` in the settings and the new fields, and its tunnel ends with every restart
  again.

**AGMessage loads only what it ships, and runs only what it names by its absolute path** (the plan's Part 6, unit U11:
the module walk the plan measured, a `supports-color` and a `bufferutil` planted in a `node_modules` three folders above
the app and loaded by the server's own requires, and the fallback that ran cloudflared by its bare name; the code and its
tests, on Linux: whether a standard account may make `C:\node_modules` on the show laptop is reading R8's, not measured)
- **Nothing is looked for above `app`.** A `require()` that `app\node_modules` cannot answer makes Node walk every folder
  above the asking file up to the drive's root (`C:\node_modules`, which any signed-in account may be able to make), then
  its global folders, and load the first it finds: inside AGMessage, with its keys. The server asked for two such
  modules at every start, four times over. ws asks for its native helpers (`bufferutil`, and on older Node `utf-8-validate`) unless told
  not to: the server sets `WS_NO_BUFFER_UTIL=1` and `WS_NO_UTF_8_VALIDATE=1` before its first `require`, and the watchdog
  starts it with both, so neither is ever asked for. `debug` (under Express and Socket.IO) asks for `supports-color`:
  `supports-color` 8.1.1 (MIT, CommonJS, the last major that is; with `has-flag` 4.0.0, MIT) is now one of AGMessage's
  own packages, shipped in `app\node_modules` with its licence file, so `debug` finds it there and looks no further.
  Nothing else changes: `debug` only picks its colours from it, and only when `DEBUG` is set.
- **cloudflared is this copy's own.** The internet link runs `bin\cloudflared.exe` beside `app`, by its absolute path
  (`lib/startup.js` `cloudflaredFile`), and nothing else. A copy without it fell back to the bare name `cloudflared`,
  which Windows looks for in the current folder and on `PATH` first; it now has no link. It is looked for as the link is
  asked to start: Turn on is refused, `ok: false` with why, before anything runs and before any end is kept or
  forgotten, and the tunnel card and "This laptop" say "cloudflared not found in this copy (bin\cloudflared.exe):
  re-extract the portable folder. AGMessage runs only its own cloudflared, never one from elsewhere on this PC." (the
  installed node's words say "repair AGMessage by running its installer again" instead, `noCloudflaredWords`); a start
  inside the link's kept end says it could not turn it on again, with the same words, and keeps the end. A cloudflared
  taken away between the look and the run (an antivirus) says `error` and never `exit`, and its log's 500 ms poll used
  to run on for the life of the process, one more at every Turn on, Turn off stopping none: each start's poll and log
  file are now its own and let go at its cloudflared's `error` as at its `exit`. The browser opener (`explorer.exe`), "This laptop" and
  the power request (`powershell.exe`) and Show the admin token (`reg.exe`) were already run by their absolute paths
  under `SystemRoot` or the installer's `{sys}`; the fence below now holds each of them, and `machine.js`'s programs as
  unit U12 (#72) makes them. The watchdog runs its server by its full path only: `AGM_CHILD` (a test's stand-in
  server) that is not one (by `isFullPath`: on Windows from a drive or a network share, never `\server.js` from the
  current drive's root nor `C:server.js` on a drive's current folder) stops the start with code 3 and "AGMessage cannot
  start: AGM_CHILD (server.js) is not a full path, and AGMessage runs its server only by its full path. …", before
  anything runs or is written, rather than run whatever `server.js` the current folder holds.
- **The fences** (`test/loads.test.js`, `docs/ANALYSIS.md` §3.7):
  - *Only what it ships.* The watchdog and its server, and the server started alone, run under a resolve hook
    (`test/resolve-preload.js`, Node's `module.registerHooks`, which only reads each resolution) with a `supports-color`,
    a `bufferutil` and a `utf-8-validate` planted where Node looks once `app` has no answer (`NODE_PATH`, which Node
    reads only after its walk up every folder), and a page, health, the admin page and a socket over WebSocket are asked
    of them. Nothing they load is outside `app`, a file the portable folder does not ship, or a package the lockfile does
    not list or lists for development only; nothing they ask for is answered nowhere in `app`; no planted module runs; the
    server is started with the switches by its watchdog and sets them itself, before its first `require`, when started
    alone. ws asked for without its switch is shown loading the planted `bufferutil`, and asking for it with no plant is
    named as the walk to the drive's root, so the hook is seen to see the walk. Before this unit the fence found four
    modules loaded from the plant: `bufferutil` for each of the three copies of ws, and `supports-color` for `debug`.
    What a run does not reach is read from the source: every ask of the shipped server-side scripts, followed through
    each of the about 590 files it reaches as Node resolves it from the asking file (a lazy require included, one in a
    comment not), is judged the same way, but the asks a register names as never made (ws's two helpers, switched off)
    and each require whose name is made at run time, with its row (express's view engine, reached only by `res.render`,
    which no shipped script calls).
  - *Only what it names by its absolute path.* Every call in `app` that starts a program (`spawn`, `spawnSync`,
    `execFile`, `execFileSync`, `fork`, and `exec` and `execSync`, which the lint already bans), read from the source
    with ESLint's own parser and its scopes, names its program by `process.execPath`, by a full path written out, or by
    a name the fence's register holds with where its full path is made. `child_process` is followed as it is required
    (`node:` or not, in place, or by `module.require`), awaited from an `import()` or imported, and through every name
    it is given (a declaration, a default, an assignment, a destructuring's rest); its functions through every name they
    are given (destructured by any local name, read by a name in brackets, a default, `this.x`, a parameter called
    `spawn`). `fork`'s `execPath` is judged as its program, and a `shell` fails. A program that is a parameter of a named
    function only ever called is judged at each call of it. `child_process` or one of its functions handed on as a
    value (passed, returned, put in an object or on another's member, on the exports, read by a name made at run time)
    is named in the register with whose calls it becomes, and `child_process` named where none of these takes it (a
    `require` given another name, `require.call`, a re-export) fails. A call the register does not hold, a bare or
    relative name written out, and a row whose call has gone each fail it.
    Each place a path is made is held to give a full path or run nothing: `cloudflaredFile` (a folder named from its
    drive or a network share, else none), `openerPlan`, `windowsPlan` and the power request's plan (a `SystemRoot` named
    from its drive, else nothing run, and nothing off Windows) and `adminName` (`reg.exe` only in a `--sys` named from
    its drive). The tests are held too: the export's and the archive's README commands now run `/bin/sh` and
    `/usr/bin/unzip`, and the smoke runs a browser only by a full path.
  - *The machine's own commands require Node's built-ins only.* `launch.js`, and `machine.js` once unit U12 makes it,
    require only `node:` modules, each written out, and load no code around `require` (an import, `createRequire`,
    `dlopen`, `binding`). A planted relative file, package, built-in without `node:`, computed name, import,
    `createRequire` and `dlopen` each fail it, and so does `require` reached another way (`module.require`, a
    `Module`'s, `require` given another name, `require.call`, `require.resolve`); `require.main` loads nothing and
    passes.
- `server.js`'s synchronous file calls stay at 15: the look for its own cloudflared is a `statSync` where it was an
  `existsSync`, and it cannot be left to the spawn, whose missing program says `error` and never `exit`.
- Tests: a copy without its cloudflared (Turn on refused with the words, nothing run, no end kept, no read of its log),
  and one whose cloudflared went between the look and the run (three Turn ons and a Turn off leave no poll), with the
  tunnel's stand-in answering the look (`AGM_TEST_TUNNEL_GONE`) and counting the reads of cloudflared's log
  (`AGM_TEST_TUNNEL_LOGS`); each shape the fences follow, planted.
- The papers: `README.md`, `README.txt` (Remote participants), `SECURITY.md`, `THIRD-PARTY-NOTICES.md`,
  `docs/DESIGN.md`, `docs/INSTALL.md` and `docs/ANALYSIS.md` (§3.2, §3.4 and the new §3.7).
- Rolling back: 0.5.1 runs the bare `cloudflared` again where `bin` has none, and its server asks for the two modules
  again, from above `app`.

**A restart rewrites only the halls that changed, a stop saves first and says it saved, and "AGMessage restarted" only
after a stop that did not save** (the plan's Part 6, unit U4, with the owner's answer 41, "only after a stop that did not
save cleanly"; the tree's tests and the admin and hall pages in Chromium. The times below are the plan's bench, not rerun
here; nothing is measured on the show laptop, where reading R3′ and lab 5 take the stop)
- A stop and a start write only the halls that changed. 0.5.1 rewrote every hall's snapshot at a stop and again at the
  start after it (the plan's bench: 1.2 s at 200,000 messages and 5.8 s at 1,000,000 each time, where writing only the
  halls whose log held changes took 1 ms), and at 1,000,000 the watchdog's 4 s wait ended every stop in the middle of
  it, before the settings and the other stores were saved, leaving a 2.7 MB temporary file per hall that nothing
  removed. The store now knows a dirty hall (`dirty`): a line in its log, an op its log refused, a change made without
  an op (`markDirty`: a message moved to today's words as it loads), or no snapshot on disk it knows whole (one a start
  found torn and read from its `.bak`). A start and a stop write those (`compactDirty`), and no other. Every line of a
  log counts toward the 500 a hall is snapshotted at, the lines a start replays, finds already in the snapshot or finds
  torn included, so a log stays bounded across restarts even where a start cannot write its snapshot.
- A stop saves in order, then says so: the audit log's waiting entries and the head that covers them first, then every
  store's write lane (the settings, the accounts and sign-ins, the screens, the show desk's results, the peaks), then the
  dirty halls (0.5.1 wrote every hall first and the lanes after), then the peaks once more when those halls' snapshots
  raised the day's longest, which their timing marks after the peaks' lane was written. Then it writes
  `data/last-stop.json` last (`{at, build, saved}`), `saved` true only when every one of them was written; when one was
  not, the record says which (`unsaved`: a store's name, "the audit log", a count of halls, never a hall's code) and the
  console says "Not saved: … The next start says AGMessage restarted in each hall."; when all were, "Saved: the audit
  log, every store and 1 hall that changed.". A crash saves in the same order and writes no record: it is not a stop.
  The record is written once, after the lanes, through the atomic writer: it is no store.
- "— AGMessage restarted · 412 messages kept —" only after a stop that did not save. 0.5.1 wrote the line into every
  hall at every start, so a planned restart, or an upgrade between two sessions of a show, put it on the Board's
  screens. A start that holds the folder reads the record and moves it aside to `last-stop.seen.json`, so a crash or a
  kill after it is never read as that stop; one it can neither move nor remove (another program holds it) is said, and
  kept as the one seen too (a new file, which a hold on the record does not stop), so the next start reads it as taken
  (`stale`). It fails closed: a record that says it saved is read against what the start found in the folder, where a
  stop that saved leaves every hall's log empty and no snapshot newer than itself, so a log with lines or a newer
  snapshot means a copy ran on the folder after that stop and the record is `stale` (a record that names no time is not
  one). The line goes into each hall only when there was no record (a crash, the watchdog's kill of a hang, Windows
  ending it, a power cut, a folder 0.5 last ran), it could not be read, it says the stop did not save, or it is stale.
  Health's detail gains `lastStop {state, saved, at, build, unsaved, code, said, left}` at its end (`state` one of
  `saved`, `unsaved`, `none`, `unread`, `stale`; `left`, why the record is still where the next start reads it), and
  `saves.stores.rooms` its `snapshots` (this run) and `atStart` (this start). The admin page's "This laptop" gains Last
  stop: "saved at 2026-11-03 20:31 UTC by 0.6.0+41: …" ✓, or not saved, or not known to have saved, with why and how
  many halls were told AGMessage restarted △, or none for a data folder the start began; a record that could not be
  moved aside is said there too △. Reading R3′ no longer waits for this unit (it waits for U8 and U12).
- What a stop cut short left: once it holds the folder, a start removes each atomic save's temporary file
  (`<file>.<pid>.tmp`) in `data/` and `data/rooms/` whose process has ended, and says how many; a running process's (its
  watchdog's, its own) is kept, and a copy refused at the lock removes nothing.
- The AI's SDK is required at the first draft asked with a key, never as the server starts: no start loads it, and a
  server whose AI drafts are off never does.
- `lib/laststop.js` (the record, `take`, `judge`, `sweep`) joins the synchronous-call caps at 4, with its reason;
  `server.js` stays at 15 and `lib/store.js` within its 10. A fence holds every field a hall's snapshot writes to a row
  of `SNAPSHOT_FIELDS` (`lib/store.js`) naming the change that marks the hall dirty (an op, or `markDirty`), in two
  halves. The source half (`test/units.test.js`) reads `server.js` and `lib/` for a hall's settings, messages or
  tombstones written beside the store through any name and however deep (assigned, counted, deleted, merged into,
  changed by a mutating call), and its name or change number through the names the server gives a hall. The runtime
  half (`test/snapshot-preload.js`, `snapshotOf`) is loaded into every server the end-to-end tests start without
  preloads of their own, whose `stopServer` fails on what it finds, into the stop's own tests and into the smoke's
  servers: each hall a start or a stop leaves unwritten is held to the fields the store last wrote or loaded, so a
  message changed in place, which no pattern reads, is caught where a test drives it. The plan's unit 7 adds its guest
  code and retired codes there, written only by a snapshot, with `markDirty`, and the test that a New code survives a
  stop and a start.
- Tests: `test/laststop.test.js`: the record read by type (only `saved: true` with its time is a stop that saved), moved
  aside once, removed where it cannot be moved, kept as the one seen where it can be neither (the next take reads it as
  taken), and read against the folder (`judge`); the sweep (a file a write of ours names, its process ended, only, with
  a pid no process can have); end to end, the stop's saves recorded in order by `test/stop-preload.js`: the audit log,
  then every lane, then the one hall of three that changed, then the record, last; the start after it writes no hall
  and no hall gains the line; after a kill each of the three does, once, only the two whose logs held lines are written,
  and a second kill is still no stop that saved; a stop whose peaks could not be written (`test/busy-preload.js`)
  records `unsaved: ["peaks"]`, and the next start writes the line; a hall written after a stop that saved (its
  snapshot newer), then the log a killed 0.5.1 leaves, each read as stale, the line written once each time, and the
  stop between them writing the peaks again after the hall, its snapshot the day's longest on disk; a dead copy's
  temporary files kept by a copy refused at the lock and removed by the next that holds it, a running one's and others
  kept, and a hall moved to today's words written once at the start. `test/units.test.js`: only dirty halls written, a
  snapshot that fails leaving its hall dirty, a torn one dirty; five starts after kills that never reach 500 lines in
  the log; the fence's two halves, the runtime half finding a message changed in place, a setting, a name and a change a
  load made unmarked, and nothing the store was told of; the SDK not loaded until a draft with a key.
  `test/laptop.test.js`: the Last stop row. Moved on purpose: `test/server.test.js`'s restart (a stop that saved: no
  line; then a kill: the log replayed and the line once), `test/resilience.test.js`'s "a restart announces nobody"
  (bounded by the hall's change number, no longer by the restart's line), the stop's console lines, and the smoke's
  restart (no line after a stop that saved), whose "This laptop" now draws Last stop.
- The papers: `README.md`, `README.txt` (the saved rooms; pages back by themselves), `SECURITY.md`, `docs/DESIGN.md`
  (Recover, don't stop), `docs/INSTALL.md` (A stop, and the start after it; R3′), `docs/NODES.md` (health) and
  `docs/ANALYSIS.md` (§3.4).
- Rolling back: 0.5.1 ignores `last-stop.json` and `last-stop.seen.json`, rewrites every hall at each start and stop
  again, and writes its restart line at every start. A record a 0.6.0 stop left is read again by the next 0.6.0 start,
  as stale, when 0.5.1 ran on the folder in between: each hall then says AGMessage restarted.

**A page on another build reloads itself at a quiet moment, and the first upgrade reaches 0.5.1's pages** (the plan's
Part 6, unit U5; the tree's tests and the hall page, the halls board, the admin page and a screen in Chromium; nothing
is measured on the show laptop, where lab 6 takes an upgrade during a rehearsal)
- After an upgrade an open page kept the old build's scripts, and could take them again from its browser's cache for 5
  minutes after it loaded them (`maxAge: '5m'`), so a reload did not always bring the new build. The pages, their
  scripts and styles, the vendored libraries included, are now served `no-cache` with their ETag: the browser asks the
  server at every load and is answered 304, nothing sent, while a file is unchanged.
- Each page that opens a socket loads `/build.js` first, which names the build that serves it (`AGM.build`, as health
  names it), and names that build as it connects (its handshake's `build`, `AGM.reconnect.auth()`). Every answer a page
  reads its server's build from carries it: a hall's join, the halls board's watch, the admin page's settings and a
  screen's state (`build`, at the end of each). A page on another build reloads itself (`AGM.reconnect.build`), each at
  its own quiet moment, and only while it is connected to its server, so a reload never lands on a server it cannot
  reach (a page that heard the build and went quiet after a drop waits until it is back): a hall page connected and in
  its hall, with nothing written and not sent (the outbox holding nothing and waiting on no act's answer, every
  composer empty, no file chosen), no dialog, menu or ask open, no document on its stage, untouched for 5 s (or not
  shown); the halls board connected, with no answer held and no act waiting, no dialog, menu or ask open, untouched; a
  screen between takes, at a take it has not drawn, so no take on the air is cut and the page it loads draws that take
  and confirms it; the admin page only when its admin presses Reload this page, connected, in the strip that says
  "AGMessage now runs …, and this page is still on …" (whichever is newer: a Go back runs an older build), since a form
  half filled there would be lost. By itself a page reloads once per build in a tab: one that reloaded for a build and
  is still not on it (a script that did not load), or cannot keep that it reloaded (its storage blocked), stays as it
  is and says once "AGMessage now runs another build — reload this page when you can.", so no page reloads again and
  again; the admin's Reload goes whenever it is pressed, its strip saying when this tab already reloaded and did not
  come back on the build. A page that does not know its own build compares nothing. The outbox says how many acts are
  out and not yet answered (`acting()`), which the quiet moments read.
- 0.5.1's pages name no build. 0.5.1 served its files fresh for 5 minutes, and a browser's reload asks the server again
  only for the page itself, so a 0.5.1 page told at once could reload into this build's page with 0.5.1's scripts from
  its cache and name no build again. Every answer 0.5.1 gave came before the new start, so from 5 minutes after it no
  0.5.1 file can be fresh in any browser: then every 0.5.1 hall page, halls board and admin page open is sent
  `account:changed` with "AGMessage was updated — reloading.", on which 0.5.1 reloads, each tab whatever sign-in it
  shares, and each that connects later is told as it connects; once a socket, and its reload loads this build whole.
  A 0.5.1 screen has no reload path: its protocol keeps working, and it is named on the admin page as a 0.5 screen, to
  reload by hand once before doors.
- "This laptop" gains Pages, after Screens: "every open page and screen is on this build" ✓, or each that is not, by
  the build it named and when it reloads △ ("0.5 screens: Foyer in Hall 1: reload each once by hand…", "0.5 pages: 2
  hall pages (Hall 1: Ana, Hall 1: Ben): each is told to reload at 14:05, once no 0.5 script can still be in its
  browser's cache", then "…: each was told to reload; reload by hand one that stays listed", "on 0.6.0+40.abc1234 (an
  older build): 1 screen (Lectern in Hall 2) reloads at its next take"), at most 32 builds said and the rest counted,
  since a build is the page's own word. No right hangs on it: it is read only for this row and to reach 0.5.1's pages.
- Tests: `test/reconnect.test.js`: on the page's half, with the reload stubbed and the test's clock, a page on its
  server's build does nothing; a hall page reloads only when quiet (held by a send in the outbox, words in a composer,
  a dialog, a document on its stage, sent out of its hall, a touch under 5 s), once, and the board likewise; one that
  heard the build while connected and is quiet only while its socket is down reloads only once it is back, the board
  alike; the admin page only when its admin agrees, again when asked after a reload that did not bring the build, and
  with its storage blocked; a screen at a take it has not drawn and never at its own take again; once per build in
  a tab by itself (a reload that did not bring the build, storage blocked), and a newer build reloaded for; the page's
  own instance names `AGM.build`. End to end: `/build.js` names health's build, `no-cache` with an ETag and a 304, and
  so do a page, a script, the stylesheet and pdf.js; the join, the watch, the settings and a screen's state carry the
  build; in the first 5 minutes no 0.5.1 page is told, and "This laptop" says the time they will be; with that wait
  short (`AGM_OLD_CACHE_MS`, for tests), every 0.5.1 page open at its end is told then (two boards and two admin pages
  under one sign-in, hall pages come back and fresh, a page not yet in a hall), a later one as it connects, each once
  and none before it, a page that names a build and a screen never; "This laptop"'s Pages row, ✓ again once they have
  gone. The fence: each page that opens a socket names its build (`auth: AGM.reconnect.auth(`), loads `/build.js`
  before its own script and hears the build in its answer. `test/laptop.test.js`: the Pages row, pure, with the 0.5
  pages' time and the builds bounded. `test/outbox.test.js`: `acting()` as acts go out, are answered, say No answer or
  drop. The tests' own sockets name this checkout's build (`test/helpers.js` `connect`), `build: null` is a 0.5.1
  page, and `on` hears an event from the socket's first packet, as a page's listeners do. Moved on purpose: `test/menus.test.js` reads the join's answer ending with `forwardable`, then `build`;
  `test/laptop.test.js`'s panel rows gain Pages; `test/pagefloor.test.js` reads `/build.js` as the server's answer, not
  a file; `test/resilience.test.js` counts the one timer that tells 0.5.1's pages. The smoke: each page names the build
  that serves it; told another build, the hall page holds while its composer has words, the board while a dialog is
  open, the admin page until Reload this page and a screen until its next take; once quiet each reloads once onto the
  build that serves, and the screen draws and confirms the take it reloaded at; "This laptop" reads every page on this
  build.
- The papers: `README.md`, `README.txt` (Upgrading), `SECURITY.md`, `docs/DESIGN.md` (Back by itself),
  `docs/DISPLAYS.md`, `docs/INSTALL.md`, `docs/ANALYSIS.md` (§3.4) and `app/README.md` (`AGM_OLD_CACHE_MS`).
- Rolling back: 0.5.1 serves its files cached for 5 minutes and sends no build; a 0.6.0 page on it names its build and
  hears none in the answers, so it never reloads by itself. Reload each page and screen by hand after going back.

**How busy AGMessage is, and a stop that saves, asked at loopback with a proof of the token** (the plan's Part 6, unit
U8, read with Part 2's S.2 as its §0.8 C4 says; the owner's answer 39, "busy as proposed, and a busy server stopped only
with a typed reason"; the tree's tests. Nothing is measured on the show laptop: reading R1 takes the stop on the
Windows runner, and R3′ waits for the server task)
- **The busy line** (`lib/busy.js`, pure): one line of counts and nothing else — `active` (pages active in the last 10
  minutes), `takes` (screens whose take changed in them), `help` (help requests raised in them), `countdowns`
  (Stagewatch countdowns running now), `seats` and `screens` (open and quiet, counted apart) and `sockets`. Busy is
  activity, not presence: a message or other input, a take or a help request in the window, or a countdown running; a
  full hall that only reads and screens holding their take are not busy. A page is a person in a hall (the hall's code
  and the uid its join gave them, so the same person back on a new socket is one page), active when its seat sent a
  verb of `busy.INPUT` (an answer, a reaction, a take, a help request, an ask of the AI), heard before its handler runs,
  or when the hall holds a message of theirs from the window: whoever sent it (a seat, the admin's support view, the
  minutes, a show system; the system's own lines never) and across a restart, since the hall keeps its messages. Input
  that left no message is held in memory, at most 10,000 pages, the oldest let go first. A page counts for 10 minutes
  from its newest input or message, open or closed since. A screen's take records when it changed (`takenAt`, beside
  `updatedAt`, which a screen made also sets). 0.5.1 had no way to say whether a show was running.
- **At loopback, for this PC's machine** (`lib/machinewire.js`, both halves): `GET /api/machine/hello?c=<challenge>`
  answers a fresh nonce, the build and the server's proof of the admin token, HMAC-SHA256 over `"agmessage machine
  server\n"`, the nonce and the machine's challenge; `GET /api/machine/busy`, `POST /api/machine/stop {reason, by,
  force}` and `POST /api/machine/events` each carry the nonce and the machine's proof, HMAC-SHA256 over `"agmessage
  machine\n"`, the nonce, the method, the path and the body's SHA-256. Each is answered only on this PC
  (`guard.isHostMachine`), only for a nonce issued within 30 s and not used before (256 held at most, the oldest let
  go), and only for a proof that compares in constant time; one with no proof, or a nonce not issued, used or 31 s old,
  is refused; a wrong proof is refused, written as `login.token.fail` and counted toward the token's lockout, which the
  token sign-in shares. The machine checks the server's proof before it sends anything else, so a program that took
  the port during a restart, or gives back a hello it read earlier, is sent nothing after the hello; the token never
  crosses the socket. A browser's request (an Origin or a Sec-Fetch-* header, which the machine never sends) is
  answered nothing, so a page open on the laptop can neither ask nor flood the nonces; and nothing is answered while
  the admin token is shorter than 16 characters, saying why, since a hello lets any program on the PC test guesses at
  the token offline (only an `ADMIN_TOKEN` chosen by hand can be that short). A nonce's refusal says `again`, and the
  machine asks once more from a fresh hello, never a third time. The machine holds the token as the server does (lower
  case, its line's end trimmed). A server that has not answered whole within 5 s reads as busy (the time is the whole
  answer's, so one that answers a byte at a time does too), as does one that does not prove it or answers no line;
  nothing listening is not busy. The nudge to read the machine's events carries nothing and reads none
  until the control tasks' unit gives the server events to read. In 0.5.1 a stop was a signal or the watchdog's IPC,
  nothing outside the watchdog could ask one, and the folder's pipe ended every connection.
- **The stop** (`reason` one of `stop`, `upgrade`, `back`, any other word refused; `by`, who asked; `force`, the reason a
  person typed) saves as every stop does and ends with code 0, which the watchdog reads as stopped. A busy server
  answers "Not stopped: AGMessage is busy (3 pages active, a countdown running). Type a reason to stop it anyway."; with a
  typed reason it stops and writes `server.stop.forced` (who asked, why, what was live, the words typed). The window
  and `server.log` say "Stopping for an upgrade, asked at loopback by LAPTOP\ana". A stop asked while one is under way
  is answered with what is being done (`already`), and says and writes nothing more.
- **The data folder's pipe** answers the busy line to whoever connects, once its copy serves, and ends the connection:
  a read, never a command. Its default access lets anyone on the PC read it and whatever took its name first answers in
  its place, so the line chooses words and nothing else. A second copy refused at the folder says it: "AGMessage is
  already running on this data folder (…). It says it is busy: 1 page active, a countdown running." or "It says it is
  idle: nothing in the last 10 minutes; 4 seats and 2 screens open." A copy refused at the port alone keeps its words:
  it cannot name the other copy's pipe (Part 2's S.2).
- **Reading R1 is taken** (`tools/readings-take.js` `takeR1`, `tools/readings.js` `judgeR1`): a portable folder seeded
  per size (an empty hall; 20 halls of 10,000 messages), the bundle's watchdog started once to settle it, then 3 rounds of
  a page seated, the stop at loopback with the proof of a token made for the reading (never kept), the next start at
  once and the page back at the hall page's own pace (0.5 s doubling to 2 s, each ±50 %, held to `public/reconnect.js`
  by its test), each round with the watchdog's code and whether `last-stop.json` says it saved; the seeded messages are
  from before the busy line's window, so the stop is the upgrade's own; the mark is the largest hall's slowest page
  back, ≤ 1.5 s, as R2 and R10 judge theirs, its median said beside it. R3′ and R9 now wait for U12 (#72) alone.
- Tests: `test/busy.test.js`: the line (its keys a fence, counts only, read by type from another program, busy from
  activity and never presence, its words) and its window (a page by its hall and person, 10,000 held, the oldest let
  go); a hall's messages from the window (each sender's page, help counted, the system's lines never, read back only to
  the window's edge); every socket verb a handler registers is input or a page's own read and not both, and every verb
  a page holds for its person is input; the two proofs bound to every part and neither standing for the other; the
  token as the machine reads it, the 16-character floor and a browser's headers; the nonces (once, 30 s, 256 held); the
  stop's body (an unknown key or word refused); a program that answers a byte at a time, on the port and on the pipe,
  let go at the time; a nonce's refusal asked again once and never twice, a wrong proof never again.
  End to end: refused off this PC (a forwarded request, another name, the tunnel's header) for all four; the hello's
  proof checks with the token; no proof six times, then a right one answered; a nonce used, then one 31 s old (the test's
  clock), refused; an idle seat and a screen not busy, then input, a help request, a take and a countdown each counted;
  the folder's pipe answering the same line, and a second copy's words busy and then idle once the window is over; five
  wrong proofs written and counted, the sixth right one refused by the lockout, as the token sign-in is, and answered a
  minute on; a browser's request refused on all four; a busy stop refused without a reason, then saved and ended with 0
  with one `server.stop.forced` row; a quiet stop with none, two asked at once saying, saving and recording one stop; a
  message from the admin's support view and the minutes busy, and still busy after a restart within the window (Ana
  back on a new socket the same page), a stop without a reason refused; a server with a 12-character token answering
  the machine nothing, with why, its sign-in as it was; programs on the port that are not the server (a wrong proof, a hello read earlier and given back, one
  that answers no line, one that never answers) each sent only the hello, and no byte the machine sent, to them or to
  the server through a relay that kept every byte, holding the token (searched by value). `test/readings.test.js`: R1
  judged on the slowest round (one round over the mark misses it), its pace read from the hall page's, its seeds from
  before the window, and taken on this machine against this checkout (each stop saved, the watchdog ended with 0, no
  token in the record). Moved on purpose: `test/readings.test.js`'s register (R1 waits for nothing; R3′ and R9 for U12 alone; the
  readings that still wait name 13 units) and its notes; `test/modules.test.js`'s pure set gains `lib/busy.js`.
- The papers: `README.md`, `README.txt` (the folder held; a token chosen by hand), `SECURITY.md` (what a hello gives a
  program on the PC), `docs/ACCOUNTS.md` (the audit log's `server.stop.forced` and the machine's `login.token.fail`; the
  token's floor), `docs/DESIGN.md`, `docs/INSTALL.md` (The busy line, and the stop at loopback; R1's row),
  `docs/NODES.md`, `docs/ANALYSIS.md` (the pure set, the two bounds, the waits) and the plan's note at Part 6's U8 (the
  wire as built, which U12, U17 and U18 speak).
- Rolling back: 0.5.1 has no `/api/machine/*` (a machine asking it reads it as not proven, so busy), its pipe answers
  nothing, and it ignores `takenAt` in `displays.json`.

**A hall's other rooms are kept beside it, and today's halls are read as halls with one room** (the plan's Part 1, unit
4, its §1.1-1.5 and §3.5, with Part 5's fence (l); the tree's tests. No act makes a side room yet, so nothing a page
shows changes: the rooms are made, given and joined in the units that follow)
- **A hall is its Main room**, as in 0.5.1: its key, its code, its name and its files are today's, and the store's hall
  readers (`store.rooms`, `get`, `has`) read halls and nothing else, so the halls board, `/api/halls`, the context and
  the desk's notice count, screens, Stagewatch and peer links, a hall's set-up and accounts' halls never see a side
  room. A reader of a hall that should have read any room answers "Room not found" there: it fails closed. Left on
  halls, each with the unit that moves it: what a side room sends to its hall's Stagewatch (`linkFor`, the AI's brief:
  the plan's unit 8, refused there until then, below), a help request's answer (`help:respond`: units 5 and 8, none
  raised there until then), the admin's room list (`admin:listRooms`: unit 6) and a hall's invite links (unit 7); the
  halls board's row, the context and health's `largestHall` count Main rooms, as their words say.
- **A side room** (Legal, Media) is a room as a hall's Main room is, with its own op log, numbers, ring, snapshot, seats
  and lock, kept beside its hall as `data/rooms/<HALL>.<KEY>.json`, `.log` and `.json.bak` (`lib/store.js`) and reached
  only by the any-room readers (`room`, `hasRoom`, `allRooms`, `roomsOf`). One is made only beside a hall that is here,
  under a key no room has, at most 20 to a hall (`createIn`), its first snapshot written at once with its guest code
  off, so a new room is for accounts until it is switched on; a hall's rooms are read from its own list, in the order
  they were made, never by a walk of every hall's. A start loads every hall first, as 0.5.1 does, then each side room
  whose hall loaded, whose key no other room has and whose hall holds fewer than 20 already; a room whose hall is gone,
  one whose key another room has, one past the 20 (by its file's name, the same ones every start) and a file of no hall
  and no room are each said on the console ("Not loaded: room LGQ4MZP8 — its hall H7K2QA is gone (its files are kept as
  H7K2QA.LGQ4MZP8)") and left on disk, where 0.5.1 skipped a name it did not read without a word. A start and a stop
  write the rooms that changed, side rooms included, and a stop that could not write a side room counts its hall among
  those it names. A hall removed goes with its side rooms, their files first, so a stop part way leaves a whole hall
  with fewer rooms, never a room without its hall. A room's backup, then its snapshot, then its log are removed, and a
  file another program holds (an antivirus, a backup: EBUSY or EPERM) is no longer passed over in silence: the removal
  stops at it, so the room's files from it on stay whole, it is said on the console ("Could not remove
  H7K2QA.LGQ4MZP8.json (EBUSY): …"), and the admin's answer, the admin page and the row say the files of how many rooms
  stayed and whether the room or hall opens again at the next start (it does while its backup or snapshot stays, beside
  its hall), in which case its uploads are kept for it even when the removal asked for them to go.
- **Who reaches a side room, by its key:** an admin account (one that manages settings) joins one, and the admin's
  support view and room controls (the laptop's token's too) reach one. No other account: an account's halls reach a
  hall's Main room only, every hall's included ("Your account has no access to this room — ask an admin."). No guest: a
  code names a hall, never a side room, so a join or a lookup with a side room's key finds nothing, as a wrong code
  does. An account's rights reach no side room, so nothing is forwarded into one on them, and the admin's link of an
  account into one is refused, as a link into a hall it may not post in is; a guest the admin links into one forwards
  there, as into another hall. A side room shows its hall's countdown (the join's `stage` and every frame are its
  hall's Stagewatch's), and sends nothing to a Stagewatch: Send to the speaker's screen, a proposal to the show desk and
  their destinations are refused there ("This room sends nothing to the speaker's screen: send it from the hall's Main
  room."), `canSendToStage` and `canPropose` false, and a draft carries no show facts, where they would have gone to the
  default Stagewatch and been answered as sent with nothing kept in the room. A help request raised there is refused
  ("Help requests are asked from the hall's Main room, where its crew answers them."): no board would show it and no
  one could answer it.
- **Every room, not only a hall:** a file a side room holds is in use, so a hall's reset or a message removed there
  never takes it from the disk (0.5.1 scans only the halls it loads); a page's room is "gone" only when no room has its
  key; a room's people list and seen receipts are sent to that room's pages; a hall that follows another Stagewatch, and
  each frame of its Stagewatch, reaches every room it holds; a hall is live for the power request with a page seated in
  any of its rooms, a meeting in a side room alone included, and a message any room holds from the busy line's window
  makes its page active, across a restart too; "This laptop"'s Pages row names a side room's page by its hall's name and
  its own ("Hall 2 › Legal"); a send to the speaker's screen or a proposal is kept only while its room is
  (`store.room`); the boot's saved seats nobody took up are let go in every room; after a stop that did not save, every
  room says "— AGMessage restarted · N messages kept —" (health's `lastStop.said` still counts the halls); a forward and
  its picker reach a room the person sits in or the admin linked them to; and a new hall's key is no room's key. The
  admin's room controls take a room by its key: watch, the transcript, reset, remove, a message removed, a seat, the
  lock, a link in, out or back, send out, the AI's summary and its minutes; a hall's invite links stay a hall's (a
  guest's code names a hall, so a side room's would admit nobody). A side room removed alone sends its pages out ("This
  room was closed by the admin."), leaves its hall's Stagewatch, screens and links as they are, and writes one
  `room.remove` row with its name and its hall's ("Legal (Hall 2), files removed"); a hall removed sends every room's
  pages out, and its `hall.remove` row counts its other rooms ("Hall 2 with 2 other rooms, files removed").
- **Health:** `/api/health` appends `sideRooms` at the end of its detail, the rooms the halls hold beside their Main
  rooms; `rooms` still counts the halls.
- **Today's halls read as halls with one room.** A 0.5.1 data folder boots with each hall's rooms its Main room alone:
  the same code, name, messages and numbers (one more, for the restart line), seats and lock, invite links, forwards (by
  their hall's name), stage sends (`link: 'hall:<code>'` with its Stagewatch's address tag, still followed: the
  speaker's acknowledgement after the restart reaches the line it sent), the hall's Stagewatch, its screens, the desk's
  results and the accounts' halls. Nothing is rewritten but what a start already writes, and no people's pages
  file and no list of rooms that may send in appears.
- **The fence (l)** (`test/modules.test.js`, `docs/ANALYSIS.md` §3.5): every call to an any-room reader in a shipped
  server file is counted per file with why it reads any room and not a hall, 38 in `server.js` (the plan's §3.5 and the
  readers of room state beside it: the people and seen frames, a stop's halls left unwritten, the power request, the
  busy line, "This laptop"'s Pages row and a stage send's room still kept); the store's side rooms are read through
  those readers alone (`store.side` and `store.sideByHall` nowhere else). A planted call
  without its reason, a reason without its call and `store.side` read past the store each fail it. The snapshot fence's
  runtime half (`test/snapshot-preload.js`) holds a side room as a hall: a field changed beside the store is found.
- Tests: `test/units.test.js`: a side room kept as `<HALL>.<KEY>`, reloaded under its hall with its numbers, its
  messages and its log replayed, resumed within the room; the hall readers never see it and the any-room readers do, in
  order; made only beside a hall, under a free key, at most 20; a room whose hall is gone, one whose key another room
  has, one past the 20 (the same ones at every start) and a file of no hall or room said and kept byte for byte;
  `compactDirty`, `dirtyCodes`, `unsaved`, `remove` and `removeHall` cover side rooms, the side rooms' files removed
  first; a file another program holds stops the removal at it, said, its room loading again whole only beside its hall;
  0.5.1's one test, `CODE_RE`, takes a hall's stem and never a side room's. `test/resilience.test.js`: a 0.5.1 folder
  (two halls, each snapshot in 0.5.1's shape, a locked hall's seats, a forward, a stage send with `link:'hall:CODE'` and
  its Stagewatch's tag, a desk result, an account's halls, a screen, the hall's Stagewatch, an invite) boots with
  `sideRooms` 0 and every hall as it was, seq + 1, the stage send acknowledged after the restart, and a second copy on
  the folder writes nothing. `test/uploads.test.js`: a file a side room holds survives its hall's reset; the room
  removed takes the file only it held and its own files, with its row; the hall removed takes the rest; a side room
  whose snapshot another program holds (`test/busy-preload.js`'s `AGM_TEST_UNREMOVABLE`) is said to the admin, in its
  row and on the console, its upload kept, and is back at the next start. `test/halls.test.js`: who reaches a side room
  by its key and who never does (the laptop token's support view among those who do), its own numbers and people, the
  hall's Stagewatch, a forward and a linked guest's forward reaching it, an account's link into it refused, the Main
  room never hearing it; its stage sends, proposals, destinations and help refused with their words while its hall's
  Main room may send, nothing reaching either Stagewatch, its page counted by the power request and its message keeping
  the busy line active across a restart. `test/modules.test.js`: the fence (l) and a planted breach of each kind. Moved
  on purpose: `test/server.test.js`'s health keys end with `sideRooms`.
- The papers: `CLAUDE.md` (the store's row, the fence's, the frames', the start rules' preload, and a room in the house
  words), `README.txt` (going back to 0.5.1: a hall's other rooms not opened, and a file only one holds),
  `docs/ACCOUNTS.md` (the audit log's `room.remove` and `hall.remove`), `docs/ANALYSIS.md` (the fence (l)),
  `docs/DESIGN.md` (the per-room numbers, fail closed, the modules fence), `docs/INSTALL.md` (the busy line's pages and
  the power request's halls, by room), `docs/NODES.md` (health's `sideRooms`; a meeting in the context is a hall, its
  side rooms never counted), and `tools/build-portable.ps1` (it refuses to package any file under `app\data\rooms`, a
  side room's included, and every store and key in `app\data`).
- Rolling back: 0.5.1 loads the halls with every message and leaves each side room's files on disk (their names hold a
  dot, which its loader never takes); back on 0.6 they load again. Under 0.5.1 a file only a side room holds can be
  removed by a reset or a deletion of any hall, since it scans only the halls it loads: do not go back to 0.5.1 during
  a show.

**New socket verbs register from handler modules, through a connection context, a server context and one gate** (the
plan's Part 5, unit 30; the tree's tests. No verb moves and none is added: what a page sends, and what it is answered,
are as before)
- **One gate** (`app/lib/gate.js`, pure): a verb in a handler module passes `conn.gate(ack, {joined, bucket, admin,
  may})` first. It reads, in this order and each only once the one before it passed: the socket seated in a room ("Not
  joined") that is still here ("Room gone"); a token of the verb's bucket ("Slow down a little.", with `busy`, so the
  outbox sends a held write again shortly); the admin ("Not admin"); its rights, in turn ("Observers can read but not
  post."; a file "Your account may not share files here.", or "On stage seats send messages, not files." from a seat On
  stage). Nothing a client names is looked up before a token is taken, so a request refused at its admin or its right
  has spent its token, as a message's already does, and a refused lookup (a stale reference, another hall's code) is
  never a free oracle. An option the gate does not take, a bucket not named (`bucket: null` says there is none), a
  bucket it cannot take from and a right it has no words for each throw before anything is read: the socket's guard
  answers the request as refused, and no verb is let through with a step left out.
- `server.js`'s own `need`, `mayPost` and `admin` are the gate's steps alone, and `limited` says its bucket's words, so
  the 57 verbs registered there answer in the gate's words, as before, each in its own order (a message takes its bucket
  before its right, `help:respond` its `chatter` token first).
- **`conn`**, frozen, is what a handler module is given of the connection: the socket, its room and its person read when
  asked (functions, so no verb holds a room its page has left), `ok`, `limited`, the `writes` and `chatter` buckets,
  `need`, `mayPost`, `allowed`, `admin`, `actor`, `canManageHall` and the gate, made after each helper it holds.
- **`ctx`**, frozen, is the server's: the room store, `apply`, `systemMessage`, `buildMessage`, `removeUnused`,
  `fileNamesOf`, the audit log, the accounts, `boardDirty`, `settings` (to read), `linkFor`, `stagePayload` and `io`. It
  is built once, last in `server.js`, after every part it names exists and before the copy holds its port; a part not
  built yet stops the start rather than reach a verb as nothing. **`takesCtx`** is the same but the parts that make a
  room's op or send to a room (`io`, `apply`, `systemMessage`), and with `sendTo(socketIds, event, payload)`, which sends
  to each socket open now named by its id, one at a time and once each, and answers how many it reached: a hall's key
  given as an id reaches nobody, where a broadcast would reach the whole hall, and only a list names sockets. The open
  sockets are read from `io` by `lib/gate.js` itself, never handed in by the server, so the server's `takesCtx` is the
  one the tests hold.
- `app/lib/handlers/rooms.js` and `app/lib/handlers/takes.js` each give the connection one `register(socket, conn,
  ctx)`, called after its own verbs on every page's socket but a screen's (the hall page's, the admin page's, the halls
  board's): the rooms module with `ctx`, the takes module with `takesCtx`. Neither registers a verb yet; the room verbs
  and the takes on people's pages of the units that follow register there, and the verbs already in `server.js` stay
  there until a unit rewrites one, and none is added there.
- **The fences** (`test/modules.test.js`, `docs/ANALYSIS.md` §3.5), each read as code (a word in a comment or a string
  is none) and shown failing on a planted breach of each kind:
  - (d) a handler module requires only the pure core (`lib/gate.js` joins it), guard's pure helpers by name (`str`,
    `cleanText`, `mac`, `Bucket`), `lib/ids.js` and, for the takes module alone, the pages' pure vocabulary by name;
    never a built-in, a package, a store or an edge (`lib/resilience.js` included); it reaches nothing past a literal
    require (no `import()`, `require` handed on or given a name, `process`, module loader or global object), makes
    (`new`) nothing it requires, however it is named, and reads its context once, destructured as its `register`'s first
    statement, so that line is its list of what it reaches;
  - (i) every listener in a handler module but Socket.IO's own `disconnect` is written in place and starts with its one
    gate, `if (!conn.gate(ack, {…})) return;`, handed the listener's own acknowledgement (so a refusal answers the
    sender), its options written out and the gate's own, naming one of the connection's buckets (`conn.writes`,
    `conn.chatter`, or one taken from `conn` by its name) or saying `bucket: null` with why on its line or the line
    before; no gate stands outside a verb, and none is passed twice;
  - (j) the takes module names no `io`, `.to(`, `.in(`, `.broadcast`, `.nsp`, `.server`, `.except(`, `socket.join(` or
    `socket.leave(`, nor a member by a string, reads the room store only through its readers, never takes the store or
    the socket under another name and asks its context for no `apply` or `systemMessage`; no handler module asks a right
    of `rbac.can` under any name rbac is bound to (or takes `can` from it), names `sendTo` but to call it, or writes into
    `settings` (an assignment, `++`, `delete`, `Object.assign`, `Reflect.set`, a method that is not a read, such as
    `push` or `splice`, a hand-off through `.call` or `.apply`, or settings or a part of it taken under another name);
  - `server.js` registers only the verbs it held when the handler modules came, a list that only shrinks, so a new verb
    written there fails the build;
  - the source read holds `conn` to its helpers, each made before it in the connection, its buckets to the
    connection's, the two modules to being registered once each after it, and `ctx` to its parts, each declared before
    it, built before the port is held and handed nothing else;
  - (f), the wire's words, reads a take's `sendTo(ids, 'event', …)` as an event the server sends, so one no page hears
    fails it, as an emit does.
- Tests: `test/units.test.js`: the gate's order on a socket's facts, recorded as they are read (each step's words, what
  it read to say them, the token taken or not), a request refused after its bucket spending its token until the next is
  refused at the bucket before its right is read, and every malformed option refused before anything is read; the
  contexts frozen with the parts themselves, `takesCtx` without `io`, `apply` or `systemMessage`, `sendTo` given a
  hall's key reaching nobody where the broadcast reaches the hall, a socket's id reached once, a socket gone reached no
  more, a string or a set never read as ids, and a context with a part not built, or an `io` whose open sockets cannot be
  read, refused; and the same on a real Socket.IO server with two pages seated in a hall, as `server.js` builds it.
  `test/modules.test.js`: (d), (i), (j), the verbs of `server.js`, the contexts' source read and (f)'s `sendTo`. Every
  other suite unchanged.
- The papers: `CLAUDE.md` (the client input rule's second place, the gate's row, the module fence's), `SECURITY.md` (the
  gate's order, what a handler module and a take reach), `docs/ANALYSIS.md` (the fences (d), (g), (i), (j)),
  `docs/DESIGN.md` (the modules row).
- Rolling back: nothing is stored or sent differently.

**Rights are checked per room, behind a fence** (the plan's Part 1, unit 5, its §2.1 and §2.3, with Part 5's
`rbac.guestCaps` and `conn`'s rights question and Part 7's seat limit in `rightsIn`; the tree's tests. No page gives an
account a room or an On stage hall yet, so in a hall's Main room every right is answered as in 0.5.1 and a side room is
the admin's; the seats and the admin's join that move are said below)
- **A room's rights are the room's** (`app/lib/rbac.js`): seeing, posting and sharing files (`ROOM_SCOPED`:
  `hall.view`, `hall.post`, `hall.files`) are answered only by `rbac.canIn(account, right, scope)`, for a room named by
  its scope, `{code, hall, main}` (`store.scopeOf(room)`: its key, its hall's, and whether it is that hall's Main room;
  one not whole, a string included, answers no). In a hall's Main room they follow the account's halls, as before; in a
  side room only the rooms the account is given (`effective`'s new `rooms`), never its halls, so an account of every
  hall (a project manager, a senior tech, "every hall, including new ones") reaches no side room by that; the admin role
  is a member of every room. A hall's own rights (its screens, its Stagewatch, its show network) stay the hall's in each
  of its rooms. `seesHall(account, hall)` reads a hall's Main room and its hall's parts, `seesRoom(account, scope)` a
  room.
- **The fence:** `rbac.can()` asked one of those three rights with a hall named (a code, or anything in its place)
  answers no, whoever asks, the admin's and every hall's accounts included, so a check left on a room's key where a
  hall's was meant refuses instead of letting every account of every hall in. Asked with no hall ("in any hall at
  all?"), they still answer, so the Accounts page's and the routes' own checks are unchanged.
- **The seat an account joins with** (`rbac.roomRoleFor(account, scope)`): backstage where it may post, else an
  observer, as before, and On stage in a hall's Main room whose hall its On stage halls name (`effective`'s new
  `board`), where it may post; never On stage in a side room. A hall's key given as a string is read as its Main room.
  Seated On stage, an account is held to the seat's limit as a guest is (no upload token, no file, nothing forwarded).
  The join seats the admin (an account that manages settings, on its pages), which may post wherever it sits
  (`allowed`), backstage wherever its account's own rights would make it an observer: in a side room it is not given,
  in a hall its halls do not list, and in a hall where its own rights only read (a Viewer given settings.manage, seated
  an observer before while the server took its posts), so its page is never read-only where its posts are taken.
- **A code guest's rights** move from the connection into `rbac.guestCaps(role, kind)`, beside the account rights: a
  hall's Main room's table as before (backstage posts, shares files and sends to Stagewatch; On stage posts; an observer
  reads), and a side room's beside it (`GUEST_CAPS_SIDE`: a Member posts and shares files and sends nothing to
  Stagewatch, an observer reads, no seat there is On stage). A seat or a kind the tables do not list holds nothing.
- **Moved to the room:** a page's rights (`allowed`: an account by its rights in its room, a guest by its seat and the
  kind of room); the join (the admin first, then the account's rights in that room, `seesRoom`; its seat by
  `roomRoleFor`); the rights a forward and its picker read in another room (`rightsIn`: an account by its rights there,
  held to the seat it would sit there, a guest by its seat there and the kind of room); `help:respond`'s account branch
  (the crew of the request's room or of its hall's Main room, `answersHelp` by each scope, its own Resolved by its
  right in the room); the halls board's `canRespond`; `/api/halls`' `can.post` and `can.files` (asked in each hall's
  Main room, so their answers are 0.5.1's); `nodes:list`'s halls (`seesHall`); and the admin's link of an account into
  a room (`admin:linkRoom`), refused where the account may not post in that room: "Tom signs in with an account that may
  not post in that room: a side room is only for the accounts it is given to." (a hall's words are as before). An
  account that manages settings (the admin, from its pages) joins any hall or room by its key, seated backstage, as
  its watch and support view reached them already; before, a hall its own halls did not list refused its join.
- **`conn.canIn(right, room)`**: a handler module's question of the connection's rights in another room, by that
  room's scope and never by a seat (the admin, the laptop's token or an account that manages settings, every right; an
  account by `rbac.canIn`; a code guest none), so no module asks `rbac.can`; what a verb may do in the room it sits in
  is asked of `conn.allowed` (the gate's `may`), which reads the seat's limit first.
- Tests: `test/accounts.test.js`: the fence for every role (accounts of their own halls and of every hall, a Viewer,
  the admin) and room right (a hall's code, a room's key, a scope, a list, a number), the no-scope question still
  answering, a hall's own rights still asked of the hall; `canIn` in a Main
  room equal to 0.5.1's answer for every role, right and hall (grants, revokes, a turned-off account, an unknown role
  and none); a side room reached by its members (their rights still deciding: a Viewer reads, a revoke takes away)
  and the admin role, never by every hall's accounts, its hall's members or a halls list naming its key; a hall's own
  rights there its hall's; a malformed scope refused even for the admin; `effective`'s `rooms` and `board` (strings in a
  list only); `roomRoleFor` by scope (a Board hall seats `board` in its Main room only, never without the hall or
  `hall.post`), and a string as a Main room; `guestCaps` for both kinds, an unknown seat, kind or an object's own name
  holding nothing, every table frozen; `answersHelp` by scope (a side room's crew its members', a Board member none,
  a string no scope). Moved on purpose: the old `:23-24` and `:27` to `canIn` and `seesHall`, the turned-off account's
  and the unknown role's room rights to `canIn` and `seesHall` (asked of `can()` with a hall, the fence alone would
  refuse them), and `answersHelp`'s cases to scopes. `test/halls.test.js`, end to end on a folder whose accounts' file gives Lou and Tom the side room and Kim
  Hall A's On stage seat and the side room too: Lou joins the side room backstage with an upload token, posts and
  shares a file, and is refused Hall A's Main room; a project manager of every hall is refused the side room; Hall A's
  `/api/halls` rights as before; Tom's forward from the Main room lands in the side room, its picker listing it; Kim is
  seated On stage, with no upload token and a file refused, and from the side room, where she sits backstage and shares
  a file, forwards into Hall A only what her On stage seat there may post (a text, posted as `board`; the file refused,
  "You may not share files in that hall.", and not offered by the picker); a project manager of Hall B alone who
  manages settings joins Hall A and the side room by their keys, seated backstage with an upload token, and posts in
  each, while the same manager without that right is refused both in their words; the admin's link of Tom into the side
  room passes and of the project manager is refused with its words (and the side-room test's link of an account with no
  room, and its title, moved to those words on purpose).
  `test/modules.test.js`: `conn` holds `canIn`, made before it in the connection.
- The papers: `CLAUDE.md` (the rights row, the seat's row, the gate's row), `SECURITY.md` (rights per room),
  `docs/ACCOUNTS.md` (rights in a room; a guest's side-room seat; a forward's and On stage's rights by room),
  `docs/DESIGN.md` (the server is the authority; fail closed), `docs/ANALYSIS.md` (the rights fence; (j)'s `canIn`).
- Rolling back: nothing is stored or sent differently. 0.5.1 ignores an account's `rooms` and `board`, which nothing
  writes yet.

**A hall's rooms are made, renamed, reset and removed, and a side room is never taken for a hall** (the plan's Part 1,
unit 6, its §1.6, §2.4, §2.5, §2.7, §7.4 and §8, with Part 5's handler module and catalogue rows, and owner question 5,
"Defaults": making and renaming rooms is `halls.manage`'s, the rest the admin's; the tree's tests. A side room's guest
code stays off, so the admin, and an account given the room by its accounts' file, go in: the codes, the Accounts page's
rooms and the pages' room switcher are the units that follow)
- **`room:create {hall, name}`** makes a side room (Legal, Media) beside a hall, for those who set halls up (`halls.manage`,
  the admin; `conn.canManageHall`, which an On stage seat never passes): its key 8 characters of the codes' alphabet, an
  address and never a guest's code, made where no room has it (`newSideRoom`), its first snapshot written at once with
  its guest code off. Refused with words: a hall that is not here ("No such hall.", a side room's key included), no name
  ("Name the room (for example Legal)."), a name another room of the hall has, its Main room's (the hall's) included, in
  any case ("Hall 2 has a room named Legal already."), and a 21st room beside a hall ("Hall 2 holds 20 rooms beside its
  Main room already: remove one to make another.", `lib/store.js` `SIDE_MAX`). One `room.create` row: "Legal in Hall 2
  (code off)". Asked again with the client id its page gave it, a create is answered with the room it made, never
  refused for the name that room now has (the newest 200 kept in memory, by who asked; `public/outbox.js` sends it again
  after a drop while it was out, as it does a pin); an id that is not one is refused ("That act's id could not be read.").
- **No two rooms of a hall share a name**, in any case, the Main room's (the hall's) included, held in one place
  (`roomNameRefused`) for a room made, a room renamed and the hall's own Set up (`hall:configure`, which refuses such a
  name in the same words and applies nothing else it was asked).
- **`room:update {code, name}`** renames a room, for the same people: a side room's name is said to its pages as one
  numbered change and written as `room.update` ("name → Media"); a hall's Main room renamed is the hall renamed, on its
  screens and the halls board too, written as `hall.update` as the hall's Set up writes it (`renameRoom`, which
  `hall:configure` now uses as well). The same name again is answered as done (`already`), with no row; a name another
  room of the hall has, an empty one and a room that is not here are refused with words; any setting but the name (and
  the client id every act from a page carries) is refused, never ignored: the codes and who may send in come with their
  units.
- `halls.manage`'s words on the Accounts page say it makes a hall's rooms too: "Create halls and their rooms, and set
  them up (names, Stagewatch link, holding image, codes)".
- **`room:settings {code}`** reads a room as those who set halls up see it: its key, name, hall, the hall's name, whether
  it is the Main room, and the hall's rooms by name and key, Main first. The admin page names the room it watches from
  it.
- The three register from `lib/handlers/rooms.js` through the one gate, the first verbs there: `room:create` and
  `room:update` take a token of the connection's writes, `room:settings` of its chatter, before anything a client names
  is looked up. The server's context gains `newSideRoom`, `renameRoom` and `roomNameRefused`; `newSideRoom` makes a room
  and `renameRoom` a room's op, so both are among the parts the takes module is never given (`lib/gate.js` `ROOM_SENDS`,
  which the module fence's (j) reads). For the busy line, `room:create` and
  `room:update` are a person's input and `room:settings` a page's read (`lib/busy.js`).
- **The admin page lists each hall's rooms under it** (`admin:listRooms` appends `side: [{key, name, users,
  messageCount, locked}]` to each hall's row, in the order they were made; a hall's row is as before), each with its own
  row, ⋯, right-click and Shift+F10 from the catalogue's `adminRoom`: Watch, Transcript, ✨ Minutes, Rename…, Clear
  messages… and Remove room… (a side room has no Roles & invites of its own yet, and no room is made in a room). A hall's
  row and the watched hall's header gain New room in this hall… and Rename…, each asked in place. A side room's row says
  its hall to a screen reader too ("Legal, a room of Hall 2"), which hears the list flat. Watched, a side room's
  header reads "Hall 2 › Legal" with its room key; removed, it leaves the list in place, the page and the hall it watches
  as they were. The transcript names a side room with its hall, by its key.
- **The admin's reads of a room it is not given are audited** (`room.read`, once each): a page entered (a join that names
  no last change it holds: never a resume, nor a page catching up on its own socket), "entered Legal (Hall 2) as the
  admin"; a watch begun ("watched …"; the room watched already writes none); a transcript ("transcript of …"); a
  person's view opened by the support view ("opened Gwen's view of …"); and the AI's minutes ("minutes of … asked of the
  AI", written as the messages are handed over, whatever the AI answers; the minutes now name a side room with its hall,
  "Legal (Hall 2)"). An admin account that is given the room reads it
  as a member and writes none; the laptop's token is given no room and always writes one. A hall's Main room writes none,
  as before. No row says what was read.
- **A room removed takes its keys out of the accounts** (`accounts.prune`): a side room out of every account's `rooms`, a
  hall out of every account's halls and On stage halls and each of its rooms out of their `rooms`, saved through the
  accounts' lane, with no page ended and no row per account; each removal's row counts the accounts it changed ("2
  accounts updated"). A room whose files another program held, which comes back at the next start (the store's `back`),
  is left in its accounts, so it comes back with its members. And a new hall or room is made under no key a room, an
  account or a node's link still names (`keyHeld`, `accounts.names`), so a code an account kept (a page's save of an
  account read before its hall closed, which the Accounts page's own check of a new hall code, a later unit, refuses) is
  never opened to it by a hall made later. 0.5.1 left a closed hall's code in its accounts' halls, so a hall made later
  under the same code (a chance in a billion) would have been open to them.
- **A hall removed writes each of its rooms' removal first**, one `room.remove` row each by its key ("Legal (Hall 2),
  with its hall, 1 account updated"), as a room removed alone does, then its own `hall.remove` row, which names its rooms
  by name and key after what went ("Hall 2 with 2 other rooms, files removed, 1 account updated: Legal · LGQ4MZP8, Media
  · MDR7VX2C"), as many as an audit row holds, the rest counted and none cut part way (`lib/audit.js`
  `wordsWithList`).
- **A node linked for a hall that has been closed proposes nothing** (`deskFor` answers no desk): "Patterns B was linked
  for a hall that has been closed: link it again for a hall, or for every hall (Admin → Show network) — not proposed.",
  and its row in Show network reads no desk. 0.5.1 sent its proposals to the default Stagewatch's show desk, another
  hall's show caller.
- A side room's key is no hall's: the screens' verbs, `nodes:link`, `hall:settings` and `hall:configure` refuse it in
  their own words, and the halls board, `/api/halls`, the show network's halls and the context never list it (tested).
- Tests: `test/halls.test.js`, end to end: who makes a room (a project manager and the admin; a tech of the hall and a
  code guest refused), its snapshot on disk at once with its code off, each refusal's words, a create asked again with
  its client id answered as the first (one room, one row) and the same id from another person or a malformed one not, 20
  beside a hall and the 21st refused with nothing written; a side room's key refused by seven hall verbs in their words
  and listed by none of four hall readers; the admin's nested list; `room:settings` and its refusals; `room.read` once
  per entry, watch, transcript, view and minutes (the AI stood in for, asked of "Legal (Hall A)"), none for a resume, a
  page catching up, the room watched already, a Main room, or an admin account given the room, one for the laptop's
  token after it is; renames (its page hearing `roomMeta`, `already`, a Main room's on its screen and the halls board)
  and their rows, and the hall's Set up refusing a room's name with nothing applied; the reset's row; a side room removed
  and then its hall, each pruning the accounts given them (written while stopped) and counted once in its row, the hall's
  room written first, every file of the hall gone; the closed hall's node refused and nothing reaching the default desk,
  nor once a hall is made after; a hall of 20 rooms removed, each room's row by its key and the hall's row naming 13 and
  counting 7 within 300 characters; and the next start loading every room left with nothing said not loaded. `test/uploads.test.js`: a held side room's
  account keeps it and it comes back with it; a held hall keeps its accounts' hall, its room (whose files went) pruned
  and counted; `hall.remove`'s words name its room and its room has its own row, on purpose. `test/accounts.test.js`:
  `prune` (each account once, by id) and `names`. `test/audit.test.js`: `wordsWithList` (whole names, the rest counted,
  a head that leaves no room). `test/units.test.js`: the store's `back`, `ROOM_SENDS` with `newSideRoom`, the contexts.
  `test/catalog.test.js`: `adminRoom`'s rows for a hall and a side room, listed and watched, their asks and words,
  `room:create` and `room:update` required. `test/menus.test.js`: each refused as a seat they are hidden from, a side
  room among the objects, nothing renamed or made. `test/inputs.test.js`: the three verbs' typed cases.
  `test/modules.test.js`: the any-room calls of the rooms module, the name rule and the admin's list with their reasons,
  the server's context's parts, (j) refusing a take that takes `newSideRoom` or `renameRoom`. The browser smoke: New room
  in this hall… asked in place, the room's row named with its hall and its doors in step, Rename… filled in and saved,
  the watched side room's header, Remove room… in place.
- The papers: `README.md`, `README.txt`, `docs/ACCOUNTS.md` (who sets rooms up; the audit list), `docs/DESIGN.md`,
  `docs/NODES.md`, `docs/ANALYSIS.md`, `SECURITY.md`, `CLAUDE.md`.
- Rolling back: 0.5.1 loads the halls and leaves the side rooms' files as they are (unit 4); their `room.*` rows read as
  any other row. A hall's accounts pruned stay pruned.

**Each room has its own guest code, switched on or off, and renewed** (the plan's Part 1, unit 7, its §1.2, §1.3, §1.5,
§2.2, §2.3, §2.7, §3.1, §3.3 and §7.1, with Part 5's code-first join page (§15.4) and its `code` and `adminRoom` rows,
Part 7's "no code On stage" (§0.1), Part 4's join page offering On stage only from an invite link (§5.9.2.1; the server's
own rule in an open hall is a later unit's), and owner questions 5 and 8, "Defaults" and "Right": the admin alone
switches codes, and codes are shown only by `mayKnowCode`; the tree's tests, end to end and pure. The Accounts page's
rooms and the pages' room switcher are the units that follow)
- **A room's guest code is its own.** A side room's is made with it, 6 characters no room holds (no room's key, live code
  or earlier code: `newGuestCode`), never its key; a hall's Main room's is its key until it is renewed, so a hall of 0.5.1
  keeps the code its guests know with nothing written. The store indexes every code (`byCode`, `byRetired`): a code is
  one room's, a duplicate is refused, and of two rooms on disk claiming one code (a file edited by hand) the first by key
  holds it and the other's admits nobody, said on the console by the room, never by the code. A new hall or room is
  made under no code either.
- **Switched on or off by the admin** (`room:update {code, codeOn, keepGuests}`; never from an On stage page, and refused
  to a project manager, "Not admin": owner question 5). A side room's code is off until switched on, so a new room is
  for the admin and the accounts given it; a Main room's is on until switched off. Off, nobody new joins with it: "Turn
  off" keeps the guest pages in (a guest whose Wi-Fi drops comes back within the grace, and a locked room's seats outlive
  a restart's first seconds); "Turn off and send them out" closes each guest page in the room ("This room is for
  signed-in accounts now.") and forgets the seats it held, saved ones included; accounts stay either way, and so does the
  laptop's token admin's own page, which is no guest page. Each switch is one meta op its pages hear (whether the code is
  on, never the code): sent out, the switch and the seats that go are that one op, each guest page taken out of the room
  before it is closed, so no close writes a seat of its own. A switch already made is answered `already`.
- **Renewed by the admin** (`room:update {code, newCode: true}`, New code…): a new code at once, written with the room's
  snapshot and never an op, so no op log, ring or resume holds it. The guests in stay; the code before it joins the
  room's earlier codes (the newest three, kept in its snapshot), which admit only a person already seated there and spend
  no lock (a hall of phones coming back on it behind one venue address is not locked out); the invite links made with it
  stop, since an invite is made with the room's code. A renewed hall's key is an address only. The new code outlives a
  restart: a renewal holds only once its snapshot is written (the snapshot is the one place a code is kept), and one the
  disk refuses is taken back whole and answered so ("No new code was made: it could not be saved. The code stays as it
  was."). A hall's snapshot gains `guestCode` and `retired` only once renewed; one never renewed is written as 0.5.1
  wrote it, byte for byte.
- **The lookup and the join by code.** `GET /api/rooms/:code` answers the room a live code opens, switched on: its name,
  whether its seats are locked, and appended its hall's name and whether it is the hall's Main room (`hallName`, `main`).
  A code switched off, an earlier code, a room's key and a code no room has are one answer, `{code, exists: false, name:
  '', locked: false}`, and each counts against the lookup's lock; a guest's join with any of them is "Room not found", the
  join's lock spent for all but an earlier code. A guest joins a side room by its code as a Member (backstage: messages
  and files, no stage) or an observer; On stage there is refused ("On stage seats are in the hall's Main room."), and the
  admin's seat move refuses it too, and its picker and Seat ▸ offer a side room's two seats alone; a side room says "Kim
  joined as a Member", and its pages (the header, People, a sender's seat) and the admin page's people rows call the seat
  Member, from the join's answer's `main`, appended (whether the room is its hall's Main room). A room's pages, seats and
  people are its key's, whatever code the page typed; the join's answer keeps the code it was sent. The laptop's token
  admin, which has no account and joins by a code as a guest does, is a member of every room: a code admits its own page
  whether it is on or off, live or earlier, a room's key does too, its misses spend no lock, and it holds no saved seat.
- **Invites per room.** `admin:invites` answers any room, its links made with its guest code: On stage and Backstage in a
  hall's Main room, a Member's in a side room, with whether the code admits now. The admin page's Roles & invites is on a
  side room too ("Member seats need an invite link"), and says when the code is off that the links admit nobody new.
- **Who is told a code** (`mayKnowCode`): the admin; those who set halls up (they hand codes out); an account whose own
  rights in that room already hold what the code gives a guest (a Tech in its halls; a Staff account in a side room it is
  given); a guest, the code it typed while it is still the room's. Never a page seated On stage (a Board tablet is handed
  no code), a Viewer, or a Staff account in a hall's Main room: **Staff and Viewers are no longer shown a hall's code**,
  as they were in 0.5.1 (owner question 8). It decides the join's answer (`guestCode`, `codeOn`, and `setsCode`: the
  admin, on a page that names the room by its key), each page's `guestCode` event as the code is switched or renewed,
  `/api/halls`' and the halls board's `guestCode` and `codeOn` per watcher, and a room's settings. The admin's room list
  carries each room's `guestCode`, `codeOn`, its guest pages now (`guests`) and, for a hall, whether its code is still its
  key (`codeIsKey`). A code is in no audit row, no console line and no frame to a page that may not know it, but for the
  residual that follows. The admin's support view is told what the person's own page is told (none to a Staff account's
  view, a Tech's the code, a guest's the code it typed), and never `setsCode`: it draws the person's doors, and acts on
  nothing.
- **The residual, said:** until New code a hall's code is its key, so wherever its key appears its code does: its pages'
  address, the halls board's and `/api/halls`' rows and links (`code`, which every account that sees the hall reads,
  Staff and Viewers included), and the audit rows that name the hall by its key (`room.code`, `hall.*`), as in 0.5.1. The
  admin page says so beside the watched hall's code and marks each such hall in its list ("code is its address"; "This
  hall's code is also its address: anyone with an account in it can read it. Choose New code to separate them."). Halls
  made now start the same way; a side room never has it.
- **The pages.** The hall page's code chip shows the code the server tells it (no longer the page's address), "(off)"
  while it admits nobody new, and nothing where the page may not know it; an observer guest now sees the code it typed;
  the page's title names the room. On the admin's own hall page it adds Turn the code off… (the three-way ask: Turn off,
  Turn off and send them out, Keep it on) or Turn the code on, and New code… (`code.toggle`, `code.new`). The admin page's
  room ⋯ gains the same two (`adminRoom.codeToggle`, `adminRoom.newCode`), its rows and the watched room's header show the
  code ("· code K3TW9A off" on a side room), and a hall's row its guest code. The halls board's chip and Copy guest code
  follow the server's `guestCode`, live. An ask with more than one way to say yes hands its runner the one chosen
  (`choice`), and the hall page asks first only where a row's ask is made for that object, as the other pages do (Turn
  the code on asks nothing). `halls.manage`'s words read "Create halls and their rooms, set them up (names, Stagewatch link, holding
  image) and hand out their guest codes".
- **The join page asks for the code first.** Once six characters are still for half a second, or on Enter, or on leaving
  the field, the code is looked up, once for each value (a corrected sixth character once more), and the page names the
  room ("Legal · Hall 2") and offers its seats only: Backstage and Observer in a hall's Main room, On stage only from an
  On stage invite link (with "On stage seats come with an invite link from the backstage team."), Member and Observer in
  a side room. No seat is chosen on a first visit; the remembered one and an invite's are, and a remembered On stage seat
  without the link falls back to Observer. A wrong code is said at the field ("No hall or room has that code. Check it
  with whoever gave it to you."). The field is `autocomplete=off`, `enterkeyhint=go`, monospace at 16 px.
- `help:respond` from a hall page reads the code the page joined with as its own room, so a guest whose code was renewed
  still marks its own request sorted.
- Tests: `test/codes.test.js` (new), end to end: a side room's code off at birth and refused word for word as a wrong
  code and a key are; the code acts' refusals by type and right ("Not admin" to a project manager); switched on, the
  lookup's answer, On stage refused, a Member's seat and its line, the admin's seat move refused; Turn off keeping two
  guest pages, a newcomer refused, a dropped guest back within the grace and not in another seat; Turn off and send them
  out (each told, closed, no seat to come back to, the account's page staying) and the meta ops a resume reads; one row
  each, none with the code. New code on a locked hall: the guest in stays and is told no code, the key a wrong code now,
  the old invites seating an observer with the new code and nobody with the old, the seat holder back on the old code,
  a dozen earlier-code joins spending no lock, and after a restart the snapshot's `guestCode` and `retired` and the new
  code admitting. A code switched off counting against the lookup's lock (twelve misses) and the join's (ten), as a wrong
  one does. Who is told a code: the join's answer for a Tech, Staff, a Viewer, On stage, an observer guest and a side
  room's guest; the board and `/api/halls` for five accounts; New code told to each page as it may know it; no op, resume,
  audit row or frame to a page that may not know it carrying the new code. The laptop's token admin's own page in a
  locked side room: by its key, seated and told the code, not counted among the guest pages, staying through Turn off and
  send them out, back by the code and by the key while it is off, and a dozen misses spending no lock; that send-out with
  two seated guests and an observer one meta op, `{codeOff: true, seats: {}}`, and its repeat `already`; the side room's
  invites a Member's alone, made with its code, a Member seated by the link and an observer without. The support view of
  a Tech, a Staff account, a guest and nobody: the person's code or none, never `setsCode`, and New code told to each as
  the person's page hears it. `test/units.test.js`: the store's index, its refusals, renewals and their newest three, a
  load with two rooms claiming one code, a code that is its key or no code, and a removal; the snapshot fence with its two
  optional fields, a renewal written at once or, refused by the disk, taken back whole (the code before it still the
  room's, the hall not left dirty, one dirty before it still dirty); `ROOM_SENDS` with `sendGuestsOut` and
  `codeChanged`. `test/accounts.test.js`: `rbac.mayKnowCode`.
  `test/halls.test.js`: `room:settings` with the code, a project manager refused a code act (on purpose). The support
  view of the laptop's token still names a side room by its key. `test/catalog.test.js`: the hall page's facts from the
  server's `guestCode` and `setsCode`, the code chip's rows by seat (On stage, a Viewer and Staff none; the admin's four),
  `adminRoom`'s code rows and their asks, `hall.code` only where told, an ask's `choices`, Seat ▸ by the room's kind.
  `test/menus.test.js`: each code act refused to every seat it is hidden from ("Not admin", the On stage seat's too),
  nothing switched or renewed; the join's answer's last fields (`main`, `guestCode`, `codeOn`, `setsCode`, then `build`).
  `test/inputs.test.js`: `codeOn`, `newCode` and `keepGuests` null and by type. `test/modules.test.js`: the server's
  context's new parts, (j) refusing a take that takes `sendGuestsOut` or `codeChanged` or renews a code, and (l) each
  any-room call with its reason (the support view's person, the token admin's page by a key, a room's invites). The browser
  smoke: the join page's code first (the room named once still, its seats only, On stage only from an invite link,
  none chosen on a first visit, a wrong code at the field, one lookup per value) and a remembered On stage falling back to
  Observer; the admin's code chip (its four acts in step, the three-way ask, every page's chip "(off)" and back); a side
  room's New code… and Turn the code on on the admin page, and the hall's residual note and its row's mark; the admin
  page's rollback line; the phone pass's code chip (none On stage, the observer's its own).
- The papers: `README.md`, `README.txt`, `docs/ACCOUNTS.md` (each room's code; who is told it; the audit list),
  `SECURITY.md` (room keys and guest codes), `docs/DESIGN.md` (fail closed: a side room's code), `docs/ANALYSIS.md` (the
  code acts' ids, the fuzz's keys, the snapshot's optional fields, `ROOM_SENDS`), `CLAUDE.md`.
- Rolling back to 0.5.1 (do not, during a show): a hall's code switched off admits guests again under 0.5.1, and back on
  0.6 it is off again (`codeOff` stays in its settings); a hall's New code is lost, since 0.5.1's snapshot drops
  `guestCode`, so under 0.5.1 and after it the hall's key admits again and the new code does not (choose New code
  again). Side rooms and their codes are 0.6's alone. The admin page says so under its build line ("Do not go back to
  0.5.1 during a show."), with the other losses of going back: a hall's other rooms not opened, a file only one of them
  holds removable by a reset, the audit log read as broken.

**A side room follows its hall** (the plan's Part 1, unit 8, its §2.5 (as Part 7 §0.1 amends it), §3.3 and §8 (as Part 4
§5.12 amends it), §7.2's help, and owner question 7, "Defaults": AI drafts are available in rooms like Legal; the tree's
tests, end to end and pure. Where the earlier lines of this entry say a side room sends nothing to a Stagewatch and raises
no help request, this unit undoes it)
- **Every room of a hall follows its hall's Stagewatch.** Legal shows the hall's countdown, as it did, and now sends to
  it: the join's `canSendToStage` and `canPropose`, `stage:targets`, Send to the speaker's screen and a proposal to the
  show desk read the hall's link (`linkFor(room.hall)`), never the default Stagewatch, and the seat's rights decide as
  in a Main room: an account sends where it holds `stage.send` in the hall, a side room's guest (a Member) never, refused
  in today's words. The stage chip in a side room is a door to Speaker's screen… wherever the seat may send. A send or a
  proposal is written into the room it came from with the hall's link, and is followed there: the speaker's
  acknowledgement, a send lost when its Stagewatch restarted and the operator's decision reach Legal's records, and a
  restart follows again the sends and proposals of every room, not only the halls'. The recent events a hall's
  Stagewatch is told (a send, a proposal, a help request answered) are its own, from whichever of its rooms they came;
  a help request answered in a side room was told to the default Stagewatch before.
- **Help in a side room.** A seat that may post there asks for help as in a Main room, and its Help button says what
  happened. The request lives in its room: its pages hear it and its answers, and on the halls board it is shown whole to
  whoever may read the room (the admin, an account given it), and to the hall's crew who may not (whoever answers the
  Main room's help requests, never a Board member of that hall) with its category, who asked, its state and who is on the
  way, never its words, to answer from the board. Nobody else sees it (a Viewer of the hall, an account seated On stage
  there). Each request on the board names its room (`code`, its key; `roomName`, '' for Main) and its hall by name
  (`hallName`); the hall's key (`hall`), which is its Main room's address and its guest code until New code, only to a
  watcher who sees the hall: an account given a side room alone is told its hall's name, or "A hall with no name", never
  its key. Each says whether this watcher may open its room (`canOpen`) and answer it (`canRespond`, as `help:respond`
  answers); the strip reads "Hall 2 › Legal", a hall's row counts its rooms' requests, and Open its room is offered only
  where the watcher may open it. `help:respond` takes a request in any room by its key. The board's row for a hall still counts
  its Main room's requests in its own field (`help`), as before.
- **The show desk's notice reaches every room of every hall**: a Legal-only lawyer hears "Break in 5 minutes" too. It is
  still answered "shown in N meetings", N the halls with a room that took it, as Stagewatch counts meetings.
- **The AI in a side room** is told its hall's Stagewatch and nodes, as a Main room's is (it was told none), and one line
  more: "This chat is the hall's 'Legal' room, not its Main room: nobody on stage reads it." (`ai.draftReply` and
  `ai.suggestOptions` take `where`, `lib/ai.js` `whereLine`). A draft reads only its own room's messages.
- Tests: `test/halls.test.js`, end to end on a hall with its own Stagewatch beside a default one, and its Legal room: a
  Member guest of Legal sees the hall's countdown and destinations and is refused a send and a proposal; a Staff account
  given Legal is offered neither, nor is a Tech given Legal in no hall (a room given grants no `stage.send` in its hall),
  refused both with nothing reaching either Stagewatch; a Tech of the hall given Legal sends and proposes from it to the
  hall's Stagewatch alone, both written into Legal with the hall's link; a guest's help request in Legal heard whole on
  Legal's pages; the halls board of the admin and of a Legal-only account showing it whole and openable, the Legal-only
  account's board carrying no hall's key (no `hall`, nothing of the Main room's key or guest code anywhere in it), a
  project manager's without its words and not openable, a Viewer's and a Board member's not at all; the project manager
  answering it from the board and Legal hearing who is on the way, the Viewer and the Board member refused; the answer in
  the hall's Stagewatch's context and not the default's; neither the request nor an action prompt asked in Legal in the
  context posted to the hall's Stagewatch or in `GET /api/context` (the hall's help count its Main room's, none), where
  a Main room's prompt is; the guest marking the request sorted from Legal's page by the code it joined with; the AI asked
  in Legal (a draft and options) told the hall's Stagewatch, not the default, and the room's line, and asked in the Main
  room told neither the line nor Legal's thread; the desk's notice in the Main room and in Legal, answered "shown in 1
  meeting"; after a restart, the speaker's acknowledgement and the operator's decision reaching Legal's records; a hall
  with no name added at that restart, whose Media room's request reaches the Legal-only account as "A hall with no name"
  with no hall's key, and the admin with its key; and a second send from Legal lost when the hall's Stagewatch restarts
  (its seq goes back), Legal's page told at once and its record read "lost" while the first keeps "done". Unit 4's test
  of a side room's refusals is replaced, its power request and busy line kept as their own test. `test/units.test.js`: `whereLine`, its line, a room with no name, a name read by type and cut at 80, and no
  line for a Main room or anything that does not say it is a side room. `test/catalog.test.js`: a side room's help
  request, opened where it may be and answered alone where it may not, and Open its hall or Open its room by the room.
  `test/menus.test.js`: the board's help objects with `canOpen` and `room`. `test/modules.test.js`: (l), the eight new
  any-room reads with their reasons (a help request's room, the board's help, the followers of a send and a proposal,
  the restart's two loops and the notice). The browser smoke: a side room's help request on the admin's halls board, read
  "Side asks › Legal", counted on its hall's row, opened by Open its room (its link the room's key) and its doors in step,
  and gone with its hall.
- The papers: `README.md`, `README.txt`, `docs/ACCOUNTS.md` (help in a side room, and the stage from it),
  `docs/DESIGN.md` (fail closed: a side room no longer refuses the stage and help), `docs/NODES.md` (the notice in every
  room, counted by halls), `docs/ANALYSIS.md` ((l): 50 calls, and this unit's readers), `SECURITY.md` (who sees a side
  room's help request, and a hall's key only for who sees the hall), `CLAUDE.md`.

**Accounts are given side rooms, an On stage seat and a chat view** (the plan's Part 1, unit 9, its §2.1, §2.3, §2.7,
§3.2, §3.3, §6 (as Part 7 §0.1 replaces it: "How it is chosen" and "How it is changed" are unchanged), §7.2 and §7.3, with
Part 7's additions to unit 9, the seat limit for accounts (7-§0.1, §17.1), and owner questions 2 ("Defaults": a side room
is only for those it is given to, and for the admin) and B1 ("they don't need to answer other people's help requests");
the tree's tests. The Accounts page's tree, the admin page's Members… and Set up's rooms are unit 10's, below; the room
choice at sign-in and the switcher unit 11's)
- **Three fields of an account** (`lib/accounts.js`): `rooms`, the side rooms it is given; `board`, the halls in whose Main
  room it sits On stage; `view`, its chat view (`''` by its seat, `simple` or `full`). `POST /api/users` and `PATCH
  /api/users/:id` take them (`pick`), each list of keys stored upper case, once, 200 at most, compared as a set, so a Save
  that sends them back as they are is no change; an account made without them is stored as 0.5.1 stored one. The
  Accounts route's answer and `/api/auth/me` tell an account's three last (`Accounts.view`), and its rights' `rooms` and
  `board` (`rightsView`).
- **Read by type, and known.** Each of an account's lists (its halls too) is a list of keys: a value that is no name,
  `{"toString": 1}` for one, is refused with words ("An account's rooms are a list of their keys."), where 0.5.1 answered a
  500 for one in its halls; an unknown right that is no name is refused the same way ("Unknown right: one that is not a
  name"). An entry an account does not hold already must name a side room that is here ("No such room: LGQ4MZP8."; a
  hall's key, "… is a hall: its Main room comes with the hall.") or, for its On stage halls, a hall that is here ("No such
  hall: …"), so a key typed wrong is never kept to open a room made later; an entry already on the account passes. Its
  halls keep 0.5.1's rule, a hall's key taken as given. A chat view that is none of the three is refused in words.
- **Who gives which** (`rbac.mayChange`): nobody sets their own side rooms, On stage halls or chat view, in the words a
  role is refused in. An account that manages accounts and is not an admin gives only the side rooms it is given itself,
  read before every hall (`exceeds`), so a project manager of every hall gives none it is not given, and manages (edits,
  resets, signs out, removes) no account that holds one; it seats On stage only in a hall it reaches, as it gives halls.
  The Accounts route tells each viewer what it may give: `giveableRooms` (`{all, rooms}`: the admin every room, anyone
  else the rooms it is given), the side rooms by key with their names and their hall's (`rooms`; its hall's key only where
  the viewer reaches that hall, its name always) and, on each account's row, only those rooms, the rest a count
  (`otherRooms`), never a guest code; a viewer that does not reach every hall is told its On stage halls only where it
  reaches them, as its halls.
- **Audited in words**: `user.create` and `user.update` name an account's side rooms by their name, their hall's and
  their key ("rooms → Legal (Hall 2) LGQ4MZP8"), its On stage halls by key ("board → On stage in H7K2QA"), and its view
  ("view → simple", "view → by seat"); never a guest code.
- **A chat view changed alone is said live.** It is no right: the account's pages in a room are told the view each draws
  now (`view`: its own choice, else the simple view On stage and the full view elsewhere) and stay open; its halls board
  is told nothing and nobody else is. Any other change still ends every page the account has open, as before. No page
  draws the simple view yet (Part 7's unit 20a), so the event is the module fence's one allow-list row of an event no page
  hears, with its reason.
- **An account given a side room joins it**, seated by its rights there, and never its hall by that: the join already
  opened it (unit 5); nothing it is given carries its hall's key or its Main room's guest code. **`/api/halls`** gives each
  hall's row the seat the account joins its Main room with (`seat`: On stage where its On stage halls name the hall, the
  admin backstage wherever its account would only read, as the join seats it, `seatIn`) and the hall's side rooms it may
  enter (`rooms`: the admin every one, an account those it is given; each with its key, name, people, guest code where it
  may know it, whether the code admits, and its seat there), and lists apart (`rooms`) the side rooms it may enter in a
  hall it does not see, by that hall's name. **The halls board** does the same per watcher: `rooms` on each hall's row,
  chosen beside the row every watcher shares, and `yourRooms` apart. Nothing that lists halls lists a side room as one.
- **A stage send's link stays on the server.** A line sent to a hall's speaker's screen, and one asked of its show desk,
  keeps on its record the link it went to, which a hall's own Stagewatch names by the hall's key (`hall:<key>`: its Main
  room's address, and its guest code until New code). Every room of a hall sends there (unit 8), so a send from Legal
  handed that key to everyone reading Legal, a Legal-only account and Legal's guests included. A room's pages are now sent
  each record without it (`lib/ops.js` `forPage`, `opForPage`): live, in a join's history and in the changes a resuming
  page missed, and the page that asked the show desk in its answer (`unlinked`). The record keeps it, so a restart still
  follows each send only where it went; no page read it.
- **A Board account** (an account its On stage halls seat On stage) is held to the seat on that page, as a guest is: no
  upload token, the speaker's screen and the show desk neither offered nor taken, no screen, set-up or node driven ("Do
  that from a backstage page."), no guest code, nothing forwarded out of the hall ("Messages from On stage stay in this
  room."); it chats and sends 🔥 Priority. On its other pages (a side room it is given, a hall where it is crew) it is the
  crew its rights make it, and a file or a question it forwards from there never goes into the hall where it sits On stage.
  It answers none of that hall's help requests from any page, a side room's of that hall it would answer only as the
  hall's crew included: from its halls board each is refused in the On stage words, "Help requests are answered by the
  backstage team." (an account refused only for its On stage seat was told "Only people in that hall can answer its help
  requests."), and the board offers neither On my way nor Resolved on them (`canRespond` false); it answers those of a
  side room it is given and of the halls where it is crew, and marks its own request sorted.
- Tests: `test/accounts.test.js`: the escalation fence with side rooms (read before every hall; a room given only by one
  who holds it, the admin any; an account holding a room another may not manage; On stage halls read as halls), nobody
  setting their own three, a right that is no name refused in words, `giveableRooms`, `rightsView`'s last two;
  `Accounts.create` and `update` with the three (kept upper case once, read by type, a view none of the three not kept, an
  untouched editor's lists no change, by seat stored as none, saved through the lane); end to end, an account made and
  changed with the three by the admin and by a one-hall lead who manages accounts (given Legal by the admin before giving
  it; refused Hall B's On stage seat and a room it lacks; refused its own three in the self-change words), each list's
  shape and each unknown entry refused with its words and nothing made, the audit rows' words, what the Accounts route
  tells the admin and the lead (the rooms, `giveableRooms`, a row's rooms and `otherRooms`, no Media key or Hall B key in
  the lead's), the three kept across a restart, and a key no room has now passing an untouched Save while a new one is
  refused; a view changed alone told to the account's On stage and side-room pages as each draws it (full, then by seat:
  simple On stage, full in Legal) with none closed and its halls board and another account told nothing, the same view
  again no change, and a view with a change of halls ending every page; a Legal-only account seated in Legal and refused
  Hall A, with Hall A's key and its renewed code in nothing it is given (its join, `/api/halls`, its board and every frame
  its pages hear while Hall A and Legal are busy and Hall A is renamed, Hall A on a Stagewatch and show desk of its own
  with a line sent and one proposed from Legal and the speaker's acknowledgement, and Legal's history and missed changes
  when its page comes back, the records keeping the link) and Hall A's message and help request in none;
  `/api/halls`' and the board's rooms and seats per watcher (a tech of the hall given Legal, a Board account given a room
  of another hall, a Viewer, a project manager of every hall, the admin). `test/onstage.test.js`: a Tech given Hall 2's
  On stage seat and its Legal room, with Hall 2's Stagewatch and show desk linked, held to the seat on its On stage page
  (no upload token, no speaker's screen or show desk offered or taken, no screen or node, no code, nothing forwarded into
  Hall 3) and not in Legal (its screens, the show network and a node's command past the seat to the link's own check,
  the speaker's screen and the show desk), its 🔥 stored, a file
  from Hall 3 refused into Hall 2 and not offered there; an admin given the seat, with no upload token and no code and a
  file refused; its help: the On stage page
  refused another's request whatever code it names, its halls board refused Hall 2's Main room's (a Board guest's
  included) and a room of Hall 2 it is not given, in the On stage words, and answering Legal's and Hall 3's and its own
  Resolved, the board's `canRespond` saying the same. `test/menus.test.js`: a Board account among the hall page's seats,
  every act its rights hide refused in the On stage table's words, and on the halls board, a Board account's help item
  with no On my way or Resolved and the verb refused in those words. `test/catalog.test.js`: a Board account's page,
  either view, shown exactly what a Board guest's is on every object of the hall page. `test/halls.test.js`: a side room
  listed under its hall's row on the admin's board and nowhere else, never to every hall's account (moved on purpose: the
  test said no side room was on the board at all), and a Board member of Hall A refused Legal's request from her halls
  board in the On stage words (moved on purpose from "Only people in that hall…"). `test/modules.test.js`: (f)'s allow-list row for `view`, and (l)'s two
  new readers with their reasons. `test/units.test.js`: the op table sends a page a stage send's and a proposal's record,
  added and changed, without its link, which the hall, the ring and the log keep, and a resume and a history likewise.
  `test/resilience.test.js`: the 0.5.1 folder's stage send read back with its link from the record (the admin's watch),
  and its page's history and acknowledgement without it (moved on purpose: it read the link from a page's history).
- The papers: `README.md`, `README.txt`, `docs/ACCOUNTS.md` (an account's three fields, who gives them, what the routes
  tell, the Board account, a stage send's link), `SECURITY.md`, `docs/DESIGN.md` (sequence numbers and deltas; the server
  is the authority; fail closed), `docs/ANALYSIS.md`
  ((f)'s allow-list, (l): 52 calls, the escalation fence), `CLAUDE.md`, and the admin page's rollback line.
- Rolling back: 0.5.1 keeps an account's `rooms`, `board` and `view` through a load and a save, and ignores them: an
  account given a hall's On stage seat sits backstage there with every right it holds, and its side rooms do not open
  (0.5.1 loads none). Back on 0.6, each is read again. The admin page's rollback line and README.txt say so.

**The Accounts page, the admin page and a hall's Set up show halls with their rooms** (the plan's Part 1, unit 10, its
§7.2-§7.4, as Part 5 §0 amends them (§15.3's journeys, §15.4 page by page: the rights in three groups, a sticky footer,
Members… for `users.manage`), with §16.7's `adminRoom` and `hall` rows and §16.10's unit 10 rows (Members…, Set up); Part
7's Clock or countdown and On stage switches (20b, 20d), Part 4's On stage link (24) and Chat view on the admin page's
people rows (20a) land with their units; the tree's tests)
- **The Accounts page's editor** sets an account's halls and rooms in one tree, **Halls and rooms**: each hall this
  person may give, by name, its Main room ("Hall 2 — Main room and hall rights") with **On stage (Board member)** beside
  it and its side rooms set in under it, then the side rooms it holds of halls it does not reach, under their hall's
  name. A side room is ticked without its hall (Legal alone); ticking On stage ticks its hall, unticking the hall takes
  On stage with it, and unticking "Every hall's Main room, including new ones (not their other rooms)" (or a role of
  named halls) ticks the hall of each seat ticked (a person's tick moves another; nothing moves by itself). While the
  rights ticked hold no Send messages, a seat the account does not hold is not offered ("Reads only: On stage needs Send
  messages."); one it holds can still be taken away. **Chat view** (By seat, Simple, Full) sits beside the role. What
  this person may not give is shown and not offered, and one's own row stays all shown, nothing offered. A Save sends
  back the rooms, On stage halls and halls the account holds that the page does not list (gone since) as they are, so an
  untouched Save of all three is still "Saved — nothing changed." The **rights are in three groups**, In the room, Show
  and Run AGMessage (`rbac.CAP_GROUPS`, the Accounts route's `capGroups`, every right in one), and the dialog's
  **footer stays in sight** as the form scrolls (Cancel and Save are always reachable). A row reads where the account
  goes: "Hall 2 (Main, Legal) · On stage", "Every hall" first for an account of every hall, with each hall it has more
  in, and what this person is not told as a count ("1 other room").
- **An On stage seat given is one the account takes** (`rbac.unseatedOnStage`, read by the Accounts routes'
  `listsRefusal`): an On stage hall a change adds must be one the account, as changed, reaches and may post in, as the
  join seats it; otherwise it is refused in words ("Reads only in Hall 2: On stage needs Send messages.", "On stage in
  Hall 2 needs Hall 2 too: give its Main room with the seat."), from the Accounts page and from Board members… alike. One
  the account holds already passes, so an untouched Save stays no change though a change of role has left it reading
  only; a page is told an account's On stage halls as the seats it takes (`rightsView`'s `board`), so its row never says
  "On stage" of an account that would sit there as an observer. Board members… reads a seat as the server judges it,
  the account enabled (its role, grants and revokes, and its halls as stored, never its `rights`, which are none for a
  turned-off account), so a turned-off Tech of the hall is offered the seat and given no hall by its tick.
- **Members…** (the catalogue's `adminRoom.members`; on a hall's Main room, **Board members…**: who sits On stage there,
  in place of Members…, since who goes into the hall itself, with its rights, is chosen on the Accounts page, as §7.2 says),
  on the admin page's list and in a hall's Set up, for whoever manages accounts (`/api/admin/me`'s new `manageUsers` and
  `/api/halls`' `canManageUsers`: the Accounts routes' own check, so the laptop's token, which is no account, is not
  offered it): a checklist of the accounts, each ticked where it holds the room, one's own and those this person may not
  change shown and not offered with why ("Your own account: another admin changes it.", the route's `locked`), an account
  that only reads not offered an On stage seat ("Reads only: On stage needs Send messages."). Save sends one `PATCH
  /api/users/:id` per account whose tick changed, its own list with the room put in or taken out, each judged by the
  server alone, and says each: "2 saved · Kim: why". Something refused keeps the dialog open, read again as the server
  holds it. An account seated On stage in a hall it does not reach is given the hall too, said on its row before the
  Save ("A tick gives Hall 2 too."). No new verb: the saves are the Accounts page's routes (`public/members.js`).
- **A hall's Set up lists its rooms**: the Main room first, then each room beside it, each with its guest code where this
  account is told it, whether it admits guests, the guest pages in it, and its ⋯ from the catalogue's `adminRoom` rows,
  done at once (Save is for the name and the Stagewatch above it). **+ Add room** (the Main room's New room in this
  hall…) and a room's Rename… for those who set halls up; its code on or off (the guest-count ask) and New code… on
  every room, and Remove room… on a room beside the Main room, for the admin; Members… for whoever manages accounts. The
  hall's own name is Set up's form and the hall is closed on the admin page, so the Main room has no Rename… or Close
  there, and the admin page's own acts (Watch, Transcript, Minutes, Roles & invites, Clear messages…) are not drawn. "Its
  members are chosen on the Accounts page" is said there (or with Members…, for whoever manages accounts). The
  catalogue's `adminRoom` rows read the facts' `page`; the halls board's facts carry the admin (`isAdmin`) and who
  manages accounts. The list is read when Set up opens, after an act made there, and when a board frame shows the hall's
  code or the rooms of it this account may enter changed; a read refused or unanswered is said above the list ("The rooms
  could not be read: …"), and + Add room follows the facts and the hall, not a row that may be missing.
- **`room:settings`** lists each of the hall's rooms with its guest code as that page may be told it (the connection's
  new `codeTold`, the one rule every list reads), whether it admits guests and how many guest pages are in it (a count,
  never who), and tells the asked room's code by the same rule: a project manager whose account sits On stage in a hall
  is no longer told that hall's Main room's code there, as the halls board already did not tell it.
- **The halls board**: each hall's side rooms the account may enter are buttons on its row ("Legal 2 in"), real links
  into the room with the seat the server gives (a middle click opens a tab; the browser keeps its own menu on them until
  the rooms' own menu lands), drawn from the board's live row so a room made, renamed, given or taken away shows at
  once; the hall's name opens its Main room, and its ⋯ offers **Open Main** and **Rooms ▸** (`hall.rooms`, each room with
  how many are in). Side rooms given in halls the account does not see are under **Your rooms**, by their hall's name and
  never its key; an account with no hall of its own reads "No hall of your own: your rooms are below.", its words
  following Your rooms as each frame brings them. A link inside an object that is not its own (a room button) keeps the
  browser's menu at every door: Shift+F10 and the menu key on it, as right-click already did, open no menu of the hall's
  (`public/menus.js`, `AGM.menu.door`).
- **The admin page**: a person's Let them forward into ▸ lists every other room, grouped by hall ("Hall 2", "Hall 2 ›
  Legal"), a line between halls, the room watched left out, and reads a person watched in a side room from its hall's
  row. A side room's row in the list names it on a line of its own, its counts and code under it, as a hall's row does
  (its name ran into its counts).
- Tests: `test/members.test.js` (new, pure: the checklist's rows and their words, read from the route's roles and rows
  as the server makes them, a turned-off account and a revoke or grant of Send messages among them, each tick's change,
  the words of a save); `test/catalog.test.js`: the facts' `manageUsers` and `admin` (only on a true), `adminRoom` on both pages (an admin
  who manages accounts; Set up's rows for the admin, one who sets halls up, one who manages accounts and a crew; none of
  the admin page's own acts in Set up), `hall.rooms` and Open Main, Members…' labels and Rooms ▸'s submenu;
  `test/menus.test.js`: Set up's rooms among the halls board's objects, each act hidden from a Viewer, a Board account
  and a project manager who sets halls up (its code, New code…, Remove room… and Members…) refused with words, each
  seat's help requests its own board's, Members… sent as its own `PATCH`, and no account given a room or a seat; `test/accounts.test.js`:
  the three groups hold every right once in its order, the route's `capGroups`, `/api/admin/me`'s `manageUsers` per
  sign-in, `unseatedOnStage` (a Viewer, a hall not reached, the rights as changed, one held already) and `rightsView`'s
  seats, the route's two refusals and a seat kept through a change of role; `test/codes.test.js`: `room:settings`' rows
  and their codes as told, a project manager On stage in the hall told none of its code once it is renewed; `test/halls.test.js`: `room:settings`' answer with its rows (moved on purpose: each row now
  carries its code, its state and its guest pages); `test/modules.test.js`: `conn`'s parts with `codeTold` (moved on
  purpose); `test/pagefloor.test.js`: `members.js` defines only. The smoke: Set up's rooms (their doors, + Add room, Turn
  the code on) and the room button on the board, whose Shift+F10 and right-click open no menu of the hall's; the Accounts page's tree, Chat view, three groups and sticky footer, a
  room, an On stage seat and a view given and said on the row, the linked ticks and an untouched Save; Members… on a room
  and Board members… on a hall, a save with one refused, and the forward picker by room; Your rooms for an account given
  a side room alone, the hall's key nowhere on its page.
- The papers: `README.md`, `README.txt`, `docs/ACCOUNTS.md` (the three groups, the tree, Members…, Set up's rooms, who is
  told a code in a room's settings), `SECURITY.md`, `docs/ANALYSIS.md`, `CLAUDE.md`.

**The room choice at sign-in, and the room switcher** (the plan's Part 1, unit 11, its §3.2-§3.4 and §7.5's header, as
Part 5 §0 amends §3.4 (no presence line between rooms of one hall; the title moves on the tap) with §15.4's switcher row
and §16.7's `room` row; the dots on the switcher are unit 21's, and the header's one model at every width unit 31's)
- **One room goes straight in.** The halls page counts every room an account may enter (each hall's Main room, the side
  rooms on its rows, Your rooms): with exactly one, and nothing else to do there (it sets no halls up, manages no
  accounts, reads no audit log, is not the admin, and answers no help requests from the board alone: `answersOnBoard`,
  appended to `/api/halls`, true for a hall's crew with a side room of the hall it is not given, whose requests come to
  it on the board), it opens that room at once, in place of itself (`location.replace`, so Back does not come round to
  it again), and opens no socket on its way out. With more than one, the board is the question. The hall page's way back
  (All halls, its Back after being sent out or refused) is `/halls.html?stay=1`, which never goes straight in; only the
  page's first read does, never a later one.
- **Each way in is seated as the server seats it.** A hall's link carries the seat `/api/halls` says the account joins
  its Main room with (`seat`): a Board account's opens On stage (`role=board`) at once, where it opened backstage and
  loaded a second time; a Viewer's reads. A help request's Open its room, and a side room's button, carry theirs. The
  hall page's reload to the server's seat stays, as a safety net for an old link.
- **The join tells a page its hall**, appended at the end of its answer: `hall` (the hall's key, for one who sees the
  hall or is the admin, else `''`: an account given a side room alone, and a code guest, are never handed it, since it
  is the Main room's address and its guest code until New code), `hallName`, and `rooms`, the rooms of the hall this
  page may move between, as the join admits them (`[{key, name, main, seat}]`, the Main room first, each with the seat
  the account would take there): an account's page only; none for a code page (a guest's, and the laptop's token
  admin's own, which joins as a guest does) or the admin's support view. `main`, `guestCode` and `codeOn` were already
  there. The same facts reach each page in any room of the hall again when one of its rooms is made, renamed or
  removed, or the hall is renamed (`rooms:changed`, per page, through a new state frame, health's `latest.rooms`).
- **The header** names the room: "Hall 2 › Legal" in a side room, the hall's name in its Main room, in the page's title
  too ("AGMessage · Hall 2 › Legal"), following each rename. **The switcher**, a row of the header under it, shown with
  two rooms or more: "Main · Legal · Media", each a real link seated as the server will seat this person there (a
  middle click opens a tab), this room marked (filled, bold, `aria-current`), 44 px under a finger, scrolling sideways
  rather than wrapping. A tap moves the title and the mark at once, before the next room opens, and keeps what this
  person wrote in this room and has not sent (the composers' words, in the tab's `sessionStorage` by the room and the
  person, as the outbox keeps a held send, so another account signed in on the tab is never handed them; never a file),
  back in its composer when they come back to this room. A page shown again from the browser's cache draws its own room
  again, and lets go of what it kept of its words, which it still holds.
- **A room's menu** (the catalogue's `room`, the plan's §16.7 row): on a switcher's room, a room button on the halls
  board and a room under Your rooms, by right-click, Shift+F10 and the menu key: Open (not on the room the page is in),
  Open in a new tab, Copy link — then Copy guest code (where the page is told it: on the hall page, its own room's alone)
  and on the halls board Set up… (the hall's, for those who set halls up; none under Your rooms, a hall not seen). The
  room buttons kept the browser's menu until now. Mark as read is unit 21's.
- **A move between rooms of one hall writes no presence line in either room.** A join by a person who left another
  room of the hall within the grace (the page the switcher left) is not announced, and that leave is marked moved and
  said nowhere when its grace ends (`movedWithinHall`, a leave's `moved`); a page that joins another room of its hall on
  its own socket, as the same person (its identity and its name), moves too, while one that names another person there
  is two people, each said. Main → Legal → Main within the grace writes no line in either room. A page still open in
  another room is no move: a second device or tab in Legal is said there as it joins and as it leaves, so Legal's people
  are told who came in and went. A guest moves the same way, by the codes it holds. The grace stays 8 s
  (`AGM_LEAVE_GRACE_MS` sets it for a test).
- **A page its tab leaves closes its socket** (`public/reconnect.js`, every page that attaches its socket there: the hall
  page, the halls board, the admin page, a screen): the browser keeps a page it may show again (its back-forward cache)
  frozen with its connection open, so the server held the person seated in the room they had left, on its People list
  and its board's count, until the frozen page's pings went unanswered (some 18 s), and a move followed by leaving the
  hall then said "left" in both rooms. Now the server hears the page go as its tab leaves it (`pagehide`), and the page
  connects again and joins as after a drop when its tab shows it again (`pageshow` from that cache, or shown however it
  comes back). A page the server sent away, one that closed its own socket and one waiting out a refusal hold no
  connection to close, and are left as they are.
- Tests: `test/halls.test.js` (new): `/api/halls`' `answersOnBoard` (a hall's crew with a side room it is not given;
  not one given every side room, one that sees no hall, a Board member or the admin) at the answer's end; the join's
  `hall`, `hallName` and `rooms` for a crew account of the hall given Legal, an account given Legal alone (no key
  anywhere in its answer), a Board account (On stage in the Main room, backstage in Legal), the admin (every room) and a
  code guest (none); Main → Legal → Main and a move on one socket, each page opened once the server has heard the last
  one go, no line in either room, then leaving the hall said in Legal alone; a second page in Legal while the Main
  room's is open, said in Legal as it joins and as it leaves; a guest's socket that joins Legal as another person,
  Mallory said to join and Alice to leave; each page told its hall's rooms again on a room made, renamed and removed
  and the hall renamed, Lou's frames never naming the hall's key. `test/reconnect.test.js`: a page its tab leaves closes
  its socket once and connects again when shown again (from the cache, or by visibility, once), says it is down as after
  a drop until it is back, and leaves a socket the server sent away, one its page closed and one waiting out a refusal
  alone; the page's own instance hears `pagehide` and `pageshow` (persisted only). `test/catalog.test.js`: the `room`
  kind, its matrix on the halls board and the hall page (no Open on the room the page is in, no Set up on the hall page
  or under Your rooms, nothing in the simple view), its menu's two groups, no bar of its own, Enter, the support view
  and offline. `test/menus.test.js`: a room button's Set up… refused for a Viewer and a Board account; the join's keys
  appended in the order they landed (moved on purpose). `test/server.test.js` and `test/resilience.test.js`: health's
  `latest` and the state frames gain `rooms` (moved on purpose). `test/modules.test.js`: (l)'s four readers with their
  reasons. The smoke: a Viewer with one hall taken straight into it, observing, its way back `?stay=1`; Lou, given
  Press alone, straight into "Smoke AGM › Press" with no switcher and the hall's key nowhere, All halls staying on the
  board, Press there with nobody in within 6 s of Lou's page leaving, and Your rooms' menu; Kim, a Board account with
  two rooms, kept on the board with both, her hall opened On stage without a second load, the switcher Main · Press,
  its rooms' doors, a tap that moves the title and the mark before the page goes, Main's People losing her within 4 s
  of the tap and no line said in Main or Press, her unsent words back after Press → Main and still no line in Main;
  Sid, a Staff account with one hall whose crew answers Press's help from the board, staying on the halls page; the
  admin's room button opening the room's own menu (moved on purpose: it kept the browser's).
- The papers: `README.md`, `README.txt`, `app/README.md`, `docs/ACCOUNTS.md`, `docs/DESIGN.md`, `SECURITY.md`,
  `docs/ANALYSIS.md`, `CLAUDE.md`.

**Which rooms may send into a room** (the plan's Part 1, unit 12, its §4.1, with §1.6 (a room removed), §1.7 and §1.8 (a
0.5.1 folder has none; 0.5.1 keeps it unread), §1.10 (the store and its bound), §2.7's `room.sendFrom` row and §7.2 and
§7.4's pickers, as Part 5 §14.2 (`setRoomSends` in the server's context) and §16.7's `adminRoom` row (May send in…) and
§16.10's unit 12 row place them; the owner's answer 5: the admin's alone. The sends themselves, `room:send` and its copy,
are unit 14's: until it lands a list is kept and shown, and nothing is sent between rooms)
- **A list per room**: the rooms, of any hall, whose people may send messages and files into it, kept in `settings.json`
  by room key, never by guest code (`roomSends: {<room>: [<room>, …]}`). A room with no list takes nothing in from
  another (fail closed); the field is written only once the admin sets a list, and goes again with the last one, so a
  folder where none was set has none. Through the server's one writer (`setRoomSends`) and one reader (`sendersOf`), in
  the rooms module's context; the takes module's context holds the reader alone (`setRoomSends` joins `ROOM_SENDS`).
- **`room:update {code, sendFrom, sendBack}`**, the admin's alone and never from an On stage page, as the code is: each
  key a room that is here, in any hall, and not the room itself (an unknown one refused in words, "No such room: ….
  Nothing was saved.", never dropped), read by type (a list of strings, or it is refused in words), each once in any
  case, at most 50 (a longer list is refused, never cut). `sendBack` ("↔ and send back") names every room this room
  sends into, each a room here and not itself: given, this room is put on the list of each room it names and taken off
  the list of every other room that names it now, each held to 50 too ("Media (Hall 2) has 50 already: this room cannot
  send back into it."); a room it does not send into yet is added only beside a room the list names ("tick that room
  too"), while one it sends into already may stay or go either way; not given, no other list changes. A room on the
  list that is not open now (one whose files another program held, which comes back at the next start) keeps its place
  through a save, which no picker could show, and counts toward the 50 ("this list names 49, and with the 2 not open now
  that keep their places on it, 51"). The lists a change touches are saved together, and written in one `room.sendFrom`
  row on the room's key, each room by its name and its hall's, never a key ("may send here: Main (Hall 2), Media (Hall 2);
  it sends back into: Media (Hall 2)"; "it no longer sends into: …"; "2 rooms not open now"); a change that changes
  nothing (the same rooms in another order) is answered `already` with no row, and a whole change is refused when the
  settings could not be read (never saved over). The answer says the rooms on the list that are here and every room this
  one sends into, by key, and for a change which it was let send into and which it no longer sends into (`into`,
  `notInto`). A room's other settings' refusals name the list too ("A
  room's name, its guest code and the rooms that may send into it are the settings changed here."; "One change at a
  time: the name, the code on or off, a new code, or the rooms that may send in."), and what comes with one change is
  refused beside any other, never ignored: `sendBack` beside anything but `sendFrom`, and `keepGuests` beside anything
  but `codeOn` (a New code asked with it was made, `keepGuests` unread).
- **Who is told the lists**: those who read a room's settings (`room:settings`, the admin and `halls.manage`). Each of
  the hall's rooms carries its list (`sendFrom`: each room by key, name, whether it is a Main room and its hall's name),
  and the asked room its list and every room of any hall it sends into (`sendBack`: those whose list names it, whether or
  not they may send into it), appended; the admin, who alone
  sets them, is told every hall's rooms by name (`everyHall`), the rooms a list may name. No page in a room is ever sent a
  list, nor a key of another hall's room on one.
- **A room removed leaves every list**, as the room listed and as a room on a list; a hall closed, with each of its rooms
  (`forgetRoomSends`, one save, no row of its own: the room's `room.remove` and the hall's `hall.remove` say what went).
  A room whose files another program held, which comes back at the next start, keeps its places; and no new hall or room
  is made under a key a list still names (`keyHeld`), so a room made later never inherits a place on a list.
- **May send in…** (the catalogue's `adminRoom.sendFrom`, ↘, between Members… and the code), on a room's ⋯, right-click
  and Shift+F10 on the admin page's list and in a hall's Set up, a hall's Main room as any other, for the admin: a
  dialog of every hall's rooms by hall, the room itself listed and not offered ("This room"), each ticked where it may
  send in now, and beside each its **↔ and send back**, ticked where this room sends into that one now, whether or not
  that one may send here: what the dialog draws, both ways, is what is kept, and a save takes away no ↔ it did not draw
  unticked. A ↔ is offered beside a tick, and stays offered, as it is, beside a room this room sends into now (a tick
  taken away leaves it, to keep or take away; a ↔ ticked beside a tick then taken away, where this room did not send,
  goes with the tick). Save sends one `room:update` with every room ticked and every ↔ ticked, read afresh as the dialog
  opens; nothing changed sends nothing ("Nothing changed."); the server's answer is said, each room this one now sends
  into or no longer does by name ("Saved: 2 rooms may send into Hall 2 › Legal. It now sends into Hall 3. It no longer
  sends into Hall 2 › Media."), its refusal in the dialog, which stays open. Set up says under each room which
  rooms may send into it ("May send in: Legal · Hall 2, Main · Hall 3", the first three, the rest counted), read again
  after a save (`public/sendfrom.js`, `AGM.sendFrom`: its rows, the change a Save sends and its words pure).
- Tests: `test/sends.test.js` (new): the admin's alone (one who sets halls up and a member refused, the member told
  nothing of the room's settings); each refusal by type and its words, with nothing saved, switched or renewed (a
  `sendBack` beside a code switched, a `keepGuests` beside a list or a New code among them); an unknown key, the room
  itself (in either list), 51 rooms, a ↔ added beside no tick; a list set once per key in any case, saved as set and told
  by name; the same rooms in another order `already`, with no row; ↔ given, taken away and given again, each list as
  saved after each; a Main room's list; the picker's own saves against the server (a room that may not send in, which
  this one sends into, drawn unticked with its ↔ ticked; ticked with the ↔ as drawn, its list still names this room;
  unticked again, the ↔ left, still kept and drawn so on reopening; the ↔ taken away, this room off its list and said by
  name); the rows, never a key in their words; one who sets halls up told the lists and not every hall's
  rooms; every frame and answer to a page in Legal and to a guest in another hall's Main room (and Legal's account's
  halls board and `/api/halls`) holding no list and no key of a room of another hall on one; the lists kept across a
  restart; a ↔ into a room whose own list holds 50 refused whole; a room removed, and then a hall with its rooms, taken off
  every list until none is left and the field is gone; a room whose files another program held, removed: its places on
  both lists kept, untold, through a save of the other list from its picker, counted toward the 50, and back on both at
  the next start; and the picker's pure half (its rows, a ↔ drawn ticked beside a room not ticked, this room not
  offered, the change a Save sends, a ↔ that would add a room beside no tick never sent, its words naming each room by
  name, none without every hall's rooms).
  `test/inputs.test.js`: `sendFrom` and `sendBack` in the shapes, and the list by type (refused in its words, no row, no
  list set). `test/startrules.test.js`: a list refused with the settings unread, neither list set. `test/menus.test.js`:
  May send in… sent as each seat it is hidden from, refused in words, and no room's list set. `test/catalog.test.js`: the
  admin page's and Set up's matrices with May send in…, its offline reason, and its label's "…". `test/units.test.js`:
  the contexts with `sendersOf` and `setRoomSends`, the takes context without the writer (moved on purpose).
  `test/modules.test.js`: `ctx`'s parts and (l)'s rooms-module reasons (moved on purpose). `test/halls.test.js` and
  `test/codes.test.js`: `room:settings`' answer and `room:update`'s refusals (moved on purpose: the lists, and words that
  name them). `test/pagefloor.test.js`: `sendfrom.js` defines only. The smoke: May send in… in Set up (every hall's rooms,
  the room not offered, ↔ only beside a tick, a save said and each row's line; opened again, both ways drawn, and the
  room unticked keeping its ↔, offered) and on the admin page (both lists set in one save, read back), and a room removed
  leaving the list of the room it could send into.
- The papers: `README.md`, `README.txt`, `docs/ACCOUNTS.md`, `SECURITY.md`, `docs/ANALYSIS.md`, `CLAUDE.md`.

**A file message is posted only in the room it was uploaded for** (the plan's Part 1, unit 13, its §4.3's provenance and
§9's row 13; the file's name and kind read from the upload's record, which Part 4 §0 adds to it, are the stage
addendum's unit 26's; the tree as the evidence: in 0.5.1 a file message took any upload's link that was on the laptop,
so a person who held another hall's link could post that hall's file in their own)
- **Each upload is kept with where it was made for**: the room its page's upload token was issued for, by key, and the
  person it was issued to (`freshUploads`: `{at, room, uid}`, for the upload's hour, in memory only; the token was
  already issued per page's join and checked at use).
- **A file message names an upload made for its room by the person who posts it, or one a message of that room holds
  already** (`buildMessage`'s provenance, `fileRefusal`): the uploader posts it, and once it is posted anyone who may
  share files there may post it again. Anything else is refused and nothing is posted: an upload made for another room,
  or a file another room holds, "That file belongs to another room — send it from there."; another person's upload not
  yet posted, "Only the person who uploaded that file can post it."; a file no room holds and only a screen or a hall's
  holding image shows (its message deleted, its record past), "That file is on a screen, not in a room: choose the file
  again."; an upload this run holds no record of (one made before a restart and not yet posted), "That upload has
  expired: choose the file again."; the last two with `reupload`, so the page that still holds the file uploads it again
  for its room and sends it under the same client id by itself, as it does for a file the laptop no longer has (a page
  reloaded since says "Not sent — choose the file again"). A file reaches another room only by a forward, between rooms
  the person is in and by the forward's own rules (and, from unit 14, by Send into a room, audited). Reading a file is
  unchanged: its link is the capability, for whoever holds it.
- **`buildMessage` returns a message or null, never a refusal**: it builds nothing of a file its provenance refuses,
  whoever calls it, and a caller that answers with the reason asks `fileRefusal` first, as the message handler does. A
  refusal handed back in a message's place could be spread into a message of a caller's own (unit 14's copy into
  another room takes `{…msg, id}`), which the op table would take, since an added message needs only its id.
- Not in this unit, by the build order: the file's name taken from the upload's record instead of the page's (Part 4's
  unit 26); a screen's take and a hall's holding image held to the hall's own files (`sourceOk`, Part 4's unit 25):
  until then whoever may drive a hall's screens can show any upload's link there, as in 0.5.1; and the start's sweep of
  the uploads nothing uses (unit 25 too): an upload a run before a restart never posted, now never posted at all, stays
  in the uploads folder until then, as it did in 0.5.1, since the record that would have removed it within the hour is
  that run's alone.
- Tests: `test/uploads.test.js`: the reset test rewritten on purpose, hall B now holding hall A's file by Ana's forward
  (its link posted there directly refused, nothing posted), the reset and deletion rules unchanged; an upload made for
  hall A refused from the same person's page in hall B and from another person in hall A until it is posted, then taken
  again from that person, still refused in hall B, an upload made for hall B refused in hall A, and once forwarded into
  hall B, hall A's file posted there directly, each hall's file messages read back by the admin's watch; an upload not
  yet posted when the server restarts refused with `reupload`, nothing posted, and the new upload posted under the same
  client id; after a restart, which holds no record of either upload, hall 1's posted file refused in hall 2 as another
  room's (no `reupload`: no upload again would make it hall 2's) and taken again in hall 1, and a picture only hall 1's
  holding image holds (its message deleted) refused with the screen's words and `reupload`, nothing refused posted.
- The papers: `README.md`, `README.txt`, `docs/ACCOUNTS.md`, `docs/DESIGN.md`, `SECURITY.md`, `CLAUDE.md`.

**A message or a file is sent into another room, with a copy kept here** (the plan's Part 1, unit 14, its §4.2 and §4.3,
§7.5's composer, ↗ menu and From / Sent to lines, §2.7's `room.send` row and §9's row 14, as Part 5 §0 (a client id on
each send, the references kept by the store, the verbs in the rooms module), §13.3.4, §13.6, §16.3 and §16.7 (one list of
rooms, the runner's choice of verb, Send back, To ▸) and Part 7 §0.1 and §11 (the owner's answer B2: nothing is sent out
of its room On stage) amend them; the tree as the evidence: in 0.5.1 a message reached another hall only by a forward,
into a hall the person sat in or was linked to, with no copy kept; the owner's ask, "It also needs file transfer between
rooms for users to download.")
- **A room's reference**: 'r' and 16 characters of a MAC of the room's key under the server's secret, made once per room
  as it is made or loaded and the same at every start (`store.roomRef`, read back by `store.byRef`, indexed with the
  codes and never written). It never passes the code shape, so no join or lookup takes one: it is how a page names a room
  it may send into, or that sent to it, never by its key or a code.
- **`room:sendTargets {}`** (the rooms module, behind the gate, one `chatter` token): the rooms whose list names this
  page's room, each by its reference, its name and its hall's name (a Main room by its hall's), no key, no code, no
  people, no numbers; none On stage, for a seat that may not post, or from the admin's support view. The join answer
  appends **`sends`**, whether there are any, at its end. When the admin's May send in… changes which rooms a room may
  send into, or a room it sends into or that room's hall is renamed, that room's pages are told to ask again
  (`sendsChanged`, which names nothing), through a state frame of its own (`frames.sends`, latest wins, 300 ms; health's
  `latest.sends`), and a page whose ask the rate held back asks once more a second later; a list taken back is read at
  the next send, so it stops at once.
- **`room:send`** (the rooms module): `{to, messageId}` sends a text or a file of this room, `{to, type: 'text' | 'file',
  text, url, filename, mime, caption, priority, replyTo}` a new one, each with the outbox's client id and wait. In order: a
  repeat of a send that went through (its client id, kept on this room's copy) is answered with what it did ("`{ok, id,
  seq, to}`", or `gone` once the copy was deleted) and writes nothing into the other room, and a client id a message of
  another kind holds here names no send ("That message's id is another message's."); On stage, nothing is sent, in
  either form, Send back included ("Messages from On stage stay in this room."); then the writes bucket, then posting here
  ("Observers can read but not post."); one form or the other ("Send a message of this room (messageId) or a new one
  (type), one of them."); a question or a help request is not sent ("Only a message or a file is sent into another
  room."; "A help request belongs to its room — ask in the other room instead."); a file needs `hall.files` here ("Your
  account may not share files here.") and, new, an upload made for this room by the sender, as a file message is read
  (unit 13's words, `reupload` included); a reference to no room, a removed room's or this room's own is "That room is
  gone.", and a room whose list does not name this one "This room may not send there — ask an admin." The rights here
  decide, as the plan has it: the list is the admin saying that whoever may post here may post there, so a Board
  account's file sent from Legal, where it is a Member, goes into the Main room where it sits On stage.
- **What each room holds**: the message goes into the other room first, from the sender, marked `sentFrom` (this room's
  name, its hall's name and its reference, and who wrote it when the sender sent on someone else's message,
  `originalAuthor`), without the client id; then this room's copy, marked `sentTo` (the other room's names and reference,
  and its message's id), with the client id and the wait. A copy is there only for a message that reached the other
  room, and nothing else of the other room (its people, its replies, its seen receipts, its numbers) comes back. A reply
  sent across answers, in the room it reaches, that room's own message: its copy of the question, or the question there.
  A file keeps its link, which the other room's people open as any file's; it outlives a reset of the room it came from
  while the other holds it. One `room.send` row on the other room's key, written once the message is in the other room
  and before the copy, so nothing crosses rooms without one, the rooms by name:
  "a message (212 characters) from Legal (Hall 2) to Main (Hall 2)", "a file (pdf, 2.1 MB) from …"; never the words, a
  file's name or its link. The message handler and the send read a new message alike (`messageOf`: the upload on disk,
  its provenance, then `buildMessage`), and an upload's presence and size are one `fs.statSync` (`uploadOnDisk`), so the
  server's synchronous calls stay at 15.
- **The hall page**: the composer's **To:** (`compose.sendTo`, `room:send`, mode `hold`; shown on the message and file
  composers where the join's `sends` is, in the full view): This room, then each room this room may send into ("Hall 2 ›
  Legal"). Set to a room, Send reads "Send to Legal" (its word and its name), the composer takes the edge of a room
  crossed (`--c-other-room`) and the line "↗ to Legal — replies stay there" stays above the field at every width, Send
  then the 44 px mark on a phone; the send goes by `room:send`, its echo says "↗ to Legal: …", and To: is back on This
  room. A message's **↗ Send to ▸** (`msg.send`, verb `forward`, F) is one list: first each room a list lets this room send
  into (by `room:send`, a copy kept), then each room the person may forward into, its second line "a forward — no
  withdraw" (a menu item's `note`); a room that is both is listed once, as the first (`myRooms` answers each room's
  reference too). A question is only forwarded. A send said: "Sent to Hall 2 › Legal — a copy stays here." **↗ Send back
  to Hall 2 › Legal** (`msg.sendBack`, `room:send`), on a message another room sent here while this room may send there:
  the composer set to that room for one send, replying to the message. A message from another room reads "↘ From Hall 2 ›
  Legal" (with "· originally by Kim" where it was someone else's), and this room's copy "↗ Sent to Hall 2 › Legal —
  delivered", each as words. A file that arrives from another room, sent or forwarded, never opens itself on the On
  stage panel: someone in the room opens or pins it.
- **Deleting**: the sender deletes the copy here as any message of theirs, which leaves the other room's message. A
  message another room sent is not its sender's to delete where it went, from a page they hold there too: `delete`
  refuses it ("A message sent from another room stays here: only the admin removes it.") and the hall page offers no
  Delete on it (`msg.delete` fits no message with `sentFrom`), so the copy's "delivered" stays true while that room
  holds it; the admin removes it there (`admin:deleteMessage`, its `message.remove` row).
- **Every reader**: the transcript says "↘ From Hall 2 › Legal" and "↗ Sent to … — a copy kept here", the admin page's
  feed "↘ From …" and "↗ Sent to … — delivered", and the AI's thread marks a message sent here from another room, and
  this room's copy of one sent there; the server's readers name a room by one helper (`lib/ops.js` `placeOf`), held to
  the pages' (`AGM.catalog.placeOf`) by a test.
- Not in this unit, by the build order: Withdraw (unit 15), so a send cannot be taken back yet and the copy's line says
  "delivered" alone; a file moved only by a seat that may download it (Part 4's unit 26, `mayDownload`; until then a file
  moves from a seat that shares files here); the confidential mark's confirm before a file crosses (Part 4's unit 31);
  the unread dot on the switcher (unit 21).
- Tests: `test/sends.test.js`: no list, no room to send to and the join says so; a list set, the room's pages told to ask
  again and the other room's not; the targets by reference and names; a message into another room and its copy, each
  field read back (the sender, the marks, the client id on the copy alone, the wait on both), heard live by both rooms; a
  repeat answered as the first and nothing new; one of the room's own messages and a new file sent; the file served and
  outliving the room's reset; each refusal in its words with nothing written (an observer, a seat that shares no file, a
  question and a help request by either form, a message not found, both forms and neither, a forged reference, the room's
  own, a key given as a reference, a client id that cannot be read, a room whose list does not name this one); across
  halls, then the list taken back mid-show and the next send refused at once; a room removed, its reference naming
  nothing; another room's upload refused by its link; Send back threading under the question in both rooms; the writes
  bucket; the rows, no words, no name, no link; every frame each page heard holding no key or code of a room it is not
  in; after a restart, the same references; a client id a plain message holds refused, nothing sent; a room it sends
  into renamed, then that room's hall, each time the room's pages told to ask again and told the new names. And On stage
  (B2): a Board guest and a Board account on its On stage page told no room and `sends` false, refused `room:send` in
  both forms, a file, a text and Send back, nothing written; the Board guest's own message's client id refused, never
  answered as a send; the same account's file sent from its Legal page into the hall where it sits On stage; its On
  stage page refused deleting what its Legal page sent there, the hall still holding it, the copy in Legal deleted by
  it, and the message removed by the admin. `test/units.test.js`: the store's
  references (made once per room, found Main or side, at every start, none of a removed room, never a code, never
  written; none without `refOf`), and the AI's thread marks. `test/halls.test.js`: `myRooms` answers each room's
  reference too (moved on purpose). `test/busy.test.js`'s fence holds `room:send` as input (a send makes the copy busy, as
  a message does) and `room:sendTargets` as a read (`lib/busy.js`). `test/inputs.test.js`: `to` and `replyTo` in the shapes, and
  `room:send` and `room:sendTargets` by type, each refused in its words with no row. `test/catalog.test.js`: the facts'
  `sends` and `targets`, a seat that sends by a list (Send to ▸, Send back, To ▸ with its values and Send's label), the On
  stage set without Send back, ↗ as one act, no Delete on what the seat itself sent here from another room, and the
  pages' room naming held to the server's. `test/menus.test.js`: `room:send` refused as each seat it is hidden from, On
  stage in the table's words, and the join's `sends` at its end (moved on purpose). `test/modules.test.js`: the
  connection's `onStage` and the server context's parts, and two any-room reasons more (moved on purpose).
  `test/resilience.test.js` and `test/server.test.js`: the state frames and health's `latest` hold `sends` (moved on
  purpose). The smoke: To:
  ▸ a room, Send's name and word, the line above the field at 390 px, the message landing "↘ From" there and the copy
  "↗ Sent to … — delivered" here, To: back on This room; Send to ▸ as one list with the room once, first, and each forward
  said; a PDF sent there not opening itself on its panel; Send back setting the other room's composer and its answer
  landing under the question; the composer's menu with To ▸ (moved on purpose).
- The papers: `README.md`, `README.txt`, `docs/ACCOUNTS.md`, `docs/ANALYSIS.md`, `docs/DESIGN.md`, `docs/NODES.md`,
  `SECURITY.md`, `CLAUDE.md`.

**A mis-sent message is withdrawn** (the plan's Part 1, unit 15, its §4.4, §2.7's `room.withdraw` row and §9's row 15, as
Part 5 §0 (`sentUpdate` a row of the op table; "⊘ Withdrawn from Legal after 40 s"; a repeat answered `already`),
§13.3.4, §13.6, §15.6 and §15.7 (⊘, the withdrawn mark), §16.3 to §16.7 (Withdraw in the danger group, asked in place,
`msg.withdraw`) and §9's row 15 of Part 5 amend them; the tree as the evidence: a send into another room could not be
taken back, and its copy said "delivered" for good)
- **`room:withdraw {messageId}`** (the rooms module, behind the gate): on this room's copy of a send. A repeat after a
  lost answer (a copy withdrawn already, asked by its sender or the admin's own page) is answered `{ok: true, already:
  true}` before the rate, so it is never refused for what succeeded; every other request takes one `writes` token before
  anything refuses it, so a refused lookup is never free (the gate's rule), and is then refused, in order: a message not
  here ("Message not found") or no copy of a send ("Only a message this room sent into another room is withdrawn."); the
  admin's support view ("This is someone else's view — act from your own page."); anyone but the copy's sender and the
  admin's own page ("Only its sender or the admin withdraws it."); a seat On stage, the admin's included ("Do that from a
  backstage page."); then the message must still be in the room it went to, the one that came from this room by its
  reference ("It is no longer in Hall 2 › Legal: there is nothing to withdraw." once that room is removed, or the admin
  removed the message there or cleared the room).
- **The room it went to**: the message goes; each reply there that quoted it (a reply's quote, the first 120 characters or
  a file's name, which the room's feed, a page joining it later and its transcript draw) keeps who wrote it and none of its
  words, its quote marked `withdrawn` and drawn "↩ Ana: ⊘ withdrawn", a change of an eighth row of the op table, `replyTo`
  → `replyUpdate`; and a line says who took it back ("Ana withdrew a message sent from Hall 2 › Legal", "… a file …"; the
  admin's "Ana Admin withdrew a message Lou sent from …"). Then one `room.withdraw` row on that room's key, the rooms by
  name and how long it was there ("a message sent from Legal (Hall 2), there 40 s"; the admin's "a message by Lou sent
  from …"), never the words or a file's name. What a withdrawal cannot take back: what people there read, a file someone
  downloaded, a copy someone there forwarded or sent on into another room, and a file's link while a room or a screen
  holds it.
- **The copy here** stays and keeps when (`sentTo.withdrawn`), a change of a seventh row of the op table, `sentTo` →
  `sentUpdate` (`lib/ops.js`, and the hall page's `UPD_EVENTS`): heard under the next number, and read by a page back
  from a drop among the changes it missed (`applyOp`), so no page of either room is left with a gap, and none joins again
  to catch up. It reads "⊘ Withdrawn from Hall 2 › Legal after 40 s" (how long, by the server's times: `lasted`, one helper
  in `lib/ops.js` and `AGM.catalog`, held equal by a test). Its file stays on the laptop while the copy holds it, and
  leaves when the copy is deleted and nothing else holds it.
- **The hall page**: 🔙 **Withdraw from Hall 2 › Legal…** (`msg.withdraw`, mode `now`, in the danger group before
  Delete…; ⊘ is the line's mark, so the act has an icon of its own), on a copy not withdrawn, for its sender and the
  admin's own page, never On stage; it asks first: "Withdraw from Hall 2 › Legal? It goes from Hall 2 › Legal's chat now;
  people there may have read it (it was there 40 s)." **[Withdraw] [Keep it]**, Keep it focused; done, "Withdrawn from
  Hall 2 › Legal." The join answer appends `admin`: whether the page is the admin's own (never the support view). The
  outbox answers a repeat of `room:withdraw` as it does a delete's. Delete… on a copy not withdrawn says the message stays
  where it went: withdraw first, since the copy is what takes it back. `delete`'s refusal of a message another room sent
  now names Withdraw: "A message sent from another room stays here: its sender withdraws it from that room, or the admin
  removes it."
- **Every reader**: the admin page's feed hears the change and redraws the copy's line; the transcript says "⊘ Withdrawn
  from … after … — a copy kept here", and of a reply in the room it went to "↩ replying to Ana: ⊘ withdrawn"; the AI's
  thread "[sent to … and withdrawn from there after …, a copy kept here]". `lib/busy.js` reads `room:withdraw` as a
  person's input.
- Choices where the plan left room: a seat On stage withdraws nothing, the admin seated there included (Part 7 §17.1: the
  checks that do not call `allowed()` refuse On stage in those words); a repeat is answered before the On stage refusal
  and the rate, as a send's repeat is, and only to one who may withdraw the copy; a reply's quote of the message in the
  room it went to is taken out with it (the plan's steps did not name the quotes; a withdrawal is for what that room
  should never have read), while `delete` within one room keeps its replies' quotes as before, the room having been the
  message's readers; the line in the room it went to names the room as its "↘ From" did, with the room's name now; a
  message the admin removed in the room it went to, or that room cleared or removed, leaves the copy reading "delivered",
  as unit 14 left it (Withdraw then says it is no longer there: marking the copy from the admin's removals is a change
  across rooms no section asks for, left to a later unit); the confirm reads the page's clock for "it was there 40 s", as
  "2 min ago" does elsewhere, and the line the server's.
- Tests: `test/sends.test.js`: refused, each in its words with nothing taken back, for another member of the room, an
  observer, the support view of the sender, a message of the room's own, none, the message where it went, and the admin
  account seated On stage; a burst of refusals (another member's, a message not here) meets the rate; taken back from a
  side room by a Main room's guest and from a Main room by a side room's account, each gone there with its line, the
  copy's mark heard live with its number; the two replies quoting it there (a reply, and the copy of a Send back) keep its
  author and no word of it, heard as `replyUpdate`, in neither the room's messages nor its transcript, while the answer
  that landed back keeps its own room's quote; a repeat answered `already`, nothing more taken, and answered so while the
  rate refuses the rest; the admin's withdrawal from its own page naming whose message it was; a file gone from the room
  it went to, still served while the copy holds it and removed once the copy is deleted; a message the admin removed there
  and a room removed, each said; the writes bucket; every change Legal's page and Hall A's page were sent heard in order,
  no number missed; a page back by resuming sent each mark among the ops it missed; the transcript's lines; one row each,
  no words; the join's `admin` for each page, the support view's false. `test/units.test.js`: the AI's thread on a
  withdrawn copy; the op table's eight rows sent in order, and its refusal planted with another field than `sentTo`, now
  the table's (moved on purpose).
  `test/catalog.test.js`: the facts' `admin` (true alone says so), Withdraw in the seat matrix (the sender, the admin; not
  another member, not withdrawn twice, never On stage, the admin's own page seated there included), its label and ask
  with the time, Delete…'s words on a copy, and `lasted` held to the server's. `test/menus.test.js`: `room:withdraw`
  refused as each seat it is hidden from, On stage in the table's words, and the join's `admin` at its end (moved on
  purpose). `test/inputs.test.js`: `room:withdraw` by type. `test/modules.test.js`: the op table's fields read from every
  handler file, `sentTo` and `replyTo` the rooms module's (moved on purpose). The smoke: Withdraw on the copy asks with the
  room and the time, the message gone there with its line and the quote of it there "↩ Ana: ⊘ withdrawn" with none of its
  words, the copy's "⊘ Withdrawn … after …" with no Withdraw left and no join again, the admin page watching the room
  redrawing the copy's line from "↗ Sent to … — delivered", a repeat `already`, and a page back by resuming drawing the
  mark through `applyOp`; the op table's listener count read from `lib/ops.js` (moved on purpose).
- The papers: `README.md`, `README.txt`, `docs/ACCOUNTS.md`, `docs/ANALYSIS.md`, `SECURITY.md`, `CLAUDE.md`.

**What people's pages are shown, as a store and a vocabulary** (the plan's Part 1, unit 16, its §1.10 and §5.1-§5.5, as
Part 4 §0 and §5.9.1 (`pages.json` in layers, its shape changed before anything writes it), Part 5 §0 (`brand` gone,
owner answer 31; the marks ◷ and ○), §14.4's fence (n) and §15.7's person-first words, and Part 7 §0.1 (`views`) amend
them; the plan as the evidence: 0.5.1 has no people's pages, and nothing of this is drawn on a page or sent yet: the
push, its console and the layer are units 17 and 18)
- **`lib/pages.js`**, a store of its own beside the screens': what a person's hall page is shown over its chat. A take
  is numbered with one counter per hall and goes to the Board (every page seated On stage in the hall's Main room) or to
  one person (`a:<account id>`, every device of an account; `u:<uid>`, a guest's device). A page is shown the
  highest-numbered take addressed to it, its person's or, on a Board page, the Board's; latest wins.
- **What may be shown** (`cleanPage`, pure, fail closed): back to chat, Stagewatch, the clock, holding or blank, each
  rebuilt as a fresh object, a key it does not know left behind. Anything else, `brand` (gone: one Holding page with the
  mark) and the web page (a later unit's) among them, is refused with the kinds in words, "Choose what to show: back to
  chat, Stagewatch, the clock, holding or blank.", and so is a kind that is not a string or that the take only inherits;
  a known key of the wrong type (a holding picture that is not a string among them) refuses the whole take in the same
  words, and so does a back to chat that names a layer (the store keeps the show layer alone, so a hand-back of one
  layer is never widened to every layer). Stagewatch only where the hall has one linked ("This hall has no Stagewatch
  linked — link one in Set up."); a holding slide with no picture, or a PNG, JPEG, GIF or WebP of AGMessage's uploads, a
  screen's holding rule type by type ("A holding image is a PNG, JPEG, GIF or WebP shared in AGMessage."), in a message
  of a room of the hall the pusher may read ("That picture is in no room of this hall you can read — share it there
  first."), the server's facts deciding, never the client's.
- **What a take is called** (`describePage`), the console's and the audit's words alike, none naming a file or carrying
  its address: "back to chat", "Stagewatch", "the clock", "a holding slide" ("… with the AGMessage mark" where neither
  the take nor the hall has a picture), "blank"; no take is "the chat".
- **The answers.** A person's Back to chat or Minimise is kept with the take it answered, for every page of theirs, and
  counts only on that take: a newer take shows again. Back to chat is final for its take (said again, it is answered as
  done; shown or minimised after it, refused). A Minimise is taken back only by the person's Show again: a page that
  says it drew the take (as it first draws it, or comes back into view) before it hears of the Minimise made on another
  device keeps it, so one device never undoes what the person did on another. A report on any take but the one that page
  is shown now is refused, and so is one of no person (a key that is not a person's, `__proto__` among them) or at no
  time, which keeps nothing; a page reports only what a take of its kind can be (a page handed back to its chat is in
  view or not, with nothing to fail, put away or minimise), and "opened" is a web page's alone, so no take here is ever
  read as opened.
- **A Board take puts away** the older takes, and the answers, in its layer, of everyone seated On stage then: none of
  them could show on a Board page again. A person's take puts away that person's answer to an older one.
- **The bounds**, the oldest going first: 200 person takes a hall, the first made first, each taking its answer with it;
  500 answers a hall, the one given longest ago first; and 5,000 guests' chat views, the one set longest ago first. Both
  are kept, and written, in the order given or set, and read back in the file's order, so neither reads the laptop's
  clock: a clock stepped back, in a run or across a restart, never makes the answer just given the one that goes.
- **Status, person first** (`Pages.status`, pure, from each page's report on the take it holds, never from the send),
  one mark one meaning: ✓ "On all 6 Board pages", "On Ana's page"; ◷ "Sending · on 2 of 4 pages" until every page has
  said; △ "Couldn't show it: the picture didn't load"; ○ "Ana went back to chat at 14:02" (the laptop's clock), "Back to
  chat on all 6 Board pages" (the operator's hand-back, once every page says it is back on its chat: never ✓, which is
  on screen), "Nothing shown yet"; ▭ "Ana minimised it at 14:02"; ◇ "Opened · AGMessage can't see inside web pages",
  never ✓ (a web page's, none yet); ◐ "5 of 6 showing · 1 asleep or in another app" ("5 of 6 back to chat" for a
  hand-back), with whoever went back to chat, minimised it or is shown something else; ✕ "Nobody on the Board is
  online". The pages' reports are the run's alone: never saved, and a page that goes takes its own with it.
- **A guest's chat view** (Simple, Full, or by their seat) is kept by their uid, in the accounts' words.
- **The `pages` lane**: `data/pages.json` (`{v: 1, views, halls}`; a hall's `{seq, board: {show}, people, answers}`,
  each person's take and answer by layer), written through a write lane of its own, mode 0600, named in `saveLanes()`
  and so in health (`saves.stores.pages`) and flushed at a stop or a crash; nothing is written until this copy holds its
  data folder (`hold()`, in the first writes), a change before that kept and written then, and a start that changes
  nothing writes nothing. It is read with its `.bak`, and a record of the wrong shape is dropped as it is read (a hall's
  key, a person's, a take numbered past its hall, a kind that is not one, a picture that is not an upload, an answer
  that is not one); why a file could not be read (EBUSY, EACCES) is recorded (`unread`), and nothing reads it yet: the
  file holds nothing sealed, and the web page's unit, which seals its addresses there, has the start read it as it reads
  the screens' store's. A hall closed takes what its people's pages were shown with it, unless it opens again at the
  next start (another program held its files).
- **The module fence** gains (n)'s kinds: `lib/pages.js`'s `KINDS` and `describePage`'s words are one set, read from the
  source, each kind its own words; no catalogue row sends a take yet, and the Board chip's rows join the set when it is
  drawn.
- Choices where the plan left room: the store keeps Part 4's shape in layers from its first write, with the show layer
  alone (the information layer, `chat {layer}` and Earlier come with the Board's information takes), so nothing
  migrates; a take's `by` is an object (`{name}`), which Part 4's `op` and Part 7's `onStage` join; the holding rule is
  Part 1's (in a room of the hall the pusher may read), which the stage's `sourceOk` replaces; one voice of words for
  now, since no kind here names a file; the pages' reports and the answers they carry are the store's (`report`, `left`,
  `pageState`), so status reads one place, and `page:report` itself is unit 17's, which carries Show again to the store
  as `again` (a `shown` report that is the person's act, not a page's routine one); Back to chat stays final for its
  take (the 10 s Show it again is unit 18's); a Board take puts away the person takes of those seated On stage, as the
  plan says, their pages in a side room included, so the push (unit 17) sends `page:take` again to every page of theirs
  whose take changed, never to the Board pages alone; a person's status is the newest take any of their pages is shown
  now, and a page shown another take "showing something else"; the time is said only where one person answered; the
  words for one Board page ("On the 1 Board page"), several of one person's ("On all 2 of Ana's pages") and several
  names ("Ana, Ben and 2 more"), which the plan does not give, follow its table; a guest's views kept in the order set,
  so a laptop clock stepped back never changes which goes; a `pages.json` that cannot be read is recorded, as
  `displays.json`'s is, and not refused (it holds nothing sealed yet); two names in `server.js` that would have hidden
  the store (`pages` in the power request's count and in `admin:kick`) are renamed.
- Rolling back: 0.5.1 never reads `pages.json`, which stays, and 0.6 reads it again.
- Tests: `test/pages.test.js` (new, pure): every kind refused that is not one (`brand`, the web page, the documents, a
  kind of the wrong type or inherited, none), each kind's clean shape as a fresh object; Stagewatch only with the hall's
  link; the holding rules (no picture; a picture of ours asked of the facts by its address; each image type; a type or
  an address that is not one; a value that is not a string, refused with the kinds; one in no room the pusher reads, and
  facts that cannot say; the screens' rule, upload type by upload type); back to chat naming a layer refused; the words
  for each kind, one set, and none naming a file; which take a page shows by number, on a Board page and elsewhere,
  across halls; a take the store would not read back not numbered; answers only on the current take, across a person's
  pages, final for Back to chat, a Minimise taken back by Show again alone (another device's report of the take keeping
  it), kept across a restart with no report written; a report of no person or at no time keeping nothing, the answers'
  prototype untouched and nothing written; each kind's reports, opened by none and a hand-back neither put away nor
  minimised; a Board take putting away the On stage persons' takes and answers and no one else's; the bounds (201 takes,
  501 answers, 5,001 views, and a file over them read back within them, in its order), an answer given with the clock
  stepped back kept as answered, and the order given or set kept across a restart; a guest's view set, cleared and
  refused; each status mark with its words, a hand-back ○ and never ✓, and every mark drawn one of the table's; status
  read from the store's reports as pages say, go and come back; a hall forgotten with its reports; a record of each
  wrong shape dropped as the file is read, `__proto__` among them, and a file that cannot be read recorded; nothing
  written before `hold()`, what changed before written at it, mode 0600, and nothing written by a hold with nothing
  changed; the store's hall keys the rooms'. `test/modules.test.js`: (n), and a planted kind without words, words
  without a kind and words given twice failing it. `test/server.test.js`: `pages` among the lanes health names.
  `test/halls.test.js`: a `pages.json` read at a start and not written by it, and a hall removed taking its people's
  pages with it while another hall's and a guest's view stay.
- The papers: `docs/DESIGN.md`, `docs/ANALYSIS.md`, `CLAUDE.md`.

**A take on the Board's pages or one person's, confirmed page by page** (the plan's Part 1, unit 17, its §2.6, §2.7's
`page.push` row, §3.3 (`page`, `canPush`, `now`, `tz`, `viewOf`), §5.2-§5.5 and §9's row 17, as Part 4 §0 (the Board
is everyone seated On stage in Main), Part 5 §0 (§5.3: a `cid`, `pages:changed` a `Latest`, the handlers in
`lib/handlers/takes.js`, the person-first words), §13.3.4, §13.3.6 (`peaks.pageHiddenMs`, reading 5), §13.6, §14.2 and
§9's row 17, and Part 7 §0.1 (§2.6: the seat limit cuts `canPush`) amend them; the tree as the evidence: what people's
pages are shown was a store nobody could reach, and nothing of it is drawn on a page yet: the layer and the console are
unit 18's)
- **`page:push {code, to, content, cid}`** (the takes module, behind the gate): `code` the hall's key, `to` the Board
  (`'board'`: every page seated On stage in the hall's Main room, Board accounts and code guests alike) or one person
  (`{uid}`, their key as `page:status` lists them: `a:<account id>`, every device of an account; `u:<uid>`, a guest's
  device), `content` one of the kinds the store's vocabulary cleans (back to chat, Stagewatch, the clock, holding,
  blank). A repeat with its client id is answered with what the first push did before the rate, never made a second
  take or a second row (the last 200 a hall, for halls still here, in memory: after a restart a repeat is a second take
  of the same content, which latest wins makes harmless); a socket that is no account, admin or seated guest keeps none.
  Every other push takes one `writes` token before anything refuses it, then is refused, in order: a key that is no
  hall's, or a hall where it may not push, in one answer ("Do that from a backstage page." On stage, the admin's seat
  included; "This is someone else's view — act from your own page." from the support view; "Your account may not change
  what people's pages show in this hall." for an account without `display.control` there; "In an open hall, showing the
  Board needs an invite link or an account — ask the admin." for a guest backstage in its own open hall's Main room;
  "Showing the Board is for the backstage team." for any other guest, a socket that joined nothing included): a hall's
  key is its guest code until New code, so neither `page:push` nor `page:status` says whether a code is real, and only
  the admin, who sees every hall, is told "No such hall."; no target ("Show the Board (to: 'board') or one person (to: {uid})."); content the store
  refuses, in its words; a person not seated now in a room of the hall the pusher may read ("That person is not in this
  hall now.", which also hides who sits in a room the pusher cannot read; the Board's own word given as a person's key
  is no person). Then the store numbers it, every page whose take or answer it moved is sent `page:take` by its socket's
  id, never a room's op or broadcast (the Board's pages; or every page of that person in any room of the hall and the
  admin's view of them; and, for a Board take, the pages of those seated On stage now whose own take it put away), one
  `page.push` row is written ("the Board (6 pages) → the clock", "Ana Silva → blank"), the consoles are told, and the
  answer is `{ok, seq, results: [{key, name, ok, status}]}` with its status "◷ Sending" (or "✕ Nobody on the Board is
  online", the take kept for whoever comes On stage), never on screen.
- **Who may push** (`canPush`, on the connection): the admin; an account with `display.control` in the hall, from any
  room of it; a code guest seated backstage in the hall's Main room while its seats are locked, so the seat came from an
  invite or was kept by the lock. Never a page seated On stage (its seat holds messages only) and never the admin's
  support view. `display.control`'s words are "Change what a hall's screens and people's pages show", on the Accounts
  page and in `rbac.CAPS`.
- **`page:take {seq, content, by, at, hallName, holding, now, tz, answer}`**, to a page by its socket's id: the take it
  is shown now, who put it up and when, the hall's name and holding picture (a holding slide with none of its own shows
  the hall's), AGMessage's clock and zone (a clock take is drawn in them), and the person's answer to it ('dismissed',
  'minimised' or null); `seq: 0` and no content when a page is shown nothing now. It carries no key or code. It is sent
  again, as the join would tell it, to each page shown a holding slide with no picture of its own when the hall's
  holding image is set or cleared (as the hall's screens are), and to each page shown a take when the hall is renamed;
  the consoles are told then too, and when a side room is renamed (its name is in their rows).
- **`page:report {seq, state, words, again}`** acks `{ok: true}` or a refusal in words: one `chatter` token; refused
  from the admin's support view ("This is someone else's view: it reports nothing.") and from a page seated nowhere;
  counted only for the take that page is shown now ("That is not what this page is shown now."), in a state a take of its
  kind has. Back to chat and Minimise are the person's answer: each page of theirs in the hall, and the admin's view of
  them, is sent `page:take` with it, and so is a Show again (`again: true`) that takes a Minimise back. A Board page that
  said it was out of view while a take was drawn on it says, once it is back in view or gone, for how long: the show
  day keeps the longest (`peaks.pageHiddenMs`, reading 5).
- **`page:status {code}`**, for whoever may push there (refused otherwise, in the same words as the push): `{ok, board:
  {seq, showing, mark, words, pages}, people: [{uid, name, room, seq, showing, mark, words, pages}]}`, the Board's take
  read from each Board page's report and each person seated in a room of the hall the asker may read (a guest pusher's:
  Main), with theirs; the support views are no one's pages. The Board's people are named only to one who may read the
  hall's Main room: an account that may push there but not read it (`display.control` with `hall.view` revoked) reads
  "Someone went back to chat" and no person's row.
- **`pages:changed {}`**, a signal with no content, a `Latest` of 150 ms keyed by the hall (health's `latest.pages`):
  sent to each page in the hall's rooms whose push held at its join, when a take is pushed, a page reports, a page comes
  or goes, or a seat moves. A console reads `page:status` again, so latest wins; a burst of reports is at most two
  frames.
- **The join** answers, at the end, `page` (the take this page is shown now with the person's answer, or null: a page
  back from a drop, a reload or a restart, and one that comes On stage later, is shown the Board's take as it joins),
  `canPush` (whether its console may push and hears `pages:changed`), `now` and `tz`. The admin's support view names the
  person it shows (`viewOf`, their uid, passed by the admin page's View from the person's row): it is given that
  person's `page`, is sent their `page:take`s and their chat view as it changes (`view`, the view their seat there
  draws), pushes nothing and reports nothing. Its join answers, at the end, that person's facts as their page there
  holds them now (`person: {role, view, canPush, sends, forwardable}`, or null for a view of nobody seated there), so it
  can draw exactly their doors (R8); `canShow` joins them with its unit, and the hall page's support view draws its
  doors from them with unit 18, whose People doors read `canPush`. No other page's join carries `person`, and a page's
  own `sends` and `forwardable` are read by the same rule as the facts its support view is told.
- **A seat moved** to or from On stage (`admin:setRole`) sends each moved page what it is shown now, before the page
  reloads, and the consoles are told; a moved page hears `pages:changed` again only from its next join.
- The busy line counts `page:push` and `page:report` as input (a person's Back to chat, Minimise and Show again ride
  `page:report`), and `page:status` as a read.
- The module fence's wire words gain an allow-list of verbs no page sends yet, each with its reason, beside the events
  no page hears: `page:push`, `page:report` and `page:status`, and the events `page:take` and `pages:changed`, are the
  hall page's with unit 18, whose layer and console send and hear them; a row fails once a page sends or hears its word,
  or once the server no longer registers or sends it.
- Choices where the plan left room: a push names the Board by `'board'` alone and a person by their key in `{uid}`, so
  neither is read as the other; the answer's `results` holds the one target with its status over the pages the pusher
  may read (a person's take still reaches their pages in rooms the pusher cannot read); a push the store would not keep
  is refused ("That could not be kept: nothing was shown."); the repeat memory is the hall's by who pushed and the client
  id, checked before the rate as `room:send`'s is, and a socket that is no one keeps none; `pages:changed` follows the
  join's `canPush` as the plan says, so a lock or a seat moved since changes who hears it at the next join, while
  `page:status` and `page:push` ask `canPush` afresh; the support view's own `canPush` is false (it acts on nothing and
  may read no console), and it shows the person's takes and is told their facts only when that person sits in the room
  as it opens; a guest seated backstage before the room's seats were locked pushes once they are, the lock keeping that
  seat as the admin left it (the admin sees and may move each seat it keeps); a
  report's refusals are words, and a report from a page that hears of a newer take is refused, never counted for it; a
  Board page's time out of view runs from its first report out of view, across a newer take, to the report or the leave
  that ends it, and counts only while a take is drawn (never on a page handed back to its chat).
- Tests: `test/takes.test.js` (new, end to end): a Board take reaching Gil's and Bea's (a Board account's) pages only,
  never a backstage, observer, Legal or console page, the consoles told with no content and nobody else; its repeat
  with its client id one take and one row; "◷ Sending" until each page reports that take shown, a support view's report,
  reports of other takes and a page out of view never ✓, then ✓ "On all 2 Board pages"; the day's peaks keeping Bea's
  time out of view; `pages.json` and health's `pages` lane holding it; the halls board and the context the same as
  before it; a page coming On stage later shown the Board's take as it joins; five reports at once at most two frames
  (`latest.pages`); a person's take reaching Tom's pages in Main and Legal and the admin's view of him and nobody else,
  his Back to chat told to all three, his row "○ Tom Tech went back to chat at …", and kept across a reload; whom a push
  may name and what it may show refused in words, nothing numbered; every seat that may not push refused, its console's
  read too, with no row; the locked hall's backstage guest pushing, her console listing Main's people alone, a person
  only in Legal not hers to name, her take to Tom reaching his Legal page; a seat moved On stage told the Board's take
  and one moved off told it is shown nothing; one row per push; an anonymous socket, a guest of another hall and an
  account of another hall each answered the same for the hall's key and two made-up ones by both verbs, and no row; the
  support view's `person` facts (Bea's On stage, Tom's backstage with his console's push, null for a view of nobody
  seated there) and no `person` on a page of one's own; Bea's chat view set and cleared reaching her two pages and the
  view of her, by seat (simple On stage, full in Legal), and never the view of Tom; the hall's holding image set and
  cleared telling each holding slide (the view of Bea among them) and the consoles, and nobody shown something else; the
  hall renamed and named back telling each page shown a take, and none shown nothing; a Board take putting away Bea's
  own, her Legal page told it is shown nothing; Gil's Back to chat named to the admin and nameless to Vic, who may push
  but not read Main and reads nobody's row; Ria a console after the lock (her join's `canPush`) and none once moved to
  Observer; the admin's views of someone no consoles; a restart keeping Tom's Back to chat and Gil's on the Board's take.
  `test/inputs.test.js`: the take verbs' fields sent in every type, each refused in its words, nothing numbered or
  audited. `test/pages.test.js`: a Board page's time out of view, from its first report out of view to the report or the
  leave that ends it, across a newer take, and none on a page in a side room or handed back to its chat.
  `test/units.test.js`: `pageHiddenMs` per show day, raised only, read back by type. `test/modules.test.js`: `canPush`
  in `conn`, the takes context's parts, the allow-list of verbs no page sends yet, planted both ways, and the takes
  module's any-room reader with its reason. `test/server.test.js`: `latest.pages` and `pageHiddenMs` in health. Moved on
  purpose: `test/menus.test.js` (the join's keys appended at the end: `page`, `canPush`, `now`, `tz`),
  `test/resilience.test.js` (the state frames' `Latest`s gain `pages`), `test/accounts.test.js` and the browser smoke
  (`display.control`'s words).
- The papers: `docs/DISPLAYS.md` (People's screens), `docs/ACCOUNTS.md`, `docs/DESIGN.md`, `docs/ANALYSIS.md`,
  `SECURITY.md`, `CLAUDE.md`.

**The hall page's header is one model at every width, and every status is drawn from one table of marks** (the plan's
Part 5, unit 31, its §15.4 (the header's rows and ⋯), §15.6 (`AGM.MARKS`, one status chip), §15.9 (1.4.10), §14.4's fence
(n), its marks half, and §9's row 31, as Part 0 §0.8 C3 (it lands in 0.6.0) and Part 7 §0.2 amend them; the tree as the
evidence: the header held 13 controls in a row that wrapped (who, the dot, A−, A, A+, 📺, 🌙, Help, Screens, People,
Leave, the code, the countdown), and the countdown, Help and a screen's state were three chips drawn three ways)
- **The header** is the same on a phone and a laptop. Row 1: the room's name ("Hall 2 › Legal"; a Main room the hall's)
  with who this is under it, then its status (the connection's mark, with "Offline · reconnecting" beside it once the
  page has been down 5 s; the countdown), then Help and a 44 px ⋯; it never wraps: the name gives way first, cut with an
  ellipsis, then the countdown's title. Row 2, only with two rooms or more: the switcher. Every control on row 1 is 44
  px, and so is each room of the switcher, under a mouse too (it was 24 px but on a touch screen). The ⋯ — and a
  right-click anywhere on row 1 but the countdown and Help, and Shift+F10 or the menu key on the ⋯ — opens the header's
  menu (kind `header` of the catalogue): People · n (the People panel, a checked toggle), Screens… (the screens console,
  for a seat that drives them; it reads their list as it opens, so it waits for the connection), Text size ▸ (Small,
  Standard, Large, Larger, Very large and Largest, twice the standard, the one in use checked), Dark theme (a checked
  toggle, kept and handed to the person's other pages as before), Copy guest code K7P2QX (with "(off)" while it admits
  nobody new) and Copy join link where the server tells the page its code, for the admin Turn the code off… / on and New
  code…, and, last behind its separator, Leave (All halls for an account, which keeps what was written and not sent for
  the person's return to the room, as a move to another room does). Its line names the room and who this is. The buttons
  it replaces are gone: A−, A, A+, 🌙, Screens, People, Leave, the code chip (its acts are the ⋯'s, and the catalogue's
  kind `code` is `header`'s rows now) and 📺, whose panel keeps its own ⇥ and its rail. Out of its hall a page draws no
  ⋯. The admin's support view draws the person's ⋯, every item disabled with whose view it is, as every menu there is:
  so the support view no longer sets the person's text size or theme, which its A−, A+ and 🌙 did (a change the person
  makes still shows there).
- **`AGM.MARKS`** (`public/common.js`): one table of the thirteen marks every status is drawn with, each with one name,
  one meaning and a colour role of the tokens: ✓ ok (showing, resolved, on screen), ◐ partly (not fully seen), ◇ unseen
  (reached but not seen into: a web page opened, and the audit log's entries accepted on this laptop, its "Linked"), ▭
  minimised, ○ off, ⊘ withdrawn, ◷ waiting (sending, waiting), △ couldNot, ✕ fault (none, or a fault), ■ urgent (waiting
  for someone), ▶ coming (on the way), ● note and ▲ soon. `AGM.mark(name)` gives a mark (a name that is none throws),
  `AGM.markOf(mark)` its name, and `AGM.chip(el, name, words)` draws **one status chip**: the mark (hidden from a screen
  reader, which reads the words), the words and the role's colour, or at rest neither mark nor colour; a name that is
  none, an inherited one (`toString`) included, is refused before anything is drawn. `AGM.toned(el, text)` draws **a
  status line** (a show-desk request's, a send to the speaker's screen, a help request's) in the role of the mark its
  words start with, so a mark draws in one colour on every line and page. The connection's mark (✓ in the hall, ◷
  connecting or down less than 5 s, ✕ down 5 s or not coming back; its name for a screen reader as before), the
  countdown (no mark while live, ▲ near the end or over time, ◷ while Stagewatch has not accepted the key, ✕ with the
  last time known, in muted ink, while the link is lost; Stagewatch's colour is its 3 px left edge, never the digits'
  ink, so they keep their contrast), Help's chip (■ Help asked on the fault red, ▶ Ana is on the way, ✓ Resolved) and
  each screen's state in the Screens console are that one chip.
- **Every page draws its statuses from the table**, each mark in its role's colour: the hall page (the show desk's
  lines: ◷ Waiting for the show desk, ✓ Approved, ✕ Not approved, △ for one that failed, was not delivered, could not be
  read or is lost, where they read ✗ and ⚠, in warn's colour where a failed or undelivered one was red; the speaker's
  screen's lines: ◷ while it waits for the speaker, where they read ⏳, ✓ on the speaker's screen, and ◷ sent but not
  confirmed, which had no mark; seen receipts, held and refused sends, a help request's line and its edge, ▶ on the way
  in info where they were amber, a withdrawn send), the halls board (a hall's stage: running and held with no mark, as
  the hall page's countdown draws a live time, where they read ▶ and ⏸; ○ not running; ▲ over time, where it read ■, its
  edge warn's where it was red; ✕ a link lost, refused or whose certificate changed, where a lost link read ?; ◷
  checking the key, where it read …; Stagewatch's colour the clock's left edge, never the digits' ink, as on the hall
  page; a screen's chip edged in its mark's role, △ in warn where it was red; a node's light, △ amber in warn's colour;
  a verb's risk in words, low risk, needs review and high risk, where it read ● ▲ ■, since no mark means a risk; ◷
  Proposed to the show desk, where it read ▲ in ok's green, a status line in info now; ✓ Live and ◷ Reconnecting, where
  they read ● and ○), the admin page (its health line's △, where it read ⚠, and ✕ for a changed certificate; ◷ for
  show-desk results waiting and a proposal; the audit log's marks; "This laptop"), the Accounts page and the audit
  export (their marks unchanged, each in its role's colour: ◇ Linked in info's, where it was ink). The server's screens
  read ◷ sending, where they read …; their marks and a take's are named in `lib/displays.js`'s and `lib/pages.js`'s
  `MARKS` by the table's names.
- **The fences**: ESLint's `no-restricted-syntax` refuses a mark of the table, or a retired one (✗ ⚠ ⏳ ⏸), written in a
  string or a template of any page script or page module (a template read as written and as it reads, so a mark written
  as its escape is caught too) but `common.js` (the table's home) and the screen page's `display.js` (which loads none
  of the people's pages' scripts); `test/lint-rules.test.js` plants each of the 17 in each page script, a template and a
  module, and each as its escape in a string and a template. Fence (n), its marks half (`test/modules.test.js`):
  `lib/pages.js` and `lib/displays.js` name each mark they draw by its name in the table, with its mark, write none of
  their own (a retired one, … included), and draw every mark of their `MARKS` and no other; the screen page's three
  tones are the table's note, soon and urgent; a mark given two names fails; each half planted. `test/catalog.test.js`
  loads `common.js` before `catalog.js`, as every page does, and holds no act's icon and no fold's a mark of the table,
  the table's thirteen names and marks, each role a token of the stylesheet, red a fault's or an urgent wait's alone, a
  chip refusing an inherited name, and a status line's colour its mark's role.
- **The stylesheet** loses eleven hex colours with the dot, the code chip, the dark countdown chip, the show desk's and
  the speaker's screen's lines' own greens and red, and the board's over-time red (the count is 254); a chip's and a
  status line's colours are the role tokens. The header never widens the page's column past the screen (its row gives
  way inside it), and a "✓ Seen by" line is a whole number of pixels tall, so one drawn under an open menu moves nothing
  there by a fraction the scroll that holds the menu's ⋯ cannot take back.
- **A menu's submenu opened by a key stays open under a mouse at rest.** A pointer left lying where a menu opens, or
  under a row the page moved there, is reported entering that row though it never moved; it was taken for a hover, which
  shut a submenu F or E had just opened (Send to ▸, React ▸) 200 ms later and left the focus on the page. A row is
  hovered now only when the pointer is somewhere it was not at its last move, press or release (`public/menus.js`). The
  header's new height put such a row under the smoke's resting pointer, whose F test found it; a smoke step of its own
  now parks the pointer on the menu's row, opens React ▸ by E under it, and then moves the pointer onto Send to ▸, which
  it hovers.
- Choices where the plan left room: the ⋯'s Screens & pages… reads Screens… until the console holds people's pages (unit
  18's); text size is six sizes in a radio list, from 0.85 to twice the standard, set once and seldom, in place of A−, A
  and A+, which stepped by a tenth from 0.7 to 2.2 (a size the page was set to between two of them checks neither, and
  stays until one is chosen); the code chip's four acts are the ⋯'s, with
  the code in its label, so the code stays one tap from being read aloud; the way out is in the manage group, behind a
  separator, with no ask (it loses nothing); a right-click on the room's name or the header's empty space opens the ⋯'s
  menu, and Help keeps its own ask; the person's name and seat stay under the room's name, as words, not a control; the
  audit log's ◇ "Linked" (the owner's answer A2) is the table's ◇, reached and not seen into; a mark is drawn only where
  its meaning in the table is the state's (a live countdown and a verb's risk have none); the screen page keeps its
  own three tones, held to the table by a test, since it loads none of the people's pages' scripts; the Board chip
  ("Board ✓ 6/6") joins the status row with unit 18, which draws it.
- Tests: `test/catalog.test.js` (the header's ⋯ by seat: People, Text size, Dark theme and the way out for every seat,
  Screens… for one that drives screens, the code for a page told it, the admin's Turn the code off… and New code…, none
  in the simple view, every item disabled in the support view, Screens… and the admin's acts disabled offline; its
  labels, toggles and sizes; the marks' table, a chip's names and a status line's colour), `test/menus.test.js`
  (Screens… refused as each seat that may not drive screens, On stage in the table's words, and the code's acts as
  before, now the header's), `test/modules.test.js` (fence (n)'s marks half, planted), `test/lint-rules.test.js` (the
  marks in the lint, escapes included), `test/pages.test.js` and `test/displays.test.js` (the marks by name, ◷ for a
  screen sending), `test/resilience.test.js` (the hex count, 254). The browser smoke: the header at 1440 and 1024 px and
  on a phone, at most 6 controls on one row, each 44 px, the switcher only with two rooms, its rooms 44 px under a
  mouse; a pointer at rest on a menu's row leaving React ▸ open with the focus in it, and a move onto Send to ▸ hovering
  it; the ⋯'s items in order and each acting (the panel, the messages' size, the theme); the ⋯'s doors (a click, a
  right-click and Shift+F10, and a right-click on the room's name); every status chip in the header the table's mark and
  its role's colour; the admin's code acts from the ⋯, every page's Copy guest code saying "(off)"; Screens… opening the
  console, Leave leaving to the halls board; and, moved on purpose, the phone pass (the ⋯ a door of 44 px for every
  seat), a page out of its hall (no ⋯), the Viewer's header and a refused proposal's ✕.
- The papers: `README.md`, `README.txt` (the header's ⋯ → Screens…, the connection's mark), `docs/ANALYSIS.md`,
  `docs/DEVICES.md`, `docs/DISPLAYS.md` (◷ sending; the header's ⋯ → Screens…), `docs/NODES.md` (△ for a show-desk
  request whose state cannot be read), `CLAUDE.md`.

**A take on the hall page, minimised, shown again; the Board chip and the console** (the plan's Part 1, unit 18, its
§5.4, §5.5, §5.7, §5.8, §7.5 and §9's row 18, as Part 4 §0, Part 5 §0 (§5.4: Show it again within 10 s, the card
icons, both ways out kept and Escape minimising, owner answer 32; §5.7: a renderer of plain values with no socket; §7.5:
the Board chip's Undo and ↶ Back to), §14.4's fence (m), §16.6, §16.7's `take`, `card`, `board` and `person` rows and
§16.10, and Part 7 §0.1 (§5.4: Full screen only where the device has it) and §0.2 (the Escape order) amend them; the tree
as the evidence: a take reached people's pages over the wire alone, and nothing drew it, said what was drawn or offered a
way to show it)
- **The take layer** (`#pageLayer`, drawn by `public/pagelayer.mjs`, an ES module loaded with `import()` at the page's
  first take): over the whole hall page, the header and the side bar included, under the menus, the asks and the toast
  (`--z-layer`), on black (`--c-take`), never a modal dialog. Stagewatch's countdown (time, title, next, the speaker's
  line; `--:--` while the link is lost, its key not accepted or the page not connected), the clock (AGMessage's clock and
  zone), the holding picture (one that does not load leaves black and says "the image did not load"), the AGMessage mark
  enlarged and the hall's name when there is no picture (owner answer 31), or black, whose bar shows once the screen is
  touched or a key is pressed. Its bar says what it is and who put it up, and holds 💬 Back to chat, 🔽 Minimise and, only
  where the device has the Fullscreen API, ⛶ Full screen, 48 px, in words and icons; in the full view its ⋯, a
  right-click and Shift+F10 open the same, and Open chat while a 🔥 message is in its strip. **Escape minimises, never
  goes back to chat**, first in the Escape order after an open menu and an open ask. The renderer answers what it drew
  and the page alone says it (`page:report`): `shown` only while the page is in view, `hidden` otherwise and again when
  that changes, `failed` with why; each join says it again (a new socket has said nothing). The focus goes to the layer,
  unless a field holds it.
- **Back to chat** takes the take off every page of the person's in the hall; the toast's **Show it again** within 10 s
  brings it back on all of them. **Minimise** puts it as a card at the top of the side bar (📺 On stage), "⏱ Stagewatch"
  with its live time, "🕐 Clock" with the time, "🖼 Holding" or "🌑 Blank", with who put it up and when, ⤴ Show again and
  Remove (Back to chat, with Undo for 10 s; the full view only); the side bar opens itself for it, its rail reads "📺 On
  stage • 1" while collapsed, and no document opens itself over the card. An observer or a Viewer account, who has no
  side bar, is given one, its cards alone, while a take of theirs is minimised (`body[data-pushed]`, on an observer's
  page alone: every other seat's side bar keeps its size at every width). Every one of these is the person's
  act on their own page: the page acts at once and says so after (`self`), and a refused one is said in the toast.
- **Nothing reaches the stage by surprise, and nothing is lost:** a take never takes the focus from a field being written
  in; it waits until the field is left, at most 3 s, and the field keeps its words under it (the person's own Show again
  draws at once). While a take covers the page, a 🔥 message from someone else breaks through in a strip at its foot
  (its sender, its words, **Open chat**, which minimises the take and brings the message into view with the focus on
  it), and other new messages are counted on its bar ("2 new").
- **The Board chip**, in the header's status for a page that may change what people's pages show (`canPush`): "Board ·
  🕐 Clock ✓ 6/6" (what the Board's pages show and how many show it), "Board · ✕ nobody on stage" with no Board page
  open, its words for a screen reader. A click, a right-click and Shift+F10 open its menu: Back to chat · Show
  Stagewatch · Show the clock · Show holding · Show blank, as radio items, the one the Board shows checked and disabled
  ("Already showing the clock.", "Already on chat."; Stagewatch "This hall has no Stagewatch linked — link one in Set
  up." where the hall has none), then ↶ Back to … and Screens & pages…; its header names the pages and their status, or
  "No Board page is open: what you show arrives when one joins.". A choice goes at once, the toast naming whom it reached
  ("The clock on 6 Board pages.") with **Undo** for 10 s, which puts back what was shown before as a take of its own,
  sent over the one it undoes; beyond the toast, **↶ Back to Stagewatch (undo your Clock, 14:02)** does the same while
  this page's take is still the Board's. A take made by either offers no undo of its own, and another operator's chip
  offers none.
- **Screens & pages** (the header's ⋯, which read Screens…; and the Board chip): the hall's console, a **Screens** tab
  for a page that drives the hall's screens and a **People's pages** tab for one that may show people's pages, each tab
  where the page may use it. People's pages: **On stage (Board) — all 6** first, with a button for each kind, then each
  person in the hall's rooms the operator may read, with their room, each with its status chip and what it shows; a
  person's ⋯ holds **📺 Show them ▸** (Stagewatch, Clock, Holding, Blank) and **Back to chat on their pages**, which a
  person in the People list and a message's sender's name offer too. It reads `page:status` as the page joins, as it
  opens and on each `pages:changed`. It names the hall by its key from any room of it, so it works from a side room, and
  a locked hall's backstage guest has one, no longer gated on an account. The support view draws the person's doors
  from their facts (`person`: their seat, sends, forward and push), every one disabled, and draws their take.
- **The server**: `page:report`'s `shown` with `again` (Show it again) or `minimised` (a card's Undo), within 10 s of the
  same person's Back to chat for that take, takes Back to chat back, every page of theirs told; after 10 s each is
  refused ("Back to chat was chosen for that one more than 10 s ago: a newer take shows again."), and a page whose own
  act (Back to chat, Minimise, Show again, Undo) is refused is told again what it is shown, so a page that drew at once is
  back in step; a routine report refused tells it nothing. A page's report of an answer counts only while that answer
  stands: once taken back the page is waiting until it says what it does again. `page:push` takes `ifSeq` (the take it
  goes over: Undo and ↶ Back to), refused "Something newer is showing there now: nothing changed." once anything newer
  is up and "That act's take could not be read." for anything but a whole number, and answers, at the end, `previous`,
  what its target was shown before (`{seq, content}`, or null), its content only as this pusher could push it itself
  (`cleanPage` with its own facts): a holding picture shared in a room it may not read, whose upload path is the file's
  capability, comes back as `content: null`, and the page then offers no Undo and no ↶ Back to. A guest's page names its
  hall by the guest code it joined with, which `page:push` and `page:status` read as that page's own Main room, so a
  locked hall's backstage guest keeps a console after New code; the book of pushes a repeat is answered from is kept by
  the hall's key, so its repeat by that code finds the first push. `page:status`'s rows gain `kind` (what the take shows) and `on` (how many of its pages
  show it now). `displays:changed` is `{}`, sent to every room of the hall, naming nothing, and the console reads its
  hall's list again on it (a side room's console included). The outbox's `self` takes an answer for a report, and
  `page:push` is answered on a repeat by its client id (`REPEATS`). The toast's Undo can carry its own words
  (`undoLabel`: Show it again).
- **The catalogue** gains the kinds `take`, `card` and `board` and `person.show` and `person.chat`: an act that puts
  something on people's pages says Show, one that undoes it Back to; "Full screen" is the device's mode, no screen of the
  hall's; a bar may hold more than two acts (the layer's, the Board's row); an entry may be a radio item. The facts gain
  `canPush`, `stagewatch` (the hall has a Stagewatch linked) and `fullscreen` (the page's probe).
- **The fences**: (m), new (`test/modules.test.js`): a page's ES modules (`public/*.mjs` outside `vendor/`) name no
  socket, `io(` or `.emit(`, read as code, planted three ways. (n) holds the Board chip's show kinds (`board.<kind>`) and
  the page's names of them (`SHOW_KINDS`) to `lib/pages.js`'s `KINDS`, in order. (f)'s allow-lists lose `page:push`,
  `page:report`, `page:status`, `page:take` and `pages:changed`, which the hall page now sends and hears.
  `test/menus.test.js` sends `page:push` as every seat its rights hide it from (On stage: "Do that from a backstage
  page."), nothing put up; `page:report` has its refusal case and is iterated by `may` like every verb, the one verb no
  right hides from any seat (`OPEN_TO_EVERY_SEAT`, with why), which the test holds to being sent and refused to none. The any-room readers' count in
  `server.js` gains the screens frame's.
- Choices where the plan left room: the take's icons are no status marks (💬 Back to chat, 🔽 Minimise, ⛶ Full screen,
  🗨 Open chat; ✕ and ▭ are the table's), and the chip's kinds read "Show the clock" (the one-verb rule: Show puts
  something on people's pages); "Already showing …" holds while the Board's take is that kind and not every page went back
  to chat, so a take everyone put away can be shown again; a blank take's bar shows at a touch and stays; Remove and
  Show it again are the toast's, its Undo for 10 s by the page's clock, refused by the server after; a minimise opens
  the side bar each time the person minimises (not at a reload); the layer's focus goes back to the feed, never to a
  field, so a tablet's keyboard never rises over the chat; Open chat is a Minimise; the People's pages tab draws one
  button per kind on the Board's row and a person's two acts in their ⋯; a person's Show them ▸ is offered on any person
  of the hall the page knows the key of, oneself included, and never on an AI's line (the Minutes); until the console's
  first read the Board's kinds and a person's acts say "Reading where their pages stand…", nothing checked, and a person
  the read lists on no page in the hall "They have no page open in this hall now."; the admin page's people rows gain no
  Show them ▸ here.
- Tests: `test/pages.test.js` (Show it again and a card's Undo within 10 s, refused after, nothing saved for a refusal;
  a report of an answer waiting once the answer is taken back; a status's `kind` and `on`), `test/takes.test.js` (end to
  end, the server's clock moved on by `test/clock-preload.js`: Back to chat on one of Gil's two devices and Show it again
  from the other, both told; a card's Undo; after 10 s both refused and the page told again, a routine word not;
  `ifSeq` refused for a stale take and for anything not a whole number, with no row, accepted over the take up, and
  `previous` for the Board and a person; a guest pushing by the code it joined with after New code, and its repeat by
  that code, after another push, answered with the first take and one row; a Legal picture on the Board and on a person,
  pushed over by a Main-only guest and a Main-only Tech, given back to neither, and to the admin whole;
  `displays:changed {}` heard in Legal and in Main), `test/outbox.test.js` (`self` with an answer, the replaced report never sent nor
  answered), `test/inputs.test.js` (`ifSeq` typed), `test/displays.test.js` (the signal names nothing),
  `test/catalog.test.js` (the three kinds and the person's two acts by seat, the radio items and their reasons, ↶ Back to
  only over this page's take, the simple view's buttons, the support view's), `test/menus.test.js`,
  `test/modules.test.js`. The browser smoke, in a hall of its own with Bea On stage and Obi observing on browsers of
  their own (a smoke tab may now be a browser of its own, `alone`): the Board chip's doors and Show the clock reaching
  Bea's page with ✓ 1/1; Screens & pages… and its People's pages; holding, blank (its bar at a touch) and Stagewatch
  drawn; Escape minimising into a card whose doors are in step, Bea's side bar keeping the Board's half of the row with
  the card in it, Show again, the layer's doors in step; Back to chat and
  Show it again; Undo putting back what was there and ↶ Back to offered only over the page's own take; a 🔥 message
  breaking through and Open chat; a draft keeping its words and focus; the observer's side bar; no console error.
- The papers: `README.md`, `README.txt`, `docs/DISPLAYS.md` (people's screens as drawn: the chip, the console, the layer,
  the card), `docs/DESIGN.md`, `docs/ANALYSIS.md` (fences (m), (n), (f)'s allow-lists, the catalogue's new kinds, the
  Escape order), `SECURITY.md`, `CLAUDE.md`.

**A web page on a person's screen, with a right of its own** (the plan's Part 1, unit 19, its §5.1's `web` row, §5.3,
§5.6 and §9's row 19, as Part 4 §0, §5.9.2.2, §5.9.9, §5.11, §7.7 and §11 amend it (`stage.web`; the owner's answer S4,
"Admin defined", confirmed "S4" on 2026-10-31: `guestWeb`), with Part 0 §0.8 C14 ("the admin" is one predicate) and the
owner's design question 6 ("Defaults": scripts but no forms, popups or navigation); the tree as the evidence: a `web`
take was refused as no kind, every page carried one strict policy, and no page could frame a site)
- **A web page is a take of its own** (`web`, the sixth kind): an https address the person's page frames over its chat,
  shown from the Board chip's **Show a web page…** or a person's **Show them a web page…** (the console's People's pages
  too). It asks for the address, then **Preview**, which frames it on the operator's own page alone first (a dialog,
  whose **Show it** sends it), or **Show it** at once. The address: at most 2,048 characters, https only (http would be
  mixed content under HTTPS and through the tunnel; `javascript:`, `data:`, `blob:` and `file:` are no web page), no
  user name or password, and never AGMessage itself (`localhost` and every loopback form, a trailing dot included
  (`localhost.`), this laptop's name and network addresses, the tunnel's host): "That address is AGMessage itself: show a page of another site." It is checked on the
  server (`lib/pages.js` `webUrl`) and again in the page before the frame is given it. **The server never fetches it.**
- **Its address goes only to the pages it is shown on** (and the admin's view of them): kept sealed with this laptop's
  key beside its host (`pages.json`'s `{kind: 'web', host, urlSealed}`, with who put it up), opened to be sent; the
  push's answer, the console's status, the `page.push` row ("the Board (6 pages) → a web page on vote.example.com"), the
  halls board, the context and the AI's brief name its host alone, or nothing of it. A later push's answer gives a web
  page back (`previous`, its Undo) only to whoever put it up and to the admin: any other pusher, a backstage guest
  included, is given no content and offered no Undo, so nobody reads another's address, a token in its query among it. A run without its machine key keeps no web page ("A
  web page's address is kept sealed with this laptop's key, which this run has not: nothing was shown."); a store read
  by another machine opens none, and the page says it could not load it.
- **On the person's page**: the one frame a page makes (`framePage`, `public/pagelayer.mjs`), `sandbox="allow-scripts
  allow-same-origin"` (no forms, popups, top navigation, modal dialogs or downloads), `referrerpolicy="no-referrer"`
  (the hall page's address carries its code and its invite), `allow=""`, `credentialless` where the browser has it, its
  title "Web page from vote.example.com"; above it, in AGMessage's words, "A web page chosen by Ana (vote.example.com).
  Don't type passwords here."; on its bar Back to chat and Minimise, and in the full view, in its ⋯ and its right-click,
  **🗗 Open in a new tab** (no opener, no referrer), outside the frame; the simple view keeps the layer's buttons alone. It is drawn as it loads. A frame a site refuses still fires `load` and nothing inside can be read,
  so a loaded web page reports `opened` and reads **◇ Opened · AGMessage can't see inside web pages**, never ✓; one not
  loaded in 15 s reports `failed` and reads **△ Couldn't show it: the page did not load**. A web page is never `shown`:
  its reports are opened, hidden, failed, dismissed and minimised, and Show it again says `opened` with `again`.
  Minimised, its card reads "🌍 vote.example.com".
- **Only the hall page frames an https page.** `/app.html`'s Content-Security-Policy is the strict one with `frame-src
  'self' blob: https:` (`guard.CSP_HALL`); every other page, the screen page and every file keep `frame-src 'self'
  blob:`, the transcript its own policy, which frames nothing, and `frame-ancestors 'self'` and `X-Frame-Options:
  SAMEORIGIN` stay everywhere.
- **`stage.web`, a right of its own**: "Show web pages on people's pages (the Board's or one person's)", a hall's right
  in the Show group, in the presets of **Tech, Senior tech and Manager** (and the admin), not Staff or Viewer; given and
  taken back per account on the Accounts page. A web page needs it beside what every take needs: without it, "Web pages
  on the stage need their own right — ask an admin.", read before the address. **On upgrade**, Tech, Senior tech and
  Manager accounts hold it; an account whose rights an admin narrowed by hand is unchanged otherwise. The join answer
  appends **`canWeb`** after `now` and `tz` (a web page from this page would be taken), and the support view's `person`
  facts carry it.
- **A locked hall's backstage code guests show web pages only while the admin lets them** (S4): the admin page's Roles
  & invites panel gains **Backstage guests may show web pages on people's pages**, on a hall's Main room, off by default
  (a hall made before 0.6.0 too), offered only while the roles are locked ("Lock the roles first: in an open hall, code
  guests show nothing.") and only to "the admin": the laptop's token, or an account whose role is admin. A manager an
  admin granted `settings.manage` reaches the admin page and is refused it ("Only an admin may let backstage guests show
  web pages.", the switch drawn disabled with those words). The verb `admin:guestWeb {roomCode, on}` (in
  `lib/handlers/rooms.js`, behind the gate's admin step and then `theAdmin()`, which this unit adds to the connection's
  context) writes `{o: 'meta', settings: {guestWeb}}` (the room's op log keeps it across a restart), one `room.guestWeb`
  row, and tells each guest page seated backstage there at once (`pages:rights {canWeb}`), so its Board chip's Show a web
  page… comes or goes without a reload; asked again as it stands it answers `already` and writes nothing. It is an admin's
  act, so the busy line counts it as input (`lib/busy.js`). Refused for a
  side room ("This is set on the hall's Main room.") and an open hall. While it is off a guest's web page is refused
  ("Web pages from backstage guests are off in this hall — ask the admin."). **Unlocking turns it off** in the same op as
  the unlock, its `room.lock` row reads "roles unlocked, guests' web pages off", and locking again leaves it off: a lock
  keeps whoever sits backstage then, code guests who joined by the bare code while the hall was open included. Turned
  off, or the hall unlocked, a web page a guest already put up stays: the answer counts it ("1 web page a guest showed is
  still up", the row "(1 shown now stays until taken down)") with its targets, a person's whether or not a page of theirs
  is open (one who comes back is shown it again), and the panel offers **Take it down** (back to chat over that take
  alone). The admin's take-down of a person's take is taken with no page of theirs open too (back to chat over it, by its
  number; the row reads "a person with no page open → back to chat"); anyone else is still told "That person is not in
  this hall now.". An open hall's guest, an On stage or observer seat and a side room's Member never show one.
  `admin:listRooms`' hall rows and `admin:lockRoles`' answer say `guestWeb`. `tellWebRights`, which walks a room's pages
  to tell them, is one of the parts the takes context never holds (`lib/gate.js` `ROOM_SENDS`).
- **The lint** (`agm/no-unescaped-html`) refuses four sinks whatever they are given: a frame's `srcdoc` (as a property,
  by a computed key or through `setAttribute`), `setHTMLUnsafe(`, `createContextualFragment(`, and a computed
  `el['innerHTML']`. **A source guard** (`test/resilience.test.js`) holds `createElement('iframe')` to once in `public/`,
  in `framePage`, which sets the sandbox, the referrer policy and `allow` before the address.
- **The catalogue**: `board.web` (Show a web page…, the Board chip's sixth radio kind, asked first) and `person.web`
  (Show them a web page…), each for a page with `canWeb` (a new fact: the join's, a code guest's as `pages:rights` says
  it); `take.tab` (🗗 Open in a new tab) in a web page's layer's ⋯, in the full view only (Part 5 §16.7's `take` row,
  which outranks Part 1 §5.6's strip); `SHOW_KINDS` gains the web page. Another address may follow
  the one shown, so a web page is never "already showing". `Show them ▸` keeps its four show kinds.
- Rolling back to 0.5.1: a `pages.json` holding a web take is ignored as 0.5.1 ignores the whole file, and a hall's
  `guestWeb` setting is kept and read by nothing. Going forward again, both are as they were.
- Choices where the plan left room: the web page is the show layer's kind, as the design has it (Part 4's information
  layer, unit 24, moves it); the console reads a web take by its host alone (the address goes to the pages it is shown on,
  not to the console's status); the admin page has no Preview of its own (its policy stays strict) and pushes only Take it
  down; the switch's words for an `on` that is no boolean are "Say whether backstage guests may show web pages: on (true)
  or off (false)."; the address also refuses `0.0.0.0/8`, names under `localhost` and an IPv4 address written as IPv6;
  the push's answer gives a web page's address back to its own pusher and the admin alone, narrower than the plan's
  "the pushers' console", since a pusher's Undo needs no one else's;
  the web page's icon is 🌍 (🌐 is the internet link's); "Show a web page…" on the Board chip (the catalogue's rule:
  an act that puts something on people's pages says Show).
- Tests: `test/pages.test.js` (`webUrl`'s refusals: other schemes, user names, every loopback form and this machine's
  names, a trailing dot included, 2,049 characters, none, a value of another type; `cleanPage`'s right before the
  address; the web take kept sealed with who put it up, `pages.json` read for no clear address, told opened, refused
  where it cannot be sealed, a record of another shape dropped; `opened` never `shown`, ◇ and △; the web pages a guest put
  up, and their count in words), `test/takes.test.js` (end to end: the
  address told to the Board's page alone, the row, the console, the halls board, the context, the audit log and the
  console's output naming the host or nothing; a push's `previous` over a web page: its own pusher's and the admin's
  given it, another Tech's, a Tech's without the right and a backstage guest's given no content; a Tech with `stage.web`
  revoked refused before the address; the switch
  refused as "Not admin" to a Tech and a guest and with its words to a manager with `settings.manage`, a side room and an
  open hall; turned on, one row and `pages:rights` to the guest alone, then the guest's web page taken, On stage,
  observing, Legal's Member and an open hall's guest still refused; kept across a restart with the guest's web page,
  opened again; turned off over it, counted, the next refused and Take it down; a guest's web page on a person who then
  leaves, a guest's take-down of it refused; an unlock writing both in one op, its row and its answer counting the web
  page left up, the guest told, the admin's take-down with no page of the person's open, locking again leaving it off),
  `test/units.test.js` (`tellWebRights` out of the takes context), `test/server.test.js` (the hall page's `frame-src` and every other
  page's, the transcript's), `test/accounts.test.js` (`stage.web` in the presets, grant and revoke, never On stage or a
  code guest's; `giveable` gains it, on purpose), `test/lint-rules.test.js` (seventeen shapes of the four sinks),
  `test/resilience.test.js` (the one frame), `test/menus.test.js` (a Tech with `stage.web` revoked: Show a web page… and
  Show them a web page… hidden by `canWeb` alone, and refused in the right's words; the join's `canWeb`),
  `test/inputs.test.js` (`admin:guestWeb` and a web address by type), `test/catalog.test.js`, `test/modules.test.js`
  (`canWeb` and `theAdmin` in the connection's context, `selfHosts` and `tellWebRights` in the server's, the kinds in
  step). The browser smoke: Show a web page… from the console's Board row, Preview framing it on the operator's page,
  Show it putting it on Bea's page in the one frame with its sandbox, no referrer, no feature and no cookies, its strip
  and, in her simple view, the layer's buttons alone, ◇ once it loads (the browser answering it); Show them a web page…
  on Obi's page, whose full view has Open in a new tab in the layer's ⋯ and not on its bar; one that never loads on her
  page at once and △ after 15 s; the Roles & invites switch disabled with its words while open, turned on once locked, a guest's chip
  gaining Show a web page… without a reload, and an unlock taking it off; no console error or CSP violation.
- The papers: `README.md`, `README.txt`, `docs/DISPLAYS.md` (A web page), `docs/ACCOUNTS.md` (`stage.web`, the guests'
  switch, `room.guestWeb`), `docs/DESIGN.md`, `SECURITY.md` (the hall page's https frames, what the sandbox does not
  stop), `docs/ANALYSIS.md` (the lint's four sinks, the one frame, the inputs), `CLAUDE.md`.

**The Board's chat view: the chat first, compact, one response place per screen** (the plan's Part 7, unit 20a, its §17.2
and §17.7 with §17.1's `msg.ack`, the sheet and the facts of the simple view, carrying Part 1's unit 20 (its §6 server
half: `view` in the join's answer and live, `admin:setView`, the admin page's and the People panel's Chat view), as Part 7
§0.1-§0.3 amend Part 1 §5.8 and §6 and Part 5 §15.5, §15.10 and §16; the owner's ask of 2026-10-26 ("Main focus is the
chat and messages … more minimal and more focused on direct response and clear communication") and answers B4 (Got it
tells the backstage team with the name), B5 (🔥 Priority), B6 and 21 (dark first) and 22 ("Board will use a mixture of
devices"); the mock (`docs/plan/0.6.0/board-view/`) as the design. The clock or countdown is unit 20b's, every pin for the
room or for me 20c's and the admin's On stage settings 20d's; their rows land with them)
- **A page seated On stage draws the simple view** unless the admin chooses Full for that person, and any page draws it
  where the admin chooses Simple: a backstage page there writes in the simple view's composer (🔥 Priority, the words,
  Send), its words and a reply begun moving with it as the view changes. The join's answer says the view (`view`, its
  last key), and `view` tells each page of the person's again live; no page reloads. **The admin chooses** in the admin page's people rows (a **Chat view** select
  beside Seat, and Chat view ▸ in the row's ⋯) and in the hall page's People panel (the person's ⋯, the admin's own page,
  full view): By seat (simple On stage, full elsewhere), Simple or Full, `admin:setView {roomCode, socketId, view}` (the
  takes module, behind the admin page's gate; for an account from an account's page, `rbac.mayChange` as the Accounts
  page's `PATCH` reads it). A guest's choice is kept by their uid in `pages.json`, an account's on the account; every page
  of the person's and the admin's view of them are told it, and one row says it (`person.view` "Rita (guest) → simple
  view", `user.update` "view → simple"). The admin's people list carries each person's choice (`view`), sent again live to
  the admin's pages in each room a page of the person's sits in (and to no other page, whose list says no view) after a
  choice made there or on the Accounts page. Before, an
  account's view could be set on the Accounts page and no page drew it.
- **One reading column**, at most 46 rem, with no card, no badge, no ⋯ and no right-click menu: the author's name (You
  for one's own; "On stage" after it only where the author sits On stage, backstage said to a screen reader alone), 🔥
  Priority or Question beside it with a rule of their colour, the time, the words at 22 px on a tablet and 20 px on a
  phone (× Text size), and status words at the end of the line: "👍 You: got it" on a message this person got, Sent or
  "Seen by Ana" (a backstage seat's receipt; "Seen by Ana and 2 more") on one's own. Reactions, seen lines under others'
  messages, presence lines, People, To:, the switcher, ✨, 📎 and the question tab are not drawn; the server refuses what
  the seat may not do whatever the view.
- **One response place per screen**: 👍 Got it and ↩ Reply after the words of the newest message from backstage that waits
  for this person (**Got all 3** when three wait, which answers each: three 👍, held together in the outbox in one step,
  each its own send, so none is lost and none made twice), and of each waiting 🔥 message (Got it filled); an older
  waiting message draws none, and a tap on it (or Enter on it in the feed) brings its own row back, for it alone: Got it
  where it waits, and Reply; on one answered (by a 👍 or a reply), Reply alone; on one's own message, a question or a
  line of the room's, nothing. What waits is read from the room's
  messages (this person's 👍, a reply of theirs that quotes it, their answer), never a field of its own. **Got it tells the
  backstage team, with the name**: the reaction row now carries the reactor's seat (`role`), and a backstage page draws
  "👍 Margaret got it" (and "Margaret and Tom", "… and 2 more") beside the reactions. A 🔥 message from another Board
  member gets Reply only.
- **A question**: its words at the body size and weight 600, its answers 48 px, then **Answer in words…** (a field of 200
  characters, asked in place, never a `prompt()`); answered, "You answered Yes · 14:10 · Change" (or the words given),
  Change bringing the answers back (`msg.change`), the one chosen pressed and the answer given said under them until a new
  one replaces it. Another's answer meanwhile leaves the answers and the focus where they are: the question is drawn again
  only when this person's own answer changes. Others' tallies are the backstage team's to read.
- **The 🔥 strip**: the newest priority message from backstage that waits holds a strip above the chat **only while it is
  out of view** (an `IntersectionObserver` on it, or behind the Shown to you tab; without one, always), its words cut to
  three lines (two under 700 px tall, one under 500), Got it after them, "+1 more" with another; Got it answers the one
  shown. The strip is a status region, so its words are written only when they change. While a take covers the page, the take layer's own 🔥 strip has **👍 Got it** beside Open chat.
- Scrolled up, "↓ 3 new · 1 question" names the questions among what came below; with nobody backstage in the room for 10
  s, "○ Nobody backstage is online. Use Help if you need someone." sits over the composer until someone comes back; an
  empty chat reads "Nothing yet. Messages from backstage appear here.".
- **The composer**: **🔥 Priority** first (a pressed toggle, "🔥 Priority" over 600 px wide and "🔥" at 600 or less, its
  name Priority either way, off after every send), the field (18 px over 600 px wide, 16 px at 600 or less, by the width
  alone) ("Message everyone here…" as its label and its placeholder, or
  "Message everyone…" where the long words do not fit the field, measured in its own font), Send; replying, "↩ Replying to
  Tom Okafor: …" with × Cancel and Escape. A refused send keeps its words in the field, the server's words said on it.
- **The header**: the hall's name (muted), the countdown where the hall has one (the clock by default is unit 20b's),
  Help and ⋯, on one row at every width as the header's own unit drew it, save that down 5 s or more "Offline ·
  reconnecting" is a phone's second row (a tablet says it before Help); the seat is said in the sheet's footer. **The ⋯ sheet** (no menu): Text size (Aa− · 100% · Aa+), Theme
  (Light · Dark), Full screen where the device has the Fullscreen API (a probe at load), why the device may sleep where
  the screen cannot be kept awake (`AGM.awake()`, asked as the view starts: HTTPS, its settings or its battery), and Leave
  the hall…, asked in place ("Leave Hall 2? You'll stop getting messages from backstage." · Leave · Stay); a bottom sheet
  on a phone, never taller than the screen (`100vh`, then `100dvh`) and scrolled within it. Text size scales the whole
  chat: the words, names, times, the cue words, the answers, Answer in words…, the response, the answered line and the
  strip; the header and the sheet stay as they are.
- **Shown to you** (the side bar, "📺 Shown to you"): a 360 px column at 900 px wide or more while something is shown (a
  file opened there, a take minimised), its 36 px rail (which names it) while nothing is; under 900 px two tabs, **Chat** and **📺 Shown to you · 1**
  (`aria-pressed` buttons), drawn only while something is shown. A minimised take's card has one act, 👁 Look. On stage
  content keeps no copy there: a long press or a right-click opens nothing (the browser's own menu included), nothing is
  dragged out, and iOS offers no save; the full view's pictures drag as before.
- **Dark until the person chooses Light** (B6): a simple view with no theme chosen draws dark, and the hall page
  remembers the view it last drew (`agm.lastView`), which `theme-init.js` reads on the hall page alone (`<html
  data-page="app">`), so a device last used there paints dark before its first frame; every other page, and the full view,
  read an unchosen theme as light. Light chosen in the sheet sticks. What the admin's support view relays to the person's
  pages now says so (`support: true`), and the simple view takes no theme from it: only the person turns a Board page
  light, and the person's Light still reaches the support view.
- **Only Tab, Enter and Escape act**: the single keys of the full view (R, E, F, P, D) do nothing there, Enter on a message
  brings its row and moves to its response, and the Escape order is an open menu, an open ask, the take layer
  (minimised), the reply, then the composer, from a message as from anywhere else.
- **By size, never by device** (answer 22): the rules above; the viewport meta's `interactive-widget=resizes-content` and,
  where a browser keeps the layout behind its keyboard (an iPad), the page follows `visualViewport.height` while the
  view is at its own scale (a pinch-zoom makes the page no smaller); the header's
  and composer's paddings clear a notch; the view's rules write physical sides only. A reader at the end of the chat stays
  there as the strip, the tabs or the line over the composer come and go.
- **The board rules' mis-scoped selectors** are rewritten: the stylesheet's `body[data-role="director"]` halves are gone
  (the page names the seat `board`), and the left column takes the whole width only on an observer's page, which has no
  side bar. The colour of a control's edge is a token (`--c-edge`); the two board rules this touched draw with tokens (the
  pinned strip's own colour goes, the base rule's `--accent-soft` drawing it, and a question's shadow is `--shadow`), so
  the stylesheet's hex colours outside its tokens go down by one (`test/resilience.test.js`, 253).
- Choices where the plan left room: Answer in words… is the house's ask in place (`AGM.ask`) with one field, rather than a
  field of its own inside the question; Change is a catalogue act (`msg.change`); Leave the hall… ends with "…", as every
  act that asks first does; Cancel reads "× Cancel" (✕ is the table's fault mark); a "Seen by" past two names reads
  "Seen by Ana and 2 more"; the strip waits for the observer's first word before it shows, so it never flashes as a
  message is drawn; Shown to you counts a file opened on the panel and a minimised take; the admin's Chat view applies to any seat in any room, as the Accounts page's does; the full view keeps
  its words and its "↓ n new"; the phone's second header row for Stagewatch's line waits for the readout of unit 20b,
  which owns its words, and until then the header keeps its one row (the name gives way first, then the countdown's
  title); the catalogue's id for the admin's Chat view is `person.chatView`, `person.view` being Open
  their view already; the Accounts page's Chat view stays its editor's select (no `account.view` row).
- Tests: `test/takes.test.js` (new: the join's view by the seat, the admin's choice for a guest and an account told to every
  page of theirs and their support view and nobody else, kept in `pages.json` and on the account, a reload drawing it, the
  people list's `view`, sent again live to the admin's page alone after `admin:setView` and after the Accounts page's
  `PATCH`, one row each, already and refused cases, a manager with `settings.manage` refused an account's; the support
  view's relay marked `support`; a 👍 carrying the seat), `test/catalog.test.js` (the second door, Got it
  never Got all on an older message, Reply alone on one answered by a reply, nothing on one's own message, a question or
  a line of the room's, Change, the sheet's rows and their bounds, Chat view ▸ by page and seat, the facts'
  `tapped` and `changing`), `test/menus.test.js` (`admin:setView` refused as every seat but the admin, in the On stage table
  too; the join's views by seat; the join's last key), `test/inputs.test.js` (`admin:setView` by type),
  `test/pagefloor.test.js` (`theme-init.js`: dark first on the hall page last drawn simple, light everywhere else),
  `test/modules.test.js` ((f)'s allow-list loses `view`, which the hall page hears; (l)'s two readers; the takes module's
  `personKey`; the contexts' parts, `viewChanged` the one added), `test/resilience.test.js` (the hex colours, 253). The
  browser smoke: the device legs, the layout leg and the floor leg's chat-view steps (`docs/DEVICES.md` §6), with the
  admin page's Chat view select and the People panel's Chat view ▸ each choosing a view the server keeps and says back; and, moved on purpose: the phone pass and the takes' doors read an On stage page in the
  full view, which the admin's Chat view gives it live (and By seat gives back); Kim's switcher steps read her account
  with Chat view Full (the simple view leaves the switcher out); the On stage composer reads 🔥 Priority, the words, Send
  and ⋯; the admin page's people heads read Chat view before May forward to.
- The papers: `README.md`, `README.txt`, `docs/ACCOUNTS.md` (the admin's Chat view, `person.view`), `docs/DEVICES.md` (§6, the
  chat view's rows), `docs/DESIGN.md`, `docs/ANALYSIS.md` ((f)'s allow-list), `SECURITY.md`, `CLAUDE.md`.
- Rolling back: 0.5.1 ignores `pages.json` (a guest's view with it) and keeps an account's `view` unread; its Board page
  draws the desk it always drew.

**Unread dots on the room switcher** (the plan's Part 1, unit 21, its §3.4 as Part 5 §0 and §13.6 amend it
(`rooms:activity` a `Latest` of 500 ms whose merge keeps any 🔥), §15.4's switcher row (a dot, not a count, with its
words), §15.9's 1.4.1 row and §16.7's `room` row (Mark as read, set apart); global #56, the one unit §0.6 lets slip,
landed in 0.6.0)
- **A room of the switcher with a message this person has not read** carries a dot after its name: the note's mark (●, in
  its colour role) for a message, 🔥 where a priority message is among them. A dot, not a count. Its words are the room's
  accessible name and its tooltip ("Press, new messages", "Press, priority"; "Smoke AGM › Press · priority"), so it is a
  shape and words, never its colour alone. The note's meaning in the marks' table now reads "something to read, not
  urgent", a screen's message and a room's news alike.
- **What is news**: a message that is not a system line. A presence line, a reaction, a pin, an answer or a help request's
  state is no news. The store keeps each room's newest message and newest priority message by their change numbers
  (`store.news`), read from the messages once and then kept as each comes; a message removed (deleted, or withdrawn by the
  room it was sent from) or a room cleared has it read again, and the pages watching the room are told so at once, so no
  dot stands for a message that has gone, live or after a reload. Which events are news is the op table's
  (`lib/ops.js`: a message, a removal, a clear).
- **What a page is told**: the join's `rooms` and each `rooms:changed` give every room of the switcher its `seq` (its
  newest message's change number) and `prioritySeq` (its newest priority one's), 0 for none, at the end of each row. An
  account's page (an admin's account's included) also joins the watchers of each other room of its switcher
  (`watch:<key>`), and leaves those no longer in it as its hall's rooms are told again or the page moves to another room
  on its own socket; a code page (the laptop's token admin's own among them, which has no switcher) and the support view
  watch none. A message there, one removed or the room cleared tells them `rooms:activity {key, seq, priority,
  prioritySeq}`: the room's key, which the page already has, its newest message's and its newest priority one's change
  numbers as they stand when the frame goes (the page takes them as the room's now), and whether a priority message came
  since the last frame; no words, no sender, no people. It is the eighth frame of state through `Latest`, 500 ms
  (health's `latest.activity`): a burst is its first frame and then one a window, and the frame that holds a 🔥 says so,
  however many plain messages fold in with it (the merge, `ops.mergeNews`, held by a test on a clock of its own).
- **What has been read** is kept in this browser (`localStorage`, `agm.read|<room>|<account>`: a room's key, for a hall's
  Main room its guest code until New code as the page's own address already holds it, and a number, never a word of a
  message or a secret), by room and person: the newest change a page of the person's held in that room while it was
  shown (as its seen receipt is sent), so a tab left open behind another reads nothing. A visit takes a room's dot off as
  the switcher is tapped, and a page of the same browser in another room drops it as soon as it is read (the `storage`
  event). **Mark as read** (the room's right-click, or Shift+F10 on it), set apart after Open, Open in a new tab and Copy
  link, takes the dot off without opening the room, its toast with Undo; with nothing new there (another page read it
  first) its toast says so. A room never read in this browser has its dot while it holds a message: a new device shows
  what it has not seen. Where the browser keeps nothing (a save refused: storage blocked or full), the page holds what is
  read itself, from the numbers its join told it: its dots are the news that came while it is open, and Mark as read
  says "on this page alone: this browser keeps nothing", never that it kept what it could not.
- Choices where the plan left room: `rooms[].seq` is the room's newest message's change number, not the room's own
  change number, so the join's dot and the live one mean the same (the room's number counts presence lines, reactions
  and pins too); `prioritySeq` is appended beside it, so a 🔥 is still a 🔥 after a move to another room (a page
  navigation) or on a page opened after it came; a room read is the room a page was shown in, never one open behind
  another tab; a room never read here counts as unread from its first message; the frame names nobody, so a person's
  own message, written on another device or sent into that room from this one (↗ Send to), lights its room's dot here
  until they open the room (its answer names no room the page watches, and a room's key in it is not worth the dot);
  Mark as read is a catalogue group of its own (`3_mark`, between the ways in and what one hands out or sets up), so its
  menu reads as the plan's whatever else fits beside it; the laptop's token admin's own page keeps the switcher's rule
  (account pages alone), so it has no dots.
- Tests: `test/halls.test.js` (new: a message in the Main room told to the pages that watch it by its numbers and its
  priority alone; a Main-only member, a side room's member without the hall and a code guest told nothing; no page told
  of its own room or of a presence line; the join's newest message and priority one, untouched by a reaction or a pin; a
  burst of ten at most one frame a window after the first, the frame holding the 🔥 carrying it; a room made watched from
  then; the newest message deleted, then the 🔥, each told live and the join reading the same; a page moved to another
  room on its own socket watching its new switcher's rooms and not its own; a room cleared told as none; and the
  switcher's rows with their numbers), `test/units.test.js` (`store.news` across messages, system lines, a pin and a
  reaction, a reload from the log and from the snapshot, a removal, a clear and a message from before messages carried
  their seq; which events are news, and the frame's merge on a clock of its own: ten messages in one window two frames,
  the second carrying the fifth's 🔥, and a 🔥 folded with a removal still said), `test/catalog.test.js` (Mark as read on
  a switcher's room with news, a 🔥 one offline, never on this room, the halls board or the simple view; its group of
  its own, set apart before Copy guest code and Set up were they to fit beside it), `test/server.test.js` (health's
  `latest` adds `activity`), `test/resilience.test.js` (the state frames' names add `activity`). The browser smoke:
  Kim's switcher in Main
  lights Press's dot for a message there, with its words, and 🔥 for a priority one; the room's doors offer Mark as read,
  which takes the dot off, Undo putting it back; a visit to Press takes it off, and back in Main it stays off; a page of
  Kim's whose storage refuses every save opens with no dot on Press, lights it for a message that comes, and its Mark as
  read says it holds for that page alone; the switcher's first steps read each room's name (a dot follows it) and
  Press, never read there, with Mark as read.
- The papers: `README.md` (and its marks: ● a note, or news in a room of the switcher), `README.txt`, `docs/DESIGN.md`
  (the eighth frame), `docs/ACCOUNTS.md`, `docs/ANALYSIS.md` (the room's menu, and the matrix's count, 74 sets and three
  of This laptop), `docs/NODES.md` (health's `latest`), `SECURITY.md`, `CLAUDE.md`.
- Rolling back: 0.5.1 has no switcher; the read marks stay in the browser, unread.

**A first open carries the newest 200 messages; older ones come on request** (the plan's Part 5, unit 32, its §11 and §9
rows, with §0's amendment of §3.3 (the join's `history` windowed), §13.3.2's trade-off (frames undeflated, so a first
open would grow with a hall's whole day), §14.2 (`history:before` in `lib/handlers/rooms.js`) and §15.10's
`requestIdleCallback` row; global #57, landed in 0.6.0 without a reading by the owner's answer 33, "Yes they can,
Unknown quantities.", to remote phones through the tunnel. No number is quoted: reading 1 times Show earlier and a room
switch at the largest hall's size, and keeps or changes the 200 with it)
- **A first open** (a join that names no change it holds, or one whose gap the server no longer holds) carries the
  room's newest 200 messages (`history`, oldest first), and, appended at the end of the answer, whether the room holds
  messages before them that it did not carry (`more`), what a page keeps in view from before them however old (`older`,
  in the room's order: every pinned message, every help request not yet resolved, every question nobody has answered
  yet) and an index of every file of the room (`files`: each one's message id, address, name and kind), so a list of the
  room's files is whole without its messages. Each message is the room's record as a page is sent it (`forPage`, no
  link). A resume is unchanged: just what the page missed, and none of these keys.
- **Earlier messages** come a page at a time: `history:before {beforeSeq}` (in `lib/handlers/rooms.js`, behind the gate:
  seated in a room that is still here, then one token of the connection's chatter bucket) answers the 200 messages
  before the first message whose change number is `beforeSeq` or later, oldest first, and whether any came before those
  that a first open does not carry (`more`: where only the messages a page keeps in view are left, it holds them already,
  and there is nothing more to show). It names no room: a page reads only the room it sits in, every seat and the
  support view alike. A `beforeSeq` that is not a whole number above 0 is refused with words ("Say where to read back
  from: …"), never read as none. A message kept from before messages carried their change number is read by its place
  among the others.
- **A message pinned since a page opened**, earlier than what the page holds, is read by its id: the page hears the pin
  of a message it does not hold and asks `history:message {messageId}` (beside `history:before`, behind the same gate
  and bucket, of the page's own room only; an id the room holds no message by is refused, "That message is not in this
  room any more."), asked again after a second for the rate or no answer, and holds it among the older ones, in its
  pinned strip and in the feed in the room's order, so every pinned message is in view on every page, as it was when
  every page held every message. The pinned strip draws every pinned message the page holds at once, drawn in the feed
  yet or not, so a first open's pinned agenda is there before its older messages are drawn.
- **A reply whose quoted message has gone from the room** (its author or the admin removed it) is sent with its quote
  marked `gone` (`replyTo.gone`, in a first open, a read back and a message read by its id: a copy, the record
  unchanged), and a page that hears a removal marks the replies it holds the same, so such a quote never offers Show it
  and no read goes back through the day for a message that is not there.
- **On the hall page** the newest 60 of a first open are drawn at once, the reader at the end, and everything else it
  holds above them a chunk at a time as the page is idle (`AGM.idle`: each chunk stops when its 8 ms are spent; on a
  browser without `requestIdleCallback`, its timer), newest first, the reader's place kept, so the run of messages a
  first open sends and the feed it draws at once no longer grow with the day (what still grows with it is the room's file
  index and the earlier messages a page keeps in view), and the page answers a tap while the rest is drawn. The older messages
  a first open keeps in view are drawn above the newest in the room's order. **Show earlier** sits above the oldest of
  the newest run while the room holds earlier ones (the catalogue's new kind `earlier`, its one act `earlier.show`, verb
  `history:before`, mode `now`: shown to every seat, disabled with why offline and in the support view): it draws the
  200 before above, each taking its place among the older ones already drawn, the message the reader was reading kept
  where it was on the screen, and goes once nothing earlier is left. A reply whose quoted message is earlier than those
  held says "**Earlier — Show it**" in its quote: Show it reads back, a page at a time, until that message is there, and
  goes to it (as a tap on a quote whose message is drawn always did); a quote whose message has gone from the room says
  so. A read that fails keeps its own words in the toast (no answer, or the server's refusal); "That message is not in
  this room any more." is said only where the room was read back to its start without it, or its removal was heard.
  Show earlier pressed during a read is that read; Show it pressed during a read for something else follows it and
  goes to its message. A page of messages the page held already (those kept in view) is followed by the next before
  Show earlier is drawn again. An answer is held in the callback that hears it, before any change heard after it, so a
  change made just after the server read a message is in it.
- **A change to a message the page does not hold** (a reaction, a pin, an answer, a help request's state) changes
  nothing drawn; the message, read later, is the server's record as it stands, the change in it. A message the page
  holds but has not drawn yet is held from the moment it comes (in the room's order), so a change heard while it waits
  is in it when it is drawn, a question's answers among them (`updateActionResponses` keeps them on the record before it
  looks for one drawn). A message removed while it waits is never drawn.
- **Holding's pictures** in Screens & pages read the room's file index, so a picture shared hours before the window is
  still offered.
- Choices where the plan left room: the window counts every entry of the room (a presence line too), as `history` always
  has, and pages back by the same 200; "open help" is a request not yet resolved (open, or someone on the way), and an
  "unanswered prompt" a question with no answer from anyone yet; the older messages a page keeps in view ride in a key
  of their own (`older`), not inside `history`, so `history` stays the newest run and its first message's change number
  is where Show earlier reads back from; `more` is true only where something before the window was left out (a room
  whose every earlier message is pinned has nothing more to show); `files` lists every file of the room, not only those
  outside the window, so a page keeps one index current from the join and the changes it hears; the new keys are
  appended at the end of the join's answer, after `view` (and the support view's `person`); Show earlier is a catalogue
  kind of its own, and Show it the same act with the quoted message's id (`find`), so both are drawn from the one row;
  Show earlier waits until what a first open holds is drawn, and a page reads one page at a time; a read refused for the
  rate is asked again after a second; Show earlier and Show it in the support view are drawn disabled, as every door
  there is (the admin reads a room whole on the admin page); a quote of a message the page does not hold says Show it
  only while the room holds earlier messages; a quote of a removed message keeps the words it quoted, as it always has
  (only a withdrawal takes them out), and says it has gone only in its title; a message pinned since is held only while
  it is still pinned when its answer comes, and one the room no longer holds is left; a 🔥 message older than the window
  that still waits for a Board member's Got it is not carried by a first open (the plan's list of what a page keeps in
  view is pinned, open help and unanswered questions; what waits is per person), so after a reload it no longer shows as
  waiting in the simple view unless it is pinned.
- Tests: `test/units.test.js` (new: `store.firstOpen` and `store.before` on 510 messages: the newest 200, the pinned
  message, the open help, the one on the way and the unanswered question from before them and not the resolved help or
  the answered question, `more`, every file, the records themselves; the 200 before, then the rest; nothing before the
  first; past the newest change the newest page; a message without a change number read by its place; an answer, a
  resolution and an unpin taking a message out of what is kept; a room whose every earlier message is kept has no more,
  and a read back whose only earlier messages are kept says no more and still reads them when asked; a reply whose quoted
  message was removed marked `gone` in a first open, a read back and `readMessage`, its record unchanged, a reply to a
  message still there and one to a withdrawn message the records themselves; an id the room holds none by read as none;
  a cleared room), `test/server.test.js` (new, end to end on a room of more than 400 messages: a join's window, `older`,
  `files` and `more`, at the end of the answer, a reply to a removed message marked `gone` and one to an earlier message
  not; read back to the start a page of 200 at a time, every message once in the room's order, a reaction made meanwhile
  to a message not held in it when it comes, the removed message never; nothing before the first; a question pinned
  after a page opened heard as a pin alone and read with `history:message` as it stands (pinned, its answer in it), a
  removed message and an unknown id refused in their words; a page in no room refused both verbs, each `beforeSeq` that
  is no whole number above 0 and each `messageId` that is no id refused in its words, a burst of both past the chatter
  bucket refused for the rate with `busy`; a resume with none of the new keys), `test/inputs.test.js` (`beforeSeq` and
  `messageId` null and unconvertible to both verbs, from a guest and from the admin's page in no room), `test/catalog.test.js` (the
  kind `earlier`: every seat shown Show earlier and Show it while the room holds earlier messages and none once it does
  not, offline and the support view disabled with why; the required verb `history:before`), `test/menus.test.js`
  (`history:before` the second verb no right hides, with why; the join's last keys gain `more`, `older` and `files`, on
  purpose, as `test/takes.test.js`'s do); `test/busy.test.js` is unchanged, its fence (every verb a handler registers
  is input or a read) holding `history:before` and `history:message`, which `lib/busy.js` names as reads, so reading a
  room back makes no hall busy. The browser smoke, on a hall of a long day (sixteen
  people, more than 250 messages): with the page's idle work held, the newest 60 of the window drawn and the other 140
  held, the reader at the end; a reaction to a message the page does not hold changes nothing drawn; let idle, the rest
  drawn above in the room's order and Show earlier above the oldest; read from the top, Show earlier draws the earlier
  ones above, the message the reader was reading in place to 2 px, the reacted message with its reaction, and goes; a
  fresh page's reply to the day's first message says "Earlier — Show it", and a reply to a message its author removed
  says nothing of the kind, its title saying the message has gone; a read back the server refuses keeps its words in the
  toast and the quote keeps its Show it; Show earlier and then Show it pressed at once: Show it follows the read and goes
  to the first message; at the floor (no `requestIdleCallback`) the rest drawn by `AGM.idle`'s timer, with no script
  error; a message pinned by someone else after the page opened, earlier than it holds, comes to its pinned strip and
  its place in the feed, in the room's order, Show earlier still above; and the removal of a message the page does not
  hold, heard, takes the Show it from the quote of it.
- The papers: `README.md`, `README.txt`, `docs/DESIGN.md` (the sequence row and the frames row), `docs/DEVICES.md`
  (`requestIdleCallback`'s row, the floor leg), `docs/ANALYSIS.md` (the kind `earlier`, the fuzz's keys), `SECURITY.md`,
  `CLAUDE.md`.
- Rolling back: 0.5.1 reads no `history:before` or `history:message` and sends a first open whole; a 0.6.0 page served by it shows no Show
  earlier and lists the files of what it was sent. A 0.5.1 page cached across the upgrade draws the newest 200 alone,
  without the older ones kept in view, until it reloads onto 0.6.0 (it is told to, 5 minutes after the start).

**An archive or an image is checked at upload, before anyone opens it** (the plan's Part 4, unit 22, its §5.10.1
(`public/zipcore.js` and `lib/zipcheck.js`, one check with two callers), §5.10.3's refusals and bounds, §5.11's
`upload.refused` row and its 0 synchronous calls, §5.9.3's `STAGE_TYPES` and §4.6.7's `TRANSFER_ONLY`; global #58)
- **A Word, Excel or PowerPoint file** (docx, xlsx, pptx) has its archive read before it is kept: its end record, its
  ZIP64 end records where it has them, and its central directory, read through `fs.promises` with nothing inflated
  (`lib/zipcheck.js` over `public/zipcore.js`). It is refused with "That file is packed in a way AGMessage will not open.
  Share it as a PDF." when it declares more than 2,000 parts (refused before its directory is read), a directory over
  1 MB (likewise), more than 200 MB unpacked in all, a part of more than 100 MB unpacked or packed more than 200:1 (a
  ZIP64 size held to the same, one past what a double holds read as past every bound), an encrypted part, two parts
  whose data overlap (one compressed stream read as several files), sizes its bytes cannot hold (a stored part whose two
  sizes differ, a part whose data would run into the directory), a method other than stored or deflate, a second disk,
  an end record whose counts or offsets disagree with its directory, or no `[Content_Types].xml`; and with "That file
  carries macros. Save it without them, or as a PDF." when it holds a `vbaProject.bin` (a `.docm`, `.xlsm` or `.pptm`
  renamed). 0.5.1 checked only its first four bytes.
- **The directory checked is the one the pages' readers open.** SheetJS's zip reader and JSZip (inside mammoth) take
  the last end record signature in the file, JSZip the last ZIP64 locator too, and JSZip reads a gap between a
  directory's records and its end record as bytes before the archive, moving every offset by it. So the check reads only
  the archive's last 98 bytes for its records and refuses, in the "packed" words, an end record that does not end the
  file or carries a comment (Office and LibreOffice write none; none of the files measured has one), an end record or
  locator signature after the one it chose, a ZIP64 end record that is not right before its locator or carries
  extensible data, ZIP64 records under an end record that marks none of its fields as held there, and a part with two
  ZIP64 fields (readers differ on which they take). A test runs the vendored SheetJS and mammoth over every archive the
  check passes and finds the parts its directory names, and no others.
- **A picture** (png, jpg, jpeg, gif, webp) has its size read from its header (`lib/imagesize.js`): PNG's IHDR, WebP's
  VP8, VP8L or VP8X header, a JPEG's frame header (SOF0 to SOF15) found by a walk over its segments' markers, each read
  at its offset, so 80 KiB of metadata before it is skipped unread, and a GIF's logical screen grown to hold its first
  frame, found by a walk past its colour table and its extensions' sub-blocks, read in windows of 64 KiB: a browser's
  decoder grows the image so, and a 1 × 1 screen would otherwise hide a 20,000 × 20,000 frame. Each walk takes at most
  64 segments or blocks and reads nothing past the file's first megabyte. Over 100 megapixels it is refused with "That
  image is too large to show."; a size that cannot be read (a header the reader does not know, a size of 0, a scan
  before any frame, a GIF that ends before its first frame, a walk past its bounds) with "That image cannot be read."
  0.5.1 kept any file whose first bytes matched.
- **A refused upload is not kept**: it leaves the disk before the answer, the page shows the server's words where the
  file would have been, and the hall's audit log has one `upload.refused` row by its uploader at the upload's own
  address (its token is a bearer's, so not always the page's socket's), its target the hall's key, its words what the
  file was refused for and the bound it broke ("a docx: 12,000 parts (bound 2,000)", "a docx with macros", "an xlsx: a
  part packed 1,016:1 (bound 200:1)", "a png of 400 MP (bound 100)", "a jpg whose size cannot be read"), never the
  file's name. One another program holds (an antivirus) is the uploads' sweep's at its next pass, within a minute, in
  no room and posted by nobody; that record is the run's, so a restart before the pass leaves the file on disk, named
  nowhere, until the boot sweep (the stage file's unit) removes it.
- **A check that cannot finish** (the stored file could not be read) refuses the file rather than keep it unread, in
  words of its own: 503 and "That file could not be checked, so it wasn't shared. Try sending it again.", its row "a
  docx that could not be checked", never the words of a check that found something. Which check a type has, and these
  refusals, are `lib/uploadcheck.js`'s (new), so a test reaches the case.
- **The archive's bounds, measured:** the plan's numbers, each at four times or more the largest of Office's samples
  measured for it, written in `test/zipcheck.test.js`: Word's and PowerPoint's own templates (as python-docx and
  python-pptx ship them; 36 parts the most, its largest part 438,677 bytes, its highest ratio 32:1, its largest
  directory 2,834 bytes) and mammoth's 17 Word test documents. Three files made for the measurement, generated words,
  numbers and pictures saved by LibreOffice 24.2.7 (a 60-slide deck, a 150-page paper, and a 60,000-row budget from
  random numbers whose sheet is 38.1 MB), are stress rows, not board packs: each passes every bound, and none sets one.
  Every file measured passes, and the server's reader and a reader over the bytes held agree on each. Not measured: the
  owner's own board packs, and whether ZIP64 appears in machine-written Office files (none of those measured used it);
  when the owner's packs are measured, their rows set the bounds.
- **The image bench** (the largest picture the device matrix's D1 and D2 decode and draw) is a record in
  `docs/DEVICES.md` §7, not measured: it sets the stage's bound on a picture shown to the Board (40 megapixels until it
  is read, the stage's file unit), not the upload's.
- **The stage's file types:** `lib/pages.js` names `STAGE_TYPES` (pdf, png, jpg, jpeg, gif, webp, txt, md, csv, xlsx,
  xls, docx and pptx: every upload type) and `TRANSFER_ONLY` (none yet: the files to transfer only come with their own
  unit). The checks run on a stage type that is not a transfer-only one.
- Choices where the plan left room: a refusal answers 400, as a file whose contents do not match its type does (503
  for a check that could not finish); the audit row's target is the hall's key whichever of its rooms the upload was
  for; "lying sizes" read as sizes the archive's own bytes cannot hold (the check inflates nothing, so a directory that
  understates what a part inflates to, its local header agreeing, is the document reader's bound to stop, unit 23's
  counting reader), and those refusals, an unread end record and the like, say the one "packed" line; the JPEG walk's
  "1 MB read" read as nothing read past the file's first megabyte (each segment's marker is a few bytes read at its
  offset); the plan's "GIF's screen" read as the screen a browser draws, grown to hold the first frame; the archive core
  is under the coverage gate through `require`, as `lib/` is.
- Tests: `test/zipcheck.test.js` (new; every zip built in the test with `node:zlib`, no binary fixture: Word, Excel
  (streamed with data descriptors) and PowerPoint files laid out as their applications lay them out, one in ZIP64 and
  one whose ZIP64 field follows another extra field, pass; 10,000 entries, a directory declared at 2 MB, a part running
  into the directory, a stored part whose sizes differ, three parts on one stream, a 1,016:1 part, an encrypted part,
  no `[Content_Types].xml`, a `vbaProject.bin`, 270 MB declared in all, a 170 MB part, ZIP64 parts of 1 TB and of 2^60
  bytes, an end record with a comment, an end record signature inside the end record's own fields, ZIP64 records under
  an end record that marks no field, a ZIP64 end record with extensible data, bytes between it and its locator, a part
  with two ZIP64 fields, and every shape above each get their verdict, the same through `lib/zipcheck.js`'s file reader,
  the worker's byte reader over a Buffer and over an ArrayBuffer, and the core run as a classic script with no `module`
  (as the worker will load it, `AGMZip`); 10,000 entries and the 2 MB directory refused with only the archive's last 98
  bytes read; the measured table, the bounds at four times Office's samples or more and every made file within them;
  every upload type whose first bytes are a zip's and which the stage shows checked as an archive; the words; a check
  that cannot finish (a file gone before it, a folder where the file was) refused with its own words, and the types no
  check reads left unread; the vendored SheetJS and mammoth, run in the test as a page runs them, reading every archive
  the check passes as the parts its directory names; and end to end, the seven refusals of the plan's list and a
  comment's each answered 400 with its words, nothing kept, one `upload.refused` row each by its uploader in the hall at
  the upload's own address, no row naming a file, and the four that pass kept whole), `test/imagesize.test.js` (new:
  PNG, GIF (89a and 87a, with and without a colour table, after an animated GIF's extensions, a frame inside its
  screen), WebP's VP8, VP8L and VP8X, a JPEG whose frame header follows 80 KiB of APP1 (its walk reading the markers at
  their offsets and 29 bytes in all), a progressive JPEG and fill bytes read; twenty-one unreadable headers refused, a
  GIF's frame of no width, a GIF that ends before its frame and one cut short among them; 63 segments or extensions
  before the frame read and 64 not, the JPEG's walk reading SOI and 64 segments and no more; a frame past the first
  megabyte refused with nothing read past it, a GIF's in windows, and one after 200 KiB of metadata found; a GIF whose
  1 × 1 screen holds a 20,000 × 20,000 first frame (89a and 87a) read as the frame, and a frame past its screen's edge
  growing it; 100 MP passing and one row more refused, 400 MP PNG and JPEG refused; every picture upload type read; and
  end to end, the 400 MP PNG, JPEG and GIF and an unreadable JPEG answered 400 with their words, nothing kept, one row
  each naming no file, and a PNG, a WebP, a GIF and a JPEG within the bound kept whole), `test/pages.test.js` (the
  stage's types are the upload types, none transfer-only yet), `test/resilience.test.js` (`lib/uploadcheck.js`,
  `lib/zipcheck.js`, `lib/imagesize.js` and `public/zipcore.js` named at 0 synchronous calls; `server.js` where it was),
  `test/modules.test.js` (a server file
  requires a page script only by a row of `PAGE_CORES`, `lib/zipcheck.js` → `public/zipcore.js`, and that core loads
  nothing and exports itself both ways). The tests that upload a picture upload a whole one (`test/helpers.js`
  `pngOf`), since a picture's size is now read: `test/halls.test.js`, `test/onstage.test.js`, `test/server.test.js`,
  `test/takes.test.js` and `test/uploads.test.js` move on purpose; the browser smoke's pictures and Word file were whole
  already. ESLint gives `public/zipcore.js` a block of its own: no Node or page global (the pages' own names and their
  libraries' included), `module` for its export only, nothing loaded.
- The papers: `README.md`, `README.txt` (the refusals' words), `SECURITY.md`, `docs/DESIGN.md` (checked before it is
  opened), `docs/ACCOUNTS.md` (`upload.refused`), `docs/ANALYSIS.md` (the guard's files, the core's lint block, the page
  core in the module fence), `docs/DEVICES.md` (§7, the benches), `CLAUDE.md`.
- Rolling back: 0.5.1 checks no archive or picture past its first bytes, and reads no `upload.refused` row (the audit
  log keeps it, as every row). A file 0.6.0 refused was never kept; one it kept is the bytes uploaded.

**Files are read in the page by bounded readers into one block model; Word has pages; the PDF worker may draw JPEG 2000**
(the plan's Part 4, unit 23, its §5.10.1 (`public/docmodel.mjs`, `public/docview.mjs`, `public/docworker.js`,
`public/wordpages.js`), §5.10.2's rules for pdf.js, SheetJS and mammoth, §5.10.3's refusals and bounds, §5.10.4 (Word's
pages, the owner's answer 14), §5.10.5 (`CSP_PDF_WORKER`, the owner's answer 15), §5.9.6's page box, zoom, find and kept
place, and the hidden things of revision 3 (the owner's answer 13, "Hidden things never shown"); global #59)
- **The readers left `app.js`.** The On stage panel draws a file through `public/docview.mjs`, imported at the first file
  opened, over pure readers in `public/docmodel.mjs`: one block model (headings, paragraphs, items, quotes, code, tables
  on their grid, pictures) for every type. `buildDocPreview`, its renderers, `loadPdfJs` and `sanitizeHtml` (with its two
  `innerHTML` sinks) are gone from `app.js`, and the hall page no longer loads mammoth or SheetJS. What each type looks
  like now: a **CSV is a grid** (RFC 4180, its delimiter sniffed among `,` `;` and tab, a byte-order mark dropped; 0.5.1
  drew it as text), a text file is its lines (UTF-8, else windows-1252, as Excel and Notepad save), Markdown is its
  blocks (headings, paragraphs, items, quotes, fenced code, pipe tables; inline marks as typed), **PowerPoint is an
  outline** (each slide's title, its points by level, its tables and pictures; 0.5.1 had no preview), and **Word and
  Excel keep their words, tables and pictures but no longer their inline styling** (bold, italic, colours, links; a
  workbook's `sheet_to_html` styling). A sheet or a CSV shows its first 5,000 rows ("Showing the first 5,000 rows.") and
  its first 256 columns ("Showing the first 256 columns."), and at most 100,000 cells, so a wide one's rows are cut to
  fit ("Showing the first 390 rows."); a table in a Word file, a deck or a Markdown file is held to the same 256 columns
  and 100,000 cells ("Showing the first 12 rows and 256 columns of this table."); a text or Markdown file shows its first
  20,000 lines ("Showing the first 20,000 lines."). A sheet's rows are counted from its first, so one whose data begins
  lower down is said cut where it is. A formula is never computed: the value its application saved is shown, and one
  saved without a value reads "formula — no saved value", whatever its type (a text, a true or false, an error), never a
  blank, FALSE or "undefined".
- **The page box, zoom, find and the kept place.** A bar above the document: a number to type, ‹ ›, "of 48", PageUp and
  PageDown (the page of a PDF, the slide of a deck, the line of text or Markdown, the row of a CSV, a workbook's sheet
  tabs); for a PDF or a picture, −, Fit width, Fit page, + and a pinch; and a find box whose Next goes to each match, on a
  page not drawn yet too. A resize, a collapse or the splitter keeps the page, the zoom and the place within the page:
  the view is laid out again where it was, and a PDF is no longer fetched and drawn again whole. Folded away, the view is
  left as it was and its place stands (a page asked for meanwhile is kept for later); opened again, it goes back there by
  itself. 0.5.1 showed a read-only page chip and rebuilt the PDF from the top.
- **Word has pages** (the owner's answer 14). They are the ones Word wrote into the file (`public/wordpages.js`, a tag
  scanner over the parts' text): where Word saved its layout (`w:lastRenderedPageBreak`), a paragraph's page is 1 + the
  breaks before it and the page box reads "p. 12 of 30"; where it did not (a file from a tool with no layout), the
  explicit breaks (a page break, `w:pageBreakBefore` set or through its style's `w:basedOn` chain, a section that
  starts a new page) give pages that are lower bounds, read "≈ p. 12 of ≈ 30" with "Word's last saved layout is missing
  or out of date: pages are approximate" as its title, as does a file whose `<Pages>` disagrees with its breaks. Each
  drawn block is placed on Word's paragraph by its text; one that cannot be is approximate. A section that numbers its
  pages its own way adds "the printed page numbers differ here". The AI's text of a Word file marks where each page
  starts ("— p. 12 —", "— ≈ p. 12 —"), so a draft can cite a page.
- **Word, Excel and PowerPoint are read in the document worker** (`public/docworker.js`), never on the page: one worker
  per file, ended when it answers, 15 s after it starts, or when the document is closed, whichever is first ("This file
  took too long to read, so it is not shown.", and on a backstage seat "⬇ Download opens it in its own application.").
  It holds the file to the upload's archive check again (`public/zipcore.js`, the server's own core), and every entry's
  name to the one every reader finds: printable ASCII, a canonical path (no `.` or `..` part, no empty one, no leading
  `/` or `\`), the same in its local header, which JSZip inside mammoth reads it from, as in the directory checked, and
  none twice whatever its case; a folder entry with data in it, or any of these, is "packed in a way AGMessage will not
  open". The archive check itself, at upload too, now refuses an entry carrying an Info-ZIP Unicode Path field, a second
  name JSZip would read in place of the one checked. It inflates each part with `DecompressionStream('deflate-raw')` no further than its declared size, and refuses a
  file any entry of which, whatever its name or encoding (UTF-16 too), declares a document type or an entity before
  SheetJS, mammoth or AGMessage's readers see it. A workbook is held to the archive check by its bytes, not its name: an
  `.xls` is read as an Excel 97-2003 file only when it is one, and anything else is refused. mammoth and SheetJS load in
  the worker only, each for its own task; SheetJS reads with `dense`, `sheetRows`, no HTML and no VBA, and the worker
  hands the page no more than a sheet's first 256 columns and 100,000 cells. mammoth's xmldom advisories (`VENDOR.json`'s
  `xmldom-parse`) are now bounded by that worker's 15 s. A device without `DecompressionStream('deflate-raw')` (below
  the document floor, Safari 16.4 and Chrome 103: the matrix's D1) now reads "this device cannot open documents — ask
  for a picture" for a Word, Excel or PowerPoint file on the panel, where 0.5.1 drew Word and Excel through the page's
  own mammoth and SheetJS; a picture reaches it through the stage's stand-in, with the stage's devices unit.
- **Hidden things are never shown on the Board's pages** (the owner's answer 13). On every seat but backstage (the
  admin's support view reads as backstage) hidden sheets ("very hidden" alike), rows and columns, hidden slides, a
  Markdown comment and hidden raw HTML are not drawn, and a line above the document says how many were left out ("1
  hidden row and 1 hidden column not shown", "2 hidden sheets not shown", "1 hidden slide not shown"); a backstage seat draws hidden
  rows, columns, sheets and slides muted and marked "hidden", so the researcher knows what the file holds. A slide's
  shape, picture, frame or group marked hidden is never read with all it holds, and presenter notes are never opened.
  **Word's hidden text never reaches mammoth**: every run hidden by `w:vanish` or `w:specVanish` (on the run, through its
  character style or its paragraph's style, through the style of each table it sits in or the default table style,
  through a `w:basedOn` chain up to 10 links, or by the document's defaults) is removed from the main document, the
  footnotes, the endnotes and the comments, each found as mammoth finds it (the package's relationships, then the main
  document's, under whatever names, else the fixed ones: `wordpages.js` `partsOf`) and judged by the styles part mammoth
  reads, and mammoth is handed a copy of the file repacked with those parts (`zipcore.repack`: every other part's bytes
  copied as they are, the replaced ones stored with their CRC-32); `w:val="0"` keeps a run. A hidden mark that cannot be
  resolved refuses the file: "This Word file has hidden text AGMessage could not leave out — show a picture or a quote."
  Those are a chain past 10 links, a style the file does not have or writes twice, a table style whose conditional
  format (its first row, its bands) hides text, a run's mark or a table's style read after the text it governs began, and
  WordprocessingML bound to a prefix other than `w` or as the default namespace, which mammoth, reading namespaces,
  would read and the scanner could not; where a file names more than one default style of a type, each is read, and any
  that hides hides. A relationships part written any other way than Office writes one is refused
  too ("This file cannot be read."). mammoth 1.13.0 drew hidden text as ordinary text; tracked deletions and comments it
  leaves out, as before. The AI's text leaves every hidden part out on every seat.
- **The AI's copy of a document's text is read only on a backstage seat** (and the support view), capped as before
  (80 pages of a PDF, 60,000 characters). A Board page reads none.
- **Pictures in a document are the page's own.** mammoth's pictures leave the worker as bytes with a placeholder
  (`agm-img:<n>`), and the page draws each through an object URL it makes and revokes with the document, never an
  address from the file or the worker. A picture's size is read from its header before anything decodes it, by the
  reader the server's upload check uses, now a core the server, the page and its worker share (`public/imagecore.js`;
  `lib/imagesize.js` keeps its file reads and words): in the worker for a picture inside a Word file or a deck, which
  then leaves without its bytes, and on the page for a picture shared on its own, before it is decoded. One over 40
  megapixels is never decoded on the device ("This picture is too big for this device."), and one in EMF or WMF, or
  whose size cannot be read, reads "a picture this browser cannot show". An external picture or a link is never
  fetched, and nothing is live. Every reader fetches its file with `cache: 'no-store'` (a PDF is read by pdf.js's own
  range requests).
- **HTML is parsed in one place** (`parseInert`, in `public/docmodel.mjs`): an inert `<template>`, walked into plain
  data, with `<style>`, `<script>`, `<noscript>`, `<template>` and anything marked `hidden`, `display:none` or
  `visibility:hidden` left out, and no parsed node put in the page, where a `<meta http-equiv=refresh>` would have
  navigated a Board tablet and a `<style>` applied. mammoth's HTML and a Markdown file's raw HTML reach the page only
  through it. A new lint rule, `agm/inert-html`, holds the documents' modules to it.
- **pdf.js**: one worker for the page's life, each document destroyed when it closes (0.5.1 never destroyed one on the
  hall page), pages fetched as they come into view rather than every page up front, no image over 16,777,216 pixels
  (`maxImageSize`), and a deadline: a PDF whose first page is not drawn within 20 s is failed with "the file took too
  long to read", and its loading and the shared worker are destroyed, the next PDF making a new one. Script, XFA, `eval`
  and annotations stay off. A screen runs pdf.js the same way (`display.js`): no image over 16,777,216 pixels, and a PDF
  whose first page is not drawn within 20 s fails its take with "the file took too long to read", its loading and the
  screen's worker destroyed, the next PDF drawing through a new one.
- **JPEG 2000 pictures in a PDF draw** (the owner's answer 15), on the panel and on screens: pdf.js's worker decodes
  them with WebAssembly, which its own response now allows (`CSP_PDF_WORKER` in `lib/guard.js`: the strict policy with
  `script-src 'self' 'wasm-unsafe-eval'`, given to exactly the pdf.js worker files `VENDOR.json` lists, by path, never
  to a page, pdf.js's own module or the document worker). Under the page's policy the worker could not compile its
  decoder, and those pictures were left undrawn.
- Choices where the plan left room: the PPTX outline reads its parts with a small XML tree reader in
  `public/docmodel.mjs`, not `DOMParser`, so it runs under `node --test` (it refuses a declared document type as the
  worker does); a picked word, line or cell (`pick`) and the PDF text layer are the stage's picks unit's, so the view
  answers `place`, `goto`, `visible`, `find`, `text` and `destroy` now; SheetJS reads with `cellFormula` and `cellStyles`
  on (the formula's text never leaves the worker, nothing is computed), since without them a formula saved without a
  value, and hidden rows and columns, cannot be told; a rendered break or a page break before any of a paragraph's text
  puts the paragraph on the next page, rather than spanning two; a Word style the file does not have is a hidden mark
  that cannot be resolved, as the plan lists it, so a file naming one is refused; a chain past 10 links for a page break
  only makes the pages approximate, but the same chain refuses the file where it could hide a run; a PDF is read by
  pdf.js's own requests (ranges), whose caching is the upload's response's, `no-store` from the stage's file unit;
  mammoth and SheetJS are listed as running in a worker (`runs: worker`); a formula saved without its value is told
  apart from a saved FALSE or "" by the worker writing such a cell, in the copy SheetJS reads, as an error with no
  value (`t="e"`, its `<v>` taken out), the one shape SheetJS leaves without a value; a sheet's rows are cut where
  SheetJS cuts them, at the sheet's 5,000th row; the column bound is 256, an Excel 97-2003 sheet's whole width, and the
  cell bound 100,000, the first draw of 5,000 rows at 20 columns; a table cut keeps its spans inside the cut.
- Measured, in headless Chromium in the build container: a 2,316-byte workbook with cells at A1 and XFD1000 read by the
  worker as 1,000 × 16,384 = 16,384,000 cells in 3 s (362 MB in Node), and 5 MB of commas parsed on the page to one
  row of 5,000,001 fields and planned in 2.7 s before any of it was drawn; the first draw of a grid grows with its
  cells: 50,000 in 1.9 s, 100,000 in 2.0 s, 130,000 in 3.9 s, 250,000 in 4.2 s, 500,000 in 9.1 s, 512,000 (2,000 × 256)
  in 13.2 s. The same workbook now reads as 390 × 256 = 99,840 cells in 0.15 s, the commas as one row of 256 in 0.05 s.
  Not measured this round: the 5,000-row, 100,000-cell and 20,000-line first draws on the rig's laptop and the device
  matrix's D2 and D4 (the plan's bench), and Word's pages against Word's own for ten paragraphs of each of the owner's
  files (the fixture README's bench); the bounds are these numbers until then.
- Tests: `test/docmodel.test.js` (new: text decoded by its byte-order mark, UTF-8 or windows-1252; RFC 4180 CSV with
  quotes, line ends and "" and the delimiter sniffed; the 5,000-row and 20,000-line bounds and their words, the worker's
  row bound the same number; Markdown's blocks with their lines, pipe tables, a comment left out over lines and kept in
  code, raw HTML read by the inert reader or left out; the occupancy grid's column C; HTML walked into plain data that
  `structuredClone` takes, without `<style>`, `<script>`, `<noscript>`, `<template>`, a refresh, hidden elements or a
  picture not the worker's; the XML reader refusing a declared document type; a deck's outline in its order, its hidden
  shape, picture and group and its notes absent, a `show="0"` slide marked and absent from the Board's and an
  observer's drawing; the document worker, run as a browser runs a worker, handing back a deck's slides and the pictures
  they name, a workbook's sheets with "very hidden" and hidden sheets, rows and columns flagged and a formula with no
  saved value marked, a declared document type and a macro part refused; what each seat draws of the workbook, with
  "1 hidden row and 1 hidden column not shown" and "2 hidden sheets not shown", and the AI's text without them; a Word
  file's text with its page marks; `readInWorker` answering in time, ending a stand-in worker at its cap, and an answer
  after it changing nothing), `test/wordpages.test.js` (new, the XML built in the test: rendered breaks give pages and a
  paragraph holding one spans two; a hard break before Word's rendered break counts once; explicit breaks alone give
  "breaks" and approximate; `w:pageBreakBefore` direct, through a 10-link chain and cut past it; sections with no type,
  continuous and odd page; `<Pages>` disagreeing gives "word-stale"; blocks placed by their text with empty paragraphs
  and deleted text dropped, one not found approximate; `w:pgNumType` marks the pages; a declared document type refused
  before the scan; a run hidden directly, by `w:specVanish`, through `w:rStyle`, its paragraph's `w:pStyle`, a `w:basedOn`
  chain, the default styles and `w:docDefaults` removed, in a text box too, while `w:val="0"`, tracked old formatting and
  a paragraph mark's own keep theirs; a chain past 10, a loop and a missing style refused; and the document worker
  handing mammoth a file whose HTML, pages and text hold no hidden run, deleted text or comment, its pages from Word's
  breaks, its picture as bytes behind `agm-img:1`), `test/zipcore.test.js` (new: an archive listed, a part's stored
  bytes found, CRC-32 as `node:zlib` has it; `repack` copying every other part's local header, data and descriptor byte
  for byte, the replaced part stored with its CRC-32, the copy passing the check; mammoth reading the replaced part and
  not the one it replaced), `test/server.test.js` (`/vendor/pdf.worker.min.mjs`'s policy holds `'wasm-unsafe-eval'` and
  no `'unsafe-eval'`, the strict policy otherwise; the pages, the screen page, pdf.js's module, the readers and near
  misses of the worker's path do not), `test/vendor.test.js` (mammoth and SheetJS run in the document worker and are
  loaded only by its `importScripts`; the pdf.js workers listed are the ones `lib/guard.js` gives WebAssembly),
  `test/lint-rules.test.js` (`agm/inert-html`: each refused shape, the one parse in `parseInert` let through, the config
  holding the three modules, and exactly one `innerHTML` site among them), `test/resilience.test.js` (the four new page
  files at 0 synchronous calls; a dedicated worker's channel told apart from a window's in the message guard),
  `test/modules.test.js` (rule (m) reads `docview.mjs`, `docmodel.mjs` and the document worker; `PAGE_CORES` gains
  `lib/imagesize.js` → `public/imagecore.js`). And for what Word's hidden text, the bounds and the place could miss:
  `test/wordpages.test.js` holds a table's style hiding its cells (through `w:basedOn`, as the default table style, in a
  nested table), a conditional format's mark, a missing table style and one named after its runs refused, a style id
  written twice refused where it reaches a run and two default styles each read, a mark after a
  run's text or inside a markup-compatibility wrapper refused while a paragraph mark's own and tracked old formatting are
  not, WordprocessingML under another prefix, as the default namespace, by a character reference or in capitals refused,
  a relationships part read as mammoth reads one and refused when written otherwise, `partsOf` finding the parts by
  relationship and falling back as mammoth does, and through the worker: a main document named `word/document2.xml` with
  its styles and footnotes renamed, `w:docDefaults` and a hidden table style stripped; another prefix, the default
  namespace, a prefixed styles part, a conditional format and an odd relationships part refused; a local header naming
  another part, a name with `.`, `..`, `//`, a leading `/`, a `\` or a letter past ASCII, two names differing in case, a
  folder with data and a Unicode Path name refused; a declaration in a part named like no XML and in UTF-16 found; a
  device with no `DecompressionStream` told apart; a picture over 40 megapixels or of no readable size handed back with
  no bytes. `test/docmodel.test.js` holds the 256 columns and 100,000 cells of a CSV (one line of 5,000,000 commas, a
  file 300 columns wide, a quoted field read past) and of a table (a span held to the columns, rows cut and their spans
  ended at the cut, a Markdown table's cut), the delimiter sniffed from the first 64 KiB, the worker's `COLS`, `CELLS`
  and `PIXELS` the page's, `readInWorker` ending a worker at once when its document closes, and through the worker: a
  formula with no saved value marked as text, true or false, error, empty `<v>` or a shared formula's first cell while a
  saved "", FALSE and error stay; a sheet with cells at A1 and XFD1000 read as 390 × 256; one whose data begins at row
  11 cut at its 5,000th row and said so; an Excel 97-2003 file read, an HTML table named `.xls` refused and a zip named
  `.xls` held to the archive check; a deck's picture over the bound without its bytes. `test/zipcore.test.js` holds the
  Unicode Path refusal and the external attributes listed; `test/imagesize.test.js` the header reader as one core, the
  same sizes from `require` and from the classic script, a picture named by its bytes. Binary fixtures under
  `app/test/fixtures/` with a README line each (how it was made, its SHA-256): a six-page board pack exported tagged and
  untagged by LibreOffice Writer, its flat OpenDocument source, and a JPEG 2000 PDF. The browser smoke: a CSV is a grid;
  Markdown without its comment or hidden raw HTML; an Excel file read through the worker, its hidden parts marked
  backstage and absent on the Board's seat with their count, the AI's text on the backstage seat only; a PowerPoint
  outline without its hidden shape, its hidden slide marked backstage and absent on the Board; a Word file converted in
  the worker reading "p. 1 of 3" and going to p. 3, its hidden run nowhere, its picture an object URL the page made and
  revoked with the document; "≈ p. 1 of ≈ 2" from explicit breaks; one pdf.js worker for several PDFs, each closed one
  destroyed, the AI's text by page backstage and none on the Board; the page box keeping its page across a resize; find
  moving to a page not yet drawn; the JPEG 2000 fixture drawn on the panel and on a screen with no error; a stuck PDF
  failed at its deadline and its worker replaced; `parseInert` in a real browser running nothing and adopting nothing;
  the page box keeping p. 4 across a collapse of the panel and its opening again; an Excel 97-2003 file through the
  worker under the strict policy; on a screen, a PDF held past its deadline (run there at 1.5 s by the smoke's probe)
  failing its take with its words and ending its worker, the next PDF drawing through a new one.
  The smoke's PDF read imports `loadPdfJs` from `docview.mjs`, and its Board's Word file reads as blocks, its bold
  dropped, on purpose.
- The papers: `README.md`, `README.txt` (the panel's documents, their words and limits), `SECURITY.md`,
  `docs/DESIGN.md` (parsed in the page, bounded and inert), `docs/ANALYSIS.md` (`agm/inert-html`, the guard's files,
  the worker's lint and channel, the vendor fence), `docs/DISPLAYS.md` (JPEG 2000 on screens),
  `THIRD-PARTY-NOTICES.md` and `VENDOR.json` (where mammoth and SheetJS run, and what now bounds xmldom's advisories),
  `CLAUDE.md`.
- Rolling back: nothing is stored. 0.5.1's page draws documents as it did; its worker's response keeps the page's
  policy again, so JPEG 2000 pictures go undrawn.

**On stage seats come from an invite; showing on the Board's pages is a right of its own; information is drawn over the
show** (the plan's Part 4, unit 24, its §5.9.1 (two layers), §5.9.2.1 (On stage by invite), §5.9.2.2 (`stage.show`,
`canShow`), §5.11's rights and rows and §9's row 24, with design §2.3, §2.6, §3.1, §3.3, §5.2-§5.5 and §7.4-§7.5 as Part
4 §0 amends them; the owner's answer 10, "Board pages should be more secure and not available to guests in an open hall.
Web pages need rights of their own.", confirmed "Right", the readings S5 and S13, "Defaults"; global #60)
- **On stage seats come from an invite link, an account or the admin, in open halls too.** In every hall's Main room, a
  code guest asking for On stage without the On stage link (or a seat it already holds there) joins as an observer: "On
  stage seats need the invite link — you joined as an observer." A locked room keeps its words for a backstage seat. In
  0.5.1 an open hall's code seated anyone On stage. **On the upgrade**, a Board tablet that joined an open hall with its
  code rejoins as an observer with those words: **send the On stage link to presenters and board members before the
  show.** An open hall's code guests no longer reach the Board's pages. The join page offered On stage only from an On
  stage link already; a remembered On stage falls back to Observer, as before.
- **The links are numbered and can be replaced.** An invite is a MAC of the room's guest code, the seat and the room's
  number for that seat (`settings.invites`, a meta op in the room's log; number 0 is MACed as 0.5.1's, so its links keep
  working until the first change). The admin's Roles & invites panel shows the hall's **On stage link** whether its
  roles are open ("Open: anyone with the code joins Backstage or as an Observer; On stage needs this link.") or locked,
  each link with **🔄 New On stage link** (New Backstage link, a side room's New Member link), which asks first and then
  voids the link it replaces without changing the code, keeps the seats already held, and writes one `room.invite` row
  ("a new On stage link (the old one no longer admits)", never the link). The verb is `admin:newInvite {roomCode,
  role}`, the admin page's (its gate), in `lib/handlers/rooms.js`, counted as input by the busy line; a new code still
  voids every link.
- **The link leaves the address bar.** A guest's hall page, once its join is taken, takes `code=` and `invite=` out of
  its address and its history entry (`history.replaceState`) and keeps them in that tab's `sessionStorage` for its own
  rejoins and reloads; where storage is blocked the address keeps them. In 0.5.1 the invite stayed in the address, and
  so in the history of a venue's shared tablet. An account's page keeps its address.
- **An open hall keeps its On stage seats** across a restart, as a locked hall keeps its seats: they come from an invite
  or the admin, so they are saved with the room (`settings.seats`, its On stage seats alone: an open hall's backstage
  and observer seats come from the code and are not kept), and a page back in the boot's first seconds takes its seat
  again. **Unlocking a hall keeps its On stage seats** and drops the rest; 0.5.1 dropped every saved seat. The admin may
  still seat a code guest On stage from the room's people list, and that seat is kept the same way (S5).
- **`stage.show`, a right of its own**: "Show files, pages and quotes to the people on stage", a hall's right in the
  Show group beside `stage.web`, in the presets of **Manager, Senior tech, Tech and Staff** (and the admin), not Viewer;
  given and taken back per account on the Accounts page. **It governs every account's information**, the operator's
  included: a Tech with it taken back is refused the take-down ("Showing files, pages and quotes on the stage needs its
  own right — ask an admin."), though `display.control` lets it put up every show kind. **On upgrade**, Staff, Tech,
  Senior tech and Manager accounts hold it (S13): **Staff can now draw information over the Board's chat**, which
  0.5.1's side panel did not (the Staff role reads "Their halls: messages and files, and what they show the people on
  stage").
- **Information is drawn over the show, never in its place.** A page holds two layers: the show (Stagewatch, the clock,
  holding, blank), which only the operator puts up, and information over it — a web page now, the document, picture and
  quote kinds as their units land. A web page put up over the clock leaves the clock under it, which reports `hidden`
  with "under a web page" (the console: "◐ Under a web page", never ✓), and Back to chat on the web page returns the
  page to the clock. A Board take puts away older takes of those On stage in its own layer alone: a web page to the
  Board leaves one Board member's clock as it is. `chat` hands back both layers at once; **Take down** (`{kind: 'chat',
  layer: 'info'}`, "the information taken down") hands back the information alone. **Over the operator's blank**
  information is held: the tablet stays dark, its bar (once touched) reads **📬 1 from backstage**, and a tap shows it;
  the page says "held under blank". **In the side bar**: information may arrive as an open card in the person's side bar
  (`page:push`'s `arrive: 'side'`), drawn there, opening the side bar once, counted on its rail and said "in the side
  bar" (while a take on the layer covers the page, side bar included, said "under …" instead: not in view), with **Show
  over the chat** and Remove; a show take always arrives over ("The show is drawn over the chat: only information
  arrives in the side bar."). **Beside the operator's**: a researcher's side-bar push while the operator's information
  is up is kept in a place of its own (`beside`), so the operator's stays over the show and the researcher's is a card
  beside it, numbered, told (`page:take` with `layer: 'beside'`, the join's `beside`), reported on and read back
  (`page:status`'s `beside`) as any take; the newest information to them, a hand-back of both, or a Take down that names
  it puts it away into Earlier, and the operator's own Take down leaves it. Each layer is told in a word of its own
  (`page:take` gains `layer`; an information take's `arrive` and the page's Earlier), each answered on its own (Back to
  chat, Minimise), and reported on by its number; a page out of view says `hidden` with no words, one drawn under
  another or held says why, so health's out-of-view peak reads only the first. A hand-back of both names, with `ifSeq`,
  a take up in any of them.
- **Earlier.** Information superseded, handed back or put away with Back to chat joins the hall's Earlier list (at most
  20 a hall, in `pages.json`, the oldest going first); each page is told the newest ten of its own (the Board's on a
  page seated On stage, and its person's), drawn under the cards in its side bar, each with **👁 Look**, which opens it
  on that page alone (a web page in the Preview's frame, with nothing to show from there): no report, no take.
- **Who may show what (`canShow`, pure, in `lib/pages.js`).** The operator (`canPush`) as before, the information kinds
  and the take-down needing `stage.show` for an account, a web page `stage.web`. Beside it, **an account seated
  backstage in a room of the hall** may show information by a right of its own (and only where the operator's push does
  not hold: an operator's page reads `canShow` false): with `stage.show` (and `stage.web` for a web page), **to the
  Board or one person seated On stage** alone ("Only the people on stage can be shown this."), from a side room only
  while that room is on the Main room's list ("This room may not send to the Main room's Board — ask an admin.", every
  kind, the take-down included), and **never over what the operator put up**, on the target's own take or on any page of
  theirs (a person On stage the operator showed a page of their own, while the Board's is a researcher's): an `over`
  push there is refused ("The operator is showing a web page — ask them, or send it to their side bar.") and a side-bar
  push kept beside it (each information take keeps whether its pusher held canPush, `by.op`). Its Take down names the
  take it takes down, over the show or beside it, takes down only one such a seat put up, only of a kind it could put up
  itself (a web page by `stage.web`, the other kinds by `stage.show`), and not while the operator's is on a page of
  theirs ("Take down names the take it takes down."; "Ben's web page is up now — yours was already replaced."). An open
  hall's code guest shows nothing, an observer seat (a Viewer granted the rights, Staff without `hall.post`) nothing.
  The join answer appends **`canShow`**, **`over`** (the information over the show, told as `page` is), **`earlier`**
  and **`beside`** (the information beside the operator's) right after `canWeb`; `canWeb` now also holds for a `canShow`
  page with `stage.web`; the support view's `person` facts carry `canShow`; the connection's context gains `canShow`,
  the server's context `invitesFor`.
- **The console for `canShow`.** Screens & pages… and the Board chip are shown to a page that may only show; the chip
  reads the show and what is over it ("Board · 🕐 Clock ◐ 0/6 · 🌍 Web page ◇ 6/6"), or, with nothing over the show, what
  is in their side bar ("· 🌍 Web page in the side bar ◇ 6/6"); its menu holds **⤵ Take down** while information is up
  (what a researcher put over the show, else what is beside the operator's; disabled over the operator's with "The
  operator put this up — ask them.", while the operator's is on a Board member's page with "The operator is showing
  something on a Board page — ask them.", and for a kind it could not put up with that right's words; an operator
  account without `stage.show` sees it greyed with the server's words, read from `page:status`'s `show`) and Show a web
  page… with `stage.web`, which goes to the side bar while the operator's information is up on the target's pages. Its
  People's pages list the people seated On stage alone (`page:status` filters them on the server), each row with what is
  over the show and beside it ("· over it: a web page on vote.example.com (◇ …) · in their side bar: …"), and a person's
  menu holds **⤵ Take down** of their information too (`person.takeDown`, the operator's and a page that may only show
  alike); `page:status` and `pages:changed` reach such a page as an operator's, a web take by its host alone. **A push
  of information offers Take down for 10 s, never Undo**: Undo put the older information back, which could pop a page
  the Board had closed back up on every tablet; a show take keeps its Undo. The admin page's Take it down (a guest's web
  page left up) takes the information down and leaves the show.
- Rolling back to 0.5.1: a `pages.json` with two layers and Earlier is ignored as 0.5.1 ignores the whole file; a hall's
  `invites` numbers are kept and read by nothing (a link made after New On stage link no longer admits under 0.5.1,
  whose links are number 0's); an open hall's saved On stage seats are read as 0.5.1 reads a locked hall's, and an open
  hall seats anyone On stage again; `stage.show` on an account is ignored.
- Choices where the plan left room: the information layer's kinds are a web page alone until the document, picture and
  quote units land (`canShow` reads their rights by name already); `page:status` keeps the show's status where unit 18's
  readers (the chip, the console's rows, the support view) read it and adds `info` and `beside` to each row, where the
  plan wrote `{show, info}`: the same facts, one level less; a push's answer adds `arrive` and `aside` only when they
  apply; a side-bar push over the operator's information is kept in a place of its own beside it (the plan says it
  "draws in the side bar beside the operator's take and supersedes nothing", which one information place could not
  hold), and a side arrival with nothing of the operator's up takes the information layer as any push does; the newest
  information to a page puts away what is beside it, latest winning there as over the show; an information take put away
  with Back to chat by one Board member joins Earlier for the Board; the operator's information on one Board member's
  page holds back a researcher's push over the Board and its Take down (refused, not put away there), rather than a
  precedence of the operator's over newer Board takes; a seat that may only show takes down only a kind its own rights
  would put up (the plan gives either right the take-down; the narrower reading of "only over its own kind of take" is
  taken); the join's new keys follow `canWeb` directly, `beside` after `earlier` (the chat view's `view` and a first
  open's keys, added by later units, follow them); the hall page drops `code=` and `invite=` from a guest's page alone
  (an account's page keeps its address); the backstage link's number and button come with the On stage link's; New …
  link asks first; the Staff role's words name what it shows.
- Tests: `test/pages.test.js` (`canShow` by kind strings and facts, each row of the table and each refusal's words: the
  operator, a Tech without `stage.show`, a locked hall's guest with and without the switch, an open hall's guest, Staff
  with and without `stage.web` and `hall.files`, an observer seat, On stage, a target not On stage, a side room off the
  list, over the operator's information and in the side bar, the operator's on one page of the Board's, a take-down with
  and without its take and of a kind its rights would not put up; the two layers, the clock under the web page and Back
  to chat on it as an answer in its layer, the information taken down, a hand-back of both; supersede per layer; Earlier
  once, bounded at 20, ten told the newest first, read back; arrivals, a take kept beside the operator's, reported on,
  read back after a restart, left by the operator's Take down, taken down by its own, put away by newer information and
  a hand-back of both, held under blank and "under …" in the status; a record of the wrong shape dropped by layer, a
  take beside the operator's among them), `test/server.test.js` (an open hall's code guest asking On stage seated an
  observer with the words, with the link On stage; a guest the admin seated On stage kept by the open hall's saved seats
  across a restart, the backstage seats not; unlocking keeping the On stage seats and a restart after it seating the
  tablet again; New On stage link refused to a guest and for a seat or a room that has none, then the old link an
  observer's, the new one On stage, a held seat kept, one row with no link, kept across a restart, a backstage link
  numbered too; a locked room's backstage words), `test/takes.test.js` (end to end, a Staff researcher with `stage.web`
  over the Board's clock, the clock under it and back on Back to chat; the join's keys; the console's read of the people
  On stage alone and by host; the show refused, a person not On stage, a Viewer's observer seat, Sal without
  `stage.web`; a side-bar push to a person; the show never to the side bar; a Tech without `stage.show` refused the
  take-down; over the operator's web page refused, kept beside it with its own status (◷ until Gil's page says, then ◇),
  told to Gil's page in its place, its row's words, taken down by its number, the operator's still up; the operator's
  web page on Gil's pages alone holding back Sue's push over the Board, her Take down of the Board's and her push over
  it to Gil, her side bar taken; Take down by its take; a side room off the list refused for every kind and its console,
  on the list shown; held under blank; a hand-back of both; Earlier and `beside` on a rejoin; an operator's page reading
  `canShow` false; and the earlier tests moved: a web page is information, Staff a console, the guests' Take it down the
  information's), `test/accounts.test.js` (`stage.show` in the presets of Manager, Senior, Tech and Staff, not Viewer,
  grant and revoke, never On stage or a code guest's; `giveable` and `view.giveable` gain it, on purpose; the Show group
  of six), `test/catalog.test.js` (Take down, its words over the operator's, on one Board member's page, for a kind
  without its right and for an operator without `stage.show`, what it names over the show or beside it; a person's Take
  down in the seat matrix; 1 from backstage; a side card's Show over the chat; Earlier's Look; the Board chip for a page
  that may only show; Show a web page… no radio), `test/modules.test.js` (`canShow` in the connection's context,
  `invitesFor` in the server's, the takes module's pure helpers, the Board chip's kinds by layer), `test/inputs.test.js`
  (`layer`, `arrive` and `admin:newInvite` by type), `test/menus.test.js` (the join's keys, `beside` among them; the
  Board's and a person's Take down refused to every seat whose rights hide it), and the joins that sit On stage in an
  open hall across the suites given the link (`test/helpers.js` `inviteOf`, the invite the panel gives, made with the
  server's secret), on purpose. The browser smoke: after joining with the On stage link the address holds no `code=` or
  `invite=` and a reload rejoins On stage; the web page drawn over the clock, the clock "◐ Under a web page" and the
  chip reading both; Back to chat back to the clock, Earlier with its Looks; a web page held under blank, "1 from
  backstage", Take down from the chip; a Staff account granted `stage.web`: its chip and its console of the people On
  stage, Take down disabled over the operator's web page, its own web page beside it in Bea's side bar in the one frame
  (the panel opened, the toast's Take down), read ◐ under the operator's page on her layer and ◇ opened in her side bar
  once she minimises that, Show over the chat drawing it on her layer, and its Take down taking it off there alone, the
  operator's left; the Invites panel's On stage link in an open hall and New On stage link. The Board's chat view's
  layout leg waits until the message it measures is drawn (a first open draws its newest 60 at once and the rest as the
  page is idle; read sooner, a size now and then found it missing).
- The papers: `README.md`, `README.txt` (On stage by invite, the link before the show and after a shared device,
  information over the show, the backstage team's right), `docs/ACCOUNTS.md` (`stage.show`, who may show what, the
  links, `room.invite`), `docs/DISPLAYS.md` (two layers, Earlier, the chip), `SECURITY.md` (On stage by invite,
  `stage.show` and `canShow`), `docs/ANALYSIS.md` (the takes module's helpers, the kinds by layer, the inputs),
  `CLAUDE.md`.

**The analyzers' versions**
- ESLint 10.14.0 and eslint-plugin-security 4.2.1, from 10.13.0 and 4.2.0 (development only: `npm ci --omit=dev` leaves
  both out of the portable folder). Dependabot's update of `main` (jammin808/AGMessage#5), carried on this branch with
  the same lockfile entries. The fences find nothing new; nothing that ships changed.

**A file, or a picture of part of one, is shown on the stage as a take; a stage file lives while a take names it; a Board
tablet keeps no copy** (the plan's Part 4, unit 25, its §5.9.3 (`doc`, `image`), §5.9.5 (`sourceOk`), §5.9.7 (Withdraw),
§5.9.11 (the take on the target's page), §4.6.3 and §4.6.6 (reading a file, what a Board tablet keeps), §5.10.3 (the
checks at a file's first take) and §5.11 (the stage files, what ends a take, `page.push`'s words) and §9's row 25; the
owner's answers 11, 12 and 20 as confirmed, and the reading S14, "Defaults"; global #61)
- **Two new kinds of take, on the information layer.** **A document** (`{kind: 'doc', url, at?, download, note?}`): a
  file the hall holds, the whole of it, opened at its place (a PDF's page, a deck's slide, a spreadsheet's sheet, a Word
  document's paragraph with its page where known, `approx` when Word's own breaks were missing, a text or Markdown
  file's line, a CSV's row) and paged, zoomed and searched on the target's own page through the drawing the page's seat
  draws (docview.mjs: the Board's without hidden parts). **A picture** (`{kind: 'image', url, from?, note?}`): an image
  shared in AGMessage, fitted, with zoom, saying what it is a picture of (`from`: a file's place, by its name and never
  its address, or the researcher's own copy). There is no region: a part of a page or a picture is drawn into a picture
  of its own on the pusher's page. A place of another type, or out of its range, refuses the take with words; `download`
  is true only when sent as true, and is kept with the take for the ticketed download a later unit adds; a note is a line
  of at most 200 characters. The take's `name` is the server's: the upload's own name for a fresh upload, else the name
  the hall's oldest message holding the file gave it, so a re-post under a new name never renames what the Board is shown.
- **Where a stage file may come from (`sourceOk`, pure, in `lib/pages.js`).** A fresh upload of the pusher's own, made
  for the Main room or for a side room on the Main room's list where it posts files; a file in a message of the Main
  room; a file in a message of a side room the pusher reads that is on the list; or one the hall's stage records (its
  stage file, a take or an Earlier entry), when the room it was recorded for passes again. Never another person's fresh
  upload. The refusal names the room only to a reader of it ("That file belongs to Legal, which may not send into the
  Main room — send it there first, or ask an admin."; else "That file belongs to another room — send it from there."). **A
  holding picture is held to the same rule**: in 0.5.1, and until now, a holding picture shared in a side room off the
  Main room's list could be put on the Board's pages; it is refused now in those words.
- **Never a document to an observer.** A document hands over the whole file, so a person seated as an observer is never
  pushed one ("Observers are shown pictures and quotes, not documents."), in any room of the hall, one the pusher cannot
  read included (a person's take reaches every page of theirs), and a page seated as an observer is told a
  document (a take that reached it before its seat moved, or under Earlier) without its address (`withheld`), drawing
  nothing of it. A picture is shown to an observer as to anyone.
- **The checks a file has not had run at its first take**, off the socket's turn, and everything is read again as it
  stands after them: a picture, and an image shown as a document, at most **40 megapixels** (provisional, until the
  device matrix's oldest rows are measured): "Too large for the Board's devices — send a region."; a Word, Excel or
  PowerPoint file that never had the archive check (one shared before 0.6.0, or before a restart) has it then, refused
  in the upload's words. What each check found is kept by the upload's name for the run, so a file is read once.
- **A stage file lives while a take names it** (`pages.json`'s `halls[H].files`, written only once a hall has one): a
  fresh upload a take named that no message holds yet (a picture drawn of a page, a document or a holding slide's
  picture shown before it was shared) is kept while a take or an Earlier entry names it, past its upload's own hour, and
  for `UPLOAD_ORPHAN_MS` once nothing does, so a push within that wait finds it again; then it is removed, unless a
  message, a screen or the hall's holding image holds it. An upload already posted is its room's, never a stage file.
  **What is in use** (`uploadsInUse`) now counts every file a take or an Earlier entry names, **a holding slide's own
  picture on people's pages among them**, so a reset or a delete never removes a file the Board is shown; and **a file
  only the stage still holds once its message goes** (deleted by its author while a holding slide shows it, its room
  reset under a holding slide, the admin's **Delete, leave it up**) becomes the hall's stage file then, so it leaves the
  disk once nothing names it and its wait is over, never stays for good. A holding slide's own picture has the checks of
  a file's first take too. **The boot sweep** removes, once after the start, the stage files whose wait ran out while
  AGMessage was stopped, by the names the stage recorded alone: no other file in the folder is read, and a file a screen,
  the hall's holding image or an Earlier entry holds stays. **At most 200 in use a hall**; a new one past that: "This
  hall's stage holds 200 files — take some down." **A hall removed takes its stage files with it**, with or without its
  rooms' files purged.
- **What ends a take.** A **Main room's reset** ends every information take of the hall and empties its Earlier (each
  page told: the information handed back, the show left as it was), its `room.reset` row ending "…, 3 takes ended"; a
  **side room's reset**, or its removal, ends those showing a file of it, a picture of one, or what was sent from it.
  **The author's delete** of a file message ends the takes and Earlier entries of its file, where no other message of
  the hall holds it. **The admin's delete** of such a message asks first, "On the Board's pages now — take it down too?"
  (`admin:deleteMessage` answers `onStage` and the question; the admin page asks in place, **Delete and take it down**
  or **Delete, leave it up**, and sends `takeDown`), its `message.remove` row saying so when it did.
- **Withdraw, for a take shown by mistake** (`page:withdraw {code, seq}`, one `writes` token, in `lib/handlers/takes.js`):
  an information take on people's pages or under Earlier, by who put it up, the operator (`canPush`) or the admin
  (anyone else who may show there: "Only who showed it, the operator or the admin can withdraw it."; On stage: "Do that
  from a backstage page."). It is handed back wherever it is up, leaves Earlier (Take down leaves it there), each page
  it was for is told (`page:take {withdrawn: seq}`: the page lets go of what it drew of it, a Look included), a stage
  file it named starts its wait, one `page.push` row per target reads "…, withdrawn", and the answer says "Withdrawn from
  6 Board pages — it is no longer under Earlier."; asked again, it is done (`already`). A page offline then is told at
  its next join, whose answer no longer holds it. In the console, **🔙 Withdraw…** on the Board chip and on a person
  (`board.withdraw`, `person.withdraw`), asked first, the operator's on any information, a seat that may only show its
  own (another's greyed with the server's words); an information push's toast offers **Take down · Withdraw** for 10 s.
  `page:status` says of each information take whether the asker put it up (`mine`).
- **The take on the target's page** (`pagelayer.mjs`, drawn through `docview.mjs`): a document at its place with its
  page box, zoom and find, its controls the Board's 48 px in the simple view; a picture fitted, with zoom; the pusher's
  note above and a line under it ("Board pack.pdf · p. 12", "Ana's picture of Board pack.pdf, p. 12"); a card in the
  side bar ("📄 Board pack.pdf · p. 12", "🖼 Ana's picture · p. 12"), and under Earlier a **Look** that draws it again on
  this page alone, in the dialog a web page's Look uses, saying nothing to the server. **The page checks again**: an
  address that is not an upload of AGMessage's of a type the stage shows draws nothing, fetches nothing, and is
  `failed`. Reports: `shown` once its place has drawn and the page is in view, `failed` with the reader's words ("the
  file could not be read", "too big for this device", "the picture did not load", the deadline's). A take's PDF is read
  by its pages' ranges alone (pdf.js's streaming and fetching ahead off).
- **A push asked again while the first is still being made** (a file's first check is awaited off the socket's turn,
  and the outbox sends `page:push` again after a drop) waits for it and is answered with what it did: one take, one row,
  one stage file.
- **⬇ Download, until the ticketed download.** A file message's Download (the backstage seats' and the admin's, as the
  catalogue's rows have it) no longer follows a link to the file, which is a navigation the guard below refuses: the page
  fetches the file `no-store`, as its readers do, and hands the browser its bytes through an object URL let go 40 s
  after, saved under the message's name; a file that cannot be read says "Not downloaded: … could not be read — try
  again.". The next unit replaces it with a ticket and the server's own attachment, streamed from disk.
- **Ready before the first take.** A Board page imports the take layer and the document reader with `import()` 2 s after
  its join, a timer and no `modulepreload` (which Safari has only from 17) nor an idle callback (which it lacks); the
  readers' heavy parts load at the first document. A device that cannot load them says so at the take.
- **What a Board tablet keeps: nothing AGMessage writes or offers.** **Every upload is served `private, no-store`** (it
  was `private, max-age=3600`), so no device keeps one in its HTTP cache; a reload fetches pictures again. **A `GET`
  never saves**: every type is served `inline` (Word, Excel and PowerPoint files were served as `attachment`, which saved
  them from their address with no record). **A navigation to an upload is refused** (404) by Fetch Metadata: the address
  bar, a link, a frame or an embed (`Sec-Fetch-Mode: navigate`, or a destination of `document`, `iframe`, `frame`,
  `embed`, `object`), which would give the browser's own viewer and its Save; AGMessage's readers fetch (`empty`) and its
  pages draw pictures with `<img>` (`image`), and a browser that sends no Fetch Metadata is served as before. A take's
  file is fetched `no-store` and drawn from memory: a picture through an object URL revoked when the take goes (Back to
  chat, a newer take, a withdrawal, a Look closed), a document's reader and its pdf.js document destroyed then. On every
  seat's take layer (an observer's included), its cards and a Look: **AGMessage's menu in place of the browser's,
  Shift+right-click included** (a selection keeps the browser's Copy, off a picture; Firefox's own Shift+right-click
  menu cannot be stopped by any page, and SECURITY.md says so), no picture draggable, no long-press "Save to Photos" on
  iOS, and **printing leaves the stage out**, "What is shown on stage is not printed." in its place. Text stays
  selectable.
- **The words** (`describePage`'s two voices): the console names the file and its place ("Board pack.pdf at p. 12",
  "Minutes.docx at ≈ p. 3", "Ana's picture of part of Stage plan.png", "…, sent from Legal" for a push from a side room,
  "… in Legal" for a side room's file); **the audit never names a file, quotes a text or carries a path** ("the Board (6
  pages) → a PDF at p. 12", "a picture of a PDF page (p. 12)", "a picture of part of an image", "…, from a local copy").
- The lint fence over `pagelayer.mjs`: HTML is parsed in one place there too (`agm/inert-html`), and the four modules
  hold one `innerHTML` site between them.
- Rolling back to 0.5.1: `pages.json` is ignored as 0.5.1 ignores it; stage-only files are in no message, so 0.5.1
  neither counts nor removes them (they stay on disk, unused, and 0.6 names them again from `pages.json`); 0.5.1's
  `uploadsInUse` does not read takes, so under it a reset or a delete can remove a file a 0.6 take names, which back on
  0.6 reports "the file could not be read"; a file's address saves an Office file again (`attachment` on `GET`), uploads
  are cached for an hour, and a navigation to one opens it.
- Choices where the plan left room: a CSV's place is its row, kept as `line`; a Word document's place needs its paragraph
  (`block`), its page optional, and the target's page opens at that paragraph; a picture shown whole needs no `from`,
  and is named by its own name; "her copy of"
  reads "their copy of"; a side room's file and a push sent from one keep the room's key on this laptop alone (to end
  them with that room's reset) and are told by its name; a side room's reset ends what shows its files and what was sent
  from it, and so does its removal; the stage's 200 are counted by what is in use (named, or inside its wait), as
  `uploadsInUse` counts them, and the oldest no longer in use goes past it; the admin's question before a delete is
  asked of what a take-down ends (a document or a picture), not of a holding slide, which is the operator's show and
  keeps its picture on the disk while it is up; Withdraw is the Board chip's and a person's
  (`board.withdraw`, `person.withdraw`: the console's takes are those objects), greyed on another's take for a seat that
  may only show, and asked first; the toast's Take down and Withdraw sit side by side (the toast gains a second button);
  a withdrawn take is kept by its number and who withdrew it (at most 200 a hall) so a repeat is told it is done and a
  later download ticket can be refused; an Earlier entry's Look of a document or a picture opens in the Look dialog,
  every seat alike (the panel's two readers are unit 26's); the Fetch Metadata guard refuses `navigate` whatever the
  destination; the page's check refuses an address that is not an upload's shape before anything is fetched; a hall's
  stage files are written only once it has one. Download tickets (and ⬇ on a take shown with Download), and the
  doors that show a document or a picture from a file (a file message's 📺 Show the Board ▸, the File pane, the
  Preview's bar), are the next units': until then they are shown by `page:push` on the wire, and Withdraw and Take down
  work on them from the console.
- Tests: `test/pages.test.js` (a document's clean shape, Download only when true, each type's place and its range, `approx`
  with a Word page alone, never to an observer, no region read, a side room's file; a picture of a file's place by its
  source, of a local copy, whole; `sourceOk`'s four rules, a Legal file named to its reader and "another room" to anyone
  else, another's fresh upload, the stage's record checked again, a re-post's name; a holding picture through
  `sourceOk`; `describePage`'s two voices, the audit's with no name or path, "≈ p. 3"; the stage files kept, under
  Earlier, withdrawn, inside and past their wait, the bound of 200 in use, a hall's names on its removal; a holding
  slide's picture in use and never a take-down's, a file only the stage holds adopted once, read back with no author
  known, let go after its wait; a posted upload no fresh one; what ends a take; a document told an observer without its
  address; read back, and a wrong shape dropped), `test/takes.test.js`
  (end to end: a Staff researcher's document reaching the Board's pages alone, "sending" until each reports, its name the
  first message's, Download kept, one row per target with no name, Earlier; a document to an observer refused and a
  picture shown; a page moved to an observer told it withheld, at its rejoin too; a 50 MP JPEG refused as a picture and
  as a document; a fresh upload of the pusher's shown and kept, another's refused, a Legal one refused off the list and
  shown on it; a document to a person observing in a room the pusher cannot read refused all the same; Withdraw refused
  to another researcher, by its pusher with each page told, its row, a repeat done, gone from Earlier; by the operator
  and the admin; a show take and a number that is none; a Word file swapped for one with macros refused at its first take
  after a restart; a push asked again while its first check is under way answered with the first's take, one row; the
  holding picture of a side room held to Main's list, moved on purpose), `test/uploads.test.js` (a stage-only picture
  past its upload's hour while a take and then Earlier name it, removed after its wait once withdrawn; the boot sweep
  removing one whose wait ran out while stopped, keeping one a take names, one a message holds and a file it never
  recorded, and one a screen, the hall's holding image or an Earlier entry holds; a fresh upload as a holding slide kept
  past its hour while the slide is up and gone after; a message's picture as a holding slide kept through its author's
  delete and a Main reset, gone once the slide is put away; the admin's Delete, leave it up, gone once withdrawn; the
  201st stage file refused end to end, and nothing shown; a Main reset ending the hall's information, each Board page
  told, and keeping the clock, a side room's its own, the author's delete of a document's file, the admin's delete
  asking), `test/server.test.js` (every type
  `private, no-store` and `inline`, never `attachment`; refused to a navigation and to a frame, an embed or an object's
  request; served to a fetch, an `<img>` and a request with no Fetch Metadata), `test/zipcheck.test.js` (a stage file's check at its first take: its upload's check where none is on record and
  not again where one is, a picture held to 40 MP, a file gone not shown), `test/inputs.test.js` (a document's and
  a picture's fields, `page:withdraw` and `takeDown` by type), `test/menus.test.js` (Withdraw refused to every seat whose
  rights hide it), `test/catalog.test.js` (Withdraw on the chip and a person, the operator's, a seat that may only show
  its own and another's greyed, its ask; the seat matrix), `test/modules.test.js` (the file kinds shown from a file, not
  the chip; the takes module's helpers; the new parts of the takes context; the any-room readers), `test/lint-rules.test.js`
  (`pagelayer.mjs` held to `agm/inert-html`), and the kinds' words moved on purpose. The browser smoke: a Board page
  imports the take layer and the reader 2 s after its join, with no modulepreload; a picture on Bo's page fetched
  `no-store`, drawn through an object URL, not draggable, no download link, ✓ once she says so; a right-click and a
  Shift+right-click open no browser menu, and print leaves the stage out; on an observer's picture the same, AGMessage's
  menu for both clicks; Back to chat revoking every URL made for it; its Look under Earlier saying nothing to the server;
  a document in the simple view paged and zoomed at 48 px, then withdrawn, its reader gone and its pdf.js document
  destroyed; a Word document opened at its paragraph; a take whose address is not ours drawing and fetching nothing; D
  on a focused file saving it whole under its name in the browser (fetched `no-store`), where it only read the link
  before; and the Staff step's toast and Board chip read Withdraw beside Take down, moved on purpose.
- The papers: `README.md`, `README.txt` (documents and pictures on the stage, Withdraw, what a Board tablet keeps and
  what cannot be prevented), `docs/DISPLAYS.md` (the two kinds, where a file may come from, the stage files, what ends a
  take, Withdraw), `docs/ACCOUNTS.md` (`page.push`'s words, Withdraw), `SECURITY.md` (uploads `no-store`, never
  `attachment`, navigations refused; what a Board tablet keeps and what cannot be prevented; the stage files' lifetime),
  `docs/DESIGN.md`, `docs/ANALYSIS.md` (`pagelayer.mjs` in the inert-HTML fence; the inputs), `CLAUDE.md`.

**A shared file is a download for the backstage team, by a ticket; nothing opens itself; files to transfer take more
types** (the plan's Part 4, unit 26, its §4.6 as Part 5 §0 and Part 7 §0.3 amend it; the owner's asks "Separate files to
transfer from files to send to stage." and "It also needs file transfer between rooms for users to download.", and the
owner's answers 12, 18 and 20 as confirmed: "A board tablet can have a feature to tick to enable it to be downloaded.",
and the readings S1, S2, S11 and S15)
- **Two acts, not one.** A file message is a transfer: **📎 Share for download** puts a card in the room's chat, and **it
  opens itself on nobody's panel** (0.5.1 opened every file on every Board and backstage page; 0.6.0 had narrowed that to
  files posted in the room). What the backstage team shows the Board is a take (📺), never a file in the chat.
- **The card, per seat**: "📎 Board pack.pdf · PDF · 2.1 MB" (its kind, and its size where the message has it; a file
  shared before 0.6.0 has none), "📦 … · download only" for a file AGMessage never opens; a picture keeps its inline
  picture, drawn from its bytes fetched `no-store` through an object URL revoked as the card leaves the page; **👁 Look**
  on a Board page, **👁 Preview** backstage (a tap on the card), in the person's own panel, reporting nothing; **⬇
  Download** for the admin and the backstage seats that are not Viewer accounts, in the full view; **📺 Show the Board ▸**
  for a seat that may show (a picture of p. 1, a picture of a page…, the document…); ⧉ Show on screens as before, never for
  a file for download only.
- **A file message carries the server's name, its size and whether it is for download only.** Its name is the upload's
  own (or the name the room's first message of the file gave it), never the poster's, so a post again cannot rename a file
  ("Final approved budget.pdf"); its `size` in bytes; and `transferOnly: true` for a file AGMessage never opens. A
  forward and a send into another room carry them; the room's file index (`files`) says which are for download only.
- **A download is the server's act, by a ticket per seat** (`file:download {messageId}` or `{seq}`, one chatter token, in
  `lib/handlers/rooms.js`; `lib/downloads.js`; `lib/pages.js` `mayDownload`, pure). A ticket is given to the admin's own
  page (where it does not sit On stage, and from the admin page for the room it watches) and to a seat backstage whose
  account is not a Viewer; **never to an observer or a Viewer account** ("Downloads are for the backstage team."); **On
  stage, a file of the room is a Look only** ("On stage tablets keep no copies — ask the backstage team to show it to you
  with Download ticked."), and **a document shown with Let them download it ticked** is downloaded there, by the take's
  number, current or under Earlier ("This was shown without Download." otherwise; "This was withdrawn." for one
  withdrawn, whose tickets are voided). A ticket is 18 random bytes, single use, 60 s, bound to the person, the file and
  the address; at most **4 live for one page and 8 for one person** ("Finish the downloads already started first."), read
  before the 1,000 kept in all, the oldest going first. **`POST /uploads/:name/download`** with the form field `t`
  answers the file as an `attachment` under the message's name with the stored file's own extension ("Agenda.cmd" for a
  `.txt` saves as "Agenda.txt"; Windows' reserved characters dropped; the true name in `filename*`, an ASCII fallback
  beside it), `no-store`, `nosniff` and the sandbox policy, streamed from the disk; **every other outcome is 204 No
  Content** (a ticket unknown, spent, expired, for another file or address, and the form's own refusals: `t` twice, a body
  over 1 KB, a third field), so the hall page stays where it was. The page builds the form with the DOM and says
  "⬇ Downloading Board pack.pdf…", then "✓ Board pack.pdf reached this browser" when the server says the whole file went
  (`file:sent`; `file:sending` when it starts), or "The download did not start — try again." after 5 s with nothing;
  when the stream ends before the whole file went (the browser's download cancelled, the connection lost) the server says
  so (`file:sent {whole: false}`) and the page says it stopped; a page that loses its connection with a download in
  flight says it cannot tell whether all of it arrived. The admin page's ⬇ Download on a file of the room it watches
  works the same way. Not audited, as a person reading what their room shows them (a confidential file's download is the
  mark's unit's: its `file.download` row, written at `file:sent` and never for a ticket not spent, lands with the mark).
- **An observer's page, and a Viewer account's, is never given a file message's link** (S2). Such pages sit in an io
  room of their own (`ro:<key>`) and are sent each file message without its address (no `url` key at all): live, in a
  join's history, older messages and file index, in a resume and in `history:before` and `history:message`. Withheld at
  delivery, never in the stored message, so a 0.5.1 message is withheld the same way. **The admin's seat change moves a
  page in or out in the same tick, before it is told**, so a page that ignores `roleChanged` is split by its new seat all
  the same. A page joining another room on its own socket leaves the room it was in.
- **A file moves to another room only from a seat that may download it where it is** (`forward`, `room:send`, a new
  file or one of the room's): a code guest seated as an observer in one hall and backstage in another, or a Viewer
  account granted the rights to post and share, is refused: "Files are moved by the backstage team." The forward's
  picker answers by the same rule, offering such a seat no hall for a file and saying why. An On stage seat is refused
  every forward first, text included ("Messages from On stage stay in this room.").
- **Files to transfer take more types** (`lib/guard.js` `TRANSFER_TYPES`; `lib/pages.js` `TRANSFER_ONLY`): zip, MP4,
  M4A, MOV, MP3, WAV, OpenDocument text, spreadsheet and presentation, each by its first bytes (a zip's signature, an
  `ftyp` box at bytes 4-7, an ID3 tag or an MPEG audio frame header, RIFF and WAVE, an ODF's `mimetype` entry first,
  stored, holding its type), and **Word, Excel and PowerPoint files protected with a password**: a compound file whose
  directory (`lib/cfbcheck.js`, read through `fs.promises` within 64 KB) holds `EncryptionInfo` and `EncryptedPackage` and
  none of `WordDocument`, `Workbook`, `PowerPoint Document`, `Macros` or `_VBA_PROJECT_CUR`, so a Word 97 document with a
  macro renamed `Agenda.docx` is refused ("That file's contents don't match its type, so it wasn't shared."). Their type
  is `application/octet-stream`; AGMessage never opens, draws, previews, parses, shows or sends one to the AI; **a `GET`
  answers 404** (a transfer type by its extension, a protected Office file by its first eight bytes, read at each `GET`,
  so after a restart too); a take of one is refused ("That file is for download only: AGMessage does not open it."),
  `sourceOk` reading the upload's and the messages' word and the take's check its first bytes; and it is downloaded only
  by a ticket. A zip is never inflated. An upload of another type says which are taken. A `GET` of a Word, Excel or
  PowerPoint file whose first bytes cannot be read (held by another program) is 404 too, never served unchecked.
- **The composer's 📎** (Part 5 §0): the File tab goes. 📎 in the Message row, or a file dropped or pasted on the feed or
  the composer, attaches a file to the next message: a chip ("📎 Board pack.pdf · 2.1 MB", Remove), Send reads **📎 Share
  for download** (**Share in Legal** with To: set), its words the caption; it is uploaded as it is sent, never before.
  Backstage, the file opens in the panel's **👁 Preview — the Board does not see this** from the copy on the device:
  nothing reaches AGMessage until it is shared or shown. The message box reads "Type a message to the Board…" (in a side
  room, "Type a message to Legal…"). A share the uploads' rate turns away (429: a burst of four, then one every 2 s, which
  a picture, the document and two shares in a row reach) is held by the outbox and uploaded again up to three times, 2 s
  apart (§5.9.7's steps), then refused with the server's words and its Retry. Once the server has a share, the page says
  **"Shared in Main — the backstage team can download it; the Board can open it."** ("Shared in Legal — the backstage team
  can download it." in a side room, which has no Board, and for a file for download only, which the Board does not open).
  A file attached on the device that is only ever transferred, a password-protected Word, Excel or PowerPoint file
  included (its first eight bytes read on the device), is a "download only" chip and never opens in the Preview.
- **The action prompt's button reads "❓ Ask the Board"** ("❓ Ask Legal" in a side room), in place of Send.
- **The Preview's bar**, for a seat that may show the Board: **📺 Picture of p. 12** (a PDF's page drawn on this page into
  a new picture, its long edge 2,048 px, never over 4,096 px a side or 5,242,880 pixels, and uploaded as it is shown, saying
  it is a picture of the file or of the pusher's own copy; for an image, **Show this picture**) and **📺 Document at p. 12**
  (the whole file, the Board pages through it; a file on the device uploaded as it is shown), side by side, one click each,
  with **☐ Let them download it** under the document's alone, **disabled for a file whose reader found hidden parts**
  (hidden sheets, rows, columns, slides or a slide's hidden shapes, Word's hidden text; `docmodel.mjs` `hiddenPartsOf`,
  the deck's outline counting the shapes it leaves out): "This file has hidden parts: Download would hand them over. Share
  a copy without them for download instead." The bar is offered only over a file its reader drew. The place is the
  Preview's own. A file's ⋯ (**📺 Show the Board ▸** a picture of p. 1, a picture of a page…,
  the document…) and a person's **Show them a document…** (People: for the operator, any person; for a seat that may only
  show, a person On stage) open **the short document bar**: the file (where none is named), its place, Let them download
  it and where it arrives.
- **The panel's two readers**: on a Board page **📺 On stage** ("Nothing on stage. What the backstage team shows you
  appears over the chat or here; ▭ Minimise keeps it here."), and backstage **👁 Preview — the Board does not see this**.
  A take shown with Download ticked has **⬇ Download** on its card (in the simple view's Shown to you beside 👁 Look; in
  the full view's ⋯), on the layer's bar in either view (and its ⋯ in the full view), and under Earlier once it is taken
  down, until it is withdrawn.
- **On an On stage seat, in either view**, the panel's reader, the side bar's cards and the feed's pictures are On stage
  content: AGMessage's menu in place of the browser's (Shift+right-click too), no picture dragged out, no long-press "Save
  to Photos".
- **The support view opens nothing on a person's panel**: a file a person opens (`userState 'doc'`) follows them to
  their own pages and to the admin's support view of them, and one the support view opens reaches nobody.
- **Every reader** (§4.6.5): the halls board's line reads "📎 Board pack.pdf — caption"; the transcript "📎 *name*
  (shared for download) — caption" (", download only" for a file AGMessage never opens); the AI's thread `shared "name"
  for download: caption`; the admin page's room view "📎 name — caption" (📦 and "· download only") with ⬇ Download; a
  reply's quote of a file "📎 name".
- **The words** (§4.6.2): `hall.files` reads "Share files for download, or forward one into a hall"; the Project manager,
  Senior tech and Tech roles add "the Board's pages", and Staff reads "Their halls: messages, files, and information for
  the Board's pages".
- Rolling back to 0.5.1: observers are given file links again and there are no download tickets; a file's address
  saves an Office file again; the composer's File tab is back; a transfer-only file is unreachable (0.5.1's `GET`
  refuses an extension it does not list, and serves a protected `.docx` as a Word file, which no reader opens); a file's
  `size` and `transferOnly` are kept on its message and ignored.
- Choices where the plan left room: the File tab goes as Part 5 amends §4.6.3 (📎 in the Message row, the attached file a
  chip, Send reading Share for download), so "the File pane" of the unit is the composer's 📎 and the Preview's bar; the
  Preview's picture button is offered for a PDF and an image alone (a picture of a DOM reader's view, "Show what you see",
  is sent as data, which is the quotes' unit), and the Document button for every type the stage shows; a Word document
  shown from the bar opens at its top (its place is a paragraph, which the Preview's page does not name); the short bar
  is an ask in place, its file chosen from the room's files (the Preview's own copy first) where it is opened from a
  person; the full view's take card keeps its two buttons (Show again, Remove) and offers ⬇ Download in its ⋯, the simple
  view's card shows Look and Download; the admin page downloads a file of the room it watches; a transfer-only file is
  told on its message (`transferOnly`) and `sourceOk` refuses it by that word too, the first-bytes check backing it; a
  file message's caption from 📎 is its words, at most 500 characters as before; the pages' file types (the stage's and
  those only ever transferred) are one copy in the catalogue, held to the server's tables by a test, the take layer's own
  copy of the stage's too. Bench: the bytes a busy hall's reload fetches with `no-store` are not recorded — no
  measurement this round (no venue Wi-Fi or busy hall on the bench); every picture is fetched again on a reload, by
  design.
- Tests: `test/downloads.test.js` (new: each transfer type taken by its first bytes and refused with the wrong ones, a
  `.mov` starting `moov`, an ODF whose `mimetype` is another type's, not first or compressed; a compound file decided by its
  directory, a renamed Word 97 document, macros, `_VBA_PROJECT_CUR`, a directory past 64 KB, a loop and a chain past the
  file refused; the tickets' one use, address, file, 60 s, four a page and eight a person while another person's stays
  live, the 1,001st pushing out the oldest, a withdrawn take's voided; the attachment's names; `mayDownload`'s table and
  `linkless`; end to end: the server's name and size on a file message, an observer's and a Viewer account's live
  message, join history, files, resume and read-back without `url`, the tickets for each seat and their refusals, the
  file by its ticket with its headers and `file:sending` and `file:sent` to the page that asked, a second use, another
  address, another file, `t` twice, a body over 1 KB, three fields, no field and JSON each 204 with no body; a seat
  moved to observer sent the next file without its link; forward refused to a code guest observing here and backstage
  there and to a Viewer account, an On stage forward refused first, the admin's forward carrying the name and the size; the
  forward's picker offering a Viewer account no hall for a file, with why; a zip forwarded transfer-only with its size;
  `room:send` of a file refused to a Viewer account (a text sent), a research page's file sent into a hall reaching the
  observer seated there and the copy kept here reaching this hall's observer without `url`; `history:before` withheld
  the same way; the admin page's download of a file of the room it watches;
  the `doc` relay to the support view and the person's own pages, none from the support view; `{seq}` tickets for a take
  shown with Download ticked, refused without it, to an observer, to one not shown it and once withdrawn, its tickets
  voided; each transfer type accepted `transferOnly` and refused with the wrong bytes, a renamed Word 97 document, macros,
  `_VBA_PROJECT_CUR` and a directory past 64 KB refused and nothing kept, 404 on `GET`, refused as a take and on a
  screen (a file or a holding image),
  `application/octet-stream` by its ticket, a protected Word file's `GET` 404 after a restart), `test/pages.test.js` (the
  transfer-only types, no key in both tables, `sourceOk`'s refusal by extension and by an upload's or a message's word),
  `test/server.test.js` (an observer's first open: every file without its link, on purpose), `test/inputs.test.js`
  (`file:download` by type), `test/outbox.test.js` (an upload the rate turned away waits 2 s and goes again, at most three
  times, then refused with the server's words, and Retry counts afresh), `test/docmodel.test.js` (a deck counts its hidden
  shapes; `hiddenPartsOf` for each kind),
  `test/menus.test.js` (`file:download` refused to every seat its rights hide it from),
  `test/catalog.test.js` (the facts `download` and `takeDownloads`; Look and Preview, Download, Show the Board ▸ and its
  choices, a file for download only and a linkless file in the seat matrix; ⬇ Download on a take and a card shown with
  Download, on the layer's bar in either view and under Earlier; Show them a document…; the composer's 📎 and Share for
  download, Ask the Board and Ask Legal; the admin page's Download; the pages' file types the server's), `lib/busy.js`
  (`file:download` is input, as `test/busy.test.js` holds every verb a handler registers), `test/modules.test.js` (the
  connection's helpers, the context's parts), `test/accounts.test.js` (the roles' words, on purpose), `test/halls.test.js` (the board's 📎, on purpose), `test/resilience.test.js` (the hex
  count lowered to 239). The browser smoke: the hall page's backstage words (the message box, 📎, the Preview); D on a
  focused file saving it whole under its name by its ticket, the page fetching nothing of it and saying it reached this
  browser; a file dropped on the composer attached and drawn in the Preview with nothing uploaded; Picture of p. 1 and
  Document at p. 1 each one click to a ✓ take; Download ticked showing ⬇ on the Board's card, which saves it; Share putting a
  card in the feed and nothing on the Board's page, a zip "download only" with no Look, Show or screen, Look and no Download
  On stage, an observer's card with no link, picture or act; a Board seat's Look read `no-store` and its object URLs revoked;
  a file of before 0.6.0 as a card; the feed's ⋯ → The document… and the People tab's Show them a document… opening the
  short bar; Let them download it disabled for a spreadsheet with a hidden sheet; the console's person menu with Show them
  a document…, on purpose; the Board's chat view upright at 820×1180 brought its tabs by a document arriving in its side
  bar, a file shared in the chat showing nothing, on purpose; the panel's heading Shown to you in the simple view and the
  seat's in the full view, whichever draws last.
- The papers: `README.md`, `README.txt` (sharing and showing, downloads, files to transfer), `SECURITY.md` (downloads by
  ticket, links withheld, files moved, files to transfer only), `docs/ACCOUNTS.md` (who may download and who may move a
  file, `hall.files`' words), `docs/DISPLAYS.md`, `docs/DESIGN.md`, `docs/ANALYSIS.md`, `CLAUDE.md`.

**The backstage team shows the Board a picked word, sentence, line, item, paragraph, cell, row or column, a picture of a
page, what they see, or the document** (the plan's Part 4, unit 27, its §5.9.3, §5.9.4, §5.9.6, §5.9.7 and §5.9.8 as
Part 5 §0 and §16.3 and Part 7 §0.3 amend them, and §5.12's "On the Board's pages now" line; the owner's answer 11,
"Both as options.", as two buttons side by side)
- **A quote is a take of its own** (`{kind: 'snippet', unit, title?, text | items | table | blocks, from?, note?, cut?,
  more?}`; `lib/pages.js` `cleanSnippet`, pure, fail closed): the words or cells a researcher picked, **carried as data
  and drawn by the page, never HTML**. `unit` is one of a word, sentence, line, item, paragraph, cell, row, column,
  range, slide, selection, what is in view (`view`) or text, and carries its one body: text, a list's items (a slide its
  title and items, a numbered list its start), a table `{rows, head, side, ref?, focus?}` (its label row and column
  marked, the cell it is of), or the blocks in view (a paragraph, a heading, an item, a quotation or a table, 12 at
  most). It is rebuilt key by key (any other key left behind); a unit with another body, a body of the wrong type or
  nothing to show is refused in words ("Choose what to send: …", "A row is sent as a table.", "There is nothing to show
  in that quote."). Every string is read by its type and cleaned as a block (`guard.cleanBlock`: its line breaks kept,
  CR LF and the Unicode separators made one, a tab a space, controls, bidi marks, overrides and isolates, the Arabic
  letter mark, zero-width space, word joiner and BOM dropped, ZWJ and ZWNJ kept for the scripts that need them, trailing
  spaces gone and blank lines in a row made one, never cut); the Arabic letter mark joins the one-line text's unsafe set too
  (`guard.cleanText`).
- **Its bounds, refused in words and never cut by the server** (§5.9.4): 1,200 characters of text ("Too long for the
  stage: 1,200 characters at most (this is 1,860)"), 20 items of 300 characters, 25 rows × 10 columns of 200 characters
  ("Too big for the stage: narrow it to 25 rows × 10 columns"), 12 blocks, 4,000 characters in all, a title of 120,
  counted as code points so no count splits a surrogate pair. **The cut is the researcher's own choice**, offered by the
  bar: `cut` on text at its 1,200 characters, or on a table at its 25 rows or 10 columns, with `more` saying what was
  left out ("… 40 more rows not shown"); a cut that is not one of those is refused ("Only text cut to its first 1,200
  characters, or a table cut to 25 rows × 10 columns, is sent as cut.").
- **Where it comes from, by name and place, never by address** (`from`): a file of this hall by its name, type and
  place, its source held to `sourceOk` as a document's (a file of a side room says that room's name); **the pusher's own
  copy** (`local`) said as theirs; a web page by its host, its address sealed at rest beside the hall's web takes and
  told only for Open the source (the ❝ Quote tab's unit, below); none, typed. Each type's places are its own (a PDF's page; a deck's slide; a sheet and a cell's reference;
  a Word paragraph with its page and "≈" where the page is a guess, and its heading; a text or Markdown file's line or
  run of lines; a CSV's line and cell) and any other is refused ("That place cannot be read for this file: …"). **A
  picture has no words to quote** ("A picture has no words to quote: show a picture of it instead."). The quote is its
  pusher's claim: the server never parses a document, so it cannot check that the words are in the file; the page's
  `shown` is the fact.
- **Drawn on the Board's page** (`pagelayer.mjs` `quote`, `fitQuote`): a `<blockquote>`, a list or a `<table>`, each
  paragraph and cell `dir="auto"`, its line breaks kept, **in the largest type that fits** between 28 px (20 px under
  600 px wide) and 12vw, in 12 steps at most, refitted as the screen turns; numbers to the right; the cell it is of
  outlined and bold with `aria-current`; **a table wider than the screen scrolls sideways inside its card**, its label
  row and column held in view. Its line says who quoted it: "Quoted by Ana · Board pack.pdf, p. 12", "Quoted by Ana from
  their copy of costs.csv, row 2", "Quoted by Ana · vote.example.com", "Typed by Ana". It reports `shown` on the frame
  after it is laid out, saying "longer than the screen: it scrolls" where it does not fit. Its card in the side bar
  reads its first 40 characters ("❝ Revenue Q3 £4.2m"); one that arrives in the side bar keeps the card's own type and
  says "longer than its card in the side bar: it scrolls" where it does, and a table in a quote longer than its box
  scrolls down inside its own card as well as across, its label row and column held in view. It is information (the
  layer over the show), as a web page, a document and a picture are.
- **Its words in every reader**: the console and the Board chip "❝ a table cell from Q3 costs.csv, B2", "❝ 3 list items
  from their copy of Pack.pdf, p. 3", "❝ a quote typed by Ana (17 characters)", "❝ a quote from vote.example.com"; the
  `page.push` audit row "a quote (a table cell, 18 characters) from a spreadsheet", "a quote (typed, 42 characters)",
  never a word of it, a file's name or an address; the hall's Earlier list keeps it, its web source as its host alone; a
  page is told no side room's key (a side room's file is said by its name, "(Legal)") and no web address. **Under
  Earlier a quote's 👁 Look draws it again** on that page alone, from its data, saying nothing to the server, as a
  document's and a picture's do.
- **The AI's "On the Board's pages now" line** (§5.12): a draft asked in a hall's Main room by a seat that may show
  reads what the Board's pages show over or beside the show as the console words it, and, **for a quote that seat
  pushed, its words** ("On the Board's pages now: ❝ a quote typed by Sue (21 characters) — Capex rose 8% on plan");
  another pusher's words never reach a seat's draft.
- **Picking in the Preview** (`docview.mjs`, for the research seat): **a highlight made first is honoured**, read from
  the browser's selection, a tap on a word, a click in a grid or a drag across one. A PDF's page has a text layer
  (pdf.js's `TextLayer`, its rules copied from pdf.js's viewer under its licence, `THIRD-PARTY-NOTICES.md`) and, where
  the PDF is tagged, **its structure tree** read to find the paragraph, the list item and the table cell, row and column
  a pick sits in (`getStructTree`, its marked content's ids); **an untagged PDF** offers words, sentences and lines, a
  paragraph read as a best guess ("≈ best guess"), and no cell: "Tables in this PDF cannot be read as cells — send the
  region as a picture". A sentence and a word are read by `Intl.Segmenter` where the browser has it (otherwise a word is
  a run of letters and digits, and a sentence ends at . ! or ?). A sheet's or a CSV's grid picks a **cell, a row, a
  column or a range** by click, Shift-click, a drag, its headings or the keyboard (arrows, Shift+arrows), with its
  **labels** (☐ with labels: **the sheet's frozen panes** as Excel saved them, its last frozen row and column, so a title
  row above a frozen header is never a cell's label; else its first row and column; or the row and column **Labels…**
  marks; the document worker reads the panes of each sheet's first view from the part the workbook's relationships name);
  a cell is sent as 2 × 2 with its labels (2 × 1 under its header row, or 1 × 2 beside its name, where it has one label
  alone, as a tagged PDF's table cell has), a row with its label row, a column with its label cell; a range over 25 × 10
  is "over" with the bar's cut, and a tagged PDF's row or column cut to 25 × 10 says so on the Board ("… 15 more rows not
  shown") as a sheet's does. **Nothing hidden is ever picked**: a hidden row's, column's or sheet's header or cell (drawn
  dimmed and marked "hidden" in the researcher's Preview) picks nothing, a pick that names one is refused when it is read
  (`docmodel.mjs` `gridQuote` reads only the rows and columns the Board's pages draw), nothing of a hidden sheet is in
  view to send, and a table on a hidden slide is never read. The outline's picks: a deck's slide (its title and items)
  and item; a Word document's paragraph, item and table, with **its page** from Word's pages ("p. 3", "≈ p. 2" where the
  page is reckoned); a text or Markdown file's line, paragraph and item, **a numbered list's items keeping their numbers**
  (the third item reads "3." on the Board, never "1."). **A picture in a Word document or a slide, tapped**, is a pick of
  its own: **This picture alone** sends it drawn again as a new picture (its metadata left behind), saying where it is
  ("Ana's picture of their copy of chart deck.pptx, slide 1"); a picture of a hidden slide or shape is never picked.
  **The pick is marked** with the CSS Custom Highlight API where the browser has it (let go with the document), its
  blocks outlined otherwise; cells, a picture and a region are outlined.
- **The bar, highlight first** (`app.js` `PickBar`, `app.html` `#pickBar`): the units that hold the pick as chips with
  their sizes ("Word · 6 ch", "Paragraph · 240 ch", "Row · 3 cells"), **the smallest chosen** (the one used last where
  two are as small); **exactly what will go, drawn as the Board's page will draw it**; a bound's refusal said before
  anything goes, with **Send the first 1,200 characters** or **Send the first 25 rows × 10 columns** as the researcher's
  choice; a note; and 📺 Show to the bar's target. **A right-click on the pick, the bar's ⋯ and a second tap on it open
  the same list as a menu** (the catalogue's kind `pick`, its order the stage addendum's `previewActions(pick)`, Copy
  first): 📋 Copy, each unit, 📷 **Picture of this page** (of this region, for a region; **This picture alone**, for a
  picture in a document), 🔳 **What I see**, 📄 **The document at this place**, 🧑 **Show a person ▸** (words, a region
  and a picture alike; "Nobody is seated On stage now." when there is no one). The bar's quote, its preview and its
  glance are read again only when what they are of changes (the pick, its unit, the cut, the labels, the note): a scroll
  of the Preview redraws only the words that follow the place. AGMessage's
  menu stands in for the browser's there; a touch's long press keeps the browser's own (select, copy, look up), and a
  selection made keeps it too (`menus.js` door option `picks`).
- **The Preview's bar** (§5.9.8): **whom it goes to** (the Board, or one person the console lists) and **where it
  arrives** (over their chat, or in their side bar, the choice kept on this device); 📺 **Picture of p. 12** and 📺
  **Document at p. 12** side by side, one click each, **the one chosen last on this device drawn first**, its note saying
  what each sends ("Picture of p. 12: this page only, as a picture (0.8 MB)", the size once the page has been drawn
  here; "Document: the whole file (2.1 MB), opened at p. 12 — the Board can page through it"), and, where a whole page's
  body text would stand under 16 px on a tablet's take, that What I see sends the part in view larger (provisional, until
  the device matrix's D2 is measured); 🔳 **What I see** (a document's blocks or a grid's cells in view as a quote; a
  PDF's or a picture's part in view as a new picture; **more in view than the stage takes is never cut by itself**: the
  bar says how much is in view, and **Send what fits** sends the part that fits, the first 12 blocks or a range's first
  25 rows × 10 columns marked cut, as the researcher's own choice); ▭ **Region** (a part of a PDF's page or of a picture
  drawn by hand, sent as a new picture, the arrow keys moving it and Shift with them resizing it); ☐ **without its
  metadata** for a picture (drawn again, so nothing of its EXIF, its place included, goes; on a browser without
  `createImageBitmap`, Safari before 15, by drawing the part of the element itself). A picture is a new file drawn here,
  its long edge 2,048 px, saying what it is a picture of ("Ana's picture of part of their copy of stage plan.jpg"). **A
  picture drawn lately is shown again without a second upload** while the stage keeps its file (the last 50 kept, the
  oldest and the expired let go), and drawn and uploaded again, once, where a push is refused because the file is gone.
  **An upload the uploads' rate turns away** (429) says "Sending in 2 s…" and goes again, three times at most, 2 s apart,
  then says the server's words.
- **The fresh-push warning** (§5.9.7): where the target is reading information another pusher put up under 15 s ago, the
  bar says so before it goes ("The Board is reading Ben's quote (8 s) — Replace · Show a person instead"), on the pick's
  bar and on the Preview's bar for a picture, the document, What I see and a region alike, and refuses nothing; over the operator's information, a seat that may only show sends to their side bar, and the bar says so. A
  quote taller than a tablet's take at the stage's smallest type says "Long for the stage — the Board will scroll"
  (provisional, until the device matrix's D2 and D6 are measured).
- `page:status`'s information row carries whether it is the asker's own, by whom and how long ago (`mine`, `by`, `ago`)
  for a seat that pushes, so the bar can say whose it is; a push that replaces a quote never hands the quote back to its
  pusher (information is taken down, never put back).
- Rolling back: a quote kept in `pages.json` is a kind an earlier build does not know, read there as a take it cannot
  read and dropped as it loads the store; nothing else of the store changes.
- Choices where the plan left room: a quote's `from` for a file names it by the server's name and type (or the pusher's
  copy's), its address never leaving the server; a typed quote (`unit: 'text'`, no `from`) is accepted now for the
  pasted quote's unit to build on, and draws as "Typed by …"; the units' bounds are one table (`SNIPPET`) the page's bar
  and the server share by test (`docmodel.mjs` `QUOTE_BOUNDS`); a cell goes as 2 × 2 with its labels and a column with
  its label cell, so the Board reads what the number is; a pick's default unit is the smallest within the bounds, the
  bare selection last among equals; the region tool draws on a PDF's page and a picture alone (a document's view goes as
  blocks, never as a picture of HTML); the fresh-push window is 15 s and the glance budget 1,100 × 700 at 28 px, both
  provisional and said so; the AI's line names only a quote's words to the seat that pushed it. Bench: no measurement
  this round (`docs/DEVICES.md`'s quotes' benches: the text layer's draw on a 200-page PDF, a tagged PDF's struct tree,
  a 25 × 10 table's fit on D2 and D6, the long press on iPadOS 14.5; each "not measured", no device matrix on the
  bench). Frozen panes are read from a workbook's archive alone: an Excel 97-2003 file's labels default to its first
  row and column. A picture inside a Word document or a deck goes when tapped; the bar does not estimate a page
  picture's size before it is drawn (its size is said once drawn, and as it uploads), since a page's encoded size is not
  known until then.
- Tests: `test/pages.test.js` (`cleanBlock`'s keeps and drops, as `\u` escapes; `cleanSnippet`'s units and bodies, every
  field by its type, each bound at and over its edge counted in code points, the cut and `more`; a source of the hall by
  name and place, the pusher's copy, a web host, typed, each type's places and a picture refused; kept, told, stored and
  described, the audit's words with no word of it; `snippetText`), `test/takes.test.js` (end to end: a CSV cell's quote
  to the Board ✓ with its words on the console, the Board chip and the audit row; a typed quote; a web quote whose
  address is sealed at rest and never told; each bound refused with nothing pushed; a hand-back leaving a quote;
  take-down; the AI's line with the pusher's own words and without another's; neither `GET /api/context` nor the context
  posted to the hall's Stagewatch, read twice while a quote is up, holds its words, its cells or its file's name),
  `test/docmodel.test.js` (the grid's quotes: a cell 2 × 2 with its labels, with one label 2 × 1 or 1 × 2, a row, a
  column, a range over the bounds and its cut, a hidden row's or column's header, cell or range end and a hidden sheet
  refused; a tagged PDF's cell under its header row and a column over the bounds refused or cut with `cut` and `more`;
  What I see over its bounds said and what fits offered; the default labels from frozen panes; the document worker's
  frozen panes by the workbook's relationships, its first view's, counted from the first row read, a split none;
  `segmentOf`, `cutText`, `quoteSize`), `test/catalog.test.js` (the kind `pick` in its order, Copy first, each unit's
  word and size, a unit over its bound disabled with its words, a region's and a picture's acts with Show a person, Show
  a person with nobody On stage, the seat matrix: the operator and a seat that may only show, no other), `test/modules.test.js` (the picked kinds are never in the Board chip's menu or Show them ▸),
  `test/inputs.test.js` (a quote's every shape through `page:push`; the drawing's words), `test/helpers.js`
  (`sheetParts`, a sheet built from rows, with hidden rows, columns and a hidden sheet, and frozen panes). The browser smoke (a hall of its own, the operator backstage on a device of
  its own signed in as an account, Cy On stage on another): a tagged PDF's word, line and paragraph chips with the word
  chosen and Cy's page drawing it ✓; a 25-row table on a phone at 20 px or more, scrolling inside its card with its
  labels in view; the right-click menu on the pick in the catalogue's order and a touch's long press keeping the
  browser's; Picture of p. 3, Document at p. 3 and What I see; an untagged PDF offering no cell and saying why; a region
  of a JPEG with EXIF, sent without it or its place; a spreadsheet's column and cell with their labels; a CSV's row, a
  Markdown item, a slide; a hidden column's header, a hidden row's header and cell and a hidden sheet's cell picking
  nothing, nothing of the hidden sheet in view to send, and a cell's labels from the sheet's frozen panes, not its title
  row; a quote under Earlier drawn again by its Look on Cy's page with no report; a picture in a slide, tapped, arriving
  as a picture of its own at its slide; a Word document's p. 3 and ≈ p. 2, a cell of its table and What I see; the
  fresh-push warning;
  the last choice kept across a reload; five quick pictures, the one the uploads' rate turned away (read from the order
  the five were shown in) saying "Sending in 2 s…" and arriving; no console error or CSP violation; and the picture's
  Look under Earlier read once its dialog's close event has had its turn, since the event comes as a task of its own
  after `close()`.
- The papers: `README.md`, `README.txt` (show the Board a word, a paragraph, a cell, or what you see), `SECURITY.md` (a
  quote is data; a part is a new picture), `docs/DISPLAYS.md` (A quote), `docs/DESIGN.md`, `docs/ACCOUNTS.md`
  (`page.push`'s words), `docs/ANALYSIS.md`, `docs/DEVICES.md` (the quotes' benches), `THIRD-PARTY-NOTICES.md` (the text
  layer's rules), `CLAUDE.md`.

**Every stage feature works on the Board's mixture of devices** (the plan's Part 4, unit T, its §5.15 as Part 0 §0.8 C1
and §0.4.10 amend it; the owner's answer 22, "Board will use a mixture of devices")
- **The document floor, and a probe for it.** pdf.js's legacy build parses from Safari 16.4 and Chrome 103, and the
  document worker inflates Office files with `DecompressionStream('deflate-raw')`, which arrived at the same versions.
  The hall page makes one inside `try` as it loads and **joins with `docs: true` only when it can** (no user agent is read
  and no syntax probed); the server keeps it per page, `true` and nothing else as yes (`socket.data.docs`). A device that
  passes the probe yet cannot import pdf.js draws that document as a device below the floor does (its stand-in, or "this
  device cannot open documents — ask for a picture"), opens no document for the rest of its tab's session (kept in
  `sessionStorage`) and joins again at once without it.
- **A document's stand-in** (`standin` on a `doc` take; `lib/pages.js` `standinOf`, pure, read by its shape before the
  file): **a picture of the place** (`{url}`, an image upload of the pusher's, checked as a picture take is: where it may
  come from, and 40 megapixels at its first take; kept as a stage file named by the take while it shows, `filesOf`) or
  **what is at the place** (`{snippet}`, a quote's body by a quote's rules and bounds, its source the document's). Never
  both, never neither ("A document's stand-in is a picture of its place or what you see there: one of the two."), on no
  other kind ("Only a document has a stand-in."), and of its document's shape: a picture for a PDF or a picture, what is
  seen for any other type ("A PDF's or a picture's stand-in is a picture of its place; any other document's is what you
  see there."; a stored one of the other shape drops its take). A document and its stand-in, both fresh, find room on the
  hall's stage together (`fileRoom` takes the take's files at once), so the two never take it past its 200 files.
- **Made by the pusher's page only when a target needs it** (`app.js` `Show.whole`): where the console's read counts
  pages of the target that joined without `docs` and the file needs a reader they lack (a PDF, or a zipped Word, Excel or
  PowerPoint file: the catalogue's `READER_EXT`), a picture of a PDF's page is drawn and uploaded as a page picture is
  (kept to show again; one kept from before whose file the stage let go, refused so, is drawn and uploaded again, once),
  and an Office file's place is read as What I see reads it, in a reader laid out as a tablet's take and never seen, its
  hidden parts left out. **The bar says so before it goes**: the Preview's ("…; 2 of 6 Board pages are older devices:
  they get a picture of p. 12 in its place") and the short document bar's.
- **On a page that cannot open documents** (`pagelayer.mjs`): the stand-in is drawn in the document's place under its
  words ("As a picture of p. 12: this device cannot page through the document", "As a quote from slide 3: …", the quote
  naming the document as its source) and reported `shown` with them; with none, a PDF or an Office file reads "This
  device cannot open documents — ask the backstage team to show you a picture." and reports `failed`, and nothing of it
  is fetched (pdf.js is never imported). A picture, a CSV, Markdown, text and an Excel 97-2003 workbook (not zipped)
  need no reader, and are drawn. A side bar
  card and a Look under Earlier draw the stand-in; a Look at a document without one, and the panel's Look at a PDF or an
  Office file, read the device's words. ⬇ Download on a take shown with Download ticked works as on any device.
- **Counted, page by page** (`Pages.status`, `page:status`): each target's pages without `docs` (`nodocs`), those that drew
  the stand-in (`standin`, and `standinAs`: "On all 6 Board pages, 2 as a picture", "… 2 as a quote" for a quote, "4 of 6
  showing, 1 as a picture · …") and those that could not show it (`cannot`), each said only where there are some; the
  Board chip reads "✓ 6/6 (2 as a picture)", and each person row says whether its person sits On stage (`board`).
  **📷 Show them a picture of p. 12** ("Show them what is at slide 3" for an Office file) is on the Board chip
  (`board.picture`) and on each person's row in the console (`person.picture`) for a document some of their pages could
  not open, as the plan's console row has it, for the take's pusher, an operator and the admin: the read gives the file
  (`doc`: its address, name and place) to those seats alone, and only where the asker may show that file itself
  (`sourceOk`), so no address reaches a page that could not already put it on the stage; the pusher's own page draws
  from its own copy. From the Board chip it goes to each person On stage whose own read of that take counts a page that
  could not open it, as a take of their own drawn over the Board's on their pages alone. The stage record that counts the
  stand-ins in its `seen` is unit 30's, which reads this count.
- **The ES2020 fence** (`eslint.config.mjs`, `ecmaVersion: 2020` for `app/public/**`): a class field, a private field, a
  static block, a logical assignment, a numeric separator or a top-level await in a page script or module is a parse
  error, so every Board device parses what it is sent (Safari parses ES2020 from 14). It found one: the simple view's
  10 s wait written `10_000`, now `10000`.
- **The device legs and the floor leg** (the browser smoke): every stage feature on three Board pages at 1180 × 820,
  820 × 1180 and 390 × 844, each a mobile viewport with touch; and a Board page without `DecompressionStream`,
  `requestIdleCallback` and `Promise.withResolvers`, as an iPad below the document floor (see Tests).
- Choices where the plan left room: the console's act is worded **Show them a picture of p. 12**, not the plan's "Send
  them a picture", since every act that puts something on people's pages says Show (the catalogue's words test and the
  house's one word per thing); it sends a picture of a PDF's page, and for an Office file what is at its place as a quote
  (no picture of an Office file's page is drawn, as the stand-in of such a file is a quote); a stand-in for a Word document
  with no place is what is at its top; a page without `docs` draws a stand-in where a take carries one, whatever the
  file's type, and the pusher sends one only for the types that need a reader; the counts ride on every status that has
  some, the show's and the information's alike; a test's pages say `docs: true` unless a test says otherwise
  (`test/takes.test.js` `invited`), so the statuses they compare read as before. Bench: no measurement this round
  (`docs/DEVICES.md` §7: a document take's bytes and time to a phone through the tunnel, on D6 and D7, "not measured").
- Rolling back: a stand-in kept in `pages.json` is a key an earlier build does not read; it reads the document without it.
- Tests: `test/pages.test.js` (a stand-in of each shape cleaned, read from its source after the document's, every other
  shape, both, neither, the other type's, one on each other kind, and a bad one before a bad file refused; kept, told,
  read back and dropped when stored wrong or of the other type's shape; named as a stage file and let go after its wait;
  two fresh files finding room together or not at the bound; the status's counts, said only where there are some, "as a
  quote" for a quote, and the file `docOf` gives the asker), `test/takes.test.js` (end to end: `docs` yes only as `true`,
  again on a rejoin; `page:status`'s `nodocs` for the Board and each person On stage; a PDF with its stand-in kept and its
  picture a stage file; ✓ "On all 3 Board pages, 2 as a picture"; a stand-in over 40 megapixels, one that is no picture,
  one on a picture and words for a PDF refused; without one, △ with the device's words and `cannot`; the read's `doc` for
  the pusher (the admin) and an operator, on the Board's row and each person's that could not open it, and never for a
  seat that may only show; a person's picture take reaching their pages alone, over the Board's, as Show them a picture
  sends it: the act itself is the page's, which the floor leg drives),
  `test/inputs.test.js` (a stand-in's every shape and a join's `docs`), `test/lint-rules.test.js` (each newer syntax a
  parse error in a page script and a page module, its ES2020 form passing, and every page script of the tree parsing),
  `test/catalog.test.js` (`board.picture` and `person.picture` for the operator and a seat that may only show, their
  words, and absent otherwise; the facts' `docs`; the reader types held to the take layer's), `test/menus.test.js` (the
  picture acts refused to a seat that may not), `test/modules.test.js` (`filesOf` among the takes module's pure helpers).
  The browser smoke: the device legs (a quote in 28 px or more on a tablet and 20 px or more on a phone, a 25 × 10 table
  scrolling inside its card at 390 px and no page scrolling sideways, a picture never dragged out with its menu the
  page's, a PDF zoomed in and paged by a tap and ⬇ Download saving it whole on the phone, a Word document without its
  hidden run or tracked deletion and found in, a workbook, a deck, a CSV and Markdown without what is hidden in them, a
  JPEG 2000 page, a web page, each ✓ on all three; Earlier and a Look; 20 takes then Back to chat with no reload), the
  floor leg (joined without `docs`; a document shown before it joined failing with its words and Show them a picture of
  p. 1 reaching that page alone; the bar's words; a PDF's picture stand-in ✓ "(1 as a picture)", never dragged out, and
  its Download saved whole; a Word document's quote stand-in ✓ "(1 as a quote)"; a Look with and without a stand-in;
  quotes, pictures, web pages and Earlier; pdf.js never fetched, its network log from the page's first request; no
  script error), and a Board page whose pdf.js import is refused on the way (it draws the stand-in, opens no document
  again, kept across a reload, and is counted without `docs`).
- The papers: `docs/DEVICES.md` (the matrix's rows, the ES2020 fence, §7's tunnel bench, §8 the stage on every row: the
  document floor, the probe, the stand-in, each fallback, what every push proves and the walk's stage rows), `README.md`,
  `README.txt` (older tablets and phones), `SECURITY.md` (a stand-in is checked as a picture or a quote; D1 and Fetch
  Metadata), `docs/DISPLAYS.md`, `docs/ANALYSIS.md` (the page floor's fence), `CLAUDE.md`.

**A pasted or typed quote, and a web page at a place** (the plan's Part 4, unit 28, its §5.9.9 with §5.9.3's `web` row,
§5.9.4's `from`, §5.9.11's source line and §5.10.3's one HTML parse, as Part 5 §0 keeps ❝ Quote a tab of the
backstage composer)
- **❝ Quote, a tab of the backstage composer** beside Message and Action prompt, for a seat that may show the Board (the
  operator, or a seat with a right of its own) in the full view: a box to paste into or type in, **From** (nothing,
  "typed by Ana"; a file of this room that holds words; a web page by its address), what will go drawn exactly as the
  Board's page draws it, whom it goes to and where it arrives as the Preview's bar has them (the operator's information
  sending a seat that may only show to the side bar, and another pusher's quote under 15 s old said with **Replace** and
  **Show a person instead**), "Long for the stage — the Board will scroll" where the quote drawn off the screen at the
  stage's smallest type is taller than a tablet's take (the pick bar's own glance, never a refusal), a line above it,
  and **📺 Show the Board** / **Show Ana**; the box is emptied once the server took it. It is the path for a highlight
  inside a web page, which a page cannot read, and for a document open on the researcher's own machine and never
  uploaded. Show is the one way it goes: Enter in its fields never sends it. **It is drawn only for a seat whose
  information pushes hold `stage.show`** (the console's read, `page:status`'s `show`, before which it is not drawn), as is
  the Preview's bar, whose every push is information too: a seat given `stage.web` alone, which `canShow` admits for its
  web pages, sees neither, where before it was offered the bar and refused at each push.
- **A paste is read from the paste event's own clipboard** (`clipboardData`, which needs no secure context, so it works
  over plain HTTP), into the empty box or over all its words (`docmodel.mjs` `pastedQuote`, pure): **tab-separated words**
  (what Excel and Sheets put on the clipboard; a quoted cell may hold a tab or a line break) **become a table**; the
  **`text/html` flavour is read for its structure alone** (one table's rows and cells, its first row the labels where every
  cell of it was a header, a merged cell's words in its first place; a list's items, numbered where every one was)
  **through `parseInert`**, so no picture or frame in it loads and nothing in it runs, and `<style>`, `<script>`,
  `<noscript>`, `<template>`, `<head>` and any element marked `hidden`, `display:none` or `visibility:hidden` are never
  read; and **the structure is kept only where its words, joined, are the `text/plain` flavour's** (white space made one):
  where they disagree (a part hidden by a style sheet), the plain words alone are used, so no word the person did not see
  arrives. Any other paste, a paste among words already there, and words typed are text. A picture pasted alone says "A
  picture has no words to quote: open it in the Preview to show a picture of it." and is never attached to a message;
  a file dragged over the tab finds no place to land (the composer's attach below it included), and one dropped anyway
  says "A file is not a quote: …" and attaches nothing.
- **Its bounds said before it goes, in the server's words** (`pasteOver`), with the cut as the researcher's own choice:
  **Send the first 1,200 characters**, **Send the first 25 rows × 10 columns** (`pasteCut`: `cut`, and the rows and
  columns left out counted in `more`); a list over 20 items or an item over 300 characters, a cell over 200 and 4,000 in
  all are said and not offered a cut. What it reads as is said first: "A table, 3 rows × 2 columns", "A list, 2 items",
  "Text, 42 characters". **Every bound the bar says is now the server's refusal word for word** (`docmodel.mjs`
  `quoteOver`, the pick bar's too): "a cell is 200 characters at most", where the bar said "a cell 200", and "Too long
  for the stage: 12 blocks at most" and "1,200 characters at most" as `cleanSnippet` words them; What I see keeps its own
  "Too much in view for the stage: 1,200 characters a block at most".
- **A quote from a web page carries its address only from a pusher who may show a web page** (`lib/pages.js`
  `snippetFrom`: `stage.web`, a code guest's by the hall's setting): the address is then sealed at rest beside its host,
  as a web take's is, and **told the pages the quote is shown on** (`told`: opened there, and told by its host alone where
  this machine cannot open it or it opens to another host's), Earlier's included; without that right the quote keeps the
  site's host alone, and **no address of it is kept, sealed or in clear, or told**. The Quote tab says so before it goes:
  "The Board is told the site's name, without a link: web pages on the stage need their own right." A quote cannot name a
  host of its own (`from: {host}` is refused, as every other shape is).
- **Open the source** (`pagelayer.mjs` `sourceHref`): the quote's source line reads "Quoted by Ana · vote.example.com ·
  Open the source", a link in a tab of the person's own (`target="_blank"`, `rel="noopener noreferrer"`, no referrer),
  its address checked again as a frame's is, and, **where it has no fragment of its own, a text directive built from the
  quote's first and last words** (`#:~:text=Net%20revenue%20rose%208,in%20the%20third%20quarter`; a short quote found
  whole), so the person's browser finds and highlights them. In the full view the take's ⋯ and its right-click offer the
  same act (`take.tab`, labelled Open the source on a quote). Without the address the line names the host with no link.
- **A web page at a place** (`pagelayer.mjs` `lookFor`): a web take's address keeps its fragment (an `#id` scrolls inside
  the frame), and **a text directive's words are said over the frame**, decoded and made one clean line of at most 300
  characters ("Look for: ❝ net revenue rose … in Q3"; its prefix and suffix left out), since a browser highlights one only
  for a navigation a person started at the top, never in a frame; Open in a new tab keeps the fragment, so there it does.
  Open in a new tab is the take's ⋯ in the full view (Part 5's `take` row): a Board page in the simple view, the
  default On stage, reads the words over the frame and has no tab to open, and the papers say so. The operator's Preview
  of the address says the same. Nothing is fetched.
- **A table's header row read as headers** (`docmodel.mjs` `inertBlocks`: `head` 1 where every cell of a table's first
  row is a `<th>`): a Word table whose first row repeats as its header row, which mammoth writes as `<th>`, is drawn by
  the documents' reader with that row as headers, and What I see of it carries it as the quote's label row, as a pasted
  table's header row is.
- Choices where the plan left room: a paste's structure is one table alone or list items alone, and anything else (a
  heading with paragraphs, a table beside a paragraph) is its plain words; a paste among words already in the box is the
  browser's own (plain words); the text directive is built from the first four words of the quote's first line and the
  last four of its last (one line of eight words or fewer whole); whether the address goes is decided at the push by the
  pusher's right then, so a quote already up keeps its link when the right is taken back or the admin turns a hall's
  guests' web pages off, as a web page already up stays (the plan's "turned off, the next push is refused"; a test holds
  it);
  **not built here, and owed to this tab by the units that build them**: its 🔒 (the person's own mark on a typed or
  pasted quote, §5.9.9 and §5.14) with the confidential mark's unit (31), and its ＋ the speaker's screen (§5.9.10) with
  that line's unit (29), each joining the ❝ Quote tab as it joins the Preview's bar; a person is reached from the tab's own To ▾ (Show Ana), the People tab's Show them ▸ gaining no quote row
  of its own. Bench: no measurement this round.
- Rolling back: nothing new is kept: a web quote's sealed address sat beside its host already; 0.5.1 reads no quote.
- Tests: `test/pages.test.js` (a web source's address kept only with the pusher's web right, the host alone otherwise, a
  bad address and AGMessage's own refused either way, a host named by the asker refused; told opened where kept, by its
  host alone where it cannot be opened or opens to another host or to no web page's address; no address at rest, sealed or
  in clear, without the right; the console's and the audit's words name the host alone), `test/takes.test.js` (end to
  end: the operator's web quote told the Board's page with its address and fragment, sealed at rest; a Staff account's
  told the host alone with no address in any frame or in `pages.json`, its row naming the host; the operator's under
  Earlier keeping its address; a locked hall's backstage guest's quote told its address only while the admin's switch is
  on, and the one she showed while it was on keeping it, told again at a join, once it is off), `test/docmodel.test.js`
  (each bound the paste's and the pick's bar say, word for word as `cleanPage` refuses it; a table's first row its labels
  only where every cell of it is a header; `pastedQuote`: a table with its labels and a picture that adds nothing, a merged cell, a
  hidden cell and row never read, HTML that disagrees falling back to the plain words as a table or text, items and
  numbered items, other structure as text, tab-separated values with a quoted cell, a blank line and a short row, nothing
  to quote; `pasteOver` and `pasteCut` at each bound; `pagelayer.mjs`'s `lookFor`, a directive's words with its prefix
  and suffix left out, among other directives, cut at 300 and none where it cannot be read, and `sourceHref`, from the
  first words of the first line to the last of the last, a short quote whole, its terms encoded, a table from its first
  cell to its last, an own fragment kept, and nothing without an address or with one a frame would refuse),
  `test/catalog.test.js` (Open the source on a quote with an address
  in the full view, never without one, never in the simple view). The browser smoke (a hall of its own): pasted
  tab-separated words a table snippet on the Board's page and the box emptied; pasted HTML with a table becoming its rows
  with its header row, its `<img>` fetching nothing (the network log) and a `display:none` span's words absent; HTML whose
  words disagree with its plain flavour falling back to the plain words; typed words reading "Typed by Ana Admin"; a web
  quote from the operator offering Open the source with a text directive from its first and last words in a tab of the
  person's own, and from a Staff account naming the host with no link and no take carrying its address; a web take with
  `#:~:text=` saying "Look for: ❝ …" over its frame and keeping the fragment in the frame and in Open in a new tab, its
  menu read once the page has drawn the take; a 25 × 10 table said "Long for the stage — the Board will scroll" with Show
  still offered; a file dragged over the box with no place to land and one dropped said, nothing attached; over a Staff
  account's fresh quote the operator's tab saying "The Board is reading Qia Staff's quote (n s) — Replace · Show a person
  instead", and Replace showing the operator's; that account given web pages and not quotes drawn no tab and no Preview
  bar; no console error or CSP violation. **On the device legs** (1180 × 820, 820 × 1180 and 390 × 844, touch) **and the
  floor leg**: a web page at a place with its "Look for" words over the frame; the operator's web quote's Open the source
  at its words, in a tab of the person's own with no opener or referrer, ✓ on all 3; a Staff account's naming the site
  alone with no link; a Word table's header row drawn as headers. The floor leg's Look at a document
  with its stand-in now waits for the Look before it to close: the dialog's close event, a task of its own after
  `close()`, could empty the next Look when it came after it (a race of the smoke's own speed, seen once).
- The papers: `README.md`, `README.txt` (❝ Quote), `SECURITY.md` (a pasted quote's HTML parsed inert and checked against
  its plain words; a web quote's address only with `stage.web`), `docs/DISPLAYS.md` (a pasted quote, Open the source,
  Look for), `docs/ACCOUNTS.md` (`stage.web` and a web quote's link), `docs/DESIGN.md`, `docs/ANALYSIS.md` (`parseInert`'s
  callers), `docs/DEVICES.md` (Open the source and Look for below the floor), `CLAUDE.md`.

**A push can carry one line to the speaker's screen, through the operator or at once** (the plan's Part 4, unit 29, its
§5.9.10 with §5.9.7's bar and step words; the owner's answer 16, "options for both", the path chosen per send; the
confidential line's rule, §5.9.10's three steps and S6, is the confidential mark's unit, 31)
- **＋ Also on the speaker's screen — every Stagewatch output, NDI and its viewer page show it**, in the Preview's bar
  and the ❝ Quote tab, for a presenter who reads only Stagewatch's speaker screen: one line of plain text sent with the
  push. It is drawn only where this seat can reach the hall's Stagewatch (`stage.send`, and a way open: the join's
  `canSendToStage` or `canPropose`), **off on every push until ticked** (a push turns it off again), and **disabled until
  there is something to send**, with why ("Pick words in the file, or type a line above it, to put one on the speaker's
  screen.", "Paste or type what to show first."). Ticked, it offers **📝 Ask the operator** (`stage:propose`) and **🖥
  Send now** (`stage:send`), each disabled with its reason where its way is closed ("The show desk is not connected",
  "Sending at once needs Stagewatch's key", the link's own words while it is down; through the desk, a line over 377
  characters too), **preset to the way this device chose last** (`localStorage`, in try/catch) and the first time to Ask
  the operator where the desk can take it. Under 🖥 the words say what it does, which the researcher cannot otherwise see:
  "Replaces what the speaker's screen shows now, the operator's message included, and cancels its waiting
  acknowledgement." Before it goes the bar shows the line and counts it: "“Revenue Q3: £4.2m” — 17 characters: 500 sent
  now, about 377 through the desk; it reads at a glance up to about 60." (an estimate from Stagewatch's layout, not
  measured). The Preview's bar, which has several pushes, also says which one carries that line: "It goes with the picked
  words, by their 📺 Show." where words are picked, else "It goes with a picture or the document." (the line above it).
  **The line goes only with a push whose own line is the one ＋ showed**, and the page sends that line as it showed it: a
  push of the bar whose words are another line (What I see's words, a picture or the document while words are picked, a
  unit chosen from the pick's menu that the bar did not draw) goes without one, its toast saying "No line went to the
  speaker's screen: this push's words are not the line ＋ showed — send that line with the push it names, or as a line of
  its own." (or that a picture or the document carries only the line typed above it); and ＋ ticked with its way closed by
  the time of the push (the link down) says why in the link's own words. After the push the one toast says the take,
  then the line's step, "📝 waiting for the operator — their answer follows on its line in the chat" or "🖥 on the
  speaker's screen — the speaker's acknowledgement follows on its line in the chat" (only where Stagewatch says it applied
  it; "🖥 Stagewatch took the line" otherwise), or why no line went; the receipt, the operator's answer and the speaker's
  acknowledgement follow on the room's line (`renderStageLine`, `renderProposalLine`), as every send's do.
- **The line is the push's own words** (`stagelines.flatten`, one core with the hall page, `public/linecore.js`): a
  quote's words in one line with its marked labels (a cell "Revenue Q3: £4.2m", a row or a column by its label "Q3:
  Revenue £4.2m · Costs £3.9m", a range row by row joined by "; ", a slide's title before its items, the blocks in view
  joined by " · "), or a document's or a picture's line above it; never a file's name, an address, a page or a cell's
  reference unless typed, and no line for a web page or a show take. Line breaks and runs of spaces are one space, no
  control or invisible character, braces as parentheses: the line the speaker's screen shows. **The page's line is the
  server's**: each string is read first as the server's cleaner keeps it (a quote's words as `guard.cleanBlock`, a title
  and a note as `guard.cleanText`, a title cut at 120 and a note at 200, where the cleaner cuts them), so a line drawn
  from words carrying a character the cleaner drops (a zero-width space in Thai or Khmer, the marks Word puts around a
  number in Hebrew and Arabic, an isolate, a word joiner, a byte-order mark) or from a long slide title is the line the
  server builds, never one it refuses as not the push's own.
- **The server builds it from the take it stored** (`withTake: <seq>` on `stage:send` and `stage:propose`): the take must
  be of the information layer, this person's (`by.who`), in this hall, put up in the last minute (`AGM_PUSH_LINE_MS`, 60 s)
  and not withdrawn; else "The line goes with a push of yours from the last minute — send it as a line of its own
  instead.". A `text` sent with it is the line the page showed, read as one line of the screen, and **one that differs is
  refused: "The line must be the push's own words."**; a take with nothing to send, "That push has no words for the
  speaker's screen — a document or a picture needs a line above it."; a `withTake` that is no whole number, "That line's
  push could not be read."; a destination other than the speaker's screen, "A line with a push goes to the speaker's
  screen." A line of a person's own words goes without `withTake`, as before, from a message's 🖥 and 📝.
- **The room's record carries no quote of it.** The room's line reads "Ana sent a line (17 characters) to the speaker's
  screen with a push" or "Ana asked the operator for a line (17 characters) on the speaker's screen with a push — waiting
  for the show desk" (a line of a person's own still quotes its first 120 characters), so observers and the transcript
  read none of its words; the proposal on it keeps **`lineMac`** (`guard.mac` of the line under the machine's secret) in
  place of `line`, and the follower compares the MAC of the line the desk holds with it, after a restart too, so it still
  knows its own proposal and drops one whose line the desk no longer holds as asked ("lost"). One `stagewatch.send` or
  `stagewatch.propose` row, counts only: "a line (17 characters) on the speaker's screen, sent now, with a push", "asked
  the operator: a message (17 characters) for the speaker's screen, with a push — proposal p3". The words stay where what
  was shown is kept: the take itself, its Earlier entry, and the take's entry in the stage record (its `line`, below),
  which a withdrawal leaves in place.
- **The Preview's bar has one line above it for every choice**: the box moved out of the pick's bar to sit beside whom
  it goes to and where it arrives, and a picture of a page, a region, a picture in the file, the document and What I see
  each carry it now (a document's and a picture's note were `cleanPage`'s already; the bar sent none).
- Choices where the plan left room: a range's rows are joined by "; " and a cell is its labels then its value (the row's
  label before the column's), as the plan's two examples read (a picked cell, and a range one column wide with its label
  column; a column picked alone carries no row label, as the Board's card draws none); the line shown before a push from
  the Preview's bar is the pick's words where there is a pick, else the line above it, and a push of the bar that carries
  another line sends none and says so (the page cannot draw What I see's words before they go, so What I see carries a
  line only where it is a picture, with the line above it); the bar's
  ＋ is not offered in the short document bar (⋯ ▸ The document…, the People tab), which has no line above it; a line
  sent with its take is checked against the window from the take's own time, so a take put up and taken down within the
  minute may still carry its line; Send now asks Stagewatch's "Got it", as a message's 🖥 does.
- Rolling back: 0.5.1 reads a proposal without `line` as one it compares by number, address and time alone, and a room's
  line as text; nothing else is kept.
- Tests: `test/showbus.test.js` (`flatten`: a cell with its two labels, a row and a column by their label, a range row by
  row, a cell without labels its value alone, no cut counted, text in one line with braces as parentheses, a slide's title
  before its items, the blocks in view, a web quote's host and address left out, a document's and a picture's note alone,
  no line for a document without one, a web page, a show take or no take; the server's `flatten` the page's core; the
  bar's bounds Stagewatch's, 377 through the desk at every urgency; the page's line of every content the line of what
  `cleanSnippet` and `cleanPage` store, over every character of the BMP in a title, items, a paragraph, a table's labels
  and value and a picture's note, with invisible characters, every line end, a 130-character title, one cut inside a
  surrogate pair and a 210-character note; a picked cell and a range one column wide from `docmodel.gridQuote` reading
  "Revenue Q3: £4.2m" and "Q3: Revenue £4.2m · Costs £3.9m"), `test/server.test.js` (end to end, with the mock
  Stagewatch: a `text` that differs refused and nothing asked of the desk; Ask the operator proposing `message "Revenue Q3:
  £4.2m" info off ack`, the room's line naming 17 characters and no record of the room quoting it, the proposal holding
  `lineMac` and no `line`, one `stagewatch.propose` row; Send now with no `text` sending the take's own words, its line and
  its one row; another person's take, no take, a show take and an old take refused with the words, a web page's with no
  words, a `withTake` of the wrong type and a `text` that is no line refused; a line read as the screen shows it accepted;
  a paragraph with U+200B, U+200E, U+200F and an isolate, and a slide with a 130-character title, each sent with the
  page's own line of it as `text`, accepted and sent to Stagewatch as the page showed it; after a restart a proposal
  followed to its approval by its MAC, and one whose line the desk changed lost), `test/inputs.test.js` (`withTake` in
  every shape; a line with a push whose number is no number refused before anything is looked up, from an open hall's
  backstage guest and a locked hall's, and nothing audited), `test/modules.test.js` (`lib/stagelines.js` →
  `public/linecore.js`, a page core a pure module may require), `test/pagefloor.test.js` (`linecore.js` defines only).
  The browser smoke (a hall of its own): ＋ not drawn without a Stagewatch, off by default once linked; ticked, 📝 and
  🖥 both offered, Ask the operator chosen the first time, 🖥's words and the line's count said; Ask the operator
  proposing the desk's line with the room's line naming its length, ＋ off again after the push; Send now sending the
  line at once and the choice kept on this device, preset to it after a reload; a document with no line above it disabling ＋ with its words, and with one sending that line
  alone, never the file's name, ＋ saying it goes with a picture or the document; with words picked as well, ＋ showing
  them and saying they go with their 📺 Show, the document and What I see each sending no line and saying why, the pick's
  Show sending exactly the line drawn; ＋ ticked and the link down by the time of the push, the take going and its toast
  saying why no line went in the link's words; a Stagewatch without a show desk disabling 📝 with "The show desk is not
  connected." and 🖥 chosen; no ＋ for a Staff account without `stage.send`; no console error or CSP violation. Bench:
  no measurement this round.
- The papers: `README.md`, `README.txt`, `docs/NODES.md` (a line with a push on the speaker's screen and the show desk),
  `docs/ACCOUNTS.md` (the rows' words), `docs/DISPLAYS.md`, `SECURITY.md` (the line built by the server; no quote in the
  room's record), `docs/ANALYSIS.md` (the page core and the fences that hold it), `app/README.md` (`AGM_PUSH_LINE_MS`),
  `CLAUDE.md`.

**What was shown to the Board is recorded, in the transcript and the minutes** (the plan's Part 4, unit 30, its §5.13 with
§5.11's stores and lifetimes and §5.12's minutes; the owner's answer 19, "Yes": who, the file and page, and a quote's
text; the confidential mark, its words in the transcript and what it withholds from the AI are unit 31's)
- **The stage record** (`lib/stagerecord.js`, new): one entry for each take a hall accepts, both layers, the Board's or
  one person's, and one for each take-down: who put it up and from which seat ("Ana (backstage)", "Ben (admin)"), for
  whom (the Board, or a person by name, never their key), the layer and the kind, what it showed in the console's words
  (a file by its name and place, "≈" where approximate; a web page by its host alone, never its address), a quote's words
  in reading order (its cells joined by " · ", its rows by line breaks), the side room it was sent from and the side room
  whose file it shows something of. A line sent with the take to the speaker's screen is kept on its entry as the server
  built it, "sent now" or "asked the operator"; a withdrawal marks its entry with its time, and the entry stays: what was
  shown was shown. **`seen`** is written once, when every page that held the take has settled on it or 10 s after it,
  whichever is first: how many showed it, of how many, and how many drew a document's stand-in ("✓ on 6 of 6", "on 4 of 6
  within 10 s", "✓ on 6 of 6, 2 as a picture"), what the pages said and nothing more. A page settles once it says it
  showed it (a page that showed it and was then minimised or put back to chat counts as showing it), or that it could
  not draw it, or that its person put it back to chat; a page that says it holds it out of view (asleep, in another app,
  under another take or held under blank) may still show it, so it is waited for until the deadline.
- **Where it lives**: `data/stage/<HALL>.json`, at most 500 entries a hall, the oldest going first and counted. Each
  hall's file has a write lane of its own (mode 0600), made at its first write, flushed at a stop and a crash and named in
  health (`stage <HALL>`); a stop that could not write one says "the stage record of 1 hall", never a hall's code. It is
  read once the copy holds its data folder, through `fs.promises`, and whatever is asked of it before then waits for it,
  in order; a torn file is read from its `.bak`, and a hall's file that cannot be read (a folder in its place is never
  read as one, on any platform) is said on the console and never written over that run, nor is any hall's when the folder
  itself cannot be listed. The record of a hall whose files are gone from `data/rooms/` goes at the start with its `.bak`
  (the boot sweep); a hall whose files are there but could not be read at that start (busy, or both torn) keeps its record
  for the start it loads (the store now keeps the halls a load found on disk, loaded or not). The start's sweep of
  temporary files a stop cut short reads `data/stage/` too. The record is its file's one writer, so its lane keeps a file
  it read whole as the `.bak` unread (a write lane's `whole`, the rooms' snapshots' `knownWhole`), and a torn one only
  once its own write has replaced it.
- **What clears it.** A Main room's reset clears its hall's record ("…, 3 takes ended, the stage record cleared" in its
  `room.reset` row, `cleared` in its answer); a side room's drops the entries sent from it ("…, 2 entries dropped from the
  stage record"), and what the Main room showed of one of its files stays the hall's. Each is written with no copy of the
  record before it, and so is `pages.json` at a reset and at a withdrawal, so a cleared quote's words are in neither file
  nor its `.bak`: a write lane's `clearBak()` makes its next write's `.bak` a copy of itself, after which each write
  keeps the one before again. A `.bak` another program holds (a scanner, on Windows) fails that write once the file
  itself is written, with why, and the lane keeps the clear and tries again until the `.bak` no longer holds what was
  cleared; it never counts as landed before. A record whose file could not be read at the start is not cleared on disk:
  this run's entries go, the row says "…, the stage record not cleared on disk: its file could not be read (EBUSY)", the
  answer carries `recordUnread`, and the admin page says what was shown before that start is still in it.
  A hall removed closes its lane, dropping what is pending, and takes its file and `.bak` with it, "purge files" or not,
  as it already takes its stage-only pictures; health's `saves.built` counts the lanes made and not closed, so it stays
  equal to the lanes named.
- **The transcript** (`/api/admin/transcript/:code`): a Main room's interleaves the hall's entries with its messages by
  time, a side room's the entries sent from it, each built with the same escaping as a message:
  "📺 14:02 — Ana (backstage) showed the Board (6 pages): ❝ a table cell from Q3.xlsx, 'Sheet1'!C4 — “Revenue Q3 £4.2m” ·
  ✓ on 6 of 6", "🖥 line: “…” (sent now)" when a line went, "withdrawn 14:03" when it was; "12 earlier entries are no
  longer kept" past the bound. Its header counts the messages ("120 messages", where it said "120 entries") and what was
  shown. It answers **`Cache-Control: no-store`** (it set none): whoever the admin page admits reads it, the laptop's
  token and any account with `settings.manage`, on any device.
- **The minutes** (`admin:summary`): the AI is given every entry the record keeps, beside the thread, "[14:02] Ana
  showed the Board: a table cell from Q3.xlsx, 'Sheet1'!C4 — "Revenue Q3 £4.2m"", with `; on the speaker's screen: "…"`
  for a line, what the pages reported and a withdrawal, under "Shown on people's pages (to the Board on stage, or to one
  person), oldest first", and a line counting those the record no longer keeps ("(12 earlier entries of the hall's record
  are no longer kept, so not included)"); its instructions read "From the conversation and what was shown to the
  Board". A take stays out of the room's feed and every reader of it: only the transcript and the minutes read the record,
  and the audit names the act without its content, as before.
- Choices where the plan left room: a withdrawal marks the take's own entry (`withdrawn`, with its time) rather than
  adding one; a hand-back the server makes itself (a reset, a deleted file, a withdrawal) is no entry, a person's
  take-down is; `from`, which the plan names without a shape, is the side room whose file a take shows something of, kept
  on the entry; a side room's reset drops, and its transcript shows, the entries sent from it (`sentFrom`), as §5.13
  says, so the Main room's record of showing a picture of a side room's file stays when that room is reset, and a side
  room removed leaves its hall's record as it is; `seen` counts the pages that held the take when it was recorded (a
  page that joins later is not counted, and one that goes before it settles is counted as not showing it); `clearBak()`
  keeps a copy of the new file as the `.bak` instead of none, so a write torn after a reset still has a whole backup, and
  `lib/resilience.js` keeps its count of synchronous calls; a side room's transcript says how many of the hall's entries
  are no longer kept.
- Rolling back: 0.5.1 does not read `data/stage/` and leaves it as it is; back on 0.6.0 it is read again. 0.5.1's
  transcript shows no entry.
- Tests: `test/stagerecord.test.js` (new: an entry's fields for a cell, a table, a web page by its host alone, a take-down,
  back to chat, a show take, a push sent from a side room of a file there and a picture of a page; an entry read back
  whole and one of the wrong shape refused; the transcript's and the minutes' words; nothing written before the record is
  read, one lane a hall named `stage <HALL>`, mode 0600; `seen` once every page settled: a page out of view or minimised
  waited for and counted once it shows it, a page that could not draw it or was put back to chat settled without showing
  it, a later report and another page's changing nothing, at the deadline what was shown by then, a stand-in counted,
  none to wait for; a line and a withdrawal on their entry, which stays; 501 entries keep 500 and count one; the minutes'
  lines, every entry and those no longer kept counted; a restart keeps it, a torn file read from its `.bak`, an entry of
  the wrong shape dropped, an unreadable file never written over and its clear saying so, a folder that cannot be listed
  writing no hall's, and the boot sweep; a side room's reset dropping the entries sent from it and keeping Main's picture
  of its file, and a Main reset clearing them, neither leaving the words in the `.bak`; a hall removed closing its lane,
  removing its file and `.bak`, writing nothing after; end to end with a mock Stagewatch and a mock AI:
  a quote's entry with its seat and words, `seen` from two Board pages once, the line sent now on its entry, a web page by
  its host, a take-down, a push from Legal and its withdrawal; the hall's lane in health with `built` and `named` equal; the
  transcript `no-store`, interleaved by time, a `<script>` quote escaped, the line and the withdrawal, Legal's transcript
  its own; the minutes' prompt holding the record's lines with their words; a restart keeping it, a planted full record
  with 12 gone saying so in the transcript and in the minutes' prompt, which holds all 500, the record of a hall gone
  removed at the start; Legal's reset and then Main's, neither the stage record, `pages.json` nor their `.bak` holding the
  cleared words, and their `room.reset` rows; a hall removed without purging taking its record, its `.bak` and its
  stage-only picture, its lane no longer named or counted; a hall whose snapshot is torn for one start keeping its record
  through it while a hall gone loses its own, and its transcript showing the record once it loads again),
  `test/resilience.test.js` (a lane's `clearBak()` and `close()`, a clear kept for a write that failed, a clear whose
  `.bak` is held once failing with the file written and landing on the next try with the words in neither file, a
  one-writer lane keeping a whole file as `.bak` unread and a torn one only after its own write; the record at 0
  synchronous calls), `test/modules.test.js` (`stageRecord` in the contexts), `test/uploads.test.js` (a Main room's reset
  row with the stage record's words; a side room's, which ends Main's take of its picture, leaves the record as it is).
  The admin page's Clear messages… says when a record could not be cleared; the browser smoke runs as before.
- Bench: the lane's save of a full hall's record at the quote's bound (500 entries of 4,000 characters, 2.1 MB), 20
  saves a run, three runs, on the build machine (Linux, 4 vCPUs): kept as `.bak` unread, 26 to 28 ms at the middle of a
  run and 38 ms at most; read first, as every lane's save was before, 34 to 36 ms and 42 ms at most, and one earlier run
  of that reached 51 ms, over the 50 ms mark reading 4 sets for a snapshot's stall. Kept unread, the worst save is under
  the mark, so the bound stays 500. The show laptop's is not measured.
- The papers: `README.md`, `README.txt`, `docs/DISPLAYS.md`, `docs/DESIGN.md`, `docs/ACCOUNTS.md` (`room.reset`'s
  words), `docs/ANALYSIS.md`, `SECURITY.md`, `CLAUDE.md`.

**A file can be marked confidential, and it goes only where it is in use or sent** (the plan's Part 4, unit 31, its §5.14
with §5.9.10's line, §5.11's stores and rows, §5.12's AI and §5.13's transcript; the owner's answer 16, "Files, especially
confidential, can only be sent to the rooms in use or selected", and S3, S6-S9, S12 and S16 as applied; an On stage seat
shares no file, so it marks none, as Part 7 amends §5.14)
- **One record a file.** The mark is `pages.json`'s `marks` (the upload's name: who marked it, the file's name, when),
  written once there is one; no message is rewritten, so every copy of the file, in every room and hall, a side room not
  loaded included, is marked at once, and a new message of a marked file is marked. A page is given a file message with
  `confidential: true` and who marked it (`markedBy`, their name and the uid their messages carry), live, in a join's
  history and a resume's ops, read back earlier (`history:before`, `history:message`) and in the admin's room view; a
  change of the mark is told to every page of every room holding the file (`fileMark`, by the messages' ids, unnumbered,
  latest wins). The record goes once the file has left the disk (one the disk kept, busy or not ours to remove, stays
  marked while it is there).
- **Who marks it.** Whoever shares a file marks it as it is shared: 🔒 Confidential beside 🔥 Priority, off by default,
  shown while a file is attached (`message` and `room:send` take `confidential: true`), the record written before the
  message is posted and taken back if the post is refused. Later, from a file's ⋯ (🔒 Mark confidential, `file:mark
  {messageId, on}`, one writes token): a seat backstage with `hall.files` where the file is, never a Viewer account, or the
  admin, from a hall page or the admin page's room view (the room it watches). The mark is removed by whoever set it or the
  admin ("Only Sue Staff or an admin can remove the mark."). Never On stage ("Do that from a backstage page."), nor from
  the admin's support view. Refused while the file is on a screen, a screen's holding slide, a hall's holding image or a
  holding slide on people's pages, naming each ("Take it off Foyer and the hall's holding image first: a screen is seen by
  whoever stands near it."), as a mark set by sharing or showing it is. Asked again as it is, it is answered `already`. One
  `file.mark` row for each mark set or removed, the file by its kind alone: "a pdf in Legal (Hall 2) marked confidential"
  / "…: the confidential mark removed", "… marked confidential as it was shared", "a png shown on people's pages in Main
  (Hall 2) marked confidential as it was shown", "a png drawn of a confidential file, marked confidential as it was
  uploaded in Legal (Hall 2)".
- **Where it is in use, and where it goes only confirmed.** In use: each room a message of which holds it, the room a
  fresh upload of it was made for, and where a take or an Earlier entry naming it is drawn (the Main room for the Board,
  each room a person's pages sit in). `room:send` and `forward` into a room where it is not in use, and a take that would
  draw it where it is not, are refused until the sender confirms (`confirm: true`): "This file is marked confidential:
  confirm to send it to Hall 2. It will be in use there." / "…: confirm to show it in the Main room. It will be in use
  there.", the answer carrying `confirm` and the rooms; the page asks once more, naming the rooms, and sends it again
  confirmed (S12). A confirmation comes from a seat that may download it where it is in use, or the admin. The rows say
  "a confidential file (pdf, 2.1 MB) from Legal (Hall 2) to Main (Hall 2), confirmed" (a forward is a `room.send` row too)
  and "the Board (6 pages) → a confidential PDF at p. 3, confirmed". A picture or a quote keeps the upload it was made
  from on its take by a reference (a keyed hash of its name: never its address, which `pages.json` still holds of no
  quote; the server's alone, never told a page), so it puts its file in use where it is drawn, as a document does.
- **What carries it.** A take is marked by the server from its file's record whatever the page sent: a document, a
  picture of it (the upload's new form field `from`, `m:<messageId>` of the room's file or `s:<seq>` of the take that
  shows it, which the page sends for a picture drawn for the older devices and for Show them a picture, marks the picture
  as it is stored, before any take names it; a `from` of any other shape is refused), its stand-in, and a quote picked
  from it. A page may add the mark (🔒 Confidential in the Preview's bar, lit and locked for a marked file, and on the ❝
  Quote tab), never remove it; a fresh upload shown so is marked by who showed it.
- **Marked after it went up.** A file marked while a take of it is up, or an Earlier entry names it, marks every such
  take (a picture or a quote made from it too; a page shown it draws its 🔒 when it is next told its takes, at its next
  take or join), and every check reads the take as it is now: its line and the hold, the
  AI's "now" line, a draft's document, a picture drawn of it, the console's words to each asker. The stage record's
  entries keep the uploads they name by the same references (the server's alone), so the transcript and the minutes read
  the mark as they are read: an entry shown before its file was marked is withheld from the AI and keeps its words to the laptop.
- **Never on a screen.** A confidential file is refused on a screen, as a hall's holding image and as a holding slide on
  people's pages: "A confidential file is never shown on screens: anyone near them can see it." (S3). ⧉ Show on screens
  is drawn greyed with those words on a confidential file, and the holding image's list shows a marked picture, never to
  be chosen ("🔒 name — confidential: never on screens").
- **Named only where it is in use.** The console's words mark it ("🔒 ❝ a paragraph from Legal advice.pdf, p. 3"), the
  audit's say "a confidential …", and an asker of `page:status` seated in no room where the item is in use (a Media
  researcher) reads "🔒 a confidential item", with no file, place or words, nor the room it was sent from, and is given
  no file to send a picture of.
- **Its line on the speaker's screen** goes only when the item is in use in the hall's Main room ("This is confidential to
  Legal: show it in the Main room first.", naming each room where it is: for a take of files, where every file it shows
  or was made from is in use), to the hall's own Stagewatch ("This hall shares its Stagewatch with another
  hall: a confidential line is not sent there.") over an encrypted link, https with its certificate pinned ("This hall's
  Stagewatch link is not encrypted: a confidential line is not sent."), with words that say what Stagewatch does with it
  (every output, its public frame, its triggers, its saved settings; S6). A hall page is told which in its frame
  (`secretLine`), so ＋ is off, with why, where it cannot go. Its row adds ", a confidential line". At most 20 confidential
  lines wait on one Stagewatch at once (sent, or proposed): the next is refused until they come up or the desk answers
  ("Wait for the confidential lines already sent to this Stagewatch to come up, or for the show desk to answer them: 20
  are waiting."), so no part of a hold is ever let go for its size.
- **The hold.** While a confidential line is on a Stagewatch's frame, its message reaches none of AGMessage's other
  readers: screens, the halls board, the context and the AI's brief get `''`; pages of a room where the item is in use
  read "🔒 a confidential line"; every other room `''`; its acknowledgement stays. Set before the line goes. The message
  held is held while the frame shows it (by its MAC or its id) and released once the frame moves past both: a new
  message, or the operator's clear. While anything waits, every new message is held, the newest kept, so a second line
  never releases the first before the frame has moved past it: a send waits for its own message (the one carrying its
  receipt's id or a later one, Stagewatch numbering upward; with no id, the first new one; a receipt read before
  Stagewatch restarted, or before AGMessage's own start, the first new one); a proposal waits for the desk's answer (the
  operator may approve it edited): approved, done or lost (it may have run: the desk restarted, or no record follows it
  any more), the newest message held since it was proposed, else the next; rejected, failed or undelivered, its part
  ends and what is held stays held; an answer that is not plain (`unknown`) is asked again, holding meanwhile. Kept by
  MAC and id, never text, in `pages.json`'s `holds`, so a restart still holds the first frame; a frame-less state
  (connecting, a restart) releases nothing; a hold whose link is gone is dropped.
- **The AI.** `ai:draft`'s document text names its source (`docFrom`: `{messageId}`, `{seq}` or `{local: true}`): text
  with none, or from a confidential file or take, is refused ("This file is marked confidential: its text is not sent to
  the AI."), and a named file's name is the server's, never the page's (the page leaves a confidential file's text out).
  The thread says "shared a confidential file", the "now" line "a confidential item — not sent to the AI", and the
  minutes "Ana showed the Board a confidential item (its name and words not sent to the AI)", none of them its name,
  place, caption or words (S9).
- **The transcript** shows a confidential entry's mark, file and place, and its words and line only on the AGMessage
  laptop itself or with the admin page's 🔒 Include confidential text (`?confidential=1`), which writes a `room.read` row
  "…, confidential text included"; otherwise "(its words are shown on the AGMessage laptop, or with Include confidential
  text)". A marked file reads "📎 🔒 Confidential · name". A confidential file's download is one `file.download` row as
  its stream ends ("a confidential pdf downloaded in Legal (Hall 2)"), never at its ticket.
- **Where it shows**, an icon with its word, never colour alone: the file card ("📎 🔒 Confidential · Board pack.pdf"),
  the Preview's header and the pinned list, the take's card ("🔒" first) and its source line ("🔒 Confidential · Quoted
  by Ana · …") on the Board's pages, the console, the admin's room view and the halls board's line ("📎 🔒 name", never
  its caption). The admin's Roles & invites takes 🎟, so 🔒 means confidential alone among the acts.
- What it does not do: it is not encryption; a person who reads it can retype or photograph it; the mark on a picture or
  local copy and the AI's check hold for AGMessage's own page, not against one that rewrites itself.
- Rolling back: 0.5.1 does not read `pages.json`, so under 0.5.1 a marked file is an ordinary one, and a hold is not kept.
- Tests: `test/confidential.test.js` (new, end to end: shared marked, one record with no message rewritten, given marked
  to a page that joins, reads back and resumes, removed by its marker or the admin only, refused On stage, on a screen and
  as a holding image, and while on a screen; a picture drawn of it marked as it is stored; a Board take confirmed then in
  use, a picture and a quote marked whatever was sent; "🔒 a confidential item" to Media; `room:send` and `forward`
  confirmed and their rows; a download's row as it ends; the AI's draft and minutes withholding it, `docName` the
  server's; the transcript on the laptop, off it and with Include confidential text; the halls board's line; nothing in
  the context; the line refused for an item in use only in Legal, on a shared Stagewatch and over http, sent over the
  hall's own https link, the hold on screens, the board, Media's page, the context and the AI, "🔒 a confidential line"
  where it is in use, kept across a restart, a proposal approved edited held, two confidential lines in a row, a refused
  proposal over a held line, an answer that is not plain, the hold at its bound, each released by the next message; a
  file marked after its quote went up: Media's words, the AI's now line, a picture of the take, the minutes, the
  transcript and the line on a shared Stagewatch; the admin page's mark; a mark refused while a fresh upload is on a
  screen and while a picture is a holding slide on people's pages; the upload's `file.mark` row),
  `test/pages.test.js` (the mark on a take and its voices, the marks' record, the hold's steps: a send's own message by
  its receipt, two lines in a row with and without ids, a clear while one waits, a proposal approved, refused over a held
  line, approved before its message; `sentHold`; the bounds; a hold of the wrong shape never written; a take marked later
  and `markTakes`; `naming`), `test/stagerecord.test.js` via `confidentialOf`,
  `test/catalog.test.js` (the rows, the admin page's, and ⧉ greyed for a confidential file) and `test/menus.test.js`
  (their refusal), `test/inputs.test.js` (`file:mark`,
  `confirm`, `confidential`, `docFrom`), `test/modules.test.js` and `test/units.test.js` (the contexts).
- The papers: `README.md`, `README.txt`, `docs/ACCOUNTS.md`, `docs/DISPLAYS.md`, `docs/DESIGN.md`, `docs/NODES.md`,
  `docs/SHOWBUS.md`, `docs/ANALYSIS.md` (the contexts and the inputs fence), `SECURITY.md`, `CLAUDE.md`.

**The clock or countdown, chosen on the tablet and by the admin, who may lock it** (the plan's Part 7, unit 20b, its
§17.3 with §17.1's `sheet` and `person` rows, as Part 7 §0.1-§0.3 amend Part 1 §1.8, §1.10, §2.7, §3.3 and §6, Part 5
§14.2, §14.4, §15.5, §16.2 and §16.7 and Part 4 §5.9.11; the owner's ask of 2026-10-26, "the local and admin option to
include the current time of day or StageWatch data for showing countdowns as a secondary object", and answers "Yes, the
admin may lock the clock/countdown setting" and B3, "Clock on by default"; "the admin" read as Part 0 §0.8 C14's one
predicate)
- **The simple view shows the time of day** after the hall's name, before Help, until the Board member or the admin
  chooses the countdown or Off (B3): 🕐 14:12, a `<time>` with no role, hours and minutes by AGMessage's clock and zone (the
  join's `now` and `tz`; a browser that does not know the zone, its own), drawn again on the minute. **Stagewatch's
  countdown** is ⏱ **4:30 left** with the title and Stagewatch's line under it ("Q&A · Wrap up in 2 minutes"), in
  Stagewatch's own phase: ▲ **0:45 left** near the end, ▲ **Wrap up · 0:45 left**, ▲ **0:30 over** past it (the minus sign
  dropped: "over" says it), Stagewatch's text alone in any other mode; its digits are a `role="timer"` named by their own
  words ("4:30 left"), its title and line a sibling `role="status"`, never nested; Stagewatch's colour is the readout's
  3 px left edge alone (its white, or none: the border's), the digits ink. Live only while the hall's Stagewatch is
  connected (or viewing), its frame fresh and the page connected; otherwise **--:-- Stagewatch offline**, never a confident
  stale time, and with no Stagewatch linked **--:-- No Stagewatch linked** (the device may still choose it, and the sheet
  says "This hall has no Stagewatch linked."). A link that is up with no time yet (its first moment, or a frame with none)
  draws --:-- with the title and its line, as a screen does, never "offline". A confidential line reads as the hall's frame
  carries it to that room. On a phone the digits are on the header's first row and the title and line take a row of their
  own, only while Stagewatch has one; down 5 s or more that row is "Offline · reconnecting" alone. The take layer's bar
  draws the same readout in the simple view (its line no live region of its own: the page has one; no live time in the
  stage's muted ink). The full view keeps its countdown chip, which the simple view no longer draws.
- **Which one is drawn** is one pure function, `AGM.clockFor({admin, device})` (`public/catalog.js`): the admin's choice
  while it is locked; else the device's own; else the admin's; else the time of day. The server never reads a device's
  choice: it sends the admin's whatever the device stored, and the page draws what wins.
- **On the device:** ⋯ → **Clock or countdown**: Time of day · Countdown · Off, kept in `agm.clock` on that device alone
  and drawn at once; never sent to the person's other devices, and relayed only to the admin's support view of them
  (`userState` `clock`, one of the three, which the server relays to no other page; the support view draws it and acts on
  none of it, R8). **Locked**, the row is the admin's choice in words, "Clock or countdown: Countdown", with "Set by the
  admin for you." and no control; a lock set or taken off while the sheet is open redraws that row in place, the sheet's
  rows and their order kept, the device's choice checked again on unlock.
- **The admin's choice** is `{show, locked}`: `show` Off, the time of day, the countdown, or none ("Their choice (the clock
  at first)"), and `locked` keeping it on the person's devices; a lock on their choice is refused ("Choose one to lock
  it."), and anything else in "Choose Off, Time of day or Countdown." (`lib/views.js` `cleanClock`, pure, in the module
  fence's pure set: an unknown word, a field of the wrong type, a key of another name, `{toString: 1}`: a refusal, never a
  throw). A guest's is kept by their uid in `pages.json`'s `views` beside their chat view (one record a guest, within its
  5,000), an account's in `accounts.json` beside `view`; an account is made without one (`POST /api/users` ignores
  `clock`), and `Accounts.view` tells it last.
- **Three doors, one act.** The admin page's people rows (a **Clock or countdown** column beside Seat and Chat view: the
  choice, **Lock it on their devices** named for the person with why it cannot be ticked drawn under it, and "Applies in
  the simple view." beside a person whose Chat view is Full; on a narrow screen the people's table scrolls within its
  section, never the page), the hall page's People panel (the person's ⋯, the admin's own page, full view) and their ⋯ on
  the admin page: **Clock or countdown ▸** (with "Applies in the simple view." on its line beside a Full chat view) and
  **Lock it on their devices**, `admin:setClock {roomCode, socketId, show?, locked?}` (the takes module, behind the admin
  page's gate). The Accounts page's editor: **Clock or countdown** and **Lock it on their devices** beside Chat view, once
  per account, never in a hall's row, and the same two in the account's ⋯ (`PATCH /api/users/:id {clock}`). **The lock is
  the admin's alone**: on a page with a socket the laptop's token or an account whose role is admin (the join's
  `theAdmin`, before `clock`), on the Accounts page an account whose role is admin (the PATCH's own rule: the token's
  cookie beside a manager's account locks nothing there, and its Lock is drawn so); a manager granted `settings.manage` (or
  `users.manage`) may choose and is refused the lock, "Only an admin may lock the clock or countdown.", and its pages draw
  Lock disabled with those words. **Their choice takes a lock off with it** (a lock holds a choice): every door sends it
  as `{show: null, locked: false}`, so on a locked clock it is the lock's alone, drawn disabled with the lock's words for
  anyone else, and the admin's one act clears both. On the socket an account is reached as the Accounts page reaches it
  (`rbac.mayChange`: "You may not manage accounts.", "Only an admin may make or change an admin."), and nobody sets their
  own (the self-change words).
- **Told live, nothing closed.** The join's answer appends `clock` (the admin's, `{show: null, locked: false}` when unset;
  the support view's, the person's) as its last key; a change is told as `clock {show, locked}` to every page of the
  person's and the admin's view of them, and to no other page; a change of the chat view or the clock alone reloads no
  page of an account's. The admin's people list carries `clock` beside `view` (only the admin's), sent again to the admin's
  pages where the person sits.
- **Audited, every lock and unlock:** `person.clock` for a guest ("Rita (guest) → clock: countdown, locked", "… → clock:
  countdown, unlocked", "… → clock: their choice"), `user.update` for an account ("clock → time of day (locked)"); a choice
  as it stands writes none, and the device's own choice is no row (a person's act on their own page).
- **Rolling back:** 0.5.1 keeps the accounts' `clock` and ignores it; it reads no `pages.json`.
- Tests: `test/catalog.test.js` (`clockFor` case by case; the sheet's row, its choices and its lock; Clock or countdown ▸
  and Lock it on their devices on the admin page, the People panel and the Accounts page, the lock disabled with the
  server's words for a manager and on their choice, by the PATCH's rule on the Accounts page; Their choice on a locked
  clock the lock's alone; "Applies in the simple view." on a Full chat view's line; the hall page's `theAdmin`), `test/units.test.js` (`cleanClock`: unknown
  words, wrong types, a lock on their choice, `{toString: 1}`), `test/pages.test.js` (a guest's clock beside their view, one
  record, its bound, and records of the wrong shape dropped as they are read), `test/takes.test.js` (end to end: a guest's in
  `pages.json` and an account's in `accounts.json`, read from the files; told to every page of the person and their support
  view and nobody else; the admin's list alone carrying `clock` and `view`; the join's `clock` its last key; the PATCH on
  oneself refused; a `users.manage` manager refused the lock, taking it off or putting one on a clock that holds none, and
  given the choice; a `settings.manage` manager refused the lock on the socket, given a guest's choice and refused an
  account's; Their choice on a locked clock refused to a manager and taken whole from the admin; a clock-only change
  ending no socket; one row each for set, lock and unlock; the device's choice relayed to the support view alone), `test/accounts.test.js` (the account
  view's last keys), `test/menus.test.js` (`admin:setClock` refused to every seat but the admin's, and the join's keys),
  `test/inputs.test.js` (`show`, `locked`, and `admin:setClock`'s typed cases), `test/modules.test.js` (`lib/views.js` in
  the pure set; `clockChanged` in the contexts), and the browser smoke (a fresh tablet's 🕐 HH:MM, Off, the countdown
  unlinked, linked, near the end and over, its edge and ink, the take layer's bar, the lock and unlock with the sheet open,
  the support view mirroring the device, the link down; on a phone, the digits on the header's first row, the line's own
  row only while there is one and the offline words alone there while the page is down, and --:-- with the title while
  the link is up with no time; the sheet's rows; the admin page's Clock or countdown cell, its tick's name and why, and the
  Accounts page's fields). The smoke reads a quote's table on a phone once the take layer is shown and two frames have
  passed, so a fit its box's first size sets off is never read before it runs.
- The papers: `README.md`, `README.txt`, `docs/ACCOUNTS.md`, `docs/ANALYSIS.md` (the pure set), `CLAUDE.md`.

**A pin for the room or for me; On stage for me only** (the plan's Part 7, unit 20c, its §17.5 with §17.1's `pin` and
`pin:mine` rows, its facts `pin` and `pinMine`, the catalogue's pin rows and their fold, "The pin doors by seat" and §17.2's
pinned bar, as Part 7 §0.1-§0.3 amend Part 1 §1.10, §2.7, §3.3 and §6, Part 5 §15.5 and §16.2-§16.8 and Part 4 §7.7; the
owner's answer B1, "they can pin messages for themselves", the pin rule of 2026-10-27, "A pin can be for the room (default)
(including On stage - essential for action prompts), or personal" and "A board member cannot pin for the room, only
themselves", and the three readings answered the same day)
- **Two kinds of pin.** **For the room** is the message's own pin, as before: a room's op every page in the room hears
  (`pin {messageId, pinned}`, `pinUpdate`), shown to everyone, On stage included, and kept in the room's record and the
  transcript. It is made only by a seat that may post and is not On stage: **On stage it is refused first**, the admin
  seated there included, "Pinning for everyone is for the backstage team.", then an observer or a Viewer account with
  today's "Observers can read but not post.". **For me** (`pin:mine {messageId, on}`, new, the takes module) keeps a
  message's id for the person alone, by their key (`a:<account id>`, so every device of the account shares them;
  `u:<uid>` for a guest's browser) and the room, in `pages.json`'s `pins` (the `pages` lane; at most 50 a room, the 51st
  refused "50 pins in this room at most: unpin one first.", and 5,000 persons, the record written longest ago going
  first: a bound of its own beside the views' 5,000, where the plan counted them inside it, since one shared count would
  let a guest's pins, made under fresh browser identities, push out the admin's chat-view and clock choices); it is
  **every seat's** that reads the room, On stage, observers and Viewer accounts included; it never changes
  the message, is no room's op and reaches nobody else: the person's pages in that room and the admin's view of them are
  told their pins (`pins {ids}`), and the answer carries them. It passes the one gate first, a `writes` token and then
  `hall.view`, as every verb of a handler module does, so the support view's refusal comes after the token, where
  §17.5 put it before; nothing the request names is read before either. Twice keeps one; `on` that is no boolean is refused "Say
  pin or unpin."; a message not in the room "Message not found"; from the admin's support view, which joins under the
  admin browser's uid, "Pins are the person's own.", nothing kept under either key. An id whose message has gone is passed
  by on the page, never told at a join, and dropped at the person's next pin write in that room; a room reset drops every
  person's pins in it (their pages told) and a room removed (its hall's rooms with a hall) drops them too, unless it
  comes back at the next start; a start drops every pin in a room neither loaded nor on disk, and an account removed
  takes its pins with it. Neither kind of pin is audited; a pin for oneself is in no transcript, context, hello or AI
  brief (the room's stays "📌 pinned" in the transcript).
- **The join's answer appends `pins`** (this person's ids in this room whose messages it still holds, in the order
  pinned; the support view's, the person's it shows) after `clock`, its last key, and a first open carries every message
  they name however old (`older`, beside the room's pins), so the pinned place is drawn whole at once, however many: a
  read back counts them as carried, and a page reads one back by its id only after a resume; the catalogue's facts gain `pin` (the room's: a seat that posts and is
  not On stage), `pinMine` (every seat) and `pins`. The gate (`lib/gate.js`) reads a third right, `hall.view`, with its
  words; `pin:mine` asks no more, and the busy line counts it as a person's input.
- **One door, the room's first.** A seat that may pin both ways (backstage, a side room's Member, the admin off stage)
  has **📌 Pin ▸ For the room · For me** in a message's ⋯, right-click and Shift+F10, each a `menuitemcheckbox` checked where
  it is pinned that way, For the room first and focused (P, then Enter, pins for the room; P, ↓, Enter for me), and
  **📌 Unpin ▸** while it is pinned both ways; on a touch screen it drills in with "‹ Back". A seat that pins for itself
  alone (an observer, a Viewer account, On stage in the full view, the admin On stage) has a flat **📌 Pin for me** /
  **📌 Unpin for me**, and P acts at once. The Preview's 📌 is the same: the fold as one menu button, or the flat Pin for
  me. **Undo by kind** for 10 s: "Pinned for the room. · Undo", "Pinned for you. · Undo", "Unpinned for the room. ·
  Undo", "Unpinned for you. · Undo"; a refusal says the server's words. Offline, For the room is disabled with
  "Not connected — AGMessage is reconnecting."; For me is held by the outbox, shows ◷ and goes when the page is back.
- **Every pinned place holds both kinds, the room's first** (the newest message first), then the person's own (the newest
  pin first): the full view's pinned strip (a seat with no panel lists its pinned files there too) and the panel's pinned
  files, each entry saying "📌 For everyone", "📌 For you" or "📌 For everyone · for you", its door unpinning the kind it
  shows (both: 📌 Unpin ▸) and none where this seat may not unpin it (the room's, for an observer or On stage); that door
  is 📌, named "Unpin for the room" or "Unpin for me", where §17.5 drew ✕: ✕ is the fault mark, and no act's icon is a
  mark; a message's
  line says "📌 Pinned for everyone", "📌 Pinned for you" or "📌 Pinned for everyone · for you", muted.
- **The simple view's pinned bar**, under the header and a phone's tabs while there is a pin: one line, 48 px (44 px on a
  phone or under 500 px tall), "📌 For everyone" or "📌 For you", the message's words cut to one line, "1 of 2" where there
  are several; on a message it goes to it in the feed, outlined for 2 s (no motion where the person asks for less), and
  shows the next pin. A tapped message's row (the second door) gains **📌 Pin for me** / **📌 Unpin for me** after Got it
  and Reply; it is the simple view's one pin door (with 📌 Unpin for me on a question pinned for oneself, in the bar): the
  room's pin has none there, and neither has a file in the Look panel.
- **A pinned question, in every view** (the owner, 2026-10-27: "A pinned question becomes hidden in the scrolling chat,
  and becomes visible in scrolling chat when unpinned."): a question pinned for the room, or for this person, is hidden
  from their feed (`data-pinned`, `data-pinned-mine`; ↓ n new does not count it and the roving feed skips it) and drawn
  whole in their pinned place alone, the strip or the bar, where it is answered: in the bar its words, its answers (48
  px), Answer in words… (asked in place) and, once answered, "You answered Yes · 14:10 · Change"; one pinned for the person
  has 📌 Unpin for me there, its one unpin door in the simple view; the line on a question shows the next pin ("Next
  pin"), and is no button while it is the only pin. One pinned for the person leaves only that person's feed (their pages
  and their support view). Unpinned, it is back in its place by its seq, its answers kept.
- **The support view** draws the person's pins, both kinds, and their pin doors disabled with "This is Kim's view — act
  from your own page.", sending nothing.
- **Got it clears** (and its rule that a message pinned either way is never cleared) lands with the admin's On stage
  settings, unit 20d.
- **Rolling back:** 0.5.1 reads no `pages.json`; a room's pin is unchanged.
- Tests: `test/pins.test.js` (new, end to end: `pin:mine` from a Board guest, a backstage guest, an observer and a Viewer
  account, each kept under its own key in `pages.json` and told to that person's other pages and support view alone, no
  room op; a Board account's tablet to its phone and support view; twice once, unpinned, the refusals in their words, the
  support view's under either key; the room's pin heard by every page, refused an observer and a Viewer by today's words
  and the Board guest, the Board account and the host's admin On stage first; a question pinned for the room answered On
  stage; a deleted message's id never told at a join and dropped at the next write; the 51st refused; a reset dropping
  them, its pages told; a side room and a hall removed dropping them, the hall's other rooms keeping theirs; an account
  removed taking its own; a start dropping those in a room no longer here; no audit row for either kind),
  `test/server.test.js` (45 pins for oneself older than the window, every one carried with the first open, in the room's
  order, and read back alike),
  `test/pages.test.js` (the store: order, once, gone ids, 50 a room, rooms forgotten, the rooms held, a person
  forgotten, 5,000 persons, read back by shape), `test/units.test.js` (a first open and a read back carrying a person's
  own pins),
  `test/catalog.test.js` (the facts; the fold, its checks and labels, flat where alone, its key and the strip's doors;
  every seat's set; the simple view's second door with 📌; a pinned file's doors in the list and the Preview's, none in
  the simple view;
  offline, held), `test/menus.test.js` (`pin` refused as both Board fixtures in the On stage words and as an observer and a
  Viewer in today's; `pin:mine` open to every seat; the join's keys), `test/inputs.test.js` (`pin:mine`'s typed cases),
  `test/units.test.js` (the gate's `hall.view`), `test/modules.test.js` (`pinsChanged` and `ownPins` in the contexts),
  `test/server.test.js` and `test/takes.test.js` (the join's last keys), and the browser smoke (a backstage page's 📌 Pin
  ▸, For the room focused, Enter, every page's line, the strip and the Board's bar, Undo; P ↓ Enter for me on that page
  alone; both ways and unchecking For me; an observer's flat door, P and Undo, and no door on the room's pin; the Board's
  tapped row, its line, its bar's order, "1 of 2" and its taps; the full view's flat door and P; a pinned question hidden
  from every reader's feed and answered in the bar, Answer in words in place, "You answered …"; a question pinned for one
  Board member alone, two in the bar, each answered, unpinned back between its neighbours; the bar's height with a
  pinned question, not answered and answered, at 1180 × 820 and 390 × 844, recorded against §17.4's estimate (105 px
  and 101 px) and within 30% of the viewport: measured 150 px and 169 px on the tablet, 187 px and 159 px on the phone,
  above the estimate, which a device's reading checks; the support view's doors disabled; a pinned file both ways in the panel;
  offline, For the room disabled and For me ◷).
- The papers: `README.md`, `README.txt`, `SECURITY.md`, `docs/ACCOUNTS.md` (pins by seat), `docs/ANALYSIS.md` (the gate's rights, the typed case), `CLAUDE.md`.

**What a seat On stage may do: where its messages also go, and what Got it does** (the plan's Part 7, unit 20d, its §17.6
with §17.1's `message {also}` rows, `compose.also` and the `person` and `account` rows, and §17.2's Also on, status words
and cleared line, as Part 7 §0.1-§0.3 amend Part 1 §1.8, §1.10, §2.7, §3.3 and §6, Part 5 §13.3.4, §14.2, §14.4 and §16.7
and Part 4 §5.9.1, §5.9.10, §5.9.11 and §5.13; the owner's answers B2, "An account seated on stage gets messages on that
page … An admin can choose if messages can go onto other screens - such as on a countdown screen, or anyone with an On
stage seat", and B4, "Got it tells the backstage team with the members name. Clearing the message is an admin option, off
by default", with "Pins 3", a pinned message never cleared; "the admin" read as Part 0 §0.8 C14's one predicate)
- **Three switches for a person, each off by default and the admin's alone**: **May send to a countdown screen**, **May
  send to people On stage** and **Got it clears the message** (`onStage {screens, people, clears}`, cleaned fail-closed by
  `lib/views.js` `cleanOnStage`: each a boolean, a change naming only what it changes, anything else "Choose on or off.",
  400 over HTTP, never a throw). A guest's is kept by their uid in `pages.json`'s `views` beside their chat view and clock,
  an account's in `accounts.json` beside them (`Accounts.view` tells it last); `POST /api/users` ignores it, so an account
  is made with every switch off, whoever makes it. **The admin** is the laptop's token or an account whose role is admin
  (`theAdmin()` on the socket, the signed-in account's role on the PATCH); a manager granted `settings.manage` or
  `users.manage` is refused, "Only an admin may choose what an On stage seat may do.", and its pages draw the switches
  disabled with those words; nobody sets their own (the self-change words). On the socket, `admin:setOnStage {roomCode,
  socketId, screens?, people?, clears?}` (the takes module, behind the admin page's gate, then the predicate), an account
  reached only as the Accounts page would reach it; over HTTP, `PATCH /api/users/:id {onStage}`. A change that names no
  switch (`{}`), or `admin:setOnStage` naming anything but the person, the switches and the outbox's `cid`, is refused in
  the same words on both doors, never answered as done.
- **Three doors, in the same words, each a tick with the admin's words under it.** The admin page's people rows (an **On
  stage** column, for a person seated On stage: each tick named for the person, why it cannot be ticked drawn under them;
  "Applies On stage." for anyone else), the hall page's People panel (the person's ⋯, the admin's own page, full view, a
  `menuitemcheckbox` each) and the Accounts page (under **When On stage** in the editor, once per account whatever the hall,
  and in the account's ⋯; disabled with "Applies On stage." while the account sits On stage in no hall; a Save sends them
  only from an admin account).
- **Told live, nothing closed.** The join's answer appends `onStage` after `pins`, its last key (the support view's, the
  person's), with the names of the hall's screens showing the countdown now (`countdownScreens`, names only, never a link,
  a token or an id) while `screens` is on; a change is told as `onStage` to every page of the person's and the admin's view
  of them, and to no other page; the names are told again to those pages when they move (read when the screens' frame
  goes). The admin's people list carries `onStage` beside `view` and `clock`, the admin's alone.
- **Also on.** With one of the two places' switches on, the On stage composer (in either view: the server reads the seat
  and the switch, never the view) draws a row above its field, "Also on", with a chip for each switch on: **⏱ Lectern**
  (the hall's countdown screen by name, "⏱ 2 countdown screens" where there are more, their names in its title and the line
  under it; waiting, with "No screen in this hall shows the countdown now.", while none does) and **👥 Everyone On stage**
  ("👥 On stage" on a phone), each an `aria-pressed` toggle, ✓ and filled when on, off after every send, in a group labelled
  "Also on" and described by the line under it. With ⏱ chosen the field holds 160 characters and says "Replaces Lectern's
  countdown line." with the count ("19 / 160"). Such a send is `message {type: 'text', text, priority?, replyTo?, also: {screens?, people?}}`, sent **now**, never
  held: offline it is refused at once and the text kept; a refusal keeps the text, its 🔥, its reply and its chips, and says
  the server's words.
- **The checks, in order, before anything is written**, so a refusal posts nothing: the seat On stage ("Only On stage seats
  send this way: use ⧉ Show on screens or 📺 Show the Board."); `also` by type, at least one of the two places, each `true`
  (`{}` refused: "Choose where else it goes: a countdown screen or people On stage."); a message, not a help request ("Only
  a message goes there, not a help request."); each place's switch **read from the store at each send** ("The admin has
  not let you send to countdown screens." / "… to people On stage."), so one turned off while the page is open refuses the
  next send with no reload; a screen of the hall showing the countdown now, and a line of 160 characters at most, never cut
  ("A countdown screen's line holds 160 characters (this is 212)."); another person seated On stage, a second device of the
  sender's being the sender ("Nobody else is On stage now."), and a line a card holds ("A line shown On stage holds 1,200
  characters (this is 1,201).", which only a page other than AGMessage's own can reach: the composer holds 300); then one
  token of the writes bucket for each place, beside the message's own.
- **Then:** the message is posted with `also`, names only (`{screens: [{name, seq, state}], people: {seq, shown, of,
  state}}`, each take's number as it will be given, `of` the people On stage it goes to); only once it is posted are the
  places taken, so a message not posted puts nothing anywhere: each countdown screen's line becomes the message (its tone
  🔥's for a priority message: the countdown and the hall's timer stay), one `display.take` row each naming the person and
  the length, never the words ("Lectern → the countdown with a line from Margaret Lowe, On stage (38 characters)"); the
  Board's pages are given a typed line
  (`{kind: 'snippet', unit: 'text', text}`, by `{name, onStage: true}`) that always arrives in the side bar, kept in a place
  of the Board's own for it (`lib/pages.js`'s `line`, told to a page as `page:take {layer: 'line'}` and in the join's answer
  as `line`), which only another such line replaces: it supersedes nothing anyone was shown and nothing of anyone else's
  supersedes it. It never takes the Board's information place, never puts away a card beside it (a researcher's for the
  Board, or one for a person, with its answer) and covers no chat (a quote or the operator's web page over a Board
  member's chat stays, with its answers); the operator's Back to chat leaves it, a Take down never names it, and a
  withdrawal or a Main room's reset ends it as any take. It is numbered as a take, entered in the hall's Earlier list as it
  is sent (so a page that comes back draws it there), drawn on every Board page as a card in Shown to you, the sender's own
  included, "Typed by Margaret Lowe (On stage)", one `page.push` row ("the Board (5 pages) → a line typed by
  Margaret Lowe, On stage (41 characters), beside their chat") and an entry of the stage record naming the sender "(On
  stage)". The ack carries `also` as sent ("sending", never "shown").
- **Attempts are not facts.** The message says where it also went, at the end of its author's line, for every reader of
  the room, in both views: "⏱ Lectern: sending", "⏱ On Lectern ✓", "△ Lectern could not show it" (in warn's colour beside
  its △), "⏱ Lectern: offline", "Replaced on Lectern at 14:12"; "👥 On stage: sending", then "👥 Shown to 5 of 6 On stage",
  counted by person, never by page: of the people On stage it went to (an account's every device one person, a guest's page
  by its uid; the sender among them), those a page of whose said it showed the card in their side bar, so a page that comes
  back on a new connection counts as its person once, and someone who sat down On stage after it was sent counts for
  nothing. The server follows each such message (its screens by their ids, kept on the server beside the message's id: the
  newest per person and place, 500 at most, let go once nothing more can change, and with its hall) and updates its `also`
  by an `upd` op (a new field of the op table, `alsoUpdate`) when the hall's screens or pages change, once a second at most
  (a new state frame, `also`). A line on a screen is followed until the screen moves on, so its readers are told when it
  was replaced; an older message's line taken by the same person's newer one is read once more as it is let go. No frame to
  a page of the room, the message, its updates or the ack holds a screen's id, link or token.
- **Got it clears the message** (B4), with the switch on: Got it is the same act and the same report to backstage ("👍
  Margaret got it"); then the person's own pages seated On stage, in either view (the full view's React ▸ 👍 is the same
  fact), draw the message as one muted 44 px line in its place, "👍 Got and cleared: Ana Ribeiro 14:02 · Show", 🔥 before
  the name for a priority message, a run of them one line ("👍 Got and cleared: 3 messages · Show"). **Show** draws them
  again, marked got, until the page reloads; **Hide** folds them back (a catalogue kind of its own, `cleared`, its one act
  local). The page reads it from facts it has (its person's 👍, the switch: `AGM.catalog.gotCleared`), so an account's
  devices clear together; a 🔥 message got and cleared leaves the strip too, and Got all N clears each. **Never cleared:** a
  message pinned for the room or for the person, a question, one's own, and anything on anyone else's page or on a page
  seated backstage. The room's record, the backstage page, the transcript and the minutes keep every message. Off, the
  message stays, "👍 You: got it", as before.
- **Audited, one row a change, no code and no text:** `person.onStage` for a guest ("Rita (guest) → may send to a countdown
  screen: on", the switches moved), `user.update` for an account ("onStage → countdown screens on, people On stage off, Got
  it clears off"); a change that changes nothing writes none.
- **Rolling back:** 0.5.1 keeps the accounts' `onStage` and ignores it, and reads no `pages.json`; a message's `also` is kept
  and ignored.
- Choices where the plan left room: a screen with no browser on its link reads "⏱ Lectern: offline" (a state the plan's
  words did not name) and is followed until a browser shows it; a line on screen is followed until the screen moves on,
  where §17.6 stops at the confirm, so "Replaced on Lectern at 14:12" is said after it was shown too; the Board's card is
  kept in a place of its own (`line`) rather than beside the Board's information, so that it supersedes nothing there, and
  a newer line from anyone On stage replaces it (the older message then says its card moved on, keeping how many saw it);
  "👥 Shown to N of M" counts people, `M` those seated On stage when it was sent; "Nobody else" means another person, so a
  second device of the sender's alone is refused; the two audit rows count a line's characters as every quote's row does
  (code points), while the 160 is the screen's own bound, counted as the composer counts it.
- Tests: `test/also.test.js` (new, end to end: the switches off by default and never set by create, by the admin and by a
  manager, over the socket and the PATCH; a guest's in `pages.json`, an account's in `accounts.json`, read from the files;
  told to the person's pages and support view and nobody else, the join's last key, the admin's people list alone; a
  `settings.manage` and a `users.manage` manager refused on the socket and the PATCH, and a PATCH on oneself with the
  self-change words; what is no switch refused with 400, `{}` among them, and `admin:setOnStage` naming no switch or a key
  of another name refused in the same words; a switches-only change ending no socket; one row a change, no code and no
  text; the default refusals, posting nothing; a backstage guest's `also`, `{}`, `{screens: 'yes'}`, `{web: true}` and a
  help request with `also`; no screen on the countdown, its names told to that person alone when one is put on it; 161
  characters; the Lectern's line at its next take and the Foyer untouched; the screen's confirm turning `also` to shown for
  every reader; the row with no text; 🔥 urgent; a line replaced, by the same person's newer one and by the operator, said
  with when; alone On stage, and with only a second device of one's own; a line longer than a card holds; the message
  posted saying the number its card's take is given; the line as a card in its own place on every Board page, the
  sender's included, with the operator's quote over the chat, a researcher's card beside it for the Board and one for a
  person with that person's answer all kept, in `pages.json` and on a page that comes back, and the line in Earlier;
  "Shown to 1 of 2" after one person's confirm, kept at 1 when that person's page comes back and confirms again and when
  someone seated On stage since confirms, then "Shown to 2 of 2"; the `page.push` row; no screen's id or link in any frame
  or ack; a Board account's switch turned off by the PATCH with its page open refusing its next send), `test/pages.test.js`
  (the Board's `line` place: only a line typed On stage to the Board in the side bar, superseding nothing and superseded by
  nothing else, in Earlier as it is sent, reported on in its place, read back in it and dropped there when it is no such
  line, withdrawn; `nextSeq`), `test/units.test.js` (`cleanOnStage`, `{}` refused, `alsoAsked`, the audit words; the op
  table's `also`), `test/catalog.test.js` (the facts' `onStage`; `compose.also` in both views and its chips, ⏱ waiting with
  why, "⏱ 2 countdown screens" with their names, `now`; the three switches on the admin page, the People panel and the
  Accounts page, disabled for a manager and with "Applies On stage."; `alsoWords` and `alsoParts`' warn; `gotCleared` in
  both views and never backstage, and what it never clears; the `cleared` kind in both views), `test/menus.test.js`
  (`admin:setOnStage` refused to every seat but the admin's; Also on refused to every seat the admin has let send nowhere
  else, On stage in the table's words; the join's keys), `test/inputs.test.js` (`admin:setOnStage`'s and `also`'s typed
  cases, a request naming no switch among them), `test/modules.test.js` (`onStageChanged` in the contexts; the any-room
  readers' reasons), `test/resilience.test.js` and `test/server.test.js` (the `also` frame), and the browser smoke (Also on
  absent with both switches off and one chip per switch on, ⏱ alone and then both, `aria-pressed`, the group described by
  its line, off after a send; the field's 160 with ⏱ chosen and its words and count; the line on the Lectern's page and "⏱
  On Lectern ✓" for every reader; offline, a send with a chip on refused at once, its text, 🔥 and chip kept, nothing held
  or posted; 👥's card in its own place, "Typed by Mia (On stage)", with no layer over the chat; no sideways scroll at 390
  px with "👥 On stage" in short; Got it clears off and on, its line 44 px, Show and Hide, a message pinned for the room,
  one pinned for the person, a question and one's own kept, a 👍 from the person's other device clearing it there too, and
  the backstage page keeping it, "👍 Mia got it"; the admin page's On stage cell, its ticks named for the person, kept by
  the server, and "Applies On stage." beside a backstage guest; the Accounts editor's three switches and the account's ⋯).
- The papers: `README.md`, `README.txt`, `SECURITY.md`, `docs/ACCOUNTS.md`, `docs/DISPLAYS.md`, `docs/DESIGN.md`,
  `docs/ANALYSIS.md` (the typed cases), `CLAUDE.md`. `docs/NODES.md` and `docs/SHOWBUS.md` are unchanged: nothing of this
  reaches the Show Bus, the context or the hello.

**The installed node's machine commands, and the server task's action** (the plan's Part 6, unit U12, with the owner's
answers 35, 37 and 38; the code, its tests and a Linux stand-in for Windows — no build installs AGMessage yet)
- **`app/machine.js`**, the machine-level commands, run elevated or as SYSTEM only, Node's built-ins only, every program
  by its absolute path in the System32 folder the installer passes, from that folder (`schtasks.exe`, `icacls.exe`,
  `reg.exe`, and `powershell.exe` for what no other program reads or makes: a folder's owner, the firewall's rules by
  NetSecurity's cmdlets, the port's holder, a code-integrity event), no machine path read from its environment. It builds
  `prepare`, `install`, `uninstall`, `preinstall-check`, `upgrade-stop`, `status` and `restore`; `import`, `control` and
  `upgrade` are refused as unknown until their later units (U14, U17, U18). Every command writes its result whole to
  `--out`, a refusal's too, never a token. Exit codes: 0 done, 2 not done, 3 refused (a precondition a person must clear),
  64 a word it does not know or an argument missing or malformed.
- **The machine folder, race-free** (`prepare`): a non-recursive `%ProgramData%\AGMessage` with inheritance cut and SYSTEM
  and Administrators in full control, by SID, never `/T`; an existing one accepted only when HKLM shows an earlier install
  (or a prepare no install finished), `lstat` shows a real directory and its owner is SYSTEM or Administrators; the root
  listed, anything another account added meanwhile refused; then its children (`data`, `uploads`, `keys`, `logs`,
  `token`, `machine\` with `inbox\`, `outbox\`, `work\` and `staged\`), each a real directory made or found before any
  grant on it, and `setup\<128 random bits>\` where any signed-in account may drop a file and none may list or read, named
  in `--out` alone and removed at the install's end.
- **The server task** `\AGMessage\Server` (`install`): LocalService under its own SID (`ProcessTokenSidType` unrestricted,
  `SeChangeNotifyPrivilege` alone), a boot trigger, no time limit, both battery settings false, `MultipleInstancesPolicy`
  `IgnoreNew`, `RestartOnFailure` 3 × 1 min, its action `node.exe` on `launch.js serve` by their absolute paths in
  `{app}`, its descriptor SYSTEM and Administrators only. Its SID may modify the folders it writes (`token\` too: the
  watchdog replaces the token by a rename) and read `machine\events.jsonl` alone; the laptop's admin reads `token\` and
  `logs\` and has its own `inbox\` and `outbox\`; every grant is checked. Beside it: the firewall rules, each by program,
  protocol and local port (TCP the port, UDP 9928), `LocalSubnet`, Private and Domain, and Public only when ticked at
  install — never a rule on `node.exe` alone; and the one install record `HKLM\SOFTWARE\AGMessage`, written last
  (`InstallDir`, `Version` the install version MAJOR.MINOR.BUILD from the build, `SemVer`, `Previous`, `Runs`, `Port`,
  `Admin`, `AdminName`, `PublicFirewall`, `Signed`), no token or password among them. The laptop's admin is recorded at
  the first install only: an upgrade keeps it, and only the first appends `machine.admin` to `machine\events.jsonl`, which
  the server turns into its audit row (U17).
- **Stopping and checking before an install or an upgrade.** `preinstall-check` looks at the port first: nothing there is
  ready, a first install with no token too; the installed AGMessage proving its token is asked how busy it is (busy
  refused without a typed reason, silent for 5 s refused naming its pid); a portable copy or another program on the port
  is refused with its words. `upgrade-stop` refuses before it asks anything when the disk is short of the backup's room,
  then stops the server at loopback (reason `upgrade`, who asked, the reason typed), waits for it to end, reads the record
  that stop wrote, and refuses (exit 3) a stop that did not save or made no backup, unless forced: "AGMessage stopped for
  the upgrade and saved at 20:31; backup …". `uninstall` stops the server at loopback first (it saves; Task Scheduler's
  End is never the stop), then removes every task of `\AGMessage\` (each control task the record names among them, should
  the folder's listing not be read), the rules and the record before any file goes; the data is kept unless
  `--remove-data`, and then the keys last; each removal is checked, and what is left is named (exit 2). Windows' answers
  are read by column, never by their localised words.
- **`launch.js serve`**, the server task's action: it runs the watchdog in a process of its own, in an environment of
  Windows' own names and `AGM_RUNS=task`, the folders and the port from its arguments — nothing else of its own, no
  `NODE_OPTIONS` and no `AGM_…` it was not handed. The watchdog's stop (0), its give-up and a configuration refusal (3) end
  `serve` with 0 after the watchdog has written why, so the task stays stopped and `RestartOnFailure` does not loop it;
  only an unexpected end of the watchdog is non-zero. **`launch.js status`**, the person's reader, without an elevation:
  each fact read, refused or absent (the data folder's records, which only SYSTEM, Administrators and the server read,
  said refused, never read as no stop), never the token; **`machine.js status`**, the elevated one, adds the port's
  holder and a code-integrity event stopping `node.exe`.
- **The way back's backup** (`lib/upgradebackup.js`): the server, the one writer, makes it at a stop this PC's machine asked
  for an upgrade, once the audit log, every store and each dirty hall are saved and before `last-stop.json`, which names
  it. A store, a snapshot and every marker is a hard link (no room, kept whatever a later build writes); an append-only
  log, a `.bak` and (on another volume) an upload are copied; `backups\` and `logs\` are never in it. Two are kept. A disk
  short of room for its copies and the reserve refuses it, leaving nothing. **`machine.js restore`** lays a backup back
  file by file while nothing answers on the port: an unchanged hard link kept, a replaced file laid back, a file the newer
  build made removed, and the audit log and `watchdog.log` never rolled back, so the audit log and its head still agree.
- **The watchdog's console** (`supervise.js`): under the task it is kept in the logs folder the launcher names
  (`AGM_LOG_DIR`, beside the data folder), so a refusal said before the data folder may be written in still reaches
  `server.log`; `channelOf` checks that folder as it checks the others.
- **`start-agmessage.bat`** names an installed AGMessage by the record's `SemVer` ("AGMessage 0.6.0 is installed on this
  PC"), since `Version` is now the install version an upgrade compares.
- Held on Linux (`test/machine.test.js`, and `machine.js` under the coverage gate): the argument parsing and its exit codes,
  the folder order (never `/T`, the refusals for a root that is taken, a link or another account's, a child made after the
  listing or that is a link), the server task's definition and its descriptor, the firewall rules, the record's shape,
  Windows' answers read by column (an English and a German answer alike), the machine's wire half matched to
  `lib/machinewire.js` vector for vector and the busy line read as `lib/busy.js` reads it, `upgrade-stop`, the backup and
  the restore against a real server (a restore followed by a start), `preinstall-check`, `uninstall`'s failures, `--out`
  for every verb, and `launch.js serve` with the real watchdog (a stop, a configuration refusal and a give-up each ending
  it 0). On Windows the same file runs the read-only scripts on a real folder and port. The Windows evidence lane now takes
  R3′ (U12's own task definition and its stop-saves) and R9 (the upgrade backup's time); R8 reads the server task's
  definition back as a standard account; R4 and R12's stand-ins carry U12's principal and settings, held to `machine.js`
  by a test; and R1's rounds are plain stops, so the backup an upgrade's stop makes is in R9 alone. What only a Windows run
  proves — `icacls`, `schtasks`, `reg` and NetSecurity's cmdlets applying, the task running as LocalService — is the
  installer job's and the lane's.
- The papers: `CHANGELOG.md`, `docs/INSTALL.md`, `docs/ANALYSIS.md`, `docs/DESIGN.md`, `SECURITY.md` and `CLAUDE.md`.
  `README.md` and `README.txt` are unchanged: nothing installs AGMessage yet, and the .bat's banner now says what
  `README.txt` already says. `docs/NODES.md` is unchanged: no machine command reaches the Show Bus, the context or the
  hello (the `install` context block is U3's).

**The installer** (the plan's Part 6, unit U13, with the owner's answers 36, 37, 38, 39 and 43; the code, its tests and a
Linux stand-in for Windows — CI builds it on the next push; its life cycle, run for real, is the life cycle job's, U16)
- **`installer/AGMessage.iss`**, Inno Setup 7.1 (PlayMap's tool and skeleton), `AGMessage-Setup-<version>-unsigned.exe`:
  per machine, Program Files\AGMessage only and no folder page (another folder, `/DIR=` included, refused before
  anything changes), one fixed `AppId`, `PrivilegesRequired=admin` with no per-user override, `CloseApplications=no` (Inno
  never closes a running AGMessage: it is stopped only at loopback, where it saves), no `[Dirs]` and no `[Registry]` (the
  machine folder and the one install record are `machine.js`'s). Every machine-level act is a `machine.js` command, run
  with this build's `node.exe` and `machine.js` extracted before anything is laid down: the refusals (only a newer build
  by its install version — "AGMessage 0.6.0 (build 41) is newer than this installer's 0.6.0 (build 37): uninstall it
  first to go back." — the same build, and a quiet first install without `/ADMIN=`), `preinstall-check` and `prepare` in
  `InitializeSetup`; `preinstall-check` again and `upgrade-stop` in `PrepareToInstall`; `install`, then the start and its
  verify, after the files; the way back; and `uninstall` before any file goes. A refusal once `prepare` has made the
  machine folder says nothing was installed, never that nothing changed; one a typed reason lifts (busy at the stop
  itself, no save record, no backup, the disk short) says how to go on anyway (`/FORCE="<why>"` from a command prompt),
  and going on without a way back is said to the person, not only logged. A first install whose server did not answer
  says what works: its task starts it again with Windows, or an uninstall and a new install, since this installer would
  refuse the build it recorded.
- **Its pages:** Smart App Control's, only while it evaluates the PC; the laptop's admin (the account that started this
  installer, as the plan's two readings find it, the person choosing between them when they disagree, never a third);
  "Also on Public networks (hotels, airports, fresh venue Wi-Fi)", unticked, or as the record keeps it on an upgrade; the
  busy page, shown only when AGMessage is busy, its counts in the server's words and a reason that must be typed, which
  the server keeps as `server.stop.forced`; and, after the files, the first admin account, made through `/api/setup` with
  the token the installer may read. The password goes to `machine.js` in a file of `machine\work\` (SYSTEM and
  Administrators only), removed before it asks, never in a command line, a URL or the installer's log, and from there,
  with the token, only to this build's server once it has proved it holds the token, on the connection it proved itself
  on: a program that took the port is asked the hello alone and sent neither. Left empty, the account is made at Admin
  login as before.
- **The way back:** a new build that is not set up or does not prove itself within 35 s is ended, the backup its stop
  made is laid back, and the kept installer of the earlier build runs with `/ROLLBACK`, which lays its files down, starts
  it and verifies that it answers. `/ROLLBACK` is accepted only for the build the record names as `Previous`, or for the
  build it still names when the files in Program Files are another build's that never recorded itself, and only while
  nothing answers on the port (`preinstall-check --rollback`), since the way back stops nothing; its record then names no
  `Previous`. The kept installer's own process (and its instance that asked for the elevation) is not taken for an open
  console of the folder. Two installers are kept in `{app}\installers\`, so no download is needed. An install that
  stopped the earlier server and did not reach its end starts it again.
- **The uninstall** refuses while a console of the Start menu is open, stops the server at loopback, removes the tasks,
  waits for every program of the folder to end (one that does not is named, and nothing is removed), then the rules and
  the record. It asks "Remove all AGMessage data from this PC?", No the default (`/REMOVEDATA` quietly; the keys removed
  last). Data kept has every right a Windows account was given on it taken back (the laptop's admin's and each grantee's,
  their inbox and outbox folders) and the record replaced by a mark (`Kept`, the folder, and its `Port`), so AGMessage
  installed again takes the folder, finds whose it is anew and serves on the same port. A busy AGMessage is uninstalled
  only with `/FORCE="<why>"`, the uninstaller's own path said whole in its refusal (it has no page to type a reason on).
- **The silent switches:** `/VERYSILENT`, `/ADMIN=<account>` (taken only for an account Windows confirms is one person's
  on this PC: a local account, or one that has signed in here; a group, a service, a group of a domain or of Entra ID and
  an account Windows names nothing for are refused), `/PUBLICFIREWALL=1` (or `=0`), `/FORCE="<reason>"`, `/REMOVEDATA` and
  `/ROLLBACK`. `/UPGRADEBY` is a later unit's (U18).
- **The Start menu:** Open AGMessage, Show the admin token and AGMessage status, each `node.exe app\launch.js <verb>`, a
  console run as the person and never elevated by itself. **`launch.js open`**, the launcher, asks `/api/health` on the
  record's port once: the installed node answering opens `http://localhost:<port>` by `explorer.exe`'s absolute path and
  the console closes; a portable copy, another program, a silent port or nothing serving is said with the server task's
  state, the log's last line and what to do. Start, Stop, Upgrade, Go back to build N and Who may run AGMessage… are
  later units' (U17, U18).
- **`machine.js` gains what the installer asks of it:** `whose` (the account that started Setup, from the `whoami` answer
  it wrote into the one-time setup folder, read and removed; the owner of `explorer.exe` in the installer's session and
  the names Windows gives each SID, from one `powershell.exe`; the account the elevation runs as, by `whoami.exe` by its
  absolute path; `/ADMIN` resolved and confirmed: Windows names it, it is no local group, and it is a local user or has
  a profile on this PC), `start` (the server task run and the server waited for until it proves, by the machine's hello,
  that it holds the machine folder's token as the build, so a program answering `/api/health` with the build's public
  words is no answer; whether the node has an account asked of it on that same connection; one that does not prove
  itself ended with its log's last lines said), `first-account` (`--build`), `--app` on `preinstall-check` (a console of
  the Start menu still open refused before anything is stopped; the server's own programs told from it by their command
  lines, which are never said or kept, and the installer's own chain by its parents), on `upgrade-stop` (anything still
  running from the folder once the server has ended refused) and on `uninstall`, `--rollback` on `preinstall-check` and
  `install`, refusals a reason lifts marked `forceable`, and the busy line's counts in `preinstall-check`'s `--out`. A
  `machine.js` run with `--out` never waits for Enter: the installer's hidden runs would wait for ever. `uninstall`
  keeps the data as above, and `prepare` takes a folder an uninstall kept as it takes an earlier install's.
- **Built in CI:** a new `installer` job on `windows-2025` builds it from the zip the package job built
  (`installer/build-installer.ps1`: the zip's stage without its two .bat files, the defines `tools/installer-defines.js`
  reads from the stage's `build.json`, the version the file carries checked, `SHA256SUMS.payload` written beside it).
  The zip carries `app\machine.js` now (`tools/build-portable.ps1`), which the installer runs from the stage and its
  uninstaller from the folder it laid down; a test holds the stage to every file the installer needs. The job takes
  Inno Setup 7.1.0 pinned by hash and checked on each run against its release's digest and its publisher's signature,
  every action pinned by its commit. It is built there and never run. A tag's release carries the installer and
  `SHA256SUMS.payload`, SHA256SUMS made again over every file, and its notes say the Smart App Control words. The
  readings lane waits for the installer job and is never held by it: R5 reads Windows' verdict on the installer beside
  the two programs' (recorded: it is unsigned), and R6 waits for U14 alone.
- **`THIRD-PARTY-NOTICES.md`** names the two programs the folder and the installer ship, Node.js (`node\node.exe`
  24.22.1, MIT and what it bundles) and cloudflared (`bin\cloudflared.exe` 2026.3.0, Apache-2.0), whose licence texts now
  ship in `licenses\nodejs\` and `licenses\cloudflared\`, and `supports-color`, which ships so that `debug`'s search ends
  in `app\node_modules`. There is no service host to name: the installed node runs `node.exe`.
- Held on Linux (`test/installer.test.js`): the script by its text (its `[Setup]`, its files, its Start menu items read by
  `launch.js`'s own parser, every `machine.js` command and option it names, the order they run in, where the password
  goes, its switches and refusals, ASCII only), the defines, the CI job, and every `machine.js` command it runs against
  stand-ins for Windows' programs or a real server (`whose` and `/ADMIN`'s confirmation, `start` proving the server and
  refusing a stand-in that answers the build's health but proves nothing, `first-account` making a first admin that then
  signs in, and sending no byte of the token or the password to a program that proves nothing or to a connection other
  than the one proved, the busy line, the console check and the installer's own chain, the way back's port check),
  `uninstall` keeping the data and a later `prepare` and `install` taking it, and `launch.js open`; on Windows the same
  file runs `whose`'s and the programs' scripts for real (an account confirmed, Users a group, this test an ancestor of
  the script that listed it). What only a Windows run proves: that ISCC compiles the script (the installer job, on the next push);
  the install, the upgrade, the way back and the uninstall themselves; the readings of whose it is under
  over-the-shoulder elevation (R6, which waits for U14 too); the Start menu's consoles and the browser opening; and the
  first admin account made from the page. None of them has run yet.
- The papers: `README.md`, `README.txt` (the installer, for your own show laptop, with the Smart App Control words),
  `docs/INSTALL.md` (The installer), `docs/ACCOUNTS.md` (the first admin account from the installer), `docs/ANALYSIS.md`,
  `SECURITY.md`, `THIRD-PARTY-NOTICES.md` and `CLAUDE.md`. `docs/NODES.md` is unchanged: nothing of the installer
  reaches the Show Bus, the context or the hello.

**The laptop's admin, the rights it gives, and the control tasks** (the plan's Part 6, unit U17, with the owner's answers
38 and 40; the code, its tests and a Linux stand-in for Windows, with the Windows readings lane taking R8, R11 and R13 on
the next push; nothing of it has run on Windows yet)
- **Four rights, one admin.** The Windows account that ran the install is this PC's AGMessage admin (`HKLM\SOFTWARE\AGMessage`
  `Admin` and `AdminName`, written by `machine.js` alone). It holds `token` (reads the admin token: the break-glass sign-in,
  Accept, the token's export, the first admin account), `start`, `stop` and `upgrade`, and alone gives them, each to one
  person's account (a group, a service, or an account Windows cannot confirm is a person's here is refused: "Give rights
  to one person's account."), takes them back, or hands the admin over. An account given rights cannot give them on.
  `Grants` holds the rest, one value per SID; the record is read at every request, so a right taken back holds at once,
  even if its control task is still there.
- **One control task per account with a right**, `\AGMessage\Control-<SID>`: SYSTEM, run on demand only, requests queued,
  10 minutes at most, its action `node.exe app\machine.js control --for <SID> --machine … --sys …` fixed at registration,
  its descriptor `D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FRFX;;;<SID>)`, so that account alone may read and run it and which task
  ran says whose request it is. The install registers the admin's (and on an upgrade each grantee's again from the new
  definition); a grant registers one, a revoke of the last right removes it, and the uninstall removes them all.
- **A request** (`machine.js control`, new): the person's `request.json` in `machine\inbox\<SID>\` (only that account may
  add a file there and write it, never a folder or a junction) is taken only when `lstat` shows a file of its own (a link,
  a hard link, a folder or one over 4 KB refused, and one swapped between the look and the open, and whatever was there
  removed, so nothing is read twice), its bytes copied into `machine\work\` and read from that copy;
  it must be whole JSON, an `id`, a known verb (`start`, `stop`, `grant`, `revoke`, `handover`; `upgrade` and `back` are
  U18's) and only that verb's fields, each of its type. The answer, refusals too, goes to `machine\outbox\<SID>\answer.json`
  (`{v, id, verb, code, words, ranAs, for, …}`), which that account may read; a run that finds no request waiting (a second
  press, queued) writes none, since the one there may be another run's. An act done in part answers not done (2) with
  what it did, and an act done whose event cannot be appended answers done, saying the audit log will not show it.
  `start` runs the server task and waits for the server to prove it holds the token ("Started."; one already serving is
  said and changes nothing); one not proving itself within 35 s is left as it is, never ended (it may still be starting,
  and Task Scheduler's End is no stop), its task's state and the log's last line said; `stop` is the stop
  at loopback with the proof, "Not stopped: AGMessage is busy (3 pages active, a countdown running). Type a reason to stop
  it anyway." until a reason is typed, then "Stopped, saved at 20:31.". The `token` right is the read on `token\`, which
  Windows holds, so the record never names less than Windows grants: `grant` makes the account's inbox and outbox and its
  control task, writes its `Grants` value, and only then gives the read for `token` (one Windows will not give is taken
  off the record again and said, not done); `revoke` takes the read back first, then the record, then what the account no
  longer needs (a read Windows keeps stays on the record, said, not done); `handover`, confirmed by the new admin's name
  typed again, makes the new admin's folders and task, takes the old admin's reads (handing nothing over while one stays),
  rewrites the record, gives the new admin every right, its reads and the giving, and removes the old admin's inbox and,
  last, after the answer, its control task; a handover to the admin itself gives its reads again. An account's folders
  are removed entry by entry, never recursively, here and at the uninstall, so a link left in one is never followed. Its words: "You have no AGMessage rights on this PC. Ask LAPTOP\ana,
  or an administrator." and "Only LAPTOP\ana, this PC's AGMessage admin, can give rights."
- **An administrator's elevated console** (`machine.js control --elevated --request <machine\work\file>`, which
  `launch.js` runs when it finds its token elevated: Administrators and a High integrity label, read by SID) may do every
  act, so a laptop whose admin account is gone is handed over; its event names that administrator.
- **The Start menu's Start AGMessage, Stop AGMessage… and Who may run AGMessage…** (`launch.js start`, `stop`, `rights`):
  each writes the person's request (their SID from `whoami.exe`) into their inbox, runs their own control task
  (`schtasks.exe /Run`, by its absolute path), waits for the answer to that request's id and says it. Stop asks for the
  reason when busy and asks again with it (Enter leaves it running). Who may run lists the admin and each grant (names as
  Windows gives them now, by one `powershell.exe`), and takes one line: "Give LAPTOP\ben: start, stop", "Take back from
  LAPTOP\ben: stop" (or all), "Hand over to LAPTOP\ben", the last confirmed by typing the name again.
- **The machine's events** (`machine\events.jsonl`, appended by `machine.js` alone, in place, under a lock so no two take
  one seq, one older than 5 s, below an append's 10 s wait, taken as a crash's): `{seq, at, kind, by, for, rights, words}`, `by` and `for` Windows accounts by SID and name, never a token, a
  password or a path in a profile. The server, the audit log's one writer, reads the file (`lib/machineevents.js`, new,
  through `fs.promises`; `AGM_MACHINE_EVENTS`, which the server task now passes as `launch.js serve --events`) after the
  hold and at each `POST /api/machine/events` (the nudge each act now sends, answered with how many rows were written),
  and writes one row per event, in seq order: `machine.admin`, `machine.grant`, `machine.revoke`, `machine.handover`,
  `machine.start`, `machine.stop`, `machine.refused` (a request read whole and refused for want of the right: who asked
  and what, the account it names said as typed and never looked up; a request that is not one leaves none), and
  `machine.upgrade`, `machine.upgrade.refused` and `machine.import` once U18 and U14 append them. A row names both
  accounts by their whole SIDs (the audit log keeps a Windows actor's id and target up to a SID's 184 characters, where
  any other actor's stay at 40 and 80): its actor the Windows account that asked (`{t: 'windows', id: <SID>, name}`), its
  target the SID of the account acted for; its words the event's, the rights, when it was done ("· done 20:31 UTC on 7 Nov
  2026", so a stop, written at the next start, keeps its own time) and the event's seq, the words giving way with an
  ellipsis before that end is cut. The last seq written is kept in settings (`machineSeq`, which U15 keeps through an
  archived event, as the plan now says) and named in each row, so a restart, even one before the settings were saved,
  never writes an event twice or skips one. A line that is not an event
  is passed over and said; a row never holds the token (taken out by value, in either case). A copy whose settings could
  not be read writes none until they can.
- **The readings lane**: R11 is taken (two standard accounts made for it, one the control task is for, as
  `app/machine.js` registers it over a machine folder of the lane's: ten runs of `schtasks /run` from a task as that
  account, each answered as SYSTEM for its SID, and ten from the second account, each refused; the met mark is 10 of 10);
  R8 reads a control task's definition back (the account it is for may read and run it, another may not, no secret in
  it); R13 runs with a control task's principal and settings, held to `controlTaskXml` element for element, and waits for
  U18's words alone.
- Held on Linux (`test/control.test.js`, new; `test/machine.test.js`, `test/readings.test.js`, `test/installer.test.js`):
  a request not whole, over 4 KB, of an unknown verb or with a field of the wrong type refused with no event; a link, a
  hard link or a file swapped after its look refused; a right taken back refused at once; giving, taking back and handing
  over from an account that is not the admin refused, each a `machine.refused` event; a handover leaving the old admin no
  right; the token's read and the record in their order when Windows refuses a step of a grant, a revoke or a handover;
  an account's folders removed without following a link; the elevated console's handover; start (one not answering left
  as it is) and stop with their events; an act whose event fails answered done; the events written as rows exactly once
  across a nudge and restarts, in seq order, a local account's and an Entra ID account's SIDs whole, a stop's 200-character
  reason and its own time kept, with no token in any row;
  `launch.js` wired to `machine.js control` end to end. What only a Windows run proves: that a control task's descriptor
  lets its one standard account run it on demand and refuses another (R11), that it runs as SYSTEM, the access lists of
  the inbox and outbox, the account lookup, and the Start menu's consoles; the lab's line 7 (the admin as a standard
  account, a second given `start` and `stop`, a third given nothing) is the show laptop's.
- The papers: `README.md`, `README.txt` (the Start menu's items, who may run AGMessage), `docs/INSTALL.md` (The laptop's
  admin and its rights; the machine's events), `docs/ACCOUNTS.md`, `docs/DESIGN.md`, `docs/ANALYSIS.md`, `SECURITY.md` and
  `CLAUDE.md`. `docs/NODES.md` is unchanged: the context, the hello and the AI's brief carry none of it.

**A portable folder is imported, once, before the installed node's first start** (the plan's Part 6, unit U14, with the
owner's answer 42; the code, its tests and a Linux stand-in for Windows, with the Windows readings lane taking R6 on the
next push; nothing of it has run on Windows yet)
- **The installer's import page.** On a first install shown to a person, when the account that started Setup is this
  PC's AGMessage admin, a page after the install asks for the portable folder (the one holding `start-agmessage.bat`),
  or Start with no halls. It says first that the folder no longer starts once imported and that its keys leave the
  account's profile, which every portable folder of that account uses. The first start waits until the page is passed.
  A quiet install, an upgrade and a repair offer none.
- **It refuses**, with nothing exported or laid: a copy running on the folder (its folder pipe answers, and the words
  say what its busy line says; the pipes now come from one place, `lib/resilience.js` `folderPipes`, which the server's
  hold reads too) or an AGMessage on the installed node's port; a folder last run by another build, or by this one in a
  format it does not write; one an import took already; keys not in the starting account's profile ("This folder's keys
  are another Windows account's: install from that account."); a machine key, certificate or server secret the installed
  node's own start would refuse (a key that is not one, a certificate whose private key is not its own, a secret that is
  no secret), each with what to do; an audit log that does not check; the folder chosen or its `app\` a link or junction,
  or one anywhere in what it carries; more files than a bundle carries (the walk stops there, and never enters what the
  import leaves, such as the backups); too little disk; and a target that has served (any hall, account or audit row, or
  a machine key, certificate or `secret.key` of its own: never merge).
- **Two steps, each side of the elevation.** `launch.js export` (new), run by `ExecAsOriginalUser` as that account,
  writes contents only into its `machine\inbox\<SID>\import\` (made by `machine.js import --step stage`, new): each
  file a numbered part, then a manifest of each part's place, size and SHA-256 with the folder's facts. The data folder
  (but its backups, its console, the watchdog's files and temporary files), the uploads, and the profile's
  `machine.key`, `tls.json` and `audit\` travel; `secret.key` is in the data folder; nothing is rotated. Each file is
  opened without following a link and refused when it is not the file the walk saw. `machine.js import --step take`,
  elevated, copies each part by its bytes into a new file (never over one there, never with an access list of its own),
  a part read only when it is a file of its own of its manifest's size, its SHA-256 checked. Each look and its read are
  compared by the whole file id (`{bigint: true}`: an NTFS or ReFS id past 2^53 read as a Number loses its low bits; the
  control task's request read the same way now too).
- **The verify** says each check that did not pass, by name: the halls, side rooms, messages, accounts and screens
  counted alike; the same machine key; every sealed value opening, as many as before; the certificate's fingerprint
  unchanged; the audit chain checking to its end with its archives. Each side is read by `lib/importfacts.js` (new), as a
  process of its own with the server's readers and writing nothing (`AuditLog.checkAsItLies`, new: the chain walked
  under a key read, never made; `secretbox.openWith`, new: a sealed value opened with a key given). Then what the
  installed node's own start refuses, read from the copy itself and never from what the export said of its source: a
  copy not last run by this build in the format it writes (`format`), a key, certificate or secret it would not start on
  (`usable`), a copy running on its data folder (`held`), an import's mark there (`moved`). A verify that does not pass
  takes out everything the copy laid, so the import can be run again. The facts reader, run elevated, loads only
  `app\lib`, `app\verify` and Node's built-ins (`test/loads.test.js`).
- **Then the old copies go.** `launch.js forget-keys` (new), as the same account, removes nothing without the import's
  verdict for this folder (`import.json` in the account's outbox, which only SYSTEM and Administrators write). It marks
  the source first (`app\data\moved.json`, which this build's server and watchdog now read before anything is written,
  refusing to start with code 3 and words that name the installed AGMessage; `start-agmessage.bat` replaced by one that
  says so, the original kept as `start-agmessage.bat.moved`), then removes `%LOCALAPPDATA%\AGMessage` and the folder's
  `secret.key`, each checked; one that fails names its path, on the page's last words, and a mark that was not made is
  said apart (the folder could still start: never start it again), never as a file to remove. It reaches nothing through
  a link. `machine.js import --step finish` appends `machine.import` (who, named by the machine: the install record's
  admin, else Windows' own name for the SID, never a name the bundle carries; the build, the counts, verified, whether
  the old copies went and the folder is marked; no path in a profile), which the first start writes as its audit row; a
  copy not removed or a folder not marked is not done.
- **No copy of the keys stays in the inbox.** The bundle holds the profile's keys and the folder's secret, so a take that
  does not pass clears it (the parts not laid, the manifest and the answers), finish clears it, and `machine.js import
  --step clear` (new) clears an import left before its end: after an export that refused or did not run, at Start with
  no halls, and at Setup's end. An import folder that is a link is removed itself, never what it names.
- **The readings lane** takes R6 (no longer waiting for U14): a standard account made for it exports a stand-in portable
  folder into its own inbox by a task with its logon, and the elevated import reads it back whole. Its mark is met only
  over an administrator's shoulder, so the lane judges it at best open.
- Held on Linux (`test/import.test.js`, new; `test/installer.test.js`, `test/machine.test.js`, `test/admintoken.test.js`,
  `test/readings.test.js`, `test/modules.test.js`): a real portable copy seeded (a hall, messages, a file, a screen, a
  sealed key, an account, HTTPS), stopped, exported, taken, verified and forgotten, the installed node started on it under
  the task's environment with every count, the fingerprint and the chain as they were, and the portable copy refused at
  its next start through the watchdog and without; every refusal above; each check of the verify failing with its words
  and the copy taken out, a laid marker of another build and a laid key that is no key among them; nothing of the bundle
  left after a take that did not pass, and clear; `forget-keys` refused without a verdict, for another import or folder,
  or through a link, a removal that fails named and a mark not made said apart; the event's name the machine's, whatever
  the manifest says; the page's steps, their order and its clears read from the installer's script. What only a Windows run proves: the
  export under `ExecAsOriginalUser` writing into its inbox by its grants and the import reading it (R6 by a task; the
  over-the-shoulder reading is the show laptop's), `%LOCALAPPDATA%` as Windows gives it, the import page itself, and
  the installer's life cycle around it (U16). K's `stores\` is #80's.
- The papers: `README.md`, `README.txt` (the import), `docs/INSTALL.md` (The import of a portable folder),
  `docs/ACCOUNTS.md`, `docs/DESIGN.md`, `docs/ANALYSIS.md`, `SECURITY.md` and `CLAUDE.md`. `docs/NODES.md` is unchanged:
  the context, the hello and the AI's brief carry none of it.

**An event is archived, never deleted silently; the next one continues an archived event, copies an event's settings and
structure, or starts fresh** (the plan's Part 6, unit U15, with the owner's answer 45; the code and its tests on Linux,
nothing of it run on Windows yet)
- **Admin → Event** (new) says the current event's name, how and when it began, and lists each archived event under it
  with its counts. Its acts are catalogue rows (kinds `event` and `archive`): **Archive this event…** asks first what comes
  next (start fresh, copy this event's or an archived event's settings and structure, continue an archived event), then
  the new event's name, typed as the confirmation, with "Keep the screens' links" for a copy and "Also split the audit log
  here", both unticked, the current event's name where it has none, and a reason when AGMessage is busy; on an archive,
  **Continue this event…** (the event's own name typed), **Copy this event…** and **Delete this archive's contents…**.
- **Only the admin** archives (the laptop's token, or an account whose role is admin: `theAdminReq`). A manager an admin
  granted `settings.manage`, whom the admin page admits, is refused with "Only an admin may archive an event.", and the
  page draws the rows disabled with those words. A busy server is archived only with a typed reason, which the archive
  point says.
- **The order, by the one writer, in one turn of the loop:** every new join and write refused ("AGMessage is starting a
  new event"); the audit log, every lane and each hall that changed saved; `data/archive/.<time>.partial/event.json`
  written first, with what comes next; the event's rooms, stage record, `pages.json`, `displays.json`,
  `desk-results.json`, `accounts.json`, the ended `sessions.json` and `admin-sessions.json` and its uploads moved in
  (each a rename on one volume; across two the uploads are copied, sized alike and only then removed, and a copy that
  would not leave 1 GiB free is refused before anything moves); the folder renamed to `<time>` (to the millisecond); the
  archive point, `audit.archive`, written as the first line of a new log file, its target `<time>;<run>`, the act's one
  row (no `event.archived`); a split ticked begun as its own act straight after it, its answer said with the archive's;
  the next event begun, and the archive's record told so (`next.began`) before the current event's record
  (`data/event.json`) is written; every page told (`account:changed`), every sign-in ended, the sessions' and the token's
  alike, and each screen given its new state or told its link is no longer in use. No room takes a change while an event
  is being archived, a link's or a timer's included.
- **The next event.** A copy keeps the halls and side rooms by their keys with their names, their locks and each hall's
  `guestWeb` with its lock and their code's switch, a new guest code for each room and no earlier one (so no code or
  invite of an earlier event opens it), and nobody seated (the guests a restart would seat again are the earlier
  event's), the allow-lists, each hall's own Stagewatch link, the accounts with their rights, views,
  clocks and On stage switches, the guests' chat views, and the screens by name and hall with their standing layout (the
  clock, the countdown without its words, black) on new links, unless "Keep the screens' links" is ticked. A continue
  moves an archive's files back and reads every store again: its codes, links and messages as they were; its archive keeps
  its record, now marked `continued`, and its ended sign-ins. A fresh start has no halls, screens or accounts, and the
  token at the laptop makes the first admin account; each hall's own Stagewatch link is kept as an earlier hall's, listed
  on Admin → Show network and offered by New hall on the admin page and on the halls board (to whoever sets halls up),
  which moves it, with its key and its frame's hold, to the new hall. A continue whose uploads come back to an uploads
  folder on another volume is refused, before anything moves, where they would not leave 1 GiB free there.
- **Kept in all three, never archived:** `settings.json` (the Stagewatch link with its sealed key and fingerprint, each
  hall's own Stagewatch, the Patterns and PlayMap links, the certificate pins, the node's id, the context token, the AI
  key, the tunnel's end, `machineSeq`), the key folder and `secret.key`, the audit log and `data/audit-archive/`, the
  laptop's admin and its grants, and the confidential holds, which go into the next event's `pages.json`. No code an
  archived event's rooms held is ever made again for a new room or a New code.
- **A stop part way loses nothing.** A move refused (a file another program holds) leaves the archive aside under
  `.partial`, every join and write refused with words, until Finish archiving the event… tries again; one refused once
  the archive is whole (a continue's files coming back, the next event's record) waits the same way, and Finish begins
  the next event from where it stopped, its point and split never made twice (a point the archive's record did not note is found in the log). A continue whose files came back part way
  reads them back at once, so no save of the stores let go lands over them. No file of the data folder is ever put over
  one the archive holds already: one written after the archive began is set aside in its `aside/`. The next start
  finishes a `.partial`'s moves before anything of the event is written (a snapshot, a restart's line, `pages.json`),
  lets go what it read of what was left behind, then writes the point and begins the next event; the split asked with
  it is left for the admin (Admin → Health), and said so. A folder between an archive made whole and its next event is
  read only from the archives' records (exactly one whose `next.began` is not there, and no `event.json` nor its `.bak`):
  a current event's record that cannot be read is never taken for none, so nothing is begun again or saved over, and
  Archive this event… is refused this run; an archive whose record, or a `.partial` whose record, cannot be read, or
  settings that cannot be read, leave the folder as it is and every join and write refused with why.
- **Delete this archive's contents…** is for the laptop's token, typed at the laptop: it reads the archive's `event.json`
  first, removes everything else in the archive, writes the record again marked `purged` (with what could not be
  removed, `left`, which the next ask deletes: the row stays while anything is there), and writes `event.purged` once
  anything went, with what was left and whether its record could be written. It never reaches `data/audit-archive/`, and
  nothing is deleted on a timer. A change to a room the store no longer holds (one removed, or an archived event's whose
  key the next event's room has) is refused, so nothing a page of an earlier event still names lands in the next one.
- **Readers:** the admin health's `event` (`id`, `name`, `began`, `kind`, `from`, `archives`, and an archive under way),
  the admin page, the halls board and the context (the new event's halls at once), the AI's brief (the current event
  only), the audit list and the screens.
- Held on Linux (`test/events.test.js`, new, with `test/eventmove-preload.js`; `test/catalog.test.js`,
  `test/menus.test.js`, `test/resilience.test.js`): copy, continue and fresh on a seeded folder, the archive holding every
  room, upload, screen, take and account file, counted alike; the node's settings byte for byte unchanged; new codes, no
  earlier code or invite admitting, the hall's Stagewatch link and allow-list following, a continue giving back the
  codes, messages, upload and screen link; the desk result archived and back; every sign-in ended in each; nobody seated
  in a copy; the point as the first line of a new file, its target and words; a move refused part way tried again in the
  run, its split made by the Finish, and, held, finished by the next start; a room's snapshot or its backup held, the
  archive keeping the hall's messages whole at the next start; the next event's record refused (Finish in the run, and a
  start that puts it in place and begins nothing again); the archive's word that its next began refused (the next start
  begins it, the holds read from the archive, its point, not noted in its record, found in the log and never written twice); a current event's record unreadable at a start (nothing begun or saved
  over, the act refused); a continue's files coming back part way (its accounts kept, Finish bringing the rest); a
  `.partial`'s record unreadable at a start (served with every join and write refused, finished once it reads); a
  continue's uploads across volumes refused for room; a deletion left part way, recorded and finished by the next ask;
  the halls board's New hall taking an earlier hall's link; a manager refused, the screens' links kept when ticked, the
  split after the point, the contents deleted only with the token typed and the log still checking. What only a Windows run proves: a rename of a
  store another program holds open there (an antivirus) and the uploads on another volume (`%ProgramData%` and an
  `AGM_UPLOAD_DIR` elsewhere). Unit K (#80) adds the claim, the pin and the refusal while accounts are held aside.
- The papers: `README.md`, `README.txt` (after the event), `docs/INSTALL.md` (Events and their archives),
  `docs/ACCOUNTS.md`, `docs/DESIGN.md` and `CLAUDE.md`.

**An upgrade the laptop's admin or a granted account starts needs no administrator, checked against its release** (the
plan's Part 6, unit U18, with the owner's answers 36 and 38; the code and its tests on Linux, GitHub's answers stood in
for; nothing of it has run on Windows yet. A check takes only an immutable release, the repository's setting, which its
owner turned on on 2026-11-07 and unit U16's release job reads back; every release published before then is refused,
fail closed)
- **Upgrade AGMessage…** (Start → AGMessage; `launch.js upgrade`, new), for the laptop's admin and an account given
  `upgrade`: the person's own control task looks up AGMessage's newest release on GitHub and says whether it is newer
  ("The newest release is AGMessage 0.6.1 (AGMessage-Setup-0.6.1-unsigned.exe, 38 MB); this PC has AGMessage 0.6.0 (build
  41)."), a look that changes nothing and writes no event; Enter installs it, or the person types the full path of an
  installer they downloaded (`AGMessage-Setup-<version>-unsigned.exe`, quoted as a file dropped into the window is),
  which their console copies into their inbox under that name, saying its SHA-256. A look refused for the newest release
  alone (not immutable, no installer in it, GitHub's own refusal) says why and still takes a named installer; one
  refused for no internet, no repository named or an install record that names too little ends there. A busy AGMessage
  is upgraded only with a reason the person types, asked for and sent again with it. The console says the last upgrade's
  or go back's outcome first, with the last lines of its installer's log when it was not done.
- **The control task's checks, as SYSTEM, in the plan's order** (`machine.js control`'s `upgrade`), under
  `machine\work\upgrade.lock` from the read of what is under way to the hand-off (made only where none is; one older than
  15 minutes, past the control task's 10, taken over), so two control tasks never both start a runner: 1. the file staged in
  a new folder of `machine\staged\` (SYSTEM and Administrators only): a named one copied by its bytes from the inbox once
  `lstat` shows a file of its own (a link, a hard link, anything else, an empty one or one over 512 MB refused, one whose
  open is not the file `lstat` saw or whose size changes refused, and the inbox's file removed whatever happens), the
  newest release's asset downloaded straight there (through GitHub's API address and its redirect to GitHub's storage,
  https only, never past the size the release gives, and within 7 minutes in all, so the check ends within its control
  task's 10 and says why); only the staged copy is hashed or run. 2. The release, asked of
  `api.github.com` for the repository this build was made in (`build.json` gains `repo` at stamp time, from
  `GITHUB_REPOSITORY`; a build that names none checks nothing) by the version the file's name or the newest release's tag
  carries: it must be that tag of that repository (its API address, its page and the asset's download address all under
  it), published, `immutable: true`, with one asset of the file's exact name, uploaded whole, whose `digest` is
  `sha256:` and the staged copy's SHA-256. 3. Newer than the record's `SemVer`, by SemVer (the installer's own version
  check refuses an older or equal build a second time). 4. Not busy, or a reason typed. Refused with words: "AGMessage
  could not check this installer against its release (no internet). Run it yourself: Windows will ask for an
  administrator's approval."; a release of another repository, a draft, not immutable, no asset of that name or no
  digest; "This file is not the release's. Do not run it."; not newer; busy without a reason; an upgrade or a go back
  being checked or under way; an install record that names no port or no install folder. Each refusal is one
  `machine.upgrade.refused` event (who, and why), the staged copy removed. An administrator's elevated console may
  upgrade to the newest release; an installer it names is its own to run.
- **The run, handed to a runner** (`machine.js upgrade --step run`, new): nothing may run from Program Files\AGMessage
  while an installer replaces it, and the control task and the person's console both run its `node.exe`. So once the
  checks pass, the control task writes the plan in a new folder of `machine\work\` first (from then on the folder reads
  as a runner's), copies `node.exe` and `machine.js` beside it, and runs it there as a task of its own,
  `\AGMessage\Upgrade-<id>` (SYSTEM, once, its descriptor SYSTEM's and Administrators' alone, no time limit), then ends:
  a task of its own is a job of its own, since Task Scheduler ends a task's job at its time limit (the control task's
  10 minutes) and a child started detached would stay in it. An elevated console's runner is started detached, as that
  administrator. Its answer says what was checked and that the upgrade begins once the window has closed (press Enter).
  The runner refuses a plan naming an installer anywhere but the release's name in one folder of its own
  `machine\staged\` or the kept installer of its build; waits up to 10 minutes for every program of {app} but the
  server's own to end (a console still open past that is refused, nothing changed); reads the staged copy's SHA-256
  again; and runs the staged installer `/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /UPGRADEBY=<SID>`, with
  `/FORCE="<reason>"` when one was typed, its log in the runner's own folder (SYSTEM and Administrators only, never a
  file another account could place), on its own and never killed (Inno's rollback does not run on a kill); the
  installer follows its own order (the version check, `preinstall-check`, `upgrade-stop`, the files, `install`, the
  verify, and the way back by itself).
- **Each outcome one event, once it is seen**: the runner reads the installer's exit code, what the install record names
  after it and, when it did not reach its build, what answers on the port, and only then appends `machine.upgrade` (an
  exit of 0 with the record naming the build asked for: who, the builds from and to as the records name them, the
  installer's SHA-256) or `machine.upgrade.refused` (anything else, said from what was seen, never from the exit code
  alone). Its outcome goes into the person's outbox ("Upgraded: AGMessage 0.6.1 (build 52) is installed on this PC, and
  it answers.", or "The installer of 0.6.1 ended with 3: the build it laid down did not start. The install record names
  AGMessage 0.6.0 (build 41), the build before; AGMessage … answers on port 3023."), written after the control task's
  own answer so that one never lands over it, with the log's last lines; `ended.json` beside the plan.
- **One at a time**: a runner is under way while its own copy of `node.exe` runs from its folder (or for its first 2
  minutes), however long it runs; one whose end is written is swept with its task and its staged copy; one whose program
  is gone with no end written died, and the next ask says its outcome by its one event, from what the record names,
  then sweeps it. The installer refuses while another AGMessage installer runs on the PC, in any session
  (`Global\AGMessageSetup`, checked and made in `InitializeSetup`; its own way back's `/ROLLBACK` run excepted).
- **`/UPGRADEBY=<SID>`** (the installer, new): accepted only from SYSTEM, for an account the install record gives
  `upgrade` (`machine.js preinstall-check --upgrade-by`, which every check of the installer then carries, refused
  otherwise with words); the stop it asks for names that account ("LAPTOP\ben, by a checked upgrade").
- **Go back to build N** (Start → AGMessage, on an upgraded PC: the item names the build the upgrade replaced, an older
  build's item removed at each install; `launch.js back`, new): the record's `Previous`, gone back to once its build
  number is typed, and what it costs said first (the data laid back as it was when the newer build was installed; what
  was written since is not kept, though the audit log is). The control task checks that `Previous` is the build asked
  for, that its installer is kept in `{app}\installers\` (laid there by an elevated or a checked install, under Program
  Files, so no network and no check), that the backup the upgrade from it made is kept, and how busy AGMessage is; the
  runner reads the kept installer's SHA-256, stops AGMessage at loopback (reason `back`; it saves), lays that backup back
  (`machine.js restore`) and runs the kept installer `/ROLLBACK /UPGRADEBY=<SID>`, its outcome said from what was seen,
  its own steps first (a kept installer refusing once the data is laid back says AGMessage is stopped with its data laid
  back, and what starts it). An administrator may go back too.
- **`machine.js restore` keeps the machine events' place** (`settings.json`'s `machineSeq`) when the settings it lays
  back are behind it, written beside them and renamed over them, so the backup's own file is never changed: the audit
  log is never rolled back, and the server looks past its place only in the log's newest 500 rows, so the earlier
  build's first start would otherwise write every machine event since the backup a second time. Both the installer's own
  way back and Go back to build N lay their backup back through it.
- **The installer's words for the laptop's admin** now say that Windows asks an administrator's approval again only to
  uninstall AGMessage, or to upgrade it with an installer it cannot check (Upgrade AGMessage… needs none).
- **The readings lane**: R13 takes its offline half: the bundle's own `machine.js` asking for the release as a checked
  upgrade asks, from a copy of the bundle's `node.exe` that an outbound rule of the firewall blocks, run by a task with a
  control task's principal, and the words it gives; the rule and the task removed at the end. No reading waits for a
  unit now.
- Held on Linux (`test/upgrade.test.js`, new, with `test/fixtures/github-release.json`, GitHub's answer for one release
  in its REST API's shape; `test/control.test.js`, `test/machine.test.js`, `test/installer.test.js`,
  `test/readings.test.js`, `test/version.test.js`, `test/loads.test.js`): the request's shapes; the release judged; a
  named installer staged, checked and handed to a runner's task from its definition, which waits for the console, runs
  it from `machine\staged\` with `/UPGRADEBY`, its log in its own folder, and appends one `machine.upgrade` once the
  record names the build; a file changed in the inbox after it was staged changing nothing that runs; no network,
  another repository, a moved one, not immutable, no asset of that name, a digest that differs, not newer, busy without a
  reason, a link, no repository named and a record naming no port or folder, each refused with one
  `machine.upgrade.refused` event and nothing left staged; the newest release looked up (no event), downloaded (a slow
  one bounded) and checked, and refused before any download when not newer; who may, and an elevated console's runner
  started on its own; a plan naming an installer anywhere else refused; Go back's checks, its runner's order and each of
  its ends said from what was seen (a kept installer refusing after the lay back, its log's last lines); a restore
  keeping the machine events' place, with no event written twice past 500 other rows; the runner's own refusals; one at
  a time (the lock, a runner's program, one that died said by its event, the sweeps); an installer that ends without its
  build; the last answer written after the control task's; the installer's one-at-a-time mutex; `/UPGRADEBY` from SYSTEM
  alone; an https GET against a local server (a redirect to http refused, the bounds, a silent server and a slow one);
  and `launch.js upgrade` (a refused look still taking a named file) and `back` as the person. What only a Windows run
  proves: SYSTEM running the control task and the runner's own task, its job outliving the control task's and the
  installer outliving the runner, Inno taking `/UPGRADEBY` and its mutex across sessions and laying the files down under
  a runner, GitHub's answer and a download from the show laptop's network (R13, lab 7, and the installer's life cycle,
  U16); no reading of the lane reads the runner's task yet.
- The papers: `README.md`, `README.txt` (Upgrading an installed AGMessage), `docs/INSTALL.md` (The checked upgrade, and
  Go back to build N), `docs/DESIGN.md`, `SECURITY.md` and `CLAUDE.md`. `docs/NODES.md` is unchanged: nothing of it
  reaches the wire, the context or the AI's brief.

**The installer's life cycle in CI, and its provenance; immutable releases read back** (the plan's Part 6, unit U16, with
the owner's answers 34 and 38; the job, its tests and their pure parts on Linux: the job's first run is the next push's,
and immutable releases are the repository's own setting, which its owner turned on on 2026-11-07, before v0.6.0)
- **`lifecycle`** (CI, new), on `windows-2025`, elevated, after the installer job, for every push, a tag and a run asked
  for by hand: Defender's real-time monitoring back on first (`tools/defender-on.ps1`); Inno Setup 7.1.0 pinned and
  checked as the installer job pins it; every action pinned by its commit; every step bounded inside the job's 290 minutes,
  the life cycle's step (215) holding every bound its tests and hooks declare, so a run slow inside them is never cut short
  with nothing said.
  **The release order** first (`tools/lifecycle.js order`, new): this build's install version must be above the newest
  release's, read from the build its notes name on their first line ("Build 0.5.1+51.89104d8."), or an AGMessage installed
  from that release would refuse its installer; a release whose notes name no release build of its own version, a list
  or notes that cannot be read, stop the job. Then **three builds from one payload**: this build's installer, the installer
  job's, the one a release ships; the build before it, the zip's stage stamped one build lower (at build 1, the highest
  build of the line below, its `package.json` that line's version); and the next build, whose server ends at once with
  code 1 (`tools/lifecycle.js stage`, new, its commit, channel and repository kept), each built by
  `installer/build-installer.ps1`.
- **The life cycle** (`installer/test/lifecycle.test.js`, new: 32 node:test tests run one after another, each leaving what
  the next begins from; its hands on Windows `installer/test/hands.js`, its expectations `installer/test/expect.js`, and
  `installer/test/as-account.js`, a probe a task runs as a standard account): a quiet first install with no `/ADMIN=`,
  another `/DIR=`, a junction and a folder another account owns at `%ProgramData%\AGMessage`, and a portable copy on the
  port, each refused with its words and nothing made (the folder and the junction's target left as they were); the build
  before this one installed for the runner's account by `/ADMIN=` (recorded in HKLM, its server task, its admin's control
  task and both firewall rules made, `machine.admin` appended, its server proving the token), given a first admin account,
  a hall, a code guest's messages and its sealed context token at loopback, and busy; an upgrade refused while busy with no
  reason, and while a silent program holds the port, naming that program's pid; the upgrade to this build with a reason
  typed, keeping the halls, messages, accounts, every sealed value, the certificate's fingerprint, the machine key and the
  audit log's head (`lib/importfacts.js` before and after), both installers kept and Go back to build N offered, its stop's
  record saved with the backup it made, and the stop timed to the new build's first proof, reported in the job's summary;
  a downgrade and the same build refused with words, the same server serving on; every installed file the payload's
  (`SHA256SUMS.payload`) and nothing else but Inno Setup's own and the kept installers; no Users, Authenticated Users,
  Everyone or CREATOR OWNER entry on the machine folder, `keys`, `data` or `logs`; no `SeImpersonatePrivilege` in the server's
  token, read through the token itself (`OpenProcessToken`); the zip's `start-agmessage.bat` run from a throwaway folder
  naming the installed build in its banner and ending with 3 with the server's words for the installed node's port, and a
  portable copy first on that port leaving `server.log` saying another copy holds it and the installed node serving once it
  is stopped (unit S's "On an installed PC"); a local standard account given `start` and `stop` running its own control task
  as SYSTEM, a stop with its reason that saved and a start, one machine event each naming it; no token, password or stored
  password in the server task's or a control task's definition; the import refused, with its words, on the node that has
  served, and run whole (stage, the export as the account whose profile holds the keys, the take and its verify, forget-keys,
  finish) into a machine folder of its own that never started, the copy's facts the portable folder's, its keys removed, the
  folder marked and refused at its next start; nothing written in Program Files\AGMessage while AGMessage runs; a file held
  open rolling the upgrade back by Inno Setup's own rollback, the record as it was and the earlier server started again; a
  build that does not start replaced by the build before it, which answers, its data laid back (the installer's exit 3);
  the watchdog's give-up, its server ending at once seven times, leaving the server task stopped with 0 past
  RestartOnFailure's minute; the uninstall keeping the data (the tasks, the rules and the record removed, `Kept` and `Port`
  left, every account's right taken back, the stop's record saved); the kept root set aside for a junction, and the kept
  root given to another account, each refused at the next install by `prepare`'s own check past the record's (a link, its
  owner), nothing laid and the root put back as it was; an install again taking it, and the uninstall with
  `/REMOVEDATA` removing it with the record; and no token or password, of the installed node or a portable copy, in any
  installer's or uninstaller's log. Every message it writes into the job's log, its TAP report and its report that quotes
  what a program said carries each token and password it knows as its label. It refuses any machine but an elevated GitHub-hosted runner with no install record, no
  install folder and no machine folder, before anything is made.
- **Counted** (`tools/lifecycle.js count`, new): the run's TAP report against the life cycle's files: every test they declare
  ran and passed, by its name, and nothing failed, was skipped, left to do, cancelled or run undeclared; a file that skips,
  marks a test to do, runs only some, nests a test or a suite, or names a test with no literal is refused as it is read.
  The job's summary says the counts; its artifact, `agmessage-lifecycle-<commit>`, keeps every installer's log and the
  life cycle's report.
- **Where the runner cannot.** The standard account's control task runs where the runner runs a second account's process;
  the test leaves it to lab 7 on the show laptop (having read the grant, the record and the task) only where Windows refused
  the account's logon: schtasks' words at the probe's registration, or its task's last result a logon refused (a bad user
  name or password, a logon type not granted, no password kept) with no line written (`installer/test/expect.js`
  `logonRefused`). The probe writes its first line as it starts, so a probe that ran as the account is asserted step by
  step, waited for as long as its own longest run (its bounds in its plan), and one that ran and did not finish fails, as
  does a task that started no probe for any other reason (node.exe in Program Files that the account cannot run among them).
  The import's verify goes into a machine folder of its own, with the installed node's
  `machine.js`, `launch.js` and facts reader, since a quiet install starts its node and the import page is a person's.
- **The release's provenance**: the release job attests the zips, the installer and `SHA256SUMS.payload`, through which
  the attestation reaches every file the installer lays down (`tools/provenance.js subjects`, new, which refuses a release
  missing one), verifies each before it publishes (`gh attestation verify`, held to `.github/workflows/ci.yml`, the tag, the
  commit and a GitHub-hosted runner), and publishes only once the life cycle passed, every action it uses pinned by its
  commit and its checkout keeping no credential; its notes give the command to check a
  download (`gh attestation verify <file> -R jammin808/AGMessage`).
- **Immutable releases**, which a checked upgrade takes alone (U18), are the repository's own setting, its owner's to turn on
  (Settings, the Releases section, Enable release immutability), for releases published after: nothing in CI changes a
  setting. Once a release is published, its job reads it back (`tools/provenance.js immutable`, new) and fails when it is not
  immutable, its words saying the setting is off, what that costs and who turns it on. R13's words for a release read as
  not immutable say the same. GitHub gives a workflow's token no read of the setting, so it is read back from the release
  itself, once published, and a release published while it is off stays mutable for good. The owner turned immutable
  releases on on 2026-11-07 (an item of the close, #81, recorded in the plan's §0.2), so v0.6.0 and every release after it
  are published immutable; the releases before it stay as they were, and none of them is newer than an installed 0.6.0. The way back's own installer log
  (`{tmp}\rollback.log`) goes with Inno Setup's temporary folder, so it is not kept or searched; no token or password is on
  that installer's command line.
- Held on Linux (`test/lifecycle.test.js`, `test/provenance.test.js`, new; `test/readings.test.js`): the two stamps and
  their order, the defines reading them, the broken server's end; the release order and its refusals; the count on real TAP
  reports (passed, failed, a file that throws as it loads, a file not run, one not declared, each uncounted form); the life
  cycle's own file held to the plan's list, every item with its test and every test an item's; its refusals of a machine;
  its plan; every word it expects held to the installer's script (each `Refuse` rendered), to `machine.js`'s own commands
  run on stand-ins (`prepare`, `preinstall-check` for a portable copy, a silent port and a busy AGMessage, `upgrade-stop`,
  `servedWords`, and `prepare` past the record's check for the kept root as a link and as another account's), to
  `lib/startup.js`, `lib/dataformat.js` and the .bat; its readers of a log, the record, an access list, the payload's sums,
  a snapshot, the events and a secret, and the scrub of what it quotes; Windows' refusal of the standard account's logon
  read from schtasks' words and its task's result, signed or not, and nothing else taken for one; the probe run here (its
  first line before its plan is read, its bounds the plan's, its end said however it ends) and its longest run inside its
  task's limit and its test's bound; every test and hook of the life cycle bounded, and their sum inside its step's; the
  job's shape; the release's subjects, its verify, its read back, its actions pinned by commit, and the immutability judged
  as `machine.js` judges a release. What only the job's run proves is everything the life
  cycle runs; its first run is the next push's.
- The papers: `README.md`, `README.txt` (Checking a download), `docs/INSTALL.md` (The installer's life cycle in CI, and
  the release's provenance), `docs/ANALYSIS.md`, `docs/DESIGN.md`, `SECURITY.md`, `CLAUDE.md`, and the plan (the close's
  item for immutable releases in §0.2, and U16's and §0.8 C2's notes as built). `docs/NODES.md` is unchanged: nothing of
  it reaches the wire, the context or the AI's brief.

**The sign-ins and the accounts are keyed to the machine key** (the plan's Part 3, unit K, 3-K; the owner's answer of
2026-10-31, "Add it", and the plan's extension to account sessions and accounts: the code, its tests and the browser
smoke; the Windows legs are CI's)
- **Each store is a file keyed whole** (`lib/keyedstore.js`, new): `accounts.json`, `sessions.json` and
  `admin-sessions.json` are the store's JSON with the save's fields first (`v: 2`, the store, the folder's set, the save's
  number, the key's id, the time) and an HMAC-SHA256 of every byte before it last, under a key of its own; five keys
  derived from the machine key (`lib/secretbox.js` `derive`'s allow-list gains their labels), never stored. A sign-in is
  kept by its keyed hash, the token's sign-ins by the token's keyed tag; a sign-in stamped more than 5 minutes ahead is
  dropped at load. A sign-in file that fails its check ends all its sign-ins, said (`signins.ended`) and kept aside as
  `<name>.changed-<time>.json`; an accounts file that fails, or names another machine key, another folder's set, an older
  save, or is 0.5.1's on a laptop that has keyed, is **held aside** whole, its copy kept byte for byte
  (`accounts.held-<time>.json`, `accounts.held`). Only ENOENT means a store is absent: one that cannot be read is
  `unread`, loads nothing and is never written over.
- **The record outside the data folder** (`<keyDir>\stores\`): each store's newest save, the one before it and the
  floor of the newest save that took a right away; which set of saves this folder holds; the set this laptop saved last
  (`latest.json`); that this laptop has keyed (`keyed.json`); each account's keyed digest; an event archive's pins and the
  archive under way. One save behind loads, said (`accounts.behind`); a save that takes a right away or ends a sign-in is
  written twice and its record at once, so the copy before it reads as older. A folder moved from the copy this laptop
  saved last keeps its accounts and sign-ins, and its set forks; another folder's saves read `other`. A record that fails
  its check is kept aside and said (`stores.record`); one that cannot be read opens no store this run. A store's file
  changed while AGMessage runs is never made its `.bak` (`stores.changed`). Its lane, `storesHead`, is in `saveLanes()`
  after the stores; health gains `signins` (each store's state and words, the record's, the set, each store's newest save),
  and `/api/admin/me`, the admin page's settings answer and `/api/auth/me` gain `held`.
- **The first start of 0.6.0 on this laptop** keys 0.5.1's accounts as found (`accounts.keyed`) and ends 0.5.1's sign-ins;
  those that can manage AGMessage or reach past their halls, and any account a folder holds twice, wait once for the token,
  refused at sign-in as an unknown name is. The black window says it under the token block. Its writes go the accounts
  first: the sign-in files are saved keyed only once the accounts' keyed save has landed, and no record outside the data
  folder is written until every store it saves has landed (health's record `waiting`, and Archive this event… waits), so
  a stop part way, or an accounts file another program holds, leaves a first start again, never a plain `accounts.json`
  beside `keyed.json`. The copy of the waiting accounts is kept only where some wait.
- **Accounts held aside are adopted by the token at the laptop** (Admin → Accounts held aside, drawn for the token's
  sign-in made by this run; `GET /api/accounts/held`, `POST /api/accounts/adopt`): each account of the copy marked as this
  laptop last saved it, changed since, new to this laptop, or repeated; admin-level ones unticked with a confirmation of
  their own; one-time passwords ticked by the copy's state (every admin-level account; under `elsewhere` also every one that
  reaches past its halls; under a copy that may have been changed, every one; never one this laptop last saved, nor at the
  first start), unticking one asking its own confirmation. The token typed is judged first, so the lockout never keeps the
  person at the laptop out; the one-time passwords are shown once, on the page (`accounts.adopted`); Start with no accounts…
  (Leave these out… at the first start), Adopt more… and Leave the rest out… (`accounts.fresh`), and the Accounts page tells
  an admin account of those kept aside. Each row shows the account's rights, when it was made, its last sign-in and when
  its password was set, read from the copy. A copy changed since it was held, or one that cannot be read, offers no account
  (said on the console, in health and as `stores.changed`): the panel offers only Leave these out… or Leave the rest out…,
  which end the hold (`accounts.fresh`, with why). An adoption is saved before it answers, its record naming the hold
  ended once that save has landed, and it reports and audits only the accounts it took: one whose name an account made
  meanwhile holds is said (`notTaken`) and stays for Adopt more…. While accounts are held aside every account sign-in
  answers 503 with why (`login.refused`, never the typed name), and no first admin account is made; the sign-in page says
  it in place of its tabs, or with one line at the first start. The opener opens `/admin` while accounts wait.
  `/api/admin/me` gives the admin page's own facts of a hold (those left out of an adoption among them) only to a page
  its gate admits; anyone else is told what `/api/auth/me` tells.
- **The token's sign-in counts only at the laptop**: a cookie through the tunnel or under another host name is nobody,
  over HTTP and on a socket. **The token sign-in judges the typed token first**, as the first admin account and an
  adoption do: the right one is taken while wrong ones hold the lockout, and a wrong one is written only while it does
  not (Accept keeps its order). The first admin account is made only with the token, in both channels, and never beside
  accounts held aside or where the accounts could not be read.
- **Events** (unit 76): Archive this event… waits while accounts are held aside or the stores were not opened; before its
  step 3 the record claims the archive under way and pins the accounts file it takes, by the save and the set it was made
  in (so an event archived before the folder moved continues after it); a continue or a copy opens an archive's accounts
  against its pin, and a continue a stop cut short also its own save made after its claim (the newest the record names,
  or one save behind it), anything else held aside (an older save of the set put in its place reads `older`); an
  archive's accounts file that cannot be read waits, nothing opened or written over it; one whose contents were deleted is
  continued with no accounts, said as `missing` until the first admin account is made; step 7 saves the next event's
  stores at once and the claim clears. Only ENOENT means an archive under way is gone (`lib/events.js` `archiveState`): one
  whose record cannot be read at a start keeps its claim and its pin, said, for a start that can read it. At a start a
  `.partial` the claim does not name is set aside as `.<time>.unclaimed` (`event.unclaimed`, health's `event.unclaimed`),
  and an archive whose next never began begins only when the claim names it.
- **The import** (unit 75) carries `stores\` with the keys, so the installed node's first start is a move; its verify adds
  `stores` (no account held aside, no account's sign-in ended there, read by `lib/importfacts.js` with the copied keys),
  and `forget-keys` removes `stores\` with the rest of the profile's `%LOCALAPPDATA%\AGMessage`.
- **Not kept, the fifth**: going back to 0.5.1 and forward again holds the accounts aside until the token adopts them (each
  one 0.5.1 left as this laptop last saved it marked so, ticked, with no one-time password), and signs everyone out. The
  admin page's rollback line says it too.
- Held by `test/keyedstore.test.js` (new: the seal and its domain separation, the first start, unrecorded, changed and its
  panel, behind, older, the floor, a power cut, relabelled, elsewhere, other, a move, a file changed while running, unread
  and keyless byte for byte, missing, repeated, rollback, the claim and its pins, the read-only judge, speed against the
  plan's bounds, and its requires; a continue resumed at a start with an older save in its place, a move then a continue,
  an archive or its accounts file that cannot be read, an archive's accounts deleted, a held copy changed or gone and
  Leave these out…, and a first start whose accounts' write is refused), `test/keyedsignins.test.js` (new: a token
  sign-in planted three ways, an account's sign-in planted and retargeted, a restart keeping the genuine ones, a new
  token, the token only at the laptop, an accounts file written into and its adoption with one-time passwords, another
  machine's folder and Start with no accounts, the lock at the token sign-in and the adoption, the first start on 0.5.1
  files and the opener, no secret in any store, record, answer or row, the events' claim, pin, continue and unclaimed
  `.partial`, an adoption on disk before its answer and its facts only to the admin page, and an event continued after
  the folder moved), `test/events.test.js` (an archive's state as the claim asks it), the browser smoke (a folder
  started under another laptop's key: the sign-in page's words in place of its tabs and Join with a code, the panel's ticks
  and each row's doors, an admin adopted with its confirmation and a one-time password shown once, the Accounts page's
  line of those left out, each row's rights and dates; 0.5.1's files at the first start: the tabs with one line, the admin
  who waits; the admin page's rollback line), and the tests
  these moved (`test/helpers.js` gains the stores' fixture keys, `openStores`, `resealStore`, `sealStore`, `signInHash` and
  `setupAdmin`, which every test's first admin account is now made with; a test that wrote a store by hand reseals it as a
  key holder could). What only a Windows run proves: the
  import's `stores\` carried and verified on a real profile (CI's `lifecycle`), and `keys\stores\` under the installed
  node's access list.
- The papers: `docs/ACCOUNTS.md` (Keyed to this laptop), `SECURITY.md`, `README.md`, `README.txt` (Upgrading, Moving
  AGMessage to another laptop, the rollback note), `docs/DESIGN.md`, `docs/ANALYSIS.md`, `docs/INSTALL.md` and
  `CLAUDE.md`. `docs/NODES.md` is unchanged: nothing of it reaches the wire's hello, the context or the AI's brief.

**0.6.0 closes** (the plan's #81: Part 1's unit 22, Part 4's unit 32 and Part 5's unit 34, as one unit; the code, its
tests and the browser smoke on Linux, CI's runs 101 to 103 as their logs and artifacts say; nothing measured on the show
laptop and no Board device walked)
- **This entry is dated** 2026-11-08, the day 0.6.0 closed, and is no longer in progress. `test/version.test.js` holds
  it: only the newest entry may say "(in progress)", each entry under it is dated no later than the one above, and
  0.6.0's header is the closed one.
- **The build count starts again at 1:** `agmessage.runBase` (`app/package.json`) is 103, CI's last run when the close
  was committed, so the next run, the close's push, is 0.6's build 1 and the build is the run less 103 from then on
  (`tools/stamp-build.js`; CI's header says so too). A 0.6.0 development build made before then carries its run's
  number (`0.6.0-dev.103` and lower, install version 0.6.103 and lower), so it counts above v0.6.0's release builds and
  the development builds after the close, and one of the same number is another commit at the same install version.
  Where one is installed it is uninstalled, keeping the data, before the release is installed (its installer refuses
  it as newer or as the same build again); where one ran portable, the release opens its folder and This laptop's Data
  folder line says, at the release's first start only, that a newer build wrote it (`docs/INSTALL.md`, `README.txt`
  Upgrading).
- **The coverage gate is raised** from 95 / 84 / 91 to **97 / 88 / 94** (lines, branches, functions), re-measured at
  99.19 / 90.45 / 96.57 over 1,250 tests on Linux (11 of them Windows-only, skipped there). `test/version.test.js` holds
  the gate at or above that and `docs/ANALYSIS.md`'s row to the numbers the run holds.
- **The catalogue's required verbs are complete** (`test/catalog.test.js`): the list is exactly the verbs the acts send,
  none left out and none named that no act sends, and every other verb a handler file registers and route the server
  mounts is named, with why no act sends it (a page's own join, sync or read, a screen's report, the sign-in, a page or
  file served, the machine's own half of the wire, or a control inside the panel or dialog an act opens), never both.
  A route is read at a literal path or at one of the machine's paths (`machinewire.PATHS`, read from the module, so its
  four routes, `/api/machine/hello`, `busy`, `stop` and `events`, are named too), and one mounted at any other
  expression fails the fence. Every 0.6.0 verb of the plan's §16.7 and its amendments (23, each with where the plan
  names it) is held to be an act's and a required verb in a list of its own, so an act dropped with its required entry
  still fails. Ten verbs the acts already sent joined the list: `room:withdraw`, `admin:setView` (both §16.7's new
  verbs), `display:list`, `page:withdraw`, `pin:mine`, `file:mark`, `admin:setClock`, `admin:setOnStage`, and the held
  accounts' `POST /api/accounts/adopt` and `GET /api/accounts/held`.
- **The show laptop's readings in the release's notes:** `tools/readings.js laptop` reads `docs/DESIGN.md`'s table
  (Measured on the show laptop, readings 0-9 of the plan's Part 5 §13.4) as it stands when a tag is built, and the
  release job puts it beside the Windows readings: each reading that triggered its change, named with that change (a
  0.6.x unit, never the release's), each recorded within its threshold, each recorded without a verdict, and those not
  measured, of which nothing is claimed. A filled row reads `<day>, build <build>: <what was read> — triggers` (or
  `within its threshold`, or `recorded` for reading 0); a paper that cannot be read says so, and the release is never
  held. When 0.6.0 closed every row read not measured, so none had triggered.
- **The Windows readings, as they stand:** CI's run 101 (`0.6.0-dev.101+ba76491`, 2026-11-08, Defender on) is recorded
  in `docs/INSTALL.md`: R1 (the default page back at the largest hall in 2.02 s at the slowest, over 1.5 s), R2 (11.8 s
  to lay this build over v0.5.1's payload, over 6 s), R3′ (7 of 10 stops at loopback saved) and R12 (a non-zero exit
  not started again) missed their marks; R4 and R5 met them; R7 to R10 and R13 recorded. R6 and R11 were not taken, by
  a fault of the lane's own (below). R8's words for the control task are judged again from that run's own record: the
  descriptor Windows read back names the runner's account `LA` (the machine's own Administrator, RID 500), which
  `tools/readings.js` read as no account it knew, so the paper said the account a control task is for may not read
  and run it; it reads LA and LG as that machine's accounts now (`test/readings.test.js` holds both), and the paper
  says that account may. The release's own notes name each reading its tag's run finds missing its mark, with the
  fallback its unit names (`tools/readings.js notes`); none holds the release.
- **What CI showed when 0.6.0 closed, and what the release waits for.** Run 101 (`ba76491`) passed every job but the
  installer's life cycle, which failed at its first test, and took neither R6 nor R11, on one cause: the lane's step
  that makes their standard accounts (`tools/readings-take.js`'s `users`, which the life cycle uses too) gave
  `New-LocalUser` a description of 49 characters, and Windows takes 48. It is 45 now ("AGMessage test account: removed
  after its use"), and `test/readings.test.js` holds every account the lane and the life cycle make to Windows' bounds
  (a description of 48 characters, a name of 20). Run 102 (`6fba155`) failed the Windows tests on the keyed stores'
  timed speed test, so no zip, installer, life cycle or readings were made; that fence counts the work now (Fixed,
  below). Run 103 (`1f7f2dc`) failed one test on Linux (Node 24) and one on Windows, each passed by the run before it:
  `test/audit.test.js`'s run with no machine key read `settings.json` before its first save had landed, and
  `test/resilience.test.js`'s second start read the audit records' folder while the running server's atomic write
  had its `.tmp` there; both now wait for what they read (Fixed, below). The release is made only once a run's life
  cycle passes (`release` needs `lifecycle`), so `v0.6.0` waits for a run that passes whole as well as for the walk.
- **Deferred to 0.6.x: an acknowledged message on disk (the group commit, the plan's #79).** It lands only when reading
  3 (`peaks.auditPutMs`, p99 ≤ 2 ms and max ≤ 100 ms on the show laptop's disk) calls for it, and that reading has not
  been taken. What lands it: the owner reads `peaks.auditPutMs` from Admin → Health after a rehearsal on a 0.6.0 build
  and writes it into `docs/DESIGN.md`; where it triggers, the group commit is built as a 0.6.x unit. Until then the
  papers still say what a power cut can lose (the last few seconds of answered changes, in the system's file cache).
  Unread dots on the room switcher (#56), which could also have slipped, are in 0.6.0 (above).
- **The walk on the Board's devices holds the tag.** `docs/DEVICES.md` is written for the owner to fill: a record for
  each of D1-D7 (the model, the OS and browser versions, the date, who walked it, its viewport and pixel ratio, the
  reading distance and Text size), and every feature of the hall page, the Board's chat view and the stage with what to
  look for, the clock or countdown, Pin for me and Also on among them, each "not walked". `v0.6.0` is tagged only once
  each device the owner has is walked with no ✕ standing; a row with no device stays "not walked", a fact and never a
  pass, and a Board device below the page floor is a ✕ until it is retired from the Board or replaced. The browser
  smoke's floor leg gains the menus without the popover API: a message's right-click, ⋯ and Shift+F10 open its menu
  fixed at the menus' layer, and a screen's menu opens inside Screens & pages, opened through `AGM.openDialog`'s own,
  where Escape closes it and keeps the dialog.
- The tag `v0.6.0` and its release are the owner's acts, after the walk and a CI run that passes whole; the version
  stays 0.6.0, and immutable releases are on (since 2026-11-07).
- The papers: `README.md` (the build count, the release's notes, the walk), `README.txt` (What's new in 0.6, and
  Upgrading's line on a development build from before the close), `docs/INSTALL.md` (the build count and what to do
  with such a build, the notes, run 101's readings, why it took neither R6 nor R11, and R8 judged again),
  `docs/DESIGN.md` (how a reading of the show laptop is written, and read for the notes), `docs/DEVICES.md`,
  `docs/ANALYSIS.md` (the coverage, the required verbs), CI's header (the build is the run less `runBase`),
  `CLAUDE.md`, and the plan's as-built notes (§0.2, Part 5's unit 33).

**Fixed**
- The portable import names a part of its bundle by the part's own name when it refuses one ("0000021.part is not a
  part the export wrote (a link, or not a file)"). It named the part by its whole path under the account's inbox, and the
  words are cut at 200 characters, so on a Windows profile the reason itself was cut away ("(a link, or )"); CI's Windows
  run found it.
- Three tests read what a slow runner had not done yet, each found on CI's Windows run: the inputs test that wants every
  case answered gave a handler 400 ms before calling it silent (now 5 s, that test alone; one that never answers is
  still the fault it finds); the
  chat-view test read the support view's copy of a relayed state as soon as the person's own page had its two (it now
  waits for both pages); the upgrade stop's test gave the wait for the server's programs 300 ms, which a runner's timers
  could end one ask early (it now waits for the ask that finds nothing running). Nothing that ships changed.
- The event test's show-desk result is one a desk tick keeps. It named a Stagewatch other than the one the default link
  points at, which the server rightly ends at its next tick (every 3 s) as having nobody to tell; the test read it back
  before a tick on Linux, and CI's Windows run (99), slower, saw a tick land first. The result now names the default
  link's own address, held there across a tick landing before the first archive and after the continue. Nothing that
  ships changed.
- The keyed stores' speed fence counts the work instead of timing it. It held a start's open of 5,000 sessions, 1,000
  accounts and 50 token sign-ins under 250 ms of the clock, which CI's Windows run (102), busy with the other test
  files, took 938 ms over (10-21 ms here). It now holds what the plan's row is for: the open makes the same MACs,
  hashes, reads and parses as one of 50 sessions (one MAC a file, never one a record, each byte read and MACed once),
  and a save of the sessions and a set record each make one MAC, as the audit log's work is counted and never timed
  (`test/audit-preload.js`). A MAC a record put into the sessions' load fails it; how long each took is said beside it,
  a record and not a pass mark. Nothing that ships changed.
- Two tests read a file before the server had finished writing it, each found once on CI's run 103 and passed by the
  run before. The run with no machine key read `settings.json` straight after the patch that saves it, whose lane writes
  a moment later, and on a fresh folder found none: it now waits for the save the patch asked for. The second start's
  test read the records beside the key 400 ms after the running server's last write, and on Windows met the head lane's
  write still in progress (its `.tmp`, renamed away as it was read): it now reads them once no write is in progress and
  two reads 250 ms apart agree, before the second start and after it. Nothing that ships changed.
- The tests that read a file a running server writes wait for what they read, never a fixed time, and never read a
  save in progress. CI's run 104 (Node 26) found one more: the export test listed the data and key folders and stat'ed
  each name, and met a head record's `.tmp` renamed into place between the two (ENOENT). A reading of every test that
  reads a store, a record or the audit log while its server runs found the rest, each with nothing it waited on that
  meant the write had landed, and a run with every write lane held back 0.6 to 1 s found two more. `test/helpers.js`
  reads a folder only at a moment no save is under way in it (`filesAtRest`, `settledFiles`: no `<file>.<pid>.tmp` or
  `.new` listed, no name gone as it is read, and for a before and after two readings alike) and an appended log up to
  its last newline (`wholeLines`: an append read part-way is read whole a poll later). The export test, the audit log's
  no-secret scan, the second start's records and the keyed stores' no-secret walk read their folders through them, the
  export test leaving out the peaks, which the server saves on a 5 s window of its own; the export's, a download's and
  the machine events' rows are polled through `wholeLines`. The hall test waits for `settings.json` to hold both halls' links, then none of
  hall B's; the On stage and clock refusals for the PATCH or the choice before them to be in `accounts.json`, and the
  clock test for a new account to be there before it reads what the account keeps; the Board's line and the twenty
  confidential waits for `pages.json` to hold them, and the hold's polls read no `pages.json` as none yet rather than
  throwing; the fresh event for its new `pages.json`; a pin for the file to hold it before its message is deleted; the
  keyed stores' kills for the act's account, sign-ins and set record on disk (a stop saves every lane, so nothing sleeps
  before one any more); the watchdog's signal test for the pid the file holds, not its name; and the opener's test for
  its whole line. Nothing that ships changed.
- The admin page's Accounts held aside keeps each account's row as it draws its bars again (at every answer of the
  settings, every 5 s, and at each tick), as its rooms, links and event rows already were: the row, its box, its lines
  and its ⋯ are kept by the account's key and drawn again in place. It threw them away and made them again, so a
  keyboard user in the list lost the focus to the page every 5 s, a ⋯ menu open across a redraw opened again when its
  button was pressed instead of closing, and Escape left the focus nowhere. CI's browser smoke (run 104) met it once as
  the held row's doors out of step; the step now draws every bar again with the focus in the row and holds the row, its
  ⋯ and the focus kept, and its line names each part and each door check that missed, with what the page held then, and
  writes each tick as ☑ or ☐ before its words (it printed it as `=true` after them, which the CI log masked).
- The installer's build accepts the installer it built. `installer/build-installer.ps1` reads the version back from the
  file it compiled and compares it with the build's, and read its strings with the padding Windows' version resource
  keeps after them, so CI's first build of it (run 96) refused "0.6.0.96" padded with blanks as not "0.6.0.96". The
  padding (blanks or NULs) is cut before the two are compared; a version that differs is still refused.
- The browser smoke's ＋ steps on the ❝ Quote tab say what the tab stood on when its Show was not ready in time, and set
  ＋ on or off rather than toggling it. One local run found Show not ready 8 s after a reload (the next two runs did
  not), and a step after it was then handed ＋ the wrong way round; the next time, the report names the box, its pane,
  the console's read and when the page fetched what the tab waits for. Nothing that ships changed.
- The installed node's account lookup says when it cannot read Windows' local accounts, and looks for a module's
  manifest in a folder of its version too. CI's Windows run, its first of these scripts, read `BUILTIN\Users` as no
  group: a failure of the lookup was swallowed, so an account read as no local user and no group whatever it was.
  `machine.js` imports each module Windows PowerShell ships by its manifest's path under `$PSHOME\Modules` and looked
  only in the module's own folder; it now also takes the manifest in the module's one version folder, where
  LocalAccounts is taken to keep it (the next Windows run says whether that was the cause). A lookup that still fails
  says why: `/ADMIN`, a grant and a handover refuse an account that has never signed in here in words that name it,
  never as "no local account", and one that has signed in here is still confirmed by its profile.
- An upload whose stored path is no file (a folder in its place) is refused as one that could not be checked, on every
  platform. The archive's check opened it and, on Windows, read a folder as an empty file, so it was refused in the
  words for a file packed some other way; Linux could not read it at all. The upload check now asks first whether it
  is a file, for every type it checks, and so does a file's check at its first take on the stage, which shows no such
  file. CI's Windows run found it; nothing a person uploads takes that path.
- A test of a first start no longer reads the data folder whole while the server may be saving its settings beside it
  (a file written next to `settings.json` and renamed over it): a run on Node 24 listed that file, which was gone when
  it was read. It looks for each folder and file it wants by name. Nothing that ships changed.
- The browser smoke starts its browser on a port the browser takes itself, read from its profile's `DevToolsActivePort`,
  and waits 30 s for it. It chose a free port and handed it over, with 15 s to answer; CI's Linux run once found no
  answer there, the browser started and the run over before a page was opened. Nothing that ships changed.
- The browser smoke's HTML probe, which hands `parseInert` an inline handler on purpose, keeps its refusal to itself.
  Chrome on CI's Linux runner tried the handler from the template's content, and the page's policy refused it, so the
  backstage documents page counted a violation that was the probe's. Nothing ran then or now; the probe says how many
  times the browser tried, each refused, and only that one refusal is taken off that page's problems.
- "Leave the hall?", asked from the Board's chat view's ⋯ sheet, stays open while the page draws what it hears. At each
  refresh (a message, a person come or gone) the page reads an ask's object again and closes the ask when the object is
  gone; it had no reading for the sheet, so the first refresh closed the ask under the person's finger and said the
  thing was gone. The browser smoke found it at a phone's size when the machine was busy. The sheet is now read as it
  is while it is open, the smoke refreshes the page under each Leave ask and wants it kept, and a test holds every kind
  the hall page runs that may ask to a reading of its own.
- A hall's side rooms keep the order they were made in. The store ordered them by the millisecond each was made, and
  two made in the same millisecond by their keys, which are random: CI's Node 26 run listed twenty rooms made one after
  another with Room 7 before Room 6. A room made now is stamped after the newest the store holds, loaded or made, so the
  order is the order of making, on the halls board, the admin page and after a restart, however fast the rooms come
  and if the clock stepped back.
- Enter in a field of a dialog on the halls board (New hall, Password, Set up the hall) or the Accounts page (Add a
  person, Edit) saves. Each form's first button was Cancel, which Enter presses, so a name typed and
  Entered was thrown away. Cancel is now a plain button that closes its dialog, and Save is the form's default.
- The clean copy is clean every time. `make-shareable-copy.bat` copied into one fixed folder and kept what was already
  there, so a clean copy that had been started once to test it kept its accounts and password hashes, sign-ins,
  `secret.key`, audit log and settings when it was made again, while the window said "The copy has no meeting history,
  files, keys or settings." Each copy now goes to a new folder named with the time (numbered when two are made in one
  minute), never into one that exists, and is checked before "Done": anything under its `app\data` or `app\uploads` but
  the empty folders and `.gitkeep`, and the copy is deleted instead.
- A proposal to the show desk stays with the hall it was asked from. A page that joined another hall before the desk
  answered had the proposal's waiting line, and the desk's later outcome, put in the hall it had moved to.
- A line sent to the speaker's screen stays with the hall it was sent from, likewise: its line in the hall, its row and
  the acknowledgement it follows. A page that joined another hall before Stagewatch answered had them put in the hall it
  had moved to.
- A line for the speaker's screen whose 500th UTF-16 unit was the first half of an emoji, or that held half an emoji
  anywhere, was never sent: making its address threw outside the send's own error handling, and the page read "That
  request could not be handled." It is now cut before the emoji and sent, and the address is made inside that handling.
- Send now refuses an urgency Stagewatch does not have ("Unknown urgency."), as a proposal does; 0.5.1 sent the line as
  info. Stagewatch's other words for one (`urgent`, `warning`) are taken for theirs, as a proposal takes them.
- A hall closed while Stagewatch answered a send, or its desk a proposal, keeps nothing of it. The line was written into
  the closed hall's folder again, a stray log holding its words after the hall and its files had gone. Each is still
  its audit row: it reached Stagewatch.
- A new hall's name is cleaned as every typed name is, from the admin page and over HTTP alike: control characters and
  the bidi overrides and isolates that make a name read other than it is are dropped. 0.5.1 only trimmed it and cut it
  at 80 characters, so such a name reached every page, screen, the halls board and the audit log as typed (renaming a
  hall already cleaned it).
- The Stagewatch link never asks Stagewatch again before its Retry-After is over. A timer starts from the event loop's
  cached clock, so the wait could end a millisecond early and the key's verdict was asked for again a moment too soon
  (Stagewatch then said "wait" again). The hold is read again when the timer fires. CI found it on Node 26, where the
  test that holds the 2 s Retry-After measured 1999 ms; with the hold read again it can no longer come short.
- A test of the audit export's verifier no longer fails about one run in eight. To show that a changed `SHA256SUMS`
  fails its signature it changed one digit of a digest, and when that digit was `a` or `f` the result was no hex digit
  at all, so the verifier refused the line's shape before it reached the signature; the digit is now changed to another
  hex digit. Nothing that ships changed.

## 0.5.1 — 2026-10-26 — the show desk and the Stagewatch link, as Stagewatch states them

From the cross-app review of the Show Bus (the four items it left for after 0.5.0), each read against Stagewatch's own
code (2.16 and its newest work) before it was changed; then two rounds of independent review of the changes, whose
upheld findings are fixed below (docs/ANALYSIS.md §6).

**The show desk**
- A proposal's outcome is read as Stagewatch states it: `ok` and `words` at the top level, `result` a string. 0.5.0
  looked for `ok` inside an object `result` that Stagewatch never sends, so every outcome read as unknown (the page's
  "done" or "failed" came from the state alone), and a result object would have been read as success whatever it said.
  A settled state without its boolean `ok`, or a state AGMessage does not know, is shown as unknown (never done, never
  waiting) and asked again. Only a proposal the desk lists as approved for this AGMessage is run. "Not delivered" shows
  Stagewatch's own words.
- What an approved notice did is reported until Stagewatch takes it or refuses it for good. 0.5.0 counted any 4xx as
  taken (a 429 at the key's 600-a-minute budget, a 401 in Stagewatch's lockout minute, a 403 for a re-entered key) and
  kept waiting results only in memory, so a notice shown in every meeting could end "undelivered: AGMessage didn't
  report back" at the desk. Now a 429 (or a 503 with Retry-After) leaves the whole link alone for its Retry-After (1 to
  120 s; the context loop too), 401 and 403 wait a minute for the key, no answer or a 5xx backs off from 3 s to a minute,
  and 409, 404 and other 4xx are final. A waiting result is saved (`desk-results.json`, at most 200, flushed before its
  first post) and outlives a restart of AGMessage, a hall's link made again and a refused key; after its first post it
  is posted only once the desk's proposal reads back with the same line, target and time and still waits (a late one
  after Stagewatch's five minutes included), so a restarted Stagewatch's p1 never gets another proposal's result, which
  0.5.0 could do when the restart went unseen. Each result that ends untaken, or is taken only after a retry, is said in
  the recent events (no notice text, no ids), and the admin page's health line counts what is waiting. Whether
  Stagewatch keeps a desk changes only on its verdict (200, or 404/405): a 429 or no answer to that check no longer hides
  the desk for a minute, in which what it approved would have expired uncollected. Our own proposals are followed with
  one read a tick of all this AGMessage proposed (0.5.0 read each, so forty open ones spent the key's 600 a minute and a
  send to the stage came back 429); a collect answered after the link was pointed elsewhere is reported to nobody,
  never to the new Stagewatch's proposal of the same number; and a collect the desk refuses (the key speaks for another
  node) is said on the admin page, the Set up and the recent events, with proposals off until one is taken.

**The Stagewatch link**
- The link dials Stagewatch as this AGMessage, by its Show Bus id (`/ws?node=<id>&t=messenger&cid=<id>`), not as
  "agmessage": two AGMessages on one Stagewatch are two of its screens, each found and named on its own, and a
  Disconnect in Stagewatch → Screens drops only that one (0.5.0's shared name made them one row, the oldest one's
  address, a name given to it applied to all of them, and disconnecting one dropped every one). The link still dials
  again after a Disconnect, as after any drop: it does not yet stay off as a browser screen does. A name given in
  Stagewatch → Screens to the old shared "agmessage" row does not carry over: name each AGMessage once. Stagewatch 2.18
  needs this address to say whether it accepted the key.
- The link is "connected", and a certificate used for the first time is pinned, only once Stagewatch accepted the key:
  2.18's first message on the socket (`{"type":"auth","ok":true}`), or for 2.16, which says nothing of the key on the
  socket and sends its public frames to any key, a 200 to one authenticated read (its context). Each new socket earns its
  own verdict. Until then the link reads "checking key" (amber; nothing is sent, the screens show `--:--`); a link with
  no key reads "viewing" (the public timer, nothing sent, nothing pinned). A wrong or revoked key, or one Stagewatch stops
  listing while linked (its next 401), reads "key refused: <Stagewatch's words>" on the admin page, the hall's Set up,
  the halls board (✕), the screens (`--:--`), the context (red) and the AI's brief; sends and proposals are refused
  before they are tried and 🖥 is withdrawn; the socket is let go and the key asked again only after 61 s. 0.5.0 called a
  wrong key connected and pinned the certificate from the first frame, kept every gate open, and asked again about 1.4
  times a second, which locked this machine's address out of Stagewatch (5 wrong keys a minute) for every hall's link.
  A refusal or an acceptance is one `stagewatch.key` audit row per change, never the key. The links of one AGMessage
  share Stagewatch's lockout minute: every wrong attempt is counted (each 401, however many were on their way when a key
  was revoked), by the Stagewatch's resolved address and on a monotonic clock, and a refused key is asked again only while
  that leaves at most four wrong a minute in all; a fingerprint edited for a refused key does not ask it again early.
  A read-only (or MCP) key, which reads its verdict but can never act as a node, is refused in Stagewatch's words at
  its first node request; a changed certificate reads as itself on the halls board and the hall's send dialog, and
  accepting the default Stagewatch's is audited. Nothing authenticated goes while the key is not accepted but the
  verdict's own read, an answer that
  comes after a refusal is not shown, and a new key shows "connecting", never the last key's "connected" and timer.

## 0.5.0 — 2026-10-24 — halls, accounts, screens and the testing environment

For a venue with several halls at once (the ICC in Birmingham, say): each hall its own message room and its own
Stagewatch, crews with their own logins, project managers seeing every hall, screens driven from the operating room.

**Accounts beside the codes**
- Individual sign-in (username and password) for crew, project managers and admins; presenters and guests still join
  a hall with its 6-character code. Roles: admin, project manager, senior tech (every hall), tech, staff, viewer (their
  halls); an admin grants or removes single rights per person and picks their halls (Accounts page).
- Passwords: scrypt (N=2^15, r=8, p=3), NIST 800-63B policy, one-time passwords for new people changed at first
  sign-in. Sessions: HttpOnly, SameSite=Strict, Secure over HTTPS, stored only as hashes, 14 h idle / 7 days, ended at
  once by a password change, turning an account off or "sign out everywhere" — open pages reconnect with the rights the
  account has now. Admin rights do not sign in through the tunnel unless the admin allows it.
- A hash-chained audit log of sign-ins, rights, halls, screens, sends to Stagewatch and commands to other show
  systems; the Accounts page checks its chain. Never a password, token, key or screen link.
- A code guest cannot take the name of someone with an account; account messages carry a ✓ mark.

**Halls**
- Each hall may follow its own Stagewatch (Set up on the halls board; Stagewatches heard on the network are offered);
  the default one serves the rest. Countdowns, sends, acknowledgements and proposals stay in their own hall.
- The halls board: every hall an account may see — its countdown, who is in, the last message, open help, its
  screens and its linked Patterns / PlayMap — live.
- Help requests: Sound, Vision, Lighting, Stage, Presenter, IT / network or Other, with a few words; red until someone
  is "On my way", on the board until "Resolved", from the hall or the board.

**Screens (display URLs)**
- Every hall can have screens, each with its own unguessable link (`/d/…`) to open in any browser: holding image,
  a message (note / soon / urgent, in a shape and a band), an image or a PDF page from the hall, the hall's countdown
  with a message strip under it (the speaker's comfort monitor), the clock, or black; identify flashes its name.
- A screen confirms what it showed: ✓ on screen, … sending, △ couldn't, ✕ offline. A link can be replaced at once.
- From the hall: Screens (tick screens, then take), and ⧉ on any message or image/PDF to show it on screens.

**Show network (Show Bus 1.2)**
- Send to Stagewatch with a destination: the speaker's screen under the countdown (sent now or asked of the
  operator), the moderator / backstage / interpreter screens, a department, or only the operator — the show caller
  approves it in Stagewatch's Copilot.
- Fixed: 0.4 proposed `message "…" <urgency> ack`, which Stagewatch refused ("flash must be off|slow|fast"); the line
  is now `… <urgency> off ack`, and every line is held to a port of Stagewatch's own parser.
- PlayMap's hellos are heard (they were dropped). Patterns and PlayMap can be linked with their own tokens: their
  light, headline and attention items on the halls board and in the AI's brief; their listed verbs proposed to the
  show desk with the node's own risk, where a person approves them and the node collects them with its own key.
- A linked node's pairing token is full control of it, so it goes only to this laptop, or over HTTPS to a certificate
  that is pinned or that a person confirmed by typing the first 16 or more characters of the fingerprint the node shows
  on its own screen (when linking, or with Confirm certificate on the admin page). A node on another machine with no
  HTTPS, or whose certificate nobody confirmed, shows red with the reason and is sent nothing. A node's hello (anyone
  can send one), and a certificate the Stagewatch link trusted on first use, confirm nothing; no page shows a fingerprint
  to copy; a node on this laptop heard from its network address is linked on the laptop itself. AGMessage never drives
  a node directly with that token: driving it waits for a key the node issues to AGMessage alone (Patterns' `ptk_`,
  PlayMap's `pmk_`). Found by a review of the Show Bus across the four apps (AG-1, units 21 and 21.1).

**Versions** — one scheme for every build (`app/lib/version.js`): `package.json` names the version; CI stamps the build
number and commit (`tools/stamp-build.js`). A release reads `0.5.0+17.abc1234`, a CI development build
`0.5.0-dev.17+abc1234`, a local copy `0.5.0-dev+abc1234`. The console banner, `/api/health` (`build`), the admin page
and the Show Bus hello (`build`) say it; the portable zip is named by it; a release tag that names another version is
refused.

**Runtime** — Node.js 24.22.1 LTS (pinned by SHA-256; CI also runs Node 26, LTS from 2026-10-28), Express 5.3,
multer 2.5, socket.io 4.8.4, ws 8.22, Anthropic SDK 1.3 (API version 2026-10-21, Apache 2.0; drafts opt into the
server-side refusal fallback); nanoid replaced by `node:crypto`.

**The testing environment** (`docs/ANALYSIS.md`, `SECURITY.md`) — ESLint 10 with the security rules, a banned-call
list and a house rule that refuses unescaped values on their way into a page's HTML, as build fences; an in-tree
secret scan; a coverage gate; the browser smoke on Linux (Chrome) and Windows (Edge); CodeQL, `npm audit` with registry
signatures, dependency review and Dependabot; releases with a CycloneDX SBOM, SHA256SUMS and build provenance. The
fences found and fixed six unescaped values, a pattern-built cookie reader, names stripped of C0 controls only (now
also C1 and bidi overrides) and a predictable jitter.

**Found by independent reviews before release, and fixed** (`docs/ANALYSIS.md` §6: 59 findings confirmed by a second
reader, then 19 more when the fixes were read together — every one fixed or answered; units 9 to 19)
- *Nothing a client sends stops the event.* A socket that never signed in could end the process with `null` or an
  object `String()` cannot convert (0.4's handlers had the same shape); every event now reaches its handler through one
  guard, and client values are read by their type. A fence sends every event every shape.
- *Rights.* The first admin is made only from the laptop itself (a page under another name that leads back to it is
  refused). Only an admin changes an account that manages accounts or settings, and a non-admin with `users.manage`
  hands out nothing past its own rights and halls. Forwarding is judged by the person's rights in the hall it lands in;
  read-only members no longer pin, react or answer action prompts; a node linked for every hall is driven only by those
  with `nodes.control` in every hall; a hall's commands are proposed only to its own Stagewatch's desk.
- *Who is told what.* A hall's join code reaches only those who may open it (not a one-hall manager's Accounts page,
  not a screen, not everyone in a hall the admin linked one guest from); a hall's AI brief and the context posted to
  its Stagewatch carry its own halls' facts and events, never another hall's; pages offer no button the server would
  refuse (Show network, send to stage, an untouched Save of one's own account).
- *Sessions.* Signing out, a session that ends and "admin rights only on the venue network" now reach open pages, not
  only the next sign-in. A page in use keeps its session past 14 hours idle; seven days still ends it. An account keeps
  its 20 newest sessions. The admin token's sign-in survives a watchdog restart and ends after a day.
- *Sign-in.* A stranger's wrong passwords no longer lock the laptop or the venue network out of an account; a refusal
  never says a password was right; a password typed into the username box is never written to the audit log; a flood
  of guesses through the tunnel cannot hold sign-ins on the venue network. Two quick clicks make one account, not two.
- *Screens.* A take reaches every ticked screen as one request (a 16-screen "Black" was partly refused); with two
  browsers on one link the console says what each shows; an older slide that loads late never paints over a newer one;
  a deck stepped through keeps one pdf.js worker; the clock shows AGMessage's time zone; the message under the countdown
  never covers it on an upright tablet.
- *The show network.* Each Stagewatch gets only the context of its own halls; a pinned node is never spoken to over
  plain HTTP again, and a changed certificate can be accepted; Stagewatch's and our numbers never cross after a restart
  or a relink; a silent Stagewatch is redialled after 12 s as documented; PlayMap's own rules rate a line before it
  reaches the show desk (high until they are read); a command's secret is never written to the audit log; the discovery table is bounded.
- *Data.* On Windows, Ctrl+C, closing the console window and the watchdog's own stop now let the server save first:
  a signal sent to a child process there ends it at once, so the last half-second of saves and any audit entries still
  waiting were lost (CI's Windows job found it). The stop is asked over IPC. A server whose watchdog has gone saves and
  leaves; on Windows, Windows ends it with the watchdog — either way no copy is left holding the folder. A locked
  hall's seats survive the watchdog's restart; a stage send whose Stagewatch restarted reads "lost", never "sent"
  waiting for an acknowledgement that cannot come. A second copy on the same data folder is refused before it writes
  anything (it used to rewrite the running copy's rooms); a save the disk cuts short fails and is retried instead of replacing a whole file; the audit check reads
  every rotated file as one chain, off the event loop; uploads stop before the disk fills, and files nobody posted are
  removed.

Tests: 237 (was 53) plus the browser smoke (61 checks, was 7).

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
