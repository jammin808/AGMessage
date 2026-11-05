# AGMessage

Messages, files and screens for every hall of a live event — the crew in each operating room, the project managers
who look after every hall, the presenters and board members on stage — on any phone, tablet or laptop on the venue
network (or remotely through the built-in Cloudflare tunnel). One portable Windows folder, no install. Part of the
show network with [Stagewatch](https://github.com/jammin808/Stagewatch), Patterns and PlayMap.

- **Halls.** Each hall has its Main room and, if it has one, its own Stagewatch: its countdown in the header, sends to
  its speaker's screen. The admin makes rooms of its own beside it (Legal, Media) on the admin page, each with its own
  messages and people, listed under its hall, watched, renamed, cleared and removed there; the admin's reads of a room it
  is not given are in the audit log. Every room of a hall shows the hall's countdown and sends to its speaker's screen
  and its show desk, by the rights of whoever sends (an account with Stagewatch rights in the hall; a room's guests
  never), the show desk's notices reach every room, and the AI drafts in a side room from that room alone, told which
  room it is. A hall's **Set up** on the halls board lists its rooms too, the Main room first, each with its code and its
  ⋯: **+ Add room** and Rename… for those who set halls up, the code and Remove room… for the admin, done at once. **Each
  room has its own guest code**, switched on or off and renewed by the admin (the admin page's room ⋯, Set up's, or the
  header's ⋯ on the admin's own hall page): a side room's starts off, so it
  is for the admin and the accounts given it until the admin switches it on; switched off, the guests already in stay (or
  are sent out, with their seats), and nobody new joins with it; **New code** gives a room a new one, the one before it
  then admitting only a person already seated there, and the invite links made with it stop. Until a hall's code is
  renewed it is also the hall's address, which anyone with an account in it can read; the admin page says so where the
  code is shown and in its list. The laptop's token admin's own hall page gets in whether a code is on or off, and is
  never sent out with the guests. The **halls board** shows every hall an account may see — countdown, who is in, the
  last message, open help requests, its screens and its Patterns / PlayMap — live; a hall's name opens its Main room, and
  each of its side rooms the account may enter is a button on its row ("Legal 2 in"). Rooms an account is given in halls
  it does not see are listed under **Your rooms**, by their hall's name. An account with one room alone, and nothing
  else to do on the board, goes straight into it on sign-in; each room opens seated as the server seats it (a Board
  member On stage at once). **Rooms:** a hall page's header names its room ("Hall 2 › Legal") and, with two rooms or more,
  a **switcher** under it moves between the hall's rooms the person may enter, keeping what they wrote and had not sent;
  a room's right-click offers Open in a new tab, Copy link and Copy guest code. Moving between a hall's rooms writes no
  "joined" or "left" line in either room; a second device or tab opened in another room is said there. A file is posted
  only in the room it was uploaded for, by whoever uploaded it (or again in a room that already holds it): another
  room's file posted by its link is refused ("That file belongs to another room — send it from there."); it goes there
  by ↗ Send to, or by choosing the file again there. **Sending into another room:** where a room's **May send in…**
  lets this room send there (in any hall), a message or a file goes into it from the composer's **To:** (Send reads
  "Send to Legal", and "↗ to Legal — replies stay there" stays above the field, on a phone too, until it is sent) or
  from a message's **↗ Send to ▸**: one list of rooms, first those this room's lists allow (sent there, a copy kept
  here), then the rooms the person may forward into ("a forward — no withdraw"). The room it went to reads "↘ From Hall 2
  › Legal" with the sender's name and offers **↗ Send back**, whose answer lands under the question in both rooms; the
  room it came from keeps the copy, "↗ Sent to Hall 2 › Legal — delivered". **A mis-sent message is withdrawn**: on the
  copy, its sender or the admin chooses **Withdraw from Hall 2 › Legal…**, which asks first ("people there may have read
  it (it was there 40 s)"); it goes from the other room, which says who took it back, a reply there that quoted it keeps
  none of its words ("↩ Ana: ⊘ withdrawn"), and the copy stays, reading "⊘ Withdrawn from Hall 2 › Legal after 40 s". The sender may delete the copy (withdraw first: the copy is what takes it
  back), but not the message in the other room, which the admin removes there. Nothing else of the other room comes back
  (its people, its replies, its receipts), no page is told another room's key or code, a file that arrives from another
  room never opens itself on the On stage panel, and each send and each withdrawal is one audit row, never its words or a
  file's name. A list
  taken back mid-show stops the next send at once. **Help requests** go in two taps
  (Help, then Sound, Vision, Lighting, Stage, Presenter, IT / network or Something else), from any room, and stay red
  until someone is on the way and on the board until resolved. A side room's request is on the board whole for those who
  read the room, and for the hall's crew without its words ("Hall 2 › Legal · Sound"), who answer it from there. The asker's Help button says what happened ("■ Help asked", "▶ Ana is on
  the way", "✓ Resolved"), and a tap on it marks the request sorted or cancels it.
- **Accounts and codes.** Crew, project managers and admins sign in as themselves (a signed-in browser opens its halls,
  never a guest's seat); presenters and guests join with a room's 6-character code, typed first: the join page names the
  room it opens ("Legal · Hall 2") and offers that room's seats only — On stage only from an On stage invite link,
  Backstage and Observer in a hall's Main room, Member and Observer in its other rooms. A code is shown only to those who
  may know it (the admin, those who set halls up, an account whose rights already hold what the code gives, a guest the
  code it typed; never On stage, a Viewer or a Staff account in a Main room). Roles (admin, project manager,
  senior tech, tech, staff, viewer), halls per person, and single rights an admin can add or remove. An account is
  also given **side rooms** (a hall's Legal or Media, never reached by its halls, "every hall" included), **On stage**
  halls (it sits On stage in that hall's Main room, held to the seat there, and backstage everywhere else) and a **chat
  view** (by its seat, simple or full), each given only by someone who holds that room or hall themselves and never set
  on one's own account; a view changed alone reaches the account's open pages without closing them. Each signed-in
  account's halls and the halls board list the rooms it may enter, with the seat it would take in each. The **Accounts
  page** sets all three: each hall's Main room ("Hall 2 — Main room and hall rights") with **On stage (Board member)**
  beside it (a seat the account takes: it may send messages there, or the server refuses it in words) and its rooms set
  in under it, Chat view beside the role, and the rights in three groups (In the room, Show,
  Run AGMessage); its rows read "Hall 2 (Main, Legal) · On stage". A room's **Members…** (on Main, **Board members…**), on
  the admin page and in Set up, ticks the accounts that go in, for whoever manages accounts: one save per account, each
  said ("2 saved · Kim: why"), the accounts a person may not change shown and not offered. A room's **May send in…**
  (the admin's, on the admin page and in Set up) ticks, among every hall's rooms, those whose people may send into it,
  with **↔ and send back** beside each to let it send there too: one save, one audit row; a room with none ticked takes
  nothing in, and no page in a room is told the list. An **audit log**
  chained with a key, of every sign-in, change of rights, room control and screen take, and every proposal Stagewatch's
  show desk takes — never a message's text or a file's name. Its records live outside the data folder, so a cut or a log
  replaced while AGMessage is stopped is found; what this laptop cannot check reads △ until accepted at the laptop with
  its token. It is **exported signed** (Ed25519, by a key derived from the laptop's) and checked on another computer
  with a verifier that runs offline, in Node or one browser page, and it is **carried across events**: an archive point
  at each, where the admin may split the older part off into a signed archive that the check names and every export
  carries. [docs/ACCOUNTS.md](docs/ACCOUNTS.md)
- **Screens.** Every hall's screens — projector PC, lectern monitor, foyer TV — each with its own link to open in any
  browser: holding image, a message (note / soon / urgent), an image or PDF page from the hall, the hall's countdown
  with a message under it (the speaker's comfort monitor), the clock, or black. Each screen confirms what it showed.
  [docs/DISPLAYS.md](docs/DISPLAYS.md)
- **People's screens.** The Board's pages (everyone seated On stage) or one person's can be shown Stagewatch's
  countdown, the clock, a holding slide, black or a **web page** over their chat, from the header's Board chip ("Board ·
  🕐 Clock ✓ 6/6", Undo for 10 s) or the console's People's pages, each page confirming what it showed only while it is
  in view. A web page (an https address, previewed on the operator's own page first if they like) needs a right of its
  own, **Web pages** (`stage.web`: Tech, Senior and Manager accounts hold it); it opens in a sandboxed frame with no
  referrer, under a strip saying who chose it and not to type passwords there, and reads ◇ opened, never ✓, since
  AGMessage cannot see inside it. A locked hall's backstage code guests show web pages only while the admin turns on
  **Backstage guests may show web pages** for that hall (off by default; unlocking turns it off). The person keeps the
  way out: Back to chat (with Show it again for 10 s), Minimise into the side bar's 📺 On stage (Escape does that), Show
  again from there, and for a web page, in the full view, Open in a new tab; a 🔥 message breaks through, and a take never takes the focus
  from words being written. [docs/DISPLAYS.md](docs/DISPLAYS.md)
- **Messages that land.** Action prompts with tap-to-answer buttons; documents (PDF, Word, Excel, images) shared and
  pushed to the on-stage panel or to screens, PDFs on iPads from iPadOS 16.4 (pdf.js's legacy build); pins, replies,
  reactions, priority, seen receipts. The hall page fits a phone, its words and icons at WCAG AA contrast in light and
  dark. Its header is the same at every width: the room's name, its status (the connection, the countdown), Help and a
  ⋯ that holds People, Screens & pages…, the text size, the theme, the guest code and Leave, with the room switcher on a row of
  its own. Every status on every page — a screen, a help request, a send held or refused, a link, the countdown — is a
  mark of one table, each mark with one meaning, beside its word and in its colour, never the colour alone (✓ on screen
  or resolved, ◷ sending or waiting, △ could not, ✕ none or a fault, ■ waiting for someone, ▶ on the way, ▲ soon, ○ off,
  ◐ not fully seen, ◇ reached but not seen into, ▭ minimised, ⊘ withdrawn, ● a note). A new message never moves a feed you have scrolled up — "↓ 3 new" says how many came below — and a New line
  marks the first that arrived since you last touched the page, instead of a fill that fades. A sent message shows "◷
  Sending" until AGMessage has it, and is never posted twice; one written while the connection is down waits on the
  page, a reload included, and is sent when it is back, marked with its wait ("written 14:02 · sent 14:06 (offline)").
  Every change is numbered and written to an append-only log before it is answered: a phone that drops off the Wi-Fi
  catches up with just what it missed, and a crash of AGMessage or of a browser loses nothing; a power cut can lose the
  last few seconds (what AGMessage has taken is in the system's file cache at once, and on the disk once the system
  writes it back). A change the disk will not take (a full disk, a log another program holds) is kept in memory, named
  on the admin page's health and put in the hall's next snapshot; until that snapshot lands, a crash of AGMessage can
  lose it. A stop saves the audit log and the settings first, then only the halls that changed, and records that it
  saved; the start after it rewrites nothing, and a hall reads "AGMessage restarted" only after a stop that did not save
  (a crash, the laptop switched off), as the admin page's This laptop says. A watchdog restarts the server after a crash
  or a hang, and tells a hang from a sleep: a wake from the laptop's sleep is recorded ("asleep from … to …"), never
  killed or counted as a crash, and while a hall is live (a page open in it, a screen showing a take, its countdown
  running) the server asks Windows to keep the laptop from its idle sleep (the lid and the power button stay the power
  plan's). Every open page comes back by itself, without a
  reload: after a drop (at once when a phone is woken or the Wi-Fi is back), after a restart (announcing nobody), and
  after a refusal at a busy moment, at the pace the server gives ("Busy — trying again in 3 s."). After an upgrade
  each page reloads onto the new build by itself at a quiet moment of its own (a hall page with nothing typed and
  unsent and no dialog open, a screen between takes, the admin page when its admin agrees), its scripts checked with
  the server at every load; 0.5's pages are told to reload 5 minutes after the start, and 0.5's screens are named on
  the admin page to reload by hand. The admin page's
  health reads the server's true delay and how busy it is, and keeps the peaks of each show day for 14 days, through a
  restart or a shutdown, so one look after a show says how it ran. A start that cannot run says why and stops, never
  looping: a folder it cannot make or read, a second copy on the same folder or port (whose server has written nothing;
  its watchdog logs the refusal; on the same folder it says how busy the running copy says it is). This PC's own
  commands ask the server at loopback how busy it is (a message or other input, a take or a help request in the last 10
  minutes, a restart between them or not, or a countdown running; open seats and screens never) and stop it, saved, with a proof of the admin token that never
  crosses the socket: a busy server stops only with a reason a person typed, which the audit log keeps. A key, certificate or settings file it cannot read is never made again or saved over:
  the copy says what it goes without this run, refuses a setting changed meanwhile with why, and serves on, and a laptop
  out of file handles loses a connection, not the server. What the window says is kept in `data/logs/server.log`
  (rotated at 2 MB, two files at most, never the admin token), with the server's own words in the watchdog's line for a
  start it refused, and the admin page's **This laptop** says what AGMessage knows of the laptop it serves from — the
  build and how it runs, the addresses, HTTPS and why it is off, the sealed values that open, the screens confirmed,
  Stagewatch, the internet link, the sleeps the watchdog recorded and whether the laptop is kept awake — and what Windows
  says (the network's profile and whether the firewall lets this
  AGMessage in on it, sleep and the lid on mains, the server task, the laptop's admin and the rights given), each fact
  with where it was read, and "unknown" with why where it could not be. A certificate due for renewal is not renewed at
  a start that has no network address, so it never names none: it serves on, and This laptop says when New certificate
  renews it. The installed node's next start says why the start before was refused.
- **Right-click.** Every act on a message, on a file in the panel, on a screen, on a person (a sender's name, a row of
  People: @ Mention), on the composer's Send (✨ Draft a reply, 🔥 Priority, Attach a file…, Cancel the reply), on the
  header (its ⋯: People, Screens & pages…, Text size, Dark theme, Copy guest code, Copy join link, for the admin Turn the code
  off… or on and New code…, and Leave, or All halls for an account), on its countdown (Speaker's screen…, Show the
  countdown on screens) and its Board chip (Back to chat, Show Stagewatch, the clock, holding or blank, Show a web page…,
  ↶ Back to, Screens & pages…), on a take shown to you (Back to chat, Minimise, Full screen, and in the full view Open in
  a new tab for a web page) and its card (Show again, Remove), and on a person for whoever may show people's pages (📺 Show them ▸, Show
  them a web page…, Back to chat on their pages)
  is on its ⋯ (the countdown is its own), its right-click and Shift+F10 (or the menu key) — one list, drawn from one
  catalogue, so the buttons and the menus never disagree. A message keeps two acts on its row: ↩ Reply and the one the
  seat uses most (Ask the operator, Send now or Show on screens). What a seat may not do is not offered; what it cannot
  do now is greyed with the reason. Keys on a message with the focus: R reply, E react, F send to, P pin (with Undo), D
  download, Enter look, Delete delete. The hall page's first Tab is a skip link to the message box (or the messages), its
  feed is one Tab stop (↑ and ↓ between messages; ↑ from an empty message box goes to the newest, Escape comes back),
  and what an act did is said in one toast a screen reader hears. What reaches other people for good asks in place,
  naming what it acts on: no page opens a browser dialog, which would pause the page and drop its connection.
  Shift+right-click keeps the browser's own menu. The admin page, the halls board and the
  Accounts page act the same way: a hall, a person, a message of the live feed, a linked Patterns or PlayMap, the
  internet link, a help request, an account and an entry of the audit log each have their ⋯, right-click and
  Shift+F10, and each of these pages has a skip link and lists that are one Tab stop (↑ and ↓ between their rows).
- **The Board.** People On stage read, reply, answer the backstage team's questions, send 🔥 Priority and ask for help,
  and mark their own help request sorted; what they write stays in their room, where the backstage team reads it. They
  never share files, ask questions, forward or send anything into another room or answer other people's help requests: the
  server refuses each by the seat, for the admin and an account seated On stage too. An account seated On stage in a
  hall answers none of that hall's help requests from its halls board either, but marks its own sorted.
- **The Board's chat view.** A page seated On stage draws the simple view, chat first and compact, unless the admin
  chooses Full for that person (a guest's choice kept by their device, an account's on the account; Chat view on the
  admin page's people rows, in the hall page's People panel for the admin, and on the Accounts page). One reading column
  of messages with no card and no badge; one response place per screen: **👍 Got it** and **↩ Reply** after the words of
  the newest message from backstage that waits for this person ("Got all 3" when three wait) and of each waiting 🔥
  message, and a tap on any other message brings its own row back. Got it tells the backstage team, with the name ("👍
  Margaret got it" on their page), and the message reads "👍 You: got it". A question's answers are 48 px, with
  **Answer in words…**; once answered it reads "You answered Yes · 14:10 · Change". A 🔥 message out of view is held in a
  strip above the chat (and on a take's strip, with Got it beside Open chat); "↓ 3 new · 1 question" below a chat scrolled
  up; "○ Nobody backstage is online" when no one backstage has been in the room for 10 s. The composer is **🔥 Priority**,
  "Message everyone here…" and Send, and keeps its words when a send is refused. The header holds the hall's name, Help
  and ⋯, whose sheet holds Text size, Theme, Full screen (where the device offers it), why the device may sleep, and Leave
  the hall, asked in place. It **starts in Dark** until the person chooses Light, and paints dark before its first frame
  on a device last used there; the admin's support view never turns it light. It works on iPads old and new, Android
  tablets and phones, upright or sideways: the Shown to you column at 900 px wide or more and two tabs, Chat and 📺 Shown
  to you, below; 22 px text on a tablet and 20 px on a phone. Only Tab, Enter and Escape act on it, and it opens no menu.
- **Remote phones.** Through the built-in Cloudflare tunnel, up to 150 at once — a Quick Tunnel's 200 in-flight
  requests, less room for page loads and files — and half of them at most from one network (an IPv6 phone counted by
  its /64, so a phone that changes its address is still one network). A page that has not joined a room within 20 s
  gives its place back. A phone refused is told what and for how long ("AGMessage's internet link is full (150 phones).
  Trying again in 34 s. On the venue's Wi-Fi there is room.") and comes back by itself; the venue's Wi-Fi never waits for
  the tunnel. The admin page counts the places, the networks and the day's refusals, and checks the link from the laptop
  before the show ("Checked 14:02 · round trip 85 ms (max 140 ms)"). Turned on, the link stays on until the end of the
  show day (06:00 by the laptop's clock, the next day's when that is under an hour away), or the time Tunnel until…
  sets, then turns off and stays off; a restart of AGMessage before then turns it on again, and since a quick tunnel's
  address is new at each start, the admin page says "New address" and gives it (or, when cloudflared cannot reach
  Cloudflare, says it was not turned on again, and the next start or Turn on tries again). For a show with remote
  people, a named Cloudflare Tunnel keeps one address throughout.
- **Devices.** The Board's mixture — iPads, Android tablets and phones — from iPadOS and iOS 14.5 and Chrome 84 (PDFs
  from iPadOS 16.4 and Chrome 103). An older browser is told so in one line and opens nothing, so it never joins a hall
  half working. A newer feature a device lacks has a fallback chosen by what the browser has, never by what it calls
  itself: a dialog opens where the browser has no `showModal()`, and each of the stylesheet's newer rules follows one
  every device from the floor reads. [docs/DEVICES.md](docs/DEVICES.md) holds the matrix of devices, each fallback, and
  the walk on the owner's devices before the release.
- **The show network (Show Bus 1.2).** Send to Stagewatch — straight to the speaker's screen, or to the operator to
  approve and pass on to the confidence monitor, a moderator, backstage or interpreter screen, a department, or keep.
  A line reads as it was typed: cut on a whole character where Stagewatch cuts, its braces as parentheses so Stagewatch
  never fills them in as its own placeholders, a department named as Stagewatch names it, and each send audited.
  A Stagewatch link is connected, and its certificate pinned, only once Stagewatch accepts AGMessage's key; a refused
  key says so on every page and never locks the laptop out. Patterns and PlayMap linked: their state on the board, and
  the verbs they list proposed to the show desk. Their pairing token goes only to this laptop or over HTTPS to a
  certificate a person confirmed.
  [docs/NODES.md](docs/NODES.md)
- **AI drafts (optional, Claude).** Answers for the backstage team from the thread and the document on stage, buttons
  for action prompts, the minutes — always a draft a person edits and sends. Everything else works offline.
- **Secure by default.** Encrypted connections (HTTPS on the same port, `/tls` to trust it), pinned links between show
  systems, sealed keys, a strict Content-Security-Policy, uploads checked by content, rate limits and lockouts. It
  loads only what it ships (never a module from a folder above `app`, where another account may have planted one) and
  runs only what it names by its absolute path: its own `bin\cloudflared.exe`, and Windows' programs under `SystemRoot`.
  [SECURITY.md](SECURITY.md) · [docs/DESIGN.md](docs/DESIGN.md)

## Run it

Download the portable zip (`AGMessage-Portable-<version>.zip`) from a release (or a CI run's artifacts), Extract All, and
double-click `start-agmessage.bat` in the `AGMessage` folder it extracts (run from inside the zip it finds nothing beside
it, and says so). The browser opens on `http://localhost:3023` once that copy serves, to make the first admin account
with the token its window shows (the token is printed only in a console window, never into output kept in a file). A
start that cannot run says why in its window: a file missing beside the .bat, or who holds the port. Full instructions:
[README.txt](README.txt).

## Versions

One scheme for every build (`app/lib/version.js`): `app/package.json` names the version, CI stamps the build number and
commit. A release reads `0.5.0+17.abc1234`, a CI development build `0.5.0-dev.17+abc1234`, a local copy
`0.5.0-dev+abc1234`. The console window, `/api/health`, the admin page and the Show Bus hello say which build runs; the
zip is named by it. Each open page names the build that served it (`/build.js`), and the admin page's This laptop lists
any page or screen on another. "Newer" is MAJOR.MINOR.BUILD (the stamp's `installVersion`, `0.6.41`; a local copy has
none). A tag `vX.Y.Z` publishes a release only when it names `app/package.json`'s version and that version is above
every release already published and every other version tagged, so among releases SemVer and MAJOR.MINOR.BUILD agree.
The data folder says which build and format last wrote it (`data/format.json`): a folder of a higher format is refused,
a 0.5 folder is copied into `data/backups/` before it is moved, and a newer build before this one is said on the admin
page (README.txt, Upgrading). Changes: [CHANGELOG.md](CHANGELOG.md).

## Develop

Node.js 24 LTS (`app/package.json` → `engines`).

```
powershell -ExecutionPolicy Bypass -File tools\fetch-runtime.ps1   # Node 24 + cloudflared, pinned and checksum-verified
cd app
npm ci
npm run check     # the analyzers, the secret scan, every test with the coverage gate
npm test          # the tests alone (a real server on a throwaway data folder for the end-to-end ones)
npm run smoke     # the browser smoke: Edge, Chrome or Chromium (AGM_BROWSER=<path>)
npm run audit     # the shipped packages' advisories and registry signatures, and the vendored libraries' advisories
```

A checkout runs the same programs a portable copy does, by the same paths: the internet link runs only `bin/cloudflared`
(`bin\cloudflared.exe` on Windows, which `fetch-runtime.ps1` puts there) beside `app`, never a cloudflared on `PATH`,
and without it Turn on is refused, saying cloudflared was not found.

The analyzers are fences: ESLint with the security rules, a banned-call list and a rule that refuses unescaped values on
their way into a page's HTML ([docs/ANALYSIS.md](docs/ANALYSIS.md)). CI runs them, the tests on Linux (Node 24 and 26)
and Windows, the browser smoke on both, CodeQL and the dependency audit; it builds the stamped zip with its SBOM (npm's
packages and the browser libraries vendored in `app/public/vendor`, each with its SHA-256) and SHA256SUMS on every push,
extracts it and starts the bundle once (its own Node and watchdog must answer `/api/health` with the stamped build
within 30 s), runs both .bat files under cmd on Windows, and a `v*` tag publishes a release with a build-provenance
attestation, its notes saying each reading that missed its mark. For every push, a tag and a run asked for by hand
(Actions, CI, Run workflow), it takes the Windows readings of that zip on `windows-2025` with Defender's real-time
monitoring turned back on first (the evidence lane, its actions pinned by commit: what each reading is, its mark and
what a miss means are in [docs/INSTALL.md](docs/INSTALL.md)), one lane at a time per branch, never cancelled once it
runs: a newer push's waits its turn. The readings inform a release and never hold it. A CI run's development build is the artifact named
`AGMessage-Portable-<version>.zip`: the zip itself, to Extract All as a release's. `tools\build-portable.ps1` builds the
zip locally.

The libraries the pages use (pdf.js, mammoth, SheetJS and what each bundles) are listed with their licences in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md), their texts in `licenses/`, and file by file, with each file's
source and SHA-256, in `app/public/vendor/VENDOR.json`, which a test holds the folder to.

Event data (`app/data`, `app/uploads`) is never committed or packaged. The agent brief for working on this tree is
[CLAUDE.md](CLAUDE.md).
