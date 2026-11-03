AGMessage — portable Windows bundle
====================================

What this is
------------
A self-contained copy of AGMessage that runs on any Windows laptop without
installing Node.js or anything else. Extract the zip (right-click it,
Extract All), double-click the launcher in the extracted folder, and share
the URL with your team. Messages, files, help requests and screens for
every hall of the event; crew sign in with their own accounts, presenters
and guests join with a hall's code.

The build this copy is (e.g. 0.5.0+17.abc1234) is in the zip's name, the
black window's first lines, and the admin page. The window's banner also
names the folder it starts from.

THIRD-PARTY-NOTICES.md and the licenses folder beside this file name the
libraries AGMessage's pages use (pdf.js, mammoth, SheetJS and what they
bundle), each with its licence. Keep them with the folder when you pass
it on.

First time on a new laptop
--------------------------
1. Extract All first (right-click the zip). Running the .bat from inside
   the zip does not work: Windows copies out only the file you opened, and
   nothing it needs is beside it. Extract it somewhere convenient (e.g.
   C:\Tools\AGMessage).

2. In the extracted folder, double-click:

       start-agmessage.bat

   A black window opens and says "AGMessage is starting...", and from
   which folder. LEAVE IT OPEN — the server runs inside it. Once this
   copy is serving, your browser opens on it at http://localhost:3023.

3. On this laptop only, the sign-in page asks for the FIRST ADMIN: the
   admin token from the black window (its "Token:" line, under Admin
   login), your name, a username and a password (10 characters or more;
   a few words together is easiest to remember). That account can do
   everything. Nobody makes it without the token, not even on this
   laptop.

   The token is printed only in the black window itself. Started with
   its output sent to a file or a log, AGMessage says "Token: not shown
   here": start it from its own window, or set ADMIN_TOKEN before the
   start to choose one. A token you choose is 16 or more random letters
   and digits, never a word or a name: until the first admin account is
   made, anyone signed in to this laptop may try tokens there without
   limit. A new token is made each time the window is started; a
   restart inside it keeps the same one.

4. Halls -> Accounts: add everyone who works the event. Pick a role
   (Project manager, Senior tech, Tech, Staff, Viewer) and their halls.
   Each new person gets a one-time password, shown once — give it to them;
   they choose their own at their first sign-in. Project managers and
   senior techs see every hall; techs, staff and viewers see their own.

5. Halls -> New hall: one per hall in use (e.g. "Hall 3", "Hall 4"). Each
   hall gets a 6-character code (e.g. K7P2QX) for the people who join
   without an account: presenters on stage, board members, guests.

6. In the black window you will see a line like:

       LAN:  http://192.168.1.42:3023

   Share that URL with everyone on the venue's Wi-Fi or wired network.
   They open it in any browser — phone, tablet, laptop.

Every day of the event
----------------------
- Crew: open the LAN URL, sign in. The halls board shows every hall you
  can see: its countdown, who is in, the last message, open help requests
  and its screens. Click a hall to open it.
- Presenters and guests: open the LAN URL, choose "Join with a code", type
  the hall's code, a name, and where you are (on stage, backstage,
  observer).
- On stage: read, reply, answer the backstage team's questions, send
  Priority and ask for Help. On stage seats cannot share files, ask
  questions or send to other rooms: what they write stays in their room,
  where the backstage team reads it. Help requests are answered by the
  backstage team: On stage, you mark your own request sorted, and have no
  "On my way" or "Resolved" on anyone else's.
- A browser signed in to an account opens its halls from the halls board,
  never with a code: a code link opened there says so and offers "Open your
  halls" or "Sign out". To join as a guest on that device, sign out first.
- Help: in a hall, tap Help, then what it is about (Sound, Vision,
  Lighting, Stage, Presenter, IT / network or Something else): that tap
  sends it. Type a few words first if you like; Enter moves to the
  categories and sends nothing. Help then says what happened: "Help
  asked", "Ana is on the way", then "Resolved" for 30 seconds. Tap it to
  say "It's sorted" or "Cancel request" ("Keep it open" changes nothing).
  A request stays red on the board until someone backstage presses "On
  my way", and on the board until it is resolved.
- New messages: a hall page you have scrolled up stays where you left it;
  "↓ 3 new" at the bottom says how many came and takes you there. A "New"
  line sits above the first message that came since you last touched the
  page. Nothing flashes. The hall page fits a phone held upright.
- When the event is over, close the black window (or press Ctrl+C in it).
  Halls, history and accounts are kept for next time.

Upgrading
---------
Upgrade between shows, never the night before one: upgrade, rehearse, then
run the show on the build you rehearsed.

1. Close the old copy's black window (or press Ctrl+C in it): it saves
   as it stops.
2. Extract the new zip into a new folder (Extract All).
3. Copy the old folder's app\data and app\uploads into the new folder,
   over its empty ones, before the new copy's first start.
4. Start the new folder's start-agmessage.bat from the same Windows
   account as before. The keys that open the saved links, the
   certificate and the audit log's key are in that account's
   %LOCALAPPDATA%\AGMessage, not in the folder.
5. Windows Firewall asks about the new folder's node.exe (below).

