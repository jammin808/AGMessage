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

3. On this laptop only, the sign-in page asks for the FIRST ADMIN: your
   name, a username and a password (10 characters or more; a few words
   together is easiest to remember). That account can do everything.

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
- A browser signed in to an account opens its halls from the halls board,
  never with a code: a code link opened there says so and offers "Open your
  halls" or "Sign out". To join as a guest on that device, sign out first.
- Help: in a hall, the red Help button asks for Sound, Vision, Lighting,
  Stage, Presenter or IT. It stays red on the board until someone presses
  "On my way", and on the board until it is resolved.
- When the event is over, close the black window (or press Ctrl+C in it).
  Halls, history and accounts are kept for next time.

The audit log, and where to keep this folder
--------------------------------------------
Halls -> Accounts -> Audit log lists every sign-in, change of rights, room
control and screen take, newest first. Each entry is chained to the one
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

Screens (projector PC, lectern monitor, foyer TV)
-------------------------------------------------
In a hall, Screens -> Add screen. The screen's link is copied: open it in
the browser on that screen (double-click for full screen) and leave it.
From the hall you can then show on it: the holding image, a message, an
image or PDF page shared in the hall, the hall's countdown with a message
under it (the speaker's comfort monitor), the clock, or black. The console
says "on screen" only when the screen confirms it. Anyone with a screen's
link can see that screen: give it only to that machine. "New link" stops
the old one at once.

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
  4. Toggle off when the event ends to take the tunnel down.

Accounts with admin rights cannot sign in through the tunnel unless an
admin allows it (Admin -> Accounts and access). The bundle ships
cloudflared.exe in bin\. If you'd rather run cloudflared yourself (e.g. a
named tunnel with a stable subdomain), leave the toggle off and run your
own from a separate window — the server doesn't depend on it.

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
  it say why (a port in use, a data folder already in use, or the
  watchdog giving up). "Server stopped." means it was stopped on purpose.

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

- "AGMessage is already running on this data folder": a second copy of
  this folder was started while the first runs. It stops before it
  touches anything; use the window that is already open. (A second copy
  on another port needs a folder of its own.)

- "The AGMessage laptop is short of disk space, so files are paused":
  the disk is nearly full (under 1 GB free), so new files are refused
  before they could fill it; messages, screens and everything else carry
  on. Free some space and files work again at once.

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
  Each room is saved as a JSON file. If the laptop crashes or you close the
  terminal by mistake, just relaunch start-agmessage.bat — every active room
  comes back with its full history, pinned messages, action prompts, and
  document references. Participants rejoin by reopening the page.

- Changes are written as they happen to a small log beside each room
  (app\data\rooms\<CODE>.log) and folded into the .json snapshot regularly,
  so even a power cut loses nothing but the last instant.

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
  - Only people in a meeting can upload, and only PDF, images, Word, Excel,
    PowerPoint, CSV and text — checked by content, not just by name. Files
    are served so they can never run script inside AGMessage.
  - Pages carry a strict Content-Security-Policy. pdf.js runs with eval
    switched off; the libraries the pages use, their versions and
    licences: see THIRD-PARTY-NOTICES.md. multer 2 (fixes the 1.x
    denial-of-service CVEs).
  - Identities are issued and signed by the server: nobody can pose as
    someone else or delete their messages.
  - Optional role lock: Admin -> Roles & invites. Board and research seats
    then need the invite link for that role; anyone else joins as an observer.
  - Guessing meeting codes, wrong admin tokens and message floods are
    rate-limited and locked out. Admin login never works through the tunnel.

Reliability and speed
  - Every change has a sequence number. A phone that drops off the Wi-Fi for a
    moment gets only what it missed when it reconnects, not the whole history.
  - Quick drop-and-rejoin no longer spams "left / joined"; comings and goings
    fold into one quiet line.
  - A watchdog runs the server: if it crashes or stops responding (no
    heartbeat for 10 s) it is restarted - after 2 s, then 4, 8, 15, 30 s if
    it keeps failing - and everything comes back from the saved log. After 6
    crashes in 10 minutes it stops and the admin page says why. The last crash
    is on the admin page (Health).
  - The admin page's Health line reads the server's delay ("loop delay p95":
    how long work waits for the server, its own 10 ms measuring tick taken
    off) and how busy it is ("busy N %"), then today's peaks: the
    highest of each reading this show day (the delay, how busy, the most
    connections from one address and through the tunnel, the largest hall,
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
  - "Seen by" under your own messages: research knows the board has read it.

AI (optional; Admin -> AI drafts, or set ANTHROPIC_API_KEY)
  - Research: "Draft answer" writes a reply to the board's latest question (or
    the one you're replying to) from the thread and the document on stage.
    It lands in your box to check and edit; nothing is sent until you press
    Send, and the transcript marks it "drafted with AI, sent by a person".
  - Action prompts: "Suggest" proposes tap-to-answer buttons.
  - Admin: "Minutes" lists decisions, open questions and action items; you read
    it first and post it to the room only if you want.
  - What's sent to Anthropic: the conversation, and the text of the document
    you have open when you ask for a draft.

Show network (Stagewatch, Patterns, presenter PCs) - Show Bus 1.2
  - Admin -> Show network: link Stagewatch (address + a "node" API key made
    in Stagewatch -> Settings -> Remote -> API keys). Everyone then sees the
    live stage timer in the header, and the research team can press the screen
    button on a message to put it on the speaker's confidence monitor. The
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
  - Show desk: when Stagewatch keeps the show's approval queue, the research
    team can press the notepad button on a message to PROPOSE it for the
    speaker's screen instead - the show caller approves it in Stagewatch, and
    the message shows waiting / approved / done. The show desk can also send
    an approved notice ("Break in 5 minutes") to every open meeting.
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
app\data and app\uploads hold real meeting history, accounts, the audit
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
