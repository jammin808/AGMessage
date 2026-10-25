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
that holds one of them (the Accounts page shows such a person as "Admin only" to anyone else); an account that is not an
admin manages only accounts within its own rights and halls, and hands out only those — it cannot make a richer account,
widen one, or reset a richer one's password (the page offers only what it holds, and shows a richer person as
"Locked"); nobody changes their own role, rights or halls; the last admin who can sign in stays one. A code guest's rights come from where they joined: backstage posts, shares files and sends to Stagewatch; on
stage posts and shares files; an observer reads. Screens, halls and other show systems need an account.

## The first admin

A new AGMessage has no accounts. Open it **on the AGMessage laptop** (`http://localhost:3023`): the sign-in page asks
for the first admin's name, username and password. "On the laptop" means a request from the laptop's own loopback,
addressed to `localhost`, `127.0.0.1` or `[::1]`, with no proxy or tunnel headers — a page served under any other name
is refused, even when that name leads back to the laptop. There is one first admin, even when two requests arrive at
once. The admin then adds everyone else on the Accounts page (Halls → Accounts); each new person gets a **one-time
password**, shown once, which they replace at their first sign-in (two saves at once still make one account). The host
laptop's admin token (printed in its window) still opens the admin page there; that sign-in lasts a day and survives a
watchdog restart, which keeps the token, but not a fresh start of AGMessage, which prints a new one.

## Passwords and sessions

- scrypt with N = 2^15, r = 8, p = 3 (32 MiB, about a quarter of a second on a show laptop), two at a time so a burst of
  sign-ins never stalls a meeting; raised later without anyone noticing (an older hash is redone at the next sign-in).
  A sign-in through the tunnel uses one of the two at most, so sign-ins on the venue network always have the other; each
  side waits in a short queue of its own, a sign-in past it is told "Sign-in is busy — try again in a moment", and one
  whose page has given up is dropped without being checked.
- At least 10 characters, at most 128; not a common password, not the username or the person's name. A few words
  together is the advice on screen.
- Five wrong passwords for a username in 15 minutes hold that username where they came from — one device on the venue
  network, or the whole Cloudflare tunnel — until 15 minutes after the first of them; twenty from one address hold that
  address. The AGMessage laptop is never held back by another device's wrong passwords, an admin's new one-time
  password ends the wait, and a signed-in person changing their own password counts only their own tries. An unknown
  username, a wrong password and a turned-off account take the same time and get the same words.
- A session is a random 256-bit token in a cookie the page's script cannot read (`HttpOnly`), never sent by another
  site (`SameSite=Strict`), only over HTTPS when the page is (`Secure`, through the Cloudflare tunnel too). Only its hash
  is stored. Idle for 14 hours or 7 days old, it ends; a page left open counts as in use, so a hall or the halls board
  open all day stays signed in. An account keeps its 20 newest sessions (a 21st sign-in ends its oldest), so one account
  signing in again and again never signs anyone else out. Signing out ends that session and closes the pages open on it;
  changing a password, turning an account off or "sign out everywhere" ends every session of that account at once — and
  closes its open pages, which reconnect with the rights it has now. The Accounts page counts only the sessions that
  still sign in.
- Every state-changing request must come from AGMessage's own pages (the `Origin` check).
- Through the Cloudflare tunnel, accounts with admin rights (`users.manage` or `settings.manage`) cannot sign in, nor use
  those rights on a session they already have, unless the admin turns on "Let accounts with admin rights sign in through
  the Cloudflare tunnel" (Admin → Accounts and access); turning it off ends admin rights on every page open through the
  tunnel at once. Such a sign-in is answered as a wrong password is, so the tunnel never tells a stranger that a password
  was right.

## The audit log

`data/audit.jsonl`: one line per action that matters — sign-ins (and failed ones), the first admin, accounts and
rights, halls and their Stagewatch, screens (made, renamed, re-linked, removed, and every take: what went on which
screen, by whom), settings (which ones, never their values), sends to Stagewatch's desk, and commands to Patterns and
PlayMap. Each line carries the SHA-256 of the line before it, so an edited, removed or reordered line breaks the chain;
**Accounts → Audit log → Check the log** says where. It is flushed to disk before the action is acknowledged, and it
never carries a password, token, key or screen link: a failed sign-in under a name that is no account is written as
"(unknown username)", since what was typed may be a password in the wrong box. Project managers and admins read it.

## Where it lives

`app/lib/rbac.js` (the rights, pure), `app/lib/accounts.js` (accounts, hashing, sessions), `app/lib/http-accounts.js`
(the routes), `app/lib/audit.js` (the chain). Tests: `app/test/accounts.test.js` (rights, accounts, hashing, sessions) and
`app/test/sessions.test.js` (signing in, the tunnel, the pages a session has open, restarts).
