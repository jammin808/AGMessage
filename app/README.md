# AGMessage

A lightweight inter-team messaging system for AGMs and corporate conferences.

Runs as a single Node.js server on a laptop on the local network. Anyone with a
browser can join by entering a 6-character meeting code, a display name, and a
role (**director on stage**, **research team**, or **observer**).

The research team can send text, files, images, and **action prompts** (a
question with tap-friendly response buttons, e.g. *Yes / No / Defer*). Directors
on stage see these as large cards with big buttons they can tap discreetly to
answer without speaking.

No accounts, no database, no build step. Rooms live in memory for the duration
of the meeting.

## Features

- Real-time chat over WebSockets (Socket.io)
- Three roles with role-aware UI — directors get a low-distraction, large-print view
- **Action prompts** — send a question + custom response buttons to the stage
- **Pin** any message to a priority strip so directors always see it
- File & image uploads (up to 25 MB) — images render inline
- Join by 6-character meeting code; role picked at join
- Runs across a local network out of the box
- Optional remote access via `cloudflared` or `ngrok` tunnel

## Quick start

Requires Node.js 18+.

```bash
npm install
npm start
```

On start the server prints the URLs to share with your team, e.g.

```
AGMessage is running
---------------------
Local:   http://localhost:3023
LAN:     http://192.168.1.42:3023
```

Share the **LAN** URL with everyone on the same Wi-Fi / wired network. Nothing
else to install — they open the URL in any browser.

## Using it at a meeting

1. One person opens the URL and clicks **Create new** to generate a meeting
   code (e.g. `K7P2QX`).
2. Share that code with the whole team.
3. Each person opens the URL, enters their name, picks their role, and types
   the code.
4. Directors see a stage-friendly view. Research team can:
   - Send a **Message** (plain text).
   - Send an **Action prompt**: a question/suggestion with tappable answer
     buttons (defaults to *Yes / No*, add more like *Defer* or *Check slide 14*).
   - Send a **File / image** with an optional caption. Images render inline
     on the directors' screens.

When a director taps an action button, everyone sees the response appear under
the prompt. Directors can also tap **Reply with text** for a quick free-text
answer.

Anyone can **📌 pin** a message. Pinned messages appear in an always-visible
strip at the top — useful when the stage team needs a single question kept in
view.

## Remote participants (optional tunnel)

If a researcher can't be on the local network, expose the local server through
a tunnel. Keep the server running, and in a separate terminal run one of:

```bash
# Cloudflare (no signup, installs via: brew install cloudflared)
cloudflared tunnel --url http://localhost:3023
```

```bash
# ngrok (needs free account, https://ngrok.com)
ngrok http 3023
```

Either command prints a public HTTPS URL (e.g. `https://xxxx.trycloudflare.com`)
you can send to remote users. They open it, enter the meeting code, and join as
normal.

## Security notes

- Meeting codes are random and 6 characters, but **anyone with the code can
  join** — treat codes like meeting passwords and don't post them publicly.
- There is no persistent user database. Names are free-text; prefer real names
  for transparency inside a trusted meeting.
- Data is in-memory only. When you stop the server, rooms and history are
  gone. That is intentional — AGMs are one-off events, and nothing is kept on
  disk except uploaded files in `uploads/` (delete after the meeting).
- For production deployments, put it behind a reverse proxy with TLS (nginx,
  Caddy) or use the tunnel which terminates TLS for you.

## Project layout

```
AGMessage/
├─ server.js              Express + Socket.io server
├─ package.json
├─ public/                Browser client (no build step)
│  ├─ index.html          Join page
│  ├─ app.html            Chat app (adapts to role)
│  ├─ join.js
│  ├─ app.js
│  └─ styles.css
├─ uploads/               File uploads (created at runtime, gitignored)
└─ README.md
```

## Future enhancements

- Optional PIN / password per room
- Persist history to SQLite so a server restart doesn't wipe the room
- Presenter "clear stage" button (archive everything, start fresh between
  agenda items)
- Broadcast mode — push a file to everyone's screen full-screen at once
- Admin role that can kick users / lock the room once the AGM starts
