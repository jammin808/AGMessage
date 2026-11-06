# Security

AGMessage runs on a show laptop and carries what a board, a crew and a venue say to each other, and what their screens
show. This page says how to report a problem, which builds are supported, and what the project checks on every change.

## Reporting a vulnerability

Please report it privately: GitHub → this repository → **Security → Report a vulnerability** (private advisory), or
email the maintainer. Say what you found, the build (`/api/health` → `build`, e.g. `0.5.0+17.abc1234`) and how to see
it. Please do not open a public issue for a vulnerability. You will hear back within a week; a fix for a confirmed
problem ships as a patch release, with credit if you want it.

## Supported builds

| Build | Supported |
|---|---|
| The newest release (`vX.Y.Z` on GitHub Releases) | yes |
| The release before it | security fixes only, for 90 days after the newer one |
| Development builds (`X.Y.Z-dev.N+sha`) and local copies (`X.Y.Z-dev`) | no — they are previews of the next release |

## What is checked on every change

`docs/ANALYSIS.md` has the detail. In short: ESLint with the security rules and the house's banned calls as build
fences; a rule that refuses unescaped values on their way into a page's HTML; a module fence that holds the server's
layers and closes the wire's words both ways; an in-tree secret scan; CodeQL (`security-extended`); `npm audit` with
registry signatures and provenance; dependency review on pull requests; the tests, the coverage gate and the browser
smoke on Linux and Windows. A release is published only when its version is above every release before it and every other
version tagged, so the newest release is always the highest number, by its version and by its build. A release carries its SBOM (CycloneDX), `SHA256SUMS` and a build-provenance attestation
(`gh attestation verify <zip> --repo <owner>/AGMessage`). The SBOM lists npm's packages and the browser libraries
vendored in `app/public/vendor`, each of those with its file's SHA-256 and the libraries bundled in it, read from the
bundle as the zip extracts it. Each vendored file is its package's file byte for byte, listed in
`app/public/vendor/VENDOR.json` with where it came from, its package's digest and its SHA-256; a test fails the build on
a file not listed, bytes that differ, a file no page loads, or a licence that is not one of those allowed, and the
SBOM's job stops on a shipped file whose bytes are not the ones listed, or a bundle without the list, the notices and
every licence text. Their licences ship in `THIRD-PARTY-NOTICES.md` and `licenses/`.

`npm audit` cannot see the vendored libraries, which are in no lockfile. `tools/vendor-audit.js` (part of `npm run
audit`, and a step of the Security workflow's weekly run) asks npm's registry for the advisories against every version
`VENDOR.json` lists, the libraries bundled inside each file included, and fails on a high or critical one `VENDOR.json`
does not assess. Each assessment says whether the advisory applies here, why, and what bounds it, and the SBOM carries
it as that vulnerability's analysis. The one that applies today: the XML parser inside mammoth (xmldom 0.8.6, which
mammoth 1.13.0, its newest release, still bundles) can be kept busy for a long time, or run short of memory, by a
crafted Word file. mammoth runs only in the page's document worker, which the page ends 15 s after it starts (or as
soon as the document is closed), and is handed only a file that passed the archive check with no entry declaring a
document type or an entity, so such a file costs the worker of the page that opens it its 15 s and the page goes on; the
server and other pages are not affected.
`THIRD-PARTY-NOTICES.md` lists each advisory and its assessment.

## Recommended repository settings

Turn on GitHub's secret scanning with push protection, Dependabot alerts and security updates, private vulnerability
reporting, and branch protection on `main` requiring the CI and Security checks.

## The design, briefly

- Identities are issued and signed by the server; accounts' passwords are hashed with scrypt; sessions are random,
  stored only as hashes, `HttpOnly`, `SameSite=Strict` and `Secure` over HTTPS; logins are rate limited and locked out.
  A browser signed in to an account is refused a code join, so an account never seats itself as a guest with rights
  its own do not hold; a join's role that the page does not offer is refused.
- Rights are checked per room. Reading, writing and sharing files in a room are asked of that room, by its key, its
  hall's and whether it is the hall's Main room (`app/lib/rbac.js` `canIn`): in a Main room by the account's halls, in
  a side room (Legal, Media) only by the rooms the account is given, or by the admin role, never by its halls, an
  account of every hall's included. Asked of `rbac.can` by a hall's code, those three are refused whoever asks, so a
  check left on a room's key where a hall's was meant fails closed instead of letting every account of every hall in. A
  code guest's rights are its seat's, by the kind of room it sits in, from one table (`rbac.guestCaps`).
