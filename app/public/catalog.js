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
  const newestPlain = (f) => (f.waiting.plain.length ? f.waiting.plain[f.waiting.plain.length - 1] : '');
  /**
   * The simple view's one response place for a message: each waiting 🔥 message, and the newest waiting plain one (the
   * page says which wait: a message from backstage waits for this person until their 👍, a reply to it, or an answer).
   */
  const respondsHere = (f, o) => f.waiting.priority.includes(o.id) || (!o.priority && newestPlain(f) === o.id);

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
      { id: 'msg.draft', label: 'Draft a reply', icon: '✨', group: '1_respond', verb: 'ai:draft', mode: 'now',
        may: (f) => backstage(f) && f.ai, fits: (f, o) => full(f) && !!o.from && o.from.role === 'board' && said(o) },
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
   * wait for this person's answer (`waiting`: `plain` oldest first, and `priority`). Pure: the same answers give the
   * same facts on the page and in the tests, which read real answers.
   */
  function facts(s) {
    const role = s.role === 'board' || s.role === 'director' ? 'board' : s.role === 'research' ? 'research' : 'observer';
    const post = role !== 'observer';
    const screens = s.screens && typeof s.screens === 'object' ? s.screens : null;
    const waiting = s.waiting && typeof s.waiting === 'object' ? s.waiting : {};
    return Object.freeze({
      role, view: s.view === 'simple' ? 'simple' : 'full', uid: typeof s.uid === 'string' ? s.uid : '', post,
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
      connected: !!s.connected,
      support: s.adminView ? String(s.name || 'this person') : '',
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
    return {
      id: e.id, label: call(inFold && e.short ? e.short : e.label, f, o), icon: e.icon || '', key: e.key || '', group: e.group,
      disabled: r === true ? '' : r, held: r === true && e.mode === 'hold' && !f.connected && !f.support ? WORDS.held : '',
      submenu: typeof e.submenu === 'function', asks: !!e.confirm,
    };
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

  const catalog = Object.freeze({ GROUPS, REACTIONS, WORDS, FOLDS, KINDS, supportWords, stageWhy, facts, entry, shown, ready, items, ids, inline, submenu, byKey });
  Object.assign(root.AGM = root.AGM || {}, { catalog });
})(typeof window !== 'undefined' ? window : globalThis);
