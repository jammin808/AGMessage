# Changelog

## 0.6.0 — 2026-10-31 — rooms within halls, people's screens and the Board's view (in progress)

Built from `docs/plan/0.6.0/PLAN.md`, one commit per unit in its global build order. This entry grows with each unit
and is dated again when 0.6.0 closes.

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
  together share one walk, which turns the event loop every 1,000 entries (a 49,999-entry archive, checked while a page
  asks, holds it at most 300 ms, a test). A byte changed in place is found there and by every export, which hash each
  archive file in full; the routine check sees a file's size, not its bytes.
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
  a screen reader while it is open, and the focus back on what opened it when it closes, however it closes. A browser
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
  its name makes the hall and closes it; `AGM.idle` runs on its timer and `AGM.awake` says the settings words; the hall
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
  ask ("That message is gone.", "That screen is gone."). The feed does not move while a menu or an ask is open. The ⋯
  opens its menu and closes it again. An ask opened by a key gives the focus back to the message the key was pressed
  on; a menu says what it acts on to a screen reader ("Message actions: Message from Kim · 14:02").
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

**Fixed**
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
