'use strict';
// People's pages, end to end (plan 1-§5.2 to §5.5): a take on the Board's pages (everyone seated On stage in a hall's
// Main room, a Board account's among them) or on one person's, numbered, reaching exactly the pages it is for by their
// sockets' ids and nothing else; "sending" until each page says what it did with it (`page:report`), and ✓ only once
// every page said it showed that take; a person's Back to chat for every page of theirs, kept across a reload and a
// restart; who may push (`canPush`: the admin, an account with display.control in the hall, a code guest backstage in a
// locked Main room) and everyone else refused in words; the consoles told only that something changed (`pages:changed`,
// a Latest) and reading it again (`page:status`); a role change telling each page what it is shown now; one `page.push`
// row per push, a repeat with its client id none; nothing of a take on the halls board or in the context.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer, restartServer, stopServer, api, connect, emit, wait, until, TOKEN } = require('./helpers');

const PASSWORD = 'clipboard and coffee';
/** The `page.push` rows as the tests read them: the hall, the words, who (an account by its user name). */
const rowsOf = (dataDir) => fs.readFileSync(path.join(dataDir, 'audit.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  .filter((e) => e.action === 'page.push').map((e) => [e.target, e.words, e.actor.name]);
/** An act asked again while its socket's bucket says slow down: the answer the verb gives, not the rate's. */
async function act(s, ev, arg) {
  for (let i = 0; i < 20; i++) {
    const r = await emit(s, ev, arg);
    if (!(r && r.busy)) return r;
    await wait(300);
  }
  throw new Error(ev + ' was refused for the rate twenty times');
}
/** A frame with its times left out, so two reads of the same state compare equal. */
const timeless = (v) => JSON.parse(JSON.stringify(v, (k, x) => (k === 'at' ? undefined : x)));
/** What a page is told of a take, without the clock it is drawn by (checked for its type apart). */
const told = (t) => { const { now, tz, at, ...rest } = t; assert.ok(Number.isFinite(now) && typeof tz === 'string' && tz && Number.isFinite(at), JSON.stringify(t)); return rest; };

test('a take on the Board\'s pages or one person\'s, numbered and confirmed page by page; who may push; Back to chat for every page of theirs, kept across a reload and a restart; one row per push; nothing on the board or in the context', { timeout: 120_000 }, async (t) => {
  let srv = await startServer();
  t.after(() => stopServer(srv.child));
  const sockets = [];
  t.after(() => sockets.forEach((s) => s.close()));
  const heard = new Map();
  /** A page's socket, every event it hears kept in order. */
  const page = async (cookie, who) => {
    const s = await connect(srv.base, cookie);
    sockets.push(s);
    heard.set(s, []);
    s.onAny((ev, ...args) => heard.get(s).push([ev, args[0]]));
    s.who = who;
    return s;
  };
  const takes = (s) => heard.get(s).filter(([ev]) => ev === 'page:take').map(([, v]) => v);
  /** The number of the take a page was told last, or undefined before it was told any. */
  const lastTold = (s) => { const t = takes(s).at(-1); return t ? t.seq : undefined; };
  const signals = (s) => heard.get(s).filter(([ev]) => ev === 'pages:changed');
  const joined = async (s, args) => { const r = await emit(s, 'join', args); assert.equal(r.ok, true, s.who + ': ' + JSON.stringify(r)); return r; };

  const admin = (await api(srv.base, 'POST', '/api/setup', { token: TOKEN, username: 'ana', name: 'Ana Admin', password: 'the green room kettle' })).cookie;
  const hall = (await api(srv.base, 'POST', '/api/rooms', { name: 'Hall 2' }, { cookie: admin })).body.code;
  const ctl = await page(admin, 'the admin page');
  const LEGAL = (await act(ctl, 'room:create', { hall, name: 'Legal' })).key;
  const account = async (username, name, role, extra) => {
    const made = await api(srv.base, 'POST', '/api/users', { username, name, role, password: PASSWORD, ...extra }, { cookie: admin });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    return { id: made.body.user.id, cookie: (await api(srv.base, 'POST', '/api/auth/login', { username, password: PASSWORD })).cookie };
  };
  const tom = await account('tom', 'Tom Tech', 'tech', { halls: [hall], rooms: [LEGAL] });   // display.control: pushes
  const bea = await account('bea', 'Bea Board', 'staff', { halls: [hall], board: [hall], rooms: [LEGAL] });   // a Board account, a Member in Legal
  const sue = await account('sue', 'Sue Staff', 'staff', { halls: [hall] });   // no display.control
  const len = await account('len', 'Len Legal', 'staff', { rooms: [LEGAL] });   // Legal alone
  const vic = await account('vic', 'Vic Viewless', 'tech', { halls: [hall], revoke: ['hall.view'] });   // display.control, but no read of the hall

  // The pages: Tom on two devices (Main and Legal), Bea On stage, Sue backstage, Len in Legal; guests Gil On stage, Ria
  // backstage and Oli observing in an open hall.
  const tomMain = await page(tom.cookie, 'Tom in Main');
  const tomMainJoin = await joined(tomMain, { roomCode: hall, as: 'account' });
  const tomLegal = await page(tom.cookie, 'Tom in Legal');
  const tomLegalJoin = await joined(tomLegal, { roomCode: LEGAL, as: 'account' });
  const beaPage = await page(bea.cookie, 'Bea On stage');
  const beaJoin = await joined(beaPage, { roomCode: hall, as: 'account' });
  const suePage = await page(sue.cookie, 'Sue backstage');
  const sueJoin = await joined(suePage, { roomCode: hall, as: 'account' });
  const lenPage = await page(len.cookie, 'Len in Legal');
  await joined(lenPage, { roomCode: LEGAL, as: 'account' });
  const beaLegal = await page(bea.cookie, 'Bea in Legal');
  await joined(beaLegal, { roomCode: LEGAL, as: 'account' });
  const gil = await page(undefined, 'Gil On stage');
  const gilJoin = await joined(gil, { roomCode: hall, name: 'Gil', role: 'board' });
  const ria = await page(undefined, 'Ria backstage');
  const riaJoin = await joined(ria, { roomCode: hall, name: 'Ria', role: 'research' });
  const oli = await page(undefined, 'Oli observing');
  const oliJoin = await joined(oli, { roomCode: hall, name: 'Oli', role: 'observer' });
  assert.deepEqual([beaJoin.role, gilJoin.role, riaJoin.role, oliJoin.role], ['board', 'board', 'research', 'observer']);
  // Whether each page may push, from its join: the account with display.control in the hall, from either room; nobody
  // On stage, without the right, or a guest of an open hall. Nothing is shown on any page yet.
  assert.deepEqual([tomMainJoin, tomLegalJoin, beaJoin, sueJoin, gilJoin, riaJoin, oliJoin].map((j) => [j.canPush, j.page]),
    [[true, null], [true, null], [false, null], [false, null], [false, null], [false, null], [false, null]]);
  for (const j of [tomMainJoin, gilJoin]) assert.ok(Number.isFinite(j.now) && typeof j.tz === 'string' && j.tz, 'AGMessage\'s clock and zone: ' + JSON.stringify([j.now, j.tz]));

  // The halls board and the context as they stand, read again once takes are up and reported.
  const boardNow = async () => timeless((await act(ctl, 'board:watch', {})).board);
  const contextNow = async () => timeless((await api(srv.base, 'GET', '/api/context', undefined, { cookie: admin })).body);
  const [boardBefore, contextBefore] = [await boardNow(), await contextNow()];

  // A Board take, from the admin page: numbered, "sending" over the Board's two pages (Gil's and Bea's, an account's).
  const status = async (s = ctl) => act(s, 'page:status', { code: hall });
  const pushed = await act(ctl, 'page:push', { code: hall, to: 'board', content: { kind: 'clock' }, cid: 'push-clock-1' });
  assert.deepEqual(pushed, { ok: true, seq: 1, results: [{ key: 'board', name: 'the Board', ok: true, status: { seq: 1, showing: 'the clock', kind: 'clock', mark: '◷', words: 'Sending', pages: 2, on: 0 } }], previous: null });
  await until(() => takes(gil).length === 1 && takes(beaPage).length === 1, 4000, 'the Board\'s pages told their take');
  const clockTake = { seq: 1, content: { kind: 'clock' }, by: { name: 'Ana Admin' }, hallName: 'Hall 2', holding: '', answer: null };
  assert.deepEqual(told(takes(gil)[0]), clockTake);
  assert.deepEqual(told(takes(beaPage)[0]), clockTake);
  // The consoles of the hall (pages whose push held at their join) are told something changed, with no content.
  await until(() => signals(tomMain).length > 0 && signals(tomLegal).length > 0, 4000, 'the consoles told');
  assert.deepEqual(signals(tomMain).at(-1), ['pages:changed', {}]);
  // Asked again with its client id (an answer lost to a drop): the first push's answer, and no second take.
  assert.deepEqual(await act(ctl, 'page:push', { code: hall, to: 'board', content: { kind: 'clock' }, cid: 'push-clock-1' }), pushed);
  await wait(400);
  for (const s of [tomMain, tomLegal, suePage, lenPage, beaLegal, ria, oli]) assert.deepEqual(takes(s), [], s.who + ' hears no take for the Board');
  assert.deepEqual([takes(gil).length, takes(beaPage).length], [1, 1], 'a repeat tells nobody again');
  for (const s of [suePage, lenPage, beaLegal, gil, beaPage, ria, oli]) assert.deepEqual(signals(s), [], s.who + ' is no console');
  assert.deepEqual(rowsOf(srv.dataDir), [[hall, 'the Board (2 pages) → the clock', 'ana']], 'one row, the repeat none');

  // ✓ only once each page said it showed that take: a support view's report, a report of another take and a page out of
  // view are not.
  assert.deepEqual((await status()).board, { seq: 1, showing: 'the clock', kind: 'clock', mark: '◷', words: 'Sending', pages: 2, on: 0 });
  assert.deepEqual(await act(gil, 'page:report', { seq: 1, state: 'shown' }), { ok: true });
  assert.deepEqual((await status()).board, { seq: 1, showing: 'the clock', kind: 'clock', mark: '◷', words: 'Sending · on 1 of 2 pages', pages: 2, on: 1 });
  const beaView = await page(admin, 'the admin\'s view of Bea');
  const beaViewJoin = await joined(beaView, { roomCode: hall, name: 'Bea Board', role: 'board', adminView: true, viewOf: bea.id });
  assert.deepEqual([told(beaViewJoin.page), beaViewJoin.canPush], [clockTake, false], 'the support view is shown what Bea is shown, and pushes nothing');
  // It is told Bea's facts, read from her page here (R8), so it draws exactly her doors: On stage, nothing leaves the
  // room. No other page is told any.
  assert.deepEqual(beaViewJoin.person, { role: 'board', view: 'simple', canPush: false, sends: false, forwardable: false });
  assert.ok(!('person' in beaJoin) && !('person' in tomMainJoin), 'a page of one\'s own carries no person\'s facts');
  assert.deepEqual(await act(beaView, 'page:report', { seq: 1, state: 'shown' }), { ok: false, error: 'This is someone else\'s view: it reports nothing.' });
  for (const seq of [0, 2, '1']) assert.deepEqual(await act(beaPage, 'page:report', { seq, state: 'shown' }), { ok: false, error: 'That is not what this page is shown now.' }, JSON.stringify(seq));
  assert.deepEqual((await status()).board.words, 'Sending · on 1 of 2 pages', 'nothing of those counted');
  assert.deepEqual(await act(beaPage, 'page:report', { seq: 1, state: 'hidden' }), { ok: true });
  assert.deepEqual((await status()).board, { seq: 1, showing: 'the clock', kind: 'clock', mark: '◐', words: '1 of 2 showing · 1 asleep or in another app', pages: 2, on: 1 });
  await wait(250);
  assert.deepEqual(await act(beaPage, 'page:report', { seq: 1, state: 'shown' }), { ok: true });
  assert.deepEqual((await status()).board, { seq: 1, showing: 'the clock', kind: 'clock', mark: '✓', words: 'On all 2 Board pages', pages: 2, on: 2 });
  // The day's peaks keep how long a Board page was out of view with the take on it (reading 5).
  const health = (await api(srv.base, 'GET', '/api/health', undefined, { cookie: admin })).body;
  const today = health.peaks.find((d) => d.day === health.showDay);
  assert.ok(today.pageHiddenMs >= 200 && today.pageHiddenMs < 60_000, 'Bea\'s page out of view: ' + today.pageHiddenMs);
  // The pages lane holds the take (health names it; pages.json keeps it), and the halls board and the context hold
  // nothing of it.
  assert.ok(health.saves.stores.pages.writes >= 1, JSON.stringify(health.saves.stores.pages));
  await until(() => { try { const book = JSON.parse(fs.readFileSync(path.join(srv.dataDir, 'pages.json'), 'utf8')).halls[hall]; return book && book.board.show.seq === 1; } catch { return false; } }, 4000, 'pages.json holds the take');   // a save in flight is read again
  assert.deepEqual(await boardNow(), boardBefore, 'the halls board says nothing of a take');
  assert.deepEqual(await contextNow(), contextBefore, 'the context says nothing of a take');

  // A page that comes On stage later is shown the Board's take as it joins; the status then counts it.
  const kit = await page(undefined, 'Kit On stage');
  const kitJoin = await joined(kit, { roomCode: hall, name: 'Kit', role: 'board' });
  assert.deepEqual(told(kitJoin.page), clockTake);
  assert.deepEqual((await status()).board, { seq: 1, showing: 'the clock', kind: 'clock', mark: '◷', words: 'Sending · on 2 of 3 pages', pages: 3, on: 2 });
  // A burst of reports is at most two frames to each console (a Latest of 150 ms).
  const latest = async () => (await api(srv.base, 'GET', '/api/health', undefined, { cookie: admin })).body.latest.pages;
  await wait(400);
  const was = await latest();
  const frames = signals(tomLegal).length;
  const burst = await Promise.all([[kit, 'shown'], [gil, 'hidden'], [beaPage, 'hidden'], [kit, 'hidden'], [gil, 'shown']].map(([s, state]) => emit(s, 'page:report', { seq: 1, state })));
  assert.ok(burst.every((r) => r.ok), JSON.stringify(burst));
  await wait(500);
  const now = await latest();
  assert.ok(now.marks - was.marks >= 5 && now.flushes - was.flushes <= 2, 'five reports, at most two frames: ' + JSON.stringify([was, now]));
  assert.ok(signals(tomLegal).length - frames <= 2, 'a console told at most twice');
  for (const s of [kit, beaPage]) await act(s, 'page:report', { seq: 1, state: 'shown' });

  // A person's take: every page of Tom's in the hall (Main and Legal) and the admin's view of him are told; the Board's
  // pages are not. The answer counts the pages the pusher may read (both rooms, for the admin).
  const tomView = await page(admin, 'the admin\'s view of Tom');
  const tomViewJoin = await joined(tomView, { roomCode: hall, name: 'Tom Tech', role: 'research', adminView: true, viewOf: tom.id });
  // Tom's facts as his page in Main has them now: backstage, the full view, his console's push, no room's list to send
  // into, and a hall to send to as his page reads it.
  const tomRooms = await emit(tomMain, 'myRooms', {});
  assert.deepEqual([tomViewJoin.page, tomViewJoin.person], [null, { role: 'research', view: 'full', canPush: true, sends: false, forwardable: tomRooms.rooms.length > 0 }]);
  // A view of nobody seated here is told nobody's facts.
  const nobodyView = await page(admin, 'the admin\'s view of nobody');
  assert.deepEqual((await joined(nobodyView, { roomCode: hall, name: 'Nobody', role: 'research', adminView: true, viewOf: len.id })).person, null);
  // An account's chat view set alone reaches each of its pages and the admin's view of it, never another's view.
  const views = (s) => heard.get(s).filter(([ev]) => ev === 'view').map(([, v]) => v);
  for (const [n, view] of [[1, 'full'], [2, '']]) {
    assert.equal((await api(srv.base, 'PATCH', '/api/users/' + bea.id, { view }, { cookie: admin })).status, 200);
    await until(() => [beaView, beaPage, beaLegal].every((s) => views(s).length === n), 4000, 'Bea\'s pages and the view of her told the view ' + n);
  }
  assert.deepEqual([views(beaView), views(beaPage), views(beaLegal)], [[{ view: 'full' }, { view: 'simple' }], [{ view: 'full' }, { view: 'simple' }], [{ view: 'full' }, { view: 'full' }]], 'by seat: simple On stage, full where she is a Member');
  assert.deepEqual(views(tomView), [], 'the view of Tom is told nothing of Bea\'s');
  const toTom = await act(ctl, 'page:push', { code: hall, to: { uid: 'a:' + tom.id }, content: { kind: 'blank' }, cid: 'push-tom-1' });
  assert.deepEqual(toTom, { ok: true, seq: 2, results: [{ key: 'a:' + tom.id, name: 'Tom Tech', ok: true, status: { seq: 2, showing: 'blank', kind: 'blank', mark: '◷', words: 'Sending', pages: 2, on: 0 } }], previous: null });
  await until(() => [tomMain, tomLegal, tomView].every((s) => takes(s).length === 1), 4000, 'Tom\'s pages told');
  const blankTake = { seq: 2, content: { kind: 'blank' }, by: { name: 'Ana Admin' }, hallName: 'Hall 2', holding: '', answer: null };
  for (const s of [tomMain, tomLegal, tomView]) assert.deepEqual(told(takes(s)[0]), blankTake, s.who);
  for (const s of [gil, beaPage, kit]) assert.equal(takes(s).length, s === kit ? 0 : 1, s.who + ' is told nothing of Tom\'s take');
  // Back to chat on one page is the person's answer on every page of theirs (and the view of them), said as theirs.
  assert.deepEqual(await act(tomMain, 'page:report', { seq: 2, state: 'dismissed' }), { ok: true });
  await until(() => [tomMain, tomLegal, tomView].every((s) => takes(s).length === 2), 4000, 'Tom\'s pages told of his answer');
  for (const s of [tomMain, tomLegal, tomView]) assert.deepEqual(told(takes(s)[1]), { ...blankTake, answer: 'dismissed' }, s.who);
  const tomRow = (await status()).people.find((p) => p.uid === 'a:' + tom.id);
  assert.deepEqual([tomRow.name, tomRow.room, tomRow.seq, tomRow.mark, tomRow.pages], ['Tom Tech', 'Main', 2, '○', 2]);
  assert.match(tomRow.words, /^Tom Tech went back to chat at \d\d:\d\d$/);
  assert.deepEqual(await act(tomLegal, 'page:report', { seq: 2, state: 'shown' }), { ok: false, error: 'Back to chat was chosen for that one: a newer take shows again.' });
  // A reload keeps it: the page joins again and is told it went back to chat.
  tomMain.close();
  const tomAgain = await page(tom.cookie, 'Tom in Main, reloaded');
  assert.deepEqual(told((await joined(tomAgain, { roomCode: hall, as: 'account' })).page), { ...blankTake, answer: 'dismissed' });

  // Whom a push may name: a person seated now in a room of the hall the pusher may read. Anyone else, the Board's own
  // word given as a person, or no target, is refused; nothing is numbered.
  for (const [to, error] of [[{ uid: 'board' }, 'That person is not in this hall now.'], [{ uid: 'u:nobody' }, 'That person is not in this hall now.'], [{}, 'Show the Board (to: \'board\') or one person (to: {uid}).'], ['everyone', 'Show the Board (to: \'board\') or one person (to: {uid}).']]) {
    assert.deepEqual(await act(ctl, 'page:push', { code: hall, to, content: { kind: 'clock' } }), { ok: false, error }, JSON.stringify(to));
  }
  // What may be shown is the server's: a kind it does not know, Stagewatch where the hall has none, a picture shared in
  // no room of the hall.
  for (const [content, error] of [
    [{ kind: 'web', url: 'https://vote.example.com/' }, 'Choose what to show: back to chat, Stagewatch, the clock, holding or blank.'],
    [{ kind: 'stage' }, 'This hall has no Stagewatch linked — link one in Set up.'],
    [{ kind: 'holding', image: '/uploads/1777424589360-onmqm0a3ew2r-holding.png' }, 'That picture is in no room of this hall you can read — share it there first.'],
  ]) assert.deepEqual(await act(ctl, 'page:push', { code: hall, to: 'board', content }), { ok: false, error }, JSON.stringify(content));
  assert.deepEqual(await act(ctl, 'page:push', { code: 'NOHALL', to: 'board', content: { kind: 'clock' } }), { ok: false, error: 'No such hall.' });

  // Who may push: never On stage, the support view, an account without display.control, an observer, a guest of an open
  // hall; each refused in its words, and the console's read with it.
  for (const [s, error] of [
    [gil, 'Do that from a backstage page.'], [beaPage, 'Do that from a backstage page.'], [tomView, 'This is someone else\'s view — act from your own page.'],
    [suePage, 'Your account may not change what people\'s pages show in this hall.'], [oli, 'Showing the Board is for the backstage team.'],
    [ria, 'In an open hall, showing the Board needs an invite link or an account — ask the admin.'], [lenPage, 'Your account may not change what people\'s pages show in this hall.'],
  ]) {
    assert.deepEqual(await act(s, 'page:push', { code: hall, to: 'board', content: { kind: 'blank' } }), { ok: false, error }, s.who);
    assert.deepEqual(await act(s, 'page:status', { code: hall }), { ok: false, error }, s.who + ' reads no console');
  }
  assert.equal(rowsOf(srv.dataDir).length, 2, 'refusals write no row');
  // A key that is no hall's is refused in the words a hall the asker may not push in gets, by both verbs: a hall's key is
  // its guest code until New code, so neither says whether a code is real. Only the admin, who sees every hall, is told
  // there is none (above).
  const hall3 = (await api(srv.base, 'POST', '/api/rooms', { name: 'Hall 3' }, { cookie: admin })).body.code;
  const max = await account('max', 'Max Three', 'tech', { halls: [hall3] });   // display.control in Hall 3 alone
  const maxPage = await page(max.cookie, 'Max on the halls board');
  const gus = await page(undefined, 'Gus backstage in Hall 3');
  await joined(gus, { roomCode: hall3, name: 'Gus', role: 'research' });
  const anon = await page(undefined, 'a socket that never joins');
  for (const [s, error] of [[anon, 'Showing the Board is for the backstage team.'], [gus, 'Showing the Board is for the backstage team.'], [maxPage, 'Your account may not change what people\'s pages show in this hall.']]) {
    for (const code of [hall, 'ZZZZZZ', 'NOHALL']) {
      assert.deepEqual(await act(s, 'page:push', { code, to: 'board', content: { kind: 'clock' } }), { ok: false, error }, s.who + ' ' + code);
      assert.deepEqual(await act(s, 'page:status', { code }), { ok: false, error }, s.who + ' reads ' + code);
    }
  }
  assert.deepEqual(await act(gus, 'page:status', { code: hall3 }), { ok: false, error: 'In an open hall, showing the Board needs an invite link or an account — ask the admin.' }, 'his own hall, whose code he holds');
  assert.equal(rowsOf(srv.dataDir).length, 2, 'and no row');

  // Locked, the hall's backstage guest pushes (the seat came from an invite, or was kept by the lock), and names only
  // people seated in the room she may read: Main. Tom's take still reaches his page in Legal.
  assert.equal((await act(ctl, 'admin:lockRoles', { roomCode: hall, on: true })).ok, true);
  // Her page joined again with the seat the lock kept is a console now: its join says so, and it hears pages:changed.
  assert.equal((await joined(ria, { roomCode: hall, name: 'Ria', role: 'research', uid: riaJoin.identity })).canPush, true);
  const holding = await act(ria, 'page:push', { code: hall, to: 'board', content: { kind: 'holding' }, cid: 'ria-hold-1' });
  assert.deepEqual(holding, { ok: true, seq: 3, results: [{ key: 'board', name: 'the Board', ok: true, status: { seq: 3, showing: 'a holding slide with the AGMessage mark', kind: 'holding', mark: '◷', words: 'Sending', pages: 3, on: 0 } }], previous: { seq: 1, content: { kind: 'clock' } } });
  const riaStatus = await status(ria);
  assert.deepEqual(riaStatus.people.map((p) => p.name).sort(), ['Bea Board', 'Gil', 'Kit', 'Oli', 'Ria', 'Sue Staff', 'Tom Tech'], 'a guest\'s console lists Main\'s people alone');
  assert.deepEqual(await act(ria, 'page:push', { code: hall, to: { uid: 'a:' + len.id }, content: { kind: 'clock' } }), { ok: false, error: 'That person is not in this hall now.' }, 'Len sits in Legal, which Ria cannot read');
  const riaToTom = await act(ria, 'page:push', { code: hall, to: { uid: 'a:' + tom.id }, content: { kind: 'clock' } });
  assert.deepEqual([riaToTom.seq, riaToTom.results[0].status.pages], [4, 1], 'counted over the page Ria may read');
  await until(() => takes(tomLegal).length === 3 && takes(tomAgain).length === 1, 4000, 'Tom\'s page in Legal told too');
  assert.deepEqual(told(takes(tomLegal)[2]), { seq: 4, content: { kind: 'clock' }, by: { name: 'Ria' }, hallName: 'Hall 2', holding: '', answer: null }, 'a newer take shows again');

  // A seat moved to or from On stage: the page is told what it is shown now, before it reloads.
  const seatOf = (s) => s.id;
  assert.equal((await act(ctl, 'admin:setRole', { roomCode: hall, socketId: seatOf(oli), role: 'board' })).ok, true);
  await until(() => takes(oli).length === 1, 4000, 'Oli told the Board\'s take');
  assert.deepEqual(told(takes(oli)[0]), { seq: 3, content: { kind: 'holding' }, by: { name: 'Ria' }, hallName: 'Hall 2', holding: '', answer: null });
  assert.equal((await act(ctl, 'admin:setRole', { roomCode: hall, socketId: seatOf(kit), role: 'observer' })).ok, true);
  await until(() => takes(kit).filter((x) => x.seq === 0).length === 1, 4000, 'Kit told he is shown nothing');
  assert.deepEqual(told(takes(kit).at(-1)), { seq: 0, content: null, by: null, hallName: 'Hall 2', holding: '', answer: null });

  // One row per push, naming whom and what in a few words, never a file; the repeats none.
  assert.deepEqual(await act(ria, 'page:push', { code: hall, to: 'board', content: { kind: 'holding' }, cid: 'ria-hold-1' }), holding);
  assert.deepEqual(rowsOf(srv.dataDir), [
    [hall, 'the Board (2 pages) → the clock', 'ana'],
    [hall, 'Tom Tech → blank', 'ana'],
    [hall, 'the Board (3 pages) → a holding slide with the AGMessage mark', 'Ria'],
    [hall, 'Tom Tech → the clock', 'Ria'],
  ]);

  // The hall's holding picture set: each page shown a holding slide with no picture of its own is told the hall's, as the
  // hall's screens are, the view of Bea among them, and the consoles are told; a page shown something else hears
  // nothing. Cleared, each is told again.
  const IMAGE = '/uploads/1777424589360-onmqm0a3ew2r-holding.png';
  const counts = (list) => list.map((s) => takes(s).length);
  const holdingPages = [gil, beaPage, oli, beaView];
  const elsewhere = [tomLegal, tomAgain, tomView, kit, suePage, lenPage, beaLegal, ria];
  const elsewhereWas = counts(elsewhere);
  for (const [image, n] of [[IMAGE, 1], ['', 2]]) {
    const was = counts(holdingPages);
    const signalled = signals(tomLegal).length;
    assert.equal((await act(ctl, 'display:hallHolding', { code: hall, image })).ok, true);
    await until(() => holdingPages.every((s, i) => takes(s).length === was[i] + 1) && signals(tomLegal).length > signalled, 4000, 'the holding slides told the hall\'s picture ' + n);
    for (const s of holdingPages) assert.deepEqual(told(takes(s).at(-1)), { seq: 3, content: { kind: 'holding' }, by: { name: 'Ria' }, hallName: 'Hall 2', holding: image, answer: null }, s.who);
    assert.equal((await status()).board.showing, image ? 'a holding slide' : 'a holding slide with the AGMessage mark');
  }
  await wait(300);
  assert.deepEqual(counts(elsewhere), elsewhereWas, 'a page shown something else, or nothing, is told nothing');
  // The hall renamed: every page shown a take is told the hall's new name, which a holding slide draws; one shown
  // nothing is told nothing. Named back, again.
  const shownPages = [gil, beaPage, oli, beaView, tomLegal, tomAgain, tomView];
  const unshown = [kit, suePage, lenPage, beaLegal, ria];
  const unshownWas = counts(unshown);
  for (const name of ['Hall Two', 'Hall 2']) {
    const was = counts(shownPages);
    assert.equal((await act(ctl, 'room:update', { code: hall, name })).ok, true);
    await until(() => shownPages.every((s, i) => takes(s).length === was[i] + 1), 4000, 'every page shown a take told the hall is ' + name);
    for (const s of shownPages) assert.equal(takes(s).at(-1).hallName, name, s.who);
  }
  await wait(300);
  assert.deepEqual(counts(unshown), unshownWas, 'a page shown nothing is told nothing of a name');

  // A Board take puts away the takes of those seated On stage now: Bea's own, on her page in Legal too, which is told it
  // is shown nothing; her Board page and the view of her show the Board's.
  const toBea = await act(ctl, 'page:push', { code: hall, to: { uid: 'a:' + bea.id }, content: { kind: 'blank' } });
  assert.deepEqual([toBea.seq, toBea.results[0].status.pages], [5, 2]);
  await until(() => [beaPage, beaLegal, beaView].every((s) => lastTold(s) === 5), 4000, 'Bea\'s pages told her take');
  assert.equal((await act(ctl, 'page:push', { code: hall, to: 'board', content: { kind: 'blank' } })).seq, 6);
  await until(() => lastTold(beaLegal) === 0 && [beaPage, beaView, gil, oli].every((s) => lastTold(s) === 6), 4000, 'her take put away');
  assert.deepEqual(told(takes(beaLegal).at(-1)), { seq: 0, content: null, by: null, hallName: 'Hall 2', holding: '', answer: null });
  // The Board's people are named only to one who may read the hall's Main room: Vic may push there, and reads them
  // nameless and nobody's row.
  assert.deepEqual(await act(gil, 'page:report', { seq: 6, state: 'dismissed' }), { ok: true });
  for (const s of [beaPage, oli]) assert.deepEqual(await act(s, 'page:report', { seq: 6, state: 'shown' }), { ok: true });
  assert.equal((await status()).board.words, '2 of 3 showing · Gil went back to chat');
  const vicPage = await page(vic.cookie, 'Vic on the halls board');
  const vicStatus = await status(vicPage);
  assert.deepEqual([vicStatus.board.mark, vicStatus.board.words, vicStatus.people], ['◐', '2 of 3 showing · Someone went back to chat', []]);

  // A seat moved ends its console's signal: Ria moved to Observer hears no pages:changed until her next join. The
  // admin's views of someone are no consoles.
  assert.ok(signals(ria).length > 0, 'Ria\'s console was told');
  const riaWas = signals(ria).length;
  assert.equal((await act(ctl, 'admin:setRole', { roomCode: hall, socketId: ria.id, role: 'observer' })).ok, true);
  const legalWas = signals(tomLegal).length;
  assert.deepEqual(await act(oli, 'page:report', { seq: 6, state: 'hidden' }), { ok: true });
  await until(() => signals(tomLegal).length > legalWas, 4000, 'the consoles told');
  await wait(300);
  assert.equal(signals(ria).length, riaWas, 'Ria is no console now');
  for (const s of [beaView, tomView, nobodyView]) assert.deepEqual(signals(s), [], s.who + ' is no console');

  // A restart keeps what each page is shown and each person's answer: Back to chat stays chosen.
  assert.deepEqual(await act(tomLegal, 'page:report', { seq: 4, state: 'dismissed' }), { ok: true });
  srv = await restartServer(srv);
  const tomCookie = (await api(srv.base, 'POST', '/api/auth/login', { username: 'tom', password: PASSWORD })).cookie;
  const tomBack = await page(tomCookie, 'Tom after the restart');
  assert.deepEqual(told((await joined(tomBack, { roomCode: LEGAL, as: 'account' })).page), { seq: 4, content: { kind: 'clock' }, by: { name: 'Ria' }, hallName: 'Hall 2', holding: '', answer: 'dismissed' });
  const gilBack = await page(undefined, 'Gil after the restart');
  assert.deepEqual(told((await joined(gilBack, { roomCode: hall, name: 'Gil', role: 'board', uid: gilJoin.identity })).page), { seq: 6, content: { kind: 'blank' }, by: { name: 'Ana Admin' }, hallName: 'Hall 2', holding: '', answer: 'dismissed' });
});

// ---------------------------------------------------------------- the hall page's acts on a take (plan 1-§5.4, unit 18)
const CLOCK = path.join(__dirname, 'clock-preload.js');
test('the person\'s acts on a take: Show it again within 10 s of Back to chat brings it back on every page of theirs, and after 10 s is refused and the page told again; a card\'s Undo makes it a Minimise again; a push over a take is refused once something newer is up, and says what was shown before; a guest pushes by the code it joined with; a hall\'s screens told to every room of it, with no key', { timeout: 120_000 }, async (t) => {
  const offsetFile = path.join(fs.mkdtempSync(path.join(require('os').tmpdir(), 'agm-clock-')), 'offset');
  fs.writeFileSync(offsetFile, '0');
  const srv = await startServer({ NODE_OPTIONS: [process.env.NODE_OPTIONS, '--require "' + CLOCK.split(path.sep).join('/') + '"'].filter(Boolean).join(' '), AGM_TEST_CLOCK: offsetFile });
  t.after(() => stopServer(srv.child));
  /** The server's wall clock moved on by `ms` (test/clock-preload.js), once the server says it runs on it. */
  const clockOn = async (ms) => {
    fs.writeFileSync(offsetFile, String(ms));
    await until(() => { try { return fs.readFileSync(offsetFile + '.ack', 'utf8') === String(ms); } catch { return false; } }, 3000, 'the server on the moved clock');
  };
  const sockets = [];
  t.after(() => sockets.forEach((s) => s.close()));
  const heard = new Map();
  const page = async (cookie) => {
    const s = await connect(srv.base, cookie);
    sockets.push(s);
    heard.set(s, []);
    s.onAny((ev, ...args) => heard.get(s).push([ev, args[0]]));
    return s;
  };
  const takes = (s) => heard.get(s).filter(([ev]) => ev === 'page:take').map(([, v]) => v);
  const answerOf = (s) => { const x = takes(s).at(-1); return x ? [x.seq, x.answer] : null; };
  const joined = async (s, args) => { const r = await emit(s, 'join', args); assert.equal(r.ok, true, JSON.stringify(r)); return r; };

  const admin = (await api(srv.base, 'POST', '/api/setup', { token: TOKEN, username: 'ana', name: 'Ana Admin', password: 'the green room kettle' })).cookie;
  const hall = (await api(srv.base, 'POST', '/api/rooms', { name: 'Hall 2' }, { cookie: admin })).body.code;
  const ctl = await page(admin);
  const LEGAL = (await act(ctl, 'room:create', { hall, name: 'Legal' })).key;
  await joined(ctl, { roomCode: hall, as: 'account' });
  const inLegal = await page(admin);
  const legalJoin = await joined(inLegal, { roomCode: LEGAL, as: 'account' });

  // Gil On stage on two devices (one identity): a Board take reaches both.
  const gilA = await page();
  const gil = await joined(gilA, { roomCode: hall, name: 'Gil', role: 'board' });
  const gilB = await page();
  await joined(gilB, { roomCode: hall, name: 'Gil', role: 'board', uid: gil.identity });
  const clock = await act(ctl, 'page:push', { code: hall, to: 'board', content: { kind: 'clock' } });
  assert.deepEqual([clock.seq, clock.previous], [1, null], 'nothing was shown before it');
  await until(() => answerOf(gilA) && answerOf(gilB), 4000, 'both told the take');
  // Back to chat on one device is his answer on both; Show it again from the other, within 10 s, brings it back on both.
  assert.deepEqual(await act(gilA, 'page:report', { seq: 1, state: 'dismissed' }), { ok: true });
  await until(() => [gilA, gilB].every((s) => JSON.stringify(answerOf(s)) === '[1,"dismissed"]'), 4000, 'both told Back to chat');
  await clockOn(9_000);
  assert.deepEqual(await act(gilB, 'page:report', { seq: 1, state: 'shown', again: true }), { ok: true });
  await until(() => [gilA, gilB].every((s) => JSON.stringify(answerOf(s)) === '[1,null]'), 4000, 'both told it shows again');
  assert.equal((await act(ctl, 'page:status', { code: hall })).board.mark, '◷', 'Gil\'s other page says again what it does with it');
  // Back to chat, then a card's Undo within 10 s: a Minimise again, on both.
  assert.deepEqual(await act(gilA, 'page:report', { seq: 1, state: 'dismissed' }), { ok: true });
  await clockOn(18_000);
  assert.deepEqual(await act(gilB, 'page:report', { seq: 1, state: 'minimised' }), { ok: true });
  await until(() => [gilA, gilB].every((s) => JSON.stringify(answerOf(s)) === '[1,"minimised"]'), 4000, 'both told it is minimised');
  // After 10 s, Back to chat is final: Show it again is refused with words, and that page is told again that it went
  // back to chat (it acted at once on its own screen); a routine word of what it drew is refused and tells it nothing.
  assert.deepEqual(await act(gilA, 'page:report', { seq: 1, state: 'dismissed' }), { ok: true });
  await until(() => [gilA, gilB].every((s) => JSON.stringify(answerOf(s)) === '[1,"dismissed"]'), 4000, 'both told Back to chat again');
  await clockOn(18_000 + 10_001);
  const toldB = takes(gilB).length;
  for (const [state, again] of [['shown', true], ['minimised', false]]) {
    assert.deepEqual(await act(gilB, 'page:report', { seq: 1, state, again }), { ok: false, error: 'Back to chat was chosen for that one more than 10 s ago: a newer take shows again.' }, state);
  }
  await until(() => takes(gilB).length === toldB + 2, 4000, 'the page told again for each act refused');
  assert.deepEqual(takes(gilB).slice(-2).map((x) => [x.seq, x.answer]), [[1, 'dismissed'], [1, 'dismissed']]);
  assert.deepEqual(await act(gilB, 'page:report', { seq: 1, state: 'shown' }), { ok: false, error: 'Back to chat was chosen for that one: a newer take shows again.' });
  await wait(300);
  assert.equal(takes(gilB).length, toldB + 2, 'a routine word refused tells the page nothing');

  // A push over a take (the Board chip's ↶ Back to, `ifSeq`): refused once something newer is up, nothing numbered and no
  // row; over the take up now, it goes, and its answer gives back what was shown before.
  const rows = () => fs.readFileSync(path.join(srv.dataDir, 'audit.jsonl'), 'utf8').split('\n').filter((l) => l.includes('"page.push"')).length;
  const rowsWere = rows();
  for (const [ifSeq, error] of [[0, 'Something newer is showing there now: nothing changed.'], [2, 'Something newer is showing there now: nothing changed.'], ['1', 'That act\'s take could not be read.'], [-1, 'That act\'s take could not be read.'], [1.5, 'That act\'s take could not be read.']]) {
    assert.deepEqual(await act(ctl, 'page:push', { code: hall, to: 'board', content: { kind: 'chat' }, ifSeq }), { ok: false, error }, JSON.stringify(ifSeq));
  }
  assert.equal(rows(), rowsWere, 'refusals write no row');
  const back = await act(ctl, 'page:push', { code: hall, to: 'board', content: { kind: 'chat' }, ifSeq: 1 });
  assert.deepEqual([back.ok, back.seq, back.previous], [true, 2, { seq: 1, content: { kind: 'clock' } }]);
  assert.deepEqual((await act(ctl, 'page:push', { code: hall, to: 'board', content: { kind: 'blank' }, ifSeq: 1 })).error, 'Something newer is showing there now: nothing changed.', 'the take it went over is gone');
  // A person's: what that person was shown before, the newest of their pages.
  const toGil = await act(ctl, 'page:push', { code: hall, to: { uid: 'u:' + gil.uid }, content: { kind: 'blank' }, ifSeq: 2 });
  assert.deepEqual([toGil.ok, toGil.seq, toGil.previous], [true, 3, { seq: 2, content: { kind: 'chat' } }]);
  assert.equal(rows(), rowsWere + 2);

  // A guest backstage in the locked hall, whose page knows it by the guest code it joined with once New code parted the
  // code from the key: it pushes by that code, as by the key; a code that is no hall's is refused in the words it was.
  const ria = await page();
  const riaIn = await joined(ria, { roomCode: hall, name: 'Ria', role: 'research' });
  assert.equal((await act(ctl, 'admin:lockRoles', { roomCode: hall, on: true })).ok, true);
  const renewed = await act(ctl, 'room:update', { code: hall, newCode: true });
  assert.ok(renewed.ok && renewed.guestCode && renewed.guestCode !== hall, JSON.stringify(renewed));
  const riaTab = await page();
  assert.equal((await joined(riaTab, { roomCode: renewed.guestCode, name: 'Ria', role: 'research', uid: riaIn.identity })).canPush, true);
  const byCode = await act(riaTab, 'page:push', { code: renewed.guestCode, to: 'board', content: { kind: 'clock' }, cid: 'ria-code-1' });
  assert.deepEqual([byCode.ok, byCode.seq], [true, 4], JSON.stringify(byCode));
  assert.equal((await act(riaTab, 'page:status', { code: renewed.guestCode })).board.seq, 4);
  assert.deepEqual(await act(riaTab, 'page:push', { code: 'ZZZZZZ', to: 'board', content: { kind: 'clock' } }), { ok: false, error: 'Showing the Board is for the backstage team.' });
  // Her push asked again by that code with its client id (the outbox after a drop), after another push in the hall, is
  // answered with what the first did: one take, one row.
  assert.equal(rows(), rowsWere + 3);
  assert.equal((await act(ctl, 'page:push', { code: hall, to: 'board', content: { kind: 'blank' }, cid: 'ana-blank-1' })).seq, 5);
  assert.deepEqual(await act(riaTab, 'page:push', { code: renewed.guestCode, to: 'board', content: { kind: 'clock' }, cid: 'ria-code-1' }), byCode);
  assert.equal(rows(), rowsWere + 4, 'the repeat wrote no row');
  assert.equal((await act(ctl, 'page:status', { code: hall })).board.seq, 5, 'and put up no take');

  // What a push gives back of what was shown before is only what its pusher could show itself: a picture shared in Legal,
  // on the Board and on Gil, pushed over by Ria (a guest of Main) and by Tia (a Tech of Main alone), comes back to neither
  // (its path is the file's capability), and whole to the admin, who reads Legal.
  const f = new FormData();
  f.append('file', new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])], { type: 'image/png' }), 'legal-only.png');
  const up = await (await fetch(srv.base + '/api/upload', { method: 'POST', headers: { 'X-AGM-Upload': legalJoin.uploadToken }, body: f })).json();
  assert.ok(typeof up.url === 'string' && up.url.startsWith('/uploads/'), JSON.stringify(up));
  assert.equal((await act(inLegal, 'message', { type: 'file', url: up.url, filename: 'legal-only.png' })).ok, true);
  const picture = { kind: 'holding', image: up.url };
  const tiaMade = await api(srv.base, 'POST', '/api/users', { username: 'tia', name: 'Tia Tech', role: 'tech', password: PASSWORD, halls: [hall] }, { cookie: admin });
  assert.equal(tiaMade.status, 200, JSON.stringify(tiaMade.body));
  const tia = await page((await api(srv.base, 'POST', '/api/auth/login', { username: 'tia', password: PASSWORD })).cookie);
  assert.equal((await joined(tia, { roomCode: hall, as: 'account' })).canPush, true);
  const toGilPerson = { uid: 'u:' + gil.uid };
  for (const [s, code, to] of [[riaTab, renewed.guestCode, 'board'], [tia, hall, 'board'], [riaTab, renewed.guestCode, toGilPerson], [tia, hall, toGilPerson]]) {
    const up1 = await act(ctl, 'page:push', { code: hall, to, content: picture });
    assert.equal(up1.ok, true, JSON.stringify(up1));
    const over = await act(s, 'page:push', { code, to, content: { kind: 'clock' } });
    assert.deepEqual([over.ok, over.previous], [true, { seq: up1.seq, content: null }], JSON.stringify([to, over]));
    assert.ok(!JSON.stringify(over).includes('/uploads/'), 'no upload path in the answer');
    // The admin's push over the picture is given it whole.
    const again = await act(ctl, 'page:push', { code: hall, to, content: picture });
    assert.deepEqual((await act(ctl, 'page:push', { code: hall, to, content: { kind: 'blank' } })).previous, { seq: again.seq, content: picture });
  }

  // A hall's screens changed: every room of it is told, Legal's console too, with nothing in it (no key).
  const screens = (s) => heard.get(s).filter(([ev]) => ev === 'displays:changed').map(([, v]) => v);
  const made = await act(ctl, 'display:create', { code: hall, name: 'Lectern monitor' });
  assert.equal(made.ok, true, JSON.stringify(made));
  await until(() => screens(inLegal).length > 0 && screens(ctl).length > 0, 4000, 'both rooms told');
  assert.deepEqual([screens(inLegal).at(-1), screens(ctl).at(-1)], [{}, {}]);
});
