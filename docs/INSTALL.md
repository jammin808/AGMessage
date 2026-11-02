# AGMessage installed on a Windows PC

*Begun with 0.6.0's start window; the installer's units (`docs/plan/0.6.0/PLAN.md` Part 6, U.9) write the rest of this
paper. No build installs AGMessage yet: until the installer ships, AGMessage runs as the portable folder only
([README.txt](../README.txt)). What is here is what the server and the portable folder's .bat already do about an
installed AGMessage.*

## It opens no browser and has no window

The installed node is a startup task in Windows' session 0: it starts with Windows, with nobody signed in, and nothing
it opens or draws there is seen by the person at the screen ("Services cannot directly interact with a user as of
Windows Vista", https://learn.microsoft.com/en-us/windows/win32/services/interactive-services).

- **No browser.** The server opens one only in the portable channel (`AGM_RUNS` unset or `portable`, `lib/startup.js`),
  when the .bat asks (`AGM_OPEN=1`). The installed node's channel is `task`: it never opens one, whatever `AGM_OPEN`
  holds.
- **No window.** What a portable copy says in its window, the installed node says on its console, which its watchdog
  keeps in `data\logs\server.log` (What it says, kept, below). The admin page's "This laptop" says what it knows and
  what Windows says; Open AGMessage and AGMessage status in the Start menu show the log's tail once the installer's
  units bring them.

## What it says, kept, and "This laptop"

- **`data\logs\server.log`** (`supervise.js`, `lib/serverlog.js`). The watchdog reads its server's output through a
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
  internet link, before this start (the watchdog's line for the run it restarted, or its record of a refused start or a
  give-up), and what the start goes without. A read of them that fails (an adapter list the system refuses) is one row
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

## A port already in use

The installed node reads `http://127.0.0.1:<PORT>/api/health` once, within a second, sending no token. Only the
holder's version, build and channel choose the words, and nothing is decided on them:

- an AGMessage answers (another copy, since the installed node runs one instance): "Another copy of AGMessage, 0.6.0
  (build …), holds port 3023. Close its window: AGMessage takes the port back on its next try."
- anything else: "Another program is using port 3023. AGMessage tries again; AGMessage status names the program's
  process."

The copy then ends with code 75, and its watchdog tries again (below).

## How it starts, and when it does not

The channel is `AGM_RUNS=task`, which the task's launcher sets (the installer's units; no build sets it yet). The
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
  14:20:11 UTC (18 min 8 s)" goes to its console, `data\watchdog.log` and `data\logs\server.log`; gaps with it awake
  less than that between (a throttled standby) are one sleep, with how many times it went. A sleep the watchdog is
  stopped in before then is said as it stops. The server is told each (one the watchdog stops in, ahead of the stop, so
  the stop saves it) and keeps it with the show day's peaks (`peaks.json`: each day's count and longest, and the newest
  20 whole), so a restart keeps them: health's `sleeps`, the admin page's peaks and "This laptop"'s Sleeps row.
