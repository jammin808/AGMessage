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
const { startServer, restartServer, stopServer, api, connect, emit, wait, until, pngOf, inviteOf, fakeStagewatch, TOKEN } = require('./helpers');

const PASSWORD = 'clipboard and coffee';
/** The `page.push` rows as the tests read them: the hall, the words, who (an account by its user name). */
const rowsOf = (dataDir) => fs.readFileSync(path.join(dataDir, 'audit.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  .filter((e) => e.action === 'page.push').map((e) => [e.target, e.words, e.actor.name]);
/**
 * A join as a guest who was sent the hall's On stage link joins On stage: the invite added to a guest's On stage join that
 * names none (an open hall's code seats nobody there); a join that names one (or '', none) is sent as it is. Each page
 * opens documents, as a current device's does (`docs: true`), unless its join says otherwise: the Board's devices' test
 * names the pages that cannot.
 */
const invited = (dataDir, args) => {
  const docs = args && typeof args === 'object' && !Object.hasOwn(args, 'docs') ? { ...args, docs: true } : args;
  return docs && docs.role === 'board' && !docs.as && !docs.adminView && !Object.hasOwn(docs, 'invite') ? { ...docs, invite: inviteOf(dataDir, docs.roomCode) } : docs;
};
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
/**
 * What a page is told of a take in a layer (the show's by default), without the clock it is drawn by and the layer it is
 * in (each checked for its type apart); an information take's arrival and Earlier left out too, checked as well.
 */
const told = (t, layer = 'show') => {
  const { now, tz, at, layer: l, arrive, earlier, ...rest } = t;
  assert.ok(Number.isFinite(now) && typeof tz === 'string' && tz && Number.isFinite(at) && l === layer, JSON.stringify(t));
  assert.ok(layer === 'info' ? (arrive === 'over' || arrive === 'side') && (earlier === undefined || Array.isArray(earlier)) : arrive === undefined && earlier === undefined, JSON.stringify(t));
  return rest;
};

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
  // The show's takes a page is told (the information over it is told in a word of its own, its layer's).
  const takes = (s) => heard.get(s).filter(([ev, v]) => ev === 'page:take' && v.layer === 'show').map(([, v]) => v);
  /** The number of the take a page was told last, or undefined before it was told any. */
  const lastTold = (s) => { const t = takes(s).at(-1); return t ? t.seq : undefined; };
  const signals = (s) => heard.get(s).filter(([ev]) => ev === 'pages:changed');
  const joined = async (s, args) => { const r = await emit(s, 'join', invited(srv.dataDir, args)); assert.equal(r.ok, true, s.who + ': ' + JSON.stringify(r)); return r; };

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
  // The show's statuses, as the console reads them (each row's information over the show, `info`, read apart).
  const showOnly = ({ info, ...row }) => { assert.ok(info && typeof info.mark === 'string', JSON.stringify(row)); return row; };
  const status = async (s = ctl) => { const r = await act(s, 'page:status', { code: hall }); return r.ok ? { ...r, board: showOnly(r.board), people: r.people.map(showOnly) } : r; };
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
  for (const s of [lenPage, beaLegal, gil, beaPage, ria, oli]) assert.deepEqual(signals(s), [], s.who + ' is no console');
  // A Staff account backstage holds stage.show by its preset: it may show information on the Board's pages (canShow), so
  // its console is told too.
  assert.deepEqual([sueJoin.canPush, sueJoin.canShow, signals(suePage).at(-1)], [false, true, ['pages:changed', {}]]);
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
  assert.deepEqual(beaViewJoin.person, { role: 'board', view: 'simple', canPush: false, canWeb: false, canShow: false, sends: false, forwardable: false });
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
  // Tom's facts as his page in Main has them now: backstage, the full view, his console's push and a web page's (a Tech
  // holds stage.web), not canShow (the operator's push holds: plan 4-§5.9.2.2, rule 2 is "otherwise"), no room's list to
  // send into, and a hall to send to as his page reads it.
  const tomRooms = await emit(tomMain, 'myRooms', {});
  assert.deepEqual([tomViewJoin.page, tomViewJoin.person], [null, { role: 'research', view: 'full', canPush: true, canWeb: true, canShow: false, sends: false, forwardable: tomRooms.rooms.length > 0 }]);
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
    [{ kind: 'brand' }, 'Choose what to show: back to chat, Stagewatch, the clock, holding, blank, a web page, a document, a picture or a quote.'],
    [{ kind: 'web', url: 'http://vote.example.com/' }, 'A web page is shown by its https address, as a browser shows it.'],
    [{ kind: 'stage' }, 'This hall has no Stagewatch linked — link one in Set up.'],
    [{ kind: 'holding', image: '/uploads/1777424589360-onmqm0a3ew2r-holding.png' }, 'That file is in no room of this hall you can read — share it there first.'],
  ]) assert.deepEqual(await act(ctl, 'page:push', { code: hall, to: 'board', content }), { ok: false, error }, JSON.stringify(content));
  assert.deepEqual(await act(ctl, 'page:push', { code: 'NOHALL', to: 'board', content: { kind: 'clock' } }), { ok: false, error: 'No such hall.' });

  // Who may push: never On stage, the support view, an account without display.control, an observer, a guest of an open
  // hall; each refused in its words, and the console's read with it.
  for (const [s, error] of [
    [gil, 'Do that from a backstage page.'], [beaPage, 'Do that from a backstage page.'], [tomView, 'This is someone else\'s view — act from your own page.'],
    [oli, 'Showing the Board is for the backstage team.'],
    [ria, 'In an open hall, showing the Board needs an invite link or an account — ask the admin.'], [lenPage, 'Your account may not change what people\'s pages show in this hall.'],
  ]) {
    assert.deepEqual(await act(s, 'page:push', { code: hall, to: 'board', content: { kind: 'blank' } }), { ok: false, error }, s.who);
    assert.deepEqual(await act(s, 'page:status', { code: hall }), { ok: false, error }, s.who + ' reads no console');
  }
  // A Staff account that may show (canShow) pushes no show kind, and reads a console of the Board's people alone.
  assert.deepEqual(await act(suePage, 'page:push', { code: hall, to: 'board', content: { kind: 'blank' } }), { ok: false, error: 'Your account may not change what people\'s pages show in this hall.' });
  const sueRead = await act(suePage, 'page:status', { code: hall });
  assert.deepEqual([sueRead.ok, sueRead.board.seq, sueRead.people.map((p) => p.name).sort()], [true, 1, ['Bea Board', 'Gil', 'Kit']], 'the people seated On stage, and no one else');
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
  // The show's takes a page is told (the information over it is told in a word of its own, its layer's).
  const takes = (s) => heard.get(s).filter(([ev, v]) => ev === 'page:take' && v.layer === 'show').map(([, v]) => v);
  const answerOf = (s) => { const x = takes(s).at(-1); return x ? [x.seq, x.answer] : null; };
  const joined = async (s, args) => { const r = await emit(s, 'join', invited(srv.dataDir, args)); assert.equal(r.ok, true, JSON.stringify(r)); return r; };

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
  f.append('file', new Blob([pngOf()], { type: 'image/png' }), 'legal-only.png');
  const up = await (await fetch(srv.base + '/api/upload', { method: 'POST', headers: { 'X-AGM-Upload': legalJoin.uploadToken }, body: f })).json();
  assert.ok(typeof up.url === 'string' && up.url.startsWith('/uploads/'), JSON.stringify(up));
  assert.equal((await act(inLegal, 'message', { type: 'file', url: up.url, filename: 'legal-only.png' })).ok, true);
  const picture = { kind: 'holding', image: up.url };
  // A picture of a side room reaches the Board's pages only from a room on the Main room's list (sourceOk): refused while
  // Legal is off it, in words that name Legal to the admin, who reads it; shown once it is on.
  assert.deepEqual(await act(ctl, 'page:push', { code: hall, to: 'board', content: picture }), { ok: false, error: 'That file belongs to Legal, which may not send into the Main room — send it there first, or ask an admin.' });
  assert.equal((await act(ctl, 'room:update', { code: hall, sendFrom: [LEGAL] })).ok, true);
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