- An account's side rooms, On stage halls and chat view are given as its halls are, through `rbac.mayChange`: nobody
  sets them on their own account, and an account that manages accounts and is not an admin gives only the side rooms it
  is given itself (read before every hall, so every hall's account gives none) and seats On stage only in a hall it
  reaches. Each list is read by type, so a value that is no name is refused with words, never a 500, and each side room
  or On stage hall it adds must be one that is here, so a key typed wrong is never kept to open a room made later (a
  list of halls takes a key as given, as 0.5.1's did). The Accounts
  route tells a viewer that is not the admin only the side rooms it holds, on its list and on each row, never a guest
  code; a hall's key in it only where the viewer reaches that hall. `/api/halls` and the halls board list the side rooms
  each watcher may enter, and those of a hall it does not see by that hall's name, never its key; so does a hall page,
  told its hall by the join and again as its rooms change (`hall`, `hallName`, `rooms`: the key only for one who sees
  the hall or is the admin, the rooms only for an account's own page, each one it may enter). A change of the chat
  view alone is no right and closes no page; any other change of an account still ends every page it has open. The
  admin chooses a person's chat view where they sit (`admin:setView`: the admin page's gate, then, for an account from an
  account's page, `rbac.mayChange` as the Accounts page's own `PATCH` reads it), a guest's kept by their uid; the view a
  page draws changes no check the server makes: On stage the seat's limit holds in either view. What one person's pages
  relay to each other from the admin's support view says so (`support: true`), and the Board's simple view takes no theme
  from it. The
  Accounts page's halls-and-rooms tree and a room's Members… (on the admin page and in a hall's Set up) are pages over the
  same routes: Members… is offered on the server's word that the account manages accounts (`manageUsers`,
  `canManageUsers`), sends one `PATCH /api/users/:id` per account it changes, and each is judged by `rbac.mayChange` as
  any other change; what the page offers or leaves off is never the check. An On stage seat given is one the account
  takes (it reaches the hall and may post there, `rbac.unseatedOnStage`), refused in words otherwise, and a page is told
  an account's On stage halls as the seats it takes (`rightsView`'s `board`).
- A hall's rooms are made and renamed by those who set halls up (`halls.manage`, the admin) and cleared and removed by
  the admin, each one audit row. A side room's key is an address, never a credential: no lookup or join takes it from a
  guest, and a hall's verbs (screens, Stagewatch, show network, Set up) refuse it. The admin's reads of a side room its
  account is not given (entering it, a watch, a transcript, a person's view, the AI's minutes) are each a `room.read` row,
  the laptop's token's always; never what was read. A room or hall removed is taken out of every account that named it
  (one whose files another program held comes back at the next start, with the accounts given it), and no new hall or
  room is made under a key a room, an account or a node's link still names, so a hall made later is never open to the
  accounts that held one before it under the same code; a Patterns or PlayMap linked for a hall that has been closed
  proposes to no show desk.
- Which rooms may send into a room is a list per room, kept in the settings by room key, never by guest code
  (`settings.roomSends`): a room with no list takes nothing in from another (fail closed), and a folder where none was
  set has none. Only the admin sets it (`room:update {sendFrom, sendBack}`, never from an On stage page), through one
  writer (`setRoomSends`, which the takes module's context does not hold): each key a room that is here and not the room
  itself, an unknown one refused in words and never dropped, each once, at most 50 (a list is refused, never cut), the
  lists a change touches saved together and in one `room.sendFrom` row that names the rooms by name, never by key; the
  picker draws both ways as they are kept (each room's ↔ ticked where this room sends into it, whether or not that room
  may send here), so a save takes away no permission the admin was not shown, and its answer names each room this one
  now sends into or no longer does;
  settings this run could not read are never saved over. The lists are told only to those who read a room's settings
  (the admin and `halls.manage`; every hall's rooms only to the admin), never to a page in a room, and a room removed
  leaves every list, as the room listed and as a room on one; no new room is made under a key a list still names, so a
  room made later never inherits a removed room's place on a list.
- A message or a file goes into another room (`room:send`) only where that room's list names the room it comes from,
  read on every send, so a list taken back stops the next send at once; the rights in the room it comes from decide
  (posting, and sharing files for a file), and a new file is one uploaded for that room by the sender. A page is told the
  rooms it may send into by reference alone (`room:sendTargets`): 'r' and 16 characters of a MAC of the room's key under
  the server's secret, which never passes the code shape, so no join or lookup takes one and it opens nothing; a forged,
  stale or removed room's reference names no room ("That room is gone."). The message carries the room it came from
  and the copy the room it went to by name and reference, never a key or a code; nothing else of either room (people,
  replies, seen receipts, numbers) reaches the other, and a test reads every frame both rooms' pages hear for the other's
  key and code. On stage nothing is sent out of its room, in either form, and no room to send to is told. A repeat of a
  send (its client id) writes nothing new, and a client id another kind of message holds is refused, never answered as a
  send. The message in the other room is not its sender's to delete there; only the admin removes it, so the copy's
  "delivered" stays true. Each send is one `room.send` row, written once the message is there, never its words or a
  file's name. A file that
  arrives from another room never opens itself on the On stage panel.
- A send is taken back (`room:withdraw`) only from the copy the room it came from keeps, by its sender or the admin's own
  page: never another person of that room, the admin's support view or a seat On stage (which acts on no other room).
  Every refusal takes a token of the writes bucket first, so asking about messages one may not withdraw is rate-limited;
  only a repeat of a withdrawal made (asked by its sender or the admin) is answered as done before it. It takes the message
  from the other room only while that room still holds it, the one that came from this room by its reference; a room
  removed or a message the admin removed there leaves nothing to take back, said so. With it goes every word of it a reply
  there quoted (a quote's first 120 characters, or a file's name): the reply keeps who wrote it and says it was withdrawn,
  in the room's feed, in what a page joining later is sent and in its transcript. The copy keeps when it was withdrawn, and
  its line says how long the message was there: a withdrawal cannot take back what people read, a file someone
  downloaded, or a copy someone there forwarded or sent on into another room, and a file's link keeps working while any
  room (the copy here among them) or screen holds it. Each withdrawal is one `room.withdraw` row, never the words or a
  file's name; a repeat changes nothing and writes none.
- A page opens a room with its newest 200 messages, and reads earlier ones (`history:before {beforeSeq}`, and one by its
  id, `history:message {messageId}`, as a message pinned since it opened) only of the room it sits in: neither verb
  names a room, so neither is a way into another, and a page seated nowhere is refused before anything is read. Each
  ask takes a token of the connection's chatter bucket first, so reading a long day back is paced, and is answered with
  at most 200 messages. What they read is what a first open sent whole before 0.6.0.
- A pin for the room (`pin`) changes what everyone in the room sees: it is made only from a seat that may post and is not
  On stage (the admin seated there included), its refusal read before anything else of the request. A pin for oneself
  (`pin:mine`) changes nothing anyone else reads: every seat that reads the room has it, kept under the person's own key
  (their account, or their browser's uid) and told to their own pages and the admin's view of them alone, never as a
  room's op. The admin's support view, which joins under the admin browser's uid, is refused it ("Pins are the person's
  own."), so nothing is ever kept under the wrong person. At most 50 a room and 5,000 persons are kept, a bound of its
  own beside the admin's chat-view and clock choices, so no guest's pins, under however many browser identities, push
  those out; a room reset or removed, a room no longer there at a start and an account removed take theirs with them.
  Neither kind is an audit row (a pin for oneself is a person's act on their own page), and a pin for oneself is in no
  transcript, context, hello or AI brief.
- A take on people's pages (`page:push`) is the admin's, an account's with `display.control` in the hall, or a code
  guest's seated backstage in the hall's Main room while its seats are locked (the seat came from an invite, or was one
  the admin kept by locking the room, who sees and may move each seat kept): never a page seated On stage, the admin's
  view of someone or a guest of an open hall, where anyone with the code may sit backstage. A push takes its rate before
  it looks the hall up, and a key that is no hall's is refused, by the push and by the console's read alike, in the words
  a hall the asker may not push in gets (only the admin, who sees every hall, is told there is none): a hall's key is its
  guest code until New code, so neither verb tells anyone whether a code is real, and the join's lockout stays the only
  way to try one. A push names a person only while they sit in a room of the hall the pusher may read, and is refused in
  the same words for anyone else, so it tells nobody who sits in a room they cannot read; a console's read of the hall's
  pages (`page:status`, the same rights) lists only those rooms' people, and names the Board's people only to one who may
  read the hall's Main room ("Someone went back to chat" to anyone else). What
  may be shown is cleaned on the server, fail closed (a picture must be one of AGMessage's uploads shared in a room of the
  hall the pusher may read). A take reaches a page by its socket's id alone, never as a room's op or broadcast (the
  takes module holds neither), and carries no key or code; consoles are told only that something changed. A page's own
  report is the only thing that makes it "on screen", counted only for the take that page is shown now and never from
  the admin's view of someone. Each push is one `page.push` row naming whom and what kind of thing, never a file; a
  repeat of a push (its client id) is answered with what it did and writes none. Nothing of a take reaches the halls
  board, the context or the AI. A guest's console names its hall by the guest code it joined with, which the server reads
  as that page's own Main room only (a code it holds already, so it learns nothing). A push may name the take it goes
  over (`ifSeq`), and is refused once a newer one is up, so an Undo never takes down someone else's take. Its answer
  gives back what the target was shown before only as the pusher could show it itself: a holding picture shared in a
  room it may not read (an upload's path is the file's capability) comes back as no content, never its path. A hall's
  screens consoles are told their list changed with a signal that names nothing (`displays:changed {}`), in every room of
  the hall, so no side room's page is sent the hall's key that way. The page draws a take with a module that holds no
  socket (`public/pagelayer.mjs`, held by the module fence), from plain values: a holding picture only of AGMessage's
  own uploads, and every word with `textContent`.
- **On stage by invite.** An On stage seat needs the On stage invite link in every hall's Main room, open or locked, or a
  seat already held there, an account given the hall's On stage seat, or the admin's seating: an open hall's code alone
  seats nobody On stage ("On stage seats need the invite link — you joined as an observer."), so a guest who only has the
  code reads nothing the Board is shown. An invite is a MAC of the room's guest code, the seat and the room's number for
  that seat: **New On stage link** (the admin's, `admin:newInvite`) voids the link it replaces without changing the code,
  keeps the seats held, and writes one `room.invite` row with no link in it; a new code voids every link. A hall page
  joined with a link takes the code and the invite out of its address and its history entry once it is in, kept in that
  tab's `sessionStorage` alone, so a venue's shared tablet keeps neither in its history. An open hall's On stage seats are
  kept with the hall across a restart (for the boot's first seconds, as a locked hall's are), and an unlock keeps them.
  The residual: an invite link passed on admits whoever holds it, as in a locked hall; New On stage link is the remedy.
- **Information shown on people's pages is a right of its own**, `stage.show` ("Show files, pages and quotes to the people
  on stage"; the Manager, Senior tech, Tech and Staff presets hold it, not Viewer), and it governs every account's
  information, the operator's included: a Tech with it taken back is refused the take-down. An account seated backstage
  in a room of the hall may show information without `display.control` (`canShow`, pure, in `lib/pages.js`): to the
  Board or one person seated On stage alone, from a side room only while that room is on the Main room's list, never the
  show layer, never over what the operator put up, on the target's take or on any page of theirs (refused over; taken in
  the person's side bar, kept beside the operator's, where it replaces nothing), and a take-down only of what such a seat
  put up, by the take it names, of a kind its own rights would put up, and not while the operator's is on a page of
  theirs. Information pushed offers Take down, never an Undo that would put older information back on every tablet. A
  code guest never shows by this
  right: an open hall's shows nothing, and an observer seat (a Viewer's, a Staff account's without `hall.post`) nothing,
  whatever it was granted. A console that may only show reads the people seated On stage alone, and a web take by its
  host. **Information is drawn over the show, never in its place**, so a researcher's push never takes down the
  operator's clock or voting page.
- A web page on people's pages needs a right of its own, `stage.web`, beside the right every take needs: the admin's,
  an account's in the hall (the Tech, Senior tech and Manager presets hold it; Staff and Viewers do not unless given it),
  and a code guest's only in a locked hall whose admin turned on its backstage guests' web pages (`admin:guestWeb`, off
  by default, "the admin's" alone, never a manager given `settings.manage`, and turned off by an unlock in the same
  change). It is refused without it before its address is read. The address is https only, at most 2,048 characters,
  with no user name or password, and never AGMessage itself (loopback by any name, a trailing dot included, this
  laptop's name and addresses, the tunnel's host): checked on the server and again in the page before the frame is
  given it. **The server never fetches it**, which would be a request from this laptop into the venue's network. It is
  sent only to the pages it is shown on, and given back in a later push's answer (its Undo) only to whoever put it up
  and to the admin: any other pusher, a backstage guest among them, is given no content, so nobody reads another's
  address (a token in its query). At rest it is sealed with the machine key beside its host and who put it up
  (`pages.json`'s `urlSealed`), and the audit row, the console, the halls board, the context and the AI's brief name the
  host alone, or nothing of it; a run without its key keeps no web page. A guest's web page left up when the switch goes
  off, or the hall is unlocked, is counted to the admin with Take it down, a person's whether or not a page of theirs is
  open.
- **The hall page's https frames.** Only the hall page (`/app.html`) may frame an https page (its CSP's `frame-src 'self'
  blob: https:`); every other page, the screen page and the transcript keep `frame-src 'self' blob:` or none, and
  `frame-ancestors 'self'` and `X-Frame-Options: SAMEORIGIN` are unchanged everywhere. The one frame a page makes
  (`framePage`, a source guard holds it to one `createElement('iframe')` in `public/`) is `sandbox="allow-scripts
  allow-same-origin"`: the site's scripts run in its own origin, but it submits no form, opens no popup, navigates
  neither itself away from its frame nor the hall page, opens no modal dialog and downloads nothing. It is sent no
  referrer (the hall page's address carries its code and its invite), no feature (`allow=""`) and, where the browser has
  it, no cookie of its own (`credentialless`). The page refuses to frame its own origin as a second check, so the site
  can never be AGMessage with the scripts a web page is allowed. **What the sandbox does not stop**: the site itself.
  It can show anything, ask for anything, and read what is typed into it, so the strip above it says who chose it and
  "Don't type passwords here.", and the person can always go back to chat (and, in the full view, open it in a tab of
  their own from the layer's ⋯). Nothing
  inside it can be seen, so it reads "opened", never "on screen". A message from it reaches nothing: the hall page hears
  a message only from its own parent's origin.
- Room keys and guest codes are two things. A guest joins by a room's guest code alone, each room its own: a side room's
  is made with it and is never its key, and a hall's Main room's is its key until the admin renews it (New code), so a
  0.5.1 hall keeps the code its guests know. A code is one room's (no live code, earlier code or key shared). The admin
  alone switches a code on or off and renews it, never from an On stage page; a side room's is off until switched on. A
  code switched off, an earlier code, a key and a code no room has are one answer to the lookup and to a join, and each
  but an earlier code counts against the lookup's and the join's locks; an earlier code admits only a person already
  seated in that room, without spending the lock, and the invite links made with it stop (an invite is a MAC of the code
  and the seat). A code is told only to those who may know it (the admin, `halls.manage`, an account whose own rights
  there hold what the code gives, a guest the code it typed; never a page seated On stage, a Viewer or a Staff account in
  a Main room), on each page as it changes, by one rule wherever a code is listed (`codeFor`; a room's settings and the
  rows of its hall's rooms in them by `conn.codeTold` too, so a hall's Set up never hands a project manager whose account
  sits On stage there that hall's code once it is renewed; until then its key is its code, the residual below), and is
  never in an op, the ring, a resume, an audit row (`room.code` names the room by its key) or a console line. The
  residual: until New code a hall's key is its code, so its code is wherever
  its key is: its pages' address, the halls board's and `/api/halls`' rows and links, which every account that sees the
  hall reads (Staff and Viewers too, whom `mayKnowCode` otherwise leaves out), and the audit rows that name the hall by its
  key, as in 0.5.1. The admin page says so where it shows the code and marks each such hall in its list; New code ends it.
  The laptop's token admin, which has no account, joins by a code as a guest does and is a member of every room: a code
  admits its own page whether on or off, and it is never counted or sent out as a guest page. The admin's support view is
  told only what the person's own page is told.
- The laptop's admin token is said only where a person sits: the watchdog that makes it says it in its console window,
  never into output that is kept (a redirect, a log, a task's capture), and a server under its watchdog never prints it.
  The installed node writes it into a token folder of its own, which its admin and the accounts it gives `token` read,
  once its server serves, and refuses an `ADMIN_TOKEN` or `ANTHROPIC_API_KEY` in its environment (a scheduled task's
  definition is read by every account allowed to read the task). The first admin account is made only with the token,
  typed at the laptop or by the token's sign-in made by this run, never from loopback alone, which a second Windows
  account on the laptop reaches too; a wrong token there counts toward the token's lockout and is written down. The
  right token is taken while that lock holds, so guessing at the laptop is bounded only by the token until the first
  admin exists: the watchdog's is 64 random bits, and a token a portable copy is given by `ADMIN_TOKEN` is as strong as
  it is long and random (the papers ask for 16 or more random letters and digits).
- This PC's own requests to its server (how busy it is, the stop, the nudge to read the machine's events) go to
  `/api/machine/*` at loopback and carry a proof of the token, never the token (`lib/machinewire.js`). Each is answered
  only on this PC (`guard.isHostMachine`), only with a nonce the server issued within 30 s and not used before, and only
  for an HMAC-SHA256 under the token over that nonce, the method, the path and the body's digest, compared in constant
  time; a wrong proof is written and counted toward the token's lockout as a wrong token is. The machine first asks for
  the server's own proof, under the token, over a fresh nonce and a challenge the machine made for that hello, and sends
  nothing more to a program that cannot give it: one that took the port during a restart, or gives back a hello it read
  earlier, is asked nothing, learns nothing and stops nothing. The two proofs begin with different words, so neither
  stands for the other. A busy server is stopped only with a reason a person typed, written as `server.stop.forced`.
  What the hello gives any program on this PC: an HMAC under the token over a nonce and a challenge the asker knows, so
  the asker can test guesses at the token offline, at any speed, outside the lockout. The watchdog's 64 random bits
  hold against that; a token a person chose is only as strong as it is long and random, so `/api/machine/*` answers
  nothing while the token is shorter than 16 characters, saying why. A browser's request (an Origin or a Sec-Fetch-*
  header, which the machine never sends) is answered nothing either, so a page open on this PC can neither ask nor flood
  the nonces the machine needs; any program on this PC could still flood them, and the machine reads a stop it could
  not ask as not done, never as done. The machine's wait is for the whole answer: a program on the port that answers a
  byte at a time reads busy at 5 s, never holding the machine longer.
- The busy line (`lib/busy.js`) is counts only, never a name, code, token or path, so whoever reads it learns how many and
  nothing more. The data folder's pipe answers it to anyone who connects, as a read: a pipe's default access lets Everyone
  and the anonymous account read it, and whatever took its name first answers in its place, so what is read there only
  chooses the words a second copy says. Nothing writes the pipe, and nothing is decided on it.
- What the console says is kept by the watchdog in `data/logs/server.log` (`lib/serverlog.js`), read by the Windows
  account AGMessage runs as (mode 0600 where the system honours it), bounded at two files of 2 MB. It never holds the
  admin token: the Token line goes to the console alone, and every line is searched for the token by value and written
  with `[the admin token]` instead, before a line past 16 KB is cut, so no token is written in two halves. A line the server writes holds no other secret by rule (the papers' "secrets ride in
  no log line"); the log holds what the window shows: paths, addresses, hall names in the server's lines.
- "This laptop" on the admin page reads Windows through one `powershell.exe` named by its absolute path under
  `SystemRoot` (never a bare name, which Windows looks for in the current folder and on `PATH` first), run from
  System32 with a fixed script that holds nothing a page sent, within 5 s, ended when the server stops. Its environment
  is named, never the server's: Windows' folders and the machine's names (`lib/laptop.js` `PASSED`), Windows' own module
  path and this `node.exe`'s path, so no secret reaches it whatever the case of its name, and it loads no module from
  the account's own folders or `PATH`: each module it uses is imported by its manifest's path under `$PSHOME`. It reads, never writes: the network's profile,
  the firewall's rules naming this `node.exe`, two power settings, the server task's state and the install record. Its
  functions are named so that none is one of Windows PowerShell's aliases, which would run in its place (a test holds
  this script, the lane's and `tools/*.ps1` to it). The
  laptop's admin and the rights given are on the admin page's answers alone (the token, or an account that may manage
  settings), never health over HTTP, the context, the hello or the AI's brief: a Windows account's name is not the show
  network's business.
- While a hall is live the server holds a power request through one more `powershell.exe`, run the same way (by its
  absolute path under `SystemRoot`, from System32, in that named environment, `lib/power.js`), with a fixed script of
  one line that takes nothing from a page: it declares `SetThreadExecutionState` with `Add-Type`, calls it and waits on
  its standard input, which carries nothing; it ends when no hall is live and with the server. `Add-Type` compiles
  that one-line declaration with the .NET Framework's `csc.exe`, which Windows PowerShell 5.1 runs as a child of its
  own on files it writes in the `TEMP` folder the server passes (the source, the compiler's arguments and the library
  it builds), then loads that library and removes the files: so the request runs `csc.exe` beside `powershell.exe`, and
  writes and loads a temporary library, which an AppLocker or WDAC policy sees as such. Nothing of it comes from a page
  or the network. Its answer is read by type, and only its state (held, refused, failed), what makes the halls live (as
  counts) and Windows' words for why reach "This laptop" and health. It keeps off idle sleep only: it cannot keep a lid
  that is closed from sleeping. The sleeps the watchdog records are times and counts, never a hall, a name or an
  address.
- AGMessage loads only what it ships. A `require()` that `app\node_modules` cannot answer makes Node walk every folder
  above it up to the drive's root, where an account that may make `C:\node_modules` (reading R8 says whether a standard
  one may on the show laptop) would have its module loaded into AGMessage, with its keys. The server asks for nothing
  there: ws's native helpers are never asked for (`WS_NO_BUFFER_UTIL`, `WS_NO_UTF_8_VALIDATE`, set by the server before
  its first `require` and by the watchdog for it), and `supports-color`, which `debug` looks for, ships in
  `app\node_modules`. A fence starts the watchdog and its server under a resolve hook, with modules planted where that
  walk ends, and fails on anything loaded from outside `app`, anything the portable folder does not ship, a development
  package, or a module asked for that `app` cannot answer; what a run does not reach is read from the source, every
  ask of the shipped scripts followed through each file it reaches, and held to the same.
- AGMessage runs only what it names by its absolute path: its own `bin\cloudflared.exe` beside `app` (a copy without it
  has no internet link, and says so, rather than run one found elsewhere), `explorer.exe` and `powershell.exe` under a
  `SystemRoot` named from its drive, and `reg.exe` in the installer's `{sys}`; never a bare name, which Windows looks for
  in the current folder and on `PATH` first, whatever the argument array. A fence reads every call in `app` that starts
  a program, however `child_process` and its functions are reached or named, and holds each to `process.execPath`, a
  full path, or a register row naming where its full path is made, with no shell; `child_process` handed on where the
  fence cannot follow it fails. The machine's own commands (`launch.js`, and `machine.js` once it is made) require
  Node's built-ins only, and reach `require` no other way, so a planted package never runs as the person at the PC or,
  for `machine.js`, as SYSTEM.
- A seat On stage holds messages and nothing else, on the server, for the admin seated there too: it is given no upload
  token, and an upload token is checked again when it is used, against the seat its page holds then; the admin's move of
  a page to a seat that shares no file ends its token in the same tick, so that page uploads nothing more with the one it
  had, even if it is moved back (it is refused and dropped at its next use). It sends nothing into another room, text
  included: a forward from it is refused before the message is read or the rate taken, in the same words for a code
  that names a hall and one that does not; only a repeat of the person's own earlier forward into that hall is answered
  first, with what it did. A file is forwarded only from a seat that may share files where it is, and a file or a
  question never into a room where the forwarder sits On stage. A seat On stage answers no one else's help request:
  from an On stage page only its own request's Resolved is taken, whatever hall the request names, before any right is
  read, and an account answers a hall's help requests only where it does not sit On stage, from the halls board too, its
  own request's Resolved excepted. An account seated On stage by its On stage halls is held to the seat on that page as
  a guest is (no upload token, no stage, no screen or node, no guest code, nothing forwarded out), whatever its rights,
  and keeps them on its other pages; a file or a question it forwards from there never goes into the hall where it sits
  On stage. A side room's help request reaches the halls board whole only for those who may read
  that room; the hall's crew who may not are shown its category, who asked and its state, never its words. A request
  names its hall's key (its Main room's address, and its guest code until New code) only to a watcher who sees the hall:
  an account given a side room alone is told the hall's name, or that it has none, never its key. A line sent to the
  speaker's screen or asked of the show desk keeps, on its record, the link it went to, which a hall's own Stagewatch
  names by the hall's key; a room's pages are sent the record without it (`lib/ops.js` `forPage`), live, in a first open
  and in the earlier messages a page reads back, in the changes a page missed and in the show desk's answer to the page
  that asked, so a send made from a side room tells its readers nothing of the hall's key.
- A connection refused for its rate says when to try again (`retryMs`, read from that address's own bucket, with a
  random spread) and nothing else: no address and no count; the page waits it out. A page that comes back in a
  restart's first 30 s naming a change its hall holds is not announced again: that is the "joined" words only, and its
  seat, role and rights are decided as at any join, and the people list shows it.
- A page names the build that served it as it connects (its handshake's `build`): the page's own word, read by type (a
  build as AGMessage composes one; anything else is no build it named), only to list the pages on another build on the
  admin page's "This laptop" and to tell a 0.5.1 page, which names none, to reload. No right, seat or limit hangs on it.
  `/build.js` names the build that serves the pages, which `/api/health` already says to anyone who asks.
- One person's pages relay to each other only the settings a page applies, each read by its type and rebuilt; the
  admin's support view acts only on what the admin page that frames it sends (its parent, from this origin).
- What a hall page offers on a message, a file or a screen is drawn from one catalogue of acts (`app/public/catalog.js`),
  each shown by rights that match a refusal the server words: hiding an act is never the check. A test sends every act
  to each seat it is not offered, on a real server, and each is refused with nothing changed. The admin's support view
  draws the person's acts and runs none of them. No act there opens a native dialog, which pauses the page: a
  `confirm()` left open past the server's ping timeout dropped the page's socket and told the hall its person had left.
  The join's `forwardable` says only whether Send to ▸ would list a hall, by the rule it lists halls by, never which, and
  its `sends` only whether a room's list lets this one send there.
- The server listens only for the verbs its pages send, and sends only events a page hears: a test fails the build on
  a verb no page sends, an event no page hears (each exception named with its reason) and an event named in a way it
  cannot read. `typing`, which took a word from anyone who may post and sent it on to the whole hall, and which no page
  sent or heard, is gone. Every verb, in `server.js` or a handler module, is sent every argument shape a client can,
  and the same test fails on a verb registered anywhere else or in a form that read does not see.
- A new verb registers in a handler module (`app/lib/handlers/`) and passes one gate before it reads anything a client
  named (`app/lib/gate.js`): seated in a room that is still here, then a token from its rate, then the admin, then its
  rights, in that order and in the words the server already answers with. A request refused for a lookup (a stale
  reference, another hall's code) has spent its token, so the refusal is never a free oracle. A verb written without its
  gate first, with its rate unnamed or with an option the gate does not take fails the build, and the gate refuses such a
  request whole at run time rather than let it through with a step left out; a gate handed anything but the verb's own
  acknowledgement, or a rate that is not the connection's, fails the build too. A handler module requires no built-in,
  package, store or link, and names no run-time import, process or global object, so it reaches a store, a link or the
  disk only through what the server hands it. A take on people's pages is handed no room broadcast and nothing that
  makes a room's op (`io`, `apply`, `systemMessage` are not in its context), reaches a page by its socket's id alone (a
  hall's key given as an id reaches nobody, which a test holds on a real Socket.IO server), joins its socket to no room
  and reads the hall's rooms through their readers only. No handler module asks a right of the rights table directly,
  or writes the settings, and `server.js` takes no new verb. These are read from the source as written: a module that
  hands its store or its settings to a function of its own is past what the fences follow.
- A send's client id (`cid`, 16 random bytes from the browser's `getRandomValues`) is not a credential and names
  nothing: it only lets the server answer a repeat of a person's own send with what that send became, keyed by the
  identity the server issued, so one person's id is never another's. A message held for sending (written while the page
  was offline, or not yet answered) sits in that tab's `sessionStorage`, under the hall and the person, until it is sent,
  never beyond the tab; another person's held messages are dropped at the join, never sent as them, and being sent out
  of a hall drops them all. The words a person wrote in a room and had not sent when the switcher moved them to
  another room of its hall are kept the same way, in that tab's `sessionStorage` under the room and the person, until
  they come back to that room, so another account signed in on the tab is never handed them. What a person has read of
  each room, for the switcher's dot, is a room's key (for a hall's Main room, its guest code until New code, as the
  page's own address already holds it) and a change number in the browser's `localStorage` under the room and the
  person, never a word of a message or a secret; where the browser keeps nothing, the page holds it for itself alone. A
  page is told of a change in another room only where its switcher lists that room (an account's page, an admin's
  account's included, joined to that room's watchers, which it leaves when the room leaves its switcher; a code page,
  the laptop's token admin's own page among them, and the support view watch none), and only the room's key it already
  holds, the change numbers of the room's newest message and newest priority one and whether a priority message came:
  no words, no sender, no people. A member of one room learns nothing of a room it may not enter. A file's bytes waiting are
  held in memory only (the link of one already uploaded is kept with its message). Nothing an act on something carries (a pin, a take, a setting, a node's token) is ever stored by
  the page. A repeat is answered before the rate only for a send of that person's own: a forward, which names the hall
  it goes to by its code, takes from the sender's rate before the code is looked up, so whether a code names a hall is
  told no faster than a send goes.
- Saved keys and tokens are sealed at rest (AES-256-GCM) with a machine key kept outside the app folder.
- Uploads are allow-listed by type and checked by content; they are served so they cannot run script. Before an
  upload of a type the stage can show is kept, it is checked, and nothing it holds is inflated or drawn: a Word, Excel or
  PowerPoint file's archive (its end records and central directory, `lib/zipcheck.js` over `public/zipcore.js`, the one
  core the page's document worker reads a file through too) is held to at most 2,000 parts, 200 MB unpacked in all and
  100 MB in one part, 200:1 for any part, a directory of 1 MB (refused unread past it), its ZIP64 sizes to the same,
  and refused with an encrypted part, two parts whose data overlap (one compressed stream read as many files), sizes
  its bytes cannot hold, no `[Content_Types].xml`, or a macro part (`vbaProject.bin`, which a `.docm` renamed `.docx`
  carries). The directory it checks is the one the pages' readers open (SheetJS's and JSZip's, which take the last end
  record signature in the file): an end record that does not end the file or carries a comment, a record signature after
  the one chosen, ZIP64 records out of their place or unmarked, and a part with two ZIP64 fields are refused, and a test
  runs the vendored readers over every archive the check passes. The check reads declared sizes only: a directory that
  understates what a part inflates to is the document reader's to stop as it inflates, and it does: the page's document
  worker inflates a part only as far as its declared size. A picture's size is read from
  its header (`lib/imagesize.js`: PNG, WebP, a GIF's screen grown to hold its first frame as browsers draw it, and a
  JPEG's frame header, each walk of at most 64 segments or blocks, never past the first megabyte) and refused over 100
  megapixels or where it cannot be read. A check that cannot finish refuses the file. A refused file leaves the disk and
  is one `upload.refused` audit row in its hall, at the upload's own address, which names the type and the bound, never
  the file. Formulas, external references and links inside a file are the readers' (they are never
  computed, fetched or live on the stage); the upload checks bound what the readers are handed.
- Documents are parsed only by the browser of the person looking, never on the server, by bounded readers
  (`public/docview.mjs` over `public/docmodel.mjs`). A Word, Excel or PowerPoint file is read in a worker of the page's
  (`public/docworker.js`) that the page ends 15 s after it starts, or when the document is closed: it holds the file to
  the upload's archive check again (the one core), holds every entry's name to the one every reader finds (printable
  ASCII, a canonical path, the same in its local header, which JSZip reads, as in the directory checked, none twice
  whatever its case; the archive check itself refuses an Info-ZIP Unicode Path name, at upload too), inflates a part only
  as far as its declared size, and refuses the file if any entry, whatever its name, declares a document type or an
  entity, before SheetJS, mammoth or AGMessage's own readers see it. A PDF is read by pdf.js with no script, no XFA, no
  `eval`, no annotation (so no live link) and no image over 16,777,216 pixels, on the panel and on a screen; one pdf.js
  worker serves a page and each document closed is destroyed, and a PDF whose first page is not drawn within 20 s is
  failed and takes that worker with it. A sheet or a CSV is drawn to its first 5,000 rows and 256 columns and at most
  100,000 cells (a wide one's rows cut to fit, in the worker before anything reaches the page), a table in a document to
  256 columns and 100,000 cells, a text file to its first 20,000 lines, each cut said; formulas are never computed (a
  formula saved without its value says so, whatever its type). A picture's size is read from its header before anything
  decodes it (`public/imagecore.js`, the server's own reader): in the document worker for one inside an Office file, on
  the page for a picture shared on its own, and one over 40 megapixels, or whose size cannot be read, is never decoded on
  the device. HTML (mammoth's, a Markdown file's raw HTML, and what is pasted into ❝ Quote) is parsed
  in one place, `parseInert`: an inert `<template>` walked into plain data, so nothing in it runs, loads or applies and no
  parsed node is put in the page; a lint rule refuses every other way to turn markup into nodes in those modules. The
  readers fetch a file with `cache: 'no-store'`, and a document's pictures are drawn through object URLs the page makes
  and revokes with the document, never an address from the file or the worker.
- Hidden things are not drawn on the Board's pages: on every seat but backstage (the admin's support view reads as
  backstage) a hidden sheet ("very hidden" too), row or column, a hidden slide, a Markdown comment or hidden raw HTML is
  left out with words saying how many; a slide's hidden shapes and its presenter notes are never read; and Word's hidden
  text (`w:vanish`, `w:specVanish`, on the run, through its character or paragraph style, the style of a table it sits
  in, or the document's defaults) is removed before mammoth reads the file, on every seat, from the main document, the
  footnotes, the endnotes and the comments found as mammoth finds them (by relationship, under whatever names), judged
  by the styles part mammoth reads. A hidden mark that cannot be resolved refuses the file: a style the file does not
  have or writes twice, a chain of styles past 10 links, a table style's conditional format that hides, a mark written after a run's
  text, or WordprocessingML bound to a prefix other than `w` or as the default namespace, which a reader that resolves
  namespaces would read and the scanner could not. The backstage seat sees hidden
  rows, columns, sheets and slides drawn muted and marked "hidden". The AI's copy of a document's text is read only on a
  backstage seat, and leaves every hidden part out.
- pdf.js's worker alone may run WebAssembly, which its JPEG 2000 decoder needs: its own response
  (`/vendor/pdf.worker.min.mjs`, by that exact path) carries `script-src 'self' 'wasm-unsafe-eval'` (`CSP_PDF_WORKER`,
  never `'unsafe-eval'`); every page, the screen page, pdf.js's own module and the document worker keep `script-src
  'self'`. A worker loaded by its address runs under its own script's policy, never its page's. A file message
  is posted only in the room its upload was made for, by the person it was made by (the upload token's room and person,
  kept with the upload for its hour in memory, `freshUploads`), or again in a room a message of which holds it already;
  any other link is refused and nothing posted (another room's file or upload, another person's upload not yet posted,
  a file only a screen or a hall's holding image holds, an upload this run holds no record of, made before a restart),
  so a file message crosses rooms only by a send into a room whose list names its room, or a forward between rooms the
  person is in, each by its own rules. A
  file's link stays the capability to read it, for whoever holds it: provenance governs where a file is posted, not who
  may open a link they were given. A screen's take and a hall's holding image are not held to it yet: whoever may drive
  a hall's screens can show any upload's link there. People's pages are (below).
- **A file shown on people's pages** (a document, a picture, a holding slide's picture) must come from a place the stage
  may show it from (`sourceOk`): the pusher's own fresh upload, made for the Main room or for a side room on its list
  where the pusher posts files; a file in a message of the Main room; a file in a message of a side room the pusher reads
  that is on the Main room's list; or one the hall's stage records, when the room it was recorded for passes again.
  Never another person's fresh upload. A refusal names the room only to one who may read it. A document hands over the
  whole file, so it is never shown to a person seated as an observer in any room of the hall (a person's take reaches
  every page of theirs, one in a room the pusher cannot read included), and a page seated as an observer is told one
  without its address. A picture's source is kept by its name and place, never its address. The page checks a take's
  address again before it fetches anything: an upload of AGMessage's, of a type the stage shows. A picture over 40
  megapixels, and an Office file that never had the archive check, are refused at their first take.
- **Uploads are kept by no device and saved by no `GET`.** Every upload is served `private, no-store` (no browser keeps
  it in its HTTP cache), always `inline` (never `attachment`, which saved an Office file from its address with no
  record), with `nosniff` and the sandbox policy; a navigation to one (the address bar, a link, a frame, an embed or an
  object: Fetch Metadata's `Sec-Fetch-Mode: navigate`, or that destination) is answered 404, so the browser's own viewer
  and its Save are never offered. A browser that sends no Fetch Metadata (an iPad before 16.4 among them) is served, as
  before: on such a device a file's address typed into its address bar opens it (the device matrix's D1,
  `docs/DEVICES.md`). What a take shows is drawn from memory: fetched `no-store`, a picture through an object URL revoked when the
  take goes, a document's reader and its pdf.js document destroyed then (a PDF read by its pages' ranges alone); a
  picture on a file's card in the chat likewise, its object URL revoked as the card leaves the page.
- **A download is the server's act, by a ticket per seat** (`file:download`, then `POST /uploads/:name/download`). A
  ticket is given only to a seat that may download (`lib/pages.js` `mayDownload`): the admin's own page (where it does
  not sit On stage), and a seat backstage whose account is not a Viewer; On stage, only a document shown with **Let them
  download it** ticked, that item alone; **never an observer and never a Viewer account**, whatever its seat. A ticket is
  18 random bytes, single use, good for 60 s, bound to the person, the file and the address the socket had; at most 4
  live for one page and 8 for one person (read before the 1,000 kept in all, so one page cannot push out another
  person's), held in memory only (a restart voids them), and voided with a take that is withdrawn. The download answers
  `attachment` under the message's name with the stored file's own extension ("Agenda.cmd" for a `.txt` saves as
  "Agenda.txt"; Windows' reserved characters dropped; the true name in `filename*`), `no-store`, `nosniff` and the
  sandbox policy, streamed from the disk; **every other outcome is 204 No Content** (a ticket unknown, spent, expired, for
  another file or address, and the form's own refusals: a field sent twice, a body over 1 KB, a third field), so the
  hall page that posted it stays where it is. A download of a file that is not confidential is not audited: it is a
  person reading what their room already shows them. A downloaded copy stays on the device that saved it. **A file with
  hidden parts is never shown with Download ticked** (hidden sheets, rows or columns, hidden slides or shapes, Word's
  hidden text): a download hands over the whole file, so a hidden "Salaries" sheet would be one Unhide away on every
  tablet that saved it. This is the researcher's page's guard, read by its own reader as it opens the file: **the server
  never parses a document, so it cannot hold it**; a page that does not hold it (one rewritten, or a client of its own)
  could push such a file with the tick.
- **An observer's page, and a Viewer account's, is never given a file message's link** (S2): such pages sit in an io room
  of their own (`ro:<key>`) and are sent each file message without its address, live, in a join's history and files, in
  a resume and in a read back; the admin's seat change moves a page in or out in the same tick, before the page is told,
  so a page that ignores the change is split by its new seat all the same. Withheld at delivery, never in the stored
  message, so a message from before 0.6.0 is withheld the same way. **A file moves to another room** (`forward`,
  `room:send`) **only from a seat that may download it where it is**, so a seat that may only read there (an observer,
  a Viewer account granted the rights to post and share) never carries a file into a room where it could download it:
  "Files are moved by the backstage team." A file's name is the server's (its upload's, or the name the room's first
  message of it gave it), never the poster's, so a post again cannot rename a file. **Nothing opens itself**: a file
  shared in a room opens on nobody's panel, and the admin's support view opens nothing on a person's (a file a person
  opens follows them to their own devices and the support view of them, never the other way).
- **Files to transfer only** (owner answer 18): zip, MP4, M4A, MOV, MP3, WAV, OpenDocument (ODT, ODS, ODP) and Word,
  Excel and PowerPoint files protected with a password are taken for download alone. AGMessage reads their first bytes
  at upload (a zip's signature, an `ftyp` box, an ID3 tag or an MPEG frame header, RIFF/WAVE, an ODF's `mimetype` first
  and stored; a protected Office file's compound-file directory, read within 64 KB, holding `EncryptionInfo` and
  `EncryptedPackage` and none of `WordDocument`, `Workbook`, `PowerPoint Document`, `Macros` or `_VBA_PROJECT_CUR`, so
  a Word 97 document with a macro renamed `Agenda.docx` is refused) and never opens, draws, previews, parses, shows or
  sends them to the AI. They are never answered on a `GET` (404, by the extension, or by a protected file's first eight
  bytes, read again at each `GET` so the answer holds after a restart), never shown on the stage or a screen, and served
  only through a download ticket, as `attachment`, `application/octet-stream`, `nosniff`, the sandbox policy and
  `no-store`, at most 25 MB. **A zip is never inflated by AGMessage**: a zip bomb harms only a machine that extracts it,
  as an email attachment would, so open a downloaded zip as you would an attachment. RTF, executables, scripts, HTML and
  SVG are not taken.
- **A device that cannot open documents is shown a stand-in, never less checked.** A page says at its join whether it
  opens documents (a probe, `docs`; the server reads `true` and nothing else as yes). For such a page the pusher's page
  sends a document's stand-in with it: a picture of the place, an upload of the pusher's checked as a picture take is
  (where it may come from, its pixels at its first take) and kept as a stage file named by the take; or what is at the
  place as a quote's body, held to a quote's rules and bounds. Only a document carries one, in one of the two shapes,
  the one its type takes; any other is refused in words. A document and its stand-in find room on the hall's stage
  together, within its bound. The page is still told the document's address (its Download, where ticked, is the
  server's ticket as on any device), and draws only the stand-in. For Show them a picture, the console's read gives a
  document's address only to the take's pusher, an operator and the admin, and only where that seat may show the file
  itself (the same check a push of it passes), so no seat learns an address it could not already put on the stage.
- **What a Board tablet keeps: nothing AGMessage writes or offers.** On every seat's take layer, its cards and a Look,
  AGMessage's menu stands in for the browser's, Shift+right-click included (so "Save image as" is never offered), no
  picture is draggable, iOS's long-press "Save to Photos" is off, and printing leaves the stage out ("What is shown on
  stage is not printed."). Words stay selectable. **What cannot be prevented**: a screenshot, a screen recording or a
  photo of the screen; a desktop browser's developer tools, which read the page's memory and can fetch any link the page
  was given (the navigation guard stops only the address bar, links and frames); a browser that sends no Fetch Metadata;
  the browser's own "save page" for what the page still shows; copying or retyping the words; Firefox's own menu on
  Shift+right-click, which Firefox shows without telling the page. "Keeps no copy" means AGMessage writes none and offers
  none, not that a person cannot make one. "Not offered" is not "not reachable" for a seat that was shown a file: its
  link is the capability (a Board tablet that Looks at a file shared in its room holds its link). On an On stage seat the
  same measures hold, in either view, on its panel's reader, its side bar's cards and the feed's pictures.
- **The stage's files live while a take names them.** A fresh upload a take named that no message holds (a picture drawn
  of a page, a holding slide's picture) is kept in the hall's stage record while a take or an Earlier entry names it, and
  for an hour after (`AGM_UPLOAD_ORPHAN_MS`); then it leaves the disk unless a message, a screen or the hall's holding
  image holds it. A file whose message goes while only the stage still shows it (a holding slide's picture, a picture the
  admin's delete left up) becomes a stage file then, and leaves the disk the same way, never kept for good. The boot sweep
  removes those whose hour ran out while AGMessage was stopped, by the names the stage recorded alone, never any other
  file in the folder; a hall removed takes its stage files with it, purged or not. A Main room's reset ends every
  information take of the hall, a side room's what shows its files, a file's message deleted what shows that file, and a
  take shown by mistake is **withdrawn** (from every page and from Earlier) by who showed it, the operator or the admin.
- **A quote is data, never HTML, and its pusher's claim.** A word, a paragraph, a cell, a row, a column or the blocks in
  view go as plain strings and tables, each string cleaned on the server (`guard.cleanBlock`: controls, the bidi
  overrides, isolates and marks, U+200B, U+2060 and U+FEFF dropped; line breaks kept) and held to its bounds (1,200
  characters, 25 rows × 10 columns of 200, 4,000 in all), refused over them, never cut; a page draws it with the DOM and
  `textContent` alone. It names its source by a file's name and place, never its address, a web page by its host; a web
  page's address is kept (sealed at rest) and told the pages it is shown on, for **Open the source**, only from a pusher
  who may show a web page (`stage.web`, a code guest's by the hall's setting), since it is a web page offered on the
  Board's devices; from anyone else no address of it is kept or told. Open the source opens it in the person's own tab
  (no opener, no referrer), checked again as a frame's address is. It hands the Board no file. The server never parses a document, so it cannot check that the
  words are in the file: the card says who quoted it. Its words sit in `pages.json` in clear, as a room's messages sit in
  its file, from the same people; a web address is sealed because it can carry a sign-in token. A pick reads only what
  the Board's pages would draw: a hidden row, column or sheet, drawn dimmed in the researcher's Preview, is never picked,
  whatever names it (a header, a cell, a range's end, What I see), nor a hidden slide or shape, nor Word's hidden text.
  A paste into ❝ Quote is read for its structure alone (a table's cells, a list's items), its hidden elements left out,
  and only where its words are the words the browser says were selected (its `text/plain` flavour): where they disagree
  (a part hidden by a style sheet AGMessage cannot see), the plain words alone are used. What a person pasted is still
  theirs to check: the tab draws it as the Board will see it before it goes.
- **A line sent with a push is the push's own words, built by the server.** ＋ the speaker's screen sends one line with a
  take (`withTake`), and the server builds it from the take it stored (`stagelines.flatten`: a quote's words in one line,
  or a document's or a picture's note; never a file's name, an address or a page), only for an information take its own
  sender put up in that hall in the last minute, and refuses a `text` that differs, so no line can ride a push to every
  Stagewatch output with no record of its words anywhere. Those words are kept where what was shown is kept (the take,
  and its entry in the stage record), never in the room: the room's line names its length ("… a line (17 characters) to the speaker's screen with a push"),
  which observers and the transcript read, and a proposal's record keeps a MAC of the line under the machine's secret
  (`lineMac`), not the line, matched against the desk's copy. A line on the speaker's screen is seen on every Stagewatch
  output, NDI and its viewer page, and Stagewatch publishes it in its public frame, keeps it and passes it to its
  triggers: the bar says so before it goes, and it is off on every push until ticked.
- **What was shown is recorded, for the transcript and the minutes.** Each take a hall accepted, and each take-down, is an
  entry in its stage record (`data/stage/<HALL>.json`, written mode 0600, at most 500 entries): who showed it and from
  which seat, to whom (a person by name, never their key), what it showed in the console's words (a file by its name and
  place, a web page by its host, never its address), a quote's words, the line sent with it to the speaker's screen, what
  the pages reported and when it was withdrawn. Its words sit there in clear, as a room's messages sit in `data/rooms/`,
  from the same people. A Main room's reset clears it and a side room's drops the entries sent from it, each written so
  that the cleared words are in neither the file nor its `.bak` (`pages.json` likewise at a reset and a withdrawal; a
  `.bak` another program holds fails the write, which is tried again until it is so, and a record whose file could not
  be read at the start is not cleared on disk, which the reset's row says); a hall removed takes its record with it, and
  the record of a hall whose files are gone goes at the next start. The transcript, which
  whoever the admin page admits reads (the laptop's token, and any account with `settings.manage`, on any device),
  interleaves it with the room's messages and is served `no-store`; the AI's minutes are given its lines. A take stays
  out of the room's feed and every reader of it, and the audit names the act without its content. A confidential
  entry's words sit there too, in clear; the transcript shows them only on the AGMessage laptop itself, or where the admin
  ticks Include confidential text (a `room.read` row says so), and the minutes are given none of them.
- **The confidential mark.** One record a file (`pages.json`'s `marks`), read by every check: a file marked goes only
  where it is in use (the rooms whose messages hold it, the room a fresh upload of it was made for, where a take of it is
  drawn) or where its sender confirms, from a seat that may download it where it is in use; never on a screen or as a
  holding image; never its text, name, place or caption to the AI; named only to a page seated where it is in use; its
  line only from where it is in use in the Main room, to the hall's own Stagewatch over https with its certificate
  pinned, and while that line is on Stagewatch's frame, its message is given to no other reader of the frame (screens,
  the halls board, other rooms, the context, the AI's brief), held by its MAC and id across a restart; a second line, a
  refused proposal or an answer the desk did not make plain never releases a line still on the frame, and at most 20
  confidential lines wait on one Stagewatch, the next refused, so a hold is never let go for its size. A file marked after
  a take of it went up is confidential there from then on: every take and Earlier entry of it, a picture or a quote made
  from it included, is marked, and the stage record's entries are read with the mark as it stands. One race is left: a
  proposal approved while another message came up on the frame, whose approval AGMessage reads (every 3 s) before the
  frame carrying the approved line (live), holds the other message and not the line; the frame normally arrives first.
  Who marked it, or
  the admin, removes the mark; an On stage seat marks nothing. It is not encryption: the file on disk and its link are as
  any file's, and anyone who reads it can retype or photograph it. The mark on a picture or a local copy, and the AI's
  check of a document's source, hold for AGMessage's own page, not against someone who rewrites it or copies the words;
  what Stagewatch does with a line once it has it is Stagewatch's (every output, its public frame, its triggers, its saved
  settings).
- **A part of a page or a picture is a new picture.** A region of a PDF's page or of a picture, what is in view of
  either, and a picture tapped in a Word document or a slide, is drawn on the pusher's own page into a new picture (at
  most 2,048 px on its long edge) and uploaded: no original goes, and a picture's metadata (EXIF, its place) is never
  carried into it. A whole picture shown as it is
  keeps its metadata, unless shown "without its metadata", drawn again the same way.
- Pages carry a strict Content-Security-Policy with no inline script. The page lint (`agm/no-unescaped-html`) refuses,
  whatever they are given, a frame's `srcdoc`, `setHTMLUnsafe(`, `createContextualFragment(` and a computed
  `el['innerHTML']`; in the documents' modules (`agm/inert-html`) every parse of HTML outside `parseInert` (`innerHTML`,
  `DOMParser` as HTML, `document.write`, `parseHTMLUnsafe`) and every move of a parsed node into the page (`importNode`,
  `adoptNode`, a template's `.content`) is refused.
- Links to Stagewatch, Patterns and PlayMap pin each peer's certificate; keys travel in headers, never in a URL. A
  Stagewatch certificate is pinned only once Stagewatch accepted the link's key; the key goes in no request but the one
  that asks for that verdict until then; and refused keys are asked again at most once a minute, shared by every link
  of this machine to that Stagewatch, so they never lock this machine out of it.
- A Patterns or PlayMap pairing token is full control of that node: it goes only to a loopback address, or over TLS to
  a certificate that is pinned or that a person confirmed by typing at least 16 characters of its fingerprint from the
  node's own screen; AGMessage never drives a node with it — lines are proposed to the show desk (Show Bus §11). On the
  admin page it is typed into a password field of a form asked in place, which the browser keeps nothing of
  (`autocomplete="off"`), never into a native prompt.
- Security-relevant actions (sign-ins, permission changes, the admin's room controls, the proposals Stagewatch's show
  desk takes, the lines sent straight to the speaker's screen, what kind of thing a display was told to show) are
  written to an audit log chained with a key (HMAC-SHA256 under a key derived from the machine key) that shows
  tampering, never with a message's text or a file's name (screen takes logged by 0.5.1 and earlier quote a message's
  first words and name the file). Its records (the newest entry on disk, the log written last and where) are kept
  beside the machine key, outside the data folder, so entries removed or a whole log replaced while AGMessage is
  stopped are found at the next start. Entries this laptop cannot check (0.5.1's, another key's) read △ until the
  person at the laptop accepts them by typing the admin token into the dialog: never a sign-in, which is a record in
  the data folder anyone who can write it could add.
- The audit log is exported signed, to be checked on another computer: the files byte for byte, the laptop's own check
  of them, `SHA256SUMS` and its Ed25519 signature. The signing key is derived from the machine key when an export signs
  and is never stored; its fingerprint is printed in the black window and on Admin → Health, and an auditor checks an
  export against their own record of it, never against the export (anyone can sign a bundle with a key of their own).
  Whoever holds `machine.key` can sign exports. Exporting is the right `audit.export`, admin-only (an account holding it
  signs in through the tunnel only when admins may), or the token at the laptop signed in by this run; from another
  device only over HTTPS. The export is an audit row, keeps no copy on the server, and carries personal data (names,
  addresses, what each did), which the dialog says. The verifier treats the bundle as untrusted input: only its fixed
  paths are read, a path that leaves the folder, a link or a file not listed ends the check before it is read, and its
  words are printed with control characters escaped; the browser verifier is one page whose policy lets it load nothing
  and send nothing.
- The audit log carries on across events as one chain. The admin (the token, or an account whose role is admin; never a
  manager granted `settings.manage`) may split it at an archive point: the older files move, never copied and never
  deleted, into a signed archive in `app\data\audit-archive\`, pinned by the SHA-256 of its `SHA256SUMS` in a keyed entry
  written before anything moves. A split is refused while anything before the point is open or broken, so it can never
  make the log read better than it did, and the check's mark is the worst of the live log's and each archive's. An archive
  moved off the laptop or changed (a file cut, removed or resized, `archive.json` or `SHA256SUMS` changed) reads ✕ until
  the token accepts it; a byte changed in place is found by the archive's own Check and by every export, which hash each
  file in full. That Check reads no better than what pins the archive: its `SHA256SUMS` must be the one the split
  pinned, and an archive under this laptop's key id must be signed by this laptop's key (one re-signed by anyone else
  reads ✕); one the live log no longer reaches reads ◇ at best. An entry once chained is never withdrawn, so a split
  whose own entry the disk refused keeps its folder and waits, and a folder left by a split is never removed on a check
  that did not walk the log to its end. Whoever holds `machine.key` can sign archives as they can exports.
- What the keyed log cannot show: anything done by someone who can change AGMessage's code, its Node or its start
  script, or holds this machine's key. In the portable layout `app\data` sits beside `app\lib` and the start script under
  the same rights, so whoever can write the data folder can usually change the code too; keep the folder where only the
  show's Windows account can write it, never on a USB stick or a shared folder. A machine key that cannot be read is never
  replaced: that run is keyless, seals nothing and says so. Nor is any other secret made over one that could not be read
  or does not open: the server secret, the certificate and the context token are each made only where there is none (the
  file not there), published whole, and never over one another start made at the same moment. Otherwise the portable
  copy goes without it this run and says so (a secret of its own, HTTPS off, context reads refused with words), and the
  installed node (`AGM_RUNS=task`) does not start at all (code 3, before anything is made), so a lost or wrong key folder
  never turns into new keys that leave every sealed value unopened. Nor does it make a machine key while a file that may
  hold values sealed with the old one (`settings.json`, `displays.json`) cannot be read: none of them can be ruled out.
- Nothing is written before a copy holds its data folder and its port: a copy refused at either has made no folder, key,
  certificate, secret or setting (its watchdog adds its line saying the start was refused, and why, to `watchdog.log` and to the console it keeps in `logs/server.log`; the installed node's watchdog records a start refused as configured in `watchdog.json`, never a portable copy's, which may be refused by another copy's folder), so a second
  start can never write a key or a certificate into a folder another copy runs on. Nor does it remove or move anything
  there: the last stop's record is moved aside, and an atomic save's temporary file left by a stop cut short is removed
  (only one named for a process that has ended), by the copy that holds the folder alone. A `settings.json` that cannot
  be read (EBUSY, EACCES) is never written over, nor taken from its `.bak`, which is a save behind: that run makes no context
  token, refuses a setting changed with why, and goes without the links and keys the file holds. The installed node's folders are each a full path outside the program's folder, checked before any write.
  Its port held, or its folder's pipe taken by another account, ends its start with code 75, which its watchdog tries
  again and never counts as a crash, so squatting either during a restart cannot hold the node down for good.
- A copy that cannot take its port reads who holds it once, from loopback, sending no token, and takes only the
  version, the build and whether it is the installed node, cleaned, to choose its words; nothing is decided on the
  answer. The browser is opened only by the portable copy, in the person's own session, through `explorer.exe` by its
  absolute path. The clean copy for giving the bundle away goes to a new folder each time and is deleted if anything of
  `app\data` or `app\uploads` is in it, so a copy handed on carries no accounts, keys or audit log.
- Display URLs are capability links: unguessable, revocable, never logged, and only able to show — not to send.
- Health's detail is for the admin and this laptop only (anyone else reads up or down, the version and the uptime). Its
  readings and the show day's peaks it keeps in `peaks.json` are numbers and days: the most sockets from one address
  and through the tunnel are counts, and no reading names an address, a hall or a person.
- Through the tunnel, a bound counts a network: an IPv6 address by its /64 (a mobile network gives each phone one, and
  the phone changes its address within it), an IPv4 address whole, so the many phones behind one carrier's address share
  one allowance and one wrong-code lock, which says "your network". A venue address is counted whole. That holds for
  the connections, the room lookups and their lock, the uploads, the wrong codes at join and the wrong context tokens;
  the sign-in's own allowance and lock per address keep the full address, because through the tunnel its lock per name
  holds for the whole tunnel. The connection, room-lookup and upload buckets hold 5,000 networks at most and are never
  reset: the fullest go first, so a flood of new addresses gives no drained network its burst back. The tunnel has 150 places, one network half of them at most, and a
  tunnel socket that has not joined a room within 20 s (and carries no account, admin token or screen link) is let go.
  Refusals are counted per show day in health, by kind, and logged at most once a minute; they are no person's act, so
  they write no audit row, and health and the log name no address (`networks` is a count). Cloudflare's address is
  read only from a connection that came from this laptop's loopback, as before, so a page on the venue cannot pass for a
  tunnel network; a program on the laptop itself could, and could take the tunnel's places, as it could already do
  anything a page can.
- The internet link is open only until its end: the end of the show day (the next 06:00 by the laptop's clock an hour or
  more away) when it is turned on, or the time an admin sets with Tunnel until… (`admin:tunnelUntil`, the admin's
  alone), never more than a day and two hours ahead. The end is kept in `settings.json` until Turn off, so a restart
  inside it opens the link again, with no person's act, at a new address only the admin page shows; past the end, or
  with an end no act could have set (a clock set back, a file written by hand), a start leaves it closed and forgets it,
  and a running link is closed within 5 s of its end, read against the wall clock. Turn off forgets the end at once,
  also while the link is down with its end kept. Under the installed node, which has no window to close, the link no
  longer stays open after the show because nobody turned it off. A crash ends cloudflared with the server; on Windows a
  cloudflared ends with its server however the server ends (libuv's job object, read in its source), while elsewhere a
  server killed as hung can leave one running. Settings that could not be read keep no end (a restart then leaves the
  link closed) and refuse Tunnel until…. The link's opening, its end moved, its closing and a start that opened it again
  are audit rows (`tunnel.on`, `tunnel.until`, `tunnel.off`, `tunnel.again`, `tunnel.ended`), with the end and never the
  address; the address is said on the admin page and the console, never in the context, the hello or an audit row.
