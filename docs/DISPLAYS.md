# Screens — display URLs a hall's operators drive

A **screen** is any browser that should show something for a hall: the projector PC, a confidence monitor on the
lectern, a foyer TV, a green-room screen. Each screen has its own link. Open the link in that browser (full screen:
double-click) and leave it; the hall's operators change what it shows from AGMessage.

## What a screen shows

| Take | On the screen |
|---|---|
| **Holding** | the hall's holding image; with none, black with the screen's name, faint, so the crew knows which it is (`?idle=blank` hides the name) |
| **Message** | the words as large as the screen holds; how urgent is a band and a shape as well as a colour: ● note, ▲ soon, ■ urgent; an optional second line |
| **File** | an image, or one page of a PDF, shared in the hall; a page past the PDF's end shows its last page, and the console says so beside ✓. Never a file for download only (a zip, a video, a protected Office file): AGMessage never opens one |
| **Countdown** | the hall's Stagewatch countdown in its own words and colour, its title and what's next — and a message strip under it: the speaker's comfort monitor. The strip's words shrink so it never covers the time, on an upright tablet too. With the link to Stagewatch lost it shows `--:--`, never a confident stale time — and while Stagewatch has not accepted AGMessage's key, or after it refused it |
| **Clock** | the time of day from AGMessage's own clock, in AGMessage's time zone (a screen PC's clock or zone may be wrong; a browser that does not know that zone shows its own) |
| **Black** | nothing |
| **Identify** | the screen's name, large, for six seconds, over whatever it shows |

A small dot in the bottom-right corner is the screen's link to AGMessage; after six seconds without it the dot turns
to a red square (`?status=hide` hides it). The screen keeps itself awake where the browser allows it (over HTTPS).

## Driving screens

In a hall (as an account with `display.control`): the header's ⋯ → **Screens & pages…**, its **Screens** tab. Tick the screens, then take Holding, Countdown, Clock,
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
and iOS 16.4), Chrome 103 or Firefox ESR, older iPads included, a picture stored as JPEG 2000 among them (pdf.js's worker
may run the WebAssembly that decodes it, by its own response's policy). On a browser older than that a PDF take says
**△** and the screen is black: share the page as an image and take that instead. A PDF whose first page is not drawn
within 20 s says **△** "the file took too long to read" and leaves black, and the screen's pdf.js worker is ended with
it, the next PDF drawing through a new one; an image inside a PDF over 16,777,216 pixels is left out of the page, as on
the hall page's panel.

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
may read, else the hall's holding image, else the AGMessage mark and the hall's name on black), blank (black) or a
**web page** (below).

Who may show people's pages: the admin; an account with `display.control` in the hall ("Change what a hall's screens and
people's pages show"), from any room of it; and a guest seated backstage in the hall's Main room while its seats are
locked: the seat came from an invite, or is one the admin kept by locking the room (Lock seats keeps the seats taken at
that moment, and the admin sees and may move each). Never a page seated On stage, never the admin's view of someone,
and never a guest of an open hall, where anyone with the code may sit backstage. A person is named only while they sit
in a room of the hall the operator may read; anyone else is "not in this hall now". The console names the Board's
people only to one who may read the hall's Main room.

### Two layers: the show, and information over it

A page holds two takes at once. **The show** is the operator's: Stagewatch, the clock, holding, blank. **Information** is
drawn over it: a web page, a document, a picture or a quote (below). Each layer is numbered by the hall's one
counter, answered by the person on its own, and told to the page in its own word (`page:take` names its `layer`); the
join answers the show (`page`), the information over it (`over`), the page's Earlier (`earlier`) and the information
beside the operator's in its side bar (`beside`).

- **Over, never instead.** Information is drawn over the show take; the show take under it says so ("hidden" with "under
  a web page", which the console reads "◐ Under a web page", never ✓), and comes back when the person goes back to chat
  on the information. A show take never replaces the information, nor the information the show.
- **Held under blank.** Blank is the operator's "keep this tablet dark": information put over it is held (the page says
  "held under blank"), the bar, once touched, reads **1 from backstage**, and a tap on it shows it.
