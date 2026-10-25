# Accounts, rights and the audit log

AGMessage has two ways in, and both are first-class:

- **An account** — a username and a password — for the people who work the venue: crew in the operating rooms,
  project managers, senior techs, admins. They see their halls on the halls board and open any of them as themselves.
- **A code** — a hall's or meeting's 6-character code — for presenters, board members and guests. They pick a name
  and where they are (on stage, backstage, observer), exactly as before 0.5.

## Roles

| Role | Halls | Can |
|---|---|---|
| Admin | every hall | everything: accounts, rights, settings, the audit log |
| Project manager | every hall | messages, files, screens (drive and manage), Stagewatch, Patterns / PlayMap, set halls up, the audit log |
| Senior tech | every hall | messages, files, drive screens, Stagewatch, Patterns / PlayMap |
| Tech | their halls | messages, files, drive screens, Stagewatch |
| Staff | their halls | messages and files |
| Viewer | their halls | read only |

An admin can make an exception for one person — tick or untick a single right on the Accounts page — and choose their
halls (or "every hall, including new ones"). The rights, as the server checks them:

| Right | Meaning |
|---|---|
| `hall.view` | see a hall: its messages, files, countdown and screens |
| `hall.post` | send messages, replies, action prompts and help requests |
| `hall.files` | share files and push them to a hall |
| `display.control` | change what a hall's screens show |
| `display.manage` | add, rename, move, re-link and remove screens; the hall's holding image |
| `stage.send` | send to Stagewatch: the speaker's screen, or to the operator to pass on |
| `nodes.control` | propose or send commands to Patterns and PlayMap |
| `halls.manage` | create halls and set them up (their own Stagewatch) |
| `users.manage` | create accounts and set roles, halls and rights |
| `settings.manage` | app settings: AI key, HTTPS, the tunnel, the show network |
| `audit.read` | read the audit log |

Rules that keep rights from growing by themselves: deny by default; only an admin makes an admin or hands out
`users.manage` or `settings.manage`, and only an admin changes, resets, signs out, turns back on or removes an account
that holds one of them (the Accounts page shows such a person as "Admin only" to anyone else); nobody changes their own
role, rights or halls; the last admin who can sign in stays one. A code guest's rights come from where they joined: backstage posts, shares files and sends to Stagewatch; on
stage posts and shares files; an observer reads. Screens, halls and other show systems need an account.

## The first admin

A new AGMessage has no accounts. Open it **on the AGMessage laptop** (`http://localhost:3023`): the sign-in page asks
for the first admin's name, username and password. "On the laptop" means a request from the laptop's own loopback,
addressed to `localhost`, `127.0.0.1` or `[::1]`, with no proxy or tunnel headers — a page served under any other name
is refused, even when that name leads back to the laptop. The admin then adds everyone else on the Accounts page (Halls →
Accounts); each new person gets a **one-time password**, shown once, which they replace at their first sign-in. The host
laptop's admin token (printed in its window) still opens the admin page there.

## Passwords and sessions

- scrypt with N = 2^15, r = 8, p = 3 (32 MiB, about a quarter of a second on a show laptop), two at a time so a burst of
  sign-ins never stalls a meeting; raised later without anyone noticing (an older hash is redone at the next sign-in).
- At least 10 characters, at most 128; not a common password, not the username or the person's name. A few words
  together is the advice on screen.
- Five wrong passwords for a username, or twenty from one address, in 15 minutes: wait 15 minutes. An unknown
  username takes the same time and gets the same words as a wrong password.
- A session is a random 256-bit token in a cookie the page's script cannot read (`HttpOnly`), never sent by another
  site (`SameSite=Strict`), only over HTTPS when the page is (`Secure`). Only its hash is stored. Idle for 14 hours or 7
  days old, it ends. Changing a password, turning an account off or "sign out everywhere" ends every session of that
  account at once — and closes its open pages, which reconnect with the rights it has now.
- Every state-changing request must come from AGMessage's own pages (the `Origin` check).
- Through the Cloudflare tunnel, accounts with admin rights cannot sign in unless the admin turns on "Let accounts
  with admin rights sign in through the Cloudflare tunnel" (Admin → Accounts and access).

## The audit log

`data/audit.jsonl`: one line per action that matters — sign-ins (and failed ones), the first admin, accounts and
rights, halls and their Stagewatch, screens (made, renamed, re-linked, removed, and every take: what went on which
screen, by whom), settings (which ones, never their values), sends to Stagewatch's desk, and commands to Patterns and
PlayMap. Each line carries the SHA-256 of the line before it, from a fixed first hash: at 20 MB the file is set aside as
`audit-<time>.jsonl` and the chain goes on in a new one. **Accounts → Audit log → Check the log** reads every file,
oldest first, as one chain, so an edited, removed or reordered line — the first and the newest included, or an older
file removed — breaks it, and the check names the file and the line; while the server runs, the newest entry on disk
must also be the one it wrote last. The check reads in slices beside the show, one at a time (a second click waits for
the same answer). What a chain without a key cannot show, and the check does not claim: the newest lines (or the
current file) removed while the server is stopped, or the whole chain written again, by someone who can write the data
folder.

Each entry is flushed to disk before the action is acknowledged. When the disk will not take it (full, or the file held
by another program) the action still goes ahead — a full disk must not stop sign-ins or takes during a show — the entry
stays in the chain in memory, the console and the admin page's health say so, and it is written ahead of the next
entry (or when the server stops), so what is on disk stays one whole chain. A half-written last line left by a power cut is cut at the next start
and the cut is recorded as an entry of its own (`audit.repair`). The log never carries a password, token, key or screen
link. Project managers and admins read it.

## Where it lives

`app/lib/rbac.js` (the rights, pure), `app/lib/accounts.js` (accounts, hashing, sessions), `app/lib/http-accounts.js`
(the routes), `app/lib/audit.js` (the chain). Tests: `app/test/accounts.test.js`.