// A web page (plan 1-§5.6, 4-§5.9.2.2, owner answer S4): a take of its own kind, shown only with a right of its own
// (stage.web, beside canPush), its address told to the pages it is shown on and back to no pusher but its own and the
// admin, sealed at rest; a locked hall's backstage code guests show one only while the admin lets them (`admin:guestWeb`,
// the admin's alone), which an unlock turns off in its own op.
test('a web page: a right of its own (stage.web); its address told only to the pages it is shown on and back to whoever put it up and the admin, sealed at rest, named by its host; a locked hall\'s backstage guests show one only while the admin lets them, kept across a restart, and an unlock turns it off, counting what stays for the admin\'s take-down', { timeout: 120_000 }, async (t) => {
  let srv = await startServer();
  t.after(() => stopServer(srv.child));
  const sockets = [];
  t.after(() => sockets.forEach((s) => s.close()));
  const heard = new Map();
  const page = async (cookie, who) => {
    const s = await connect(srv.base, cookie);
    sockets.push(s);
    heard.set(s, []);
    s.onAny((ev, ...args) => heard.get(s).push([ev, args[0]]));
    s.who = who;
    return s;
  };
  const events = (s, name) => heard.get(s).filter(([ev]) => ev === name).map(([, v]) => v);
  const joined = async (s, args) => { const r = await emit(s, 'join', invited(srv.dataDir, args)); assert.equal(r.ok, true, s.who + ': ' + JSON.stringify(r)); return r; };
  const auditRows = (action) => fs.readFileSync(path.join(srv.dataDir, 'audit.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .filter((e) => e.action === action).map((e) => [e.target, e.words, e.actor.name]);
  const VOTE = 'https://vote.example.com/poll/7?token=abc#q2';
  const web = { kind: 'web', url: VOTE };
  const NO_WEB = 'Web pages on the stage need their own right — ask an admin.';
  const GUESTS_OFF = 'Web pages from backstage guests are off in this hall — ask the admin.';

  const admin = (await api(srv.base, 'POST', '/api/setup', { token: TOKEN, username: 'ana', name: 'Ana Admin', password: 'the green room kettle' })).cookie;
  const hall = (await api(srv.base, 'POST', '/api/rooms', { name: 'Hall 5' }, { cookie: admin })).body.code;
  const other = (await api(srv.base, 'POST', '/api/rooms', { name: 'Hall 6' }, { cookie: admin })).body.code;
  const ctl = await page(admin, 'the admin page');
  const LEGAL = (await act(ctl, 'room:create', { hall, name: 'Legal' })).key;
  assert.equal((await act(ctl, 'room:update', { code: LEGAL, codeOn: true })).ok, true);
  const account = async (username, name, role, extra) => {
    const made = await api(srv.base, 'POST', '/api/users', { username, name, role, password: PASSWORD, ...extra }, { cookie: admin });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    return (await api(srv.base, 'POST', '/api/auth/login', { username, password: PASSWORD })).cookie;
  };
  const tomPage = await page(await account('tom', 'Tom Tech', 'tech', { halls: [hall] }), 'Tom, a Tech');
  const tedPage = await page(await account('ted', 'Ted Tech', 'tech', { halls: [hall], revoke: ['stage.web'] }), 'Ted, a Tech without stage.web');
  const miaPage = await page(await account('mia', 'Mia Manager', 'manager', { grant: ['settings.manage'] }), 'Mia, a manager who manages settings');
  const listed = async () => (await new Promise((r) => { ctl.emit('admin:listRooms', r); })).rooms.find((x) => x.code === hall);
  const legalCode = (await listed()).side[0].guestCode;
  const gil = await page(undefined, 'Gil On stage');
  const ria = await page(undefined, 'Ria backstage');
  const oli = await page(undefined, 'Oli observing');
  const lou = await page(undefined, 'Lou, a Member in Legal');
  const gus = await page(undefined, 'Gus backstage in an open hall');
  const joins = {
    tom: await joined(tomPage, { roomCode: hall, as: 'account' }), ted: await joined(tedPage, { roomCode: hall, as: 'account' }),
    gil: await joined(gil, { roomCode: hall, name: 'Gil', role: 'board' }), ria: await joined(ria, { roomCode: hall, name: 'Ria', role: 'research' }),
    oli: await joined(oli, { roomCode: hall, name: 'Oli', role: 'observer' }), lou: await joined(lou, { roomCode: legalCode, name: 'Lou', role: 'research' }),
    gus: await joined(gus, { roomCode: other, name: 'Gus', role: 'research' }),
  };
  // Whether a web page pushed from each would be taken: canPush and stage.web. A Tech holds it by its preset; revoked, a
  // Tech still pushes every other kind; no code guest of an open hall, On stage, observing or in a side room.
  assert.deepEqual(Object.fromEntries(Object.entries(joins).map(([k, j]) => [k, [j.canPush, j.canWeb]])),
    { tom: [true, true], ted: [true, false], gil: [false, false], ria: [false, false], oli: [false, false], lou: [false, false], gus: [false, false] });

  // The admin shows a web page on the Board: Gil's page is told its address, and nothing else is; the answer, the console,
  // the row, the file, the halls board and the context name its host alone, or nothing of it.
  // A web page is information over the show: the status is the information layer's, and says who put it up (the operator).
  const shown = await act(ctl, 'page:push', { code: hall, to: 'board', content: web });
  assert.deepEqual(shown, { ok: true, seq: 1, results: [{ key: 'board', name: 'the Board', ok: true, status: { seq: 1, showing: 'a web page on vote.example.com', kind: 'web', mark: '◷', words: 'Sending', pages: 1, on: 0, arrive: 'over', op: true } }], previous: null });
  await until(() => events(gil, 'page:take').length === 1, 4000, 'Gil told the take');
  const toldGil = told(events(gil, 'page:take')[0], 'info');
  assert.deepEqual([toldGil.seq, toldGil.content, toldGil.by], [1, { kind: 'web', url: VOTE, host: 'vote.example.com' }, { name: 'Ana Admin' }]);
  await wait(300);
  for (const s of [ctl, tomPage, tedPage, ria, oli, lou, gus]) assert.ok(!JSON.stringify(heard.get(s)).includes('poll/7'), s.who + ' hears nothing of the address');
  assert.deepEqual(await act(gil, 'page:report', { seq: 1, state: 'shown' }), { ok: false, error: 'A page shown a web page on vote.example.com reports one of: opened, hidden, failed, dismissed, minimised.' });
  assert.deepEqual(await act(gil, 'page:report', { seq: 1, state: 'opened' }), { ok: true });
  const consoleRead = await act(tomPage, 'page:status', { code: hall });
  assert.deepEqual([consoleRead.board.info.mark, consoleRead.board.info.words, consoleRead.board.info.showing], ['◇', 'Opened · AGMessage can\'t see inside web pages', 'a web page on vote.example.com']);
  assert.deepEqual([consoleRead.board.seq, consoleRead.board.kind], [0, ''], 'the show under it: nothing put up');
  assert.ok(!JSON.stringify(consoleRead).includes('poll/7'), 'the console names its host alone');
  assert.deepEqual(auditRows('page.push'), [[hall, 'the Board (1 page) → a web page on vote.example.com', 'ana']]);
  const pagesFile = () => fs.readFileSync(path.join(srv.dataDir, 'pages.json'), 'utf8');
  await until(() => fs.existsSync(path.join(srv.dataDir, 'pages.json')) && pagesFile().includes('vote.example.com'), 4000, 'pages.json written');
  assert.equal(JSON.parse(pagesFile()).halls[hall].board.info.content.host, 'vote.example.com', 'kept in the information layer');
  for (const part of ['https://', 'poll/7', 'token=abc']) assert.ok(!pagesFile().includes(part), 'pages.json holds no clear address: ' + part);
  assert.match(pagesFile(), /"urlSealed":"enc1:/);
  const boardRead = JSON.stringify((await act(ctl, 'board:watch', {})).board);
  const contextRead = JSON.stringify((await api(srv.base, 'GET', '/api/context', undefined, { cookie: admin })).body);
  for (const text of [boardRead, contextRead, fs.readFileSync(path.join(srv.dataDir, 'audit.jsonl'), 'utf8'), srv.out()]) assert.ok(!text.includes('poll/7') && !text.includes('token=abc'), 'no address on the halls board, in the context, the audit log or the console');

  // Stage.web revoked: refused in its words, nothing numbered; every other kind still goes. Another Tech holds it.
  assert.deepEqual(await act(tedPage, 'page:push', { code: hall, to: 'board', content: web }), { ok: false, error: NO_WEB });
  assert.deepEqual(await act(tedPage, 'page:push', { code: hall, to: 'board', content: { kind: 'web', url: 'javascript:x' } }), { ok: false, error: NO_WEB }, 'the right before the address');   // eslint-disable-line no-script-url
  assert.equal((await act(ctl, 'page:status', { code: hall })).board.info.seq, 1, 'nothing numbered');
  const toOli = await act(tomPage, 'page:push', { code: hall, to: { uid: 'u:' + joins.oli.uid }, content: { kind: 'web', url: 'https://news.example.org/live' } });
  assert.equal(toOli.ok, true, JSON.stringify(toOli));
  await until(() => events(oli, 'page:take').length === 1, 4000, 'Oli told his take');
  assert.deepEqual(events(oli, 'page:take')[0].content, { kind: 'web', url: 'https://news.example.org/live', host: 'news.example.org' });
  // A push's answer gives back what it went over in its layer (`previous`, its Undo): a web page's address only to whoever
  // put it up and to the admin. Another pusher who may show web pages is given no content, and so no Undo, as is one who
  // may not; a show take goes over no web page (the information is over it), so it gives back none.
  const NEWS = { kind: 'web', url: 'https://news.example.org/live', host: 'news.example.org' };
  const SECRET = 'https://vote.example.com/admin?token=s3cr3t';
  const toOliKey = { uid: 'u:' + joins.oli.uid };
  assert.deepEqual((await act(tomPage, 'page:push', { code: hall, to: toOliKey, content: { kind: 'clock' } })).previous, null, 'the show under it: nothing before');
  const tomOwn = await act(tomPage, 'page:push', { code: hall, to: toOliKey, content: { kind: 'web', url: VOTE } });
  assert.deepEqual(tomOwn.previous, { seq: toOli.seq, content: NEWS }, 'his own web page, back to him');
  const adminWeb = await act(ctl, 'page:push', { code: hall, to: toOliKey, content: { kind: 'web', url: SECRET } });
  assert.deepEqual(adminWeb.previous, { seq: tomOwn.seq, content: { kind: 'web', url: VOTE, host: 'vote.example.com' } }, 'the admin is given any');
  const tomOver = await act(tomPage, 'page:push', { code: hall, to: toOliKey, content: NEWS });
  assert.deepEqual(tomOver.previous, { seq: adminWeb.seq, content: null }, 'the admin\'s web page is not his: no address');
  const tomAgain = await act(tomPage, 'page:push', { code: hall, to: toOliKey, content: NEWS });
  const tedOver = await act(tedPage, 'page:push', { code: hall, to: toOliKey, content: { kind: 'chat', layer: 'info' } });
  assert.deepEqual(tedOver.previous, { seq: tomAgain.seq, content: null }, 'nor to one without the right');
  const tomOnceMore = await act(tomPage, 'page:push', { code: hall, to: toOliKey, content: NEWS });
  const adminOver = await act(ctl, 'page:push', { code: hall, to: toOliKey, content: { kind: 'chat', layer: 'info' } });
  assert.deepEqual(adminOver.previous, { seq: tomOnceMore.seq, content: NEWS }, 'the admin is given it back');
  for (const r of [tomOver, tedOver]) assert.ok(!JSON.stringify(r).includes('s3cr3t'), 'no other pusher reads the admin\'s address');
  // The address rules, on the server too: AGMessage itself is never framed.
  for (const url of ['https://localhost:' + new URL(srv.base).port + '/app.html', 'https://127.0.0.1/', 'http://vote.example.com/']) {
    assert.equal((await act(ctl, 'page:push', { code: hall, to: 'board', content: { kind: 'web', url } })).ok, false, url);
  }
  // A code guest of an open hall shows nothing, a web page included.
  assert.deepEqual(await act(ria, 'page:push', { code: hall, to: 'board', content: web }), { ok: false, error: 'In an open hall, showing the Board needs an invite link or an account — ask the admin.' });

  // Locked, Ria (her seat kept by the lock) shows every kind but a web page while the hall's switch is off, as for any
  // hall: off by default.
  assert.equal((await act(ctl, 'admin:lockRoles', { roomCode: hall, on: true })).ok, true);
  assert.equal((await listed()).guestWeb, false);
  assert.deepEqual(await act(ria, 'page:push', { code: hall, to: 'board', content: web }), { ok: false, error: GUESTS_OFF });
  assert.equal((await act(ria, 'page:push', { code: hall, to: 'board', content: { kind: 'clock' } })).ok, true, 'every other kind goes');
  assert.equal((await joined(ria, { roomCode: hall, name: 'Ria', role: 'research', uid: joins.ria.identity })).canWeb, false);
  // A quote from a web page goes, as every quote does, but its address with it only while she may show a web page: off, Gil's
  // page is told the site's host alone (no Open the source), and no address of it is kept.
  const gilQuoteKey = 'u:' + joins.gil.uid;
  const webQuote = { kind: 'snippet', unit: 'text', text: 'Turnout was 64%', from: { web: VOTE } };
  const quoteOff = await act(ria, 'page:push', { code: hall, to: { uid: gilQuoteKey }, content: webQuote });
  assert.equal(quoteOff.ok, true, JSON.stringify(quoteOff));
  await until(() => events(gil, 'page:take').some((x) => x.seq === quoteOff.seq), 4000, 'Gil told Ria\'s quote');
  assert.deepEqual(events(gil, 'page:take').find((x) => x.seq === quoteOff.seq).content.from, { host: 'vote.example.com' });

  // The switch is the admin's alone: a Tech and a guest are not the admin page's, and a manager who manages settings is
  // admitted by its gate and is not "the admin". A side room has none, and an open hall none to turn.
  assert.deepEqual(await act(tomPage, 'admin:guestWeb', { roomCode: hall, on: true }), { ok: false, error: 'Not admin' });
  assert.deepEqual(await act(ria, 'admin:guestWeb', { roomCode: hall, on: true }), { ok: false, error: 'Not admin' });
  assert.deepEqual(await act(miaPage, 'admin:guestWeb', { roomCode: hall, on: true }), { ok: false, error: 'Only an admin may let backstage guests show web pages.' });
  assert.deepEqual(await act(ctl, 'admin:guestWeb', { roomCode: LEGAL, on: true }), { ok: false, error: 'This is set on the hall\'s Main room.' });
  assert.deepEqual(await act(ctl, 'admin:guestWeb', { roomCode: other, on: true }), { ok: false, error: 'Lock the roles first: in an open hall, code guests show nothing.' });
  assert.deepEqual(await act(ctl, 'admin:guestWeb', { roomCode: hall, on: 'yes' }), { ok: false, error: 'Say whether backstage guests may show web pages: on (true) or off (false).' });
  assert.deepEqual(auditRows('room.guestWeb'), [], 'refusals write no row');

  // Turned on by the admin: one row, and Ria's page told at once; nobody else's page is told anything.
  const riaTold = events(ria, 'pages:rights').length;
  assert.deepEqual(await act(ctl, 'admin:guestWeb', { roomCode: hall, on: true }), { ok: true, on: true, up: 0 });
  assert.deepEqual(auditRows('room.guestWeb'), [[hall, 'backstage guests may show web pages', 'ana']]);
  await until(() => events(ria, 'pages:rights').length === riaTold + 1, 4000, 'Ria told she may show web pages');
  assert.deepEqual(events(ria, 'pages:rights').at(-1), { canWeb: true });
  for (const s of [gil, oli, tomPage, tedPage, lou, gus, ctl]) assert.deepEqual(events(s, 'pages:rights'), [], s.who + ' is told nothing');
  assert.deepEqual(await act(ctl, 'admin:guestWeb', { roomCode: hall, on: true }), { ok: true, already: true, on: true, up: 0 });
  assert.equal(auditRows('room.guestWeb').length, 1, 'asked again: no second row');
  assert.equal((await listed()).guestWeb, true);
  // A guest who may show web pages is given back no other pusher's address either: the admin's, a token in its query.
  const adminBoard = await act(ctl, 'page:push', { code: hall, to: 'board', content: { kind: 'web', url: SECRET } });
  assert.equal(adminBoard.ok, true, JSON.stringify(adminBoard));
  const riaOver = await act(ria, 'page:push', { code: hall, to: 'board', content: { kind: 'chat', layer: 'info' } });
  assert.deepEqual(riaOver.previous, { seq: adminBoard.seq, content: null });
  assert.ok(!JSON.stringify(riaOver).includes('s3cr3t') && !JSON.stringify(heard.get(ria)).includes('s3cr3t'), 'Ria reads nothing of it');
  // On, her quote from a web page carries its address to Gil's page, for Open the source.
  const quoteOn = await act(ria, 'page:push', { code: hall, to: { uid: gilQuoteKey }, content: webQuote });
  assert.equal(quoteOn.ok, true, JSON.stringify(quoteOn));
  await until(() => events(gil, 'page:take').some((x) => x.seq === quoteOn.seq), 4000, 'Gil told Ria\'s quote');
  assert.deepEqual(events(gil, 'page:take').find((x) => x.seq === quoteOn.seq).content.from, { host: 'vote.example.com', url: VOTE });
  // Ria's web page goes now; On stage, observing, a side room's Member and an open hall's guest still show nothing.
  const riaWeb = await act(ria, 'page:push', { code: hall, to: 'board', content: web });
  assert.deepEqual(riaWeb.previous, { seq: riaOver.seq, content: { kind: 'chat', layer: 'info' } });
  assert.equal(riaWeb.ok, true, JSON.stringify(riaWeb));
  assert.deepEqual(await act(gil, 'page:push', { code: hall, to: 'board', content: web }), { ok: false, error: 'Do that from a backstage page.' });
  assert.deepEqual(await act(oli, 'page:push', { code: hall, to: 'board', content: web }), { ok: false, error: 'Showing the Board is for the backstage team.' });
  assert.deepEqual(await act(lou, 'page:push', { code: hall, to: 'board', content: web }), { ok: false, error: 'Showing the Board is for the backstage team.' });
  assert.deepEqual(await act(gus, 'page:push', { code: other, to: 'board', content: web }), { ok: false, error: 'In an open hall, showing the Board needs an invite link or an account — ask the admin.' });
  assert.equal((await joined(ria, { roomCode: hall, name: 'Ria', role: 'research', uid: joins.ria.identity })).canWeb, true, 'her page joined again is told so');

  // A restart keeps the switch (the room's op log) and the guest's web page, its address opened again for Gil's page.
  sockets.splice(0).forEach((s) => s.close());
  srv = await restartServer(srv);
  const ctl2 = await page(admin, 'the admin page, after the restart');
  assert.equal((await new Promise((r) => { ctl2.emit('admin:listRooms', r); })).rooms.find((x) => x.code === hall).guestWeb, true, 'the switch is kept');
  const ria2 = await page(undefined, 'Ria, after the restart');
  assert.equal((await joined(ria2, { roomCode: hall, name: 'Ria', role: 'research', uid: joins.ria.identity })).canWeb, true);
  const gil2 = await page(undefined, 'Gil, after the restart');
  const gilBack = await joined(gil2, { roomCode: hall, name: 'Gil', role: 'board', uid: joins.gil.identity });
  assert.deepEqual([gilBack.over.seq, gilBack.over.content], [riaWeb.seq, { kind: 'web', url: VOTE, host: 'vote.example.com' }]);

  // Turned off over the web page Ria put up: her next one is refused, the one up stays, and the answer counts it with
  // its target, for the admin's Take it down; the row says it stays.
  assert.deepEqual(await act(ctl2, 'admin:guestWeb', { roomCode: hall, on: false }), { ok: true, on: false, up: 1, upWords: '1 web page a guest showed is still up', takeDown: [{ to: 'board', seq: riaWeb.seq }] });
  assert.deepEqual(auditRows('room.guestWeb').at(-1), [hall, 'backstage guests may no longer show web pages (1 shown now stays until taken down)', 'ana']);
  await until(() => events(ria2, 'pages:rights').length === 1, 4000, 'Ria told she may not');
  assert.deepEqual(events(ria2, 'pages:rights')[0], { canWeb: false });
  assert.deepEqual(await act(ria2, 'page:push', { code: hall, to: 'board', content: web }), { ok: false, error: GUESTS_OFF });
  const still = (await act(ctl2, 'page:status', { code: hall })).board.info;
  assert.deepEqual([still.seq, still.kind], [riaWeb.seq, 'web'], 'the web page up stays');
  // As her web page stays, so does the quote she showed Gil while it was on, with its address: whether a quote carries its
  // link is decided as it is pushed, and a page joining again is told it so.
  const gilAgain = await joined(gil2, { roomCode: hall, name: 'Gil', role: 'board', uid: joins.gil.identity });
  const keptQuote = [gilAgain.over, gilAgain.beside, ...gilAgain.earlier].find((x) => x && x.seq === quoteOn.seq);
  assert.deepEqual(keptQuote && keptQuote.content.from, { host: 'vote.example.com', url: VOTE }, JSON.stringify(gilAgain.earlier.map((x) => x.seq)));
  // Take it down: the information handed back over that take alone (the admin page's Take it down); then nothing a guest
  // showed is up.
  assert.equal((await act(ctl2, 'page:push', { code: hall, to: 'board', content: { kind: 'chat', layer: 'info' }, ifSeq: riaWeb.seq })).ok, true);
  assert.deepEqual(await act(ctl2, 'admin:guestWeb', { roomCode: hall, on: false }), { ok: true, already: true, on: false, up: 0 });

  // Turned on again, Ria shows Gil a web page of his own, and Gil leaves: the take stays for when he comes back. Taking it
  // down with no page of his open is the admin's alone.
  assert.equal((await act(ctl2, 'admin:guestWeb', { roomCode: hall, on: true })).ok, true);
  await until(() => events(ria2, 'pages:rights').length === 2, 4000, 'Ria told again');
  const gilKey = 'u:' + joins.gil.uid;
  const toGil = await act(ria2, 'page:push', { code: hall, to: { uid: gilKey }, content: web });
  assert.equal(toGil.ok, true, JSON.stringify(toGil));
  gil2.close();
  for (let i = 0; i < 50 && (await act(ctl2, 'page:status', { code: hall })).people.some((x) => x.uid === gilKey); i++) await wait(100);
  assert.deepEqual(await act(ria2, 'page:push', { code: hall, to: { uid: gilKey }, content: { kind: 'chat', layer: 'info' }, ifSeq: toGil.seq }), { ok: false, error: 'That person is not in this hall now.' });
  // Then the hall unlocked: one op writes both (the room's log), its row says the guests' web pages are off and that one
  // stays, Ria is told, and the answer counts it with its target, for the admin's Take it down, as turning it off does.
  const unlocked = await act(ctl2, 'admin:lockRoles', { roomCode: hall, on: false });
  assert.deepEqual([unlocked.ok, unlocked.locked, unlocked.guestWeb, unlocked.up, unlocked.upWords, unlocked.takeDown], [true, false, false, 1, '1 web page a guest showed is still up', [{ to: gilKey, seq: toGil.seq }]]);
  const ops = fs.readFileSync(path.join(srv.dataDir, 'rooms', hall + '.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((o) => o.o === 'meta' && o.settings);
  assert.deepEqual([ops.at(-1).settings.lockRoles, ops.at(-1).settings.guestWeb], [false, false], 'one op: the lock and the switch');
  assert.deepEqual(auditRows('room.lock').at(-1).slice(0, 2), [hall, 'roles unlocked, guests\' web pages off (1 shown now stays until taken down)']);
  await until(() => events(ria2, 'pages:rights').length === 3, 4000, 'Ria told she may not');
  assert.deepEqual(events(ria2, 'pages:rights').at(-1), { canWeb: false });
  // Take it down, with no page of Gil's open: back to chat over that take alone, the address given back to the admin.
  const down = await act(ctl2, 'page:push', { code: hall, to: { uid: gilKey }, content: { kind: 'chat', layer: 'info' }, ifSeq: toGil.seq });
  assert.deepEqual([down.ok, down.results[0].name, down.results[0].status.words, down.previous], [true, '', 'No page of theirs is open in this hall', { seq: toGil.seq, content: { kind: 'web', url: VOTE, host: 'vote.example.com' } }]);
  assert.deepEqual(auditRows('page.push').at(-1), [hall, 'a person with no page open → the information taken down', 'ana']);
  assert.deepEqual(await act(ctl2, 'page:push', { code: hall, to: { uid: gilKey }, content: { kind: 'chat', layer: 'info' }, ifSeq: toGil.seq }), { ok: false, error: 'Something newer is showing there now: nothing changed.' });
  assert.deepEqual(await act(ctl2, 'page:push', { code: hall, to: { uid: gilKey }, content: { kind: 'clock' } }), { ok: false, error: 'That person is not in this hall now.' }, 'only a take-down, by its number');
  // Locking again leaves it off, with nothing a guest showed still up.
  assert.equal((await act(ctl2, 'admin:lockRoles', { roomCode: hall, on: true })).ok, true);
  assert.equal((await new Promise((r) => { ctl2.emit('admin:listRooms', r); })).rooms.find((x) => x.code === hall).guestWeb, false, 'locking again leaves it off');
  assert.deepEqual(await act(ctl2, 'admin:guestWeb', { roomCode: hall, on: false }), { ok: true, already: true, on: false, up: 0 });
  assert.deepEqual(await act(ria2, 'page:push', { code: hall, to: 'board', content: web }), { ok: false, error: GUESTS_OFF });
});

test('a person\'s chat view: the join\'s view by the seat, the admin\'s choice for a guest (kept by their uid) or an account, told live to every page of theirs and their support view and nobody else, one row each, the admin\'s alone; the support view\'s relayed state says so; a reaction carries its seat', { timeout: 120_000 }, async (t) => {
  const srv = await startServer();
  t.after(() => stopServer(srv.child));
  const sockets = [];
  t.after(() => sockets.forEach((s) => s.close()));
  const heard = new Map();
  const page = async (cookie, who) => {
    const s = await connect(srv.base, cookie);
    sockets.push(s);
    heard.set(s, []);
    s.onAny((ev, ...args) => heard.get(s).push([ev, args[0]]));
    s.who = who;
    return s;
  };
  const views = (s) => heard.get(s).filter(([ev]) => ev === 'view').map(([, v]) => v.view);
  const joined = async (s, args) => { const r = await emit(s, 'join', invited(srv.dataDir, args)); assert.equal(r.ok, true, s.who + ': ' + JSON.stringify(r)); return r; };
  const rows = (action) => fs.readFileSync(path.join(srv.dataDir, 'audit.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.action === action).map((e) => [e.target, e.words]);
  const kept = () => { try { return JSON.parse(fs.readFileSync(path.join(srv.dataDir, 'pages.json'), 'utf8')).views; } catch { return null; } };

  const admin = (await api(srv.base, 'POST', '/api/setup', { token: TOKEN, username: 'ana', name: 'Ana Admin', password: 'the green room kettle' })).cookie;
  const hall = (await api(srv.base, 'POST', '/api/rooms', { name: 'Hall 2' }, { cookie: admin })).body.code;
  const account = async (username, name, role, extra) => {
    const made = await api(srv.base, 'POST', '/api/users', { username, name, role, password: PASSWORD, ...extra }, { cookie: admin });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    return { id: made.body.user.id, cookie: (await api(srv.base, 'POST', '/api/auth/login', { username, password: PASSWORD })).cookie };
  };
  const bea = await account('bea', 'Bea Board', 'staff', { halls: [hall], board: [hall] });
  const tom = await account('tom', 'Tom Tech', 'tech', { halls: [hall] });
  // A manager given settings.manage: the admin page's gate admits it; it manages no account.
  const max = await account('max', 'Max Manager', 'staff', { halls: [hall], grant: ['settings.manage'] });

  // The join's view: by the seat, none chosen yet: simple On stage, a guest's or an account's, full backstage.
  const gil = await page(undefined, 'Gil On stage');
  const gilJoin = await joined(gil, { roomCode: hall, name: 'Gil', role: 'board' });
  const gil2 = await page(undefined, 'Gil\'s second device');
  await joined(gil2, { roomCode: hall, name: 'Gil', role: 'board', uid: gilJoin.identity });
  const ria = await page(undefined, 'Ria backstage');
  const riaJoin = await joined(ria, { roomCode: hall, name: 'Ria', role: 'research' });
  const beaPage = await page(bea.cookie, 'Bea On stage');
  const beaJoin = await joined(beaPage, { roomCode: hall, as: 'account' });
  const tomPage = await page(tom.cookie, 'Tom backstage');
  await joined(tomPage, { roomCode: hall, as: 'account' });
  assert.deepEqual([gilJoin.view, riaJoin.view, beaJoin.view], ['simple', 'full', 'simple']);
  assert.deepEqual(Object.keys(gilJoin).slice(-4), ['view', 'more', 'older', 'files'], 'the join\'s view, appended at its end before a first open\'s bounds');

  // The admin page reads the room's people, with the view the admin chose for each ('' by the seat).
  const ctl = await page(admin, 'the admin page');
  const watched = await emit(ctl, 'admin:watchRoom', { roomCode: hall });
  const sid = (name) => watched.users.find((u) => u.name === name).socketId;
  assert.deepEqual(watched.users.map((u) => [u.name, u.view]).sort(), [['Bea Board', ''], ['Gil', ''], ['Ria', ''], ['Tom Tech', '']]);
  // The admin's support view of Gil: told the view his pages draw.
  const gilView = await page(admin, 'the admin\'s view of Gil');
  const gilViewJoin = await joined(gilView, { roomCode: hall, name: 'Gil', role: 'board', adminView: true, viewOf: gilJoin.uid });
  assert.equal(gilViewJoin.person.view, 'simple');

  // The admin's people rows hear each choice live (`users`, to the admin's pages alone): no other page's list says it, so
  // no other page is sent its list again.
  const lists = (s) => heard.get(s).filter(([ev]) => ev === 'users').map(([, v]) => v);
  const viewIn = (s, name) => { const l = lists(s).at(-1) || []; const u = l.find((x) => x.name === name); return u ? u.view : undefined; };
  await wait(300);
  const others = [gil, gil2, ria, beaPage, tomPage];
  const before = others.map((s) => lists(s).length);

  // A guest's view chosen: both of Gil's devices and the admin's view of him told, nobody else; kept by his uid; one row.
  assert.deepEqual(await act(ctl, 'admin:setView', { roomCode: hall, socketId: sid('Gil'), view: 'full' }), { ok: true, view: 'full' });
  await until(() => [gil, gil2, gilView].every((s) => views(s).length === 1), 4000, 'Gil\'s pages told');
  assert.deepEqual([views(gil), views(gil2), views(gilView), views(ria), views(beaPage), views(tomPage)], [['full'], ['full'], ['full'], [], [], []]);
  await until(() => viewIn(ctl, 'Gil') === 'full', 4000, 'the admin page\'s people rows say Gil\'s view');
  await wait(300);
  assert.deepEqual(others.map((s) => lists(s).length), before, 'no other page is sent its people list for a chat view');
  assert.ok(lists(ctl).at(-1).every((u) => 'view' in u) && others.every((s) => lists(s).every((l) => l.every((u) => !('view' in u)))), 'only the admin\'s list says a view');
  await until(() => kept() && kept()['u:' + gilJoin.uid], 4000, 'pages.json keeps it');
  assert.equal(kept()['u:' + gilJoin.uid].view, 'full');
  // Asked again as it stands: already, no row and nobody told.
  assert.deepEqual(await act(ctl, 'admin:setView', { roomCode: hall, socketId: sid('Gil'), view: 'full' }), { ok: true, already: true, view: 'full' });
  // Backstage set to Simple; and Gil back to his seat's (simple On stage), which pages.json no longer keeps.
  assert.deepEqual(await act(ctl, 'admin:setView', { roomCode: hall, socketId: sid('Ria'), view: 'simple' }), { ok: true, view: 'simple' });
  assert.deepEqual(await act(ctl, 'admin:setView', { roomCode: hall, socketId: sid('Gil'), view: '' }), { ok: true, view: '' });
  await until(() => views(ria).length === 1 && views(gil).length === 2, 4000, 'Ria and Gil told again');
  assert.deepEqual([views(ria), views(gil), views(gil2)], [['simple'], ['full', 'simple'], ['full', 'simple']]);
  await until(() => kept() && !kept()['u:' + gilJoin.uid] && kept()['u:' + riaJoin.uid], 4000, 'pages.json keeps Ria\'s, and Gil\'s no longer');
  // A reload keeps it: Ria's next join draws the simple view.
  const ria2 = await page(undefined, 'Ria, reloaded');
  assert.equal((await joined(ria2, { roomCode: hall, name: 'Ria', role: 'research', uid: riaJoin.identity })).view, 'simple');

  // An account's view chosen: kept on the account, its page told, its row the Accounts page's words.
  assert.deepEqual(await act(ctl, 'admin:setView', { roomCode: hall, socketId: sid('Bea Board'), view: 'full' }), { ok: true, view: 'full' });
  await until(() => views(beaPage).length === 1, 4000, 'Bea\'s page told');
  assert.deepEqual(views(beaPage), ['full']);
  const users = (await api(srv.base, 'GET', '/api/users', undefined, { cookie: admin })).body.users;
  assert.equal(users.find((u) => u.username === 'bea').view, 'full');
  // The admin's people list says each choice now, live and as read again.
  await until(() => viewIn(ctl, 'Bea Board') === 'full' && viewIn(ctl, 'Ria') === 'simple' && viewIn(ctl, 'Gil') === '', 4000, 'the admin page\'s rows live');
  assert.deepEqual((await emit(ctl, 'admin:watchRoom', { roomCode: hall })).users.map((u) => [u.name, u.view]).sort(), [['Bea Board', 'full'], ['Gil', ''], ['Ria', 'simple'], ['Tom Tech', '']]);
  assert.deepEqual(rows('person.view'), [[hall, 'Gil (guest) → full view'], [hall, 'Ria (guest) → simple view'], [hall, 'Gil (guest) → the view by their seat']]);
  assert.deepEqual(rows('user.update').filter(([, w]) => /^view/.test(w)), [['bea', 'view → full']]);
  // The Accounts page's Chat view (PATCH) reaches the account's pages and the admin page's rows alike.
  assert.equal((await api(srv.base, 'PATCH', '/api/users/' + bea.id, { view: 'simple' }, { cookie: admin })).status, 200);
  await until(() => views(beaPage).length === 2 && viewIn(ctl, 'Bea Board') === 'simple', 4000, 'the PATCH told Bea\'s page and the admin page\'s rows');
  assert.deepEqual(views(beaPage), ['full', 'simple']);
  assert.equal((await api(srv.base, 'PATCH', '/api/users/' + bea.id, { view: 'full' }, { cookie: admin })).status, 200);
  await until(() => viewIn(ctl, 'Bea Board') === 'full', 4000, 'and back');

  // The admin's alone: a Tech's page is not the admin's; a manager with settings.manage sets a guest's, and no account's
  // (the Accounts page's own rule); a view that is none, and a person not in the room, are refused in words.
  assert.deepEqual(await act(tomPage, 'admin:setView', { roomCode: hall, socketId: sid('Gil'), view: 'full' }), { ok: false, error: 'Not admin' });
  const maxPage = await page(max.cookie, 'Max on the admin page');
  assert.deepEqual(await act(maxPage, 'admin:setView', { roomCode: hall, socketId: sid('Bea Board'), view: 'simple' }), { ok: false, error: 'You may not manage accounts.' });
  assert.deepEqual(await act(maxPage, 'admin:setView', { roomCode: hall, socketId: sid('Gil'), view: 'full' }), { ok: true, view: 'full' });
  assert.deepEqual(await act(ctl, 'admin:setView', { roomCode: hall, socketId: sid('Gil'), view: 'tiny' }), { ok: false, error: 'Choose By seat, Simple or Full.' });
  assert.deepEqual(await act(ctl, 'admin:setView', { roomCode: hall, socketId: 'nobody', view: 'full' }), { ok: false, error: 'That person is not in this room now.' });
  assert.equal((await api(srv.base, 'GET', '/api/users', undefined, { cookie: admin })).body.users.find((u) => u.username === 'bea').view, 'full', 'unchanged by the refusal');

  // The support view's relayed state says it came from there (the simple view takes no theme from it); the person's own
  // pages relay theirs as they are.
  gilView.emit('userState:push', { key: 'theme', value: 'light' });
  gil2.emit('userState:push', { key: 'theme', value: 'dark' });
  const pushes = (s) => heard.get(s).filter(([ev]) => ev === 'userState:push').map(([, v]) => v);
  await until(() => pushes(gil).length === 2, 4000, 'Gil\'s page told both');
  assert.deepEqual(pushes(gil), [{ key: 'theme', value: 'light', support: true }, { key: 'theme', value: 'dark' }]);
  assert.deepEqual(pushes(gilView), [{ key: 'theme', value: 'dark' }], 'the support view hears the person\'s, never with support');

  // A Board member's 👍 carries the seat, so the backstage page says who got it.
  const said = await act(tomPage, 'message', { type: 'text', text: 'Doors open in five' });
  assert.ok(said.ok);
  assert.deepEqual(await act(gil, 'react', { messageId: said.id, emoji: '👍', on: true }), { ok: true });
  const reacted = (await emit(ctl, 'admin:watchRoom', { roomCode: hall })).messages.find((m) => m.id === said.id).reactions;
  assert.deepEqual(reacted.map((r) => [r.name, r.emoji, r.role]), [['Gil', '👍', 'board']]);
});

// Two layers, and who may show what (plan 4-§5.9.1, §5.9.2.2): information (a web page, until the document, picture and
// quote kinds land) is drawn over the show take and never replaces it; a researcher's account shows it by a right of its
// own (canShow: stage.show, stage.web for a web page), to the people On stage alone, never over the operator's information
// (its side bar instead, into Earlier), and takes down only what such a seat put up; a side room reaches the Board only
// from the Main room's list; stage.show governs the operator's information too.
test('information over the show: a researcher\'s web page over the Board\'s clock, the clock under it, Back to chat returning to it; canShow for accounts on the people On stage, never over the operator\'s, a side room only from the Main room\'s list; Take down over its own kind; Earlier', { timeout: 120_000 }, async (t) => {
  const srv = await startServer();
  t.after(() => stopServer(srv.child));
  const sockets = [];
  t.after(() => sockets.forEach((s) => s.close()));
  const heard = new Map();
  const page = async (cookie, who) => {
    const s = await connect(srv.base, cookie);
    sockets.push(s);
    heard.set(s, []);
    s.onAny((ev, ...args) => heard.get(s).push([ev, args[0]]));
    s.who = who;
    return s;
  };
  const layerTakes = (s, layer) => heard.get(s).filter(([ev, v]) => ev === 'page:take' && v.layer === layer).map(([, v]) => v);
  const joined = async (s, args) => { const r = await emit(s, 'join', invited(srv.dataDir, args)); assert.equal(r.ok, true, s.who + ': ' + JSON.stringify(r)); return r; };
  const rows = () => fs.readFileSync(path.join(srv.dataDir, 'audit.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.action === 'page.push').map((e) => e.words);
  const VOTE = 'https://vote.example.com/poll/7?token=abc';
  const NEWS = 'https://news.example.org/live';
  const OPERATOR = 'The operator is showing a web page — ask them, or send it to their side bar.';
  const OFF_LIST = 'This room may not send to the Main room\'s Board — ask an admin.';
  const NO_SHOW = 'Showing files, pages and quotes on the stage needs its own right — ask an admin.';

  const admin = (await api(srv.base, 'POST', '/api/setup', { token: TOKEN, username: 'ana', name: 'Ana Admin', password: 'the green room kettle' })).cookie;
  const hall = (await api(srv.base, 'POST', '/api/rooms', { name: 'Hall 7' }, { cookie: admin })).body.code;
  const ctl = await page(admin, 'the admin page');
  const LEGAL = (await act(ctl, 'room:create', { hall, name: 'Legal' })).key;
  const account = async (username, name, role, extra) => {
    const made = await api(srv.base, 'POST', '/api/users', { username, name, role, password: PASSWORD, ...extra }, { cookie: admin });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    return (await api(srv.base, 'POST', '/api/auth/login', { username, password: PASSWORD })).cookie;
  };
  // Sue, Staff granted stage.web, backstage in Main and given Legal; Sal, Staff (stage.show by its preset, no stage.web);
  // Ned, a Tech with stage.show revoked (the operator by display.control); Vic, a Viewer granted both (an observer seat).
  const suePage = await page(await account('sue', 'Sue Staff', 'staff', { halls: [hall], rooms: [LEGAL], grant: ['stage.web'] }), 'Sue in Main');
  const sueLegal = await page(await (async () => (await api(srv.base, 'POST', '/api/auth/login', { username: 'sue', password: PASSWORD })).cookie)(), 'Sue in Legal');
  const salPage = await page(await account('sal', 'Sal Staff', 'staff', { halls: [hall] }), 'Sal in Main');
  const nedPage = await page(await account('ned', 'Ned Tech', 'tech', { halls: [hall], revoke: ['stage.show'] }), 'Ned, without stage.show');
  const vicPage = await page(await account('vic', 'Vic Viewer', 'viewer', { halls: [hall], grant: ['stage.show', 'stage.web'] }), 'Vic, a Viewer');
  const gil = await page(undefined, 'Gil On stage');
  const oli = await page(undefined, 'Oli observing');
  const joins = {
    sue: await joined(suePage, { roomCode: hall, as: 'account' }), sueLegal: await joined(sueLegal, { roomCode: LEGAL, as: 'account' }),
    sal: await joined(salPage, { roomCode: hall, as: 'account' }), ned: await joined(nedPage, { roomCode: hall, as: 'account' }), vic: await joined(vicPage, { roomCode: hall, as: 'account' }),
    gil: await joined(gil, { roomCode: hall, name: 'Gil', role: 'board' }), oli: await joined(oli, { roomCode: hall, name: 'Oli', role: 'observer' }),
  };
  // Who may show by a right of its own (canShow), and a web page (canWeb): Sue (stage.web granted) and Sal backstage in
  // Main; Sue's Legal page, off the Main room's list, not; Ned is the operator (canPush), so not canShow (rule 2 is
  // "otherwise"); Vic reads only.
  assert.deepEqual(Object.fromEntries(Object.entries(joins).map(([k, j]) => [k, [j.canPush, j.canShow, j.canWeb]])),
    { sue: [false, true, true], sueLegal: [false, false, false], sal: [false, true, false], ned: [true, false, true], vic: [false, false, false], gil: [false, false, false], oli: [false, false, false] });
  // The join's last keys of people's pages: canWeb, then canShow, the information over the show (`over`) and Earlier.
  const keys = Object.keys(joins.gil);
  assert.deepEqual(keys.slice(keys.indexOf('canWeb'), keys.indexOf('canWeb') + 4), ['canWeb', 'canShow', 'over', 'earlier']);
  assert.deepEqual([joins.gil.over, joins.gil.earlier], [null, []]);

  // The operator puts the clock on the Board; Sue's web page goes over it, not in its place.
  const clock = await act(ctl, 'page:push', { code: hall, to: 'board', content: { kind: 'clock' } });
  const sueWeb = await act(suePage, 'page:push', { code: hall, to: 'board', content: { kind: 'web', url: VOTE } });
  assert.deepEqual([sueWeb.ok, sueWeb.previous, sueWeb.results[0].status.op, sueWeb.results[0].status.arrive], [true, null, false, 'over'], JSON.stringify(sueWeb));
  await until(() => layerTakes(gil, 'info').length === 1 && layerTakes(gil, 'show').length === 1, 4000, 'Gil told both layers');
  const info = layerTakes(gil, 'info')[0];
  assert.deepEqual([info.seq, info.content, info.by, info.arrive, info.earlier], [sueWeb.seq, { kind: 'web', url: VOTE, host: 'vote.example.com' }, { name: 'Sue Staff' }, 'over', []]);
  assert.equal(layerTakes(gil, 'show')[0].seq, clock.seq, 'the clock is still his show take');
  // Gil's page draws the web page over the clock and says so of each: the clock under it, the web page opened.
  assert.deepEqual(await act(gil, 'page:report', { seq: clock.seq, state: 'hidden', words: 'under a web page' }), { ok: true });
  assert.deepEqual(await act(gil, 'page:report', { seq: sueWeb.seq, state: 'opened' }), { ok: true });
  const read = await act(ctl, 'page:status', { code: hall });
  assert.deepEqual([read.board.kind, read.board.mark, read.board.words, read.board.on], ['clock', '◐', 'Under a web page', 0], 'the clock: never on screen while it is under');
  assert.deepEqual([read.board.info.kind, read.board.info.mark, read.board.info.op, read.board.info.showing], ['web', '◇', false, 'a web page on vote.example.com']);
  // Sue's console reads it by its host alone, and lists the people On stage alone.
  const sueRead = await act(suePage, 'page:status', { code: hall });
  assert.ok(!JSON.stringify(sueRead).includes('poll/7'), 'the host alone');
  assert.deepEqual(sueRead.people.map((p) => p.name), ['Gil']);
  // Back to chat on the web page returns Gil to the clock: his answer in the information layer, the clock's untouched.
  assert.deepEqual(await act(gil, 'page:report', { seq: sueWeb.seq, state: 'dismissed' }), { ok: true });
  assert.deepEqual(await act(gil, 'page:report', { seq: clock.seq, state: 'shown' }), { ok: true });
  const back = await act(ctl, 'page:status', { code: hall });
  assert.deepEqual([back.board.mark, back.board.words, back.board.info.mark], ['✓', 'On the 1 Board page', '○']);
  // Put away, it is Gil's to find under Earlier: his page is told it.
  await until(() => layerTakes(gil, 'info').some((x) => x.earlier && x.earlier.some((e) => e.seq === sueWeb.seq)), 4000, 'Earlier told');

  // Who may show: never the show layer by canShow; never a person who is not On stage; a Viewer's observer seat nothing;
  // a Staff account a web page only with its right.
  assert.deepEqual(await act(suePage, 'page:push', { code: hall, to: 'board', content: { kind: 'clock' } }), { ok: false, error: 'Your account may not change what people\'s pages show in this hall.' });
  assert.deepEqual(await act(suePage, 'page:push', { code: hall, to: { uid: 'u:' + joins.oli.uid }, content: { kind: 'web', url: NEWS } }), { ok: false, error: 'Only the people on stage can be shown this.' });
  assert.deepEqual(await act(vicPage, 'page:push', { code: hall, to: 'board', content: { kind: 'web', url: NEWS } }), { ok: false, error: 'Your account may not change what people\'s pages show in this hall.' }, 'its seat is checked: an observer pushes nothing');
  assert.deepEqual(await act(salPage, 'page:push', { code: hall, to: 'board', content: { kind: 'web', url: NEWS } }), { ok: false, error: 'Web pages on the stage need their own right — ask an admin.' });
  const toGil = await act(suePage, 'page:push', { code: hall, to: { uid: 'u:' + joins.gil.uid }, content: { kind: 'web', url: NEWS }, arrive: 'side' });
  assert.deepEqual([toGil.ok, toGil.arrive], [true, 'side'], 'a person On stage, in their side bar');
  assert.ok(rows().at(-1).endsWith('a web page on news.example.org, in their side bar'), rows().at(-1));
  // The show arrives over the chat alone; an arrival that is none is refused.
  assert.deepEqual(await act(ctl, 'page:push', { code: hall, to: 'board', content: { kind: 'clock' }, arrive: 'side' }), { ok: false, error: 'The show is drawn over the chat: only information arrives in the side bar.' });
  assert.deepEqual(await act(ctl, 'page:push', { code: hall, to: 'board', content: { kind: 'web', url: NEWS }, arrive: 'under' }), { ok: false, error: 'Information arrives over their chat or in their side bar.' });

  // stage.show governs the operator's information too: Ned (display.control) is refused the take-down, a web page goes;
  // each console is told whether its information pushes hold it (`show`), so Ned's greys the take-down.
  assert.deepEqual(await act(nedPage, 'page:push', { code: hall, to: 'board', content: { kind: 'chat', layer: 'info' } }), { ok: false, error: NO_SHOW });
  assert.deepEqual(await Promise.all([nedPage, ctl, suePage].map(async (s) => (await act(s, 'page:status', { code: hall })).show)), [false, true, true]);
  // The operator's web page is up: Sue's over it is refused, her side-bar push taken, superseding nothing (into Earlier).
  const opWeb = await act(nedPage, 'page:push', { code: hall, to: 'board', content: { kind: 'web', url: NEWS } });
  assert.equal(opWeb.ok, true, JSON.stringify(opWeb));
  assert.deepEqual(await act(suePage, 'page:push', { code: hall, to: 'board', content: { kind: 'web', url: VOTE } }), { ok: false, error: OPERATOR });
  const aside = await act(suePage, 'page:push', { code: hall, to: 'board', content: { kind: 'web', url: VOTE }, arrive: 'side' });
  // Kept beside the operator's, replacing nothing: its own status, sending until Gil's page says where it is.
  const asideSaid = aside.results[0].status;
  assert.deepEqual([aside.ok, aside.aside, aside.arrive, aside.previous, asideSaid.seq, asideSaid.mark, asideSaid.arrive, asideSaid.op], [true, true, 'side', null, aside.seq, '◷', 'side', false], JSON.stringify(aside));
  assert.ok(rows().at(-1).endsWith('a web page on vote.example.com, in their side bar, beside the operator\'s'), rows().at(-1));
  const opStill = (await act(ctl, 'page:status', { code: hall })).board;
  assert.deepEqual([opStill.info.seq, opStill.info.op, opStill.beside.seq, opStill.beside.mark, opStill.beside.arrive], [opWeb.seq, true, aside.seq, '◷', 'side'], 'the operator\'s still over the show, Sue\'s beside it');
  // Gil's page is told it in its own place, arriving in his side bar; his report on it counts, as any take's.
  await until(() => layerTakes(gil, 'beside').some((x) => x.seq === aside.seq), 4000, 'Gil told it beside the operator\'s');
  const asideTold = layerTakes(gil, 'beside').find((x) => x.seq === aside.seq);
  assert.deepEqual([asideTold.content, asideTold.arrive, asideTold.by], [{ kind: 'web', url: VOTE, host: 'vote.example.com' }, 'side', { name: 'Sue Staff' }]);
  assert.deepEqual(await act(gil, 'page:report', { seq: aside.seq, state: 'opened', words: 'in the side bar' }), { ok: true });
  assert.deepEqual(await act(gil, 'page:report', { seq: opWeb.seq, state: 'opened' }), { ok: true });
  const besideRead = (await act(suePage, 'page:status', { code: hall })).board;
  assert.deepEqual([besideRead.beside.mark, besideRead.beside.on, besideRead.beside.pages, besideRead.info.mark], ['◇', 1, 1, '◇'], 'each read from Gil\'s report on it');
  // Take down: refused over the operator's, and needs the take it names; Sue's own beside it, by its number, taken down
  // there alone, the operator's left over the show, and Gil's Earlier told it.
  assert.deepEqual(await act(suePage, 'page:push', { code: hall, to: 'board', content: { kind: 'chat', layer: 'info' }, ifSeq: opWeb.seq }), { ok: false, error: OPERATOR });
  assert.deepEqual(await act(suePage, 'page:push', { code: hall, to: 'board', content: { kind: 'chat', layer: 'info' } }), { ok: false, error: 'Take down names the take it takes down.' });
  const asideDown = await act(suePage, 'page:push', { code: hall, to: 'board', content: { kind: 'chat', layer: 'info' }, ifSeq: aside.seq });
  assert.deepEqual([asideDown.ok, asideDown.results[0].status.words], [true, 'Nothing in their side bar'], JSON.stringify(asideDown));
  assert.ok(rows().at(-1).endsWith('the information taken down, from their side bar'), rows().at(-1));
  const afterAside = (await act(ctl, 'page:status', { code: hall })).board;
  assert.deepEqual([afterAside.info.seq, afterAside.beside], [opWeb.seq, undefined]);
  await until(() => layerTakes(gil, 'beside').some((x) => x.seq === 0 && x.content === null), 4000, 'Gil told nothing is beside it');
  await until(() => layerTakes(gil, 'info').some((x) => x.earlier && x.earlier[0] && x.earlier[0].seq === aside.seq), 4000, 'Gil told it in his side bar\'s Earlier');
  assert.equal((await act(ctl, 'page:push', { code: hall, to: 'board', content: { kind: 'chat', layer: 'info' }, ifSeq: opWeb.seq })).ok, true, 'the operator takes its own down');
  const salOwn = await act(suePage, 'page:push', { code: hall, to: 'board', content: { kind: 'web', url: VOTE } });
  const benOver = await act(suePage, 'page:push', { code: hall, to: 'board', content: { kind: 'web', url: NEWS } });
  // The operator's web page on Gil's pages alone, while the Board's own is Sue's: her push over the Board, and her Take
  // down of the Board's, would put it away there, so each is refused; her side bar is taken; the operator's stays.
  const gilOp = await act(ctl, 'page:push', { code: hall, to: { uid: 'u:' + joins.gil.uid }, content: { kind: 'web', url: VOTE } });
  assert.equal(gilOp.ok, true, JSON.stringify(gilOp));
  assert.deepEqual(await act(suePage, 'page:push', { code: hall, to: 'board', content: { kind: 'web', url: NEWS } }), { ok: false, error: OPERATOR });
  assert.deepEqual(await act(suePage, 'page:push', { code: hall, to: 'board', content: { kind: 'chat', layer: 'info' }, ifSeq: benOver.seq }), { ok: false, error: OPERATOR });
  assert.deepEqual(await act(suePage, 'page:push', { code: hall, to: { uid: 'u:' + joins.gil.uid }, content: { kind: 'web', url: NEWS } }), { ok: false, error: OPERATOR }, 'nor over it on Gil\'s pages');
  const besideGil = await act(suePage, 'page:push', { code: hall, to: 'board', content: { kind: 'web', url: NEWS }, arrive: 'side' });
  assert.deepEqual([besideGil.ok, besideGil.aside], [true, true]);
  const gilRow = (await act(ctl, 'page:status', { code: hall })).people.find((x) => x.uid === 'u:' + joins.gil.uid);
  assert.deepEqual([gilRow.info.seq, gilRow.info.op, gilRow.beside.seq], [gilOp.seq, true, besideGil.seq], 'the operator\'s still on Gil\'s pages, Sue\'s beside it');
  assert.equal((await act(suePage, 'page:push', { code: hall, to: 'board', content: { kind: 'chat', layer: 'info' }, ifSeq: besideGil.seq })).ok, true, 'hers beside it, taken down');
  assert.equal((await act(ctl, 'page:push', { code: hall, to: { uid: 'u:' + joins.gil.uid }, content: { kind: 'chat', layer: 'info' }, ifSeq: gilOp.seq })).ok, true, 'the operator takes its own down from Gil\'s pages');
  assert.deepEqual(await act(suePage, 'page:push', { code: hall, to: 'board', content: { kind: 'chat', layer: 'info' }, ifSeq: salOwn.seq }), { ok: false, error: 'Sue Staff\'s web page is up now — yours was already replaced.' });
  const down = await act(suePage, 'page:push', { code: hall, to: 'board', content: { kind: 'chat', layer: 'info' }, ifSeq: benOver.seq });
  assert.deepEqual([down.ok, down.results[0].status.words, down.results[0].status.showing], [true, 'Nothing over the show', 'the information taken down']);
  assert.equal(rows().at(-1), 'the Board (1 page) → the information taken down');
  assert.equal((await act(ctl, 'page:status', { code: hall })).board.seq, clock.seq, 'the clock stays the Board\'s');

  // A side room reaches the Board only from the Main room's list: Sue's Legal page, refused for every kind, the take-down
  // included; once Legal is on the list, her Legal page shows.
  for (const content of [{ kind: 'web', url: NEWS }, { kind: 'chat', layer: 'info' }, { kind: 'clock' }]) {
    assert.deepEqual(await act(sueLegal, 'page:push', { code: hall, to: 'board', content, ifSeq: down.seq }), { ok: false, error: OFF_LIST }, JSON.stringify(content));
  }
  assert.deepEqual(await act(sueLegal, 'page:status', { code: hall }), { ok: false, error: OFF_LIST }, 'and reads no console from there');
  assert.equal((await act(ctl, 'room:update', { code: hall, sendFrom: [LEGAL] })).ok, true);
  const listedNow = await act(sueLegal, 'page:push', { code: hall, to: 'board', content: { kind: 'web', url: NEWS } });
  assert.equal(listedNow.ok, true, JSON.stringify(listedNow));
  assert.equal((await act(sueLegal, 'page:push', { code: hall, to: 'board', content: { kind: 'chat', layer: 'info' }, ifSeq: listedNow.seq })).ok, true);
  assert.equal((await act(ctl, 'room:update', { code: hall, sendFrom: [] })).ok, true);
  assert.deepEqual(await act(sueLegal, 'page:push', { code: hall, to: 'board', content: { kind: 'web', url: NEWS } }), { ok: false, error: OFF_LIST }, 'off the list again');

  // Held under blank: the operator's blank keeps the tablet dark; the information over it is held, said with words.
  const blank = await act(ctl, 'page:push', { code: hall, to: 'board', content: { kind: 'blank' } });
  const heldWeb = await act(suePage, 'page:push', { code: hall, to: 'board', content: { kind: 'web', url: VOTE } });
  assert.deepEqual(await act(gil, 'page:report', { seq: blank.seq, state: 'shown' }), { ok: true });
  assert.deepEqual(await act(gil, 'page:report', { seq: heldWeb.seq, state: 'hidden', words: 'held under blank' }), { ok: true });
  const held = (await act(ctl, 'page:status', { code: hall })).board;
  assert.deepEqual([held.kind, held.mark, held.info.mark, held.info.words], ['blank', '✓', '◐', 'Held under blank']);
  // A hand-back of both clears both, with one number; Earlier holds what was taken off, bounded, the newest first.
  const both = await act(ctl, 'page:push', { code: hall, to: 'board', content: { kind: 'chat' } });
  const after = (await act(ctl, 'page:status', { code: hall })).board;
  assert.deepEqual([after.seq, after.kind, after.info.seq, after.info.words], [both.seq, 'chat', both.seq, 'Nothing over the show']);
  const gilAgain = await page(undefined, 'Gil, joined again');
  const rejoin = await joined(gilAgain, { roomCode: hall, name: 'Gil', role: 'board', uid: joins.gil.identity });
  assert.equal(rejoin.over, null, 'nothing over the show');
  // In the order they were taken off, the last first (a take put away with Back to chat joins it then, whatever its number).
  assert.deepEqual(rejoin.earlier.slice(0, 2).map((e) => e.seq), [heldWeb.seq, listedNow.seq], 'the last taken off first');
  assert.ok(rejoin.earlier.length <= 10);
  assert.ok(rejoin.earlier.every((e) => e.content.kind === 'web' && Object.keys(e).join() === 'seq,content,by,at'));
  assert.equal(rejoin.beside, null, 'nothing beside it');
  // A page that joins is told what is beside the operator's (`beside`), after Earlier, as `over` is told.
  const opLast = await act(ctl, 'page:push', { code: hall, to: 'board', content: { kind: 'web', url: VOTE } });
  const asideLast = await act(suePage, 'page:push', { code: hall, to: 'board', content: { kind: 'web', url: NEWS }, arrive: 'side' });
  assert.deepEqual([opLast.ok, asideLast.aside], [true, true]);
  const gilLast = await page(undefined, 'Gil, joined once more');
  const last = await joined(gilLast, { roomCode: hall, name: 'Gil', role: 'board', uid: joins.gil.identity });
  assert.deepEqual([last.over.seq, last.over.layer, last.beside.seq, last.beside.layer, last.beside.arrive, last.beside.content], [opLast.seq, 'info', asideLast.seq, 'beside', 'side', { kind: 'web', url: NEWS, host: 'news.example.org' }]);
  const lastKeys = Object.keys(last);
  assert.deepEqual(lastKeys.slice(lastKeys.indexOf('canShow'), lastKeys.indexOf('canShow') + 4), ['canShow', 'over', 'earlier', 'beside']);
});

// A document and a picture on the stage (plan 4-§5.9.3, §5.9.5, §5.9.7, §5.10.3, §5.11): a file the hall holds shown
// as a take of its own kind, by where it may come from, its name the server's; "sending" until each page reports; Download
// kept only when ticked; never a document to an observer, nor its address told to a page seated as one; the pixel and
// archive checks at a file's first take; a fresh upload kept as the hall's stage file; Withdraw by its pusher, the
// operator or the admin, from every page and Earlier; one row per target, never a file's name.
test('a document and a picture on the stage: by where the file may come from, its name the server\'s, confirmed page by page, Download only when ticked, never a document to an observer, the checks at a first take, Withdraw', { timeout: 120_000 }, async (t) => {
  const { officeZip, wordParts } = require('./helpers');
  let srv = await startServer();
  t.after(() => stopServer(srv.child));
  const sockets = [];
  t.after(() => sockets.forEach((s) => s.close()));
  const heard = new Map();
  const page = async (cookie, who) => {
    const s = await connect(srv.base, cookie);
    sockets.push(s);
    heard.set(s, []);
    s.onAny((ev, ...args) => heard.get(s).push([ev, args[0]]));
    s.who = who;
    return s;
  };
  const info = (s) => heard.get(s).filter(([ev, v]) => ev === 'page:take' && v.layer === 'info').map(([, v]) => v);
  const withdrawals = (s) => heard.get(s).filter(([ev, v]) => ev === 'page:take' && Number.isInteger(v.withdrawn)).map(([, v]) => v);
  const joined = async (s, args) => { const r = await emit(s, 'join', invited(srv.dataDir, args)); assert.equal(r.ok, true, s.who + ': ' + JSON.stringify(r)); return r; };
  const upload = async (token, name, bytes, type) => {
    const f = new FormData();
    f.append('file', new Blob([bytes], { type }), name);
    const r = await fetch(srv.base + '/api/upload', { method: 'POST', headers: { 'X-AGM-Upload': token }, body: f });
    return { status: r.status, ...(await r.json()) };
  };
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n', 'latin1');
  /** A JPEG's header alone, its frame `w` × `h` (lib/imagesize.js reads its size from it; nothing decodes it here). */
  const jpeg = (w, h) => Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]);

  const admin = (await api(srv.base, 'POST', '/api/setup', { token: TOKEN, username: 'ana', name: 'Ana Admin', password: 'the green room kettle' })).cookie;
  const hall = (await api(srv.base, 'POST', '/api/rooms', { name: 'Hall 4' }, { cookie: admin })).body.code;
  const ctl = await page(admin, 'the admin page');
  await joined(ctl, { roomCode: hall, as: 'account' });
  const LEGAL = (await act(ctl, 'room:create', { hall, name: 'Legal' })).key;
  const account = async (username, name, role, extra) => {
    const made = await api(srv.base, 'POST', '/api/users', { username, name, role, password: PASSWORD, ...extra }, { cookie: admin });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    return (await api(srv.base, 'POST', '/api/auth/login', { username, password: PASSWORD })).cookie;
  };
  const sueCookie = await account('sue', 'Sue Staff', 'staff', { halls: [hall], rooms: [LEGAL] });   // stage.show: shows by a right of its own
  const sidCookie = await account('sid', 'Sid Staff', 'staff', { halls: [hall] });
  const tomCookie = await account('tom', 'Tom Tech', 'tech', { halls: [hall] });   // display.control: the operator
  const sue = await page(sueCookie, 'Sue backstage');
  const sueJoin = await joined(sue, { roomCode: hall, as: 'account' });
  const sueLegal = await page(sueCookie, 'Sue in Legal');
  const sueLegalJoin = await joined(sueLegal, { roomCode: LEGAL, as: 'account' });
  const sid = await page(sidCookie, 'Sid backstage');
  await joined(sid, { roomCode: hall, as: 'account' });
  const tom = await page(tomCookie, 'Tom backstage');
  const tomJoin = await joined(tom, { roomCode: hall, as: 'account' });
  const gil = await page(undefined, 'Gil On stage');
  const gilJoin = await joined(gil, { roomCode: hall, name: 'Gil', role: 'board' });
  const kim = await page(undefined, 'Kim On stage');
  await joined(kim, { roomCode: hall, name: 'Kim', role: 'board' });
  const oli = await page(undefined, 'Oli observing');
  const oliJoin = await joined(oli, { roomCode: hall, name: 'Oli', role: 'observer' });
  const rex = await page(undefined, 'Rex backstage');
  const rexJoin = await joined(rex, { roomCode: hall, name: 'Rex', role: 'research' });
  assert.deepEqual([sueJoin.canShow, tomJoin.canPush], [true, true]);

  // A PDF shared in Main, then posted again under another name: the take names the file as its first message did.
  const up = await upload(sueJoin.uploadToken, 'Board pack.pdf', pdf, 'application/pdf');
  assert.equal(up.status, 200, JSON.stringify(up));
  assert.equal((await act(sue, 'message', { type: 'file', url: up.url, filename: 'Board pack.pdf', mime: 'application/pdf' })).ok, true);
  assert.equal((await act(sue, 'message', { type: 'file', url: up.url, filename: 'Final approved budget.pdf', mime: 'application/pdf' })).ok, true);
  const pushed = await act(sue, 'page:push', { code: hall, to: 'board', content: { kind: 'doc', url: up.url, name: 'Final approved budget.pdf', at: { page: 2 } } });
  assert.deepEqual([pushed.ok, pushed.results[0].status.mark, pushed.results[0].status.words, pushed.results[0].status.pages, pushed.results[0].status.showing], [true, '◷', 'Sending', 2, 'Board pack.pdf at p. 2'], JSON.stringify(pushed));
  const docContent = { kind: 'doc', url: up.url, name: 'Board pack.pdf', at: { page: 2 }, download: false };
  await until(() => info(gil).some((x) => x.seq === pushed.seq) && info(kim).some((x) => x.seq === pushed.seq), 4000, 'the Board\'s pages told the document');
  for (const s of [gil, kim]) assert.deepEqual(info(s).find((x) => x.seq === pushed.seq).content, docContent, s.who);
  await wait(300);
  for (const s of [sue, tom, oli, rex, ctl]) assert.ok(!info(s).some((x) => x.seq === pushed.seq), s.who + ' is not On stage: not told');
  // ✓ only once each Board page said it drew it.
  const boardInfo = async () => (await act(tom, 'page:status', { code: hall })).board.info;
  assert.ok((await act(gil, 'page:report', { seq: pushed.seq, state: 'shown' })).ok);
  assert.deepEqual([(await boardInfo()).mark, (await boardInfo()).words], ['◷', 'Sending · on 1 of 2 pages']);
  assert.ok((await act(kim, 'page:report', { seq: pushed.seq, state: 'shown' })).ok);
  assert.deepEqual([(await boardInfo()).mark, (await boardInfo()).words], ['✓', 'On all 2 Board pages']);
  // The row: whom, how many pages, the file's kind and place, never its name.
  const rows = () => rowsOf(srv.dataDir).filter(([h]) => h === hall);
  assert.deepEqual(rows().at(-1), [hall, 'the Board (2 pages) → a PDF at p. 2', 'sue']);
  // Download ticked is kept; anything else is no Download.
  const ticked = await act(sue, 'page:push', { code: hall, to: 'board', content: { kind: 'doc', url: up.url, download: true } });
  assert.equal(ticked.ok, true, JSON.stringify(ticked));
  await until(() => info(gil).some((x) => x.seq === ticked.seq), 4000, 'told');
  assert.equal(info(gil).find((x) => x.seq === ticked.seq).content.download, true);
  const kept = () => JSON.parse(fs.readFileSync(path.join(srv.dataDir, 'pages.json'), 'utf8')).halls[hall];
  await until(() => fs.existsSync(path.join(srv.dataDir, 'pages.json')) && kept().board.info.seq === ticked.seq, 4000, 'saved');
  assert.equal(kept().board.info.content.download, true);
  // The first is under Earlier now, told to each Board page as a Look.
  assert.deepEqual(info(gil).find((x) => x.seq === ticked.seq).earlier.map((e) => [e.seq, e.content.kind, e.content.name]), [[pushed.seq, 'doc', 'Board pack.pdf']]);

  // Never a document to a person seated as an observer; a picture, yes.
  assert.deepEqual(await act(tom, 'page:push', { code: hall, to: { uid: 'u:' + oliJoin.uid }, content: { kind: 'doc', url: up.url } }), { ok: false, error: 'Observers are shown pictures and quotes, not documents.' });
  const png = await upload(tomJoin.uploadToken, 'Stage plan.png', pngOf(40, 30), 'image/png');
  assert.equal((await act(tom, 'message', { type: 'file', url: png.url, filename: 'Stage plan.png', mime: 'image/png' })).ok, true);
  const toOli = await act(tom, 'page:push', { code: hall, to: { uid: 'u:' + oliJoin.uid }, content: { kind: 'image', url: png.url } });
  assert.equal(toOli.ok, true, JSON.stringify(toOli));
  await until(() => info(oli).some((x) => x.seq === toOli.seq), 4000, 'Oli told the picture');
  assert.deepEqual(info(oli).find((x) => x.seq === toOli.seq).content, { kind: 'image', url: png.url, name: 'Stage plan.png' });
  // Pat backstage in Main and observing in Legal, a room Tom cannot read: a person's take reaches every page of theirs, so
  // a document to Pat is refused all the same, in the same words.
  const pat = await page(undefined, 'Pat backstage');
  const patJoin = await joined(pat, { roomCode: hall, name: 'Pat', role: 'research' });
  assert.equal((await act(ctl, 'room:update', { code: LEGAL, codeOn: true })).ok, true);
  const patLegal = await page(undefined, 'Pat observing in Legal');
  const legalCode = (await new Promise((r) => { ctl.emit('admin:listRooms', r); })).rooms.find((h) => h.code === hall).side[0].guestCode;
  await joined(patLegal, { roomCode: legalCode, name: 'Pat', role: 'observer', uid: patJoin.identity });
  assert.deepEqual(await act(tom, 'page:push', { code: hall, to: { uid: 'u:' + patJoin.uid }, content: { kind: 'doc', url: up.url } }), { ok: false, error: 'Observers are shown pictures and quotes, not documents.' });
  pat.close();
  patLegal.close();
  assert.equal((await act(ctl, 'room:update', { code: LEGAL, codeOn: false })).ok, true);
  // A document to Rex backstage, then Rex seated as an observer: his page is told it without its address, and so is his join.
  const toRex = await act(tom, 'page:push', { code: hall, to: { uid: 'u:' + rexJoin.uid }, content: { kind: 'doc', url: up.url } });
  assert.equal(toRex.ok, true, JSON.stringify(toRex));
  await until(() => info(rex).some((x) => x.seq === toRex.seq && x.content.url === up.url), 4000, 'Rex told the document');
  const rexSid = (await act(ctl, 'admin:watchRoom', { roomCode: hall })).users.find((u) => u.name === 'Rex').socketId;
  assert.equal((await act(ctl, 'admin:setRole', { roomCode: hall, socketId: rexSid, role: 'observer' })).ok, true);
  await until(() => info(rex).some((x) => x.seq === toRex.seq && x.content.withheld === true), 4000, 'Rex told it withheld');
  assert.deepEqual(info(rex).at(-1).content, { kind: 'doc', name: 'Board pack.pdf', withheld: true });
  const rexBack = await page(undefined, 'Rex again');
  const rexAgain = await joined(rexBack, { roomCode: hall, name: 'Rex', role: 'observer', uid: rexJoin.identity });
  assert.ok(!JSON.stringify(rexAgain.over).includes('/uploads/') && rexAgain.over.content.withheld === true, JSON.stringify(rexAgain.over));

  // A picture over what the Board's devices draw is refused at its take (40 MP), as a picture and as a document alike.
  const big = await upload(tomJoin.uploadToken, 'crowd.jpg', jpeg(8000, 6250), 'image/jpeg');
  assert.equal(big.status, 200, JSON.stringify(big));
  assert.equal((await act(tom, 'message', { type: 'file', url: big.url, filename: 'crowd.jpg', mime: 'image/jpeg' })).ok, true);
  for (const kind of ['image', 'doc']) assert.deepEqual(await act(tom, 'page:push', { code: hall, to: 'board', content: { kind, url: big.url } }), { ok: false, error: 'Too large for the Board\'s devices — send a region.' }, kind);

  // A fresh upload of the pusher's own is shown, and kept as the hall's stage file; another's is refused; one made from a
  // Legal page is refused while Legal is off Main's list, naming Legal, and shown once it is on.
  const fresh = await upload(sueJoin.uploadToken, 'p2.png', pngOf(20, 20), 'image/png');
  assert.deepEqual(await act(tom, 'page:push', { code: hall, to: 'board', content: { kind: 'image', url: fresh.url } }), { ok: false, error: 'That file is in no room of this hall you can read — share it there first.' });
  const pic = await act(sue, 'page:push', { code: hall, to: 'board', content: { kind: 'image', url: fresh.url, from: { url: up.url, at: { page: 2 } } } });
  assert.equal(pic.ok, true, JSON.stringify(pic));
  assert.equal(pic.results[0].status.showing, 'Sue Staff\'s picture of Board pack.pdf, p. 2');
  assert.deepEqual(rows().at(-1), [hall, 'the Board (2 pages) → a picture of a PDF page (p. 2)', 'sue']);
  await until(() => kept().files && kept().files[fresh.url.slice(9)], 4000, 'the stage file kept');
  assert.deepEqual(kept().files[fresh.url.slice(9)], { at: kept().files[fresh.url.slice(9)].at, room: hall, uid: kept().files[fresh.url.slice(9)].uid, name: 'p2.png', named: true });
  const legalPic = await upload(sueLegalJoin.uploadToken, 'legal.png', pngOf(10, 10), 'image/png');
  assert.deepEqual(await act(sue, 'page:push', { code: hall, to: 'board', content: { kind: 'image', url: legalPic.url } }), { ok: false, error: 'That file belongs to Legal, which may not send into the Main room — send it there first, or ask an admin.' });
  assert.equal((await act(ctl, 'room:update', { code: hall, sendFrom: [LEGAL] })).ok, true);
  const fromLegal = await act(sue, 'page:push', { code: hall, to: 'board', content: { kind: 'image', url: legalPic.url } });
  assert.equal(fromLegal.ok, true, JSON.stringify(fromLegal));
  assert.equal(fromLegal.results[0].status.showing, 'legal.png in Legal');

  // Withdraw: refused to a seat that may only show for a take it did not put up; by its pusher, from every Board page and
  // from Earlier, each told; one row; asked again, done.
  assert.deepEqual(await act(sid, 'page:withdraw', { code: hall, seq: pushed.seq }), { ok: false, error: 'Only who showed it, the operator or the admin can withdraw it.' });
  const before = withdrawals(gil).length;
  assert.deepEqual(await act(sue, 'page:withdraw', { code: hall, seq: pushed.seq }), { ok: true, withdrawn: pushed.seq, words: 'Withdrawn from 2 Board pages — it is no longer under Earlier.' });
  await until(() => withdrawals(gil).length > before && withdrawals(kim).some((x) => x.withdrawn === pushed.seq), 4000, 'each Board page told');
  assert.deepEqual(withdrawals(gil).at(-1), { withdrawn: pushed.seq });
  assert.deepEqual(rows().at(-1), [hall, 'the Board (2 pages) → a PDF at p. 2, withdrawn', 'sue']);
  assert.deepEqual(await act(sue, 'page:withdraw', { code: hall, seq: pushed.seq }), { ok: true, already: true, withdrawn: pushed.seq });
  const gilBack = await page(undefined, 'Gil again');
  const gilAgain = await joined(gilBack, { roomCode: hall, name: 'Gil', role: 'board', uid: gilJoin.identity });
  assert.ok(!gilAgain.earlier.some((e) => e.seq === pushed.seq), 'no longer under Earlier');
  // The operator withdraws a researcher's take; a take that is no information, or none, is not one to withdraw.
  assert.equal((await act(tom, 'page:withdraw', { code: hall, seq: fromLegal.seq })).ok, true);
  const clock = await act(tom, 'page:push', { code: hall, to: 'board', content: { kind: 'clock' } });
  assert.deepEqual(await act(tom, 'page:withdraw', { code: hall, seq: clock.seq }), { ok: false, error: 'That is not on anyone\'s pages or under Earlier now.' });
  assert.deepEqual(await act(tom, 'page:withdraw', { code: hall, seq: 'x' }), { ok: false, error: 'Withdraw names the take it withdraws.' });
  assert.deepEqual(await act(gil, 'page:withdraw', { code: hall, seq: ticked.seq }), { ok: false, error: 'Do that from a backstage page.' });
  assert.equal((await act(ctl, 'page:withdraw', { code: hall, seq: ticked.seq })).ok, true, 'the admin');

  // A Word file that never had its check (one shared before the checks, or before a restart: its file swapped here for one
  // with a macro part) has it at its first take, and is refused in its words.
  const word = officeZip(wordParts({ body: '<w:p><w:r><w:t>Minutes</w:t></w:r></w:p>' }));
  const docx = await upload(sueJoin.uploadToken, 'minutes.docx', word, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(docx.status, 200, JSON.stringify(docx));
  assert.equal((await act(sue, 'message', { type: 'file', url: docx.url, filename: 'Minutes.docx' })).ok, true);
  const twice = await upload(tomJoin.uploadToken, 'twice.png', pngOf(12, 12), 'image/png');
  assert.equal((await act(tom, 'message', { type: 'file', url: twice.url, filename: 'twice.png', mime: 'image/png' })).ok, true);
  srv = await restartServer(srv);
  fs.writeFileSync(path.join(srv.dataDir + '-uploads', docx.url.slice(9)), officeZip({ ...wordParts({ body: '<w:p/>' }), 'word/vbaProject.bin': Buffer.from('macro') }));
  const tomAfter = await page(tomCookie, 'Tom after the restart');
  await joined(tomAfter, { roomCode: hall, as: 'account' });
  assert.deepEqual(await act(tomAfter, 'page:push', { code: hall, to: 'board', content: { kind: 'doc', url: docx.url } }), { ok: false, error: 'That file carries macros. Save it without them, or as a PDF.' });
  // A push sent again while the first is still being made (its picture's first check this run under way, off the socket's
  // turn) waits for it and is answered with what it did: one take, one row.
  const rowsBefore = rows().length;
  const asked = { code: hall, to: 'board', content: { kind: 'image', url: twice.url }, cid: 'twice-1' };
  const [once, again] = await Promise.all([act(tomAfter, 'page:push', asked), act(tomAfter, 'page:push', asked)]);
  assert.equal(once.ok, true, JSON.stringify(once));
  assert.deepEqual(again, once);
  assert.equal(rows().length, rowsBefore + 1, 'one row');
  assert.deepEqual(await act(tomAfter, 'page:push', asked), once, 'and once it is made, from what it kept');
  for (const [, words] of rows()) assert.ok(!/Board pack|Minutes|Stage plan|p2\.png|legal\.png|\/uploads\//.test(words), words);
});

test('a quote on the stage: words or cells picked from a file of the hall, carried as data, named by the file and its place and never its address; typed, or from a web page by its host, its address told the Board\'s pages only from a pusher who may show a web page; refused over its bounds; the console\'s words and the row\'s; nothing of it in the context or the Show Bus; the AI told what the Board\'s pages show, a quote\'s words only to who pushed it', { timeout: 120_000 }, async (t) => {
  const http = require('http');
  // A stand-in for the AI's endpoint (the SDK's ANTHROPIC_BASE_URL): every request's body kept, a draft answered.
  const bodies = [];
  const model = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => {
      bodies.push(b);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'x', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ draft: 'Yes.', gaps: [], confidence: 'high' }) }], usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  });
  await new Promise((resolve) => { model.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise((resolve) => { model.close(resolve); }));
  const srv = await startServer({ ANTHROPIC_API_KEY: 'a-key-for-the-fake-model', ANTHROPIC_BASE_URL: 'http://127.0.0.1:' + model.address().port });
  t.after(() => stopServer(srv.child));
  const sockets = [];
  t.after(() => sockets.forEach((s) => s.close()));
  const heard = new Map();
  const page = async (cookie, who) => {
    const s = await connect(srv.base, cookie);
    sockets.push(s);
    heard.set(s, []);
    s.onAny((ev, ...args) => heard.get(s).push([ev, args[0]]));
    s.who = who;
    return s;
  };
  const info = (s) => heard.get(s).filter(([ev, v]) => ev === 'page:take' && v.layer === 'info').map(([, v]) => v);
  const joined = async (s, args) => { const r = await emit(s, 'join', invited(srv.dataDir, args)); assert.equal(r.ok, true, s.who + ': ' + JSON.stringify(r)); return r; };
  const admin = (await api(srv.base, 'POST', '/api/setup', { token: TOKEN, username: 'ana', name: 'Ana Admin', password: 'the green room kettle' })).cookie;
  const hall = (await api(srv.base, 'POST', '/api/rooms', { name: 'Hall 5' }, { cookie: admin })).body.code;
  const ctl = await page(admin, 'the admin page');
  await joined(ctl, { roomCode: hall, as: 'account' });
  const LEGAL = (await act(ctl, 'room:create', { hall, name: 'Legal' })).key;
  // The hall's own Stagewatch, so the context posted to it is read beside the node's.
  const sw = await fakeStagewatch({ name: 'Hall 5 timer' });
  t.after(() => sw.close());
  assert.equal((await act(ctl, 'hall:configure', { code: hall, stagewatchUrl: sw.url, stagewatchKey: 'swk_hall5_node_key_0001' })).ok, true);   // secret-scan: fixture
  const posted = () => sw.requests.filter((r) => r.url === '/api/peers/context').map((r) => r.body);
  await until(() => posted().length > 0, 8000, 'the hall\'s Stagewatch linked, its key accepted');
  const account = async (username, name, role, extra) => {
    assert.equal((await api(srv.base, 'POST', '/api/users', { username, name, role, password: PASSWORD, ...extra }, { cookie: admin })).status, 200);
    return (await api(srv.base, 'POST', '/api/auth/login', { username, password: PASSWORD })).cookie;
  };
  const sueCookie = await account('sue', 'Sue Staff', 'staff', { halls: [hall], rooms: [LEGAL] });   // stage.show: shows by a right of its own
  const tomCookie = await account('tom', 'Tom Tech', 'tech', { halls: [hall] });   // display.control: the operator
  const sue = await page(sueCookie, 'Sue backstage');
  const sueJoin = await joined(sue, { roomCode: hall, as: 'account' });
  const sueLegal = await page(sueCookie, 'Sue in Legal');
  await joined(sueLegal, { roomCode: LEGAL, as: 'account' });
  const tom = await page(tomCookie, 'Tom backstage');
  await joined(tom, { roomCode: hall, as: 'account' });
  const gil = await page(undefined, 'Gil On stage');
  await joined(gil, { roomCode: hall, name: 'Gil', role: 'board' });
  assert.equal(sueJoin.canShow, true);

  // A CSV shared in Main; a cell of it picked and shown, with its labels: the take names the file by its name and the
  // cell by its place, and no page is told the file's address.
  const f = new FormData();
  f.append('file', new Blob(['Item,Q3\nRevenue,4.2\n'], { type: 'text/csv' }), 'Q3 costs.csv');
  const up = await (await fetch(srv.base + '/api/upload', { method: 'POST', headers: { 'X-AGM-Upload': sueJoin.uploadToken }, body: f })).json();
  assert.ok(typeof up.url === 'string', JSON.stringify(up));
  assert.equal((await act(sue, 'message', { type: 'file', url: up.url, filename: 'Q3 costs.csv', mime: 'text/csv' })).ok, true);
  const cell = { kind: 'snippet', unit: 'cell', table: { rows: [['Item', 'Q3'], ['Revenue', '4.2']], head: 1, side: 1, ref: 'B2', focus: [1, 1] }, from: { url: up.url, at: { line: 2, ref: 'B2' } } };
  const pushed = await act(sue, 'page:push', { code: hall, to: 'board', content: cell });
  assert.deepEqual([pushed.ok, pushed.results[0].status.showing, pushed.results[0].status.kind], [true, '❝ a table cell from Q3 costs.csv, B2', 'snippet'], JSON.stringify(pushed));
  await until(() => info(gil).some((x) => x.seq === pushed.seq), 4000, 'the Board\'s page told the quote');
  const told = info(gil).find((x) => x.seq === pushed.seq);
  assert.deepEqual(told.content, { kind: 'snippet', unit: 'cell', table: { rows: [['Item', 'Q3'], ['Revenue', '4.2']], head: 1, side: 1, ref: 'B2', focus: [1, 1] }, from: { name: 'Q3 costs.csv', type: 'csv', at: { line: 2, ref: 'B2' } } });
  assert.ok(!JSON.stringify(info(gil)).includes(up.url.slice(9)), 'no take tells the Board\'s page the file\'s address');
  assert.ok((await act(gil, 'page:report', { seq: pushed.seq, state: 'shown' })).ok);
  assert.deepEqual([(await act(tom, 'page:status', { code: hall })).board.info.mark, (await act(tom, 'page:status', { code: hall })).board.info.showing], ['✓', '❝ a table cell from Q3 costs.csv, B2']);
  const rows = () => rowsOf(srv.dataDir).filter(([h]) => h === hall);
  assert.deepEqual(rows().at(-1), [hall, 'the Board (1 page) → a quote (a table cell, 3 characters) from a table', 'sue']);
  // Kept by the file's name and place, never its address.
  const onDisk = () => fs.readFileSync(path.join(srv.dataDir, 'pages.json'), 'utf8');
  await until(() => fs.existsSync(path.join(srv.dataDir, 'pages.json')) && JSON.parse(onDisk()).halls[hall].board.info.seq === pushed.seq, 4000, 'saved');
  assert.ok(!onDisk().includes(up.url.slice(9)), 'pages.json holds no quote\'s file address');

  // Typed: no source but who typed it. From a web page: its host, its address sealed at rest and told to no page.
  const typed = await act(sue, 'page:push', { code: hall, to: 'board', content: { kind: 'snippet', unit: 'text', text: 'Revenue Q3: £4.2m' } });
  assert.equal(typed.results[0].status.showing, '❝ a quote typed by Sue Staff (17 characters)');
  assert.deepEqual(rows().at(-1), [hall, 'the Board (1 page) → a quote (typed, 17 characters)', 'sue']);
  // Nothing of a quote on the Board's pages (its words, its cells, its file's name) is in the context, the node's or the
  // one posted to the hall's Stagewatch, while it is up: two posts made after it are read.
  const before = posted().length;
  await until(() => posted().length >= before + 2, 15000, 'the context posted to the hall\'s Stagewatch twice more');
  const contexts = [...posted(), JSON.stringify((await api(srv.base, 'GET', '/api/context', undefined, { cookie: admin })).body)];
  for (const body of contexts) for (const words of ['Revenue', '£4.2m', 'Q3 costs', 'costs.csv']) assert.ok(!body.includes(words), 'the context carries no quote: ' + words + ' in ' + body);
  // A quote from a web page, by a pusher who may show a web page (Tom: stage.web by his preset): the Board's page is told
  // the address, its fragment kept, for Open the source; at rest it is sealed; the console, the row and the context name
  // its host alone.
  const web = await act(tom, 'page:push', { code: hall, to: 'board', content: { kind: 'snippet', unit: 'text', text: 'Turnout was 64%', from: { web: 'https://vote.example.com/results?token=s3cr3t#q2' } } });
  assert.equal(web.ok, true, JSON.stringify(web));
  assert.equal(web.results[0].status.showing, '❝ a quote from vote.example.com');
  await until(() => info(gil).some((x) => x.seq === web.seq), 4000, 'told');
  assert.deepEqual(info(gil).find((x) => x.seq === web.seq).content.from, { host: 'vote.example.com', url: 'https://vote.example.com/results?token=s3cr3t#q2' });
  await until(() => JSON.parse(onDisk()).halls[hall].board.info.seq === web.seq, 4000, 'saved');
  const keptWeb = JSON.parse(onDisk()).halls[hall].board.info.content.from;
  assert.ok(!onDisk().includes('s3cr3t') && keptWeb.host === 'vote.example.com' && /^enc1:/.test(keptWeb.urlSealed), 'the web page\'s address is kept sealed: ' + JSON.stringify(keptWeb));
  assert.deepEqual(rows().at(-1), [hall, 'the Board (1 page) → a quote from a web page on vote.example.com', 'tom']);
  assert.ok(!JSON.stringify((await act(tom, 'page:status', { code: hall })).board).includes('s3cr3t'), 'the console names its host alone');
  // Over a bound it is refused in words, never cut; nothing is numbered.
  const seqNow = (await act(tom, 'page:status', { code: hall })).board.info.seq;
  assert.deepEqual(await act(tom, 'page:push', { code: hall, to: 'board', content: { kind: 'snippet', unit: 'paragraph', text: 'x'.repeat(1201) } }), { ok: false, error: 'Too long for the stage: 1,200 characters at most (this is 1,201)' });
  assert.deepEqual(await act(tom, 'page:push', { code: hall, to: 'board', content: { kind: 'snippet', unit: 'range', table: { rows: Array.from({ length: 26 }, () => ['1']), head: 0, side: 0 } } }), { ok: false, error: 'Too big for the stage: narrow it to 25 rows × 10 columns' });
  assert.equal((await act(tom, 'page:status', { code: hall })).board.info.seq, seqNow);
  // The operator's quote is theirs to take down; a researcher's goes over the show again after it.
  assert.equal((await act(tom, 'page:push', { code: hall, to: 'board', content: { kind: 'chat', layer: 'info' }, ifSeq: web.seq })).ok, true);
  // The same from Sue, who may show quotes but not web pages (Staff: stage.show, no stage.web): the Board's page is told the
  // host alone, and no address of it is kept, sealed or in clear.
  const named = await act(sue, 'page:push', { code: hall, to: 'board', content: { kind: 'snippet', unit: 'text', text: 'Turnout was 64%', from: { web: 'https://vote.example.com/results?token=n0r1ght' } } });
  assert.equal(named.ok, true, JSON.stringify(named));
  await until(() => info(gil).some((x) => x.seq === named.seq), 4000, 'told');
  const toldNamed = info(gil).find((x) => x.seq === named.seq);
  assert.deepEqual(toldNamed.content.from, { host: 'vote.example.com' });
  assert.ok(!JSON.stringify(heard.get(gil)).includes('n0r1ght'), 'no frame to the Board\'s page carries its address');
  await until(() => JSON.parse(onDisk()).halls[hall].board.info.seq === named.seq, 4000, 'saved');
  assert.deepEqual(JSON.parse(onDisk()).halls[hall].board.info.content.from, { host: 'vote.example.com' }, 'no address kept, sealed or in clear');
  assert.ok(!onDisk().includes('n0r1ght'));
  assert.deepEqual(rows().at(-1), [hall, 'the Board (1 page) → a quote from a web page on vote.example.com', 'sue']);
  // Tom's, taken down and now under the Board's Earlier, keeps its address for the pages it was shown on.
  assert.deepEqual(toldNamed.earlier.find((e) => e.seq === web.seq).content.from, { host: 'vote.example.com', url: 'https://vote.example.com/results?token=s3cr3t#q2' });
  assert.equal((await act(sue, 'page:push', { code: hall, to: 'board', content: { kind: 'chat', layer: 'info' }, ifSeq: named.seq })).ok, true);

  // The AI is told what the Board's pages show, in the console's words, by who may show there and drafts in Main; the
  // quote's own words only to who pushed it; a side room's draft is told none of it.
  const mine = await act(sue, 'page:push', { code: hall, to: 'board', content: { kind: 'snippet', unit: 'text', text: 'Capex rose 8% on plan' } });
  assert.equal(mine.ok, true);
  const drafted = async (s) => { const r = await act(s, 'ai:draft', { question: 'What was capex?' }); assert.equal(r.ok, true, s.who + ': ' + JSON.stringify(r)); return JSON.parse(bodies.at(-1)).messages[0].content; };
  const sueMain = await drafted(sue);
  const tomMain = await drafted(tom);
  const sueSide = await drafted(sueLegal);
  assert.ok(sueMain.includes('On the Board\'s pages now: ❝ a quote typed by Sue Staff (21 characters) — Capex rose 8% on plan'), sueMain);
  assert.ok(tomMain.includes('On the Board\'s pages now: ❝ a quote typed by Sue Staff (21 characters)') && !tomMain.includes('Capex rose 8%'), 'another pusher\'s words are not in it: ' + tomMain);
  assert.ok(!sueSide.includes('On the Board\'s pages now') && !sueSide.includes('Capex rose 8%'), 'a side room\'s draft is told none of it: ' + sueSide);
});

test('the Board\'s devices: a page joins with `docs` only when it says true; page:status counts the target\'s pages without it; a document\'s stand-in is kept, checked and kept as a stage file, and a page that drew it counts toward ✓ "as a picture"; without one such a page fails, counted, the console\'s read gives the file to its pusher, the operator and the admin, and a person\'s picture take reaches that person alone', { timeout: 120_000 }, async (t) => {
  const srv = await startServer();
  t.after(() => stopServer(srv.child));
  const sockets = [];
  t.after(() => sockets.forEach((s) => s.close()));
  const heard = new Map();
  const page = async (cookie, who) => {
    const s = await connect(srv.base, cookie);
    sockets.push(s);
    heard.set(s, []);
    s.onAny((ev, ...args) => heard.get(s).push([ev, args[0]]));
    s.who = who;
    return s;
  };
  const info = (s) => heard.get(s).filter(([ev, v]) => ev === 'page:take' && v.layer === 'info').map(([, v]) => v);
  const joined = async (s, args) => { const r = await emit(s, 'join', invited(srv.dataDir, args)); assert.equal(r.ok, true, s.who + ': ' + JSON.stringify(r)); return r; };
  const upload = async (token, name, bytes, type) => {
    const f = new FormData();
    f.append('file', new Blob([bytes], { type }), name);
    const r = await fetch(srv.base + '/api/upload', { method: 'POST', headers: { 'X-AGM-Upload': token }, body: f });
    return { status: r.status, ...(await r.json()) };
  };
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n', 'latin1');
  const jpeg = (w, h) => Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]);
  const AS = 'As a picture of p. 2: this device cannot page through the document';
  const DEVICE = 'this device cannot open documents — ask for a picture';

  const admin = (await api(srv.base, 'POST', '/api/setup', { token: TOKEN, username: 'ana', name: 'Ana Admin', password: 'the green room kettle' })).cookie;
  const hall = (await api(srv.base, 'POST', '/api/rooms', { name: 'Hall 5' }, { cookie: admin })).body.code;
  const ctl = await page(admin, 'the admin page');
  const ctlJoin = await joined(ctl, { roomCode: hall, as: 'account', docs: true });
  const account = async (username, name, role) => {
    const made = await api(srv.base, 'POST', '/api/users', { username, name, role, password: PASSWORD, halls: [hall] }, { cookie: admin });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    return (await api(srv.base, 'POST', '/api/auth/login', { username, password: PASSWORD })).cookie;
  };
  // Backstage in Main: Tom, a Tech (the operator, canPush), and Sal, a Staff account who may only show (canShow).
  const tom = await page(await account('tom', 'Tom Tech', 'tech'), 'Tom, the operator');
  await joined(tom, { roomCode: hall, as: 'account' });
  const sal = await page(await account('sal', 'Sal Staff', 'staff'), 'Sal, who may only show');
  await joined(sal, { roomCode: hall, as: 'account' });
  // Three Board pages: Gil's opens documents; Kim's says so in a word that is not `true`; Lou's says nothing.
  const gil = await page(undefined, 'Gil, a current tablet');
  await joined(gil, { roomCode: hall, name: 'Gil', role: 'board', docs: true });
  const kim = await page(undefined, 'Kim, an older iPad');
  const kimJoin = await joined(kim, { roomCode: hall, name: 'Kim', role: 'board', docs: 'true' });
  const lou = await page(undefined, 'Lou, an older phone');
  const louJoin = await joined(lou, { roomCode: hall, name: 'Lou', role: 'board', docs: undefined });
  const status = () => act(ctl, 'page:status', { code: hall });
  const st0 = await status();
  assert.deepEqual([st0.board.pages, st0.board.nodocs], [3, 2], 'the Board: two of its three pages cannot open documents ' + JSON.stringify(st0.board));
  const row = (st, name) => st.people.find((p) => p.name === name);
  assert.deepEqual(['Gil', 'Kim', 'Lou'].map((n) => [row(st0, n).board, row(st0, n).nodocs]), [[true, undefined], [true, 1], [true, 1]], 'each person On stage, and their pages that cannot');
  // A page that joins again on its own socket, now saying true, is counted again.
  await joined(kim, { roomCode: hall, name: 'Kim', role: 'board', uid: kimJoin.identity, docs: true });
  assert.equal((await status()).board.nodocs, 1);
  await joined(kim, { roomCode: hall, name: 'Kim', role: 'board', uid: kimJoin.identity, docs: 1 });
  assert.equal((await status()).board.nodocs, 2);

  // The document, shared in Main, and its stand-in, a picture of p. 2 the pusher's page drew and uploaded, never posted.
  const up = await upload(ctlJoin.uploadToken, 'Board pack.pdf', pdf, 'application/pdf');
  assert.equal((await act(ctl, 'message', { type: 'file', url: up.url, filename: 'Board pack.pdf', mime: 'application/pdf' })).ok, true);
  const pic = await upload(ctlJoin.uploadToken, 'Board pack p2.png', pngOf(40, 30), 'image/png');
  assert.equal(pic.status, 200, JSON.stringify(pic));
  const pushed = await act(ctl, 'page:push', { code: hall, to: 'board', content: { kind: 'doc', url: up.url, at: { page: 2 }, standin: { url: pic.url } } });
  assert.equal(pushed.ok, true, JSON.stringify(pushed));
  const docContent = { kind: 'doc', url: up.url, name: 'Board pack.pdf', at: { page: 2 }, download: false, standin: { url: pic.url } };
  await until(() => [gil, kim, lou].every((s) => info(s).some((x) => x.seq === pushed.seq)), 4000, 'the Board\'s pages told the document');
  for (const s of [gil, kim, lou]) assert.deepEqual(info(s).find((x) => x.seq === pushed.seq).content, docContent, s.who);
  // Kept with its stand-in, which the hall keeps as a stage file named by the take.
  const kept = () => JSON.parse(fs.readFileSync(path.join(srv.dataDir, 'pages.json'), 'utf8')).halls[hall];
  await until(() => fs.existsSync(path.join(srv.dataDir, 'pages.json')) && kept().board.info.seq === pushed.seq, 4000, 'saved');
  assert.deepEqual(kept().board.info.content.standin, { url: pic.url });
  assert.deepEqual(Object.keys(kept().files || {}), [pic.url.slice(9)], 'the stand-in a stage file; the document is its message\'s');
  // Each page says what it drew: the current tablet the document, the two others its stand-in, with its words: ✓ on all
  // three, two as a picture.
  assert.ok((await act(gil, 'page:report', { seq: pushed.seq, state: 'shown' })).ok);
  assert.ok((await act(kim, 'page:report', { seq: pushed.seq, state: 'shown', words: AS })).ok);
  assert.ok((await act(lou, 'page:report', { seq: pushed.seq, state: 'shown', words: AS })).ok);
  const st1 = (await status()).board.info;
  assert.deepEqual([st1.mark, st1.words, st1.on, st1.pages, st1.nodocs, st1.standin, st1.cannot], ['✓', 'On all 3 Board pages, 2 as a picture', 3, 3, 2, 2, undefined]);
  // A stand-in is checked as a picture take is: over what the Board's devices draw, refused at its take; one that is no
  // picture, refused in words.
  const big = await upload(ctlJoin.uploadToken, 'p2 big.jpg', jpeg(8000, 6250), 'image/jpeg');
  assert.equal(big.status, 200, JSON.stringify(big));
  assert.deepEqual(await act(ctl, 'page:push', { code: hall, to: 'board', content: { kind: 'doc', url: up.url, at: { page: 2 }, standin: { url: big.url } } }), { ok: false, error: 'Too large for the Board\'s devices — send a region.' });
  assert.deepEqual(await act(ctl, 'page:push', { code: hall, to: 'board', content: { kind: 'doc', url: up.url, standin: { url: up.url } } }), { ok: false, error: 'A document\'s stand-in is a picture of its place or what you see there: one of the two.' });
  assert.deepEqual(await act(ctl, 'page:push', { code: hall, to: 'board', content: { kind: 'image', url: pic.url, standin: { url: pic.url } } }), { ok: false, error: 'Only a document has a stand-in.' });
  // Its shape is its document's: a PDF's is a picture of its place, never words.
  assert.deepEqual(await act(ctl, 'page:push', { code: hall, to: 'board', content: { kind: 'doc', url: up.url, standin: { snippet: { unit: 'text', text: 'p. 2' } } } }), { ok: false, error: 'A PDF\'s or a picture\'s stand-in is a picture of its place; any other document\'s is what you see there.' });

  // Without one (a page that joined after the push, or none made): those two pages fail with their words, counted.
  const bare = await act(ctl, 'page:push', { code: hall, to: 'board', content: { kind: 'doc', url: up.url, at: { page: 2 } } });
  assert.equal(bare.ok, true, JSON.stringify(bare));
  await until(() => [gil, kim, lou].every((s) => info(s).some((x) => x.seq === bare.seq)), 4000, 'told again');
  assert.ok((await act(gil, 'page:report', { seq: bare.seq, state: 'shown' })).ok);
  assert.ok((await act(kim, 'page:report', { seq: bare.seq, state: 'failed', words: DEVICE })).ok);
  assert.ok((await act(lou, 'page:report', { seq: bare.seq, state: 'failed', words: DEVICE })).ok);
  const st2all = await status();
  const st2 = st2all.board.info;
  assert.deepEqual([st2.mark, st2.words, st2.nodocs, st2.cannot, st2.standin], ['△', 'Couldn\'t show it on 2 of 3 pages: ' + DEVICE, 2, 2, undefined]);
  // The console's read gives the file Show them a picture draws from to its pusher, the operator and the admin, on the
  // Board's row and on each person's that could not open it; never to a seat that may only show and did not put it up,
  // and never where every page showed it.
  const FILE = { url: up.url, name: 'Board pack.pdf', at: { page: 2 } };
  assert.deepEqual([st2.doc, row(st2all, 'Kim').info.doc, row(st2all, 'Kim').info.cannot, row(st2all, 'Lou').info.doc, row(st2all, 'Gil').info.doc], [FILE, FILE, 1, FILE, undefined]);
  assert.deepEqual((await act(tom, 'page:status', { code: hall })).board.info.doc, FILE, 'the operator');
  const salSees = await act(sal, 'page:status', { code: hall });
  assert.deepEqual([salSees.ok, salSees.board.info.cannot, salSees.board.info.doc, row(salSees, 'Kim').info.doc], [true, 2, undefined, undefined], 'a seat that may only show, not its pusher');
  assert.equal(st1.doc, undefined, 'a document every page showed carries none');
  // A person take, as Show them a picture sends to each such person (the act is the pusher's page's, which the browser
  // smoke drives): drawn over the Board's on their pages alone.
  const before = new Map([gil, kim, lou].map((s) => [s, info(s).length]));
  const toKim = await act(ctl, 'page:push', { code: hall, to: { uid: 'u:' + kimJoin.uid }, content: { kind: 'image', url: pic.url, from: { url: up.url, at: { page: 2 } } } });
  assert.equal(toKim.ok, true, JSON.stringify(toKim));
  await until(() => info(kim).some((x) => x.seq === toKim.seq), 4000, 'Kim told the picture');
  await wait(300);
  assert.deepEqual(info(kim).find((x) => x.seq === toKim.seq).content, { kind: 'image', url: pic.url, name: 'Board pack p2.png', from: { name: 'Board pack.pdf', type: 'pdf', at: { page: 2 } } });
  assert.deepEqual([gil, lou].map((s) => info(s).slice(before.get(s)).some((x) => x.seq === toKim.seq)), [false, false], 'nobody else is told it');
  const kimNow = row(await status(), 'Kim').info;
  assert.deepEqual([kimNow.seq, kimNow.kind], [toKim.seq, 'image'], 'Kim\'s pages show the picture over the Board\'s document');
  assert.deepEqual([row(await status(), 'Lou').info.seq], [bare.seq], 'Lou\'s still the Board\'s, until sent hers');
  assert.equal(louJoin.ok, true);
});