- **In the side bar.** Information may arrive in the person's side bar instead of over their chat (`arrive: 'side'`): an
  open card drawn there, which opens the side bar once, is counted on its rail and says "in the side bar" (or, while a
  take on the layer covers the page and its side bar, "under" it: not in view); its **Show over the chat** puts it on
  the layer by the person's choice. A show take always arrives over.
- **Beside the operator's.** A researcher's side-bar push while the operator's information is up is kept in a place of
  its own (`beside`): the operator's stays over the show, the researcher's is a card in the side bar beside it, numbered,
  told (`page:take {layer: 'beside'}`), reported on and read back (`page:status`'s `beside`) as any take. The newest
  information to them, a hand-back of both, or a Take down that names it puts it away into Earlier; the operator's own
  Take down leaves it.
- **Handing back.** Back to chat on the Board chip (`chat`) hands back both layers at once, and what is beside them;
  **Take down** (`{chat, layer: 'info'}` with the take it names, `ifSeq`) hands back that information alone, over the show
  or beside it, the show staying up.
- **Earlier.** Information superseded, handed back or put away with Back to chat joins the hall's Earlier list (20 a
  hall, the oldest going first, kept in `pages.json`), and each page is told the newest ten of its own (the Board's, on a
  page seated On stage, and its person's), drawn under the cards in its side bar. **Look** opens one on that page alone,
  with no report and no take.
- **Who may show information, and over what.** The operator (`canPush`, above), the information kinds with `stage.show`
  for an account; and an account seated backstage in a room of the hall by a right of its own (`canShow`: `stage.show`,
  and `stage.web` for a web page), to the Board or one person seated On stage, from a side room only while it is on the
  Main room's list. **What the operator put up stays up**, the target's own or on any page of theirs (a person On stage
  the operator showed a page of their own): a `canShow` push over it is refused ("The operator is showing a web page —
  ask them, or send it to their side bar.") and taken in the side bar, kept beside it; between two researchers the latest
  wins. A `canShow` Take down names the take it takes down (`ifSeq`), takes down only one such a seat put up ("The
  operator put this up — ask them."), only of a kind its own rights would put up (a web page by `stage.web`, the others by
  `stage.show`), and not while the operator's is on a page of theirs. A page that may only show is told the people
  seated On stage alone, and its console hears what changed as the operator's does.

### A web page

A web page is shown by its https address: a voting page, a live document, a site the Board should look at. It needs a
right of its own beside the one every take needs: **`stage.web`** ("Show web pages on people's pages"), which Tech,
Senior tech and Manager accounts and the admin hold, Staff and Viewers do not unless an admin gives it; without it a web
page is refused, "Web pages on the stage need their own right — ask an admin.", whatever its address. A code guest holds
it only in a locked hall whose admin has turned on **Backstage guests may show web pages on people's pages** (Roles &
invites; off by default, turned off by an unlock: `docs/ACCOUNTS.md`), and is refused otherwise with "Web pages from
backstage guests are off in this hall — ask the admin."

- **The address**: at most 2,048 characters, https alone (http would be mixed content under HTTPS and through the
  tunnel; `javascript:`, `data:`, `blob:` and `file:` are no page of the web), no user name or password, and never
  AGMessage itself: `localhost` (a trailing dot included), a loopback address, this laptop's name, its network addresses and the tunnel's host are
  refused ("That address is AGMessage itself: show a page of another site."), since a frame of AGMessage's own origin
  would own the page around it. The server checks it, and the page again before it frames it. **The server never
  fetches it**: a check of its headers would be a request from the laptop into the venue's network, and would not see
  what the tablet sees.
- **Where it goes**: the address is sent only to the pages it is shown on (and the admin's view of them), and given
  back in a later push's answer, for its Undo, only to whoever put it up and to the admin: any other pusher is given no
  content there, and no Undo. At rest it is sealed with this laptop's key beside its host (`pages.json` holds `{host,
  urlSealed}`, and who put it up); a run without its key shows none. The console, the audit row ("the Board (6 pages) →
  a web page on vote.example.com"), the halls board, the context and the AI's brief name its host alone, or nothing of
  it.
- **The frame** is the one frame a page makes (`framePage`, `public/pagelayer.mjs`): `sandbox="allow-scripts
  allow-same-origin"` (scripts, but no forms, popups, top navigation, modal dialogs or downloads: owner question 6),
  `referrerpolicy="no-referrer"` (the hall page's address carries its code and its invite), `allow=""`,
  `credentialless` where the browser has it, and a title naming its host. Only the hall page may frame an https page
  (its Content-Security-Policy's `frame-src 'self' blob: https:`); every other page, the screen page and the transcript
  frame none. Above it, in AGMessage's own words: "A web page chosen by Ana (vote.example.com). Don't type passwords
  here."; its bar keeps **Back to chat** and **Minimise**, and in the full view its ⋯ (and a right-click) adds **🗗 Open
  in a new tab**, outside the frame, for a site that refuses to be framed or asks for a sign-in; the simple view keeps
  the layer's buttons alone. Minimised, its card reads "🌍 vote.example.com".
- **What can be known**: nothing inside the frame. A site that refuses to be framed (its X-Frame-Options or
  frame-ancestors) still fires `load`. So a loaded web page reads **◇ Opened · AGMessage can't see inside web pages**,
  never ✓, and one that has not loaded in 15 s reads **△ Couldn't show it: the page did not load**. The person can
  always go back to chat.
- **Preview**: Show a web page… asks for the address, then **Preview** frames it with the same `framePage` on the
  operator's own page first (only they see it; **Show it** there sends it), or **Show it** at once.

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
kind of thing ("the clock", "a holding slide", "a web page on vote.example.com", "a PDF at p. 12", "a picture of a PDF page
(p. 12)", "the information taken down", with ", in their side bar" for an arrival there, ", sent from Legal" for a push
from a side room and ", withdrawn" for a withdrawal), never a file's name or an address. Nothing of a take is on the halls board, in the context
another show system reads, or in the AI's brief.

### A document, a picture

**A document** (`{kind: 'doc', url, at?, download, note?}`) is a file the hall holds, the whole of it, opened at its
place: a PDF's page, a deck's slide, a spreadsheet's sheet, a Word document's paragraph (with its page where the reader
knew it, "≈" where Word's own breaks were missing), a text or Markdown file's line, a CSV's row. The target's page draws
it with the same reader as the side bar's (`docview.mjs`), as its own seat draws it (the Board's and an observer's
without hidden rows, sheets, slides or Word's hidden text), with its page box, zoom and find, 48 px in the simple view.
**A picture** (`{kind: 'image', url, from?, note?}`) is an image shared in AGMessage, fitted, with zoom, and says what it
is a picture of (`from`: a file's place, by its name, never its address; or the pusher's own copy, said as theirs):
"Ana's picture of Board pack.pdf, p. 12". There is no region: a part of a page or a picture is drawn into a picture of
its own on the pusher's page, so a target is never handed the original. A note is the pusher's line above it.

- **Where the file may come from** (`sourceOk`): the pusher's own fresh upload, made for the Main room or for a side
  room on its list where the pusher posts files; a file in a message of the Main room; a file in a message of a side
  room the pusher reads that is on the Main room's list; or one the hall's stage records, when the room it was recorded
  for passes again. A holding picture is held to the same rule. A refusal names the room only to one who may read it
  ("That file belongs to Legal, which may not send into the Main room — send it there first, or ask an admin."). The
  take's name is AGMessage's: the upload's, or the one the hall's oldest message holding the file gave it.
- **Never a document to an observer** ("Observers are shown pictures and quotes, not documents."), seated so in any room of
  the hall: it hands over the whole file. A page seated as an observer is told a document without its address and draws
  nothing of it.
- **Checked at its first take**: a picture, or an image as a document, at most 40 megapixels ("Too large for the Board's
  devices — send a region."); a Word, Excel or PowerPoint file that never had the archive check has it then.
- **The page checks again**: an address that is not one of the hall's uploads, of a type the stage shows, draws nothing
  and fetches nothing. A document reports `shown` once its place has drawn, a picture once it has decoded, each in view;
  `failed` with the reader's words otherwise.
- **Kept by no device**: fetched `no-store`, drawn from memory (a picture through an object URL revoked when the take
  goes, a document's reader and its pdf.js document destroyed then; a PDF read by its pages' ranges alone); on every
  seat's layer, its cards and a Look, AGMessage's menu stands in for the browser's (Shift+right-click too), no picture is
  dragged out or saved by a long press, and printing leaves the stage out. Words stay selectable.
- **A stage file** (a fresh upload a take named that no message holds: a picture drawn of a page, a holding slide's
  picture) lives while a take or an Earlier entry names it, and for an hour after (`AGM_UPLOAD_ORPHAN_MS`); then it leaves
  the disk, unless a message, a screen or the hall's holding image holds it, at the latest at the next start (the boot
  sweep, by the names the stage recorded alone). A file whose message goes while only the stage still shows it (a
  holding slide's picture, a picture the admin's delete left up) becomes a stage file then. At most 200 in use a hall
  ("This hall's stage holds 200 files — take some down."); a hall removed takes its stage files with it.
- **What ends a take**: clearing the Main room's messages ends every information take of the hall and empties its
  Earlier (the show stays; its `room.reset` row counts them); clearing or removing a side room ends what shows its files
  or was sent from it; the author's delete of a file message ends what shows its file, where no other message of the
  hall holds it; the admin's delete of one asks first, "On the Board's pages now — take it down too?".
- **Withdraw**, for a take shown by mistake (`page:withdraw {code, seq}`): by who put it up, the operator or the admin.
  It goes from every page it is on and from Earlier (Take down leaves it there), each page lets go of what it drew of it
  (`page:take {withdrawn}`), its download tickets are voided and no other is given ("This was withdrawn."), and its row
  says "…, withdrawn". The toast after information offers **Take down** and **Withdraw** for 10 s; later, **🔙
  Withdraw…** on the Board chip or a person, asked first.
- **Where it is shown from** (plan 4-§4.6.3, §5.9.7): the backstage Preview's bar (**📺 Picture of p. 12**, a new picture
  of that page drawn on the pusher's page and uploaded as it is shown, saying it is a picture of the file or of the
  pusher's own copy; **📺 Document at p. 12**, the whole file, with **☐ Let them download it** under it alone, disabled for
  a file whose reader found hidden parts); a file's ⋯ (**📺 Show the Board ▸** a picture of p. 1, a picture of a page…, the
  document…); and a person's **Show them a document…**. The document's short bar asks its place, the tick and where it
  arrives. **A document shown with Download ticked** offers ⬇ Download on its card (and its layer's ⋯ in the full view),
  On stage too, by the take's number (`file:download {seq}`); without the tick: "This was shown without Download."
- **Never a file for download only** (a transfer type, or a Word, Excel or PowerPoint file protected with a password):
  "That file is for download only: AGMessage does not open it.", as a document, a picture or a holding picture alike.

### A quote

**A quote** (`{kind: 'snippet', unit, title?, text | items | table | blocks, from?, note?, cut?, more?}`, plan 4-§5.9.4)
is words or cells the backstage team picked in a file in their Preview (a word, a sentence, a line, a list's items, a
paragraph, a table's cell, row, column or range, a slide, a selection, or the blocks in view), carried as data and drawn
by the page, never HTML: every string is read by its type and cleaned as a block (its line breaks kept; controls, bidi
overrides and invisible characters dropped). `unit` carries its one body (a cell, a row, a column and a range a table,
`{rows, head, side, ref?, focus?}`, its label row and column marked; a slide its title and items; what is in view its
blocks). It names where it comes from by the file's name and its place (`from`: a page, a slide, a sheet and a cell's
reference, a paragraph with its Word page, "≈" where approximate, a run of lines), never the file's address; the pusher's
own copy is said as theirs; a web page by its host, its address sealed at rest; with none, it was typed. Its source is a
file the stage may show from (`sourceOk`, as a document's); a picture has no words to quote.

- **Its bounds**, refused in words, never cut by the server: 1,200 characters of text ("Too long for the stage: 1,200
  characters at most (this is 1,860)"), 20 items of 300, 25 rows × 10 columns of 200 ("Too big for the stage: narrow it
  to 25 rows × 10 columns"), 12 blocks, 4,000 characters in all, counted as code points. The cut is the researcher's own
  choice, offered by the bar: `cut` on text, or on a table at its full 25 rows or 10 columns, `more` saying what was left
  out ("… 40 more rows not shown").
- **Drawn** in a `<blockquote>`, a list or a `<table>`, each paragraph and cell `dir="auto"`, its line breaks kept, in the
  largest type that fits (between 28 px, 20 px under 600 px wide, and 12vw, in at most 12 steps); numbers to the right,
  the cell it is of outlined and bold; a table wider than the screen scrolls sideways inside its card, its label row and
  column kept in view. Its line says who quoted it, in their voice: "Quoted by Ana · Board pack.pdf, p. 12", "Quoted by
  Ana from their copy of …", "Quoted by Ana · vote.example.com", "Typed by Ana"; a side room's file adds its name. Its
  card reads its first 40 characters ("❝ Revenue Q3 £4.2m"); one that arrives in the side bar keeps the card's type. It
  reports `shown` once laid out on a frame in view, with "longer than the screen: it scrolls" where it is ("longer than
  its card in the side bar" in a card); a table in a quote longer than its box scrolls down inside its own card too, its
  label row kept in view. Under Earlier its Look draws it again on that page alone.
- **Its words** in the console: "❝ a table cell from Q3.xlsx, 'Sheet1'!C4", "❝ a quote typed by Ana (42 characters)",
  "❝ a quote from vote.example.com"; its `page.push` row: "a quote (a table cell, 18 characters) from a spreadsheet",
  "a quote (typed, 42 characters)", never a word of it, a file's name or an address.
- **The quote is its pusher's claim**: the server never parses a document, so it cannot check that the words are in the
  file; the page's `shown` is the fact.
- **From the Preview**: a highlight made first is a pick, and the Preview's bar offers its units as chips with their
  sizes, the smallest chosen (the last one used where two are as small), drawing the quote as the Board's page will;
  📺 Show sends it to the Board or the person chosen there, over their chat or in their side bar. A right-click on the
  pick, the bar's ⋯ and a second tap on it open the same list as a menu (the catalogue's kind `pick`): Copy, each unit,
  **Picture of this page** (a PDF's; of the region, for a region; **This picture alone**, for a picture tapped in a Word
  document or a slide), **What I see** (a PDF's or a picture's part in view as a new picture; a document's blocks or
  cells in view as a quote, and over the stage's bounds the bound said and **Send what fits** offered, never cut by
  itself), **The document at this place**, and a person. **▭ Region** draws a part of a PDF's page (a picture's always)
  to send as a new picture, its metadata never with it. A cell's labels are the sheet's frozen panes by default (its
  header, never a title row above it), else its first row and column, or those marked; a hidden row, column or sheet is
  never picked. The bar says whose information the target is reading where another pusher's is under 15 s old ("The
  Board is reading Ben's quote (8 s) — Replace · Show a person instead"), for every choice on the Preview's bar, and
  refuses nothing for it; over the operator's information, a seat
  that may only show sends to their side bar, and the bar says so. A picture uploaded and turned away by the uploads' rate
  says "Sending in 2 s…" and goes again, three times at most.

### Showing it: the Board chip and the console

A page that may show people's pages has the **Board chip** in its header: what the Board's pages show and how many show
it ("Board · 🕐 Clock ✓ 6/6"; "Board · ✕ nobody on stage" with no Board page open), and the information over it after it
("Board · 🕐 Clock ◐ 0/6 · 🌍 Web page ◇ 6/6"), or with nothing over the show what is in their side bar ("· 🌍 Web page in
the side bar ◇ 6/6"). Its menu holds **⤵ Take down** while information is up (over the show, else beside it): for a
page that may only show (`canShow`) it shows only that and **Show a web page…** (with `stage.web`), Take down taking
down what that page's kind of seat put up, disabled over the operator's information with "The operator put this up —
ask them." (and, for an account whose information pushes lack `stage.show`, with that right's words, read from
`page:status`'s `show`). A person's menu holds the same **⤵ Take down** for their information. A click on it, a right-click or
Shift+F10 opens its menu: **Back to chat · Show Stagewatch · Show the clock · Show holding · Show blank**, and **Show a
web page…** for a page that may show one, the one the Board shows checked (choosing it again says "Already showing the clock."; Stagewatch is greyed where the hall has none
linked), then **↶ Back to …** and **Screens & pages…**. A choice goes at once, and the toast names whom it reached
("The clock on 6 Board pages.") with **Undo** for 10 s, which puts back what was shown before as a take of its own (none
is offered where that was a picture shared in a room this page may not read). Information offers **Take down** for 10 s
instead, over that take alone, never Undo: older information is never put back up, which could reopen on every tablet
what the Board had closed. After
that, the chip's **↶ Back to Stagewatch (undo your Clock, 14:02)** does the same while this page's take is still the
Board's: it is sent over that take, so it never undoes someone else's later take, and a take made by an Undo or a Back to
offers no undo of its own.

The header's ⋯ → **Screens & pages…** is the hall's console: its **Screens** tab (above) for a page that drives the
hall's screens, and its **People's pages** tab for one that may show people's pages, each tab where the page may use
it. People's pages lists **On stage (Board) — all 6** first, with a button for each kind, then each person in the
hall's rooms the operator may read, with their room, each with its status (mark and words) and what it shows now; a
person's ⋯ (and a right-click, and Shift+F10) holds **📺 Show them ▸** (Stagewatch, Clock, Holding, Blank), **Show them
a web page…** for a page that may show one, and **Back to chat on their pages**. The same two acts are on a person in the room's People list and on a message's sender's name.
It reads where the pages stand as it opens and each time it is told they changed.

### On the person's page

A take is drawn over the hall page, the header and the side bar included (under the menus, the asks and the toast), on
black: Stagewatch's countdown (its time, title, next and the speaker's line; `--:--` while the link is lost, its key not
accepted, or the page not connected), the clock (AGMessage's time and zone), the holding picture (a picture that does
not load leaves black, and says so), the AGMessage mark and the hall's name, or black, whose bar shows once the screen
is touched or a key pressed. Its bar names what it is and who put it up, and holds **💬 Back to chat**, **🔽 Minimise**
and, where the device can, **⛶ Full screen**, 48 px, in words as well as icons (in the full view its ⋯, a right-click
and Shift+F10 hold the same). **Escape minimises; it never goes back to chat.** The page says what it drew only while it
is in view (shown, or hidden while asleep or behind another app, and again when that changes), so the console's ✓ means
someone could see it.

- **Back to chat** takes it off every page of the person's in the hall; the toast offers **Show it again** for 10 s,
  which brings it back on all of them (after 10 s the server refuses it, and a newer take shows again).
- **Minimise** puts it at the top of the side bar (📺 On stage) as a card, "⏱ Stagewatch" with its live time, "🕐 Clock"
  with the time, "🖼 Holding" or "🌑 Blank", who put it up and when, and **⤴ Show again** and **Remove** (which is Back to
  chat, with Undo for 10 s). The side bar opens itself for it, and while it is collapsed its rail reads "📺 On stage •
  1". An observer or a Viewer account, who has no side bar, is given one while a take of theirs is minimised, so a
  Minimise always has somewhere to go. While a card is there a new document does not open itself over it.
- **Nothing reaches the stage by surprise, and nothing is lost.** A take never takes the focus from a field being written
  in: it waits until the field is left, at most 3 s, and the field keeps its words under it. While a take covers the
  page, a 🔥 message from someone else breaks through in a strip at its foot, with its sender, its words and **Open
  chat** (which minimises the take and brings the message into view), and other new messages are counted on its bar
  ("2 new").
- The admin's view of someone draws what they are shown, every door disabled with whose view it is, and says nothing to
  the server.

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
`display:*` events), `app/public/display.html|css|js` (the screen), `app/public/app.js` (Screens & pages). A take is
`display:take {ids, content}` (or `{id, content}` for one screen), answered `{ok, results: [{id, ok, seq, status} or
{id, ok: false, error}]}`; a hall's operators hear `displays:changed {}` at once for a lone change, and at most once
per 150 ms in a burst (`lib/latest.js`), then re-read the list.
People's screens: `app/lib/pages.js` (the store, what may be shown, its words and the states),
`app/lib/handlers/takes.js` (the verbs) and `server.js` (who may push, the pages open in a hall, `pages:changed`). A
take is `page:push {code, to: 'board' | {uid}, content, cid}` (`uid` a person's key as `page:status` lists them:
`a:<account id>`, `u:<uid>`), answered `{ok, seq, results: [{key, name, ok, status}]}` with "◷ Sending", never on
screen; a repeat with its client id is answered with what the first push did, in memory, so a restart between the push
and its repeat makes a second take of the same content. Each page is sent `page:take {seq, content, by, at, hallName,
holding, now, tz, answer}` by its socket's id, never as a room's broadcast, and answers `page:report {seq, state, words,
again}` (`shown`, `hidden`, `failed`, `dismissed`, `minimised`; acked); a `shown` with `again` or a `minimised` within
10 s of a `dismissed` takes Back to chat back, and a person's act refused (after 10 s) tells that page again what it is
shown. Two layers and a place beside them ("Two layers: the show, and information over it", above): `page:take` names
its place (`layer`: `show`, `info` or `beside`) and an information take how it arrives (`arrive`); `page:push` takes
`arrive: 'over' | 'side'` for information, and a Take down is `{kind: 'chat', layer: 'info'}` with the take it names;
each `page:status` row adds `info` and, while one is there, `beside`, and the answer `show` (whether the asker's
information holds `stage.show`). A push may name the take it goes over (`ifSeq`: Undo, ↶ Back to and Take down), refused
"Something newer is showing there now: nothing changed." once a newer take is up, and its answer gives back what was
shown before (`previous: {seq, content}`, or null), its content only as the pusher could show it itself: a picture
shared in a room it may not read comes back as `content: null`, and that page offers no Undo. A guest's console names
its hall by the code it joined with, and a repeat of its push by that code is answered with what the first did. A hall's
consoles hear `pages:changed {}` at most once per 150 ms in a burst and read `page:status {code}` again (each row also
giving what it shows, `kind`, and how many of its pages show it, `on`); a hall's screens consoles hear `displays:changed
{}`, in every room of the hall, naming nothing, and read their hall's list again. The hall page draws a take with
`app/public/pagelayer.mjs` (loaded at its first take; it draws and answers what it drew, holding no socket) and its
console and the Board chip in `app/public/app.js` (`Takes`, `Console`). A page's join answers `page` (what it is shown
now), `canPush`, `canWeb`, `canShow`, `over`, `earlier` and `beside`; the admin's view of someone names them (`viewOf`),
is shown what they are shown and told their chat view as it changes, and its join answers, at the end, their facts as
their page holds them (`person: {role, view, canPush, sends, forwardable}`, or null), so it can draw exactly their
doors. A key that is no hall's is refused in the words a hall the asker may not push in gets, by `page:push` and
`page:status` alike; only the admin is told "No such hall."
Tests: `app/test/displays.test.js`, `app/test/pages.test.js`, `app/test/takes.test.js` and the browser smoke.
