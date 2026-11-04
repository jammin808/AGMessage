# Screens — display URLs a hall's operators drive

A **screen** is any browser that should show something for a hall: the projector PC, a confidence monitor on the
lectern, a foyer TV, a green-room screen. Each screen has its own link. Open the link in that browser (full screen:
double-click) and leave it; the hall's operators change what it shows from AGMessage.

## What a screen shows

| Take | On the screen |
|---|---|
| **Holding** | the hall's holding image; with none, black with the screen's name, faint, so the crew knows which it is (`?idle=blank` hides the name) |
| **Message** | the words as large as the screen holds; how urgent is a band and a shape as well as a colour: ● note, ▲ soon, ■ urgent; an optional second line |
| **File** | an image, or one page of a PDF, shared in the hall; a page past the PDF's end shows its last page, and the console says so beside ✓ |
| **Countdown** | the hall's Stagewatch countdown in its own words and colour, its title and what's next — and a message strip under it: the speaker's comfort monitor. The strip's words shrink so it never covers the time, on an upright tablet too. With the link to Stagewatch lost it shows `--:--`, never a confident stale time — and while Stagewatch has not accepted AGMessage's key, or after it refused it |
| **Clock** | the time of day from AGMessage's own clock, in AGMessage's time zone (a screen PC's clock or zone may be wrong; a browser that does not know that zone shows its own) |
| **Black** | nothing |
| **Identify** | the screen's name, large, for six seconds, over whatever it shows |

A small dot in the bottom-right corner is the screen's link to AGMessage; after six seconds without it the dot turns
to a red square (`?status=hide` hides it). The screen keeps itself awake where the browser allows it (over HTTPS).

## Driving screens

In a hall (as an account with `display.control`): the header's ⋯ → **Screens…**. Tick the screens, then take Holding, Countdown, Clock,
Black, or type a message and choose **Show** (tick "Under the countdown" to put it in the countdown's strip). On any
message, or any image or PDF shared in the hall, **⧉** offers it to the ticked screens (a PDF from its first page).
A take goes to every ticked screen in one request — all 50 of a hall's screens if they are ticked; a screen it could
not reach (removed meanwhile, or not yours) is named in the console's note and on its line. Each screen a take reaches
is one `display.take` row in the audit log: who, which screen and what kind of thing ("a warning (28 characters)", "a
PDF at p. 3", "an image", "the countdown with words (8 characters)"), never the message's words or the file's name,
which the console and the halls board quote and name.

Every take is numbered. The screen renders it and says so, and only then does the console say **✓ on screen**. Until
then it says **◷ sending**; **△** and the reason when the screen could not show it (an image that did not load, a PDF
that did not render — the screen is then black, never the picture before it); **✕ offline** when no browser has the
link open. **Holding** reads "holding image" when the hall
has one, which is what the screen shows.

Several browsers can hold one link (a projector and its backup, a manager's laptop after **Open**). Each says for itself
what it showed: the console says **✓ on all 2 screens** only when every one did, **◷ sending — on 1 of 2 screens** until
then, and **△ could not show it on 1 of 2 screens** as long as any one could not. A screen whose network blips comes back
as the same screen, not a second one, by itself: from half a second after a drop, at once when its browser is shown
again or back online, and after AGMessage refused it at a busy moment, at the wait AGMessage named. It never says
"Busy" to the audience: it keeps its picture meanwhile, and its countdown dims as any stale one does. Only a refusal no
wait lifts (Require HTTPS, from a plain address) is said on it. A browser that vanished without closing counts until
AGMessage notices (within about 18 seconds).

After an upgrade a screen comes over to the new build by itself, between takes: it keeps showing its take until the
next one, and at that take it reloads instead of drawing it, so no take on the air is cut and the page it loads draws
that take and confirms it. A screen that holds one take all show (a clock, the countdown) is on the old build until its
next take; Admin → This laptop's Pages names it. A screen 0.5 opened has no way to reload itself: it keeps working, is
named there as a 0.5 screen, and is reloaded by hand once (or opened again from its link) before doors.

A screen keeps one PDF open and draws each page off screen before it swaps it in: stepping through a deck never blanks
the slide, and a rename or a reconnect leaves the picture alone. A slide the browser had to clear (its graphics reset)
is drawn again, never taken as still on screen. A file taken earlier that is still loading never paints over the one
taken after it. PDFs are drawn by pdf.js 4.10.38's legacy build, which a screen's browser runs from Safari 16.4 (iPadOS
and iOS 16.4), Chrome 103 or Firefox ESR, older iPads included. On a browser older than that a PDF take says **△** and
the screen is black: share the page as an image and take that instead.

## Managing screens

With `display.manage` (project managers, admins): **Add screen** (the new link is copied — open it on that screen),
**Copy link**, **Open**, **Rename…**, **New link…**, **Remove…**, and the hall's **holding image** (pick one of the
images shared in the hall, then **Use it**; the pick stays while the list refreshes, until the dialog closes). A screen's
row keeps **Identify**; the rest, with **Tick only this one**, is in its ⋯, which a right-click on the row and Shift+F10
open too. Rename… is a field in place; New link… and Remove… ask in place, naming the screen, inside the console, which
stays open. The halls board shows every hall's screens and their state, in the same words as the console.

## People's screens

Beside the hall's screens, a hall's people's own pages can be shown something over their chat: **the Board's** (every
page seated On stage in the hall's Main room, the presenters' and Board accounts' alike) or **one person's** (every page
of theirs in any room of the hall). A take is one of: back to chat, the hall's Stagewatch countdown (only where the hall
has one linked), the clock (AGMessage's time and zone), holding (a picture shared in a room of the hall the operator
may read, else the hall's holding image, else the AGMessage mark and the hall's name on black) or blank (black).

Who may show people's pages: the admin; an account with `display.control` in the hall ("Change what a hall's screens and
people's pages show"), from any room of it; and a guest seated backstage in the hall's Main room while its seats are
locked: the seat came from an invite, or is one the admin kept by locking the room (Lock seats keeps the seats taken at
that moment, and the admin sees and may move each). Never a page seated On stage, never the admin's view of someone,
and never a guest of an open hall, where anyone with the code may sit backstage. A person is named only while they sit
in a room of the hall the operator may read; anyone else is "not in this hall now". The console names the Board's
people only to one who may read the hall's Main room.

Every take is numbered, one count per hall, and a page shows the newest take addressed to it: its person's, or the
Board's on a page On stage, so **back to chat** is how a page is handed back. A page that comes On stage later, comes
back from a drop or a reload, or after a restart, is shown what it was shown, with no backlog. Each page says what it
did with its take, and only those reports make its status, person first: **◷ Sending** until every page has said;
**✓ On all 6 Board pages** / **On Ana's page** once each said it showed that take; **◐ 5 of 6 showing · 1 asleep or in
another app**; **△ Couldn't show it** and why; **▭ Ana minimised it at 14:02**; **○ Ana went back to chat at 14:02**, or
**Back to chat on all 6 Board pages** for a hand-back (never ✓); **✕ Nobody on the Board is online**. A report of an
older take, or from the admin's view of someone, counts for nothing.

A person's **Back to chat** is theirs on every page they have in the hall: each goes back to its chat, and the take
does not come back on a reload or a restart; a newer take shows again. **Minimise** is kept the same way, until they
show it again. A seat moved to or from On stage is told at once what it is shown now, and so is every page shown a
holding slide with no picture of its own when the hall's holding image is set or cleared, and every page shown a take
when the hall is renamed. The longest a Board page said it
was asleep or behind another app while a take was on it is kept for the show day (health's `peaks.pageHiddenMs`).

Each take is one `page.push` row in the audit log: who, whom ("the Board (6 pages)", or the person's name) and what
kind of thing ("the clock", "a holding slide"), never a file. Nothing of a take is on the halls board, in the context
another show system reads, or in the AI's brief. The hall page draws a take and its console with the next 0.6.0 unit;
in this build a take reaches people's pages over the wire alone (below).

## The link is a capability

`/d/<token>`: 256 random bits. It follows the W3C's good practice for capability URLs:

- it can only show — a screen's connection is listened to for nothing but its "shown" reports, and is never told its
  hall's code, which would let that browser into the hall as a guest (it is told the hall's name; Identify on a hall
  with no name draws no hall);
- the page is the same for any token (the server says nothing about a link by its URL), never cached, never indexed,
  and sends no referrer;
- AGMessage looks it up by its SHA-256; the token itself is sealed at rest so a manager can copy it again; it is never
  written to a log or the audit log (the screen's short id is);
- **New link…** replaces it at once, and every screen holding the old one is told and stops.

Anyone with a screen's link can see that screen, so give it only to the machine that shows it.

## Where it lives

`app/lib/displays.js` (the store, what may be shown, the states), `server.js` (`/d/:token`, `serveDisplay`, the
`display:*` events), `app/public/display.html|css|js` (the screen), `app/public/app.js` (Screens). A take is
`display:take {ids, content}` (or `{id, content}` for one screen), answered `{ok, results: [{id, ok, seq, status} or
{id, ok: false, error}]}`; a hall's operators hear `displays:changed` at once for a lone change, and at most once per
150 ms in a burst (`lib/latest.js`), then re-read the list.
People's screens: `app/lib/pages.js` (the store, what may be shown, its words and the states),
`app/lib/handlers/takes.js` (the verbs) and `server.js` (who may push, the pages open in a hall, `pages:changed`). A
take is `page:push {code, to: 'board' | {uid}, content, cid}` (`uid` a person's key as `page:status` lists them:
`a:<account id>`, `u:<uid>`), answered `{ok, seq, results: [{key, name, ok, status}]}` with "◷ Sending", never on
screen; a repeat with its client id is answered with what the first push did, in memory, so a restart between the push
and its repeat makes a second take of the same content. Each page is sent `page:take {seq, content, by, at, hallName,
holding, now, tz, answer}` by its socket's id, never as a room's broadcast, and answers `page:report {seq, state, words,
again}` (`shown`, `hidden`, `failed`, `dismissed`, `minimised`; acked). A hall's consoles hear `pages:changed {}` at
most once per 150 ms in a burst and read `page:status {code}` again. A page's join answers `page` (what it is shown now)
and `canPush`; the admin's view of someone names them (`viewOf`), is shown what they are shown and told their chat view
as it changes, and its join answers, at the end, their facts as their page holds them (`person: {role, view, canPush,
sends, forwardable}`, or null), so it can draw exactly their doors. A key that is no hall's is refused in the words a
hall the asker may not push in gets, by `page:push` and `page:status` alike; only the admin is told "No such hall."
Tests: `app/test/displays.test.js`, `app/test/pages.test.js`, `app/test/takes.test.js` and the browser smoke.
