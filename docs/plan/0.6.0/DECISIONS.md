# The owner's answers (2026-10-26), with the reading the plan takes

The owner's words are quoted exactly; "Reading" is how the plan applies them. A reading the owner may correct is
marked **(to confirm)**.

## The audit chain (addendum-audit-hmac.md, H.13)

- **A. "Must the log be checkable on another computer?"** → "The log must be exportable"
  - Reading: the log is exported as a bundle that someone on another computer can check without this machine's HMAC
    key: every line, a manifest, and a signature by this machine over the chain's head. The bundle carries its public
    key and its fingerprint, plus a verifier that runs offline.
  - Each entry keeps its HMAC, as asked. Entry contents are made checkable off the machine without K (for example a
    plain hash chain beside the HMAC, whose head is what the signature covers).
  - The export is itself an audit row.
- **B. "Accept belongs to the laptop's token alone. Is that workable for your crew?"** → "Yes"
- **C. "On a machine that has never keyed a log, should the first start ask about the 0.5 entries?"** → "It is now
  0.5.1 - First start should ask"
  - Reading: the first 0.6.0 start on a 0.5.1 log does not take the older entries silently. They read △ until the
    laptop's token holder accepts them, and the acceptance is an entry of its own.

## Transfer, the stage and researcher pushes (addendum-stage.md, questions 10–20)

- **10.** → "Board pages should be more secure and not available to guests in an open hall. Web pages need rights of
  their own."
  - Reading: in an open hall (roles not locked), a code guest can neither show anything on the Board's pages nor take
    an On stage (Board) seat. On stage seats come from an invite or an account given the hall's `board`.
    **(to confirm: presenters who join by code would need an invite link.)**
  - Web pages on the stage need a right of their own, `stage.web`, apart from `stage.show`.
- **11.** → "Both as options."
  - Reading: the researcher chooses per push between a picture of exactly what they see and the live document the
    Board can page through.
- **12.** → "Leave as is" (download only when the researcher ticks "Let them download it").
  - Reading: answer 20 is the more specific answer for the Board, so a Board tablet never offers a download, tick or
    no tick. The tick remains only where a stage target is not a Board seat. **(to confirm)**
- **13.** → "Hidden things never shown."
- **14.** → "Page numbers would be preferable to have as well."
  - Reading: Word documents get page numbers as well as heading and paragraph anchors. The page numbers are taken from
    the page breaks Word itself last recorded in the file where present, and are said to be approximate otherwise.