- The data folder says which build and format last wrote it
  (app\data\format.json). The first start of 0.6 on a 0.5 folder copies
  the folder, as it was, into app\data\backups\format-1-<time>-... before
  it changes anything, and the black window says so ("Data folder:
  format 2 · moved from format 1 at this start; the folder as it was is
  kept in ..."). It needs free space for the copy and 1 GB beside it.
  Keep that copy until the show on the new version is over; then it
  may be deleted.
- The first start of a version that keys the audit log asks you to
  accept the older entries at Admin -> Health (type the token from this
  window).
- Newer is the build number: 0.6.0+41 is newer than 0.6.0+37, and
  0.6.1+40 than 0.6.0+39. Admin -> This laptop's "Data folder" line
  names the build that wrote the folder before this start; "a newer
  build than this one" there means an older build was started on it.
- Going back: an older build of the same format opens the folder and
  says so. A build of an older format refuses it and changes nothing:
  "AGMessage cannot start: this data folder (...) was last written by
  AGMessage 0.7.0+52 in format 3, and this build (...) reads format 2
  and older. ..." Start the newer build again, or start the older one on
  the copy the words name. 0.5.1 reads no format: it opens a 0.6 folder
  with the losses "Going back to 0.5.1" names below. Do not go back to
  0.5.1 during a show.

Windows Firewall, a new folder, a standard account, a Public network
---------------------------------------------------------------------
Windows asks about node.exe the first time a copy serves from a new
folder, and each version you extract is a new folder.
- Choose "Allow access". On a standard Windows account that button
  needs an administrator's password. Without one, phones and tablets
  cannot reach this laptop (http://localhost:3023 still works on it);
  Cancel may leave a rule that blocks it.
- On a network Windows calls Public (often a venue's Wi-Fi), the rule
  must cover Public networks too. Or make the network Private: Settings
  -> Network & internet -> Wi-Fi (or Ethernet) -> the network -> Private
  network.
- Admin -> This laptop says the network's profile and whether a rule
  lets this copy's node.exe in on it ("no rule ... on Public: phones
  there may not reach AGMessage", "a block rule on Private: phones there
  cannot reach AGMessage"). Allow it once on the show's Windows account,
  on the kind of network the venue has, before you go.

The words AGMessage uses
------------------------
One word for each thing, on every page:

  hall       A space at the venue (Hall 2, the Foyer) with its room. Never
             "meeting" or "session".
  room       Where a hall's people write to each other, named as the hall
             is: "Hall 2".
  code       The 6 characters a guest types to join a room; on the admin
             page, the guest code.
  seat       Where a person sits: On stage, Backstage or Observer (the join
             page asks where you are).
  the Board  Everyone seated On stage: presenters and board members.
  backstage  The Backstage seat's people, the backstage team, who write to
             the Board.
  screens    The browsers on walls and lecterns that hold a screen's link
             (/d/...): a projector PC, a lectern monitor, a foyer TV.
  the speaker's screen
             Stagewatch's confidence monitor.
  Send       puts a message into the room; Show on puts something on
             screens.

What AGMessage tells Stagewatch still counts the halls as "meetings" (its
status, and the show desk's answers), as Stagewatch reads them. A hall's
history keeps the words it was written in: a line from before 0.6.0, such
as "Session restored", stays as it was.

The audit log, and where to keep this folder
--------------------------------------------
Halls -> Accounts -> Audit log lists every sign-in, change of rights, room
control and screen take, newest first, and each start by another build
than the one that last wrote the data folder (server.upgraded: from
which build to which, and the copy kept when the folder's format moved).
Each entry is chained to the one
before it with this laptop's key (machine.key, kept outside this folder),
so a line that was changed, removed, or written without the key shows.
"Check the log" answers with one mark, and each row carries its own:

    ✓ Intact           every entry keyed on this laptop, checked
    ◇ Linked           entries it cannot check, accepted on this laptop
    △ Not vouched for  entries it cannot check, not accepted yet
    ✕ Broken           a line changed or missing, or entries cut

- The first start of a version that keys the audit log (0.6.0, after
  0.5.1) asks you to accept the older entries at Admin -> Health: type the
  token from this window. The browser opens there. Until then the log
  reads △, and each start asks again; nothing else waits.
- Accept is done only on this laptop, signed in with its token (Admin
  login), and you type the token again in the dialog. Each finding has its
  own tick; a ✕ asks for a second tick, because what it names (entries
  missing, say) cannot be brought back. An admin account is told where to
  accept, and has no button.
- The machine key also keys the audit log and signs its exports. A rebuilt
  Windows profile or a new laptop turns the earlier entries △ until
  accepted and changes the signing key, and anyone holding a copy of
  machine.key can write entries that check and sign exports of them. Run the
  show from one Windows account: two accounts taking turns on one folder
  each need an Accept at every switch.
- Keep this folder where only the show's Windows account can write it: not
  a USB stick, not a shared folder. Whoever can write it can change
  AGMessage itself, and then the log says whatever they make it say. At
  each start, compare the "Signing key:" line in the black window with the
  show's paperwork. A "Key folder:" line there means someone set
  AGM_KEY_DIR.
- Going back to 0.5.1: its check reads a keyed log as "Broken at line N:
  entry N was changed after it was written", and it writes on. Back on
  0.6.0, the entries it wrote read △ until accepted. 0.5.1 has no export;
  one already made stays checkable with the release's verifier. After a
  split (below), 0.5.1 reads "Broken at line 1 of audit-<time>.jsonl:
  entries 1 to 2003 are missing before entry 2004", since it knows no
  archive; it never touches app\data\audit-archive.

The audit log across events
---------------------------
The audit log carries on from one event to the next. Archiving an event
leaves an archive point in it, as the first line of a file of its own.
- An admin (the token at this laptop, or an admin account) may split the
  log at a point: Admin -> Health -> Split the audit log..., choose the
  point, type the word split. The entries before it move, whole files,
  into a signed archive in app\data\audit-archive\. Nothing is deleted.
  The check then starts at the point, names the archive, and reads no
  better than before: an archive of accepted entries stays ◇.
- A split is refused while anything before the point is open or broken
  (accept it first at Admin -> Health), and while an export is being made.
- Leave app\data\audit-archive where it is. An archive moved or removed,
  or one whose files were changed, reads ✕ until it is accepted with the
  token, and its entries can no longer be checked on this laptop.
- Halls -> Accounts -> Audit log lists each archive with its own Check.
  Every export carries the archives. An archive is checked on its own
  with the same verifier and the same three commands, in its folder:
      node verify-audit.js <the archive's folder> --fingerprint <your record>
- If AGMessage stops part way through a split (a backup tool holding a
  file, say), the log reads △ "not finished" until the next start, which
  finishes it; Finish the split on the same dialog does it too. An
  export is refused until the split is finished.

Checking the audit log on another computer
------------------------------------------
Export at the end of each show day, and keep the export off the laptop.
If the laptop is lost, the exports you kept are what is left to check.

- Copy the "Signing key:" line from the black window (all 64 characters,
  also on Admin -> Health with Copy) into the show's paperwork. Whoever
  checks an export compares it with that record: never with the export,
  which anyone could sign with a key of their own.
- Export: Admin -> Health -> Export..., or Halls -> Accounts -> Audit log
  -> Export... (an admin, or an account given "Export the whole audit log";
  the token at this laptop too). From another device it works only over
  https:// (see Encrypted connections). Health then names the last
  export.
- The export holds every entry: names, addresses and what each person did.
  Entries from before 0.6.0 can also hold the first words of messages shown
  on screens and the names of files shown there. Give it only to whoever
  checks it. Made at this laptop, it is saved in this laptop's Downloads
  folder: move it off, then delete it here.
- To check it, take the verifier from the AGMessage release the export
  names (agmessage-audit-verifier-<version>.zip on the release page; check
  its SHA-256 against that release's SHA256SUMS), not the copy inside the
  export, which came from the laptop under check. Extract both, then:
      node verify-audit.js <the export's folder> --fingerprint <your record>
  or open verify.html in Chrome or Edge, type the key and choose the
  export's folder. 0: signed by that key, whole, and the laptop said ✓.
  1: the same, and the laptop said ◇ or △ (read its findings). 2: the same,
  and the laptop said ✕ (also when every file is what was signed and the
  entries break where the laptop's own check said they do). 3: nothing in
  it is vouched for. 4: no key given.
  --earlier <an older export's folder> checks that every entry the older
  one held is still in the newer one, byte for byte.
  Check it before browsing the export's folder: a file the export does
  not list ends the check (3), and some desktops add their own (a Mac's
  Finder writes .DS_Store). Remove it, or extract the zip again.
- Cancel while the export is made stops it: nothing is saved.
- By hand, in the export's folder (OpenSSL 3; the first line is the
  compare, and a mismatch ends the check):
      openssl pkey -pubin -in signing-key.pem -outform DER | sha256sum
      openssl pkeyutl -verify -pubin -inkey signing-key.pem -rawin -in SHA256SUMS -sigfile SHA256SUMS.sig
      sha256sum -c SHA256SUMS
  On Windows, certutil -hashfile <file> SHA256 gives the digests; the
  signature needs OpenSSL or the verifier.
- What it proves: the files are what this laptop exported, signed by its
  key; what this laptop's own check said of them; and that every line is
  whole and linked. Not who really acted, nor when (the times are the
  laptop's clock), nor anything about someone who could change AGMessage on
  the laptop or holds its machine.key.

Menus and keys
--------------
A message keeps two buttons on its row: Reply, and the one you use most
(Ask the operator, Send now or Show on screens). Everything else you may
do with it is in its ⋯ button, and right-click or Shift+F10 (or the menu
key) opens the same list. Delete, Ask the operator and Show on screens
moved there in 0.6.0. A file in the On stage panel and each screen in
Screens have one too. Something you may do but not now is greyed, with
the reason under it ("Not connected — AGMessage is reconnecting.").
On a message with the focus (click it first):
  R reply, E react, F send to another hall, P pin (the note at the bottom
  offers Undo for 10 seconds), D download a file, Enter look at a file,
  Delete or Backspace delete your own (it asks first).
Shift+right-click opens the browser's own menu (Copy, spelling). No page
opens a browser pop-up: what cannot be undone asks in place, beside what
it acts on, and Escape answers no.

The rest of the hall page works the same way. A person's name on a
message, and each person under People, opens a small menu: Mention puts
"@Kim " in your message box. The ⋯ beside Send holds Draft a reply,
Priority, Attach a file..., Remove the file and Cancel the reply (Escape
in the message box or on Send does that too). The guest code in the header copies
the code or the join link; the countdown there, for the backstage team,
opens the speaker's screen box or shows the countdown on the hall's
screens. The first Tab is "Skip to message box" ("Skip to messages" for
an observer). The messages are one Tab stop: the arrow keys move between
them, Up from an empty message box goes to the newest, and Escape comes
back to the box. An observer reads a question's answers as words.

The other pages work the same way. On the admin page each hall, person,
message of the live feed, linked Patterns or PlayMap, the Stagewatch
link and the internet link's card has its ⋯ (Close hall..., Clear
messages..., Log out..., Delete for everyone..., Set up..., Turn off...
and the rest ask first). Linking a Patterns or PlayMap is one small
form: its pairing token, the hall from a list, and the start of its
certificate's fingerprint. On the halls board a hall's name opens it (a
middle click opens a new tab), and its ⋯ has Open in a new tab, Copy
link, Copy guest code and Set up...; a help request's ⋯ has On my way,
Resolved and Open its hall. On the Accounts page each account's ⋯ has
Edit..., a new one-time password, Sign out everywhere, Turn off and
Remove; a row you may not change says why on its Edit. Each audit log
entry's ⋯ copies it, or keeps the list to its actor or its target (Show
all brings the rest back). The first Tab on each page is a "Skip to ..."
link, and each list is one Tab stop: the arrow keys move between its
rows.

Screens (projector PC, lectern monitor, foyer TV)
-------------------------------------------------
In a hall, Screens -> Add screen. The screen's link is copied: open it in
the browser on that screen (double-click for full screen) and leave it.
From the hall you can then show on it: the holding image, a message, an
image or PDF page shared in the hall, the hall's countdown with a message
under it (the speaker's comfort monitor), the clock, or black. The console
says "on screen" only when the screen confirms it. Each screen's row keeps
Identify; its ⋯ (or a right-click on it) has Tick only this one, Copy
link, Open, Rename..., New link... and Remove.... Anyone with a screen's
link can see that screen: give it only to that machine. "New link..."
stops the old one at once.

Stagewatch (the countdown) for each hall
----------------------------------------
Halls -> a hall's Set up: the address of that hall's Stagewatch and a
"node" API key made in Stagewatch -> Settings -> Remote -> API keys. Halls
without their own use the one in Admin -> Show network. The hall's
countdown then shows in the hall, on the board and on its screens; a
message can go straight to the speaker's screen, or to the Stagewatch
operator to approve and pass on (confidence monitor, moderator, backstage,
interpreter, a department, or just for the operator).

Patterns and PlayMap
--------------------
Admin -> Show network -> a Patterns or PlayMap that is heard -> Link...:
paste its pairing token, then type the first 16 or more characters of the
certificate fingerprint it shows on its own screen. Its state then shows
on the halls board; project managers and senior techs can propose the
commands it lists to the show desk, where a person approves them.
Its pairing token is full control of it, so AGMessage sends it only to
this laptop, or over HTTPS to a certificate you confirmed that way. A
Patterns or PlayMap on another machine without HTTPS shows red and is sent
nothing: turn HTTPS on in it. A changed certificate is refused until you
type the start of the new one (Confirm certificate... / Accept new
certificate...).

Remote participants (optional)
------------------------------
If someone can't be on the venue's network, expose the local server
through a free Cloudflare tunnel — built right into the bundle, no
separate install needed.

  1. Open http://localhost:3023/admin on this laptop.
  2. Scroll to "Remote access (Cloudflare tunnel)" and toggle it ON.
  3. Within 5-10 seconds a public HTTPS URL appears
     (e.g. https://xxxxx.trycloudflare.com) — click Copy and send it
     to the remote person with their hall's code or their account.
  4. It stays on until the end of the show day (06:00 by this laptop's
     clock; turned on after 05:00, 06:00 the next day), then turns off
     by itself and stays off. To end it sooner, or keep it later, choose
     Tunnel until... in the card's ... menu and give a time of day by
     this laptop's clock (a time already past today is tomorrow's).
     Toggle it off when the event ends.

If AGMessage starts again before that time (a restart, a crash, an
upgrade, the laptop woken or restarted), the link is turned on again by
itself, until the same time. Its address is new: the card says "New
address" and shows it. Send the new address to the remote people; the
one before no longer works. If the laptop is not online yet when
AGMessage starts (just after a boot), the card says the link was "Not
turned on again": once the laptop is online, turn it on again (it keeps
the same end), or it comes back at AGMessage's next start.

The internet link has 150 places: at most 150 phones, tablets, pages and
screens through it at once, and half of them at most from one network (a
mobile operator often puts many phones behind one address). A page that
has not joined a room within 20 seconds gives its place back. The venue's
Wi-Fi never waits for the tunnel. The card reads, for example, "Internet
link: 37 of 150 places · 12 networks · refused today: 4 full, 1 one
network's share".

Before doors, with the tunnel on:
  - Read the card's check: "Checked 14:02 · round trip 85 ms (max 140 ms)"
    is the laptop's side of the link. "△ The internet link did not
    answer: remote phones cannot join." means remote people cannot join
    now: check the laptop's internet. Check again asks for another (once a
    minute at most; until then it says "Checked 20 s ago.").
  - Walk it once: one phone on mobile data, its Wi-Fi off, opens the
    largest hall through the link. Write down how long it takes to show
    the newest message. Over 5 seconds, or a check over 1 second, is a slow
    link: tell the remote people before doors.

Accounts with admin rights cannot sign in through the tunnel unless an
admin allows it (Admin -> Accounts and access). The bundle ships
cloudflared.exe in bin\, and AGMessage runs only that one, never a
cloudflared found elsewhere on the PC. If it is missing (an antivirus may
remove it), the card says "cloudflared not found in this copy
(bin\cloudflared.exe): re-extract the portable folder. ..." and the link
stays off: download the zip again and Extract All.

For a show with remote people, a named Cloudflare Tunnel is better: it
keeps one address across restarts, so nobody needs a new one mid-show.
Set one up in your Cloudflare account (a stable subdomain pointing at
http://localhost:3023), run cloudflared with it from a separate window,
and leave this toggle off — the server doesn't depend on it.

Troubleshooting
---------------
- "Windows Defender SmartScreen" may warn you the first time you run
  the .bat file. Click "More info" -> "Run anyway". The file is a
  normal batch script — you can open it in Notepad to inspect.

- The browser opens only once this copy is serving, and only from the
  window's first start. If it does not open, open http://localhost:3023
  yourself.

- "AGMessage was started from inside the zip. Close this window,
  right-click the zip, choose Extract All, and run start-agmessage.bat
  from the extracted folder.": do just that. Nothing was started, and
  no browser opens.

- "This copy is missing node\node.exe. Download the portable zip again
  and Extract All. If it keeps going missing, your antivirus may be
  removing it.": the folder is not a whole copy (or the bundled Node was
  removed). The same is said of app\supervise.js, app\server.js or
  app\node_modules.

- "AGMessage did not start - the reason is above.": the lines just above
  it say why (a port in use, a data folder already in use, a folder that
  cannot be made, or the watchdog giving up). "Server stopped." means it
  was stopped on purpose.

- "AGMessage cannot start: the uploads folder ... cannot be made
  (EACCES). ...": the folder named cannot be made or written by this
  Windows account (the data folder's words are the same, and "the
  rooms folder ... cannot be read" for one inside it this account
  cannot list). Move this copy to a folder of its own that you can
  write to, or set AGM_DATA_DIR / AGM_UPLOAD_DIR to one. It is not
  started again by itself; folders made before the one that failed
  stay, empty. "AGM_RUNS is ..., which names no way AGMessage runs":
  remove AGM_RUNS from the .bat; the portable folder needs none.

- The black window's lines are kept in app\data\logs\server.log, each
  with its time (never the admin token; past 2 MB it becomes
  server.1.log and a new one begins, so at most two). When the window
  has closed, or AGMessage stopped by itself, read why there. The
  watchdog's line for a start it refused carries the reason: "server
  stopped: cannot start as configured (code 3): the uploads folder ...".
  On an installed PC the next start says it on Admin -> This laptop,
  under "Before this start".

- Admin -> This laptop says, each with where it was read: the build and
  how it runs, the data folder's format and the build that wrote it
  before this start, the LAN addresses (Copy LAN address copies one), HTTPS
  and why it is off, how many sealed values open, the screens that
  confirmed what they show, Stagewatch, the internet link, why the
  watchdog started it again (or why the start before was refused, or
  the watchdog gave up), what this run goes without, the sleeps the
  watchdog recorded ("once today · the last asleep from ..."), and
  whether the laptop is kept awake while a hall is live ("not held: ..."
  says why not; PowerShell locked down by IT is one reason). From
  Windows: the network's profile (Private, Public or Domain) and whether
  a firewall rule lets this copy's node.exe in on it ("no rule ... on
  Public: phones there may not reach AGMessage" is the case to fix
  before doors: allow it, or make the network Private), sleep and the
  lid on mains (a laptop that sleeps takes AGMessage with it), the
  server task, and the laptop's admin. Refresh reads Windows again; a
  fact it could not read in 5 s says "unknown" and why.

- "[tls] the certificate, which ends ..., is due for renewal and not
  renewed at this start, which has no network address": this laptop had
  no network yet, so a new one would have named no address. It serves
  on with the one it has. Once the laptop is on the network, press New
  certificate on the admin page (HTTPS), which This laptop's HTTPS line
  names too; starting AGMessage again then renews it as well. Devices
  that trusted the old certificate are asked to trust the new one.

- "Token: not shown here, since this output is not a window a person
  reads and may be kept.": AGMessage was started with its output sent
  to a file or a log, where a token would stay for anyone to read.
  Start it from start-agmessage.bat in its own window, or set
  ADMIN_TOKEN before the start to choose a token yourself: 16 or more
  random letters and digits, never a word.

- Lines that say what this run goes without. Each file is left as it is,
  never replaced, and the copy serves on:
  - "Secret: ...secret.key could not be read (...)": guests and invite
    links are signed with a secret of this run's own, so links handed
    out before do not work until it can be read again (another program,
    often an antivirus, may hold it: start AGMessage again).
  - "HTTPS: off — ...tls.json could not be read" or "the private key in
    ...tls.json does not open with this laptop's machine key": devices
    use http:// this run. A certificate made on another laptop or
    Windows account never opens here: to make a new one, close
    AGMessage, move tls.json out of %LOCALAPPDATA%\AGMessage, and start
    it again (each device trusts the new one once).
  - "Context: This AGMessage's context token does not open ...": other
    show systems cannot read this AGMessage until Admin -> Health -> New
    token makes one; give them the new token.
  - "Settings: ...settings.json could not be read (EBUSY)": this run
    has no Stagewatch link or saved keys, and refuses any setting
    changed ("Not saved: ..."), so the file is never written over.
    Start AGMessage again once nothing else holds it (an antivirus or
    a backup may). "...holds no settings AGMessage can read, nor does
    its .bak": put back a copy of settings.json, or move it aside and
    start AGMessage again to begin with new settings (set its links
    and keys again).

- A port already in use is named by who holds it:
  - "AGMessage 0.5.1 (build ...) is already running on port 3023. Use its
    window, or close it and start this copy again.": an AGMessage left
    running, perhaps an older one. Its version is at
    http://localhost:3023/api/health.
  - "The AGMessage installed on this PC (0.6.0, build ...) is serving on
    port 3023. Open it from Start → AGMessage → Open AGMessage, or set
    PORT to another number to run this copy beside it."
  - "Another program is using port 3023. Close it, or set PORT to another
    number."
  To run this copy on another port, edit start-agmessage.bat and change
      set PORT=3023
  to another free port (e.g. 4023), then relaunch.

- "AGMessage 0.6.0 is installed on this PC and starts with Windows. This
  window starts a separate portable copy.": AGMessage is installed here
  too. The portable copy runs beside it only on a port of its own. A copy
  missing its files then ends with "To use the installed AGMessage:
  Start -> AGMessage -> Open AGMessage."

- "AGMessage cannot start: this data folder (...) was last written by
  AGMessage ... in format 3, and this build (...) reads format 2 and
  older.": a newer AGMessage has changed this folder; see Upgrading,
  Going back. Nothing was changed, and nothing is written in the folder,
  not even the window's log. "...format.json could not be read (EBUSY)":
  another program holds it; start AGMessage again. "...holds no format
  AGMessage can read": put back the copy it had.
- "AGMessage cannot start: ...marker ...format.json could not be written
  (EBUSY)": the folder would not say which build last wrote it, so
  AGMessage does not serve it. Another program (an antivirus, a backup)
  holds it: start AGMessage again; nothing waits for it.
- "AGMessage cannot start: the data folder (...) is moved from format 1
  to 2 only once a copy of it is kept, and its disk has ... MB free":
  the first start of 0.6 on a 0.5 folder copies it first, and keeps
  1 GB free beside the copy for the saves and logs. Free some space on
  that disk and start again. A copy cut short (the window closed, the
  power gone) is removed at the next start, which copies again.

- "AGMessage is already running on this data folder": a second copy of
  this folder was started while the first runs. It stops before it
  touches anything; use the window that is already open. (A second copy
  on another port needs a folder of its own.)

- "◷ Waiting — it goes when the connection is back" on a message: the page
  is not connected. Leave it: it is sent by itself when the connection is
  back. "△ Not sent: ..." says why AGMessage refused it: Retry sends it
  again, Edit puts it back to change. "Not sent — choose the file again":
  the page was reloaded before the file was uploaded (or the laptop no
  longer has it); choose the file again.
  "Not connected — AGMessage is reconnecting." on a pin, a reaction, a
  screen's take or an admin's act: it was not sent; do it again once the
  page is back. "No answer — check the connection.": AGMessage did not
  answer in 5 seconds; its answer is shown if it comes later. Check
  whether it was done before doing it again.

- "Reconnecting… what you write waits here until we're back." at the top
  of a hall's messages (and "Offline · reconnecting" beside the dot after
  5 seconds): the page lost its connection to AGMessage - the Wi-Fi, or
  the laptop restarting. Leave it open: it comes back by itself, at once
  when the phone or tablet is woken or the Wi-Fi is back, and what was
  written meanwhile is sent then. Nobody in the hall is told it joined
  again.
  "Busy — trying again in 3 s." at the top of a page: AGMessage is taking
  many connections from the same network at once (a room filling up). Leave
  it: the page connects by itself after those seconds, without a reload.
  Through the internet link (the tunnel), a remote phone may read:
    "Busy — many phones are connecting from your network. Trying again in
    3 s." - the same, for its mobile network: leave it.
    "Many phones from your network are already connected through the
    internet (75). Trying again in 31 s." - its network holds half the
    link's places; it comes in when one of them leaves.
    "AGMessage's internet link is full (150 phones). Trying again in 34 s.
    On the venue's Wi-Fi there is room." - every place is taken; on the
    venue's Wi-Fi it joins at once.
    "Too many wrong codes from your network — wait a minute." - someone on
    the same mobile network typed wrong codes; wait a minute and type the
    code again.
  Each page tries again by itself; the admin page counts every refusal of
  the day on the tunnel's card.
  "This AGMessage requires HTTPS — open it with https:// (see /tls).":
  the admin turned on Require HTTPS; open the same address with https://.

- "The AGMessage laptop is short of disk space, so files are paused":
  the disk is nearly full (under 1 GB free), so new files are refused
  before they could fill it; messages, screens and everything else carry
  on. Free some space and files work again at once.

- "This browser is too old for AGMessage. Update this device (iPadOS or
  iOS 14.5, or Chrome 84, or later), or use another.": the device's
  browser is older than AGMessage's pages need, so the page shows only
  this and never joins the hall. Update the device (an iPad or iPhone:
  Settings -> General -> Software Update; Android: update Chrome), or
  give that person another device. A Board device that says this is not
  supported: retire it from the Board or replace it.

- A PDF does not draw on an iPad, or on a screen's browser: PDFs need
  Safari 16.4 or later (iPadOS and iOS 16.4), Chrome 103 or later, or a
  current Firefox. On an older device, share the page as a picture (an
  image) instead.

- Forgot a password: an admin sets a new one-time password on the
  Accounts page. Lost the only admin
  password: on this laptop, the admin token printed in the black window
  still opens the admin page.

- Uploaded files are kept in:
      app\uploads\
  Delete this folder after the event if you want to clear attachments.

- Conversation history is kept in:
      app\data\rooms\
  Each room is saved as a JSON file. If the laptop restarts or you close the
  terminal by mistake, just relaunch start-agmessage.bat — every active room
  comes back with its full history, pinned messages, action prompts, and
  document references. Pages left open come back by themselves once it
  runs again, and nobody is announced again. A crash of the laptop itself
  (not of AGMessage) counts as a power cut: see below.

- Changes are written as they happen to a small log beside each room
  (app\data\rooms\<CODE>.log), before AGMessage answers, and folded into the
  .json snapshot regularly. A crash of AGMessage or of a browser loses
  nothing; a power cut can lose the last few seconds: what AGMessage has
  taken is in Windows' file cache at once, and on the disk once Windows
  writes it back. A change the disk will not take (a full disk, a log
  another program holds) is kept in memory, named on the admin page's
  Health line and put in the room's next snapshot; until that snapshot
  lands, a crash of AGMessage can lose it.

- When AGMessage stops (Ctrl+C, the window closed, its watchdog), it
  saves the audit log and its settings first, then each room that changed
  since its last snapshot, and only those, so a large event still stops in
  time. Then it writes app\data\last-stop.json to say it saved. The next
  start rewrites no room and adds nothing to any room's history. After a
  stop that did not save (AGMessage crashed or was ended, the laptop was
  switched off or Windows restarted it, or an older AGMessage ran on the
  folder after it), every room reads "— AGMessage restarted · 412
  messages kept —", once; Admin -> This laptop says which it was under
  Last stop. A file ending .tmp that a stop cut short leaves in app\data
  is removed by the next start.

What's new in 0.5
-----------------
Halls, accounts and screens
  - Individual accounts beside the codes: roles, halls per person, single
    rights an admin can add or remove, and an audit log of every sign-in,
    change of rights and screen (Halls -> Accounts -> Audit log; "Check the
    log" says whether any line was changed or removed).
  - Each hall its own Stagewatch; the halls board; help requests.
  - Screens: a link per screen, driven from the hall, confirmed on screen.
  - Send to Stagewatch with a destination for the operator to pass on.
  - Patterns and PlayMap linked: their state on the board, their commands
    proposed to the show desk; their token only to this laptop or to a
    certificate you confirmed.
  - Fixed: 0.4's "propose to the show desk" lines were refused by
    Stagewatch; PlayMap was not heard on the show network.
  - Signing out closes your other open pages of that sign-in too; a
    page left open and in use stays signed in through a long day.
  - People who may only read a hall (Viewers, observers) can no longer
    pin, react or answer action prompts.

Checked before release
  - Two independent reviews read every change of 0.5; the 59 defects
    they confirmed were fixed, each with a test (CHANGELOG.md).

Under the bonnet
  - Node.js 24 LTS and Express 5; every package current.
  - Every build is numbered: releases 0.5.0+17.abc1234, development builds
    0.5.0-dev.17+abc1234.
  - The analyzers, a secret scan, CodeQL and a dependency audit run on
    every change; each release carries a list of every package it ships
    (SBOM), the zip's SHA-256 and a build-provenance attestation.

Earlier (0.2 - 0.4)
-------------------
Security
  - Only people in a room can upload, and only PDF, images, Word, Excel,
    PowerPoint, CSV and text — checked by content, not just by name. Files
    are served so they can never run script inside AGMessage.
  - Pages carry a strict Content-Security-Policy. pdf.js runs with eval
    switched off; the libraries the pages use, their versions and
    licences: see THIRD-PARTY-NOTICES.md. multer 2 (fixes the 1.x
    denial-of-service CVEs).
  - Identities are issued and signed by the server: nobody can pose as
    someone else or delete their messages.
  - Optional lock: Admin -> Roles & invites. On stage and Backstage seats
    then need the invite link for that seat; anyone else joins as an
    observer.
  - Guessing codes, wrong admin tokens and message floods are
    rate-limited and locked out. Admin login never works through the tunnel.
  - Through the tunnel the limits count a network, an IPv6 phone by its
    network (its /64), so changing address steps out of none of them
    (sign-in's own allowance counts the full address, but its lock
    through the tunnel is per name, which no address change lifts); a
    flood of new addresses never gives anyone their allowance back.

Reliability and speed
  - Every change has a sequence number. A phone that drops off the Wi-Fi for a
    moment gets only what it missed when it reconnects, not the whole history.
  - A message you send shows "◷ Sending" until AGMessage has it, and its box
    keeps your words until then. Written while the connection is down, it
    waits on the page ("◷ Waiting — it goes when the connection is back"),
    also if the page is reloaded, and is sent when the connection is back,
    however long that takes; everyone then sees "written 14:02 · sent 14:06
    (offline)" on it, the halls board's help requests included. A message is
    never posted twice, even when it is sent again after a drop.
  - Quick drop-and-rejoin no longer spams "left / joined"; comings and goings
    fold into one quiet line.
  - A watchdog runs the server: if it crashes or stops responding (no
    heartbeat for 10 s) it is restarted - after half a second, then 4, 8,
    15, 30 s if it keeps failing - and everything comes back from the saved
    log. After 6 crashes in 10 minutes it stops and the admin page says why.
    The last crash is on the admin page (Health). A laptop that slept is not
    a server that stopped responding: the watchdog did not run either, so it
    judges nothing of that time, and AGMessage carries on after the wake.
    It writes "asleep from 2026-11-02 14:02:03 to 14:20:11 UTC (18 min
    8 s)" in app\data\watchdog.log, and Admin -> This laptop says it under
    Sleeps.
  - While a hall is live (a page open in it, a screen showing something
    other than holding, or its Stagewatch countdown running) AGMessage asks
    Windows to keep this laptop from going to sleep when idle (This laptop:
    Kept awake). Closing the lid or pressing the power button still does
    what the power plan says: set "When I close the lid" to "Do nothing" on
    mains before doors. A laptop that sleeps takes AGMessage with it, and
    every page waits until it wakes.
  - Open pages come back by themselves: after a drop (from half a second,
    and at once when a phone is woken or the Wi-Fi is back), after a restart
    (nobody is announced again; after a stop that did not save, the hall
    reads "AGMessage restarted"), and
    after AGMessage refused them at a busy moment, at the pace it gives
    ("Busy — trying again in 3 s."). A page down for 2 seconds says
    "Reconnecting…".
  - The admin page's Health line reads the server's delay ("loop delay p95":
    how long work waits for the server, its own 10 ms measuring tick taken
    off) and how busy it is ("busy N %"), then today's peaks: the
    highest of each reading this show day (the delay, how busy, the most
    connections from one address and through the tunnel (and from one
    network through it), the refusals through it, the largest hall,
    the most people joining a hall in 5 s, the longest snapshot, the time
    an audit entry takes to reach the disk). A show day runs from 06:00 to
    06:00 by this laptop's clock, so an evening that runs past midnight is
    one day. The peaks of the last 14 show days are kept in
    app\data\peaks.json, saved every 5 s while they rise and at once when
    AGMessage stops or crashes, so a restart keeps them; a hang the watchdog
    ends, or a power cut, can lose the last 5 seconds' readings. After a
    show or a rehearsal, one look at Health (or /api/health on this laptop)
    is the reading. They hold numbers and dates, never a hall, a name or an
    address.
  - Saves are crash-safe (written, flushed to disk, then swapped in, with a
    backup of the last whole copy). Saved keys are encrypted with a key kept
    outside this folder, so a copied folder carries no usable key.
  - "Seen by" under your own messages: backstage knows the Board has read it
    (at once, or within a second when many read at the same moment).

AI (optional; Admin -> AI drafts, or set ANTHROPIC_API_KEY)
  - Backstage: "Draft answer" writes a reply to the Board's latest question
    (or the one you're replying to) from the thread and the document on stage.
    It lands in your box to check and edit; nothing is sent until you press
    Send, and the transcript marks it "drafted with AI, sent by a person".
  - Action prompts: "Suggest" proposes tap-to-answer buttons.
  - Admin: "Minutes" lists decisions, open questions and action items; you read
    it first and post it to the room only if you want.
  - What's sent to Anthropic: the conversation, and the text of the document
    you have open when you ask for a draft.
  - Without a key, "Draft answer" and "Suggest" are drawn with a dashed
    edge: pressed, they say why ("AI drafts are off: they need an Anthropic
    key (admin) and the internet") and send nothing. Without the internet no
    draft can be made either. Messages, action prompts, documents, the stage
    link and the show network work without both.

Show network (Stagewatch, Patterns, presenter PCs) - Show Bus 1.2
  - Admin -> Show network: link Stagewatch (address + a "node" API key made
    in Stagewatch -> Settings -> Remote -> API keys). Everyone then sees the
    live stage timer in the header, and the backstage team can press the
    screen button on a message to put it on the speaker's screen. The
    message then shows whether it is on screen and when the speaker has seen
    or acknowledged it.
  - The link says "connected" only once Stagewatch accepted the key. Until
    then it says "checking key" and nothing is sent. "key refused: ..." (with
    Stagewatch's own words) means Stagewatch does not list that key: make a
    node key in Stagewatch -> Settings -> Remote -> API keys and enter it in
    Admin -> Show network or the hall's Set up. A refused key is tried again
    once a minute, so it never locks this laptop out of Stagewatch. With no
    key the link only shows the timer ("viewing").
  - Stagewatch, Patterns and presenter PCs on the network are found
    automatically (UDP 9928) and listed there, live or not heard.
  - "CLOCKS APART" on the admin page: this laptop's clock and Stagewatch's
    disagree by more than 2 s.
  - Other show systems can read this AGMessage's status (counts and the
    action-prompt questions only - never messages, names or documents) with the
    read-only token on the admin page.
  - Show desk: when Stagewatch keeps the show's approval queue, the backstage
    team can press the notepad button on a message to PROPOSE it for the
    speaker's screen instead - the show caller approves it in Stagewatch, and
    the message shows waiting / approved / done. The show desk can also send
    an approved notice ("Break in 5 minutes") to every open hall.
  - A line for Stagewatch is counted as Stagewatch counts it (an emoji counts
    two) and cut where Stagewatch cuts it, never in half an emoji: 500
    characters sent straight to the speaker's screen, 200 for a role screen or
    a department, 300 for the operator. Asked of the show caller, a line for
    the speaker's screen is at most 377 (Stagewatch's desk keeps 400 of a line,
    with its urgency and its "Got it"): a longer one is refused with how much
    fits, never cut - shorten it, or use Send now. Braces { } reach
    Stagewatch as ( ): Stagewatch would read {TIME} or {REMAINING} as its own
    placeholders. Every line sent straight to the speaker's screen is in the
    audit log (who sent it and how long, never the words).
  - All of this works on the venue network with no internet. Only AI drafts
    and the Cloudflare tunnel need the internet.

Encrypted connections (HTTPS)
  - AGMessage serves HTTPS on the same port as HTTP, with its own certificate
    (made on first start, kept outside this folder). Browsers warn until you
    trust it once on each device: open /tls (e.g. https://192.168.1.20:3023/tls)
    for the fingerprint and how to trust it on Windows, Mac, iPhone/iPad and
    Android. Check the fingerprint matches the admin page first.
  - Admin -> Encrypted connections -> "Require HTTPS": other devices must use
    https:// (this laptop and the Cloudflare tunnel are unaffected).
  - The link to Stagewatch is encrypted when Stagewatch offers it, and pinned
    to Stagewatch's certificate once Stagewatch accepts the key: if that
    certificate changes, the admin page says CERTIFICATE CHANGED and the link
    stays off until you accept it.

Sharing this bundle
-------------------
app\data and app\uploads hold the halls' real history, accounts, the audit
log and files. Before giving the bundle to anyone, double-click
make-shareable-copy.bat: it makes a copy next to this folder without them,
in a new folder each time (AGMessage-Portable-Windows-clean-<date>-<time>),
never into one that is already there. It says "Done" only after checking
that the copy holds nothing under app\data or app\uploads; otherwise it
deletes the copy and says so. Give away the copy you just made, not an
older one you may have started to test.

Tests (for developers): cd app, then: npm run check

From a git clone (developers): the two bundled programs aren't in git. Run
  powershell -ExecutionPolicy Bypass -File tools\fetch-runtime.ps1
once to download them (pinned versions, checksum-verified), or
tools\build-portable.ps1 to make the zip. CI (GitHub Actions) runs the
analyzers, the tests and the browser smoke test, builds the zip, and
starts it once extracted, on every push. A CI run's artifact is a zip
around the zip: extract both.
