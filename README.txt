AGMessage — portable Windows bundle
====================================

What this is
------------
A self-contained copy of AGMessage that runs on any Windows laptop without
installing Node.js or anything else. Unzip the folder, double-click the
launcher, and share the URL with your team.

How to use
----------
1. Unzip this folder to somewhere convenient on the meeting laptop
   (e.g. C:\Tools\AGMessage, or just your Desktop).

2. Double-click:

       start-agmessage.bat

   A black terminal window will open and say "AGMessage is starting..."
   Your default browser will open at http://localhost:3023 after a
   couple of seconds. LEAVE THE TERMINAL WINDOW OPEN — the server is
   running inside it.

3. In the terminal window you will also see a line like:

       LAN:  http://192.168.1.42:3023

   Share that URL with anyone on the same Wi-Fi / wired network.
   They open it in any browser — phone, tablet, laptop, it doesn't
   matter — and join the meeting.

4. One person clicks "Create new" on the join page to generate a
   6-character meeting code (e.g. K7P2QX). Share that code with the
   team. Everyone enters it, picks their role (on-stage director,
   research team, or observer), and joins.

5. When the meeting is over, close the terminal window (or press
   Ctrl+C inside it). The server stops and rooms are cleared.

Remote participants (optional)
------------------------------
If someone can't be on the venue's network, expose the local server
through a free Cloudflare tunnel — built right into the bundle, no
separate install needed.

  1. Open http://localhost:3023/admin and log in with the admin token
     printed in the server's terminal window.
  2. Scroll to the "Remote access (Cloudflare tunnel)" section near
     the bottom of the dashboard and toggle it ON.
  3. Within 5-10 seconds a public HTTPS URL appears
     (e.g. https://xxxxx.trycloudflare.com) — click Copy and send it
     to the remote user along with the 6-character meeting code.
  4. Toggle off when the meeting ends to take the tunnel down.

The bundle ships cloudflared.exe in bin\ — no manual download or PATH
setup required. If you'd rather run cloudflared yourself (e.g. with
a named tunnel and a stable subdomain), leave the toggle off and run
your own from a separate terminal — the server doesn't depend on it.

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

- Uploaded files are kept in:
      app\uploads\
  Delete this folder after the meeting if you want to clear attachments.

- Conversation history is now persisted to:
      app\data\rooms\
  Each room is saved as a JSON file. If the laptop crashes or you close the
  terminal by mistake, just relaunch start-agmessage.bat — every active room
  comes back with its full history, pinned messages, action prompts, and
  document references. Participants rejoin by reopening the page.

- Changes are written as they happen to a small log beside each room
  (app\data\rooms\<CODE>.log) and folded into the .json snapshot regularly,
  so even a power cut loses nothing but the last instant.

What's new in 0.2
-----------------
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
  - The launcher restarts the server within 2 seconds if it ever stops
    unexpectedly; everything comes back from the saved log.
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

Show network (Stagewatch and Patterns)
  - Admin -> Show network: link Stagewatch (address + a control API key made
    in Stagewatch -> Settings -> Remote -> API keys). Everyone then sees the
    live stage timer in the header, and the research team can press the screen
    button on a message to put it on the speaker's confidence monitor
    (with an acknowledgement the speaker taps).
  - Stagewatch and Patterns machines on the network are found automatically
    and listed there.

Sharing this bundle
-------------------
app\data and app\uploads hold real meeting history and files. Before giving
the bundle to anyone, double-click make-shareable-copy.bat: it makes a copy
next to this folder without them.

Tests (for developers): cd app, then: npm test

From a git clone (developers): the two bundled programs aren't in git. Run
  powershell -ExecutionPolicy Bypass -File toolsetch-runtime.ps1
once to download them (pinned versions, checksum-verified), or toolsuild-portable.ps1 to make the zip.
CI (GitHub Actions) runs the tests, the browser smoke test and builds the zip on every push.
