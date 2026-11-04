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
// page's people rows; `adminRoom`: the admin page's list of halls and rooms, and the rooms of a hall's Set up on the halls
// board; `room`: the hall page's switcher, and the halls board's room buttons and Your rooms, its Set up… the board's alone,
// by its facts and the room's hall key) fits each page's rows only on that page (`page`, a fact of each page's facts, or
// what only that page's facts and objects carry), so a page never draws a row whose runner is another page's, and no row
// is hidden by a right the server would not refuse.
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
  /**
   * Who sets a hall's rooms up where a room is drawn: on the admin page, whom its gate admits (`admin`, which passes
   * room:create's and room:update's own check); on the halls board, an account that sets halls up (`manageHalls`).
   */
  const setsUp = (f) => (onAdmin(f) ? f.admin : !!f.manageHalls);
  const newestPlain = (f) => (f.waiting.plain.length ? f.waiting.plain[f.waiting.plain.length - 1] : '');
  /**
   * The simple view's one response place for a message: each waiting 🔥 message, and the newest waiting plain one (the
   * page says which wait: a message from backstage waits for this person until their 👍, a reply to it, or an answer).
   */
  const respondsHere = (f, o) => f.waiting.priority.includes(o.id) || (!o.priority && newestPlain(f) === o.id);
  /** A hall as an ask names it: its name, else its code; a side room by its hall's name and its own ("Hall 2 › Legal"). */
  const hallOf = (o) => String(o.hall || o.name || o.code || 'this hall');
  /** A room of the admin's list that is a hall (its Main room): every room is, but a side room (`main: false`). */
  const isHall = (o) => o.main !== false;
  /** A hall's row with side rooms this watcher may enter. */
  const hasRooms = (o) => Array.isArray(o.rooms) && o.rooms.length > 0;
  /** The seats the admin moves a code guest between, in the words every page uses (the value is the server's): a hall's
   *  Main room's, and a side room's, which has no stage and whose backstage seat is a Member's. */
  const SEATS = Object.freeze([['board', 'On stage'], ['research', 'Backstage'], ['observer', 'Observer']]);
  const SEATS_SIDE = Object.freeze([['research', 'Member'], ['observer', 'Observer']]);
  const seatOf = (role) => (role === 'director' ? 'board' : role);
  /**
   * The ask before a room's guest code is switched off (the design's three-way choice): the guest pages in with it stay
   * (a guest whose connection drops comes back within a few seconds, and nobody new joins with it), or are sent out with
   * their seats; accounts stay either way. `o.guests`, the guest pages in now, where the page knows it.
   */
  const codeOffAsk = (o) => ({
    title: 'Turn off the guest code of ' + hallOf(o) + '?',
    words: [
      ...(Number.isInteger(o.guests) ? [o.guests === 1 ? '1 guest page is in with the code.' : o.guests + ' guest pages are in with the code.'] : []),
      'Turn off: nobody new joins with it, and a guest already in comes back within a few seconds of a dropped connection. Turn off and send them out: every guest page closes, and its seat goes. Accounts stay either way.',
    ],
    choices: [{ answer: 'keep', label: 'Turn off' }, { answer: 'out', label: 'Turn off and send them out', danger: true }],
    no: 'Keep it on',
  });
  /** The ask before a room's guest code is renewed: who it leaves in, who needs the new one, what stops. */
  const newCodeAsk = (o) => ({
    title: 'New guest code for ' + hallOf(o) + '?',
    words: [
      'Guests in the room now stay. Anyone joining or reconnecting after a long break needs the new code, and the invite links made with this one stop working.',
      ...(o.codeIsKey ? ['This hall\'s code is also its address: the new code separates them.'] : []),
    ],
    yes: 'Make a new code', no: 'Keep this code',
  });
  /**
   * A room a page may send into, or one a send came from or went to (`{name | roomName, hallName}`), as every page names a
   * room: a hall's Main room by its hall's name, a side room by its hall's and its own ("Hall 2 › Legal"); a send's mark
   * as the server's readers name it (lib/ops.js `placeOf`, held to this one by its test).
   */
  function placeOf(r) {
    const name = r ? String(r.name !== undefined ? r.name : r.roomName || '') : '';
    const hall = r ? String(r.hallName || '') : '';
    return !name || name === hall ? hall || name || 'another room' : (hall || 'A hall with no name') + ' › ' + name;
  }
  /**
   * How long a message was in a room ("40 s", "3 min", "1 h 5 min", "2 d 3 h"), as the server's readers say it (lib/ops.js
   * `lasted`, held to this one by its test): a withdrawn send's line, and the ask before one is withdrawn.
   */
  function lasted(ms) {
    const s = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
    if (s < 60) return s + ' s';
    if (s < 3600) return Math.floor(s / 60) + ' min';
    const and = (n, unit) => (n ? ' ' + n + ' ' + unit : '');
    if (s < 86400) return Math.floor(s / 3600) + ' h' + and(Math.floor((s % 3600) / 60), 'min');
    return Math.floor(s / 86400) + ' d' + and(Math.floor((s % 86400) / 3600), 'h');
  }
  /** This room's copy of a message it sent into another room, not withdrawn from there: Withdraw takes it back. */
  const withdrawable = (o) => !!o.sentTo && typeof o.sentTo === 'object' && !o.sentTo.withdrawn;
  /** Whether the room a message came from (its `sentFrom`) is one this page may send into now: Send back goes there. */
  const sendsBackTo = (f, o) => !!o.sentFrom && typeof o.sentFrom.ref === 'string' && f.targets.some((t) => t.ref === o.sentFrom.ref);
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
      // ↗ Send to ▸: one list of rooms, asked of the server as it opens: first those whose list lets this room send into
      // them (a copy stays here), then the other rooms this person may forward into. The runner sends by room:send to the
      // first, and by its verb, forward, to the rest; the person never chooses between two verbs. A file moves only from a
      // seat that shares files here; a question is forwarded, never sent by a list; a help request stays in its room.
      { id: 'msg.send', label: 'Send to', icon: '↗', key: 'F', group: '2_send', verb: 'forward', mode: 'hold',
        may: (f, o) => (o.type === 'action' ? f.forwardable : f.forwardable || f.sends) && (o.type !== 'file' || f.files),
        fits: (f, o) => full(f) && (o.type === 'text' || o.type === 'file' || o.type === 'action'),
        submenu: () => null },
      // ↗ Send back to Hall 2 › Legal: on a message another room sent here, while this room may send into that one; the
      // composer, set to that room for one send, answers under it.
      { id: 'msg.sendBack', label: (f, o) => 'Send back to ' + placeOf(o.sentFrom), icon: '↗', group: '2_send', verb: 'room:send', mode: 'hold',
        may: (f) => f.sends && f.post, fits: (f, o) => full(f) && sendsBackTo(f, o) },
      // The room's pin; the simple view keeps it off (its pinned place is read-only there).
      { id: 'msg.pin', label: (f, o) => (o.pinned ? 'Unpin' : 'Pin'), icon: '📌', key: 'P', group: '3_keep', verb: 'pin', mode: 'now',
        may: (f) => f.pin, fits: (f) => full(f), undo: 'msg.pin' },
      { id: 'msg.look', label: 'Look', icon: '👁', key: 'Enter', group: '3_keep', verb: 'local', mode: 'local',
        may: (f) => seesFiles(f), fits: (f, o) => o.type === 'file' },
      { id: 'msg.download', label: 'Download', icon: '⬇', key: 'D', group: '3_keep', verb: 'local', mode: 'local',
        may: (f) => backstage(f) && !f.viewer, fits: (f, o) => o.type === 'file' && typeof o.url === 'string' && o.url.length > 0 },
      { id: 'msg.copy', label: 'Copy text', icon: '📋', group: '3_keep', verb: 'local', mode: 'local',
        may: () => true, fits: (f, o) => full(f) && typeof o.text === 'string' && o.text.length > 0 },
      // ⊘ is the withdrawn line's mark, so the act has an icon of its own. Its sender or the admin takes back what this
      // room sent into another room, never On stage (where the seat acts on no other room); the ask names the room and how
      // long it has been there (`now`, the page's clock, given where the ask is made: by default, the time it is asked).
      { id: 'msg.withdraw', label: (f, o) => 'Withdraw from ' + placeOf(o.sentTo) + '…', icon: '🔙', group: '9_danger', verb: 'room:withdraw', mode: 'now',
        may: (f, o) => (mine(f, o) || f.admin) && f.role !== 'board', fits: (f, o) => full(f) && withdrawable(o),
        confirm: (f, o, now = Date.now()) => ({ title: 'Withdraw from ' + placeOf(o.sentTo) + '?', words: 'It goes from ' + placeOf(o.sentTo) + '\'s chat now; people there may have read it (it was there ' + lasted(now - o.at) + ').', yes: 'Withdraw', no: 'Keep it', danger: true }) },
      { id: 'msg.delete', label: 'Delete…', icon: '🗑', key: 'Delete', group: '9_danger', verb: 'delete', mode: 'now',
        // A message another room sent here is not its sender's to delete from this room: its sender withdraws it from the
        // room it came from, and the admin removes it here. A copy of what this room sent there goes from here alone.
        may: (f, o) => mine(f, o), fits: (f, o) => full(f) && !o.sentFrom,
        confirm: (f, o) => ({ title: 'Delete your message?', words: '“' + snippet(o) + '” goes from everyone\'s page in this room now.' + (withdrawable(o) ? ' It stays in ' + placeOf(o.sentTo) + ': withdraw it first to take it from there, which this copy alone can do.' : '') + ' This cannot be undone.', yes: 'Delete', no: 'Keep it', danger: true }) },
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
    // backstage), `room` the name of the room its next send goes to (this room's, or the one To: is set to), `file` the
    // name of the file chosen to send ('' for none), `replying` whom the next send answers ('' for nobody), `priority`
    // whether 🔥 is pressed, `to` the reference of the room To: is set to ('' for this room).
    compose: [
      // ✨ A draft of a reply, from the thread and the document on stage, into the composer: a person edits and sends it.
      // AI drafts off (no key, no internet) is the laptop's state, not a right: shown, with why.
      { id: 'compose.draft', label: 'Draft a reply', icon: '✨', group: '1_respond', verb: 'ai:draft', mode: 'now',
        may: (f) => backstage(f), fits: (f, o) => full(f) && o.form === 'text', ready: (f) => f.ai || WORDS.aiOff },
      { id: 'compose.send', label: (f, o) => (o.room ? 'Send to ' + o.room : 'Send'), icon: '➤', group: '2_send', inline: () => 1, verb: 'message', mode: 'hold',
        may: (f) => f.post, fits: () => true, ready: (f, o) => (o.form === 'file' && !o.file ? WORDS.noFile : true) },
      // To ▸: where the next message or file goes, this room or a room whose list lets this room send into it (by
      // room:send, a copy kept here). It goes back to this room after every send.
      { id: 'compose.sendTo', label: 'To', icon: '↗', group: '2_send', verb: 'room:send', mode: 'hold',
        may: (f) => f.sends && f.post, fits: (f, o) => full(f) && (o.form === 'text' || o.form === 'file'),
        submenu: (f, o) => [{ value: '', label: 'This room', role: 'menuitemradio', checked: !o.to }]
          .concat(f.targets.map((t) => ({ value: t.ref, label: placeOf(t), role: 'menuitemradio', checked: o.to === t.ref }))) },
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

    // The code chip: the room's guest code (`code`, and `on`: whether it admits guests), for a page the server tells it
    // (`mayKnowCode`); switched on or off and renewed by the admin, on a page that names the room by its key (`setsCode`).
    code: [
      { id: 'code.code', label: 'Copy guest code', icon: '🔢', group: '3_keep', verb: 'local', mode: 'local',
        may: (f, o) => f.mayKnowCode && typeof o.code === 'string' && o.code.length > 0, fits: () => true },
      { id: 'code.copy', label: 'Copy join link', icon: '🔗', group: '3_keep', verb: 'local', mode: 'local',
        may: (f, o) => f.mayKnowCode && typeof o.code === 'string' && o.code.length > 0, fits: () => true },
      { id: 'code.toggle', label: (f, o) => (o.on ? 'Turn the code off…' : 'Turn the code on'), icon: '🚦', group: '4_manage', verb: 'room:update', mode: 'now',
        may: (f) => f.setsCode, fits: () => true, confirm: (f, o) => (o.on ? codeOffAsk(o) : null) },
      { id: 'code.new', label: 'New code…', icon: '🎲', group: '4_manage', verb: 'room:update', mode: 'now',
        may: (f) => f.setsCode, fits: () => true, confirm: (f, o) => newCodeAsk(o) },
    ],

    // ------------------------------------------------------------ the admin page (adminFacts) and Set up's Rooms (boardFacts)
    // A room in the admin page's list, and the room it watches (its header): a hall (its Main room) or one of its side
    // rooms beside it (`main: false`), with `code` (its key), `name`, `hall` (as an ask names it: a side room as "Hall 2
    // › Legal"), `watched`, and its guest code: `on` (whether it admits guests), `guests` (the guest pages in now) and
    // `codeIsKey` (a hall whose code is still its address). The same room is a row of the halls board's Set up (its
    // Rooms), where the hall's own name is Set up's Name and the hall is closed on the admin page: there a hall's Main room
    // has no Rename… and no Close, and the admin page's own acts (Watch, Transcript, Minutes, Roles & invites, Clear) are
    // not drawn. On the admin page every act but Members… is whom its gate admits (`admin`), which every admin:* verb
    // checks again and which passes room:create's and room:update's own check; in Set up a room is made and renamed by
    // one who sets halls up (`setsUp`), and its code switched, renewed, the rooms that may send into it chosen (May send
    // in…) and the room removed by the admin alone (`admin`, the halls board's /api/halls `isAdmin`), on both pages and on
    // a hall's Main room as on any other. Members… (Board members… on a hall's Main room: the accounts seated On
    // stage there) is for an account that manages accounts (`manageUsers`), whose saves are the Accounts routes'. A
    // room's invite links are made with its guest code (a side room's a Member's alone), and a room is made in a hall.
    adminRoom: [
      { id: 'adminRoom.watch', label: 'Watch', icon: '👀', key: 'Enter', group: '3_keep', inline: () => 1, verb: 'admin:watchRoom', mode: 'now',
        may: (f) => f.admin, fits: (f, o) => onAdmin(f) && !o.watched },
      { id: 'adminRoom.transcript', label: 'Transcript', icon: '📜', group: '3_keep', verb: 'local', mode: 'local',
        may: (f) => f.admin, fits: (f) => onAdmin(f) },
      { id: 'adminRoom.minutes', label: 'Minutes', icon: '✨', group: '3_keep', verb: 'admin:summary', mode: 'now',
        may: (f) => f.admin, fits: (f) => onAdmin(f), ready: (f) => f.ai || WORDS.noAi },
      { id: 'adminRoom.invites', label: 'Roles & invites', icon: '🔒', group: '4_manage', verb: 'admin:invites', mode: 'now',
        may: (f) => f.admin, fits: (f) => onAdmin(f) },
      { id: 'adminRoom.create', label: 'New room in this hall…', icon: '➕', group: '4_manage', verb: 'room:create', mode: 'now',
        may: (f) => setsUp(f), fits: (f, o) => isHall(o),
        confirm: (f, o) => ({ title: 'New room in ' + hallOf(o), words: 'A room of its own beside the hall\'s Main room (Legal, Media), with its own messages and people. Its guest code is off: the admin, and the accounts given it, go in.',
          fields: [{ name: 'name', label: 'Room name (for example Legal)', max: 80 }], yes: 'Make the room', no: 'Cancel' }) },
      // Who is in a room by account: a checklist of the accounts this person may change, each saved by its own PATCH and
      // said (public/members.js); in a hall's Main room, those seated On stage there.
      { id: 'adminRoom.members', label: (f, o) => (isHall(o) ? 'Board members…' : 'Members…'), icon: '👥', group: '4_manage', verb: 'http:PATCH /api/users/:id', mode: 'now',
        may: (f) => !!f.manageUsers, fits: () => true },
      // Which rooms may send into this one, a hall's Main room as any other: every hall's rooms, grouped, each ticked with
      // "↔ and send back" beside it (public/sendfrom.js), saved in one room:update; the admin's alone.
      { id: 'adminRoom.sendFrom', label: 'May send in…', icon: '↘', group: '4_manage', verb: 'room:update', mode: 'now',
        may: (f) => f.admin, fits: () => true },
      { id: 'adminRoom.codeToggle', label: (f, o) => (o.on ? 'Turn the code off…' : 'Turn the code on'), icon: '🚦', group: '4_manage', verb: 'room:update', mode: 'now',
        may: (f) => f.admin, fits: () => true, confirm: (f, o) => (o.on ? codeOffAsk(o) : null) },
      { id: 'adminRoom.newCode', label: 'New code…', icon: '🎲', group: '4_manage', verb: 'room:update', mode: 'now',
        may: (f) => f.admin, fits: () => true, confirm: (f, o) => newCodeAsk(o) },
      { id: 'adminRoom.rename', label: 'Rename…', icon: '🏷', group: '4_manage', verb: 'room:update', mode: 'now',
        may: (f) => setsUp(f), fits: (f, o) => onAdmin(f) || !isHall(o),
        confirm: (f, o) => ({ title: 'Rename ' + hallOf(o), words: isHall(o) ? 'The hall\'s new name, on every page, screen and the halls board. Its code stays.' : 'The room\'s new name, on its pages. Its people and messages stay.',
          fields: [{ name: 'name', label: isHall(o) ? 'Hall name' : 'Room name', value: o.name || '', max: 80 }], yes: 'Rename', no: 'Cancel' }) },
      { id: 'adminRoom.clear', label: 'Clear messages…', icon: '🧹', group: '9_danger', verb: 'admin:resetRoom', mode: 'now',
        may: (f) => f.admin, fits: (f) => onAdmin(f),
        confirm: (f, o) => ({ title: 'Clear every message in ' + hallOf(o) + '?', words: 'Files used nowhere else go too. Everyone stays in the ' + (isHall(o) ? 'hall' : 'room') + '. This cannot be undone.', yes: 'Clear messages', no: 'Keep them', danger: true }) },
      { id: 'adminRoom.remove', label: (f, o) => (isHall(o) ? 'Close hall…' : 'Remove room…'), icon: '🗑', group: '9_danger', verb: 'admin:deleteRoom', mode: 'now',
        may: (f) => f.admin, fits: (f, o) => onAdmin(f) || !isHall(o),
        confirm: (f, o) => (isHall(o)
          ? { title: 'Close hall ' + hallOf(o) + '?', words: 'Everyone in it, and in each of its rooms, is sent out and its saved history is deleted. Open its transcript first if you need it.',
            fields: [{ name: 'purge', type: 'checkbox', label: 'Also delete the files shared only in this hall', value: true }], yes: 'Close and delete', no: 'Keep it open', danger: true }
          : { title: 'Remove room ' + hallOf(o) + '?', words: 'Everyone in it is sent out and its saved history is deleted; the hall and its other rooms stay. Open its transcript first if you need it.',
            fields: [{ name: 'purge', type: 'checkbox', label: 'Also delete the files shared only in this room', value: true }], yes: 'Remove and delete', no: 'Keep it', danger: true }) },
    ],
    // A person: on the hall page, a row of its People panel and a message's sender (`uid`, `name`, `role`); on the admin
    // page, a person in the watched hall (`socketId`, `name`, `role`, `account`: signs in with an account, so its seat
    // follows its rights, `linkedRooms`, `hall`: its name, `main`: false in a side room, whose seats are a Member's and an
    // observer's). Each page draws its own half: the hall page's acts are a seat's in its room, the admin page's the
    // admin's, run on its own socket.
    person: [
      // @ Mention puts the person's name in this page's composer, to be sent with what follows it.
      { id: 'person.mention', label: 'Mention', icon: '@', group: '1_respond', verb: 'local', mode: 'local',
        may: (f) => f.post, fits: (f, o) => onHall(f) && full(f) && typeof o.name === 'string' && o.name.length > 0 && o.uid !== f.uid },
      { id: 'person.seat', label: 'Seat', icon: '💺', group: '4_manage', verb: 'admin:setRole', mode: 'now',
        may: (f) => f.admin, fits: (f, o) => onAdmin(f) && !o.account,
        submenu: (f, o) => (o.main === false ? SEATS_SIDE : SEATS).map(([value, label]) => ({ value, label, role: 'menuitemradio', checked: seatOf(o.role) === value })) },
      // Let them forward into ▸ ticks a room, every other room listed by its hall (admin:linkRoom); a room unticked there,
      // or a chip's ×, is No longer forward into ▸ (admin:unlinkRoom), an act of its own: one verb for one act, each
      // refused by the server alike. `linkedNames` names the rooms by key, as the page knows them.
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
    // newest check, or null), and the end it is kept on until, in the server's words by the laptop's clock: `untilWords`
    // ("06:00 tomorrow", '' when none is kept) and `untilClock` ("06:00"), kept too while it is off after cloudflared ended.
    tunnel: [
      { id: 'tunnel.check', label: 'Check again', icon: '🔄', group: '3_keep', inline: () => 1, verb: 'admin:tunnelStatus', mode: 'now',
        may: (f) => f.admin, fits: () => true, ready: (f, o) => tunnelWhy(o) || true },
      { id: 'tunnel.copy', label: 'Copy address', icon: '📋', group: '3_keep', inline: () => 2, verb: 'local', mode: 'local',
        may: (f) => f.admin, fits: (f, o) => !!o.running && typeof o.url === 'string' && o.url.length > 0 },
      { id: 'tunnel.on', label: 'Turn on', icon: '🌐', group: '4_manage', verb: 'admin:tunnelStart', mode: 'now',
        may: (f) => f.admin, fits: (f, o) => !o.running },
      // Its end moved: the next such time by the laptop's clock, kept, so a restart before it turns the link on again.
      { id: 'tunnel.until', label: 'Tunnel until…', icon: '⏰', group: '4_manage', verb: 'admin:tunnelUntil', mode: 'now',
        may: (f) => f.admin, fits: (f, o) => !!o.running,
        confirm: (f, o) => ({ title: 'Keep the internet link on until…',
          words: [(o.untilWords ? 'It is on until ' + o.untilWords + '.' : 'It is on.') + ' At the time you give, it is turned off and stays off.',
            'If AGMessage starts again before then, the link is turned on again, with a new address to send to remote people.'],
          fields: [{ name: 'until', type: 'time', label: 'Until (this laptop\'s clock; a time already past today is tomorrow\'s)', value: o.untilClock || '' }],
          yes: 'Keep it on until then', no: 'Cancel' }) },
      // Off while an end is kept (cloudflared ended), it keeps the link off: no start before the end turns it on again.
      { id: 'tunnel.off', label: 'Turn off…', icon: '⏹', group: '9_danger', verb: 'admin:tunnelStop', mode: 'now',
        may: (f) => f.admin, fits: (f, o) => !!o.running || !!o.untilWords,
        confirm: (f, o) => (o.running
          ? { title: 'Turn the internet link off?', words: 'Every phone and laptop joined through it is cut off now, and its address stops working. A new one is given when it is turned on again.', yes: 'Turn it off', no: 'Keep it on', danger: true }
          : { title: 'Keep the internet link off?', words: 'It was to stay on until ' + o.untilWords + ', so a start of AGMessage before then would turn it on again. Kept off, it stays off until it is turned on here.', yes: 'Keep it off', no: 'Cancel', danger: true }) },
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
    // A hall's row: `code` (its key), `name`, `guestCode`: the code its guests type, as the server tells this watcher ('' to
    // one that may not know it), and `rooms`: its side rooms this watcher may enter, as the board lists them ({key, name,
    // people}). Its name is the row's one link, which opens its Main room; its side rooms are its room buttons and Rooms ▸.
    hall: [
      { id: 'hall.open', label: (f, o) => (hasRooms(o) ? 'Open Main' : 'Open'), icon: '🚪', key: 'Enter', group: '3_keep', verb: 'local', mode: 'local', may: () => true, fits: () => true },
      { id: 'hall.tab', label: 'Open in a new tab', icon: '🗗', group: '3_keep', verb: 'local', mode: 'local', may: () => true, fits: () => true },
      { id: 'hall.rooms', label: 'Rooms', icon: '🗂', group: '3_keep', verb: 'local', mode: 'local', may: () => true, fits: (f, o) => hasRooms(o),
        submenu: (f, o) => o.rooms.map((r) => ({ value: r.key, label: (r.name || 'A room') + ' · ' + r.people + ' in' })) },
      { id: 'hall.copy', label: 'Copy link', icon: '🔗', group: '3_keep', verb: 'local', mode: 'local', may: () => true, fits: () => true },
      { id: 'hall.code', label: 'Copy guest code', icon: '🔢', group: '3_keep', verb: 'local', mode: 'local',
        may: (f, o) => typeof o.guestCode === 'string' && o.guestCode.length > 0, fits: () => true },
      { id: 'hall.setup', label: 'Set up…', icon: '⚙', group: '4_manage', verb: 'hall:settings', mode: 'now', may: (f) => f.manageHalls, fits: () => true },
      { id: 'hall.network', label: 'Show network…', icon: '📡', group: '4_manage', verb: 'nodes:list', mode: 'now', may: (f) => f.canDrive, fits: () => true },
    ],
    // A room of a hall this person may enter: a segment of the hall page's switcher, a room button on the halls board's
    // hall row, a room under Your rooms. `key` (its key), `name` ('' for none), `hall` (its hall's name), `href` (its way
    // in, seated as the server would seat this person there), `current` (the room this hall page is in), `guestCode` (its
    // guest code where this page is told it, '' else: the hall page is told its own room's alone) and `hallKey` (its
    // hall's key where this page may open the hall's Set up: the halls board's rows of halls this account sees, '' else).
    // The room is its own link: a click, Enter or a middle click opens it, so it has no bar of its own. Its ways in come
    // first; its guest code and its Set up, what one hands out or sets up for the room, after them.
    room: [
      { id: 'room.open', label: 'Open', icon: '🚪', key: 'Enter', group: '3_keep', verb: 'local', mode: 'local', may: () => true, fits: (f, o) => !o.current },
      { id: 'room.tab', label: 'Open in a new tab', icon: '🗗', group: '3_keep', verb: 'local', mode: 'local', may: () => true, fits: () => true },
      { id: 'room.copy', label: 'Copy link', icon: '🔗', group: '3_keep', verb: 'local', mode: 'local', may: () => true, fits: () => true },
      { id: 'room.code', label: 'Copy guest code', icon: '🔢', group: '4_manage', verb: 'local', mode: 'local',
        may: (f, o) => typeof o.guestCode === 'string' && o.guestCode.length > 0, fits: () => true },
      { id: 'room.setup', label: 'Set up…', icon: '⚙', group: '4_manage', verb: 'hall:settings', mode: 'now', may: (f) => !!f.manageHalls, fits: (f, o) => typeof o.hallKey === 'string' && o.hallKey.length > 0 },
    ],
    // An open help request on the board: `code` (its room's key), `id`, `state`, `room` (a side room's name, '' for a
    // hall's Main room), and the board's facts, each the server's own rule: `canRespond`, and `canOpen` (whether this
    // account may open its room: the hall's crew answer a side room's request they may not read from here).
    help: [
      { id: 'help.respond', label: 'On my way', icon: '▷', group: '1_respond', inline: () => 1, verb: 'help:respond', mode: 'hold',
        may: (f, o) => !!o.canRespond, fits: (f, o) => o.state === 'open' },
      { id: 'help.resolve', label: 'Resolved', icon: '🏁', group: '1_respond', inline: () => 2, verb: 'help:respond', mode: 'hold',
        may: (f, o) => !!o.canRespond, fits: (f, o) => o.state !== 'resolved' },
      { id: 'help.open', label: (f, o) => (o.room ? 'Open its room' : 'Open its hall'), icon: '🚪', key: 'Enter', group: '3_keep', verb: 'local', mode: 'local',
        may: (f, o) => !!o.canOpen, fits: () => true },
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

  /** The rooms a page may send into, as room:sendTargets tells them, read by type: each with a reference. */
  const targetsOf = (v) => Object.freeze(Array.isArray(v) ? v.filter((t) => t && typeof t.ref === 'string' && t.ref.length > 0)
    .map((t) => Object.freeze({ ref: t.ref, name: typeof t.name === 'string' ? t.name : '', hallName: typeof t.hallName === 'string' ? t.hallName : '' })) : []);
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
      // Whether a message here may be sent into another room by its list (the join's `sends`), and those rooms as
      // room:sendTargets tells them: each by its reference, its name and its hall's name.
      sends: !!s.sends, targets: targetsOf(s.targets),
      // The room's guest code: the server tells it only to a page that may know it ('' else), and lets the admin switch it
      // and renew it from a page that names the room by its key.
      mayKnowCode: typeof s.guestCode === 'string' && s.guestCode.length > 0, setsCode: !!s.setsCode,
      // The admin's own page (the join's `admin`; never its support view): it withdraws any send this room made.
      admin: s.admin === true,
      connected: !!s.connected,
      support: s.adminView ? String(s.name || 'this person') : '',
    });
  }

  /**
   * The admin page's facts (/api/admin/me's answer): whom its gate admits (`ok`: the laptop's token, or an account that
   * may manage settings), "the admin" (`admin`: the token, or an account whose role is admin), whether this page's account
   * may manage accounts (`manageUsers`: a room's Members…), whether AI drafts are on, the halls a node may be linked for,
   * and whether the page is connected now. Pure.
   */
  function adminFacts(s) {
    const halls = Array.isArray(s.halls) ? s.halls.filter((h) => h && typeof h.code === 'string').map((h) => Object.freeze({ code: h.code, name: typeof h.name === 'string' ? h.name : '' })) : [];
    // The socket the gate admits is the server's admin (isAdmin), whom mayDriveNode lets drive every node: `canDrive`.
    return Object.freeze({ page: 'admin', admin: !!s.ok, theAdmin: !!s.admin, manageUsers: s.manageUsers === true, canDrive: !!s.ok, ai: !!s.ai, halls: Object.freeze(halls), connected: !!s.connected, support: '' });
  }
  /**
   * The halls board's facts (/api/halls's answer and the board's): who may set halls up, the admin (`admin`, its
   * `isAdmin`: a room's code and its removal in Set up), who may manage accounts (`manageUsers`, its `canManageUsers`: a
   * room's Members…) and who may drive the show network. Pure.
   */
  function boardFacts(s) {
    return Object.freeze({ page: 'halls', manageHalls: !!s.canManageHalls, admin: s.isAdmin === true, manageUsers: s.canManageUsers === true, canDrive: !!s.canDrive, connected: !!s.connected, support: '' });
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

  const catalog = Object.freeze({ GROUPS, REACTIONS, WORDS, FOLDS, KINDS, supportWords, stageWhy, facts, adminFacts, boardFacts, accountFacts, actorKey, entry, shown, ready, items, ids, inline, submenu, byKey, placeOf, lasted });
  Object.assign(root.AGM = root.AGM || {}, { catalog });
})(typeof window !== 'undefined' ? window : globalThis);
