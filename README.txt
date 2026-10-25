AGMessage — portable Windows bundle
====================================

What this is
------------
A self-contained copy of AGMessage that runs on any Windows laptop without
installing Node.js or anything else. Unzip the folder, double-click the
launcher, and share the URL with your team. Messages, files, help requests
and screens for every hall of the event; crew sign in with their own
accounts, presenters and guests join with a hall's code.

The build this copy is (e.g. 0.5.0+17.abc1234) is in the zip's name, the
black window's first lines, and the admin page.

First time on a new laptop
--------------------------
1. Unzip this folder somewhere convenient (e.g. C:\Tools\AGMessage).

2. Double-click:

       start-agmessage.bat

   A black window opens and says "AGMessage is starting...". LEAVE IT
   OPEN — the server runs inside it. Your browser opens at
   http://localhost:3023.

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
- Help: in a hall, the red Help button asks for Sound, Vision, Lighting,
  Stage, Presenter or IT. It stays red on the board until someone presses
  "On my way", and on the board until it is resolved.
- When the event is over, close the black window (or press Ctrl+C in it).
  Halls, history and accounts are kept for next time.

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
paste its pairing token. Its state then shows on the halls board; project
managers and senior techs can send it the commands it lists (risky ones go
to the show desk for a person to approve).

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

- If the browser opens but shows "This site can't be reached",
  wait five seconds and refresh. Node takes a moment to boot the
  first time.

- If port 3023 is already in use, close whatever's using it, or
  edit start-agmessage.bat and change:
      set PORT=3023
  to another free port (e.g. 4023), then relaunch.

- "AGMessage is already running on this data folder": a second copy of
  this folder was started while the first runs. It stops before it
  touches anything; use the window that is already open. (A second copy
  on another port needs a folder of its own.)

- "The AGMessage laptop is short of disk space, so files are paused":
  the disk is nearly full (under 1 GB free), so new files are refused
  before they could fill it; messages, screens and everything else carry
  on. Free some space and files work again at once.

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
  - Patterns and PlayMap linked: their state on the board, their commands.
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
  - Pages carry a strict Content-Security-Policy. pdf.js is 4.10.38 (fixes
    CVE-2024-4367) with eval switched off; SheetJS 0.20.3; mammoth 1.11.0;
    multer 2 (fixes the 1.x denial-of-service CVEs).
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
    and the server's own delay are on the admin page (Health).
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
    to Stagewatch's certificate: if that certificate changes, the admin page
    says CERTIFICATE CHANGED and the link stays off until you accept it.

Sharing this bundle
-------------------
app\data and app\uploads hold real meeting history, accounts, the audit
log and files. Before giving the bundle to anyone, double-click
make-shareable-copy.bat: it makes a copy next to this folder without them.

Tests (for developers): cd app, then: npm run check

From a git clone (developers): the two bundled programs aren't in git. Run
  powershell -ExecutionPolicy Bypass -File tools\fetch-runtime.ps1
once to download them (pinned versions, checksum-verified), or
tools\build-portable.ps1 to make the zip. CI (GitHub Actions) runs the
analyzers, the tests and the browser smoke test, and builds the zip, on
every push.
