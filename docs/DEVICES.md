# The Board's devices

The owner's answer 22: "Board will use a mixture of devices". Read as: iPads on current and older iPadOS, Android
tablets, and phones (iOS and Android); every Board feature works on each, with a test matrix and fallbacks, and nothing
is tuned to one device. And on 2026-10-31, of the page floor below: "Keep these as mim" — the floor stays, and a Board
device below it is not supported.

This paper is the one matrix, the one floor of the pages and the one walk. It holds the hall page's, its menus', its
dialogs' and its stylesheet's part (the plan's Part 5 §15.10). The stage's rows (the document floor, a document's
stand-in below it, the no-save measures) join it with the stage's devices unit; the Board's chat view's rows (the
sheet's Full screen and wake-lock rows, the layout by size) are §6, from the chat view's unit (the plan's Part 7 §17.7);
neither makes a second matrix or a second walk.

Every browser version here is MDN's compatibility data (https://github.com/mdn/browser-compat-data), named by its path
there. No page reads the user agent: each fallback is chosen by a probe or by what failed, so a device nobody listed
draws by what it is.

## 1. The matrix

| Row | Device | Browser | Why it is a row | Walked |
|---|---|---|---|---|
| D1 | an iPad on an iPadOS before 16.4, the oldest the owner's devices run | Safari | below the document floor (Safari 16.4); at or above the page floor (iPadOS 14.5) unless the owner's oldest iPad is older, which this row then says | not walked |
| D2 | an iPad on iPadOS 16.4 to 16.7 | Safari | the oldest that opens documents | not walked |
| D3 | an iPad on the current iPadOS | Safari | the newest WebKit | not walked |
| D4 | an Android tablet | Chrome, current | a long press fires `contextmenu` | not walked |
| D5 | an Android tablet | Samsung Internet, current | a second Blink browser, with menus and downloads of its own | not walked |
| D6 | an iPhone on the current iOS | Safari | a phone's width | not walked |
| D7 | an Android phone | Chrome, current | a phone's width and a long press | not walked |
| CI | the smoke's Chrome (Linux) and Edge (Windows) | — | every push (§4) | every push |

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
| pdf.js | its legacy build's targets: Safari 16.4, Chrome 103 (the document floor) | the panel and screens | the stage's stand-in below the document floor, with the stage's devices unit | the legacy build |
| `DecompressionStream('deflate-raw')` | `api.DecompressionStream`, its `deflate-raw` format: Safari 16.4, Chrome 103, Firefox 113 (the document floor, the same probe as pdf.js's) | the document worker (`docworker.js`), which inflates a Word, Excel or PowerPoint file's parts with it | none on the panel: a device without it reads "this device cannot open documents — ask for a picture" for an Office file (an `.xls`, which is not zipped, still opens); the stage's stand-in, with the stage's devices unit | `app/public/docworker.js` (`inflater`, the answer `device`) |
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
  the chip's ask opens in place (no popover API) with Keep it open focused. A long day's hall opens at the floor with
  its newest 200 messages, the rest after the newest 60 drawn through `AGM.idle`'s timer, in the room's order, Show
  earlier above them, and no script error. With no `<dialog>` at all beside that,
  the Accounts page's Add a person opens, its Cancel closes it on the page and saves nothing, Escape closes it, Enter in
  a field submits through Save with Save as its submitter, and Export… opens and closes.
- **The smoke's leg below the floor:** without `WeakRef`, the sign-in page, the halls board, the Accounts page, the admin
  page and the hall page each show the floor's words and nothing else and ask nothing (no fetch, request, WebSocket or
  beacon); health's `clients` does not move, the hall never hears of the guest, and the sign-in form, sent, goes
  nowhere.
- **The device legs, the layout leg and the floor leg's chat-view steps** are §6's.
- **Not in CI:** Safari, Samsung Internet and WebView. Playwright's WebKit is refused: it would be a new dev dependency,
  and it is not the older iPadOS Safari this answer is about. The legs take features away in Chromium; the walk runs
  the real browsers. The floor leg's menu steps come with the units that build what they test.

## 5. The walk (before 0.6.0 is tagged)

On every row, each feature ✓, its fallback named, or ✕:

| Feature | D1 | D2 | D3 | D4 | D5 | D6 | D7 |
|---|---|---|---|---|---|---|---|
| The device: model, OS and browser versions, the date | not walked | not walked | not walked | not walked | not walked | not walked | not walked |
| The screen kept on for 10 minutes untouched, or the words naming why not | not walked | not walked | not walked | not walked | not walked | not walked | not walked |
| Help opened, sent and closed | not walked | not walked | not walked | not walked | not walked | not walked | not walked |
| ⋯ and a long press on a message in the full view; on a take in the simple view nothing opens and nothing saves | not walked | not walked | not walked | not walked | not walked | not walked | not walked |
| A dialog's buttons reached with the on-screen keyboard up | not walked | not walked | not walked | not walked | not walked | not walked | not walked |
| Every mark of `AGM.MARKS` drawn (✓ ◐ ◇ ▭ ○ ⊘ ◷ △ ✕ ■ ▶ ● ▲); the hall page's header on one row with its ⋯ | not walked | not walked | not walked | not walked | not walked | not walked | not walked |
| Back by itself after the device slept | not walked | not walked | not walked | not walked | not walked | not walked | not walked |
| A send written offline lands once | not walked | not walked | not walked | not walked | not walked | not walked | not walked |
| The same through the internet link on mobile data | — | — | — | — | — | not walked | not walked |
| The Board's chat view: its rows are §6's walk | §6 | §6 | §6 | §6 | §6 | §6 | §6 |

## 6. The Board's chat view on every row

The chat view (the simple view a page seated On stage draws unless the admin chooses Full for that person) lays out by
the viewport's size and each feature by a probe, never by the device's name: the plan's Part 7 §17.7, in
`app/public/styles.css` (`body[data-view="simple"]`) and `app/public/app.js` (`Simple`).

**The rules, by size:**

| Rule | Where it applies | Why |
|---|---|---|
| The Shown to you column, 360 px | 900 px wide or more, while something is shown (a file opened, a take minimised); its 36 px rail, which names it, while nothing is | it needs a chat of 540 px or more beside it; empty, the chat takes the rest of the width |
| The two tabs, Chat and 📺 Shown to you · n (`aria-pressed` buttons) | under 900 px wide, while something is shown: every phone, and every tablet upright | an upright tablet keeps its whole width for the chat |
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

**The walk** (on every row, upright and sideways; ✓, a fallback named, or ✕):

| Feature | D1 | D2 | D3 | D4 | D5 | D6 | D7 |
|---|---|---|---|---|---|---|---|
| `innerWidth` × `innerHeight` and `devicePixelRatio`, upright and sideways | not walked | not walked | not walked | not walked | not walked | not walked | not walked |
| The layout the rules draw, and the feed's height, upright and sideways | not walked | not walked | not walked | not walked | not walked | not walked | not walked |
| A tap on an older message brings its row; a long press on a message opens nothing of AGMessage's; on a take and a card's thumbnail it offers no save | not walked | not walked | not walked | not walked | not walked | not walked | not walked |
| Got it, Reply and Answer in words… with the on-screen keyboard up: the replying line and Send stay in view | not walked | not walked | not walked | not walked | not walked | not walked | not walked |
| 🔥 Priority sent, and the strip while its message is out of view | not walked | not walked | not walked | not walked | not walked | not walked | not walked |
| The sheet: Text size, Theme, Full screen where offered (none on D6), Leave; the wake lock held 10 minutes untouched, or its words | not walked | not walked | not walked | not walked | not walked | not walked | not walked |
| Dark before the first frame, on a device last used in the simple view | not walked | not walked | not walked | not walked | not walked | not walked | not walked |
| The placeholder whole, or the short words | not walked | not walked | not walked | not walked | not walked | not walked | not walked |
| The reading distance and the Text size chosen (reading 9) | not walked | not walked | not walked | not walked | not walked | not walked | not walked |

The clock or countdown's rows (🕐 HH:MM in the hall's zone; the countdown's words, mark and edge) join this table with
the clock's unit.

## 7. The benches

Each a record, not a test: read on the rows it names, its number written here and in the test of the bound it sets. A
row the owner has no device for reads "not measured", as the walk's reads "not walked".

| Bench | Rows | What it sets | D1 | D2 |
|---|---|---|---|---|
| The largest picture the device decodes and draws: an image of a known size opened (`naturalWidth` × `naturalHeight` read) and drawn into a canvas, doubled until one fails | D1, D2 | the bound on a picture shown on the Board's pages, 40 megapixels until it is read | not measured | not measured |

A picture is held to 100 megapixels at upload (`lib/imagesize.js`) whatever this reads: that bound is the server's, on
what it keeps, and the one this bench sets is the stage's, on what a Board device is handed.