- **15.** → "Yes" (`'wasm-unsafe-eval'` on the PDF worker's own response).
- **16.** → "options for both. Files, especially confidential, can only be sent to the rooms in use or selected."
  - Reading: a line to the speaker's screen can go through the operator or at once, chosen per send.
  - A file (or a quote or picture from it) can be marked confidential. It then goes only to the rooms where it is in use
    and to rooms the sender selects, and never to Stagewatch's speaker screen, which every Stagewatch output shows.
    **(to confirm)**
- **17.** → "Yes" (ask Stagewatch, for 2.20, for a picture or table card on the speaker's screens, and for messages a
  node owns).
- **18.** → "Yes" (files to transfer accept more types than the stage can show; AGMessage parses none of them).
- **19.** → "Yes" (the transcript and the minutes record what was shown to the Board: who, which file and page, a
  quote's text).
  - Reading: a confidential item is recorded with its mark, and its text never goes to the AI provider. **(to confirm)**
- **20.** → "No. And no board tablets should not keep copies, nor offer a download feature."
  - Reading: observers and Viewer accounts may not download files shared for download.
  - Board tablets offer no download and keep no copies: stage files are served `no-store`, drawn from memory, their
    object URLs revoked on close, and there is no download link or save action in AGMessage's own menus. A browser's own
    screenshot or developer tools cannot be prevented, and the papers say so.

## The owner's confirmations (2026-10-26, later the same day) — these supersede the readings above

- **10 (open halls)** → "Right": a code guest in an open hall can neither take an On stage (Board) seat nor show
  anything; presenters who join by code need an invite link. Confirmed, no longer "(to confirm)".
- **12 / 20 (downloads on a Board tablet)** → "A board tablet can have a feature to tick to enable it to be
  downloaded."
  - Reading: a Board tablet offers no download and keeps no copy **by default**. The sender's "Let them download it"
    tick on a whole file (answer 12, "leave as is") does apply to Board tablets: when ticked, that item offers Download
    there, and only that item.
  - Quotes and page pictures are never downloads. Observers and Viewer accounts still never download (answer 20).
- **16 (confidential)** → "Right. But if the speaker screen is part of the room, yes it can, as they would be the people
  who need to see it."
  - Reading: a confidential file, and every quote or picture from it, goes only to rooms where it is in use or that the
    sender selects. The speaker's screen counts as part of a room when it is the Stagewatch linked to that room's hall
    and that room is one of them (in use or selected).
  - A confidential item may then go to that speaker's screen, through the operator or at once as chosen, with the
    sender told in words that every output of that Stagewatch shows it. It never goes to another hall's Stagewatch.
- **19 (minutes)** → "Right": confidential items are recorded with their mark, and their text never goes to the AI
  provider. Confirmed.

## The Board's chat view (the owner's ask, 2026-10-26)

> "The Boards chat view doesn't need to let them add file attachments or create action prompts. They can chat and
> respond and view pushed documents, but they are there to be supported so only need minimal features. Main focus is
> the chat and messages - this doesn't mean the message container design needs to be huge, rather it needs to be more
> minimal and more focused on direct response and clear communication.
> It should have the local and admin option to include the current time of day or StageWatch data for showing
> countdowns as a secondary object within the design."

- Reading:
  - A Board seat (On stage in a Main room, guest or account) chats, replies, answers prompts, asks for help, and views
    what is pushed to it.
  - It never attaches a file or creates an action prompt. The server refuses both, whatever the page sends.
  - The chat is the primary object, and it is compact rather than large.
  - The time of day or Stagewatch's countdown is an optional secondary object: off, the clock, or Stagewatch.
  - Both the Board member on their device (local) and the admin (per person) can set it. The admin's choice is the
    default and the device's choice overrides it on that device. **(to confirm: may the admin lock it?)**
- **Confirmed (2026-10-26):** "Yes, the admin may lock the clock/countdown setting"
  - The admin's per-person setting carries a lock. While locked, the device's own choice is not offered, and the server
    sends the admin's choice whatever the device stored.
  - Unlocking returns the device's choice. Each lock and unlock is an audit row.

## The Board's chat view: the owner's answers to B1–B6 (2026-10-26)

- **B1** → "they can can pin messages for themselves. they don't need to answer other people's help requests other
  than interact with the usual chat."
  - Reading: an On stage seat may pin messages for itself only. A personal pin is kept for that person and that device
    (an account's pins follow the account), and is never a room pin others see.
  - The seat cannot answer or take other people's help requests; `help:respond` is refused on the server. It still
    asks for help itself and uses the chat as usual.
- **B2** → "An account seated on stage gets messages on that page. Anyone in that same room sees the messages (they
  need to as support). An admin can choose if messages can go onto other screens - such as on a countdown screen, or
  anyone with an On stage seat."
  - Reading: what an On stage seat writes is in the room's feed, and everyone in that room sees it, as support needs.
    By default it goes nowhere else: no screens, no speaker's screen, no people's pages, whatever the account's role.
  - The admin may allow it per person, in two separate switches, each off by default and audited:
    - "may send to a countdown screen": a message to the message strip of a `/d/` countdown screen in that hall;
    - "may send to people On stage": a message shown on the pages of the hall's On stage seats.

    **(to confirm the reading of "anyone with an On stage seat")**
- **B3** → "Clock on by default." The secondary object starts as the clock (time of day) for every On stage seat. The
  device or the admin may change it to the countdown or off, subject to the admin's lock.
- **B4** → "Got it tells the backstage team with the members name. Clearing the message is an admin option, off by
  default."
  - Got it reports to backstage with the Board member's name.
  - Whether Got it also clears the message from that Board member's screen is an admin setting, per person, off by
    default (the message stays in the feed, marked as got).
- **B5** → "Yes." Board members may send 🔥 Priority messages; the composer keeps 🔥.
- **B6** → "Yes." The Board's view starts in Dark. This also answers the architecture addendum's question 21.
- **B2 confirmed (2026-10-26):** "yes": "anyone with an On stage seat" means that, when the admin allows it, a Board
  member's message can appear on the pages of the others seated On stage. It is no longer "(to confirm)".

## Pins (the owner, 2026-10-27)

> "A pin can be for the room (default) (including On stage - essential for action prompts), or personal."

- Reading:
  - Every pin is one of two kinds: **for the room** (the default) or **for me** (personal).
  - A room pin is seen by everyone in the room, On stage seats included, so a question (an action prompt) pinned
    for the room reaches the Board's pinned bar, where it is answered.
  - Personal pins are open to every seat, not only On stage.
  - **Confirmed (2026-10-27):** "A board member cannot pin for the room, only themselves. So pinning for everyone is
    for backroom teams, not the board or presenters on stage."
    - On stage seats (Board members and presenters) pin **for me** only, and the server refuses a room pin from them.
    - Backstage seats and accounts that may post choose **for the room** (the default) or **for me**.

## Pins: the owner's answers to the plan's three readings (2026-10-27)

1. **Where a pinned question is answered** → "A pinned question becomes hidden in the scrolling chat, and becomes
   visible in scrolling chat when unpinned."
   - Reading: in every view, simple and full, a question pinned in a way this person sees (for the room, or for them)
     is drawn only in their pinned place: the Board's pinned bar, or the full view's pinned strip. That is where its
     answers are.
   - It is hidden from their feed while it stays pinned, and returns to its place in the feed when unpinned.
   - This replaces the plan's "answers in the bar only while the question is out of view".
2. **Room pins listed first** → "Yes".
3. **Got it never clears a pinned message, either kind** → "Correct".

## Every question left open: the owner's answers (2026-10-27)

> "Defaults except for: 4 - Admin defined · 22 - Board will use a mixture of devices · 29 - wrap into 0.6.0 · 33 - Yes
> they can, Unknown quantities. · 34 - Installer in 0.6.0 · 35 - Yes · 38 - Whichever account it is installed on.
> Could be either an admin account or standard. The admin will be whoever does the install. They can add permissions or
> handover to another account. · 45 - Archive old event data. A new event can continue a previous event, copy the
> settings and structure of a previous event, or start fresh. Keep linking settings. Carry on audit log with an archive
> point an entry in it. Admin can choose to split the audit log and archive the older part."

### The exceptions

- **"4 – Admin defined":** read as the stage reading **S4**, whether a locked hall's backstage code guests may push web
  pages.
  - It is an admin setting per hall, off by default. While it is on, such guests also need `stage.web`'s equivalent
    for code guests, given by that setting.
  - **(to confirm: S4, not A4)**
  - A4 keeps its default: the first start asks and does not block sign-ins.
- **22** → the Board uses a mixture of devices: iPads (current and older iPadOS), Android tablets, and phones (iOS and
  Android). Every Board feature works on each, with a test matrix and fallbacks (Wake Lock, long-press, the legacy
  pdf.js build, `<dialog>` and CSS support), and nothing is tuned to one device.
- **29** → "wrap into 0.6.0": there is no 0.5.2. Every stand-alone unit (the start window S, the audit chain H/H2, the
  arch-ux lettered units, L, V, G and the others) ships in 0.6.0.
- **33** → remote phones do join through the tunnel on mobile data, in unknown numbers.
  - The bounded first open (arch-ux unit 32) lands in 0.6.0 rather than waiting on a reading.
  - The tunnel path is designed for an unknown count: per-address and global bounds that say what they refused, and a
    tunnel reading taken before the show.
- **34** → the installer is in 0.6.0 (U12–U16 with U1–U11). U7's Windows readings are still taken; they inform the
  release and do not hold it back.
- **35** → yes: the show laptop must serve with nobody signed in. The installed shape is B-service or B-task (session 0,
  data and keys in `%ProgramData%\AGMessage`, started with Windows), never B-session. The install addendum chooses one
  and says why.
- **38** → the account is whichever one AGMessage is installed on, admin or standard.
  - The AGMessage admin is whoever runs the install. The installer records that Windows account as the node's admin:
    it holds the laptop's token and the start, stop and upgrade rights.
  - A per-machine install still needs Windows' elevation, so a standard account is asked for an administrator's
    approval once.
  - That admin can later give the same rights to another Windows account, or hand them over entirely, through the
    supervisor's own commands. Each grant and handover is audited.
- **45** → events:
  - **A new event** can continue a previous event, copy a previous event's settings and structure (halls, rooms,
    allow-lists, screens, accounts and their rights, views, without messages or files), or start fresh.
  - **Old event data** (messages, files, help requests, transcripts, desk results, takes) is archived, never deleted
    silently.
  - **Linking settings are kept:** Stagewatch, Patterns and PlayMap links, keys and pins.
  - **The audit log carries on** across events, with an archive-point entry written in it.
  - **The admin may split the audit log** at that point and archive the older part. The check then verifies the
    current log from the archive point and names the archive, which is still checkable on its own and in an export.

### Everything else: the plan's defaults

- **Stage S1–S16:** the readings as applied, except S4 (above).
- **Audit A1–A4:** A1 admin and the laptop's token only, with others granted; A2 ◇ "Linked" after Accept; A3 an export
  at the end of each show day; A4 does not block sign-ins.
- **21** dark (B6).
- **23** "Backstage".
- **24** "Show the Board" / "Show Ana".
- **25** a help category sends at once.
- **26** no typing indicator.
- **27** sent when back, marked with how long it waited.
- **28** "a power cut can lose the last few seconds", until the disk is measured.
- **30** keep "meetings".
- **31** one Holding page with the logo.
- **32** keep both ✕ and ▭, Escape minimises.
- **36** unsigned, named `-unsigned`, with SHA256SUMS.
- **37** the local subnet only, and never the Public profile unless chosen at install. It starts with Windows (35).
- **39** busy as proposed, and a busy server stopped only with a typed reason.
- **40** yes.
- **41** "Session restored" only after a stop that did not save cleanly (the plan's choice: the question had no stated
  default).
- **42** keep `secret.key` and the certificate, and remove the old copies from the show user's profile once the import
  is verified (the plan's choice).
- **43** keep the data on uninstall, with "Remove all AGMessage data from this PC" offered unticked.
- **44** venue laptops use the portable folder, and the installer is for the owner's own laptops (the plan's choice).

## The last open questions: the owner's answers (2026-10-31)

> "1. S4 · 2. Add it · 3. Yes · 4. Keep these as mim"

1. **"4 – Admin defined" meant S4.** Confirmed: a per-hall admin setting, off by default, lets a locked hall's backstage
   code guests show web pages. A4 and the design's question 4 keep their defaults. No "(to confirm)" remains.
2. **The stored admin-token sign-in** → "Add it".
   - Reading: a unit of its own. Token sign-ins are kept as keyed hashes, with a key derived from the machine key
     outside the data folder, so someone who can write the data folder cannot plant a sign-in. They still survive a
     watchdog restart.
   - The plan extends the same keying to account sessions and account records, which the same writer could otherwise
     use to mint an admin account. **(the plan's extension: the owner may narrow it to token sign-ins only)**
3. **The Stagewatch request's items 3–7** → "Yes": they are asked, with items 1 and 2.
4. **The Board device floor** → "Keep these as mim[imum]": iPadOS 14.5 and Chrome 84 stay the minimum. A Board device
   below it is not supported (retired or replaced), and the floor is not lowered.
