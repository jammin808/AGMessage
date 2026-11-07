# AGMessage installed on a Windows PC

*Begun with 0.6.0's start window; the installer's units (`docs/plan/0.6.0/PLAN.md` Part 6, U.9) write the rest of this
paper. The installer (`installer/AGMessage.iss`, The installer below) is built by CI from the portable zip, and imports a
portable folder before the installed node's first start (The import of a portable folder, below); an upgrade with no
administrator is a later unit's, and its life cycle in CI (install, upgrade, the way back, uninstall, run for real) is the
installer job's still to come. Venue laptops run the portable folder
([README.txt](../README.txt)).*

## It opens no browser and has no window

The installed node is a startup task in Windows' session 0: it starts with Windows, with nobody signed in, and nothing
it opens or draws there is seen by the person at the screen ("Services cannot directly interact with a user as of
Windows Vista", https://learn.microsoft.com/en-us/windows/win32/services/interactive-services).

- **No browser.** The server opens one only in the portable channel (`AGM_RUNS` unset or `portable`, `lib/startup.js`),
  when the .bat asks (`AGM_OPEN=1`). The installed node's channel is `task`: it never opens one, whatever `AGM_OPEN`
  holds.
- **No window.** What a portable copy says in its window, the installed node says on its console, which its watchdog
  keeps in `logs\server.log`, its logs folder beside `data\` (What it says, kept, below). The admin page's "This laptop" says what it knows and
  what Windows says; Open AGMessage and AGMessage status in the Start menu show the log's tail (The installer, below).

## What it says, kept, and "This laptop"

- **`server.log`** (`supervise.js`, `lib/serverlog.js`), in the installed node's logs folder (`%ProgramData%\AGMessage\logs`,
  which `launch.js serve` names in `AGM_LOG_DIR` and the watchdog's start checks as it checks the other folders), so a
  refusal said before the data folder may be written in still reaches it; a portable copy's is `data\logs\server.log`.
  The watchdog reads its server's output through a
  pipe, says each line on its own console, and appends it, with its time, to the log, with its own lines, and no blank
  line. Past 2 MB the file becomes `server.1.log`, replacing the one before, so the folder holds about 4 MB of it at
  most. A held port's tries (2,880 a day at the ladder's last step) were measured at 139 bytes each, the server's words
  and the watchdog's line only where `watchdog.log` takes it: about 390 KB a day, some ten days in the two files. It never
  holds the admin token: the Token line goes to the console alone, and every line is searched for the token by value,
  before a long line is cut. A log that cannot be written never stops the node, and a console nobody reads holds at
  most 1 MB waiting. The watchdog's line for a start the server refused carries the server's own words ("server stopped:
  cannot start as configured (code 3): …", "server could not take its port or data folder, which another program holds
  (code 75): Another program is using port 3023. …"), in `watchdog.log` too. A restart is handed the line for the run
  before it; a start refused as configured, which ends the watchdog, is recorded in `data\watchdog.json` (`refused:
  true`), where a give-up is, so the next start, whichever watchdog runs it, says it once on "This laptop" and in the
  admin page's health, and renames the file `watchdog.seen.json`. A portable copy's refusal is read in its window and
  records nothing.
- **"This laptop"** on the admin page, each fact with where it was read: the build and how it runs, the LAN addresses,
  HTTPS and why it is off, how many sealed values open (never which), the screens confirmed, the Stagewatch links, the
  internet link and its end, the last stop (saved, or not and why: A stop, and the start after it, below), before this
  start (the watchdog's line for the run it restarted, or its record of a refused start or a give-up), and what the start
  goes without. A read of them that fails (an adapter list the system refuses) is one row
  that says so; the rest of the admin page's answer is drawn. Windows' facts are read by one `powershell.exe`,
  `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` by that absolute path, run from System32 with a fixed
  script (`lib/laptop.js` `SCRIPT`: one line, nothing from a page in it); once the server serves and again at Refresh,
  one read at a time, ended after 5 s or when the server stops. Its environment is named, never the server's:
  `SystemRoot`, Windows' folders and the machine's names (`PASSED`: `SystemDrive`, `windir`, `TEMP`, `TMP`,
  `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `ProgramData`, `ProgramFiles`, `COMPUTERNAME`, `NUMBER_OF_PROCESSORS`,
  `PROCESSOR_ARCHITECTURE`), `PSModulePath` set to `%SystemRoot%\System32\WindowsPowerShell\v1.0\Modules`, and
  `AGM_NODE`, this `node.exe`'s path; so no secret whatever the case of its name, no `PATH`, no module of the account's
  own. Each part is read on its own and said on a line of its own as soon as it is read (`{"v":1}` first), the cheap
  ones first and the firewall last, so a read ended at its time keeps what it said; a part Windows refuses says
  "unknown" with its reason: sleep and the lid on mains (`powercfg /query SCHEME_CURRENT`, `STANDBYIDLE` and
  `LIDACTION`, the AC index); the server task `\AGMessage\Server`, its state and last result (`Get-ScheduledTask`,
  `Get-ScheduledTaskInfo`); the install record, `HKLM\SOFTWARE\AGMessage`: `AdminName` (else `Admin`, its SID) and,
  under its `Grants` key, one value per account's SID holding its rights, comma-separated, each account's name looked
  up by Windows where it can (under Constrained Language Mode the SID is shown); the connected networks' profiles
  (`Get-NetConnectionProfile`); and whether an enabled inbound rule names this `node.exe` on each
  (read from the firewall's own object, `HNetCfg.FwPolicy2`: each rule's program, its environment variables expanded,
  compared with this `node.exe`'s path in any case; every rule judged, a block rule winning over an allow; past 512 the
  reach is unknown). It does not see a rule a domain's policy sets, a rule by port alone, or a profile whose firewall
  is off. Under Constrained Language Mode, which allows no COM object, the NetSecurity cmdlets are asked instead
  (`Get-NetFirewallApplicationFilter -Program`, in this PC's own policy store), and their `-Program` reads a path as a
  pattern, so there a folder whose name holds `[` or `]` matches no rule. Networks and rights past 32 are counted. Each
  module a part uses is imported by its manifest's path under `$PSHOME`, Windows' own, never found by name. Each line is
  ASCII JSON, any other character escaped, so no code page changes a name. None of it reaches health over HTTP, the context, the hello or the AI's brief. The Windows
  CI job runs the script at every push and checks its answer's shape (`test/laptop.test.js`: each part read, or refused
  with Windows' reason; the task and the record missing on a runner; the read's time said, and when each part's line
  came); what it reads on a show laptop is unread until a walk.
