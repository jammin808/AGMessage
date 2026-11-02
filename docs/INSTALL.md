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
- **No window.** What a portable copy says in its window, the installed node says on its console, which its log keeps.
  Open AGMessage and AGMessage status in the Start menu, and the admin page's "This laptop", are where those words are
  read, the port-holder words below included, once the installer's units bring them.

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
  watchdog writes there first: the data folder itself, and `watchdog.log`'s line for how the start ended.
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
