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
  (`Get-NetFirewallApplicationFilter -Program`, in this PC's own policy store, every rule judged, a block rule winning
  over an allow; past 512 the reach is unknown). It does not see a rule a domain's policy sets, a rule by port alone,
  or a profile whose firewall is off, and `-Program` reads a path as a pattern, so a folder whose name holds `[` or `]`
  matches no rule. Networks and rights past 32 are counted. Each line is ASCII JSON, any other character escaped, so no
  code page changes a name. None of it reaches health over HTTP, the context, the hello or the AI's brief. The Windows
  CI job runs the script at every push and checks its answer's shape (`test/laptop.test.js`: each part read, or refused
  with Windows' reason; the task and the record missing on a runner; the read's time said); what it reads on a show
  laptop is unread until a walk.
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
