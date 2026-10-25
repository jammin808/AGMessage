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
| `hall.post` | send messages, replies, action prompts and help requests; answer a prompt, pin, react; forward into the hall |
| `hall.files` | share files and push them to a hall, or forward one into it |
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

**Inside a hall.** Reading is `hall.view`; everything that changes what the others see — a message, a reply, a help
request, an answer to an action prompt, a pin, a reaction — is `hall.post`, so an observer or a Viewer reads, sees a
prompt's options and its tally, and is offered nothing to press. Forwarding a message posts it in the other hall, so the
rights there decide: an account's rights in that hall (and `hall.files` for a file), a code guest's own seat there (a
locked hall's observer seat stays an observer's), or, where the guest has no seat, the admin's link. The forward carries
the role and the account mark a post there would carry, and the picker lists only the halls that would take it. A help
request is not forwarded: it is tracked and answered in its own hall. An account's role in a hall follows its rights, so
the admin page's room list changes a code guest's role and refuses an account's (that is the Accounts page's); its link
lets a code guest forward into a hall, and is refused for an account that may not post there. An account with a hall
open on a laptop and a phone (or a guest with it open in two tabs) is one person there: listed, announced and counted
once, "left" only when the last page closes, and the room list's role, link and logout reach every one of those pages.
A locked hall's invite is for people who join later: a code guest already seated there keeps the seat while another of
their pages is open and for the few seconds before "left" (Wi-Fi drops, the page's reload after the admin changes their
role), under the same name and role; after the admin logs them out it is gone.

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
PlayMap. Each line carries the SHA-256 of the line before it, so an edited, removed or reordered line breaks the chain;
**Accounts → Audit log → Check the log** says where. It is flushed to disk before the action is acknowledged, and it
never carries a password, token, key or screen link. Project managers and admins read it.

## Where it lives

`app/lib/rbac.js` (the rights, pure), `app/lib/accounts.js` (accounts, hashing, sessions), `app/lib/http-accounts.js`
(the routes), `app/lib/audit.js` (the chain). Tests: `app/test/accounts.test.js`.
