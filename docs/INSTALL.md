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

Trying again is the installed node's own start rule, which the installer's units bring with the channel itself.

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
