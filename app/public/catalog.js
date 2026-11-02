// The action catalogue (AGM.catalog): every act a page offers on an object, written once as data and pure functions of
// the page's facts and the object, with no DOM and no socket. The buttons drawn on an object, its right-click menu, its
// ⋯ menu, Shift+F10 (or the menu key) and its single keys all read this one list, so they cannot drift apart; a page
// binds only what each act does (its runner). test/catalog.test.js holds the list to its rules and the seats to their
// shown sets, test/menus.test.js holds every act hidden by rights to the server's refusal of it, and the browser smoke
// holds the doors to each other.
//
// An entry: `id` (kind.verb: the data-action, the test key), `label` (one string, or a function of (f, o): the button's
// aria-label, its tooltip and the menu item; "…" ends the label of an act that asks first or opens a dialog), `short`
// (its label inside a fold), `icon` (aria-hidden), `key` (a single key on the focused object), `group` (GROUPS, in
// order), `inline` (a rank, or none: the object's bar draws the two lowest shown), `verb` (a socket verb, an HTTP route
// written 'http:METHOD /path', or 'local'), `mode` (the outbox's: now, hold, self, local), `may` (rights: false and the
// act is absent; each matches a refusal the server words), `fits` (the view, the object's kind and state: false and the
// act is absent; never asked of the server), `ready` (now: true, or the words that say why not, and the act is shown
// disabled with them), `confirm` (an ask in place, AGM.ask, before it runs), `undo` (the id that takes it back),
// `submenu` (the values it offers one level down), `fold` (entries of one kind that share it and are both shown are
// drawn as one item, FOLDS, their short labels one level down; one alone is drawn flat with its full label).
//
// The ids later units name: `msg.speaker` is the speaker's screen's line box (Ask the operator…, or Edit, then send…
// where Stagewatch keeps no show desk), shown wherever the Speaker's screen ▸ door is, and folded there with
// `msg.sendNow`; a help request's answers are two ids, `msg.helpRespond` (On my way) and `msg.helpResolve` (Resolved),
// so each can be absent alone. In the simple view (`view: 'simple'`) no object has a menu: its acts are its buttons.
// A kind drawn on more than one page (`person`: the hall page's People panel and a message's sender, and the admin
// page's people rows) fits each page's rows only on that page (`page`, a fact of each page's facts), so a page never
// draws a row whose runner is another page's, and no row is hidden by a right the server would not refuse.
// An entry with `checked` is a toggle, drawn as a menu item that is checked or not (🔥 Priority).
(function (root) {
  'use strict';

  const GROUPS = Object.freeze(['1_respond', '2_send', '3_keep', '4_manage', '9_danger']);
  const REACTIONS = Object.freeze(['👍', '👎', '❤️', '🎉', '🤔', '👀', '😂', '🔥']);
  const WORDS = Object.freeze({
    offline: 'Not connected — AGMessage is reconnecting.',
    held: '◷ sent when the connection is back',
    gone: 'Not available any more.',
    noScreens: 'No screens in this hall yet — add one in Screens.',
    linkDown: 'Stagewatch is not connected right now — nothing is queued; try again when it is.',
    linkKey: 'Stagewatch has not accepted this AGMessage\'s key yet — nothing is queued; try again in a moment.',
    linkRefused: 'Stagewatch refused this AGMessage\'s key — nothing can be sent until an admin enters a node key it lists (Halls → Set up).',
    linkCert: 'Stagewatch\'s certificate changed — nothing can be sent until an admin accepts it (Halls → Set up, or Admin → Show network).',
    noAi: 'AI drafts are off: no Anthropic API key — add one under ✨ AI drafts.',
    aiOff: 'AI drafts are off: they need an Anthropic key (admin) and the internet. Everything else works without them.',
    noFile: 'Choose a file first.',
  });
  /** The support view's words (R8): every door the person has, drawn, and none of them acts. */
  const supportWords = (name) => 'This is ' + name + '\'s view — act from your own page.';
  const FOLDS = Object.freeze({ speaker: Object.freeze({ label: 'Speaker\'s screen', icon: '🖥' }) });

  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const mine = (f, o) => !!f.uid && !!o.from && o.from.uid === f.uid;
  /** A message with words of its own that can be put on the speaker's screen. */
  const said = (o) => (o.type === 'text' || o.type === 'action') && typeof o.text === 'string' && o.text.length > 0;
  /** What a hall's screens can show of a message: its words, or a picture or a PDF. */
  const showable = (o) => (o.type === 'text' && !!o.text) || (o.type === 'file' && /^(image\/(png|jpeg|gif|webp)|application\/pdf)$/.test(o.mime || ''));
  const helpState = (o) => (o.help && o.help.state) || 'open';
  const reacted = (f, o, emoji) => !!f.uid && Array.isArray(o.reactions) && o.reactions.some((r) => r.uid === f.uid && r.emoji === emoji);
  const answered = (f, o) => {
    const r = Array.isArray(o.responses) ? o.responses.find((x) => x.uid === f.uid) : null;
    return r ? r.optionIndex : null;
  };
  const backstage = (f) => f.role === 'research';
  // A Viewer account's pages hold no file's link, whatever its seat: no Look and no Download (the server's half is the
  // stage's withheld link).
  const seesFiles = (f) => (f.role === 'research' || f.role === 'board') && !f.viewer;
  const full = (f) => f.view !== 'simple';
  /** The page an object's row is drawn on: the hall page's facts say 'hall', the admin page's 'admin'. */
  const onHall = (f) => f.page === 'hall';
  const onAdmin = (f) => f.page === 'admin';
  const newestPlain = (f) => (f.waiting.plain.length ? f.waiting.plain[f.waiting.plain.length - 1] : '');
  /**
   * The simple view's one response place for a message: each waiting 🔥 message, and the newest waiting plain one (the
   * page says which wait: a message from backstage waits for this person until their 👍, a reply to it, or an answer).
   */
  const respondsHere = (f, o) => f.waiting.priority.includes(o.id) || (!o.priority && newestPlain(f) === o.id);
  /** A hall as an ask names it: its name, else its code. */
  const hallOf = (o) => String(o.hall || o.name || o.code || 'this hall');
  /** The seats the admin moves a code guest between, in the words every page uses (the value is the server's). */
  const SEATS = Object.freeze([['board', 'On stage'], ['research', 'Backstage'], ['observer', 'Observer']]);
  const seatOf = (role) => (role === 'director' ? 'board' : role);
  /** A Patterns or PlayMap: the links a pairing token drives. */
  const isNode = (o) => o.t === 'patterns' || o.t === 'playmap';
  /** A verb's own words, without its placeholders: what a line to propose starts with. */
  const verbStem = (v) => String(v || '').split(/\s+/).filter((w) => !/^[<[{(]/.test(w)).join(' ') + ' ';
  /**
   * The halls a node may be linked for: every hall, then each listed; the hall it is linked for now stays a choice (and
   * chosen) when the page does not list it (closed since, or the list not read yet), so a Save never moves it quietly.
   */
  function hallChoices(f, now) {
    const listed = (f.halls || []).map((h) => ({ value: h.code, label: (h.name || h.code) + ' · ' + h.code }));
    const kept = now && !listed.some((h) => h.value === now) ? [{ value: now, label: now + ' · not listed here now' }] : [];
    return [{ value: '', label: 'Every hall' }].concat(listed, kept);
  }
  /** Why the internet link cannot be checked now, or '': off, no address yet, a check running, or one within a minute. */
  function tunnelWhy(o) {
    if (!o.running) return 'The internet link is off.';
    if (!o.url) return 'Waiting for Cloudflare to give the address.';
    if (o.checking) return 'Checking the internet link…';
    if (Number.isFinite(o.checkedAgo) && o.checkedAgo <= 60) return 'Checked ' + Math.max(0, Math.round(o.checkedAgo)) + ' s ago.';
    return '';
  }
  /** Who an audit row's actor is, as the filter keeps it: its kind and its id. */
  const actorKey = (o) => (o.actor ? String(o.actor.t || '') + ':' + String(o.actor.id || o.actor.name || '') : '');

  const KINDS = {
    // A message: in the feed, and its copy in the pinned strip (one delegated handler for both, no clone).
    msg: [
      // 👍 Got it: the simple view's answer to the backstage team, one per message it answers (Got all N answers each
      // plain message waiting); the full view's React ▸ 👍 is the same fact, so it has none.
      { id: 'msg.ack', label: (f, o) => (!o.priority && f.waiting.plain.length > 1 ? 'Got all ' + f.waiting.plain.length : 'Got it'), icon: '👍', group: '1_respond',
        inline: () => 1, verb: 'react', mode: 'hold', may: (f) => f.post,
        fits: (f, o) => !full(f) && !!o.from && o.from.role === 'research' && (o.type === 'text' || o.type === 'file') && !reacted(f, o, '👍') && respondsHere(f, o) },
      { id: 'msg.reply', label: 'Reply', icon: '↩', key: 'R', group: '1_respond', inline: (f) => (full(f) ? 1 : 2), verb: 'local', mode: 'local',
        may: (f) => f.post, fits: (f, o) => full(f) || respondsHere(f, o) },
      { id: 'msg.react', label: 'React', icon: '😊', key: 'E', group: '1_respond', verb: 'react', mode: 'now',
        may: (f) => f.post, fits: (f) => full(f),
        submenu: (f, o) => REACTIONS.map((e) => ({ value: e, label: e, role: 'menuitemcheckbox', checked: reacted(f, o, e) })) },
      { id: 'msg.answer', label: 'Answer', icon: '☑', group: '1_respond', verb: 'actionResponse', mode: 'hold',
        may: (f) => f.post, fits: (f, o) => o.type === 'action' && Array.isArray(o.options) && o.options.length > 0,
        submenu: (f, o) => o.options.map((opt, i) => ({ value: i, label: String(opt), role: 'menuitemradio', checked: answered(f, o) === i })) },
      { id: 'msg.answerWords', label: 'Answer in words…', icon: '✎', group: '1_respond', verb: 'actionResponse', mode: 'hold',
        may: (f) => f.post, fits: (f, o) => o.type === 'action',
        confirm: () => ({ title: 'Answer in words', words: 'Your answer goes to everyone in this room, under the question.',
          fields: [{ name: 'note', label: 'Your answer', max: 200 }], yes: 'Send answer', no: 'Cancel' }) },
      // Help requests are answered by the backstage team; a seat On stage marks only its own request resolved (from its
      // Help chip in the simple view).
      { id: 'msg.helpRespond', label: 'On my way', icon: '▷', group: '1_respond', verb: 'help:respond', mode: 'hold',
        may: (f) => f.respondHelp, fits: (f, o) => full(f) && o.type === 'help' && helpState(o) === 'open' },
      { id: 'msg.helpResolve', label: 'Resolved', icon: '🏁', group: '1_respond', verb: 'help:respond', mode: 'hold',
        may: (f, o) => f.respondHelp || (f.post && mine(f, o)), fits: (f, o) => full(f) && o.type === 'help' && helpState(o) !== 'resolved' },
      // AI drafts off (no key, no internet) is the laptop's state, not a right: shown, with why, as the composer's ✨ is.
      { id: 'msg.draft', label: 'Draft a reply', icon: '✨', group: '1_respond', verb: 'ai:draft', mode: 'now',
        may: (f) => backstage(f), fits: (f, o) => full(f) && !!o.from && o.from.role === 'board' && said(o), ready: (f) => f.ai || WORDS.aiOff },
      // The speaker's screen ▸: its line box, to edit the line and choose its urgency (Ask the operator where Stagewatch
      // keeps a show desk, else Edit, then send), and Send now, which sends the message's words as they are.
      { id: 'msg.speaker', label: (f) => (f.canPropose ? 'Ask the operator…' : 'Edit, then send to the speaker\'s screen…'), short: (f) => (f.canPropose ? 'Ask the operator…' : 'Edit, then send…'),
        icon: '📝', group: '2_send', fold: 'speaker', inline: (f) => (f.canPropose ? 2 : false), verb: 'stage:propose', mode: 'now',
        may: (f) => backstage(f) && (f.canPropose || f.canSendToStage), fits: (f, o) => full(f) && said(o), ready: (f) => f.stageWhy || true },
      { id: 'msg.sendNow', label: 'Send now to the speaker\'s screen', short: 'Send now', icon: '🖥', group: '2_send', fold: 'speaker', inline: () => 3,
        verb: 'stage:send', mode: 'now', may: (f) => backstage(f) && f.canSendToStage, fits: (f, o) => full(f) && said(o), ready: (f) => f.stageWhy || true },
      { id: 'msg.screens', label: 'Show on screens…', icon: '⧉', group: '2_send', inline: () => 4, verb: 'display:take', mode: 'now',
        may: (f) => f.canScreens, fits: (f, o) => full(f) && showable(o), ready: (f) => f.screens > 0 || WORDS.noScreens },
      // ↗ Send to ▸: the rooms this message would be taken in, asked of the server as it opens. A file moves only from a
      // seat that shares files here; a help request stays in its hall.
      { id: 'msg.send', label: 'Send to', icon: '↗', key: 'F', group: '2_send', verb: 'forward', mode: 'hold',
        may: (f, o) => f.forwardable && (o.type !== 'file' || f.files), fits: (f, o) => full(f) && (o.type === 'text' || o.type === 'file' || o.type === 'action'),
        submenu: () => null },
      // The room's pin; the simple view keeps it off (its pinned place is read-only there).
      { id: 'msg.pin', label: (f, o) => (o.pinned ? 'Unpin' : 'Pin'), icon: '📌', key: 'P', group: '3_keep', verb: 'pin', mode: 'now',
        may: (f) => f.pin, fits: (f) => full(f), undo: 'msg.pin' },
      { id: 'msg.look', label: 'Look', icon: '👁', key: 'Enter', group: '3_keep', verb: 'local', mode: 'local',
        may: (f) => seesFiles(f), fits: (f, o) => o.type === 'file' },
      { id: 'msg.download', label: 'Download', icon: '⬇', key: 'D', group: '3_keep', verb: 'local', mode: 'local',
        may: (f) => backstage(f) && !f.viewer, fits: (f, o) => o.type === 'file' && typeof o.url === 'string' && o.url.length > 0 },
      { id: 'msg.copy', label: 'Copy text', icon: '📋', group: '3_keep', verb: 'local', mode: 'local',
        may: () => true, fits: (f, o) => full(f) && typeof o.text === 'string' && o.text.length > 0 },
      { id: 'msg.delete', label: 'Delete…', icon: '🗑', key: 'Delete', group: '9_danger', verb: 'delete', mode: 'now',
        may: (f, o) => mine(f, o), fits: (f) => full(f),
        confirm: (f, o) => ({ title: 'Delete your message?', words: '“' + snippet(o) + '” goes from everyone\'s page in this room now. This cannot be undone.', yes: 'Delete', no: 'Keep it', danger: true }) },
    ],

    // A file: an entry of the panel's pinned list, and the file open in the panel (the Preview's header).
    file: [
      { id: 'file.screens', label: 'Show on screens…', icon: '⧉', group: '2_send', verb: 'display:take', mode: 'now',
        may: (f) => f.canScreens, fits: (f, o) => showable(o), ready: (f) => f.screens > 0 || WORDS.noScreens },
      { id: 'file.look', label: 'Look', icon: '👁', key: 'Enter', group: '3_keep', inline: () => 1, verb: 'local', mode: 'local',
        may: (f) => seesFiles(f), fits: (f, o) => o.where === 'list' },
      { id: 'file.download', label: 'Download', icon: '⬇', key: 'D', group: '3_keep', verb: 'local', mode: 'local',
        may: (f) => backstage(f) && !f.viewer, fits: (f, o) => typeof o.url === 'string' && o.url.length > 0 },
      { id: 'file.pin', label: (f, o) => (o.pinned ? 'Unpin' : 'Pin'), icon: '📌', key: 'P', group: '3_keep', inline: () => 2, verb: 'pin', mode: 'now',
        may: (f) => f.pin, fits: () => true, undo: 'file.pin' },
      { id: 'file.close', label: 'Close', group: '4_manage', inline: () => 3, verb: 'local', mode: 'local',
        may: () => true, fits: (f, o) => o.where === 'preview' },
    ],

    // A screen: a row of the Screens console (display.control sees and drives them; display.manage makes and changes them).
    screen: [
      { id: 'screen.identify', label: 'Identify', icon: '◎', group: '2_send', inline: () => 1, verb: 'display:identify', mode: 'now',
        may: (f) => f.canScreens, fits: () => true },
      { id: 'screen.only', label: 'Tick only this one', icon: '☝', group: '2_send', verb: 'local', mode: 'local',
        may: (f) => f.canScreens, fits: () => true },
      { id: 'screen.copy', label: 'Copy link', icon: '🔗', group: '4_manage', verb: 'local', mode: 'local',
        may: (f) => f.screensManage, fits: (f, o) => typeof o.path === 'string' && o.path.length > 0 },
      { id: 'screen.open', label: 'Open', icon: '📂', group: '4_manage', verb: 'local', mode: 'local',
        may: (f) => f.screensManage, fits: (f, o) => typeof o.path === 'string' && o.path.length > 0 },
      { id: 'screen.rename', label: 'Rename…', icon: '🏷', group: '4_manage', verb: 'display:update', mode: 'now',
        may: (f) => f.screensManage, fits: () => true,
        confirm: (f, o) => ({ title: 'Rename ' + o.name, fields: [{ name: 'name', label: 'Name', value: o.name, max: 60 }], yes: 'Rename', no: 'Cancel' }) },
      { id: 'screen.rotate', label: 'New link…', icon: '↻', group: '9_danger', verb: 'display:rotate', mode: 'now',
        may: (f) => f.screensManage, fits: () => true,
        confirm: (f, o) => ({ title: 'Give ' + o.name + ' a new link?', words: 'The old link stops at once, on every screen that has it. The new one is copied for you to open on the screen.', yes: 'New link', no: 'Keep this link', danger: true }) },
      { id: 'screen.remove', label: 'Remove…', icon: '🗑', group: '9_danger', verb: 'display:remove', mode: 'now',
        may: (f) => f.screensManage, fits: () => true,
        confirm: (f, o) => ({ title: 'Remove ' + o.name + '?', words: 'Its link stops working on every screen that has it open.', yes: 'Remove', no: 'Keep it', danger: true }) },
    ],

    // The composer: its Send button (its one act on the row) and its ⋯, never its text field, where the browser's own
    // menu stays (spelling, paste). `form` is the composer shown ('director' On stage; 'text', 'action' or 'file'
    // backstage), `room` the room's name, `file` the name of the file chosen to send ('' for none), `replying` whom the
    // next send answers ('' for nobody), `priority` whether 🔥 is pressed.
    compose: [
      // ✨ A draft of a reply, from the thread and the document on stage, into the composer: a person edits and sends it.
      // AI drafts off (no key, no internet) is the laptop's state, not a right: shown, with why.
      { id: 'compose.draft', label: 'Draft a reply', icon: '✨', group: '1_respond', verb: 'ai:draft', mode: 'now',
        may: (f) => backstage(f), fits: (f, o) => full(f) && o.form === 'text', ready: (f) => f.ai || WORDS.aiOff },
      { id: 'compose.send', label: (f, o) => (o.room ? 'Send to ' + o.room : 'Send'), icon: '➤', group: '2_send', inline: () => 1, verb: 'message', mode: 'hold',
        may: (f) => f.post, fits: () => true, ready: (f, o) => (o.form === 'file' && !o.file ? WORDS.noFile : true) },
      { id: 'compose.priority', label: 'Priority', icon: '🔥', group: '2_send', verb: 'local', mode: 'local', checked: (f, o) => !!o.priority,
        may: (f) => f.post, fits: () => true },
      { id: 'compose.attach', label: 'Attach a file…', icon: '📎', group: '2_send', verb: 'local', mode: 'local',
        may: (f) => f.files, fits: (f, o) => o.form !== 'director' },
      { id: 'compose.removeFile', label: 'Remove the file', group: '4_manage', verb: 'local', mode: 'local',
        may: (f) => f.files, fits: (f, o) => o.form === 'file' && !!o.file },
      { id: 'compose.cancelReply', label: 'Cancel the reply', key: 'Escape', group: '4_manage', verb: 'local', mode: 'local',
        may: (f) => f.post, fits: (f, o) => !!o.replying },
    ],

    // The stage chip: the hall's countdown from its Stagewatch, in the full view's header (`live`: the time is Stagewatch's
    // now; `words`: what the chip says of the link). Its acts are the backstage team's.
    chip: [
      // Speaker's screen…: the line box, empty, with Ask the operator and Send now as the seat may (as msg.speaker's).
      { id: 'chip.speaker', label: 'Speaker\'s screen…', icon: '📝', group: '2_send', verb: 'stage:propose', mode: 'now',
        may: (f) => backstage(f) && (f.canPropose || f.canSendToStage), fits: (f) => full(f), ready: (f) => f.stageWhy || true },
      // The countdown on the ticked screens (all of them until Screens says otherwise), while the link is up.
      { id: 'chip.screens', label: 'Show the countdown on screens', icon: '⧉', group: '2_send', verb: 'display:take', mode: 'now',
        may: (f) => f.canScreens, fits: (f) => full(f), ready: (f) => f.stageWhy || (f.screens > 0 || WORDS.noScreens) },
    ],

    // The code chip: the room's guest code (`code`), for a seat that may know it.
    code: [
      { id: 'code.code', label: 'Copy guest code', icon: '🔢', group: '3_keep', verb: 'local', mode: 'local',
        may: (f, o) => f.mayKnowCode && typeof o.code === 'string' && o.code.length > 0, fits: () => true },
      { id: 'code.copy', label: 'Copy join link', icon: '🔗', group: '3_keep', verb: 'local', mode: 'local',
        may: (f, o) => f.mayKnowCode && typeof o.code === 'string' && o.code.length > 0, fits: () => true },
    ],

    // ------------------------------------------------------------ the admin page (adminFacts)
    // A hall in the admin page's list, and the hall it watches (its header): `code`, `name`, `watched`. Every act here is
    // the admin page's: whom it admits (`admin`), which every admin:* verb checks again.
    adminRoom: [
      { id: 'adminRoom.watch', label: 'Watch', icon: '👀', key: 'Enter', group: '3_keep', inline: () => 1, verb: 'admin:watchRoom', mode: 'now',
        may: (f) => f.admin, fits: (f, o) => !o.watched },
      { id: 'adminRoom.transcript', label: 'Transcript', icon: '📜', group: '3_keep', verb: 'local', mode: 'local',
        may: (f) => f.admin, fits: () => true },
      { id: 'adminRoom.minutes', label: 'Minutes', icon: '✨', group: '3_keep', verb: 'admin:summary', mode: 'now',
        may: (f) => f.admin, fits: () => true, ready: (f) => f.ai || WORDS.noAi },
      { id: 'adminRoom.invites', label: 'Roles & invites', icon: '🔒', group: '4_manage', verb: 'admin:invites', mode: 'now',
        may: (f) => f.admin, fits: () => true },
      { id: 'adminRoom.clear', label: 'Clear messages…', icon: '🧹', group: '9_danger', verb: 'admin:resetRoom', mode: 'now',
        may: (f) => f.admin, fits: () => true,
        confirm: (f, o) => ({ title: 'Clear every message in ' + hallOf(o) + '?', words: 'Files used nowhere else go too. Everyone stays in the hall. This cannot be undone.', yes: 'Clear messages', no: 'Keep them', danger: true }) },
      { id: 'adminRoom.remove', label: 'Close hall…', icon: '🗑', group: '9_danger', verb: 'admin:deleteRoom', mode: 'now',
        may: (f) => f.admin, fits: () => true,
        confirm: (f, o) => ({ title: 'Close hall ' + hallOf(o) + '?', words: 'Everyone in it is sent out and its saved history is deleted. Open its transcript first if you need it.',
          fields: [{ name: 'purge', type: 'checkbox', label: 'Also delete the files shared only in this hall', value: true }], yes: 'Close and delete', no: 'Keep it open', danger: true }) },
    ],
    // A person: on the hall page, a row of its People panel and a message's sender (`uid`, `name`, `role`); on the admin
    // page, a person in the watched hall (`socketId`, `name`, `role`, `account`: signs in with an account, so its seat
    // follows its rights, `linkedRooms`, `hall`: its name). Each page draws its own half: the hall page's acts are a
    // seat's in its room, the admin page's the admin's, run on its own socket.
    person: [
      // @ Mention puts the person's name in this page's composer, to be sent with what follows it.
      { id: 'person.mention', label: 'Mention', icon: '@', group: '1_respond', verb: 'local', mode: 'local',
        may: (f) => f.post, fits: (f, o) => onHall(f) && full(f) && typeof o.name === 'string' && o.name.length > 0 && o.uid !== f.uid },
      { id: 'person.seat', label: 'Seat', icon: '💺', group: '4_manage', verb: 'admin:setRole', mode: 'now',
        may: (f) => f.admin, fits: (f, o) => onAdmin(f) && !o.account,
        submenu: (f, o) => SEATS.map(([value, label]) => ({ value, label, role: 'menuitemradio', checked: seatOf(o.role) === value })) },
      // Let them forward into ▸ ticks a hall (admin:linkRoom); a hall unticked there, or a chip's ×, is No longer forward
      // into ▸ (admin:unlinkRoom), an act of its own: one verb for one act, each refused by the server alike. `linkedNames`
      // names the halls by code, as the page knows them.
      { id: 'person.forward', label: 'Let them forward into', icon: '➦', group: '4_manage', verb: 'admin:linkRoom', mode: 'now',
        may: (f) => f.admin, fits: (f) => onAdmin(f), submenu: () => null },
      { id: 'person.unforward', label: 'No longer forward into', icon: '🚫', group: '4_manage', verb: 'admin:unlinkRoom', mode: 'now',
        may: (f) => f.admin, fits: (f, o) => onAdmin(f) && Array.isArray(o.linkedRooms) && o.linkedRooms.length > 0,
        submenu: (f, o) => o.linkedRooms.map((code) => ({ value: code, label: (o.linkedNames && o.linkedNames[code]) || code })) },
      { id: 'person.view', label: 'Open their view', icon: '🪟', group: '4_manage', verb: 'local', mode: 'local',
        may: (f) => f.admin, fits: (f) => onAdmin(f) },
      { id: 'person.kick', label: 'Log out…', icon: '⏏', group: '9_danger', verb: 'admin:kick', mode: 'now',
        may: (f) => f.admin, fits: (f) => onAdmin(f),
        confirm: (f, o) => ({ title: 'Log ' + o.name + ' out of ' + hallOf(o) + '?',
          words: 'Every page ' + o.name + ' has open here closes. ' + (o.account
            ? o.name + '\'s account still has ' + hallOf(o) + ' and can open it again. To keep ' + o.name + ' out, take ' + hallOf(o) + ' off the account on the Accounts page.'
            : o.name + ' can join again with the code.'),
          yes: 'Log out', no: 'Keep ' + o.name + ' in', danger: true }) },
    ],
    // A message in the admin page's live feed: `id`, `type`, `text`, `from`, `hall` (its name).
    adminMsg: [
      { id: 'adminMsg.copy', label: 'Copy text', icon: '📋', group: '3_keep', verb: 'local', mode: 'local',
        may: (f) => f.admin, fits: (f, o) => typeof o.text === 'string' && o.text.length > 0 },
      { id: 'adminMsg.delete', label: 'Delete for everyone…', icon: '🗑', key: 'Delete', group: '9_danger', verb: 'admin:deleteMessage', mode: 'now',
        may: (f) => f.admin, fits: () => true,
        confirm: (f, o) => ({ title: 'Delete this message for everyone in ' + hallOf(o) + '?', words: (snippet(o) ? '“' + snippet(o) + '” ' : 'It ') + 'goes from every page in the hall now. This cannot be undone.', yes: 'Delete for everyone', no: 'Keep it', danger: true }) },
    ],
    // A link to another show system: the default Stagewatch (`t: 'main'`, `changed` when its certificate changed), one
    // heard on the network (`heard`), and a Patterns or PlayMap, heard or linked (`linked`, `certificateWaits`,
    // `certificateChanged`, `desk`, `commands`). Linking one hands it a pairing token: the admin's alone.
    link: [
      { id: 'link.propose', label: 'Propose…', icon: '📨', group: '2_send', verb: 'nodes:command', mode: 'now',
        may: (f) => f.canDrive, fits: (f, o) => isNode(o) && !!o.linked && Array.isArray(o.commands) && o.commands.length > 0,
        ready: (f, o) => o.desk || o.name + '\'s lines go to the show desk, and its Stagewatch keeps none now — nothing can be proposed.',
        confirm: (f, o) => ({ title: 'Propose a line to ' + o.name, words: 'A person approves it at the show desk in Stagewatch, then ' + o.name + ' runs it. It lists: ' + o.commands.slice(0, 6).map((c) => c.verb).join(', ') + (o.commands.length > 6 ? ', …' : '') + '.',
          fields: [{ name: 'line', label: 'The line', value: verbStem(o.commands[0].verb), max: 400 }], yes: 'Propose', no: 'Cancel' }) },
      { id: 'link.use', label: 'Use this address', icon: '📥', group: '3_keep', inline: () => 1, verb: 'local', mode: 'local',
        may: (f) => f.admin, fits: (f, o) => o.t === 'main' && !!o.heard && !!o.url },
      { id: 'link.copy', label: 'Copy address', icon: '📋', group: '3_keep', verb: 'local', mode: 'local',
        may: (f) => f.admin, fits: (f, o) => typeof o.url === 'string' && o.url.length > 0 },
      // The default Stagewatch's address, node key and certificate: the admin page's settings, asked in one form.
      { id: 'link.configure', label: 'Set up…', icon: '⚙', group: '4_manage', verb: 'admin:settings', mode: 'now',
        may: (f) => f.admin, fits: (f, o) => o.t === 'main' && !o.heard,
        confirm: (f, o) => ({ title: 'Set up Stagewatch',
          words: 'The Stagewatch every hall without one of its own sends to. Its node key is kept sealed; the link is refused until Stagewatch accepts it.',
          fields: [
            { name: 'url', label: 'Its address (for example 10.0.4.21:9924)', value: o.url || '', max: 300 },
            { name: 'key', type: 'password', label: 'Its node key (swk_…)', hint: o.keySet ? 'Leave it empty to keep the saved one.' : '', max: 200 },
            { name: 'fingerprint', label: 'Its certificate: the first 16 or more characters of the fingerprint Stagewatch shows', value: o.fingerprint || '', hint: 'Leave it empty when Stagewatch runs on this laptop or speaks plain HTTP.', max: 100 },
          ],
          yes: 'Save', no: 'Cancel' }) },
      { id: 'link.setup', label: (f, o) => (o.linked ? 'Set up…' : 'Link…'), icon: '⚙', group: '4_manage', inline: () => 2, verb: 'nodes:link', mode: 'now',
        may: (f) => f.admin, fits: (f, o) => isNode(o),
        confirm: (f, o) => ({ title: (o.linked ? 'Set up ' : 'Link ') + o.name,
          words: 'Its pairing token is full control of it: AGMessage keeps it sealed and sends it only to this laptop, or over HTTPS to a certificate you confirm here.',
          fields: [
            { name: 'token', type: 'password', label: 'Its pairing token (' + (o.t === 'playmap' ? 'PlayMap: node settings → Network' : 'Patterns: Remote page → TRUST') + ')', hint: o.linked ? 'Leave it empty to keep the saved one.' : '', max: 200 },
            { name: 'hall', type: 'select', label: 'For', value: o.hall || '', options: hallChoices(f, o.hall) },
            { name: 'fingerprint', label: 'Its certificate: the first 16 or more characters of the fingerprint ' + o.name + ' shows on its own screen', hint: 'Leave it empty when it runs on this laptop, or its certificate is confirmed already.', max: 100 },
          ],
          yes: o.linked ? 'Save' : 'Link', no: 'Cancel' }) },
      { id: 'link.accept', label: 'Accept certificate…', icon: '🔏', group: '4_manage', inline: () => 1, verb: 'admin:acceptCertificate', mode: 'now',
        may: (f) => f.admin, fits: (f, o) => o.t === 'main' && !o.heard && !!o.changed,
        confirm: () => ({ title: 'Accept Stagewatch\'s new certificate?', words: 'Only do this if you know why it changed (a reinstall, a new certificate made on purpose). Until then the link is refused.', yes: 'Accept it', no: 'Keep refusing', danger: true }) },
      { id: 'link.confirm', label: 'Confirm fingerprint…', icon: '🔑', group: '4_manage', inline: () => 1, verb: 'nodes:acceptCertificate', mode: 'now',
        may: (f) => f.admin, fits: (f, o) => isNode(o) && !!o.linked && !!o.certificateWaits,
        confirm: (f, o) => ({ title: 'Confirm ' + o.name + '\'s certificate', words: (o.certificateChanged ? o.name + '\'s certificate changed. Only accept it if you know why (a renewal, a reinstall, a new laptop). ' : '')
          + 'Type the first 16 or more characters of the fingerprint ' + o.name + ' shows on its own screen.', fields: [{ name: 'fingerprint', label: 'Fingerprint', max: 100 }], yes: 'Confirm', no: 'Cancel' }) },
      { id: 'link.unlink', label: 'Unlink…', icon: '⛓', group: '9_danger', verb: 'nodes:unlink', mode: 'now',
        may: (f) => f.admin, fits: (f, o) => isNode(o) && !!o.linked,
        confirm: (f, o) => ({ title: 'Unlink ' + o.name + '?', words: 'Its token and its certificate pin are forgotten: linking it again takes its token again.', yes: 'Unlink', no: 'Keep it linked', danger: true }) },
    ],
    // The internet link (the admin page's tunnel card): `running`, `url`, `checking`, `checkedAgo` (seconds since its
    // newest check, or null).
    tunnel: [
      { id: 'tunnel.check', label: 'Check again', icon: '🔄', group: '3_keep', inline: () => 1, verb: 'admin:tunnelStatus', mode: 'now',
        may: (f) => f.admin, fits: () => true, ready: (f, o) => tunnelWhy(o) || true },
      { id: 'tunnel.copy', label: 'Copy address', icon: '📋', group: '3_keep', inline: () => 2, verb: 'local', mode: 'local',
        may: (f) => f.admin, fits: (f, o) => !!o.running && typeof o.url === 'string' && o.url.length > 0 },
      { id: 'tunnel.on', label: 'Turn on', icon: '🌐', group: '4_manage', verb: 'admin:tunnelStart', mode: 'now',
        may: (f) => f.admin, fits: (f, o) => !o.running },
      { id: 'tunnel.off', label: 'Turn off…', icon: '⏹', group: '9_danger', verb: 'admin:tunnelStop', mode: 'now',
        may: (f) => f.admin, fits: (f, o) => !!o.running,
        confirm: () => ({ title: 'Turn the internet link off?', words: 'Every phone and laptop joined through it is cut off now, and its address stops working. A new one is given when it is turned on again.', yes: 'Turn it off', no: 'Keep it on', danger: true }) },
    ],
    // "This laptop" (the admin page's panel): `addresses` (each LAN address as devices open it, http://address:port) and
    // `reading` (Windows is being read now). Refresh reads Windows again; Copy LAN address offers each address.
    laptop: [
      { id: 'laptop.refresh', label: 'Refresh', icon: '⟳', group: '3_keep', inline: () => 1, verb: 'admin:laptop', mode: 'now',
        may: (f) => f.admin, fits: () => true, ready: (f, o) => (o.reading ? 'Reading Windows\' facts now…' : true) },
      { id: 'laptop.copy', label: 'Copy LAN address', icon: '📋', group: '3_keep', inline: () => 2, verb: 'local', mode: 'local',
        may: (f) => f.admin, fits: (f, o) => Array.isArray(o.addresses) && o.addresses.length > 0,
        submenu: (f, o) => o.addresses.map((a) => ({ value: a, label: a })) },
    ],

    // ------------------------------------------------------------ the halls board (boardFacts)
    // A hall's row: `code`, `name`. Its name is the row's one link, which opens it.
    hall: [
      { id: 'hall.open', label: 'Open', icon: '🚪', key: 'Enter', group: '3_keep', verb: 'local', mode: 'local', may: () => true, fits: () => true },
      { id: 'hall.tab', label: 'Open in a new tab', icon: '🗗', group: '3_keep', verb: 'local', mode: 'local', may: () => true, fits: () => true },
      { id: 'hall.copy', label: 'Copy link', icon: '🔗', group: '3_keep', verb: 'local', mode: 'local', may: () => true, fits: () => true },
      { id: 'hall.code', label: 'Copy guest code', icon: '🔢', group: '3_keep', verb: 'local', mode: 'local',
        may: (f, o) => typeof o.code === 'string' && o.code.length > 0, fits: () => true },
      { id: 'hall.setup', label: 'Set up…', icon: '⚙', group: '4_manage', verb: 'hall:settings', mode: 'now', may: (f) => f.manageHalls, fits: () => true },
      { id: 'hall.network', label: 'Show network…', icon: '📡', group: '4_manage', verb: 'nodes:list', mode: 'now', may: (f) => f.canDrive, fits: () => true },
    ],
    // An open help request on the board: `code`, `id`, `state`, `canRespond` (the board's fact: the server's own rule).
    help: [
      { id: 'help.respond', label: 'On my way', icon: '▷', group: '1_respond', inline: () => 1, verb: 'help:respond', mode: 'hold',
        may: (f, o) => !!o.canRespond, fits: (f, o) => o.state === 'open' },
      { id: 'help.resolve', label: 'Resolved', icon: '🏁', group: '1_respond', inline: () => 2, verb: 'help:respond', mode: 'hold',
        may: (f, o) => !!o.canRespond, fits: (f, o) => o.state !== 'resolved' },
      { id: 'help.open', label: 'Open its hall', icon: '🚪', key: 'Enter', group: '3_keep', verb: 'local', mode: 'local', may: () => true, fits: () => true },
    ],

    // ------------------------------------------------------------ the Accounts page (accountFacts)
    // A person's account: `id`, `name`, `disabled`, `locked` (why this viewer may not change it, or ''), `self`.
    account: [
      { id: 'account.edit', label: 'Edit…', icon: '🖊', key: 'Enter', group: '4_manage', inline: () => 1, verb: 'http:PATCH /api/users/:id', mode: 'now',
        may: (f) => f.manageUsers, fits: () => true, ready: (f, o) => o.locked || true },
      { id: 'account.password', label: 'New one-time password…', icon: '🔐', group: '4_manage', verb: 'http:POST /api/users/:id/password', mode: 'now',
        may: (f, o) => f.manageUsers && !o.locked, fits: () => true,
        confirm: (f, o) => ({ title: 'Give ' + o.name + ' a new one-time password?', words: o.name + ' is signed out everywhere and the old password stops working. The new one is shown once, here.', yes: 'New password', no: 'Cancel' }) },
      { id: 'account.signout', label: 'Sign out everywhere…', icon: '📴', group: '4_manage', verb: 'http:POST /api/users/:id/signout', mode: 'now',
        may: (f, o) => f.manageUsers && !o.locked, fits: () => true,
        confirm: (f, o) => ({ title: 'Sign ' + o.name + ' out everywhere?', words: 'Every page ' + o.name + ' has open closes, on every device. ' + o.name + ' can sign in again with their password.', yes: 'Sign out', no: 'Cancel' }) },
      { id: 'account.disable', label: (f, o) => (o.disabled ? 'Turn on' : 'Turn off…'), icon: '⏻', group: '9_danger', verb: 'http:PATCH /api/users/:id', mode: 'now',
        may: (f, o) => f.manageUsers && !o.locked, fits: (f, o) => !o.self,
        confirm: (f, o) => (o.disabled ? null : { title: 'Turn ' + o.name + '\'s account off?', words: o.name + ' is signed out everywhere and cannot sign in until it is turned on again. Their messages stay.', yes: 'Turn off', no: 'Keep it on', danger: true }) },
      { id: 'account.remove', label: 'Remove…', icon: '🗑', group: '9_danger', verb: 'http:DELETE /api/users/:id', mode: 'now',
        may: (f, o) => f.manageUsers && !o.locked, fits: (f, o) => !o.self,
        confirm: (f, o) => ({ title: 'Remove ' + o.name + '\'s account?', words: 'Their messages stay; they can no longer sign in. This cannot be undone.', yes: 'Remove', no: 'Keep it', danger: true }) },
    ],
    // An entry of the audit log: `seq`, `action`, `actor` {t, id, name}, `target`, `mark` (no actor: a line that is not a
    // whole entry). The rows hold no secret, by rule.
    audit: [
      { id: 'audit.copy', label: 'Copy this row', icon: '📋', group: '3_keep', verb: 'local', mode: 'local', may: (f) => f.auditRead, fits: () => true },
      { id: 'audit.actor', label: 'Only this actor', icon: '👤', group: '3_keep', verb: 'local', mode: 'local',
        may: (f) => f.auditRead, fits: (f, o) => !!o.actor && !(f.filter && f.filter.by === 'actor' && f.filter.value === actorKey(o)) },
      { id: 'audit.target', label: 'Only this target', icon: '🎯', group: '3_keep', verb: 'local', mode: 'local',
        may: (f) => f.auditRead, fits: (f, o) => typeof o.target === 'string' && o.target.length > 0 && !(f.filter && f.filter.by === 'target' && f.filter.value === o.target) },
      { id: 'audit.all', label: 'Show all', icon: '☰', group: '3_keep', verb: 'local', mode: 'local', may: (f) => f.auditRead, fits: (f) => !!f.filter },
      { id: 'audit.check', label: 'Check the log', icon: '🔍', group: '4_manage', verb: 'http:GET /api/audit/verify', mode: 'now', may: (f) => f.auditRead, fits: () => true },
      { id: 'audit.export', label: 'Export the log…', icon: '📤', group: '4_manage', verb: 'http:POST /api/audit/export', mode: 'now', may: (f) => f.auditExport, fits: () => true },
      { id: 'audit.split', label: 'Split the log here…', icon: '✂', group: '4_manage', verb: 'http:POST /api/audit/split', mode: 'now',
        may: (f) => f.theAdmin, fits: (f, o) => o.action === 'audit.archive' && Number.isSafeInteger(o.seq),
        confirm: (f, o) => ({ title: 'Split the audit log at entry ' + o.seq + '?', words: 'The entries before it move, whole files, into a signed archive in this laptop\'s data folder. Nothing is deleted: the check then starts at entry ' + o.seq + ' and names the archive, and every export still carries it.',
          fields: [{ name: 'word', label: 'Type the word split to split there', max: 10 }], yes: 'Split', no: 'Cancel' }) },
    ],
  };
  for (const kind of Object.keys(KINDS)) {
    for (const e of KINDS[kind]) Object.freeze(e);
    Object.freeze(KINDS[kind]);
  }
  Object.freeze(KINDS);

  /** A message's words as a confirm names them: its first 60 characters, cut on a whole character. */
  function snippet(o) {
    const text = String(o.text || o.filename || o.category || '');
    const chars = Array.from(text);
    return chars.length > 60 ? chars.slice(0, 59).join('') + '…' : text;
  }

  /**
   * Why a hall's Stagewatch takes nothing now, in words, or '' when it does: a send and a proposal both need the link
   * connected (lib/nodes.js), so any other state disables them with the words that say what to do.
   */
  function stageWhy(v) {
    if (v && v.cert) return WORDS.linkCert;
    if (v && v.key === 'refused') return WORDS.linkRefused;
    if (v && v.status === 'connected' && !v.stale) return '';
    if (v && v.status === 'checking key') return WORDS.linkKey;
    return WORDS.linkDown;
  }

  /** A list of message ids, as the page gives it: strings only, in its order. */
  const idList = (v) => Object.freeze(Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.length > 0) : []);

  /**
   * The page's facts, from what the server told it: the join's answer (its seat, its view, its account, upload token,
   * Stagewatch rights and link, AI, `forwardable`, and the support view's own name), the screens it may drive
   * (display:list's answer, or null), whether it is connected and joined now, and, in the simple view, the messages that
   * wait for this person's answer (`waiting`: `plain` oldest first, and `priority`). `page` is 'hall', the page these
   * facts are drawn on. Pure: the same answers give the same facts on the page and in the tests, which read real answers.
   */
  function facts(s) {
    const role = s.role === 'board' || s.role === 'director' ? 'board' : s.role === 'research' ? 'research' : 'observer';
    const post = role !== 'observer';
    const screens = s.screens && typeof s.screens === 'object' ? s.screens : null;
    const waiting = s.waiting && typeof s.waiting === 'object' ? s.waiting : {};
    return Object.freeze({
      page: 'hall', role, view: s.view === 'simple' ? 'simple' : 'full', uid: typeof s.uid === 'string' ? s.uid : '', post,
      viewer: !!(s.account && s.account.role === 'viewer'),
      pin: post,                              // the room's pin: a seat that posts
      ask: post && role !== 'board',          // a question for the Board comes from backstage
      respondHelp: post && role !== 'board',  // others' help requests are answered by the backstage team
      waiting: Object.freeze({ plain: idList(waiting.plain), priority: idList(waiting.priority) }),
      files: typeof s.uploadToken === 'string' && s.uploadToken.length > 0,
      canSendToStage: !!s.canSendToStage, canPropose: !!s.canPropose, stageWhy: stageWhy(s.stage),
      ai: !!s.ai,
      canScreens: !!screens, screensManage: !!(screens && screens.manage), screens: screens && Array.isArray(screens.displays) ? screens.displays.length : 0,
      forwardable: !!s.forwardable,
      mayKnowCode: post,                      // the room's guest code: a seat that posts (an observer's page shows none)
      connected: !!s.connected,
      support: s.adminView ? String(s.name || 'this person') : '',
    });
  }

  /**
   * The admin page's facts (/api/admin/me's answer): whom its gate admits (`ok`: the laptop's token, or an account that
   * may manage settings), "the admin" (`admin`: the token, or an account whose role is admin), whether AI drafts are on,
   * the halls a node may be linked for, and whether the page is connected now. Pure.
   */
  function adminFacts(s) {
    const halls = Array.isArray(s.halls) ? s.halls.filter((h) => h && typeof h.code === 'string').map((h) => Object.freeze({ code: h.code, name: typeof h.name === 'string' ? h.name : '' })) : [];
    // The socket the gate admits is the server's admin (isAdmin), whom mayDriveNode lets drive every node: `canDrive`.
    return Object.freeze({ page: 'admin', admin: !!s.ok, theAdmin: !!s.admin, canDrive: !!s.ok, ai: !!s.ai, halls: Object.freeze(halls), connected: !!s.connected, support: '' });
  }
  /** The halls board's facts (/api/halls's answer and the board's): who may set halls up and drive the show network. Pure. */
  function boardFacts(s) {
    return Object.freeze({ page: 'halls', manageHalls: !!s.canManageHalls, canDrive: !!s.canDrive, connected: !!s.connected, support: '' });
  }
  /**
   * The Accounts page's facts (/api/auth/me's account and /api/admin/me's `admin`): its rights, read by the server's
   * names, and the audit list's filter (`{by: 'actor' | 'target', value}` or null), the page's own view of the list. The
   * page has no socket: an act goes over HTTP when it is made, so it is never refused for a connection. Pure.
   */
  function accountFacts(s) {
    const caps = s.account && s.account.rights && Array.isArray(s.account.rights.caps) ? s.account.rights.caps : [];
    const filter = s.filter && (s.filter.by === 'actor' || s.filter.by === 'target') && typeof s.filter.value === 'string' ? Object.freeze({ by: s.filter.by, value: s.filter.value }) : null;
    return Object.freeze({
      page: 'accounts', uid: s.account && typeof s.account.id === 'string' ? s.account.id : '',
      manageUsers: caps.includes('users.manage'), auditRead: caps.includes('audit.read'),
      auditExport: caps.includes('audit.read') && caps.includes('audit.export'), theAdmin: !!s.admin,
      filter, connected: true, support: '',
    });
  }

  const call = (v, f, o) => (typeof v === 'function' ? v(f, o) : v);
  const kindOf = (kind) => { if (!has(KINDS, kind)) throw new Error('No catalogue kind ' + kind); return KINDS[kind]; };
  const entry = (kind, id) => kindOf(kind).find((e) => e.id === id) || null;
  /** What is an object of a kind at all: a system line (who came and went, what a send did) is no message to act on. */
  const isObject = (kind, o) => !!o && typeof o === 'object' && !(kind === 'msg' && o.type === 'system');
  /** The entries of a kind this seat may do with this object, here: may and fits, in catalogue order. */
  const shown = (kind, f, o) => (isObject(kind, o) ? kindOf(kind).filter((e) => e.may(f, o) && e.fits(f, o)) : []);

  /**
   * Whether an act runs now: true, or the words that say why not. The support view acts on nothing (R8); while the page
   * is not connected an act on something (`now`) is refused at once and says so, while a send held by the outbox
   * (`hold`) and an act on the page itself (`self`, `local`) go on (R2); then the act's own state.
   */
  function ready(kind, id, f, o) {
    const e = entry(kind, id);
    if (!e) return WORDS.gone;
    if (f.support) return supportWords(f.support);
    if (e.mode === 'now' && !f.connected) return WORDS.offline;
    return e.ready ? e.ready(f, o) : true;
  }

  /** One drawn item for an entry: its words and state as they are now. */
  function itemOf(kind, e, f, o, inFold) {
    const r = ready(kind, e.id, f, o);
    const item = {
      id: e.id, label: call(inFold && e.short ? e.short : e.label, f, o), icon: e.icon || '', key: e.key || '', group: e.group,
      disabled: r === true ? '' : r, held: r === true && e.mode === 'hold' && !f.connected && !f.support ? WORDS.held : '',
      submenu: typeof e.submenu === 'function', asks: !!(e.confirm && e.confirm(f, o)),
    };
    if (e.checked) { item.role = 'menuitemcheckbox'; item.checked = !!e.checked(f, o); }
    return item;
  }

  /**
   * What a menu draws for the object: the shown entries in order, a fold of two or more as one item whose `children` are
   * its entries' items, and `sep` between groups. Right-click, ⋯ and Shift+F10 open exactly this. The simple view has no
   * menu door: nothing.
   */
  function items(kind, f, o) {
    if (!full(f)) return [];
    const list = shown(kind, f, o);
    const out = [];
    let group = null;
    const folded = new Set();
    for (const e of list) {
      if (folded.has(e.id)) continue;
      if (group !== null && e.group !== group) out.push({ sep: true });
      group = e.group;
      const mates = e.fold ? list.filter((x) => x.fold === e.fold) : [e];
      if (mates.length < 2) { out.push(itemOf(kind, e, f, o, false)); continue; }
      for (const m of mates) folded.add(m.id);
      const fold = FOLDS[e.fold];
      out.push({ id: '', fold: e.fold, label: fold.label, icon: fold.icon, key: e.key || '', group: e.group, disabled: '', held: '', submenu: true, children: mates.map((m) => itemOf(kind, m, f, o, true)) });
    }
    return out;
  }

  /** The ids a menu holds, a fold's entries in its place: what every door of the object must show alike. */
  const ids = (kind, f, o) => items(kind, f, o).filter((i) => !i.sep).flatMap((i) => (i.children ? i.children.map((c) => c.id) : [i.id]));

  /** The object's own bar: the two shown entries of lowest inline rank, in rank order, each with its full label. */
  function inline(kind, f, o) {
    return shown(kind, f, o)
      .map((e) => ({ e, rank: e.inline ? e.inline(f, o) : false }))
      .filter((x) => typeof x.rank === 'number')
      .sort((a, b) => a.rank - b.rank)
      .slice(0, 2)
      .map((x) => itemOf(kind, x.e, f, o, false));
  }

  /** The values an entry offers one level down (its reactions, its answers), or null where its runner finds them. */
  function submenu(kind, id, f, o) {
    const e = entry(kind, id);
    const list = e && typeof e.submenu === 'function' ? e.submenu(f, o) : null;
    return Array.isArray(list) ? list : null;
  }

  /** The shown entry a single key runs on the focused object, or null. Backspace is a Mac's delete key. */
  function byKey(kind, f, o, key) {
    const k = key === 'Backspace' ? 'Delete' : key.length === 1 ? key.toUpperCase() : key;
    return shown(kind, f, o).find((e) => e.key === k) || null;
  }

  const catalog = Object.freeze({ GROUPS, REACTIONS, WORDS, FOLDS, KINDS, supportWords, stageWhy, facts, adminFacts, boardFacts, accountFacts, actorKey, entry, shown, ready, items, ids, inline, submenu, byKey });
  Object.assign(root.AGM = root.AGM || {}, { catalog });
})(typeof window !== 'undefined' ? window : globalThis);