- **The install record's `Grants`** is this shape: a key `HKLM\SOFTWARE\AGMessage\Grants`, one `REG_SZ` value per
  account, named by its SID (`S-1-…`), holding its rights comma-separated (`start,stop`). The machine's commands that
  write the record and its grants (the plan's U12 and U17) write it so; "This laptop" reads no other shape.
- **The certificate at a boot start.** A certificate due for renewal (30 days or fewer to run) is renewed at start only
  while a network has given the laptop an address (an address an adapter gives itself, `169.254.x.x`, is none): one
  made before the network gives one would name no address devices reach it by, for its 825 days. It serves on, said in
  the log and on "This laptop" in words true when read: once the laptop has an address, New certificate on the admin
  page renews it, as does a start that has one. It is never renewed without a person, since every device that trusted
  the old one is asked again. Not measured: whether the task's boot start comes before the network on the show laptop;
  an adapter that is always up (a virtual switch, a VPN) gives an address devices may not reach the laptop by.

## The internet link, until its end

The installed node has no window for a person to close at the end of a show, so the internet link (the Cloudflare quick
tunnel the admin page turns on) is kept to an end instead. Turned on, it runs until the end of the show day, the next
06:00 by the laptop's clock (the next day's when that is under an hour away), or the time of day the card's Tunnel
until… gives; then it is turned off (within 5 s, read against the wall clock) and stays off. The end is kept in
`data\settings.json` until Turn off, so any start before it (the watchdog's restart, a crash, an upgrade, a boot under
the task) turns the link on again at the same end. A quick tunnel's address is new at every start: once cloudflared
gives it, the tunnel card says "New address" with the new one, "This laptop" says the link was turned on again as
AGMessage started, and the console says "[tunnel] on again until …", so the admin sends the new address to the remote
people. A start whose cloudflared cannot reach Cloudflare (a boot start before the network has an address) says "Not
turned on again" on the card, in "This laptop" and on the console, and keeps the end: Turn on, once the laptop is
online, starts the link again until that end, and so does the next start before it; nothing tries again by itself. A
cloudflared that ends of its own once it was on keeps the end too, and Turn off… keeps the link off. A start past the
end, or with an end no act could have set (a clock set back), leaves it off and says so. Turn off forgets the end at
once. On Windows a cloudflared ends with its server however the server ends, a hang kill included (libuv puts each child
Node starts in a job object that ends it with its parent: read in libuv's source, not measured here), so the address
before a restart stops working. For a show with remote people, a named Cloudflare Tunnel run beside AGMessage keeps one
address across restarts. Not measured: whether the task's boot start comes before the network on the show laptop.

## It loads only what it ships, and runs only what it names

The installed node's code sits under Program Files, where no other account can change it, but a module that
`app\node_modules` cannot answer is looked for in every folder above it up to the drive's root (`C:\node_modules`), and
reading R8 says whether a standard account may make that folder on the show laptop. The server asks for nothing there:
ws's native helpers are switched off by the server before its first `require` and by the watchdog for it
(`WS_NO_BUFFER_UTIL`, `WS_NO_UTF_8_VALIDATE`), and `supports-color`, which `debug` looks for, ships in
`app\node_modules`. It runs its own `bin\cloudflared.exe` beside `app`, and Windows' programs from a `SystemRoot` named
from its drive or the installer's `{sys}`, each by its absolute path; never a bare name, which Windows looks for in the
current folder (the task's working folder) and on `PATH` first. A node without its cloudflared has no internet link:
Turn on is refused with "cloudflared not found in this copy (bin\cloudflared.exe): repair AGMessage by running its
installer again. …" before anything runs or an end is kept (the portable copy's words say to re-extract the folder).
`docs/ANALYSIS.md` §3.7 has the fences that hold both.

## A port already in use

The installed node reads `http://127.0.0.1:<PORT>/api/health` once, within a second, sending no token. Only the
holder's version, build and channel choose the words, and nothing is decided on them:

- an AGMessage answers (another copy, since the installed node runs one instance): "Another copy of AGMessage, 0.6.0
  (build …), holds port 3023. Close its window: AGMessage takes the port back on its next try."
- anything else: "Another program is using port 3023. AGMessage tries again; AGMessage status names the program's
  process."

The copy then ends with code 75, and its watchdog tries again (below).

## How it starts, and when it does not

The channel is `AGM_RUNS=task`, which the task's launcher sets (`launch.js serve`, the installer's server task). The
watchdog and the server read it, and these rules, before either writes anything (`lib/startup.js` `channelOf`,
`supervise.js`, `server.js`):

- **Its folders.** `AGM_DATA_DIR`, `AGM_UPLOAD_DIR` and `AGM_KEY_DIR` are each set, a full path (from a drive, or a
  share), and outside the program's folder (the one that holds `app\` and `node\`), which an upgrade replaces; so is the
  watchdog's `AGM_TOKEN_DIR`, a folder of its own (The admin token, below). A folder
  that is not, or that cannot be made, ends the start with code 3 and words that name it; so does a rooms folder that is
  there but cannot be read. An `AGM_RUNS` that is neither `portable` nor `task` is refused the same way, in either
  channel.
- **Nothing before the hold.** The server writes nothing, in the data folder or the key folder, until the copy holds its
  data folder and its port: a copy refused at either has made no folder, key, certificate, secret or setting. Only its
  watchdog writes there first: the data folder itself, `watchdog.log`'s line for how the start ended, the console it
  keeps in `logs\server.log`, and, for a start refused as configured, its record in `watchdog.json`.
- **Its keys.** It never runs without them. A `machine.key`, `secret.key` or `tls.json` that cannot be read, a machine key
  missing while the data folder holds values sealed with one (or while `settings.json` or `displays.json`, which hold
  them, cannot be read, so none can be ruled out), or a sealed value that does not open with it ends the start with code
  3, before anything is made, and its words name the kinds of value (never one). Nothing is made over them. A
  certificate in date whose renewal fails is kept, said, and served, and the next start renews it. A `settings.json` that
  cannot be read is not code 3 (the node serves guests, screens and the token): nothing is saved over it, a setting
  changed is refused with why, and context reads are refused until it is read. A portable copy, by contrast, goes on
  without what it cannot read and says so (`README.txt`, Troubleshooting).
- **Held, and tried again.** Its port in use, or its data folder held (the hold's pipe, whose name anyone can take), ends
  the start with code 75 (`EXIT.HELD`). The watchdog starts it again on its ladder (0.5, 4, 8, 15, 30 s, the last
  repeating) for as long as that lasts, never counting it as a crash, so it never gives up for it. Each try is said on its
  console; `watchdog.log` takes the first of such a run and every hundredth after it, with its count, so a port held for
  days never grows it without bound. A portable copy ends with code 3 there, where a person reads why.
- **Once it serves.** An error on its port (EMFILE, out of file handles) loses that connection and is counted in health
  (`acceptErrors`); the node serves on. A port that stops listening is saved and ended as a crash (70), which the
  watchdog starts again.
- **Codes the task reads** (from the watchdog, which ends only with these): 0 stopped, 3 cannot start as configured or
  gave up; anything else is a crash of the watchdog itself. What the task does with each (stays stopped on 0 and 3) is
  the installer's units', with the log that keeps these words.

## A stop, and the start after it

- **A stop saves, then says so.** A stop (the watchdog's, Ctrl+C, the console closed, or this PC's own stop at
  loopback with a proof of the token, below) saves the audit log's waiting entries and the head that covers them first, then
  every store's write lane, then each hall that changed since its last snapshot, and no other (`server.js` `saveAll`,
  `lib/store.js` `compactDirty`), then the day's peaks once more when those snapshots raised its longest. A hall that did
  not change is never rewritten, at a stop or a start: the plan's bench (not the show laptop) measured the rewrite of
  every hall at 1.2 s at 200,000 messages and 5.8 s at 1,000,000, and at 1,000,000 the watchdog's 4 s wait ended every
  stop inside it, before the lanes were saved. Then it writes `data\last-stop.json` last, `{at, build, saved}`, `saved`
  true only when every one of them was written; when one was not, the record says which (`unsaved`: a store's name, "the
  audit log", a count of halls, never a hall's code), and the console says "Not saved: …".
- **The start after it.** Once it holds the folder, the start reads the record and moves it aside to
  `last-stop.seen.json`, so a crash or a kill of this start is never read as the stop before it. Where it can be neither
  moved nor removed (another program holds it), it is said on the console, in health's `lastStop.left` and on Last stop,
  and kept as the one seen too, so the next start reads it as taken. A record that says it saved is then read against
  the folder: a stop that saved leaves every hall's log empty and no snapshot newer than itself, so a log with lines, or a
  newer snapshot, means a copy ran on the folder after that stop (0.5.1 rolled back to, which keeps no record and writes
  every hall at its start, then a crash or a kill), and the record is stale. The start writes only the halls that hold
  what their snapshot does not (a log a crash left, a snapshot it found torn), and writes "— AGMessage restarted · N
  messages kept —" into each hall only after a stop that did not save: no record (a crash, the watchdog's kill of a
  hang, Windows ending the task at a shutdown or a restart, which is the installed node's unsaved end, lab 5; a power
  cut; a folder 0.5 last ran, which kept none), one that could not be read, one that says it did not save, or one that
  is stale. Health's `lastStop` and "This laptop"'s Last stop say which it was, and how many halls were told. A temporary
  file of a save a stop cut short (`<file>.<pid>.tmp`, in `data\` and `data\rooms\`) whose process has ended is removed
  then too; a copy refused at the lock reads and removes nothing.

## The busy line, and the stop at loopback

Both channels (the plan's Part 6, unit U8, with the owner's answer 39, "busy as proposed, and a busy server stopped only
with a typed reason"). The machine's commands ask it: the installer's checks and the upgrade's stop, and Stop
AGMessage… (a control task, below); Go back is a later unit's. Each is tested here against the server and against
programs that are not it.

- **The busy line** (`lib/busy.js`) is one line of counts, and nothing else: no name, code, token or path. `active`, the
  pages active in the last 10 minutes, a page being a person in a room (the room's key, a hall's code for its Main room,
  and the uid its join gave them, so the same person back on a new socket is the same page): one whose seat gave input (an answer, a reaction, a take, a
  help request, an ask of the AI: a verb of `busy.INPUT`, heard before its handler runs, so one refused counts too), or
  whose message the room holds from the window, a hall's side room's too, whoever sent it (a seat, the admin's support view, the minutes, a show
  system) and whether or not the server restarted since, the system's own lines never; `takes`, the screens whose take
  changed in them (`takenAt`, kept in `displays.json`); `help`, the help requests raised in them; `countdowns`, the
  Stagewatch countdowns running now (as the power request reads them); `seats`, the pages seated now that are not
  active; `screens`, the screens a browser holds now; `sockets`, every socket open. **Busy** is activity, not presence:
  a message or other input, a take or a help request in the last 10 minutes, or a countdown running. A full hall that
  only reads, and screens that hold their take, are not busy. A page counts from its newest input or message for 10
  minutes, open or closed since; input that left no message (a reaction, a pin) is held in memory, at most 10,000 pages,
  the oldest let go first, and a restart forgets it, while messages, takes and help requests are kept across it.
- **At loopback, for the machine** (`lib/machinewire.js`; answered only on this PC, `guard.isHostMachine`; never to a
  browser, a request with an Origin or a Sec-Fetch-* header, which the machine never sends; and only while the admin
  token is 16 characters or more, since a hello lets any program on this PC test guesses at the token offline: a shorter
  one, which only `ADMIN_TOKEN` can give, is refused on every route with why):
  - `GET /api/machine/hello?c=<challenge>` answers a fresh nonce, the build, and the server's proof that it holds the
    token: HMAC-SHA256 under the token over `"agmessage machine server\n"`, the nonce and the machine's challenge.
  - `GET /api/machine/busy`, `POST /api/machine/stop {reason, by, force}` and `POST /api/machine/events` (no body) each
    carry the nonce (`X-AGM-Nonce`) and the machine's proof (`X-AGM-Proof`): HMAC-SHA256 under the token over
    `"agmessage machine\n"`, the nonce, the method, the path and the body's SHA-256, a line each. A nonce is good for one
    request within 30 s of its hello; a request with no proof, or a nonce not issued, used or older, is refused (a
    nonce's refusal says `again`, and the machine asks once more from a fresh hello, never a third time); a proof that
    does not match is refused, written as a wrong token is (`login.token.fail`) and counted toward the token's lockout
    (five a minute). The machine holds the token as the server does: lower case, its line's end trimmed.
  - **The token never crosses the socket.** The machine asks for a hello and checks the server's proof before it sends
    anything else: a program that took the port during a restart is sent nothing after the hello, learns nothing, and
    stops nothing. A hello it read earlier and gives back proves nothing, since the machine's challenge is new each time.
  - **A server that does not answer within 5 s reads as busy**; so does one that does not prove it, or answers no line.
    The 5 s are the whole answer's, from the request to its last byte: a program that answers a byte at a time reads
    busy at 5 s too. Nothing listening is not busy: nothing runs.
  - The machine reads the token from `token\admin-token`, which the watchdog writes (above).
  - The machine's half is built and tested here (`hello`, `ask`, `busy`, `stop`, `nudge` in `lib/machinewire.js`, which
    reading R1 drives). The machine's own commands (`machine.js`, the installed node's unit, U12) require Node's built-ins
    only, so they carry their own copy of that half, held to the same vectors as `test/busy.test.js`'s (the two proofs'
    words, the nonce's and challenge's shapes, the stop's body).
- **The stop** (`reason` one of `stop`, `upgrade`, `back`; `by`, who asked; `force`, the reason a person typed) saves as
  every stop does (above), and ends with code 0, which the watchdog and the task read as stopped. A busy server is not
  stopped without a typed reason: it answers "Not stopped: AGMessage is busy (3 pages active, a countdown running). Type
  a reason to stop it anyway.", and with one it stops and writes `server.stop.forced` (who asked, why, what was live, the
  words typed). Its window and `server.log` say "Stopping for an upgrade, asked at loopback by LAPTOP\ana". A stop
  asked while one is under way is answered with what is being done (`already`) and says and writes nothing more. The
  machine event naming who asked (`machine.stop`) is appended by the control task that asked (below), and the nudge reads
  the machine's events into the audit log, answering how many rows it wrote; a portable copy keeps none, and says so.
- **On the data folder's pipe**, once it serves, the copy that holds the folder answers whoever connects with the busy
  line and ends the connection: a read, never a command (nothing machine-level writes the pipe). A pipe's default access
  lets Everyone and the anonymous account read it (reading R7), and whatever took its name first answers in its place,
  so the line read there chooses words and nothing else. A second copy refused at the folder says what it read: "It
  says it is busy: 1 page active, a countdown running." or "It says it is idle: nothing in the last 10 minutes; 4 seats
  and 2 screens open." A copy refused at the port alone cannot name that pipe (it is named after the other copy's
  folder), so the port's words stay as they are.

## Sleep, the power request and the lid

Both channels (the plan's Part 6, unit U9). Nothing here has been measured on a laptop that sleeps: the proxies are
Linux processes frozen and thawed, and lab 1 is the show laptop's.

- **A sleep is not a hang** (`supervise.js`, `lib/resilience.js` `BeatClock`). The watchdog ticks every half second and
  measures its server's silence on a steady clock (`performance.now()`, which a change to the laptop's clock does not
  move). A tick that comes more than 2 s late, on that clock or on the wall clock, means the watchdog did not run either
  (the laptop slept, or a standby froze or throttled both processes), so it judges nothing of that gap: the beat clock
  starts again at that tick, and a sleep is never counted as a crash. A hang is the watchdog ticking on time with no
  beat from its server for 10 s, which is still killed and restarted. So a wake no longer kills the server unsaved, and
  a node throttled in Modern Standby ("no more than one second of activity every 30 seconds",
  https://learn.microsoft.com/en-us/windows-hardware/design/device-experiences/prepare-software-for-modern-standby) no
  longer gives up and stays down. Either clock, because a steady clock may stop while the machine sleeps (Linux's
  monotonic clock does; whether Windows' does is lab 1's to read) and would then see no gap, while the wall clock does.
  What the rule cannot tell apart from a sleep, and records as one:
  - a step of the laptop's clock forward by more than 2 s (a person setting it, a time sync's jump): the beat clock
    starts again once, and the step is recorded as a sleep; a clock set back is no sleep and hides no hang;
  - the watchdog itself held from running for more than 2.5 s while the laptop was awake (a machine starved of memory
    and swapping, a disk that held its write to `watchdog.log` or `server.log`): it judges nothing of that gap either,
    so while it keeps being held that long, a server that hangs meanwhile is not killed until the watchdog runs on
    time for 10 s.
- **The sleeps recorded.** Once the watchdog has ticked on time for 10 s after one, "asleep from 2026-11-02 14:02:03 to
  14:20:11 UTC (18 min 8 s)" goes to its console, `data\watchdog.log` and `server.log`; gaps with it awake
  less than that between (a throttled standby) are one sleep, with how many times it went. A sleep the watchdog is
  stopped in before then is said as it stops. The server is told each (one the watchdog stops in, ahead of the stop, so
  the stop saves it) and keeps it with the show day's peaks (`peaks.json`: each day's count and longest, and the newest
  20 whole), so a restart keeps them: health's `sleeps`, the admin page's peaks and "This laptop"'s Sleeps row.
- **The power request** (`lib/power.js`). While a hall is live, the server holds a power request. A hall is live while
  it has an open page seated in any of its rooms, idle or not (a Board reading quietly through a long session is a live show, so a
  page left open in a hall holds the request until it is closed: "This laptop" says what makes the halls live, "2 pages
  open, 1 screen showing"); a screen on which a browser confirmed a take other than holding (another browser on the same
  link that could not show it takes nothing from it); or its Stagewatch countdown counting, as Stagewatch says now (a
  link connected, its frame not gone quiet): running, or past zero and counting on into overtime, never held at zero.
  The default Stagewatch, which every hall without its own follows, is one countdown: it makes one hall live, never
  each. The request is held through one `powershell.exe`, by its absolute path under `SystemRoot`, from System32, in the
  same named environment "This laptop"'s read has (`lib/laptop.js` `powershellPlan`), with a fixed script of one line:
  it declares `SetThreadExecutionState` with `Add-Type`, calls it with `ES_CONTINUOUS | ES_SYSTEM_REQUIRED` and waits on
  its standard input. `Add-Type` compiles that one-line declaration with the .NET Framework's compiler: Windows
  PowerShell 5.1 runs `csc.exe` (the .NET Framework's, under `%SystemRoot%\Microsoft.NET`) as a child of its own on
  files it writes in the `TEMP` folder the server passes, loads the library it built and removes them, so an AppLocker
  or WDAC policy that governs those sees the compiler and the temporary library too. The request ends when no hall is
  live (the server closes that input and ends the child) and with the server, however it ends (its input closes; on
  Windows the job libuv puts every child in ends it too). It reads "held" only when the call returned non-zero. Under
  Constrained Language Mode (an AppLocker or WDAC policy), where `Add-Type` is refused, it says so and asks nothing, and
  is asked again only once no hall is live and one is again: nothing about it changes while the halls stay live. A
  failure (the call returned 0, `powershell.exe` could not be run, did not answer within 30 s, or ended while the
  request was wanted) is asked again a minute after while a hall stays live, never sooner; a failure in the same words
  as the one before it is said once. Each is said on the console ("[power] …") and on "This laptop". A child is started
  at each change from no hall live to one live, which the board's frame and the 5 s window read; what each start costs
  on the show laptop (a start of PowerShell and its compile) is not measured, and no hold-off is put on it until it is.
  Health's `power` and "This laptop"'s Kept awake row say its state.
- **What it keeps off, and what it does not.** "Held" is what Windows answered, never more: it took the request to keep
  off idle sleep. "Power requests will block the NoCS phase indefinitely on AC power, and for up to 5 minutes on DC
  power" (the Modern Standby page above), so on battery a laptop with Modern Standby only delays its idle-out, and "This
  laptop" says so beside "held". And "the SetThreadExecutionState function cannot be used to prevent the user from
  putting the computer to sleep. Applications should respect that the user expects a certain behavior when they close
  the lid on their laptop or press the power button"
  (https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-setthreadexecutionstate): the lid and the
  power button stay the power plan's. Before doors, on mains, "This laptop" should read Lid closed on mains: do nothing,
  and Kept awake: held, once a hall is live; and no Windows restart should be pending (Stop AGMessage first if one must
  happen).
- **Lab 1** (lid closed and idle-out, on mains and on battery, with and without the power request: serving after,
  sleeps recorded, no kill) is the show laptop's, and reads "not run" until it is taken there.

## The admin token

The installed node has no window to print its token in, and its output is kept (the installer's units keep it in a
log), so the token is never in it (`supervise.js`, `lib/startup.js` `taskTokenProblem`, `tokenLine`):

- **Its own token, never from the environment.** The watchdog makes the token at each start. An `ADMIN_TOKEN` or
  `ANTHROPIC_API_KEY` in the installed node's environment ends the start with code 3 ("ADMIN_TOKEN is set in the
  installed node's environment, where every account that may read its task reads it too. …"), its words never holding
  the value: a scheduled task's definition can be read by every account allowed to read that task. The AI key is added
  on the admin page, sealed with the machine key.
- **A token folder of its own.** `AGM_TOKEN_DIR` (the installer's `%ProgramData%\AGMessage\token`) is set, a full path,
  outside the program's folder, and neither the data, uploads or key folder, inside one of them, nor holding one: whoever
  is given the token reads that folder and nothing else of the node. Else code 3 and why, before anything is written. The
  node never makes the folder; its access list is the installer's (SYSTEM and Administrators full control, the server's
  task may modify, since the token is replaced by a rename, which needs delete; this PC's AGMessage admin and the
  accounts it gives `token` may read; `machine.js prepare` and `install`, below).
- **Written once it serves.** The watchdog writes the token into `admin-token` there when its server holds its folder and
  its port and asks for its banner's Token line, and at each restart after, the same token: a copy whose port or folder
  is held never writes over the token of the copy that serves. It is written whole, a temporary file in the token folder
  renamed over the old one (`lib/resilience.js` `writeFileAtomic`, which here never makes the folder), so a reader finds
  the old token or the new one, never a file cut short. The Token line says "not shown here. It is in
  C:\ProgramData\AGMessage\token\admin-token, which this PC's AGMessage admin reads (Start → AGMessage → Show the admin
  token)." A token that cannot be written leaves the node serving without it, said on its console and in `watchdog.log`.
  A new start makes a new token, and the file then holds it; the file left by a node that has stopped holds a token
  nothing answers to.
- **Show the admin token.** `node.exe app\launch.js token --machine C:\ProgramData\AGMessage --sys C:\Windows\System32`,
  run as the person and never elevated (the Start menu's item, which the installer adds, passing its `{commonappdata}`
  and `{sys}`: `launch.js` reads no machine path from its environment), prints the token in that person's console, with
  "It holds while AGMessage serves; each start makes a new one", or says "This PC's AGMessage admin has not given you the
  token: ask LAPTOP\ana" when their account may not read it (the name is the install record's `AdminName`, read with
  `reg.exe` by its absolute path in the `--sys` folder, run from there; without `--sys` the words name no one),
  "AGMessage has no admin token on this PC yet: …" before the node has served, and never what a file that holds no token
  holds. It exits 0 when it printed the token, 2 when it did not, and 64 for a word it does not know. The source fence
  that holds every program `app/` runs to its absolute path (`test/loads.test.js`, `docs/ANALYSIS.md` §3.7) holds this
  `reg.exe` (`path.win32.join(sys, 'reg.exe')`, run only for a `--sys` named from its drive), `launch.js status`'s
  `schtasks.exe` and `reg.exe` and `machine.js`'s programs (below); `launch.js` and `machine.js` require Node's built-ins
  only, by `node:`, which the same fence holds.
- **The first admin account** is made with the token, as on every AGMessage: `/api/setup` takes it typed, or the
  token's sign-in made by this run, at the laptop, and never loopback alone (`docs/ACCOUNTS.md`, The first admin).

## The machine's own commands, the server task, and the way back's backup

The machine-level commands (`app/machine.js`) run elevated or as SYSTEM only, by the installer, the control tasks (below)
and, later, the checked upgrade. They require Node's built-ins only and run nothing but by its absolute path in the System32
folder the installer passes (`{sys}`), from that folder: `schtasks.exe`, `icacls.exe`, `reg.exe` and
`WindowsPowerShell\v1.0\powershell.exe`, never a bare name. `powershell.exe` runs one fixed script for each Windows fact
no other program gives (a folder's owner by `Get-Acl`, the firewall's rules by NetSecurity's cmdlets, the port's holder by
`Get-NetTCPConnection`, a code-integrity event by `Get-WinEvent`), each module imported by its manifest under Windows' own
module folder, its values handed in by name in an environment of its own (the Windows folder, its drive and its `Temp`,
and that module folder, each made from `{sys}`), never written into the script. `netsh.exe` is not used: a rule by
program, protocol and port is NetSecurity's. No machine path
is read from the environment; Inno passes `{sys}`, `{app}` and `{commonappdata}` as arguments. Every command takes
`--out <file>`, where its result is written whole as JSON (`{v, verb, code, words, …}`), a refusal's too, never a token.
Exit codes: 0 done, 2 not done (with why), 3 refused (a precondition a person must clear, fail closed), 64 a word it does
not know, or an argument missing or malformed (a path that is not full from a drive or a share, `\ProgramData\…` among
them). This build has `prepare`, `install`, `uninstall`, `preinstall-check`, `upgrade-stop`, `status`, `restore`, `whose`,
`start`, `first-account`, `control` and `import` (The import of a portable folder, below); `upgrade` is a later unit's
(U18) and is refused as unknown until it lands. The audit log is the server's alone: the machine appends to `machine\events.jsonl`, and the server turns each
event into its audit row (The machine's events, below).

- **The machine folder, race-free** (`machine.js prepare`, at the installer's start). A non-recursive
  `%ProgramData%\AGMessage`, at once its inheritance cut and SYSTEM and Administrators in full control, written by SID
  (account names are localised), never `/T`. An existing folder is accepted only when the install record
  (`HKLM\SOFTWARE\AGMessage`) shows an earlier install, or a prepare of this folder that no install finished (`Prepared`,
  which the install removes), `lstat` shows a real directory (not a link or reparse point), and its owner (`Get-Acl`) is
  SYSTEM or Administrators. The root is listed: one made empty and then found holding something another account added is
  refused, nothing installed. Then each child, non-recursive, with its own grants, and in a root made by this run any
  child already there is refused; in a root that was there, each one there must be a real directory before any grant
  touches it: `data`, `uploads`, `keys` and `logs`, `token`, `machine\` with `inbox\`, `outbox\`, `work\` and `staged\`
  (SYSTEM and Administrators only); and `setup\<128 random bits>\`, where any signed-in account may create a file and
  none may list or read, its name given to the installer in `--out` alone and the folder removed at the install's end.
- **The server task** `\AGMessage\Server` (`machine.js install`; `--app` is `{app}`, which holds `node\node.exe` and
  `app\launch.js`). LocalService under a SID of its own (`NT TASK\AGMessage-Server`, `ProcessTokenSidType` unrestricted),
  with `SeChangeNotifyPrivilege` alone (so `SeImpersonatePrivilege` is removed); a boot trigger; no execution time limit;
  both battery settings false; `MultipleInstancesPolicy` `IgnoreNew`; `RestartOnFailure` 3 × 1 min; its action `node.exe`
  on `launch.js serve`, both by their absolute paths, from `app\`, with the five folders, the machine's events file
  (`--events`, `machine\events.jsonl`) and the port; its descriptor (`D:P(A;;FA;;;SY)(A;;FA;;;BA)`) SYSTEM and
  Administrators only, so people start it through their control tasks (below).
  Its SID is read (`schtasks /ShowSid`) and given what it uses: modify on `data`, `uploads`, `keys` and `logs`, and on
  `token`, since the watchdog replaces the token by a rename, which needs delete; read on `machine\events.jsonl`, that file
  alone, never a list of `machine\`. The laptop's admin is given read on `token` and `logs` (Show the admin token,
  AGMessage status) and its own `machine\inbox\<sid>\` (it may create and write files) and `machine\outbox\<sid>\` (it may
  read), and its own control task. On an upgrade each account given a right has its control task registered again from
  this build's definition. Every grant is checked: a SID not read or a grant that fails is not done (2), with no record
  written.
- **The firewall rules** (answer 37). One for TCP on the port, one for UDP on 9928 (discovery), each naming the program
  (`node.exe`), the protocol and the local port, the remote address `LocalSubnet`, on Private and Domain, and Public only
  when ticked at install — never a rule on `node.exe` alone, which would let any account's inbound traffic reach any
  script. Each install makes them again, so a changed port changes them.
- **The one install record**, `HKLM\SOFTWARE\AGMessage` in the 64-bit view, written last: `InstallDir` (`{app}`),
  `Version` (the install version, MAJOR.MINOR.BUILD from the build, the order an installer and an upgrade compare; a
  local build is never installed), `SemVer` (the product's version, which the words say), `Previous` (the install
  version an upgrade replaced), `Runs` (`task`), `Port`, `Admin` (the laptop's admin's SID), `AdminName` (its name, for
  the words), `PublicFirewall` and `Signed`. The laptop's admin is found once, at the first install (`--admin` then
  required); an upgrade keeps the record's, whoever runs it, and only the first install appends `machine.admin` to the
  machine's events. No token or password is ever written to the record, a task's definition or a machine command's
  `--out`.
- **`launch.js serve`** is the server task's action, run by Task Scheduler as LocalService. It runs the watchdog
  (`supervise.js`) in a process of its own, in an environment made of Windows' own names (`SystemRoot`, `TEMP` and the
  like) and `AGM_RUNS=task`, the folders, the machine's events file (`AGM_MACHINE_EVENTS`) and the port from its
  arguments, and nothing else: no `NODE_OPTIONS`, no `AGM_…`
  it was not handed. The watchdog's stop (0), its give-up and a configuration refusal (3) end `serve` with 0 after the
  watchdog has written why (`watchdog.json`, `server.log`), so the task stays stopped and `RestartOnFailure` does not loop
  it; only an unexpected end of the watchdog is non-zero, which it restarts.
- **`launch.js status`** is the person's reader (Start → AGMessage → AGMessage status), run without an elevation, each
  fact read, refused or absent and never a refusal taken for a fact: the server task's state and last result (by column,
  never Windows' localised words), the record's admin and port, the tail of `server.log`; the data folder's
  `last-stop.json` and `watchdog.log` are SYSTEM's, Administrators' and the server's, so to anyone else they read
  refused, and are said so. **`machine.js status`** is the elevated reader: all of it, plus the port's holder pid and
  whether a code-integrity event (Smart App Control) stopped `node.exe`, from one `powershell.exe`. Neither shows a token.
- **`machine.js preinstall-check`** fails closed before an install or an upgrade lays a file. With `--app`, a console of
  the Start menu still open from {app} is refused first; the installer's own chain is not one (a kept installer of
  `{app}\installers\` that is a parent of this check, and its other instance, the one that asked for the elevation, which
  the parents' chain names by its file). With `--rollback` (the way back, which stops nothing) anything answering on the
  port is refused. Nothing on the port: ready, with or without a token (a first install has none). The installed AGMessage proving its token is asked how busy it is:
  busy is refused without a typed reason (`/FORCE`), and one that does not answer within 5 s is refused, naming its pid.
  Anything else on the port is refused with who holds it: "AGMessage 0.5.1 is running on port 3023 from a folder: press
  Ctrl+C in its window, then continue" from its `/api/health`, or "Another program (pid 4120) holds port 3023: close it,
  then continue".
- **`machine.js upgrade-stop`** asks nothing when the disk is short of the room the backup takes (its copies and 1 GB
  beside them), unless forced. Then the stop at loopback with the proof of the token, reason `upgrade`, who asked
  (`--by`) and the reason typed: it waits for the server to end (its port closed, up to 2 minutes), reads
  `last-stop.json` written after it asked, and says "AGMessage stopped for the upgrade and saved at 20:31; backup …". No
  record, a stop that did not save, or no backup made (the record's `unbacked` says why) is refused (3) unless forced.
- **`machine.js uninstall`** refuses while a console of the Start menu is open from `--app` ({app}), then stops the
  server at loopback (it saves; Task Scheduler's End, TerminateProcess, is never the stop), waits for its port to close,
  ends and removes every task in `\AGMessage\` (the server task, the control task the record names for the laptop's admin
  and each account given a right, and any other the folder lists), waits for every program of {app} to end (one still
  running is named), then removes the firewall rules and the record, before any file goes. The data is removed only when
  the person says Yes to "Remove all AGMessage data from this PC" (`/REMOVEDATA`), the keys last (answer 43). Kept, it
  is left with SYSTEM and Administrators alone: the laptop's admin's and each grantee's grants on the machine folder's
  children are taken back (`icacls /remove:g`, by SID, while the record still names them) and their `inbox\` and
  `outbox\` folders removed; the record is replaced by `Kept` (the root) and `Port`, which `prepare` takes as it takes an
  earlier install, so AGMessage installed again takes the folder, finds whose it is anew and serves on the same port.
  Each step is checked: what was left is named, and the exit is 2.
- **The way back's backup** (`app/lib/upgradebackup.js`). The server, the one writer, makes it at a stop this PC's machine
  asked for an upgrade, once the audit log, every store and each dirty hall are saved and before `last-stop.json`, which
  names it (`backup`, `backupMs`, or `unbacked`). It goes under `data\backups\upgrade-<build>-<time>-<suffix>\`: a hard
  link to every file only ever replaced whole by a rename (each store, a hall's snapshot, every marker and record), which
  costs no room and keeps the file as it was; a copy of a file written where it lies (an append-only log, a hall's op
  log, the audit log, a `.bak`) and, where the uploads folder is on another volume, of each upload; `backups\` and `logs\`
  are never in it. Two are kept, the newest. A disk short of room for the copies and the reserve refuses the backup,
  leaving nothing.
- **`machine.js restore`** lays one backup back for the way back, before the earlier build starts again (the installer's
  U.6.1), refused while anything answers on the port. File by file: a file the backup holds whose live file is still the
  same file (a hard link nothing replaced) is kept, any other is laid back, and a file the newer build made is removed;
  the audit log and `watchdog.log` are never rolled back, since they carry what the newer build did, so the audit log
  and its head in `keys\` still agree, and `keys\` is never touched.
- **What only a Windows run proves.** `icacls`, `schtasks`, `reg` and NetSecurity's cmdlets applying; the task running as
  LocalService with `SeChangeNotifyPrivilege` alone; the installer's life cycle (U13, U16). The pure parts — the argument
  parsing, the folder order (never `/T`, and its refusals), the task's definition, the firewall rules, the record's shape,
  Windows' answers read by column, the machine's wire half (matched to `lib/machinewire.js` and `lib/busy.js`), the stop
  for an upgrade and its backup against a real server, the restore, and `launch.js serve` with the real watchdog — are
  held on Linux (`test/machine.test.js`); on Windows the same file runs the read-only scripts (a real folder's owner, the
  port's holder) through the machine's own hands. The Windows readings lane takes R3′ (U12's own task definition, its
  stop-saves) and R9 (the backup's time), and R8 reads that definition back as a standard account.

## The laptop's admin, its rights and the control tasks

The plan's Part 6, unit U17, with the owner's answers 38 ("The admin will be whoever does the install. They can add
permissions or handover to another account.") and 40. The Windows account that ran the install is this PC's AGMessage
admin, standard or administrator (`Admin`, its SID, and `AdminName`, its name for the words, in the install record). In
the pages "the laptop's admin" is that Windows account; "admin account" stays an AGMessage account with the admin role.

| Right | What it lets the account do | How Windows holds it |
|---|---|---|
| `token` | read the laptop's token: the break-glass sign-in, Accept, the token's export, the first admin account | read on `%ProgramData%\AGMessage\token\` |
| `start` | Start AGMessage | the account's control task runs the server task |
| `stop` | Stop AGMessage…, with a typed reason when busy | the account's control task stops the server at loopback, saved |
| `upgrade` | Upgrade AGMessage…, and Go back to build N (a later unit's, U18) | the account's control task, after U18's checks |

- **Who holds them.** The laptop's admin holds all four, and alone gives them, takes them back or hands the admin over.
  An account given rights cannot give them on. Each right goes to one person's account (a local account, or one that has
  signed in to this PC); a group, a service, or an account Windows cannot confirm is a person's is refused: "Give rights
  to one person's account." `Grants` (`HKLM\SOFTWARE\AGMessage\Grants`, one value per SID: its rights, `start,stop`)
  holds the rest. Holding the token includes a stop by hand, since the token is the node's whole admin; `stop` alone is
  for an account that should stop the node and never hold the token. A member of Administrators can still do everything
  through an elevation.
- **One control task per account with a right**, `\AGMessage\Control-<SID>`: SYSTEM, run on demand only (no trigger),
  a request queued behind one that runs, both battery settings false, 10 minutes at most; its action `node.exe` on
  `app\machine.js control --for <SID> --machine C:\ProgramData\AGMessage --sys C:\Windows\System32`, both by their absolute
  paths, fixed at registration; its descriptor `D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FRFX;;;<SID>)`, read and execute for that
  account alone beside SYSTEM and Administrators. So which task ran says whose request it is, and nothing the request
  says can change that. Which rights let a standard account run it on demand is reading R11.
- **A request.** `launch.js` (run as the person, never elevated by itself) reads their SID (`whoami.exe`), writes
  `request.json` (`{id, verb, …}`) into `machine\inbox\<SID>\`, where only that account may add a file and write it (no
  folder and no junction: the folder's own grant is `WD`, the files' an inherited `W`), and runs their control
  task (`schtasks.exe /Run`). The control task, as SYSTEM, refuses a request file that `lstat` shows as a link, a hard
  link, a folder or over 4 KB (whatever was there is removed, so nothing is read twice), copies its bytes into
  `machine\work\` and reads that copy: whole JSON, an `id`, a known verb (`start`, `stop`, `grant`, `revoke`, `handover`;
  `upgrade` and `back` are U18's) and only that verb's fields, each of its type; an unknown word is refused, never
  defaulted. It reads the right from the record at that moment, so a right taken back holds at once even if removing its
  task failed; it acts, writes `answer.json` (`{v, id, verb, code, words, ranAs, for, …}`, refusals too) into
  `machine\outbox\<SID>\`, which that account may read, and appends one machine event for an act done, and one
  (`machine.refused`: who asked, what, and the rights it named, the account it names said as typed and never looked up)
  for a request read whole and refused for want of the right, so an account asking beyond its rights is in the audit
  log. A request that is not one leaves no event; a run that finds no request waiting (a second press, queued behind the
  first) writes no answer either, since the one there may be the run's before it. An act done in part answers not done
  (2) with what it did; an act done whose event cannot be appended answers done, saying the audit log will not show it.
  `launch.js` waits for the answer to its request's id and prints its words.
- **The acts.** `start` runs the server task and waits for its server to prove it holds the token ("Started."; one already
  serving is said, and changes nothing). One that has not proved itself within 35 s is left as it is, never ended, since
  it may still be starting or its watchdog retrying a held port, and Task Scheduler's End is no stop: the answer, not done
  (2), says the task's state and the log's last line, and the event says the start was asked. `stop` is the stop at
  loopback with the proof, `by` the account's name, which a busy server refuses with its busy line's counts: "Not
  stopped: AGMessage is busy (3 pages active, a countdown running). Type a reason to stop it anyway." until the person
  types one (Stop AGMessage… asks for it and asks again; Enter leaves it running), then
  "Stopped, saved at 20:31." The `token` right is the read on `token\`, which Windows holds, so the record never names less
  than Windows grants: a read is given only once the record names it and taken back before the record stops naming it.
  `grant` makes the account's `inbox\` and `outbox\` and its control task, writes its `Grants` value, and only then, for
  `token`, gives its read on `token\`; a read Windows will not give is taken off the record again and said, the rest
  given, not done (2). `revoke` takes back the read on `token\` first, then writes the record (read at every request, so
  what it no longer names is refused at once), then, with no right left, removes the control task, `inbox\` and
  `outbox\`; a read Windows keeps stays on the record and is said, not done. A SID the record names is taken as typed,
  so an account Windows no longer knows can lose its rights. `handover`, confirmed by typing the new admin's name again,
  makes the new admin's folders and control task first, then takes the old admin's reads on `token\` and `logs\` (and
  hands nothing over while one stays), then rewrites `Admin` and `AdminName` (the new admin's own `Grants` value goes),
  then gives the new admin its reads, then removes the old admin's `inbox\`, and its control task last, after the
  answer; the old admin keeps no right unless the new one gives it back. A new admin Windows will not give its reads is
  said (2), and a handover to the admin itself gives them again. An account's folders are removed entry by entry, never
  recursively, so a link left in one is taken and never what it names; uninstall does the same before the machine
  folder goes. The words:
  "You have no AGMessage rights on this PC. Ask LAPTOP\ana, or an administrator." and "Only LAPTOP\ana, this PC's
  AGMessage admin, can give rights."
- **Who may run AGMessage…** (`launch.js rights`) lists the admin and each grant (the names as Windows gives them now, by
  one `powershell.exe`), then takes one line: "Give LAPTOP\ben: start, stop", "Take back from LAPTOP\ben: stop" (or all),
  "Hand over to LAPTOP\ben". Run in an administrator's elevated console (Administrators and a High integrity label, read
  by SID), each of Start, Stop and Who may run runs `machine.js control --elevated --request <machine\work\file>` beside
  it instead, which may do every act, so a laptop whose admin account is gone is handed over; its event names that
  administrator.
- **The machine's events.** `machine\events.jsonl` is appended by `machine.js` alone, in place (the server's task reads
  that one file by its own grant), under `machine\events.lock`, so no two control tasks take one seq (a lock is held for
  one read and one append; one older than 5 s, below an append's 10 s wait, was left by a crash and is taken): `{seq, at,
  kind, by, for, rights, words}`, `by` and `for` Windows accounts (`{sid, name}`), never a token, a password or a path in
  a profile.
  The server (`lib/machineevents.js`), the audit log's one writer, reads the file after the hold and at each nudge
  (`POST /api/machine/events`, which each act sends), and writes one row per event in seq order: `machine.admin`,
  `machine.grant`, `machine.revoke`, `machine.handover`, `machine.start`, `machine.stop`, `machine.refused` (and
  `machine.upgrade` and `machine.upgrade.refused`, which U18 appends, and `machine.import`, the import's). A row names both
  accounts by SID, whole, since names are localised and can be renamed: its actor the Windows account that asked
  (`{t: 'windows', id: <SID>, name}`), its target the SID of the account acted for; its words the event's (naming both by
  name), then the rights it names, when it was done ("· done 20:31 UTC on 7 Nov 2026", the event's own time: a stop's row
  is written at the next start) and its seq ("· machine event 7"). The words give way, with an ellipsis, before that end
  is cut, the token taken out first. The last seq written is kept in settings (`machineSeq`), and a start takes the higher of
  that and the seq the log's newest rows name, so a restart, even one before the settings were saved, never writes an
  event twice or skips one. A line that is not an event is passed over and said on the console; a row never holds the
  token (taken out by value, in either case). A copy whose settings could not be read writes none until they can. The
  file, not the nudge, is the authority: an event the server missed is written at its next start.
- **Where it shows.** "This laptop" lists the laptop's admin and each grant, to admin accounts and the token; AGMessage
  status, run elevated, lists them too. The context, the hello and the AI's brief carry none of it: a Windows account's
  name is not the show network's business.
- **What only a Windows run proves**, and is not yet run: that a control task's descriptor lets its one standard account
  run it on demand and refuses another, and that it then runs as SYSTEM (R11, the lane's); the inbox's and outbox's access
  lists; the account lookup; the Start menu's consoles; lab 7 (the admin as a standard account, a second given `start` and
  `stop`, a third given nothing). The pure parts and the acts are held on Linux (`test/control.test.js`): the request's
  shape and its refusals, a link, a hard link and a file swapped after its look refused, the rights read at each request
  and a refusal for want of one in the log, giving, taking back and handing over (from the admin, an elevated
  administrator, and refused from anyone else), the token's read and the record in their order when Windows refuses a
  step, an account's folders removed without following a link, start (one not answering left as it is) and stop with
  their events, `launch.js` wired to `machine.js control` end to end, and the events written by a real installed-channel
  server exactly once across a nudge and restarts, in seq order, a local account's and an Entra ID account's SIDs whole,
  a stop's long reason and its own time kept, with no token in any row.

## The installer

`installer/AGMessage.iss`, an EXE built by Inno Setup 7.1 (PlayMap's tool and skeleton), `AGMessage-Setup-<version>-unsigned.exe`
(a CI build's `AGMessage-Setup-0.6.0-dev.41_abc1234-unsigned.exe`). `installer/build-installer.ps1` builds it from the
portable zip's stage without its two .bat files (the installed node has no window and no clean copy), with the defines
`tools/installer-defines.js` reads from the stage's `app\package.json` and `app\build.json` by `lib/version.js`'s rules
(a local build has no install version and makes no installer), checks the version the file carries, and writes
`SHA256SUMS.payload` beside it: the SHA-256 of every file it lays down, by its path under the install folder. CI's
`installer` job builds it on `windows-2025` from the zip the package job built, Inno Setup pinned by hash and checked, on
each run, against its release's digest and its publisher's signature; it is built there and never run.

- **Per machine, Program Files only.** One fixed `AppId`; `{autopf}\AGMessage` with no folder page, and any other folder
  (`/DIR=` included, or an earlier install elsewhere) refused before anything changes; `PrivilegesRequired=admin` with no
  per-user override, since it registers tasks and rules; `CloseApplications=no`, so Inno never closes a running AGMessage:
  it is stopped only at loopback, where it saves. No `[Dirs]` and no `[Registry]`: the machine folder is
  `machine.js prepare`'s, in its race-free order, and `HKLM\SOFTWARE\AGMessage` is `machine.js install`'s one record.
- **Every machine-level act is `machine.js`'s**, run with this build's `node.exe` and `machine.js`, extracted to the
  installer's temporary folder before anything is laid down (R10 read that extraction inside 5 s), hidden and waited for,
  its record read from `--out`; a command run with `--out` never waits for Enter. In order:
  1. **`InitializeSetup`, the refusals.** Only a newer build installs, by the install version: "AGMessage 0.6.0 (build
     41) is newer than this installer's 0.6.0 (build 37): uninstall it first to go back."; the same build "is installed
     already: an installer upgrades only an older build."; a quiet first install without `/ADMIN=` "AGMessage needs to
     know whose it is: add /ADMIN=<account>." Then `preinstall-check` (a portable copy, another program or an open console
     said before anything is made; a busy server is the busy page's), `prepare` (the machine folder) and, at a first
     install, the plan's two readings of whose it is (below).
  2. **The pages.** Smart App Control's, only while it evaluates this PC; the laptop's admin's (first install); "Also on
     Public networks (hotels, airports, fresh venue Wi-Fi)", unticked, or as the record keeps it on an upgrade
     (`/PUBLICFIREWALL=1` or `=0` quietly); the busy page, shown only when `preinstall-check` refuses a busy server: its
     counts in the server's words ("AGMessage is busy (3 pages active, a countdown running)") and a reason that must be
     typed (`/FORCE="<reason>"` quietly), kept in the audit log as the stop's `server.stop.forced`.
  3. **`PrepareToInstall`.** `preinstall-check` again (the wizard may have waited on its pages), then on an upgrade
     `upgrade-stop`: the stop at loopback with the proof of the token, saved and backed up for the way back, and nothing
     left running from Program Files\AGMessage (a console of the Start menu is named: "AGMessage's own console is open
     (node.exe (pid 5000) runs from …): close its window, then continue."). Any refusal there is the Preparing page's
     words (with how to go on anyway, `/FORCE="<why>"` from a command prompt, where a reason lifts it: no save record, no
     backup, the disk short), and an install that does not reach its end starts the earlier server again. A stop that
     went on without its save or backup, by the reason given, is said to the person. A refusal there, once `prepare` has
     made the machine folder, says nothing was installed.
  4. **After the files: `install`, then `start`.** The server task, its grants, the rules and the record (the laptop's
     admin given at a first install, kept at an upgrade), then the server task run and the server waited for until it
     proves, by the machine's hello, that it holds the machine folder's token, as this build (35 s: the watchdog's 30 s
     start window and the task's own start). `/api/health` is never the verify: its build words are public, and a program
     that took the port during the upgrade could say them. Whether the node has an account yet is asked of the proven
     server, on the connection it proved itself on. One that does not prove itself is ended, and its log's last lines are
     the words. A first install whose server did not answer says what works: its task starts it again with Windows (a
     restart, once the cause is cleared), or an uninstall and a new install; this installer would refuse to run again,
     since the record names its build.
  5. **The way back**, when the new build is not set up or does not answer: the backup its stop made laid back
     (`machine.js restore`), then the kept installer of the earlier build run with `/ROLLBACK`, which lays the earlier
     files down, starts that build and verifies that it answers. `/ROLLBACK` is accepted only for the build the record
     names as `Previous`, or for the build it still names when the files in Program Files\AGMessage are another build's
     (a newer one that never recorded itself, read from their `app\build.json`), and only while nothing answers on the
     port (`preinstall-check --rollback`): the way back stops nothing, since the newer build had ended. Its record names
     no `Previous` (`install --rollback`): the build it replaced did not start. Two installers are kept in
     `{app}\installers\`, this one and the earlier build's, by their install versions (`AGMessage-Setup-0.6.41-unsigned.exe`),
     so the way back needs no download.
  6. **The first admin account**, on the page after the files, when the node has none: user name, name and password
     (twice), made through `/api/setup` with the token the installer may read (`machine.js first-account`). The three go to
     `machine.js` in a file of `machine\work\`, which only SYSTEM and Administrators may read and which it removes before
     it asks; the password is never in a command line, a URL or the installer's log. They and the token are sent only to
     this build's server once it has proved it holds the token, on the connection it proved itself on: a program that
     took the port is asked the hello alone and sent neither. Empty fields leave it for Admin login with the token. A
     quiet install makes none.
- **Whose AGMessage it is** (the laptop's admin, the plan's U.5.1). Once the elevation is in, the account that started
  Setup runs `{sys}\whoami.exe /user /fo csv /nh` through `{cmd}` (Inno's `ExecAsOriginalUser`, which returns only an
  exit code) into the one-time folder `prepare` made in `setup\`, where any signed-in account may create a file and none
  may list or read; then `machine.js whose` reads and removes that file, reads the owner of `explorer.exe` in the
  installer's session (`Win32_Process`'s `GetOwnerSid`, one `powershell.exe` by its absolute path), the account the
  elevation runs as (`whoami.exe`) and the names Windows gives each SID. Both readings naming one person's account
  decide it: "AGMessage's admin on this PC will be LAPTOP\ana, the account that started this installer. LAPTOP\it-admin
  approved it and gets no AGMessage rights." When they disagree, or one cannot be read, the page shows both and the
  person chooses one of them, never a third; when neither names a person (SYSTEM, nobody at the screen), the install is
  refused unless `/ADMIN=<account>` names it, which Windows resolves to its SID and which is taken only when Windows
  confirms it is one person's account on this PC: it names the SID, it is no local group, and it is a local account
  (`Get-LocalUser`) or has a profile here (`ProfileList`: it has signed in to this PC, which no group ever does). A group
  or a service is refused ("Give it to one person's account"), and so are a group of a domain or of Entra ID, which share
  a person's SID shape, an account Windows cannot confirm and a SID it names nothing for. The record keeps its SID
  (`Admin`) and its name for the words (`AdminName`); an upgrade keeps them, whatever `/ADMIN` says.
- **The Start menu** (`Start → AGMessage`): Open AGMessage, Show the admin token and AGMessage status, each
  `node.exe app\launch.js <verb>` with the machine folder and `{sys}`, a console run as the person and never elevated by
  itself. **Open AGMessage** (`launch.js open`) reads the port from the record (3023 when it names none) and asks
  `/api/health` once: the installed node answering opens `http://localhost:<port>` in the person's browser by
  `explorer.exe`, by its absolute path in the Windows folder `{sys}` sits in, and the console closes; a portable copy or
  another program on the port, a port that does not answer within 3 s, or nothing serving is said, with the server task's
  state, the log's last line and what to do, and the console stays until Enter. **Start AGMessage**, **Stop
  AGMessage…** and **Who may run AGMessage…** (`launch.js start`, `stop`, `rights`) ask the person's own control task
  (The laptop's admin, its rights and the control tasks, above). Upgrade and Go back to build N are a later unit's (U18).
- **The uninstall** asks "Remove all AGMessage data from this PC?", No the default (the uninstaller has no pages, so the
  box the plan names unticked is a question whose default is No; `/REMOVEDATA` quietly), then `machine.js uninstall
  --app` refuses while a console of the Start menu is open, stops the server at loopback (it saves), removes every task
  of `\AGMessage\`, waits for every program of the folder to end, removes the rules and the record, and the data when
  asked, the keys last, before any file goes; data kept is left for AGMessage installed again, every account's right on
  it taken back (`machine.js uninstall`, above). Anything it could not take back stops the uninstall with every file
  still in place; a busy AGMessage is stopped only with `/FORCE="<reason>"`, and the uninstaller, which has no page to
  type it on, says its own command whole (`"C:\Program Files\AGMessage\unins000.exe" /FORCE="<why>"`).
- **Smart App Control.** The installer and its uninstaller are AGMessage's only unsigned executables. Under Smart App
  Control's enforcement Windows blocks the installer and it never runs, so its words are in `README.txt` and the release
  notes; while Smart App Control evaluates, the installer runs and its first page says so (PlayMap's page). The installed
  node runs on `node.exe`, which R5 reads as Valid; whether Smart App Control keeps it starting is lab 4's, not run.
- **What only a Windows run proves**, and is not yet run: that ISCC compiles the script (the installer job, on the next
  push); the install, the upgrade, the way back and the uninstall themselves, the readings of whose it is under
  over-the-shoulder elevation (R6: the lane takes the import's export as a standard account, and the two readings stay the
  show laptop's), the import page itself, the Start menu's consoles and the browser opening, and the
  first admin account made from the page (the installer's life cycle, U16). The pure parts are held on Linux
  (`test/installer.test.js`): the script by its text (its `[Setup]`, files, Start menu items parsed by `launch.js`'s own
  reader, every `machine.js` command and option it names, the password's path, the switches and refusals), the defines
  and the portable stage holding every file the installer needs, and every `machine.js` command it runs (`whose` with
  `/ADMIN`'s confirmation, `start` and `first-account` against proving and impostor stand-ins and a real server, no byte
  of the token or the password reaching one that proves nothing, `preinstall-check`'s busy line, console check, the
  installer's own chain and `--rollback`, `upgrade-stop`'s, `uninstall` keeping the data and a later install taking it)
  and `launch.js open`; on Windows the same file runs `whose`'s and the programs' scripts for real.

## The import of a portable folder, before the first start

A portable folder's halls, messages, files, accounts, screens and keys come into the installed node once, on the
installer's import page, before that node first starts (the 0.6.0 plan's Part 6, unit U14, with the owner's answer 42).
An installed node that has served has its own machine key, `secret.key`, certificate and audit chain, and two of each
cannot be merged, so a later import is refused; the portable folder's events stay in that folder, or come over to a
fresh install whose data was removed at the uninstall. The page is offered on a first install shown to a person (never a
quiet one), and only to the account that started the installer when it is AGMessage's admin here: the export runs as
that account, since its profile holds the folder's keys. The first start waits until the page is passed; "Start with no
halls" starts at once. The page says before Import is pressed that the folder no longer starts once imported, and that
its keys leave the account's profile, which every portable folder of that account uses.

- **It refuses**, with nothing exported or laid: a copy running on the folder (its folder pipe answers, and the words say
  what its busy line says there, counts only) or an AGMessage answering on the installed node's port; a folder last run by
  another build, or by this one in a format it does not write (its `app\data\format.json`; "upgrade the portable folder
  to this build, start it once and stop it, then import again"); a folder an import took already (its `moved.json`); keys
  that are not in the profile of the account that started Setup ("This folder's keys are another Windows account's:
  install from that account.", when a sealed value does not open with that profile's machine key, the audit log is keyed
  under another, or the profile has none while the folder holds what one sealed); a machine key, certificate or server
  secret the installed node's own start would refuse (a `machine.key` that is not a key, a `tls.json` it cannot use, a
  `secret.key` that holds no secret), each with what to do (put back the copy it had, or move it aside where nothing was
  sealed with it); an audit log that does not check; the folder chosen or its `app\` a link or junction, or one anywhere
  in what it carries (the backups, the console and the watchdog's files, which an import leaves, are never walked); more
  files than a bundle carries (500,000; the walk stops there); a disk short of the room; and a target that has served (any
  hall, account or audit row, or a machine key, certificate or `secret.key` of its own: never merge).
- **Two steps.** `launch.js export`, run through Inno's `ExecAsOriginalUser` as the account that started Setup, writes a
  bundle of contents only into that account's `machine\inbox\<SID>\import\` (made by `machine.js import --step stage`,
  where the account may add files and write them, never a folder or a junction): each file's bytes as a part named by its
  place, then a manifest naming each part's place, size and SHA-256 with the folder's facts. It carries the data folder
  (but its backups, its console, the watchdog's own files and temporary files), the uploads, and from the profile's
  `%LOCALAPPDATA%\AGMessage` the machine key, `tls.json` and the audit records, so every sealed value, the certificate's
  fingerprint and the chain carry over; `secret.key` travels in the data folder. Nothing is rotated (answer 42). Then
  `machine.js import --step take`, elevated, copies each part by its bytes into a new file of the data, uploads or keys
  folder, never over a file there and never with an access list of its own (each takes its folder's), each part read only
  when it is a file of its own (no link, no hard link, the file `lstat` saw, by its whole file id) of the size its
  manifest names, and its SHA-256 checked.
- **It then verifies, and says which check did not pass**: the halls, side rooms, messages, accounts and screens counted
  alike; the same machine key; every sealed value opening, as many as the portable folder had; the certificate's
  fingerprint unchanged; the audit chain checking to its end as it did there, the archives in `data\audit-archive\` it
  names included. Then what the installed node's own start refuses, read from the copy itself and never from what the
  export said of its source: the copy last run by this build in the format it writes (`format`), a machine key,
  certificate and secret it starts on (`usable`), no copy running on its data folder (`held`) and no import's mark there
  (`moved`). Each side is read by `lib/importfacts.js` with the server's own readers, writing nothing: the portable
  folder's by the export, as the account; the copy's by the import, elevated, in an environment of Windows' own folders
  (it loads only `app\lib`, `app\verify` and Node's built-ins, which `test/loads.test.js` holds). A check that does not
  pass is said by its name, and everything the copy laid is taken out again, so the import can be run again.
- **Then the old copies go** (answer 42). Once verified, the import's verdict is in the account's `machine\outbox\<SID>\`
  (`import.json`, which only SYSTEM and Administrators write), and `launch.js forget-keys`, run as the same account,
  removes nothing without a verdict that names this import and this folder. It marks the source first: `app\data\moved.json`,
  which this build's server and watchdog read before they write anything and refuse to start on ("this folder's
  AGMessage … was moved into the AGMessage installed on this PC on … : its halls, accounts and keys are there now"), and
  its `start-agmessage.bat` replaced by one that names the installed AGMessage, the original kept as
  `start-agmessage.bat.moved`; then it removes that account's `%LOCALAPPDATA%\AGMessage` and the folder's
  `app\data\secret.key`, each checked and said. One that fails names its path, which stays on the import page's last words;
  a mark that was not made is said apart ("the folder is not marked as moved …, so it could still start: never start it
  again"). It reaches nothing through a link: the folder or its `app\` a link by then, nothing is removed.
- **The import's end** (`machine.js import --step finish`) appends `machine.import` to the machine's events, which the
  installed node's first start writes as its audit row: who imported, named by the machine (the install record's name for
  the laptop's admin, else Windows' own name for the SID; never a name the bundle carries), the build, the counts,
  verified, and whether the old copies went and the folder is marked (never a path in a profile); a copy not removed or a
  folder not marked is not done, its words the page's last. The audit log carries on at its new path, saying where it was
  written last (`audit.moved`).
- **No copy of the keys stays in the inbox.** The bundle holds the profile's machine key, certificate and audit records and
  the folder's secret, and the account may not remove what it wrote there. So a take that does not pass clears it (the
  parts not laid, the manifest and the answers), finish clears it, and `machine.js import --step clear` clears an import
  left before its end: the installer runs it after an export that refused or did not run, after a take or a finish that
  did not end it, at Start with no halls, and at Setup's end. An import folder that is a link is removed itself, never what
  it names.
- **What only a Windows run proves**: that the export, run by `ExecAsOriginalUser` over an administrator's approval,
  writes into its inbox under those grants and the import reads it (R6 takes the export as a standard account by a task
  with its logon; the over-the-shoulder readings are the show laptop's), the import page itself, and the installer's life
  cycle around it (U16). The rest is held on Linux (`test/import.test.js`): a real portable copy seeded, stopped, exported,
  taken, verified and forgotten, the installed node started on it under the task, and the portable copy refused at its
  next start; each refusal, each check that does not pass, the copy taken out again and the bundle cleared, and
  `forget-keys` removing nothing without the verdict and naming a removal that failed with its path.

## The version number, the release order and the data folder's format

- **The version number** an installer and an upgrade compare is MAJOR.MINOR.BUILD (PlayMap's rule, in the bounds an
  MSI's ProductVersion carries: MAJOR and MINOR up to 255, BUILD up to 65535): `app\build.json`'s `installVersion`,
  written by `tools/stamp-build.js` (`0.6.41` for build 41 of 0.6.x), which stamps no version past those bounds. A local
  build has none and is ordered against nothing; the installer's units refuse one.
- **Newer** is that number, on every node of the show network (`lib/version.js` `compareBuilds`). A release is published
  only when its version is above every release already published and every other version tagged, released or not
  (`stamp-build.js --check-tag --released --tags`, asked in the analyze job and again as the release job's first step,
  one release job at a time), so among releases SemVer and MAJOR.MINOR.BUILD agree: an older PATCH built after a newer
  one is never released, even when two tags run side by side. Development builds of one MAJOR.MINOR order by build
  number alone.
- **The data folder's format** (`lib/dataformat.js`): `data\format.json`, `{format, build, at}` and, after a move,
  `backup`, read before anything else of the folder (by the watchdog and by the server, before either writes anything)
  and read again and written once the node holds it. 0.6.0 writes format 2; a folder without one is format 1 (0.5), or
  new when it holds nothing a server wrote. A higher format ends the start with code 3 in this channel too (no wait
  lifts it, so never 75), its words naming the build that wrote the folder and the copy it kept, and nothing is written
  in the folder, the watchdog's log included: the words are on the watchdog's error output. A lower one is copied whole
  into `data\backups\format-<n>-<time>-<suffix>\` first (a copy a stop cut short removed, and refused with words when
  the disk would keep less than the 1 GB reserve beside it; the watchdog's beat goes on while it runs), then moved, then
  marked last; a copy, step or marker that fails ends the start with code 3, the marker as it was. A marker that cannot
  be written ends the start the same way for a new folder and another build of the format: a node never serves a folder
  that does not say which build last wrote it. A newer build of the same format before this one is served and said
  (health's `format`, "This laptop"'s Data folder row, the log's "Data folder:" line), and a marker whose build changed
  is one `server.upgraded` audit row. The upgrade's own backup at its stop (`data\backups\upgrade-<build>-<time>\`) is
  the installer's units', beside these.
- **The pages after an upgrade** (both channels). The pages, their scripts and styles are served `no-cache` with their
  ETag, so a browser checks each with the server at every load (a 304 while unchanged) and a reload brings the build
  that serves. An open page on another build reloads itself at a quiet moment of its own: a hall page and the halls
  board once nothing is written and unsent and no dialog is open, a screen at its next take, the admin page when its
  admin presses Reload this page; each only while it is connected. 0.5.1's hall pages, halls boards and admin pages
  are told to reload 5 minutes after the first start of 0.6, once none of 0.5.1's files (cached for 5 minutes) can
  still be fresh in a browser; 0.5.1's screens cannot be, and "This laptop"'s Pages row names each as a 0.5 screen.
  Before doors after an upgrade, that row should read "every open page and screen is on this build": reload by hand
  each screen it names.

## A portable copy on a PC where AGMessage is installed

- `start-agmessage.bat` reads the install record (`SemVer` under `HKLM\SOFTWARE\AGMessage`, in the 64-bit view,
  through `%SystemRoot%\System32\reg.exe`), and its banner says "AGMessage 0.6.0 is installed on this PC and starts
  with Windows. This window starts a separate portable copy."
- A portable copy missing its files ends its words with "To use the installed AGMessage: Start -> AGMessage -> Open
  AGMessage."
- A portable copy started on the installed node's port ends with "The AGMessage installed on this PC (0.6.0, build …)
  is serving on port 3023. Open it from Start → AGMessage → Open AGMessage, or set PORT to another number to run this
  copy beside it."
- The .bat's preflight, its exit codes, the browser opener and the clean copy are the portable folder's alone: the
  installed node has no .bat.

## The Windows readings and the lab lines

What is measured on Windows before anything installed is trusted (the 0.6.0 plan's Part 6, unit U7). **The readings
inform each release and never hold it** (the owner's answer 34): each mark stays a mark, and a reading that misses it is
written in the release's notes, here and on the hour-before-doors card, with the fallback its unit names. A test is not
a reading: the installer's life cycle in CI, when it lands, is a gate, as every test is.

- **The lane.** CI's `readings` job runs on `windows-2025`, every action in it pinned by its commit, once the package
  job has built the zip, for every push, a `v*` tag and a run asked for by hand (Actions, CI, Run workflow), never for a
  pull request (its commits are pushes already). It runs one at a time per branch or tag, in a concurrency group of its
  own that never cancels a lane once it runs: a newer push's lane waits its turn, the newest waiting taking the place of
  an older one still waiting, so every lane runs whole (up to 45 minutes) and a regression shows on the next readings
  taken; its checkout keeps no credential (the stand-in tasks run the bundle's code from that folder).
  Its first step after that checkout, `tools/defender-on.ps1`, turns Defender's real-time monitoring back on (GitHub's
  image turns it off), removes the image's exclusions of `C:\` and `D:\`, and records whether that took, read back from
  Defender itself: on means real-time monitoring and scanning on access on, in Defender's Normal mode (in passive or EDR
  block mode it does no real-time scanning), and neither drive excluded. The image's other Defender settings (archive,
  download and script scanning, behaviour monitoring, cloud protection) stay as it left them, so the runner's Defender
  is narrower than a laptop's: lab 3 is the laptop's own. Then the newest release published is named and its zip
  downloaded (a GitHub answer that fails here stops nothing: R13 then reads not run, and R2 lays this build over its
  own, each saying why); `tools/readings-take.js` lays the zip down and takes each reading this build can, each on its
  own (one that fails is written with why, and the rest are taken), reading Defender again at the end; and
  `tools/readings.js` judges each against its mark. The job's summary is the table below with the run's verdicts; its
  artifact, `agmessage-readings-<commit>`, holds the measurements and the verdicts. A reading that needs Defender on and
  was taken without it is never met: it reads "not run", unless it is over its mark anyway, which Defender would only
  make worse.
- **Bounded.** Every step of the job has a bound of its own, and together they end inside the job's, so the job ends
  passed or failed, never cancelled by its own timeout, and the release that waits for it still runs. The take step
  begins no reading after 20 minutes (the lane's own bound); its record is written before the first reading and after
  each, and marked whole at its end, so a lane cut short still has what it took (and Defender's record) judged, and each
  reading it had not reached reads "not run".
- **CI's alone.** `take` registers tasks as SYSTEM and LocalService, adds a firewall rule and grants LocalService its
  work folder, so it refuses, before it makes or removes anything, a machine that is not a GitHub-hosted runner, a work
  folder it did not make, and a `\AGMessage\Server` task it did not make (the installed node's). It is never run on the
  show laptop: lab 3 is taken there by hand.
- **What it stands in for.** The installer is the installer job's, whose file R5 reads (the lane waits for that job and is
  never held by it); the server task is U12's and the control tasks U17's (`app/machine.js`). R11 registers U17's own
  control task definition for one of two standard accounts it makes for the reading (removed with their tasks and
  profiles at its end), its action the bundle's `machine.js control` over a machine folder of the lane's: the runner has no
  install record, so each request is refused for its rights and nothing is started or stopped (a machine with an
  AGMessage install record is refused before anything is made). Each of ten rounds leaves a request with a fresh id
  in that account's inbox, runs a task that runs as the account (by its password, given to `schtasks` alone and written
  nowhere) whose probe runs `schtasks /run` of the control task, and waits for the answer to that id (`ranAs`, `for`); the
  second account's ten rounds must be refused, with no answer. R8 also reads a control task's definition back. R3′ and R8 register U12's own definition under the lane's names (R3′ runs it on demand, its boot
  trigger never firing; R8 reads it back and never runs it). R4, R7 and R12 are taken under stand-in tasks whose
  principal and settings are that definition's (`\AGMessage\Server`: LocalService under its own SID,
  `SeChangeNotifyPrivilege` only, no time limit, RestartOnFailure 3 × 1 min; `test/readings.test.js` holds them element
  for element), their actions the lane's probes, R4's starting the bundle's own watchdog in the installed channel
  (`AGM_RUNS=task`, the four folders); R13 under a task with U17's control task's principal and settings (SYSTEM, a request queued, 10 minutes at most), held to
that definition element for element, with no token. R4's `whoami /priv` and `/groups` are run by the task's action, whose token
  the watchdog and the server inherit (each is started with no token of its own); the server counts as serving only when
  health answers with the build the bundle's stamp names. R4's firewall rule is made and read back; that it matches a
  connection needs a client on another machine (Windows Firewall does not filter loopback), which is the show laptop's.
  R7's access list is read from a client's handle to the pipe (`GetSecurityInfo` on the handle, as a kernel object), else
  through .NET by the pipe's name, else both reasons are recorded; each read opens the pipe's client end and takes one of
  the server's instances. R7 also connects to the pipe through SMB at the runner's own names (`\\localhost\pipe\…`,
  `\\<name>\pipe\…`): a network logon, as a remote client's would be, but not a second machine. R12 runs two tasks, each with a folder of its own: one
  whose action exits 1, measured and removed, then one whose action exits 0, so a restart the first still has queued
  is never counted for the second. R1 seeds a folder per size (an empty hall; 20 halls of 10,000 messages), starts the
  bundle's watchdog on it once, unmeasured, then in each round seats a page (Socket.IO over its WebSocket, naming the
  build the hello named), stops the server at loopback with the proof of a token it made for the reading (never kept),
  starts the watchdog again the moment the old one has ended, as an upgrade's start is, and times the page back from the
  stop to its rejoin answered, trying again at the hall page's own pace (from 0.5 s, doubling to 2 s, each ±50 %, read
  from `public/reconnect.js` by its test); each round also records the watchdog's code and whether `last-stop.json`
  says the stop saved. The seeded messages are from before the busy line's window (11 minutes before), so no stop
  needs a reason typed; R1's is a plain stop, R9's the upgrade's, which also makes the way back's backup. R2 lays the newest release's payload whole, then this build over it, file by file,
  each inflated to a name of its own beside the one it replaces and renamed over it; R10 inflates `node.exe` alone into
  `%TEMP%` and runs it once, and a round counts only when it ran to exit 0. Every stand-in task and the firewall rule
  are removed at the end. A reading whose unit is not built yet reads "not run", naming the unit; that unit adds its step
  to the lane, and a test fails once its code is in the tree while a reading still waits for it.
- **The verdicts:** met; missed (over its mark, or what the miss names was found: R10 over 5 s, R12's restarts as U.5
  fears them, R13's answer not read); recorded (taken, where the mark is "recorded", and no miss found); open (taken,
  its mark waiting for another reading: R2's waits for R9's backup); not run, with why; retired.
- **The release's notes** (`tools/readings.js notes`, in the release job) say each reading that missed its mark with its
  fallback, those met, recorded, open and not run, and the lab lines as the table below records them. A lane that wrote
  nothing leaves the notes saying the readings were not taken, and a file that is not its verdicts, saying they could
  not be read; neither stops the release. The release waits for the lane to end and publishes whatever it found.
- **This paper** records a run's readings in the Measured column (the day, the build, the verdict and what was found):
  `node tools/readings.js record <the run's readings.json>`, from the run's artifact, writes each reading the run took
  and keeps the rest, and the change is committed with the run named. A lab line's record is written by hand in its
  Taken column, from what the show laptop showed. The hour-before-doors card is the installer's papers'; it takes each
  miss when it is written.

| Reading | What | Mark | A miss means | This build's lane | Measured |
|---|---|---|---|---|---|
| R1 | `gap.js` (the stop at loopback with the proof, not SIGUSR2) at an empty hall and at 20 × 10,000 | the default page back ≤ 1.5 s at the largest real hall | handoff is revisited (U.10) | taken with the bundle's own watchdog (a portable folder seeded per size): a start that settles the folder, then 3 rounds of a page seated, the stop at loopback with the proof of a token made for the reading (a stop, not an upgrade's: the backup an upgrade's stop makes is R9's, timed on its own), the next start at once and the page back at the hall page's own pace; the slowest round at the largest hall judged, as R2's and R10's are, its median said | 2026-11-03, build 0.6.0-dev.78+442583d: ✕ missed: at an empty hall: page back median 1.31 s, slowest 2.20 s over 3 rounds; at 20 halls × 10,000: page back median 2.34 s, slowest 4.94 s over 3 rounds; every stop saved (the slowest over 1.5 s at the largest) |
| R2 | lay about 5,120 files and 188 MB over the previous payload, Defender on | ≤ 6 s together with R9 (a screen's "lost") | version folders (U.10) | taken: the zip laid on an empty folder, then 3 rounds of the newest release's payload laid whole and this build laid over it (over its own when that release's zip could not be had, said so), the slowest round judged; its mark waits for R9 | 2026-11-03, build 0.6.0-dev.78+442583d: ✕ missed: 5194 files, 181 MB laid over v0.5.1's payload, the slowest of 3 rounds 21.6 s: over 6 s alone, before R9's backup |
| R3 | retired: it was B-service's (shawl's stop under `NT SERVICE\AGMessage`), which is not the shape (U.5) | — | — | — | — |
| R3′ | the task: a stop at loopback with the proof saves and `last-stop.json` says so; the watchdog's give-up and a configuration refusal end the task with 0, and it stays stopped | 10 of 10 | the release notes name the failing case; a stop that does not save is said on "This laptop" | taken (U12, #72): U12's own server task definition (`app/machine.js`), under the lane's name and with the lane's folders, run on demand (its boot trigger never fires), its action `launch.js serve` (`AGM_RUNS=task`); 10 rounds of a stop at loopback with the proof of a token its own server made, each saving and ending the task with 0, staying stopped; the give-up and configuration refusal ending it with 0 are `launch.js serve`'s exit mapping, held on Linux (`test/machine.test.js`) | not measured |
| R4 | under the task: `LOCALAPPDATA`, `os.homedir()`, UDP 9928 broadcast heard, a quick tunnel's URL returned with nothing written in the account's profile, a rule by program, protocol and port matching `node.exe` under the task, `whoami /priv` from the server's process, `schtasks /showsid` | `SeImpersonatePrivilege` absent, and the server serves with `SeChangeNotifyPrivilege` alone | the privilege list U12 sets is widened by the one privilege the reading names, with its reason | taken under the stand-in server task, whose principal and settings are U12's own (`app/machine.js`, held element for element by `test/readings.test.js`), its action the lane's probe: the token's privileges and groups (read by the task's action, which the server inherits), the task's SID, `LOCALAPPDATA` and the home folder, health answering with this bundle's build, UDP 9928 heard from this machine, a quick tunnel and the profile before and after, a rule by program, protocol and port made and read back; a client on another machine is the show laptop's | 2026-11-03, build 0.6.0-dev.78+442583d: ✓ met: the token holds SeChangeNotifyPrivilege alone, and the server served under it in 786 ms (0.6.0-dev.78+442583d). Beside it: the task's SID in the token; UDP 9928 heard yes (from this machine); a quick tunnel's address returned; files written or changed in the account's profile 0; a rule by program, protocol and port made and read back (TCP, 3124, LocalSubnet; no client on another machine to show it matching) |
| R5 | `Get-AuthenticodeSignature` on `node.exe`, `cloudflared.exe` and the installer | the first two Valid; the installer recorded | `README.txt` names the file Windows does not trust | taken for `node.exe` and `cloudflared.exe`, and for the installer the installer job built for the run (recorded: it is unsigned; a job that built none is said) | 2026-11-03, build 0.6.0-dev.78+442583d: ✓ met: node.exe Valid (CN=OpenJS Foundation, O=OpenJS Foundation, L=San Francisco, S=California, C=US), cloudflared.exe Valid (CN="Cloudflare, Inc.", O="Cloudflare, Inc.", L=San Francisco, S=California, C=US, SERIALNUMBER=4710875, OID.2.5.4.15=Private Organization, OID.1.3.6.1.4.1.311.60.2.1.2=Delaware, OID.1.3.6.1.4.1.311.60.2.1.3=US); the installer not built yet (U13, #73) |
| R6 | over-the-shoulder elevation: U.5.1's two readings of the account that started Setup; the user's own export (U14) run through `ExecAsOriginalUser` into the laptop's admin's inbox; an elevated read of another account's `%LOCALAPPDATA%\AGMessage` | both readings name the standard account | the admin page asks the person to choose, as U.5.1 says | taken in part (U14 built): a standard account made for the reading runs the bundle's `launch.js export` (a task with its logon, as `ExecAsOriginalUser` runs it) of a stand-in portable folder into its own import folder, which `machine.js import --step stage` made with its grants; `machine.js import --step take` reads and verifies that bundle elevated; and the lane, elevated, reads a file that account made in its `%LOCALAPPDATA%\AGMessage`. The two readings of who started Setup need a standard account and an administrator's typed approval at a desktop, the show laptop's (lab 7's first account): open at best on a runner | not measured |
| R7 | the folder pipe's access list as libuv makes it (`CreateNamedPipeW(…, NULL)`, `crit-dl/pipe.c:596-599`) under the task's token, and whether a remote client reaches it | recorded | nothing machine-level writes the pipe any more (U8); the busy line's readers are named | taken: the stand-in server's folder pipe, who may read and write it, and whether a client reaches it through SMB at the runner's own names (a network logon on one machine; a second machine is the show laptop's) | 2026-11-03, build 0.6.0-dev.78+442583d: ✓ recorded: read: Everyone, Anonymous, SYSTEM, LOCAL SERVICE, Administrators; write: SYSTEM, LOCAL SERVICE, Administrators (1 pipe); through SMB at this machine's own names (a network logon; no second machine): \\localhost connected, \\runnervmhao91 connected |
| R8 | `icacls C:\` and `icacls %ProgramData%` (may a standard account create `C:\node_modules` or `%ProgramData%\AGMessage`?); `schtasks /query /xml` of each task as a standard account: readable or not, and no secret in it | recorded | U11 and U12's order already assume the worst | taken: both access lists, read by SID (`icacls /save`); U12's server task definition (`app/machine.js`), registered under the lane's folder and never run, its descriptor read back (may a standard account read it?) and its XML searched for a secret; U17's control task definition the same way, for the lane's own account (may that account read and run it, and another standard account not?) | 2026-11-03, build 0.6.0-dev.78+442583d: ✓ recorded: C:\: a standard account may create a folder (Authenticated Users); C:\ProgramData: a standard account may create a folder (Users); the tasks' definitions as a standard account wait for U12 (#72) and U17 (#74) |
| R9 | the upgrade backup's time at an empty hall and at 20 × 10,000 | recorded, beside R2 | as R2 | taken (U12, #72): the bundle's own watchdog serves a seeded folder (empty, and 20 × 10,000), the stop at loopback with the proof carries reason `upgrade` (the seeded messages are from before the busy window, so no reason is typed), the server backs the folder up for the way back (`app/lib/upgradebackup.js`), and `last-stop.json` names its time | not measured |
| R10 | extracting `node.exe` to `%TEMP%` for each machine command, Defender on | recorded | over 5 s: an upgrade runs its checks with the installed `node.exe` | taken: 5 rounds, each extracted from the zip and run once, the slowest judged against 5 s; a round that did not run to exit 0 is said, and measured no command | 2026-11-03, build 0.6.0-dev.78+442583d: ✓ recorded: the slowest of 5 rounds 4.06 s (extracted, then run once): within 5 s |
| R11 | a control task whose descriptor gives one standard account read and execute: that account runs it with `schtasks /run`; a second standard account is refused; the task runs as SYSTEM with `--for` that account's SID | 10 of 10 | the Start menu's acts fall back to an administrator's approval, and the release notes say so | taken: U17's control task (`app/machine.js`) for one of two standard accounts the lane makes, its action the bundle's `machine.js control`; ten runs from a task as that account, each answer read for `ranAs` and `for`, and ten from the second account, each to be refused; the accounts, their tasks and profiles removed | not measured |
| R12 | RestartOnFailure on the server task: does a non-zero exit of the action start it again, and does exit 0 leave it stopped | recorded | U.5's second cost reads as measured | taken under two stand-ins with the server task's principal and settings (U12's own, `app/machine.js`, held element for element by `test/readings.test.js`), one whose action exits 1, then one whose action exits 0; a non-zero exit not started again, or a 0 started again, is the miss | 2026-11-03, build 0.6.0-dev.78+442583d: ✕ missed: a non-zero exit was not started again within 150.8 s; exit 0 left it stopped within 90.4 s |
| R13 | from a control task as SYSTEM, `api.github.com`'s release answer for a published tag: `immutable` and each asset's `digest` read; with no network, the words | recorded | U18's offline words are the ones shown | taken online from a task with U17's control task's principal and settings (SYSTEM), for the newest release published (a refusal for the runner's rate limit reads "not run"); with no network, once U18 (#77) has its words | 2026-11-03, build 0.6.0-dev.78+442583d: ✓ recorded: read in 261 ms: v0.5.1 not immutable (U16, #78, turns immutable releases on), 3 of 3 assets with a SHA-256 digest; with no network, the words wait for U18 (#77) |

R7's `crit-dl/pipe.c:596-599` is the plan's reading of libuv's `src/win/pipe.c`, where the folder's pipe is made with no
security attributes, so Windows gives it the default descriptor for the token that makes it.

**The lab lines** run on the show laptop (Windows 11) and are never replaced by a reading of the runner, which has no
Modern Standby, no Smart App Control and no lid. Each is the plan's line, word for word, with the pass it names
("recorded" where it names none). Each reads "not run" until it is taken there; its Taken cell then says the day, the
build and what the laptop showed, and the release's notes read it from here. They inform the release as the readings do.

| Lab | What | Pass | Taken |
|---|---|---|---|
| Lab 1 | lid closed and idle-out, on mains and on battery, with and without U9's power request. Serving after, sleeps recorded, no kill | Serving after, sleeps recorded, no kill | not run |
| Lab 2 | Fast Startup's Shut down, then power on, under the task. Fast Startup keeps session 0 across a Shut down (https://learn.microsoft.com/en-us/windows/win32/power/system-power-states), so the server should be resumed, not restarted (inferred). Pass: no kill | no kill | not run |
| Lab 3 | R2, R9 and R10 with the laptop's own Defender | recorded | not run |
| Lab 4 | Smart App Control, evaluating and then enforcing: which of `node.exe`, `cloudflared.exe`, the installer and the .bat run | recorded | not run |
| Lab 5 | a Windows restart and a shutdown with the server busy, under the task (expected: ended unsaved, U.5) and for the portable copy (console close). What `last-stop.json`, the next start's words and the audit head say | recorded | not run |
| Lab 6 | an upgrade during a rehearsal, PlayMap's L11 for AGMessage: stop to health, and pages back | recorded | not run |
| Lab 7 | the laptop's admin as a standard account: Show the admin token, Start, Stop with a reason, Upgrade (online and offline) and Go back; then the same from a second standard account given `start` and `stop` only, and from a third given nothing | recorded | not run |
