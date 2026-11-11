# The Board's devices

The owner's answer 22: "Board will use a mixture of devices". Read as: iPads on current and older iPadOS, Android
tablets, and phones (iOS and Android); every Board feature works on each, with a test matrix and fallbacks, and nothing
is tuned to one device. And on 2026-10-31, of the page floor below: "Keep these as mim" — the floor stays, and a Board
device below it is not supported.

This paper is the one matrix, the one floor of the pages and the one walk. It holds the hall page's, its menus', its
dialogs' and its stylesheet's part (the plan's Part 5 §15.10); the Board's chat view's rows (the sheet's Full screen and
wake-lock rows, the layout by size) are §6 (the plan's Part 7 §17.7); the stage's (the document floor, a document's
stand-in below it, the no-save measures, every stage feature on every row) are §8 (the plan's Part 4 §5.15). None makes
a second matrix or a second walk.

Every browser version here is MDN's compatibility data (https://github.com/mdn/browser-compat-data), named by its path
there. No page reads the user agent: each fallback is chosen by a probe or by what failed, so a device nobody listed
draws by what it is.

## 1. The matrix

| Row | Device | Browser | Why it is a row | Walked |
|---|---|---|---|---|
| D1 | an iPad on an iPadOS before 16.4, the oldest the owner's devices run | Safari | below the document floor (Safari 16.4, §8): a document's stand-in, and everything else as on any row; at or above the page floor (iPadOS 14.5) unless the owner's oldest iPad is older, which this row then says | not walked |
| D2 | an iPad on iPadOS 16.4 to 16.7 | Safari | the oldest that opens documents; no `<link rel="modulepreload">` (Safari 17) and no `Promise.withResolvers` (Safari 17.4), so the timed `import()` and pdf.js's legacy build are what it runs | not walked |
| D3 | an iPad on the current iPadOS | Safari | the newest WebKit | not walked |
| D4 | an Android tablet | Chrome, current | a long press fires `contextmenu` | not walked |
| D5 | an Android tablet | Samsung Internet, current | a second Blink browser (`browsers/samsunginternet_android.json`), with menus and downloads of its own | not walked |
| D6 | an iPhone on the current iOS | Safari | a phone's width; the chat view's Shown to you tab | not walked |
| D7 | an Android phone | Chrome, current | a phone's width and a long press | not walked |
| CI | the smoke's Chrome (Linux) and Edge (Windows), with the device legs and the floor leg | — | every push (§4, §6, §8) | every push |

- A walked row records the device's model, its OS and browser versions and the date: "current" is whatever the device ran
  that day, written down. Which iPadOS the owner's oldest Board iPad runs (D1) is recorded here; it no longer decides the
  floor.
- A row the owner has no device for reads "not walked", which is a fact in this paper, never a pass.
- A ✕ is a defect, fixed before 0.6.0 is tagged, or a fallback that the row and the device's own words then name. The
  page floor's words are not such a fallback: a Board device of the owner's below the floor is a ✕ that holds the tag
  until the owner retires it from the Board or replaces it, and the floor is not lowered for it.

## 2. The page floor: Safari 14.1 (iOS and iPadOS 14.5) and Chrome 84

- **Why there.** The layout uses flex `gap` (`css.properties.gap`, its flex context: Safari 14.1, Chrome 84), and the
  pages' scripts parse as ES2020, whose newest syntax Safari parses from 14 (`javascript.builtins.BigInt`).
- **The probe.** `app/public/theme-init.js` is the first script of every page with people (the sign-in page, the halls
  board, the Accounts page, the admin page, the hall page; a test holds each to it). It tests `typeof window.WeakRef ===
  'function'`: `WeakRef` arrived in the same versions as flex `gap` (`javascript.builtins.WeakRef`: Safari 14.1, Chrome
  84, Firefox 79).
- **Below the floor the page says so in words instead of half working.** `theme-init.js` sets `data-floor="old"` before
  the page paints; the stylesheet hides everything else, and the page shows one line: "This browser is too old for
  AGMessage. Update this device (iPadOS or iOS 14.5, or Chrome 84, or later), or use another." Every page script stops
  before it opens a socket or asks the server anything (a test holds each, and names the four that only define at load),
  so a guest's page never joins a hall and the hall never hears of it. The hall page's own script ends by throwing (a
  classic script's top level has no return); its one console error says so.
- **No form is sent below the floor.** `theme-init.js` holds every submit at the window before the browser or a page's
  handler acts on it, so a form whose script stopped (the sign-in form, whose method is the page's own address) never
  puts a password in a URL, whether or not the stylesheet that hides it arrived.
- **The words reach the browser that needs them.** `theme-init.js` keeps to ES5, under a lint block of its own in which
  a newer syntax is a parse error.
- **Screens are untouched.** A screen's page (`/d/…`) loads no `theme-init.js`, and an audience-facing screen never
  shows the words.

## 3. Each feature above the floor, and its fallback

Each fallback is the same on every device. "Today" is the tree as 0.6.0 is built.

| Feature | From (MDN) | Where | The fallback | Today |
|---|---|---|---|---|
| `<dialog>` and `showModal()` | `api.HTMLDialogElement`: Safari 15.4, Chrome 37 | every dialog | `AGM.openDialog(dlg)` (`app/public/common.js`): `showModal()` where it exists. Elsewhere the dialog gets its `open` attribute and is fixed in the viewport, centred as a browser centres a modal dialog (its four sides at 0, auto margins, `height: fit-content`; no transform, so a menu fixed inside it is placed by the viewport as in the top layer), above a backdrop element in `::backdrop`'s colour; the focus goes to its first control, stays inside it and goes back to the opener when it closes, also when it is opened again before the close event of the browser's own `close()` or `method="dialog"` form has come (a task later): that event ends nothing of the new opening, and an opening the browser closed itself ends as the next one begins; Escape closes it; the rest of the page is `aria-hidden` while it is open. A browser with no `<dialog>` at all is given the dialog's `close()`, `open` and `returnValue`, its `method="dialog"` forms' closing (which would otherwise send the form to the page's address) and the submit event's `submitter` (which came with it) | every dialog opens through it: the halls board's four, the Accounts page's two and its Export…, the admin page's Accept and Split, and the hall page's three (Help, Screens & pages, the Stagewatch dialog); their Cancel is a plain button, so Enter in a field saves |
| Screen Wake Lock | `api.WakeLock`: Safari 16.4 (iOS and iPadOS 16.4 in a Safari tab, from the Home Screen from 18.4), Chrome 84, Samsung Internet 14.0; only in a secure context (HTTPS) | the Board's simple view; screens keep their own (`display.js`) | `AGM.awake(say)`: the lock where it exists, asked again each time the page is shown. Where it cannot be had, `say` hears the cause and its words: not a secure context, "This device may sleep: open AGMessage over HTTPS."; no Wake Lock in this browser, "This device may sleep: set its screen to stay on in its own settings (Auto-Lock or Screen timeout)."; refused with `NotAllowedError` (the platform could not take it, for example on low battery), or taken back while the page is shown, "This device would not stay awake (its battery may be low): plug it in." | the helper; the simple view asks it as it starts, and its ⋯ sheet draws the words as a row of their own (§6) |
| A form's `requestSubmit()` | `api.HTMLFormElement.requestSubmit`: Safari 16, Chrome 76 | Return in the hall page's composer | behind its probe; where it is missing, the form's own submit button is clicked, which submits it the same way. A bare call fails the lint | in `app.js` |
| `requestIdleCallback` | `api.Window.requestIdleCallback`: no Safari | a first open's older messages (unit 32) | `AGM.idle(fn)`: `requestIdleCallback` where it exists, else a timer at once; either way each chunk's deadline gives at most 8 ms by `performance.now()`. A bare call fails the lint | the helper; a hall page's first open draws its newest 60 messages at once and the rest of what it holds through it, a chunk at a time (`app/public/app.js`, `Earlier`), as it draws the earlier ones Show earlier and Show it bring |
| Popover | `api.HTMLElement.showPopover`: Safari 17, Chrome 114 | the Help chip's ask; every page's menus and their asks | where the popover API is missing an ask or a menu is fixed at the menus' layer (`--z-menu`), and one opened from inside an open modal dialog (Screens) is mounted in that dialog, which makes everything outside it inert; a menu is never popover-only | the menus and asks of every page (`menus.js`), the Help chip's ask among them |
| A long press | `api.Element.contextmenu_event`: iOS fires none on a long press; Chrome on Android and Samsung Internet do | menus | ⋯ is the touch door on every device (a chip and a sender's name are their own); where a long press fires `contextmenu` the same menu opens in the full view; the simple view opens none; AGMessage runs no timer of its own; at 480 px or less with a coarse pointer a menu is a sheet at the screen's foot, and a submenu drills in with "‹ Back" | the menus of every page (`menus.js`) |
| `dvh` | `css.types.length.dvh`: Safari 15.4, Chrome 108 | the hall page's height, the dialogs' and Screens & pages' height | the same property in `vh` first | in `styles.css` |
| `:focus-visible` | `css.selectors.focus-visible`: Safari 15.4, Chrome 86 | the buttons' focus ring | in a rule of its own: a browser that does not know it drops the whole rule, so the fields' `:focus` ring stands apart and holds | in `styles.css` |
| `:has()` | `css.selectors.has`: Safari 15.4, Chrome 105 | the chosen seat on the sign-in page | a highlight only: the seat's radio stays visible | in `styles.css` |
| `color-mix()` | `css.types.color.color-mix`: Safari 16.2, Chrome 111 | the halls board's help strip | a plain colour first: the card's colour behind the strip (its red border and heading stay), the border token between its rows | in `styles.css` |
| `inset` and the logical properties | `css.properties.inset`, `margin-inline` and the rest: Safari 14.1, Chrome 87, so Chrome 84 to 86 drop them | the Shown to you panel's rail, the support view's backdrop, the Help chip's ask | `top`, `right`, `bottom` and `left` (or the physical sides) first | in `styles.css` |
| The Fullscreen API | `api.Element.requestFullscreen`: Safari 16.4 (prefixed before it, and on iOS "only available on iPad, not on iPhone"), Chrome 71 | a take's ⛶ Full screen on the hall page, and the simple view's sheet's Full screen | not drawn where the page's probe at load finds none (`fullscreenEnabled` or its `webkit` form, and `requestFullscreen` or its `webkit` form): the take covers the page all the same, and an iPhone's sheet has no Full screen row | `app/public/app.js` (`FULLSCREEN`, the `fullscreen` fact) |
| `light-dark()`, `@container`, `text-wrap` | Safari 17.5, 16, 17.4; Chrome 123, 105, 114 | not used | a plain declaration of the same property first, or inside `@supports` | held by the fence |
| pdf.js | its legacy build's targets: Safari 16.4, Chrome 103 (the document floor) | the panel, screens and the stage | a document's stand-in on the stage below the document floor (§8); the panel's Look says the device cannot open documents | the legacy build; the stand-in in `app/public/pagelayer.mjs` |
| `DecompressionStream('deflate-raw')` | `api.DecompressionStream`, its `deflate-raw` format: Safari 16.4, Chrome 103, Firefox 113 (the document floor, the same probe as pdf.js's) | the hall page's documents' probe at its join (`docs`); the document worker (`docworker.js`), which inflates a Word, Excel or PowerPoint file's parts with it | a page without it joins without `docs` and is sent a document's stand-in (§8); its panel says "This device cannot open documents — ask the backstage team to show you a picture." for a PDF or a zipped Office file, and draws a picture, a CSV, Markdown, text and an Excel 97-2003 workbook (not zipped) | `app/public/app.js` (`DOCS`), `app/public/pagelayer.mjs`, `app/public/docworker.js` (`inflater`, the answer `device`) |
| The CSS Custom Highlight API | `api.Highlight`, `CSS.highlights`: Safari 17.2, Chrome 105 | a pick in the researcher's Preview | where it is missing, the pick's blocks are outlined (`.dv-pick`), its cells and a picture always are | `app/public/docview.mjs` |
| `Intl.Segmenter` | `javascript.builtins.Intl.Segmenter`: Safari 14.1, Chrome 87 | a word and a sentence picked | where it is missing (Chrome 84 to 86), a word is a run of letters and digits and a sentence ends at . ! or ? | `app/public/docmodel.mjs` `segmentOf` |
| A caret from a point | `api.Document.caretPositionFromPoint`: Chrome 128; `caretRangeFromPoint`: every row | a tap on a word picks it | the one the browser has, the standard one first; with neither, a tap picks nothing and a selection still does | `app/public/docview.mjs` |
| `createImageBitmap` with a part | `api.createImageBitmap`: Safari 15, Chrome 52 | a region of a picture, a picture in a document drawn again | where it is missing, the part of the element is drawn on a canvas itself; both leave the metadata behind | `app/public/docview.mjs` |
| Marks and emoji | each device's own fonts | every mark | every mark carries its word, so a glyph a device lacks never takes the meaning away; the walk checks each draws | `AGM.MARKS` (`app/public/common.js`): the thirteen marks ✓ ◐ ◇ ▭ ○ ⊘ ◷ △ ✕ ■ ▶ ● ▲, each with its word beside it (or for a screen reader) and its colour role, drawn by name on every page (the lint refuses a mark a page writes itself) |

## 4. What every push proves (Chromium)

- **The lint** (`eslint.config.mjs`): a bare `requestIdleCallback` or `cancelIdleCallback` in a page script, a
  `requestSubmit()` call not behind its probe, and any read of the user agent however it is reached
  (`window.navigator.userAgent`, `userAgentData`, a computed key, a destructuring) fail; `theme-init.js` parses as ES5. `test/lint-rules.test.js` holds the config to each.
- **`test/resilience.test.js`:** `.showModal(` appears only in `common.js` (`AGM.openDialog`, behind its probe), which
  the hall page and the admin page load before their own scripts. `styles.css` is read for each feature above the floor:
  a `dvh`, `svh` or `lvh` value follows the same property in `vh`; `:focus-visible` and `:has(` never share a selector
  list with a selector the floor reads; `color-mix(`, `light-dark(` and `text-wrap` follow a plain declaration of the
  same property or sit inside `@supports`, as a rule inside `@container` must; an `inset` follows `top`, `right`,
  `bottom` and `left`, and a logical property its physical sides; and no rule is nested. A planted sheet holds the read
  to each. A new feature above the floor joins that list with its fallback.
- **`test/pagefloor.test.js`:** `theme-init.js`, run as a page runs it, marks the page, says the words and holds every
  submit below the floor (storage blocked or not) and does nothing else above it; `AGM.awake`'s cause and words for each case, the lock asked
  again when the page is shown and let go by `stop()`; `AGM.idle`'s timer and its 8 ms slice; every page with people
  loads `theme-init.js` first and a screen's page none; every script of theirs stops below the floor before it first asks
  the server anything or opens a socket, but the four named that only define at load.
- **The smoke's floor leg:** without `showModal()`, the popover API, the Wake Lock, `requestIdleCallback` and
  `requestSubmit()`, the halls board's New hall opens through `AGM.openDialog`'s own, fixed in view above its backdrop
  with the focus in it and the page hidden from a screen reader; Escape closes it and gives the focus back; Enter in its
  name makes the hall and closes it; Escape and New hall again in one task (the late close event ending nothing: one
  backdrop, the focus in the name), then Enter, the focus back on New hall; `AGM.idle` runs on its timer; `AGM.awake` says the settings words; no script error.
  The hall page in that hall sends by Return, taken once, with no script error; its Help opens through
  `AGM.openDialog`'s own with its heading focused, its Close (the form's own) and Help again in one task leave one
  opening and one backdrop, a category sends it and closes it with the focus back on Help, and
  the chip's ask opens in place (no popover API) with Keep it open focused. On the account's page of that hall, with no
  popover API, a message's right-click, ⋯ and Shift+F10 open the catalogue's set, fixed at the menus' layer and never a
  popover, Escape giving the focus back; in Screens & pages, opened through `AGM.openDialog`'s own, a screen's menu opens
  inside the dialog and its Escape closes the menu and keeps the dialog open. A long day's hall opens at the floor with
  its newest 200 messages, the rest after the newest 60 drawn through `AGM.idle`'s timer, in the room's order, Show
  earlier above them, and no script error. With no `<dialog>` at all beside that,
  the Accounts page's Add a person opens, its Cancel closes it on the page and saves nothing, Escape closes it, Enter in
  a field submits through Save with Save as its submitter, and Export… opens and closes.
- **The smoke's leg below the floor:** without `WeakRef`, the sign-in page, the halls board, the Accounts page, the admin
  page and the hall page each show the floor's words and nothing else and ask nothing (no fetch, request, WebSocket or
  beacon); health's `clients` does not move, the hall never hears of the guest, and the sign-in form, sent, goes
  nowhere.
- **The device legs, the layout leg and the floor leg's chat-view steps** are §6's; **the stage's device legs and floor
  leg** are §8's.
- **The ES2020 fence** (`eslint.config.mjs`, `ecmaVersion: 2020` for `app/public/**`): a class field, a private field, a
  static block, a logical assignment (`||=`, `&&=`, `??=`), a numeric separator or a top-level await in a page script or
  page module is a parse error, so every row parses what it is sent (ES2020's newest syntax, BigInt, Safari parses from 14:
  `javascript.builtins.BigInt`; optional chaining and `??` from 13.1). `test/lint-rules.test.js` plants each and lints
  every page script of the tree. Built-ins are not syntax: the floor legs and the walk hold those. The vendored files are
  outside the lint, which is why pdf.js sets the document floor.
- **Not in CI:** Safari, Samsung Internet and WebView. Playwright's WebKit is refused: it would be a new dev dependency,
  and it is not the older iPadOS Safari this answer is about. The legs take features away in Chromium; the walk runs
  the real browsers.

## 5. The walk (before 0.6.0 is tagged)

A person's walk on the owner's own Board devices, in the real browsers, with this paper in hand: nothing here is
measured by CI, and nothing in it is filled until someone has done it on the device. **The walk holds the tag:** `v0.6.0`
is tagged only once every row the owner has a device for is walked, each feature ✓ or its fallback named, and no ✕ is
left standing (the 0.6.0 plan's §0.2, the owner's answer 22). A row the owner has no device for stays "not walked",
which is a fact in this paper and never a pass. A Board device of the owner's below the page floor (an iPad on an
iPadOS before 14.5, a Chrome before 84) is a ✕ that holds the tag until the owner retires it from the Board or replaces
it; the floor is not lowered for it ("Keep these as mim", 2026-10-31). When 0.6.0 closed (2026-11-08) no row had been
walked.

**How to walk a row.** On a 0.6.0 build serving on the venue's network (over HTTPS for the wake lock, the certificate
trusted once on the device, `/tls`), open a hall as a Board member (an On stage invite or a Board account) and, beside
it, a backstage page on a laptop that pushes, sends and answers. Walk each table below (§5, §6, §8) upright and sideways
where it says so. Write in each cell ✓, the fallback the device showed in its own words (as "fallback: the sheet says
'This device may sleep: open AGMessage over HTTPS.'"), or ✕ with what went wrong; a ✕ is a defect fixed before the tag,
or a fallback the row then names. Then fill the row's record:

| Row | Model | OS and version | Browser and version | Date | Walked by | `innerWidth` × `innerHeight`, `devicePixelRatio` (upright; sideways) | Reading distance and Text size (reading 9) | Result |
|---|---|---|---|---|---|---|---|---|
| D1 | not walked | | | | | | | not walked |
| D2 | not walked | | | | | | | not walked |
| D3 | not walked | | | | | | | not walked |
| D4 | not walked | | | | | | | not walked |
| D5 | not walked | | | | | | | not walked |
| D6 | not walked | | | | | | | not walked |
| D7 | not walked | | | | | | | not walked |

The Result is ✓ (every feature ✓ or its fallback named), ✕ (one standing: the tag waits), or "not walked" (no such
device). The matrix's Walked column (§1) takes the Result and the date.

**The hall page, its menus and its dialogs** (the plan's Part 5 §15.10), on every row:

| Feature | What to look for | D1 | D2 | D3 | D4 | D5 | D6 | D7 |
|---|---|---|---|---|---|---|---|---|
| The device: model, OS and browser versions, the date | written in the row's record above | not walked | not walked | not walked | not walked | not walked | not walked | not walked |
| The screen kept on for 10 minutes untouched, or the words naming why not | the screen still lit after 10 minutes with nothing touched; or the ⋯ sheet's row says why, in one of §3's three sentences, and the cause is true of the device | not walked | not walked | not walked | not walked | not walked | not walked | not walked |
| Help opened, sent and closed | Help opens with its heading read first; a category's tap sends it and closes the dialog; the chip then reads "■ Help asked", and Escape on its ask keeps the request | not walked | not walked | not walked | not walked | not walked | not walked | not walked |
| ⋯ and a long press on a message in the full view; on a take in the simple view nothing opens and nothing saves | in the full view ⋯ opens the message's menu, and a long press opens the same menu where the browser fires one (D4, D5, D7) or nothing of AGMessage's (D1-D3, D6); in the simple view a long press on a take opens nothing and offers no save | not walked | not walked | not walked | not walked | not walked | not walked | not walked |
| A dialog's buttons reached with the on-screen keyboard up | in Help with the keyboard up, every button and the dialog's Close can be scrolled to and tapped | not walked | not walked | not walked | not walked | not walked | not walked | not walked |
| Every mark of `AGM.MARKS` drawn (✓ ◐ ◇ ▭ ○ ⊘ ◷ △ ✕ ■ ▶ ● ▲); the hall page's header on one row with its ⋯ | each mark a glyph, never a box or a blank, its word beside it; the header's room name, status, Help and ⋯ on one row | not walked | not walked | not walked | not walked | not walked | not walked | not walked |
| Back by itself after the device slept | the device locked for 2 minutes and woken: the page is back with the messages sent meanwhile, nothing tapped | not walked | not walked | not walked | not walked | not walked | not walked | not walked |
| A send written offline lands once | Wi-Fi off, a message written and sent (◷ on it), Wi-Fi on: it lands once in the hall, never twice and never lost | not walked | not walked | not walked | not walked | not walked | not walked | not walked |
| The same through the internet link on mobile data | Wi-Fi off, the hall opened through the link's address: the newest message drawn within 5 s (reading 7's walk, its time written down), and the rows above on mobile data | — | — | — | — | — | not walked | not walked |
| The Board's chat view: its rows are §6's walk | — | §6 | §6 | §6 | §6 | §6 | §6 | §6 |

## 6. The Board's chat view on every row

The chat view (the simple view a page seated On stage draws unless the admin chooses Full for that person) lays out by
the viewport's size and each feature by a probe, never by the device's name: the plan's Part 7 §17.7, in
`app/public/styles.css` (`body[data-view="simple"]`) and `app/public/app.js` (`Simple`).

**The rules, by size:**

| Rule | Where it applies | Why |
|---|---|---|
| The Shown to you column, 360 px | 900 px wide or more, while something is shown (a take minimised, Earlier); its 36 px rail, which names it, while nothing is; closed with ⇥, a 44 px rail, "📺 Shown to you • n ⇤", a button that opens it again | it needs a chat of 540 px or more beside it; empty, the chat takes the rest of the width |
| The Shown to you column, wide | 900 px wide or more, while it holds something to read (a file opened with Look, a card that draws what arrived in the side bar): 55 % of the row, its grip dragged or moved with ← → (5 % a step), kept on the device (`agm.bvCol`); the chat and the column each keep 360 px | a PDF's page is read at a width the Board can read; the owner's walk of run 129 found it too small at 360 px |
| The two tabs, Chat and 📺 Shown to you · n (`aria-pressed` buttons) | under 900 px wide, while something is shown: every phone, and every tablet upright; 👁 Look chooses the Shown to you tab, which opens a column closed on a wider screen | an upright tablet keeps its whole width for the chat |
| 22 px text | the viewport's smaller side 600 px or more: a tablet, either way up; 20 px otherwise | a phone held sideways keeps 20 px |
| The phone's composer (🔥 alone, a 16 px field) | 600 px wide or less, by the width alone: a phone held sideways is wider, and draws 🔥 Priority and an 18 px field | the placeholder fits beside 🔥 and Send; 16 px or more stops iOS zooming on focus |
| The phone's header | one row; down 5 s or more, "Offline · reconnecting" is its second row (a tablet says it before Help on its one row) | the hall's name keeps its room on the first row |
| The 🔥 strip | three lines; two under 700 px tall; one under 500 px | an iPhone in Safari keeps 659 of its 852 px |
| The ⋯ sheet | never taller than the viewport (`100vh`, then `100dvh` where the browser has it), scrolled within it; a bottom sheet at 600 px wide or less | a phone held sideways reaches Leave, and iOS Safari's bars never hide its last row |
| The placeholder | "Message everyone here…" where it fits the field, measured in the field's own font on load and on `resize`; "Message everyone…" where not; the label keeps the long words | the field's room varies with the device's font and width |
| An iPad's Split View, Slide Over or Stage Manager window | by the window's size, as any viewport | — |

**Each feature, on every row** (the fallback is the same on every device):

| Feature | From (MDN) | The fallback |
|---|---|---|
| Kept awake | `api.WakeLock` (§3) | `AGM.awake()`, asked as the simple view starts and again when the page is shown; where it cannot be held, the sheet's row says why, by cause (§3's words) |
| Full screen (the sheet's row, the take layer's ⛶) | `api.Element.requestFullscreen` (§3) | drawn only where the probe at load finds the API; the unprefixed call where it exists, else the `webkit` one |
| A long press | `api.Element.contextmenu_event` (§3) | the simple view needs none: its second door is a tap, and it opens no menu; on On stage content (a take, a card in Shown to you, a file opened there) its door opens nothing, the browser's own menu included, `-webkit-touch-callout: none` on iOS, and nothing is dragged out |
| The on-screen keyboard | `html.elements.meta.name.viewport.interactive-widget`: Chrome on Android 108 and Samsung Internet 21 only; `api.VisualViewport`: Safari 13, Chrome 62 | the viewport meta's `interactive-widget=resizes-content`; elsewhere the page follows `visualViewport.height` on its `resize`, so the replying line and Send stay above the keyboard, while the view is at its own scale (a pinch-zoom resizes the visual viewport too, and the page is not made smaller for it) |
| The 🔥 strip's "out of view" | `api.IntersectionObserver`: Safari 12.1, Chrome 51 | without it the strip always shows (the safe failure) |
| A notch or a home indicator | `css.types.env`: Safari 11.1, Chrome 69 | the header's and composer's paddings `max(16px, env(safe-area-inset-*))` |
| Box offsets | `inset` and the logical properties: Chrome 87 | the simple view's rules write `top`, `right`, `bottom`, `left`, `margin-left` and `margin-right` alone |
| Dark before the first frame | `localStorage`, read in `try` | `theme-init.js` reads `agm.lastView` on the hall page alone (`<html data-page="app">`): a device last used in the simple view paints dark; storage that cannot be read is no theme chosen, and the page turns dark at its join |

**What every push proves** (the browser smoke, Chromium):

- **The device legs**: a Board guest's page at 1180×820 and 390×844 in both themes and 820×1180 in dark, each a device of
  its own (a mobile viewport, touch), and a Board account's at 1180×820: dark until chosen; the header's two controls
  (Help, ⋯); 👍 Got all n and ↩ Reply after the newest waiting plain message's words, none on an older one, Got it and
  Reply on a waiting 🔥 one, a question's answers and Answer in words…; the composer's three (🔥 Priority, the field,
  Send); nothing of the backstage team's drawn; 22 px on a tablet and 20 px on a phone; each response after its words;
  a 44 px band through each control's centre hitting it; the placeholder whole; no sideways scroll; text at 4.5:1 or more.
  Nothing shown yet, Shown to you is its rail at 1180 px wide and not drawn at 390; down 5 s, "Offline · reconnecting" is
  the phone's second header row and sits before Help on the tablet's one row. At 820×1180 a file shown brings the tabs,
  and no column. Then, on the tablet: a tap's second door, Reply and Escape, Got all n (one 👍 each, and the backstage
  page's "👍 … got it"), Answer in words… as a field of 200 characters (no `prompt()`) and Change (the answers back with
  the answer given under them, kept through another's answer, then replaced), 🔥 Priority sent and off again, a refused
  send keeping its words, one's own message's You, Sent and "Seen by … and n more", the 🔥 strip only while its message is
  out of view, "↓ n new · 1 question", the take layer's Got it beside Open chat, the Escape order (a take over an open
  reply first), the sheet and Leave asked in place, Text size scaling the words, the answers, the response and the strip
  (the header fixed), the wake lock asked, dark first and Light sticking, the support view never turning the page light,
  a backstage page set to Simple writing in the simple view's composer, and "○ Nobody backstage is online" after 10 s.
- **The layout leg**: nine more sizes, each across a rule (640×1024, 1024×640, 768×1024, 1024×768, 375×667, 393×659,
  360×780, 734×343, 863×360): the column or the tabs, the body's size, no sideways scroll, the 44 px band, the
  placeholder (the short words where the long do not fit, measured), the sheet's last row reached and Leave asked; the
  feed's height at each is written to the smoke's output as a record, not a pass mark.
- **The floor leg's chat-view steps**: with the Fullscreen API taken away (`requestFullscreen`, `webkitRequestFullscreen`,
  `fullscreenEnabled`, `webkitFullscreenEnabled`) the sheet has no Full screen row and a take no ⛶; with the floor's Wake
  Lock gone, the settings words; with `isSecureContext` false, the HTTPS words; with the lock refused (`NotAllowedError`),
  the battery words.

**The walk** (on every row, upright and sideways; ✓, a fallback named, or ✕), as §5 says:

| Feature | What to look for | D1 | D2 | D3 | D4 | D5 | D6 | D7 |
|---|---|---|---|---|---|---|---|---|
| `innerWidth` × `innerHeight` and `devicePixelRatio`, upright and sideways | read on the device itself, upright and sideways (no AGMessage page shows them), and written in the row's record (§5); checked against §6's rules by size | not walked | not walked | not walked | not walked | not walked | not walked | not walked |
| The layout the rules draw, and the feed's height, upright and sideways | the column at 900 px wide or more while something is shown, the two tabs below that; 22 px text where the smaller side is 600 px or more, 20 px otherwise; no sideways scroll; the feed's height written down | not walked | not walked | not walked | not walked | not walked | not walked | not walked |
| 🕐 HH:MM in the hall's zone; the countdown's words, mark and edge | with nothing chosen the clock reads the hall's time of day (B3); with Countdown chosen, ⏱ and "left" with the title and the line, the readout's edge in Stagewatch's colour; overtime ▲ and "over"; with the link down `--:--` "Stagewatch offline" | not walked | not walked | not walked | not walked | not walked | not walked | not walked |
| A tap on an older message brings its row; a long press on a message opens nothing of AGMessage's; on a take and a card's thumbnail it offers no save | a tap on an older waiting message shows its own Got it and Reply; a long press there opens only the browser's own text selection; on a take and a thumbnail no "Save to Photos" or "Download image" | not walked | not walked | not walked | not walked | not walked | not walked | not walked |
| 👁 Look on a file, the wide column and its grip, ⇥ and its rail | Look under every file the page opens, a filled button; sideways, the file opens over half the screen and its page reads at the seat; the grip drags it wider and narrower, and the width holds after a reload; ⇥ leaves the rail "📺 Shown to you • n ⇤", and a tap on it opens the column again; upright, Look opens the Shown to you tab | not walked | not walked | not walked | not walked | not walked | not walked | not walked |
| Got it, Reply and Answer in words… with the on-screen keyboard up: the replying line and Send stay in view | with the keyboard up the line "Replying to …" and Send are above it; Got it reads "👍 You: got it" and the backstage page "👍 … got it" | not walked | not walked | not walked | not walked | not walked | not walked | not walked |
| 🔥 Priority sent, and the strip while its message is out of view | 🔥 Priority pressed and sent: the message 🔥 on the backstage page; a 🔥 message scrolled out of view brings its strip, which goes once it is back in view or got | not walked | not walked | not walked | not walked | not walked | not walked | not walked |
| The sheet: Text size, Clock or countdown, Theme, Full screen where offered (none on D6), Leave; the wake lock held 10 minutes untouched, or its words | each row acts (Text size scales the words; Clock or countdown changes the readout, or reads the admin's lock as words; Theme turns light and stays); no Full screen row on an iPhone; Leave asks in place; the sheet's last row reached with the device sideways | not walked | not walked | not walked | not walked | not walked | not walked | not walked |
| 📌 Pin for me, and the pinned bar | a tapped message's 📌 Pin for me, then Unpin for me; the bar reads "📌 For everyone" first where the room pinned one, "1 of 2" with two, and a pinned question answered from the bar | not walked | not walked | not walked | not walked | not walked | not walked | not walked |
| Also on, where the admin turned it on for this person | the composer's ⏱ and 👥 chips, one per switch the admin turned on; a message sent with them says where it went as each screen and page confirms; with Got it clears on, a got message folds to "👍 Got and cleared" with Show | not walked | not walked | not walked | not walked | not walked | not walked | not walked |
| Dark before the first frame, on a device last used in the simple view | the page opens dark with no light flash, the device's own theme notwithstanding | not walked | not walked | not walked | not walked | not walked | not walked | not walked |
| The placeholder whole, or the short words | "Message everyone here…" whole in the field, or "Message everyone…" where it does not fit; never cut | not walked | not walked | not walked | not walked | not walked | not walked | not walked |
| The reading distance and the Text size chosen (reading 9) | a Board member at their seat says within 5 s what is new and what is urgent; the distance and the Text size they chose written in the row's record (§5) | not walked | not walked | not walked | not walked | not walked | not walked | not walked |

## 7. The benches

Each a record, not a test: read on the rows it names, its number written here and in the test of the bound it sets. A
row the owner has no device for reads "not measured", as the walk's reads "not walked".

| Bench | Rows | What it sets | D1 | D2 |
|---|---|---|---|---|
| The largest picture the device decodes and draws: an image of a known size opened (`naturalWidth` × `naturalHeight` read) and drawn into a canvas, doubled until one fails | D1, D2 | the bound on a picture shown on the Board's pages, 40 megapixels until it is read | not measured | not measured |

A picture is held to 100 megapixels at upload (`lib/imagesize.js`) whatever this reads: that bound is the server's, on
what it keeps, and the one this bench sets is the stage's, on what a Board device is handed.

The quotes' benches (the stage's picks), each read before its number is fixed; on the rig's laptop where they name it:

| Bench | Where | What it sets | Reading |
|---|---|---|---|
| The glance budget: a quote's height at the stage's smallest type (28 px) read at a glance on a tablet and a phone | D2, D6 | "Long for the stage — the Board will scroll" on the bar, which never refuses; provisional until read: taller than 700 px at 1,100 px wide | not measured |
| A whole PDF page's body text read at a glance on a tablet's take | D2 | the Preview's bar suggesting 🔳 What I see where a whole page's body text would stand under 16 px on a tablet's take (the glance box above); provisional until read | not measured |
| A page picture drawn (2,048 px on its long edge) and uploaded, and paging through pictures against the uploads' rate (four, then one every 2 s) | the rig's laptop | whether the uploads' rate changes for pictures; none changes unless it is measured to matter | not measured |
| A 25 MB document's parse (its first page drawn) | D2, D4 | the readers' first draw (5,000 rows, 20,000 lines) | not measured |
| A pusher at the `writes` bucket's 5 a second onto the Board's pages | the rig's laptop | none: the bucket stands unless it is measured to matter | not measured |
| The `pages` lane's save of 50 halls each holding its 200 person takes and 20 Earlier entries as quotes (about 6 KB each) | the rig's laptop | a further bound on `pages.json`, only if it is measured to matter | not measured |

A quote reaches a phone in at least 20 px type, a table wider than its card scrolling inside it; the walk's rows for a
quote (a word, a paragraph, a cell with its labels, a 25 × 10 table) are §8's, on every row, D1 included.

The stage's devices bench (a phone may be remote, through the internet link on mobile data, owner answer 33):

| Bench | Rows | What it records | D6 | D7 |
|---|---|---|---|---|
| A document take's bytes and time to a phone through the tunnel: a 25 MB PDF shown at p. 12 (its first page drawn, by ranges) and a 2 MB Word file, the bytes the phone fetched and the seconds to `shown` | D6, D7 | a record beside the tunnel's own row: no bound is set from it unless it is measured to matter | not measured | not measured |

## 8. The stage on every row

The stage (what the Board's pages are shown over their chat: a quote, a picture, a web page, a document) on every row of
the matrix: the plan's Part 4 §5.15. No user agent is read anywhere in the stage's code; each fallback is chosen by a
probe or by what failed, and its words say what this device does.

**The document floor is Safari 16.4 (iOS and iPadOS 16.4), Chrome 103 and Firefox ESR.** pdf.js 4.10.38's legacy build is
compiled for those targets (its `gulpfile.mjs`'s `ENV_TARGETS`) and keeps a class static block, which Safari parses from
16.4 (`javascript.classes.static_initialization_blocks`); below it the module does not parse. The document worker inflates
Office files with `DecompressionStream('deflate-raw')`, which arrived at the same versions (`api.DecompressionStream`). An
older pdf.js for devices below the floor is not taken: 3.11.174's legacy build predates CVE-2024-4367's fix, and two
pdf.js versions would double what is vendored and tested. A picture of the place reaches those devices instead.

- **The probe.** At its join the hall page makes `new DecompressionStream('deflate-raw')` inside `try`, and sends `docs:
  true` only when it succeeds (`app/public/app.js`, `DOCS`). No syntax is probed: the page's policy has no
  `'unsafe-eval'`. The server keeps it per page (anything but `true` is no), and the console's read of where the pages
  stand counts each target's pages without it (`nodocs`). A device that passes the probe yet cannot import pdf.js draws
  that document as a device below the floor does (its stand-in, or "this device cannot open documents — ask for a
  picture") and opens no document for the rest of its tab's session (kept in `sessionStorage`, in `try`), joining again
  at once without `docs`.
- **A document's stand-in** (`standin` on a document take): for a PDF, a picture of the take's place, drawn and uploaded
  by the showing page as a page picture is (`{url}`: checked as a picture take is, kept as a stage file named by the
  take); for a Word, Excel or PowerPoint file, what is at that place, read as What I see reads it with its hidden parts
  left out (`{snippet}`: a quote's body, by a quote's rules and bounds); the server refuses either shape on the other's
  type. The showing page makes it only when the console's
  read says a target page joined without `docs`, so nothing is uploaded for nothing, and its bar says so before it goes
  ("2 of 6 Board pages are older devices: they get a picture of p. 12 in its place").
- **What a page without `docs` draws.** A document's stand-in, under its words ("As a picture of p. 12: this device cannot
  page through the document"; "As a quote from slide 3: …"), the document's line below it, reported `shown` with those
  words; the console reads "✓ 6/6 (2 as a picture)" ("as a quote" for a quote). With no stand-in (a page that joined
  after the push), a PDF or a zipped Office file draws "This device cannot open documents — ask the backstage team to
  show you a picture." and reports `failed`; the console of the take's pusher, an operator or the admin offers **Show
  them a picture of p. 12** (what is at the place, for an Office file) on the Board chip and on the person's row, a take
  of its own to each such page's person, drawn over the Board's on their pages alone (the console's read gives those
  seats the file to draw from, where each may show it). A picture, a CSV, Markdown, text and an Excel 97-2003 workbook
  (not zipped) need no reader, and are drawn. A side bar card and a Look under Earlier draw the stand-in; a Look at a document
  without one, and the panel's Look at a file, read the device's words. ⬇ Download on a take shown with Download ticked
  is offered as on any device: a form POST needs no parser. pdf.js is never fetched.
- **Everything else works below the floor**: quotes and tables (drawn with `textContent` and CSS), pictures
  (`HTMLImageElement.decode()`, Safari 11.1), zoom (Pointer Events, Safari 13), web pages (the one frame), Earlier,
  Download and the no-save measures. A quote's Open the source is a link and a web page's "Look for: ❝ …" is words: a
  browser without text directives opens the page at its top, and the words over the frame still say what to look for
  (not walked).
- **Older devices' other gaps, each with its fallback:** `<link rel="modulepreload">` arrived in Safari 17 and Safari has
  no `requestIdleCallback`: the Board page imports the take layer and the document reader with a timed `import()` 2 s
  after its join. Fetch Metadata arrived in Safari 16.4 (`http.headers.Sec-Fetch-Mode`): a device without it is served,
  so on D1 a file's address typed into the address bar opens it (`SECURITY.md` says so). `'wasm-unsafe-eval'` (Safari 16)
  is under the floor, so every device that opens documents draws JPEG 2000.
- **A long press:** iOS never fires `contextmenu` on one, so `-webkit-touch-callout: none` keeps "Save to Photos" off a
  picture there; Chrome on Android fires `contextmenu` on a long press, and the layer's handler opens AGMessage's menu in
  place of "Download image". Whether Samsung Internet does the same is D5's walk.
- **Phones** (D6, D7): the side bar is the chat view's 📺 Shown to you tab; a quote's type floor is 20 px under 600 px
  wide, and a table wider than the screen scrolls sideways inside its card; the zoom controls and the page box are 48 px,
  as in the simple view. A phone may be remote, through the tunnel on mobile data (answer 33): a quote or a picture costs
  its own bytes, a document its file (by ranges for a PDF). No measurement this round: §7's bench records it.

**What every push proves** (the browser smoke, Chromium):

- **The device legs**: a Board page at 1180 × 820, 820 × 1180 and 390 × 844, each a device of its own with a mobile viewport
  and touch, each opening documents by its probe: a quote in 28 px or more on a tablet and 20 px or more on a phone; a
  25 × 10 table scrolling sideways inside its card at 390 px, the page never sideways on any leg; a picture drawn, never
  draggable, its menu the page's; a PDF at its page, zoomed in by a tap on + and paged on by a tap, shown with Download
  ticked and saved whole by ⬇ Download on the phone, the page staying; a Word document without its hidden run or its
  tracked deletion, its header row drawn as headers, and found in; a workbook without its hidden column, row and sheets,
  a deck without its hidden shape and slide, a CSV, and Markdown without its comment; a JPEG 2000 page drawn; a web
  page's frame at a place, its "Look for: ❝ …" words over it; each ✓ on all three (the web page ◇); a picture under
  Earlier drawn again in a Look; a quote from a web page by the operator offering Open the source at its words, in a tab
  of the person's own with no opener or referrer, ✓ on all three, and one from a Staff account (no Web pages right)
  naming the site alone with no link; 20 takes in a row, then Back to chat, each page still drawing and never reloaded.
  Not on the legs: a pinch and a double-tap (touch gestures the legs do not make; the walk's), the first page of a 25 MB
  pack timed (the bench's, §7), Word's page numbers (the panel's steps, the same reader), Open in a new tab (the take's ⋯
  in the full view only: the legs are On stage in the simple view; the quote hall's smoke opens it in the full view), and
  a device asleep and back (the walk's).
- **The floor leg**: a Board page with `DecompressionStream`, `requestIdleCallback` and `Promise.withResolvers` taken away
  before its scripts run joins without `docs`; a document shown before it joined says it cannot open documents and fails,
  and the pusher's console offers Show them a picture of p. 1, which reaches that page alone; the pusher's bar then says
  "1 of 4 Board pages is an older device: it gets a picture of p. 1 in its place", the PDF goes with its stand-in, drawn
  with its words, never dragged out, its menu the page's, ✓ on the console "(1 as a picture)", and ⬇ Download on it,
  ticked, saves the file whole; a Word document's stand-in is what is at its place, as a quote naming the document,
  without its hidden run or tracked deletion, ✓ "(1 as a quote)"; under Earlier a Look at a document with no stand-in
  reads the device's words and one with a stand-in draws it; quotes, pictures (never dragged out, the page's menu), a web
  page at a place with its "Look for" words, a web quote's Open the source (and none from a pusher without the right) and
  Earlier draw; pdf.js is never fetched (the tab's network log, from its first request); no script error. It
  cannot take away syntax the browser parses: that is the ES2020 fence's and the walk's.
- **A Board page that passes the probe but cannot import pdf.js** (its module refused on the way): it draws the document
  as a page below the floor does (here its stand-in, with its words), opens no document for the rest of its tab's
  session, kept across a reload, and joins again without `docs`, counted on the console.
- **The server's half** (`test/pages.test.js`, `test/takes.test.js`): a stand-in is `{url}` (an image upload, checked as a
  picture take) for a PDF or a picture, or `{snippet}` (a quote's rules) for any other type, and any other shape, both,
  the other type's, or one on another kind is refused; a document and its stand-in find room on the stage together; a
  join's `docs` is yes only as `true`; `page:status` counts each target's pages without it; a page that drew the stand-in
  counts toward ✓ "as a picture" ("as a quote"); without one, its `failed` is counted (`cannot`), and the read gives the
  file to its pusher, an operator and the admin, never to a seat that may only show; a person's picture take reaches
  their pages alone. Show them a picture itself is the page's act: the floor leg drives it.

**The walk** (on every row; ✓, a fallback named, or ✕), as §5 says. The backstage page pushes each take to the Board:

| Feature | What to look for | D1 | D2 | D3 | D4 | D5 | D6 | D7 |
|---|---|---|---|---|---|---|---|---|
| A quote: a word, a paragraph, a cell with its labels and a 25 × 10 table, drawn, fitted, ✓ | each drawn in 28 px or more on a tablet, 20 px or more on a phone; the table scrolls sideways inside its card, never the page; the console reads ✓ for the device | not walked | not walked | not walked | not walked | not walked | not walked | not walked |
| A picture: a page picture and a region, drawn; pinch, double-tap and + / − zoom with pan; ✓ | both drawn whole; a pinch and a double-tap zoom, + and − zoom, a drag pans; the console reads ✓ | not walked | not walked | not walked | not walked | not walked | not walked | not walked |
| A web page: the frame, its "Look for" strip, Open in a new tab | the page in its frame with "Look for: ❝ …" over it; Open in a new tab opens it in the browser's own tab; the console reads ◇ opened | not walked | not walked | not walked | not walked | not walked | not walked | not walked |
| A PDF: the page box, paging, zoom, find; a JPEG 2000 page; the first page of a 25 MB pack, timed (D1: its stand-in, with its words) | the page shown is the one pushed, the box pages on and back, zoom and find work, a JPEG 2000 page draws; the 25 MB pack's first page's seconds written down. D1: a picture of the page under "As a picture of p. N: this device cannot page through the document" | not walked | not walked | not walked | not walked | not walked | not walked | not walked |
| A DOCX, XLSX, PPTX, CSV, Markdown or text document, without hidden parts; Word's page numbers (D1: CSV, Markdown and text drawn, the others as their stand-in) | each drawn without its hidden text, rows, columns, sheets, slides or comments; a Word file's page numbers; D1: the zipped ones as a quote of what is at their place | not walked | not walked | not walked | not walked | not walked | not walked | not walked |
| Earlier and Look: an Earlier entry, and a Look at a picture (D1: a document's entry draws its stand-in; a Look at one without reads the device's words) | a take taken down is under Earlier, and Look draws it again on this device alone | not walked | not walked | not walked | not walked | not walked | not walked | not walked |
| ⬇ Download on a take shown with Download ticked: the file in the device's downloads under its name, the page staying | the file saved whole under its own name in the device's downloads, the hall page still open behind it | not walked | not walked | not walked | not walked | not walked | not walked | not walked |
| No save: a long press on a picture offers no save, a drag leaves it, AGMessage's menu where `contextmenu` fires | no "Save to Photos" or "Download image"; a drag leaves the picture where it is; on D4, D5 and D7 the long press opens AGMessage's menu in place of the browser's | not walked | not walked | not walked | not walked | not walked | not walked | not walked |
| Many takes: 20 in a row, then Back to chat; the tab still draws, nothing reloads it | 20 takes pushed one after another, then Back to chat: the chat is back, the tab answers taps, and it never reloaded | not walked | not walked | not walked | not walked | not walked | not walked | not walked |
| Asleep, then back: a take sent while the device slept drawn at its next join, current or under Earlier | a take pushed while the device was locked is drawn when it is woken, or under Earlier if it was taken down meanwhile | not walked | not walked | not walked | not walked | not walked | not walked | not walked |

A model or browser version that appears after the walk is not proven until its row is walked again. The benches that
named "a Board iPad" run on the rows §7 names: D1 and D2 for the image decode limit, D2 and D4 for parse times, D2 and D6
for the glance budget, and D6 and D7 for a document through the tunnel.
