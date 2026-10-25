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
| **Countdown** | the hall's Stagewatch countdown in its own words and colour, its title and what's next — and a message strip under it: the speaker's comfort monitor. The strip's words shrink so it never covers the time, on an upright tablet too. With the link to Stagewatch lost it shows `--:--`, never a confident stale time |
| **Clock** | the time of day from AGMessage's own clock, in AGMessage's time zone (a screen PC's clock or zone may be wrong; a browser that does not know that zone shows its own) |
| **Black** | nothing |
| **Identify** | the screen's name, large, for six seconds, over whatever it shows |

A small dot in the bottom-right corner is the screen's link to AGMessage; after six seconds without it the dot turns
to a red square (`?status=hide` hides it). The screen keeps itself awake where the browser allows it (over HTTPS).

## Driving screens

In a hall (as an account with `display.control`): **Screens**. Tick the screens, then take Holding, Countdown, Clock,
Black, or type a message and choose **Show** (tick "Under the countdown" to put it in the countdown's strip). On any
message, or any image or PDF shared in the hall, **⧉** offers it to the ticked screens (a PDF from its first page).
A take goes to every ticked screen in one request — all 50 of a hall's screens if they are ticked; a screen it could
not reach (removed meanwhile, or not yours) is named in the console's note and on its line.

Every take is numbered. The screen renders it and says so, and only then does the console say **✓ on screen**. Until
then it says **… sending**; **△** and the reason when the screen could not show it (an image that did not load, a PDF
that did not render — the screen is then black, never the picture before it); **✕ offline** when no browser has the
link open. **Holding** reads "holding image" when the hall
has one, which is what the screen shows.

Several browsers can hold one link (a projector and its backup, a manager's laptop after **Open**). Each says for itself
what it showed: the console says **✓ on all 2 screens** only when every one did, **… sending — on 1 of 2 screens** until
then, and **△ could not show it on 1 of 2 screens** as long as any one could not. A screen whose network blips comes back
as the same screen, not a second one; a browser that vanished without closing counts until AGMessage notices (within
about 18 seconds).

A screen keeps one PDF open and draws each page off screen before it swaps it in: stepping through a deck never blanks
the slide, and a rename or a reconnect leaves the picture alone. A file taken earlier that is still loading never
paints over the one taken after it.

## Managing screens

With `display.manage` (project managers, admins): **Add screen** (the new link is copied — open it on that screen),
**Copy link**, **Open**, **Rename**, **New link**, **Remove**, and the hall's **holding image** (pick one of the images
shared in the hall, then **Use it**; the pick stays while the list refreshes, until the dialog closes). The halls board
shows every hall's screens and their state, in the same words as the console.

## The link is a capability

`/d/<token>`: 256 random bits. It follows the W3C's good practice for capability URLs:

- it can only show — a screen's connection is listened to for nothing but its "shown" reports;
- the page is the same for any token (the server says nothing about a link by its URL), never cached, never indexed,
  and sends no referrer;
- AGMessage looks it up by its SHA-256; the token itself is sealed at rest so a manager can copy it again; it is never
  written to a log or the audit log (the screen's short id is);
- **New link** replaces it at once, and every screen holding the old one is told and stops.

Anyone with a screen's link can see that screen, so give it only to the machine that shows it.

## Where it lives

`app/lib/displays.js` (the store, what may be shown, the states), `server.js` (`/d/:token`, `serveDisplay`, the
`display:*` events), `app/public/display.html|css|js` (the screen), `app/public/app.js` (Screens). A take is
`display:take {ids, content}` (or `{id, content}` for one screen), answered `{ok, results: [{id, ok, seq, status} or
{id, ok: false, error}]}`; a hall's operators hear `displays:changed` at most once per 150 ms, then re-read the list.
Tests: `app/test/displays.test.js` and the browser smoke.
