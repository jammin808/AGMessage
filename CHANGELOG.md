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
  guest's hall page refused this way opens that code link, keeping the code and an invite's role. A one-time password
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
  takes and why; `apply()`'s `message` or `system`, by the added message's kind, is the one row. `linkedRoomsChanged`,
  which the server sends a guest's pages when the admin lets them forward into another hall and no page hears yet, is
  allowed by a row that says so, and the fence fails on that row once a page hears it or the server stops sending it. A
  page that names an event by an expression fails it too, unless a row names the events it carries and why (none does
  today; the outbox and the op table's listeners will each be one).
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

**Fixed**
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