- **The power request** (`lib/power.js`). While a hall is live, the server holds a power request. A hall is live while
  it has an open page seated in it, idle or not (a Board reading quietly through a long session is a live show, so a
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
  task may write, this PC's AGMessage admin and the accounts it gives `token` may read).
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
  that holds every program `app/` runs to its absolute path (the plan's U11) names this `reg.exe` beside `launch.js`'s
  `schtasks.exe`.
- **The first admin account** is made with the token, as on every AGMessage: `/api/setup` takes it typed, or the
  token's sign-in made by this run, at the laptop, and never loopback alone (`docs/ACCOUNTS.md`, The first admin).

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

## A portable copy on a PC where AGMessage is installed

- `start-agmessage.bat` reads the install record (`Version` under `HKLM\SOFTWARE\AGMessage`, in the 64-bit view,
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
  job has built the zip; its checkout keeps no credential (the stand-in tasks run the bundle's code from that folder).
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
- **What it stands in for.** The server task, the control tasks and the installer are later units'. Until they land, R4,
  R7 and R12 are taken under stand-in tasks with the server task's principal and settings (`\AGMessage\Server`:
  LocalService under its own SID, `SeChangeNotifyPrivilege` only, no time limit, RestartOnFailure 3 × 1 min), R4's
  action starting the bundle's own watchdog in the installed channel (`AGM_RUNS=task`, the four folders); R13 under a
  stand-in task as SYSTEM, with no token. R4's `whoami /priv` and `/groups` are run by the task's action, whose token
  the watchdog and the server inherit (each is started with no token of its own); the server counts as serving only when
  health answers with the build the bundle's stamp names. R4's firewall rule is made and read back; that it matches a
  connection needs a client on another machine (Windows Firewall does not filter loopback), which is the show laptop's.
  R7's access list is read from a client's handle to the pipe (`GetSecurityInfo` on the handle, as a kernel object), else
  through .NET by the pipe's name, else both reasons are recorded; each read opens the pipe's client end and takes one of
  the server's instances. R7 also connects to the pipe through SMB at the runner's own names (`\\localhost\pipe\…`,
  `\\<name>\pipe\…`): a network logon, as a remote client's would be, but not a second machine. R12 runs two tasks, each with a folder of its own: one
  whose action exits 1, measured and removed, then one whose action exits 0, so a restart the first still has queued
  is never counted for the second. R2 lays the newest release's payload whole, then this build over it, file by file,
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
| R1 | `gap.js` (the stop at loopback with the proof, not SIGUSR2) at an empty hall and at 20 × 10,000 | the default page back ≤ 1.5 s at the largest real hall | handoff is revisited (U.10) | not run: needs U8 (#36), the stop at loopback with the proof | not measured |
| R2 | lay about 5,120 files and 188 MB over the previous payload, Defender on | ≤ 6 s together with R9 (a screen's "lost") | version folders (U.10) | taken: the zip laid on an empty folder, then 3 rounds of the newest release's payload laid whole and this build laid over it (over its own when that release's zip could not be had, said so), the slowest round judged; its mark waits for R9 | 2026-11-02, build 0.6.0-dev.74+583f341: ✕ missed: 5179 files, 181 MB laid over v0.5.1's payload, the slowest of 3 rounds 18.5 s: over 6 s alone, before R9's backup |
| R3 | retired: it was B-service's (shawl's stop under `NT SERVICE\AGMessage`), which is not the shape (U.5) | — | — | — | — |
| R3′ | the task: a stop at loopback with the proof saves and `last-stop.json` says so; the watchdog's give-up and a configuration refusal end the task with 0, and it stays stopped | 10 of 10 | the release notes name the failing case; a stop that does not save is said on "This laptop" | not run: needs U4 (#34), U8 (#36) and U12 (#72) | not measured |
| R4 | under the task: `LOCALAPPDATA`, `os.homedir()`, UDP 9928 broadcast heard, a quick tunnel's URL returned with nothing written in the account's profile, a rule by program, protocol and port matching `node.exe` under the task, `whoami /priv` from the server's process, `schtasks /showsid` | `SeImpersonatePrivilege` absent, and the server serves with `SeChangeNotifyPrivilege` alone | the privilege list U12 sets is widened by the one privilege the reading names, with its reason | taken under the stand-in server task (U12, #72, puts its own task in its place): the token's privileges and groups (read by the task's action, which the server inherits), the task's SID, `LOCALAPPDATA` and the home folder, health answering with this bundle's build, UDP 9928 heard from this machine, a quick tunnel and the profile before and after, a rule by program, protocol and port made and read back; a client on another machine is the show laptop's | 2026-11-02, build 0.6.0-dev.74+583f341: ✓ met: the token holds SeChangeNotifyPrivilege alone, and the server served under it in 792 ms (0.6.0-dev.74+583f341). Beside it: the task's SID in the token; UDP 9928 heard yes (from this machine); a quick tunnel's address returned; files written or changed in the account's profile 0; a rule by program, protocol and port made and read back (TCP, 3124, LocalSubnet; no client on another machine to show it matching) |
| R5 | `Get-AuthenticodeSignature` on `node.exe`, `cloudflared.exe` and the installer | the first two Valid; the installer recorded | `README.txt` names the file Windows does not trust | taken for `node.exe` and `cloudflared.exe`; the installer once U13 (#73) builds it | 2026-11-02, build 0.6.0-dev.74+583f341: ✓ met: node.exe Valid (CN=OpenJS Foundation, O=OpenJS Foundation, L=San Francisco, S=California, C=US), cloudflared.exe Valid (CN="Cloudflare, Inc.", O="Cloudflare, Inc.", L=San Francisco, S=California, C=US, SERIALNUMBER=4710875, OID.2.5.4.15=Private Organization, OID.1.3.6.1.4.1.311.60.2.1.2=Delaware, OID.1.3.6.1.4.1.311.60.2.1.3=US); the installer not built yet (U13, #73) |
| R6 | over-the-shoulder elevation: U.5.1's two readings of the account that started Setup; the user's own export (U14) run through `ExecAsOriginalUser` into the laptop's admin's inbox; an elevated read of another account's `%LOCALAPPDATA%\AGMessage` | both readings name the standard account | the admin page asks the person to choose, as U.5.1 says | not run: needs U13 (#73) and U14 (#75) | not measured |
| R7 | the folder pipe's access list as libuv makes it (`CreateNamedPipeW(…, NULL)`, `crit-dl/pipe.c:596-599`) under the task's token, and whether a remote client reaches it | recorded | nothing machine-level writes the pipe any more (U8); the busy line's readers are named | taken: the stand-in server's folder pipe, who may read and write it, and whether a client reaches it through SMB at the runner's own names (a network logon on one machine; a second machine is the show laptop's) | 2026-11-02, build 0.6.0-dev.74+583f341: ✓ recorded: read: Everyone, Anonymous, SYSTEM, LOCAL SERVICE, Administrators; write: SYSTEM, LOCAL SERVICE, Administrators (1 pipe); through SMB at this machine's own names (a network logon; no second machine): \\localhost connected, \\runnervmhao91 connected |
| R8 | `icacls C:\` and `icacls %ProgramData%` (may a standard account create `C:\node_modules` or `%ProgramData%\AGMessage`?); `schtasks /query /xml` of each task as a standard account: readable or not, and no secret in it | recorded | U11 and U12's order already assume the worst | taken: both access lists, read by SID (`icacls /save`); the tasks' definitions as a standard account once U12 (#72) and U17 (#74) make them | 2026-11-02, build 0.6.0-dev.74+583f341: ✓ recorded: C:\: a standard account may create a folder (Authenticated Users); C:\ProgramData: a standard account may create a folder (Users); the tasks' definitions as a standard account wait for U12 (#72) and U17 (#74) |
| R9 | the upgrade backup's time at an empty hall and at 20 × 10,000 | recorded, beside R2 | as R2 | not run: needs U8 (#36) and U12 (#72), the upgrade's stop and its backup | not measured |
| R10 | extracting `node.exe` to `%TEMP%` for each machine command, Defender on | recorded | over 5 s: an upgrade runs its checks with the installed `node.exe` | taken: 5 rounds, each extracted from the zip and run once, the slowest judged against 5 s; a round that did not run to exit 0 is said, and measured no command | 2026-11-02, build 0.6.0-dev.74+583f341: ✓ recorded: the slowest of 5 rounds 2.73 s (extracted, then run once): within 5 s |
| R11 | a control task whose descriptor gives one standard account read and execute: that account runs it with `schtasks /run`; a second standard account is refused; the task runs as SYSTEM with `--for` that account's SID | 10 of 10 | the Start menu's acts fall back to an administrator's approval, and the release notes say so | not run: needs U17 (#74) | not measured |
| R12 | RestartOnFailure on the server task: does a non-zero exit of the action start it again, and does exit 0 leave it stopped | recorded | U.5's second cost reads as measured | taken under two stand-ins with the server task's settings (U12, #72, puts its own task in their place), one whose action exits 1, then one whose action exits 0; a non-zero exit not started again, or a 0 started again, is the miss | 2026-11-02, build 0.6.0-dev.74+583f341: ✕ missed: a non-zero exit was not started again within 150.7 s; exit 0 left it stopped within 90.5 s |
| R13 | from a control task as SYSTEM, `api.github.com`'s release answer for a published tag: `immutable` and each asset's `digest` read; with no network, the words | recorded | U18's offline words are the ones shown | taken online from the stand-in SYSTEM task (U17, #74, puts a control task in its place), for the newest release published (a refusal for the runner's rate limit reads "not run"); with no network, once U18 (#77) has its words | 2026-11-02, build 0.6.0-dev.74+583f341: ✓ recorded: read in 192 ms: v0.5.1 not immutable (U16, #78, turns immutable releases on), 3 of 3 assets with a SHA-256 digest; with no network, the words wait for U18 (#77) |

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
