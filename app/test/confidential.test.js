'use strict';
// The confidential mark (plan 4-§5.14, owner answer 16): one record a file, read by every check; a file goes only where it
// is in use or where its sender confirms it; never on a screen; never to the AI; its line only to the hall's own
// Stagewatch over an encrypted link, held back from every other reader of that Stagewatch's frame.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const tlsmod = require('../lib/tls');
const { startServer, restartServer, stopServer, api, connect, emit, wait, until, pngOf, inviteOf, fakeStagewatch, setupAdmin } = require('./helpers');
const ai = require('../lib/ai');
const board = require('../lib/board');
const { entryOf, storedEntry } = require('../lib/stagerecord');

const PASSWORD = 'clipboard and coffee';
/** An act asked again while its socket's bucket says slow down: the answer the verb gives, not the rate's. */
async function act(s, ev, arg) {
  for (let i = 0; i < 20; i++) {
    const r = await emit(s, ev, arg);
    if (!(r && r.busy)) return r;
    await wait(300);
  }
  throw new Error(ev + ' was refused for the rate twenty times');
}
/** Every audit row of an action, as [target, words, actor's name]. */
const rowsOf = (dataDir, action) => fs.readFileSync(path.join(dataDir, 'audit.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  .filter((e) => e.action === action).map((e) => [e.target, e.words, e.actor.name]);
const pagesJson = (dataDir) => JSON.parse(fs.readFileSync(path.join(dataDir, 'pages.json'), 'utf8'));
const pdf = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n', 'latin1');

/** A stand-in for the AI's endpoint (the SDK's ANTHROPIC_BASE_URL): every request's body kept, a draft or minutes answered. */
async function fakeModel() {
  const bodies = [];
  const model = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => {
      bodies.push(b);
      const text = /minutes/i.test(b) ? { headline: 'Q3', decisions: [], open: [], actions: [] } : { draft: 'A draft', gaps: [], confidence: 'low' };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'x', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(text) }], usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  });
  await new Promise((resolve) => { model.listen(0, '127.0.0.1', resolve); });
  return { bodies, url: 'http://127.0.0.1:' + model.address().port, close: () => new Promise((resolve) => { model.close(resolve); }) };
}

/** A hall with Legal and Media beside its Main room, both on Main's list; Sue backstage in Legal, Mo in Media, Tom the operator in Main. */
async function hallOf(srv, t, { name = 'Hall 2' } = {}) {
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
  const joined = async (s, args) => {
    const a = args.role === 'board' && !args.as ? { ...args, invite: inviteOf(srv.dataDir, args.roomCode), docs: true } : { ...args, docs: true };
    const r = await act(s, 'join', a);
    assert.equal(r.ok, true, s.who + ': ' + JSON.stringify(r));
    return r;
  };
  const admin = (await setupAdmin(srv.base, { username: 'root', name: 'Root Admin', password: 'the green room kettle' })).cookie;
  const hall = (await api(srv.base, 'POST', '/api/rooms', { name }, { cookie: admin })).body.code;
  const ctl = await page(admin, 'the admin');
  await joined(ctl, { roomCode: hall, as: 'account' });
  const LEGAL = (await act(ctl, 'room:create', { hall, name: 'Legal' })).key;
  const MEDIA = (await act(ctl, 'room:create', { hall, name: 'Media' })).key;
  assert.equal((await act(ctl, 'room:update', { code: hall, sendFrom: [LEGAL, MEDIA] })).ok, true);
  const account = async (username, display, role, extra) => {
    const made = await api(srv.base, 'POST', '/api/users', { username, name: display, role, password: PASSWORD, ...extra }, { cookie: admin });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    return (await api(srv.base, 'POST', '/api/auth/login', { username, password: PASSWORD })).cookie;
  };
  return { admin, hall, LEGAL, MEDIA, ctl, page, joined, account, heard };
}

test('the readers\' words: the AI\'s thread and minutes say "a confidential file" and "a confidential item" with none of its name, place, caption, words or line; the halls board "📎 🔒 name"; the stage record keeps the mark', () => {
  const file = { id: 'm1', type: 'file', url: '/uploads/1730000000000-abcdefghijkl-advice.pdf', filename: 'Redundancy plan — K. Smith.docx', caption: 'For the chair', at: Date.UTC(2026, 10, 6, 14, 5), from: { name: 'Sue', role: 'research' } };
  assert.equal(ai.threadText([{ ...file, confidential: true }]), '[14:05] Sue (research) shared a confidential file');
  assert.match(ai.threadText([file]), /shared "Redundancy plan — K\. Smith\.docx" for download: For the chair$/);
  const take = { seq: 4, at: Date.UTC(2026, 10, 6, 14, 6), by: { name: 'Ana' }, content: { kind: 'snippet', unit: 'paragraph', text: 'Settle at £2m.', from: { name: 'Legal advice.pdf', type: 'pdf', at: { page: 3 } }, confidential: true } };
  const entry = { ...entryOf(take, { role: 'research' }), line: { text: 'Settle at £2m.', via: 'now' } };
  assert.equal(entry.confidential, true);
  assert.match(entry.what, /^🔒 ❝ a paragraph from Legal advice\.pdf, p\. 3$/);
  assert.deepEqual(storedEntry(entry), entry, 'read back with its mark');
  assert.equal(storedEntry({ ...entry, confidential: 'yes' }), null);
  assert.equal(ai.shownText([entry]), '[14:06] Ana showed the Board a confidential item (its name and words not sent to the AI)');
  assert.equal(ai.shownText([{ ...entry, withdrawn: Date.UTC(2026, 10, 6, 14, 7) }]), '[14:06] Ana showed the Board a confidential item (its name and words not sent to the AI); withdrawn at 14:07');
  assert.equal(board.lineOf({ ...file, confidential: true }), '📎 🔒 Redundancy plan — K. Smith.docx');
  const room = { code: 'HALLA1', seq: 1, users: new Map(), messages: [file] };
  assert.equal(board.hallRow(room, { isConfidential: () => true }).last.text, '📎 🔒 Redundancy plan — K. Smith.docx');
  assert.equal(board.hallRow(room, { isConfidential: () => false }).last.text, '📎 Redundancy plan — K. Smith.docx — For the chair');
});

test('the mark: one record a file, set as it is shared or later by the backstage team, removed by its marker or the admin, on every copy; never on a screen; across rooms only confirmed; on the stage only where it is in use or confirmed; pictures and quotes of it marked; downloads audited; named only where it is in use; the AI, the transcript, the halls board and the context', { timeout: 180_000 }, async (t) => {
  const model = await fakeModel();
  t.after(() => model.close());
  const srv = await startServer({ ANTHROPIC_API_KEY: 'a-key-for-the-fake-model', ANTHROPIC_BASE_URL: model.url });
  t.after(() => stopServer(srv.child));
  const H = await hallOf(srv, t);
  const { hall, LEGAL, MEDIA, ctl, page, joined, account, heard, admin } = H;
  const hall3 = (await api(srv.base, 'POST', '/api/rooms', { name: 'Hall 3' }, { cookie: admin })).body.code;
  const sueCookie = await account('sue', 'Sue Staff', 'staff', { halls: [hall, hall3], rooms: [LEGAL] });
  const tomCookie = await account('tom', 'Tom Tech', 'tech', { halls: [hall], rooms: [LEGAL] });
  const moCookie = await account('mo', 'Mo Media', 'staff', { halls: [hall], rooms: [MEDIA] });
  const sue = await page(sueCookie, 'Sue in Legal');
  const sueJoin = await joined(sue, { roomCode: LEGAL, as: 'account' });
  const sue3 = await page(sueCookie, 'Sue in Hall 3');
  await joined(sue3, { roomCode: hall3, as: 'account' });
  const tomLegal = await page(tomCookie, 'Tom in Legal');
  await joined(tomLegal, { roomCode: LEGAL, as: 'account' });
  const tom = await page(tomCookie, 'Tom in Main');
  const tomJoin = await joined(tom, { roomCode: hall, as: 'account' });
  const mo = await page(moCookie, 'Mo in Media');
  const moJoin = await joined(mo, { roomCode: MEDIA, as: 'account' });
  const gil = await page(undefined, 'Gil On stage');
  await joined(gil, { roomCode: hall, name: 'Gil', role: 'board' });
  const rootLegal = await page(admin, 'the admin in Legal');
  await joined(rootLegal, { roomCode: LEGAL, as: 'account' });
  assert.deepEqual([moJoin.canShow, sueJoin.canShow, tomJoin.canPush], [true, true, true]);
  // An upload sent again while the uploads' rate (a burst, then one every 2 s) turns it away, as a page's outbox does.
  const upload = async (token, name, bytes, type, from) => {
    for (let i = 0; ; i++) {
      const f = new FormData();
      if (from !== undefined) f.append('from', from);
      f.append('file', new Blob([bytes], { type }), name);
      const r = await fetch(srv.base + '/api/upload', { method: 'POST', headers: { 'X-AGM-Upload': token }, body: f });
      if (r.status !== 429 || i >= 8) return { status: r.status, ...(await r.json()) };
      await r.arrayBuffer();
      await wait(2100);
    }
  };
  const messages = (s, ev = 'message') => heard.get(s).filter(([e]) => e === ev).map(([, v]) => v);
  const info = (s) => heard.get(s).filter(([ev, v]) => ev === 'page:take' && v.layer === 'info').map(([, v]) => v);

  // Shared marked (🔒 beside 🔥): its sharer marks it as it is shared; every page of the room is given it marked, with who.
  const up = await upload(sueJoin.uploadToken, 'Legal advice.pdf', pdf, 'application/pdf');
  assert.equal(up.status, 200, JSON.stringify(up));
  const name = up.url.slice(9);
  assert.deepEqual(await act(sue, 'message', { type: 'file', url: up.url, filename: 'Legal advice.pdf', mime: 'application/pdf', confidential: 'yes' }), { ok: false, error: 'Confidential is a tick: true, or left out.' });
  const shared = await act(sue, 'message', { type: 'file', url: up.url, filename: 'Legal advice.pdf', mime: 'application/pdf', confidential: true });
  assert.equal(shared.ok, true, JSON.stringify(shared));
  assert.equal(shared.confidential, true);
  await until(() => messages(tomLegal).some((m) => m.id === shared.id), 4000, 'Legal told the file');
  const live = messages(tomLegal).find((m) => m.id === shared.id);
  assert.deepEqual([live.confidential, live.markedBy.name, live.markedBy.uid], [true, 'Sue Staff', sueJoin.uid]);
  // One record a file, kept in pages.json; the message itself carries no mark.
  await until(() => fs.existsSync(path.join(srv.dataDir, 'pages.json')) && !!(pagesJson(srv.dataDir).marks || {})[name], 4000, 'the mark kept');
  assert.equal(pagesJson(srv.dataDir).marks[name].name, 'Legal advice.pdf');
  const stored = fs.readdirSync(path.join(srv.dataDir, 'rooms')).filter((f) => f.startsWith(LEGAL)).map((f) => fs.readFileSync(path.join(srv.dataDir, 'rooms', f), 'utf8')).join('');
  assert.ok(!stored.includes('confidential'), 'no message is rewritten');
  // One row, the file by its kind alone.
  assert.deepEqual(rowsOf(srv.dataDir, 'file.mark'), [[LEGAL, 'a pdf in Legal (Hall 2) marked confidential as it was shared', 'sue']]);
  // A page that joins, reads earlier messages or resumes is given it marked.
  const late = await page(tomCookie, 'Tom again in Legal');
  const lateJoin = await joined(late, { roomCode: LEGAL, as: 'account' });
  assert.equal(lateJoin.history.find((m) => m.id === shared.id).confidential, true);
  assert.equal((await act(late, 'history:message', { messageId: shared.id })).message.confidential, true);
  const resumed = await act(late, 'join', { roomCode: LEGAL, as: 'account', since: lateJoin.seq - 1, docs: true });
  assert.ok(Array.isArray(resumed.ops));

  // Removed only by who marked it, or the admin; marked again later by the backstage team; each a row, every page told.
  assert.deepEqual(await act(tomLegal, 'file:mark', { messageId: shared.id, on: false }), { ok: false, error: 'Only Sue Staff or an admin can remove the mark.' });
  assert.deepEqual(await act(tomLegal, 'file:mark', { messageId: shared.id, on: 'off' }), { ok: false, error: 'Say mark (on: true) or remove the mark (on: false).' });
  assert.deepEqual(await act(rootLegal, 'file:mark', { messageId: shared.id, on: false }), { ok: true, confidential: false });
  await until(() => messages(tomLegal, 'fileMark').some((f) => f.confidential === false), 4000, 'told the mark went');
  assert.deepEqual(messages(tomLegal, 'fileMark').at(-1), { name, ids: [shared.id], confidential: false });
  assert.deepEqual(await act(rootLegal, 'file:mark', { messageId: shared.id, on: false }), { ok: true, already: true, confidential: false });
  assert.deepEqual(await act(tomLegal, 'file:mark', { messageId: shared.id, on: true }), { ok: true, confidential: true });
  assert.equal(messages(sue, 'fileMark').at(-1).confidential, true);
  assert.deepEqual(rowsOf(srv.dataDir, 'file.mark').map(([, w]) => w), ['a pdf in Legal (Hall 2) marked confidential as it was shared', 'a pdf in Legal (Hall 2): the confidential mark removed', 'a pdf in Legal (Hall 2) marked confidential']);
  // The admin page marks and unmarks a file of the room it watches, seated nowhere, its room view given the mark.
  const desk = await page(admin, 'the admin page');
  const watched = await act(desk, 'admin:watchRoom', { roomCode: LEGAL });
  assert.equal(watched.messages.find((m) => m.id === shared.id).confidential, true);
  assert.deepEqual(await act(desk, 'file:mark', { messageId: shared.id, on: false }), { ok: true, confidential: false });
  await until(() => messages(desk, 'fileMark').some((f) => f.confidential === false), 4000, 'the admin page told');
  assert.deepEqual(await act(desk, 'file:mark', { messageId: shared.id, on: true }), { ok: true, confidential: true });
  assert.deepEqual(rowsOf(srv.dataDir, 'file.mark').slice(-2), [[LEGAL, 'a pdf in Legal (Hall 2): the confidential mark removed', 'root'], [LEGAL, 'a pdf in Legal (Hall 2) marked confidential', 'root']]);

  // Never on a screen, nor a holding image; and a file on a screen is taken off it before it is marked.
  const screen = await act(ctl, 'display:create', { code: hall, name: 'Foyer' });
  assert.equal(screen.ok, true, JSON.stringify(screen));
  const NEVER = 'A confidential file is never shown on screens: anyone near them can see it.';
  assert.deepEqual(await act(ctl, 'display:take', { id: screen.display.id, content: { kind: 'file', url: up.url } }), { ok: false, error: NEVER });
  // A fresh upload put on a screen by its address is not marked as it is shared, nor shown marked, while it is there.
  const floor = await upload(tomJoin.uploadToken, 'Floor plan.png', pngOf(30, 20), 'image/png');
  assert.equal((await act(ctl, 'display:take', { id: screen.display.id, content: { kind: 'file', url: floor.url } })).ok, true);
  const OFF_FOYER = 'Take it off Foyer first: a screen is seen by whoever stands near it.';
  assert.deepEqual(await act(tom, 'message', { type: 'file', url: floor.url, filename: 'Floor plan.png', mime: 'image/png', confidential: true }), { ok: false, error: OFF_FOYER });
  assert.deepEqual(await act(tom, 'page:push', { code: hall, to: 'board', content: { kind: 'image', url: floor.url, confidential: true } }), { ok: false, error: OFF_FOYER });
  assert.equal((pagesJson(srv.dataDir).marks || {})[floor.url.slice(9)], undefined, 'not marked');
  const plan = await upload(tomJoin.uploadToken, 'Stage plan.png', pngOf(40, 30), 'image/png');
  const planMsg = await act(tom, 'message', { type: 'file', url: plan.url, filename: 'Stage plan.png', mime: 'image/png' });
  assert.equal((await act(ctl, 'display:take', { id: screen.display.id, content: { kind: 'file', url: plan.url } })).ok, true);
  assert.equal((await act(ctl, 'display:hallHolding', { code: hall, image: plan.url })).ok, true);
  assert.deepEqual(await act(tom, 'file:mark', { messageId: planMsg.id, on: true }), { ok: false, error: 'Take it off Foyer and the hall\'s holding image first: a screen is seen by whoever stands near it.' });
  // On stage, nothing is marked: an On stage seat shares no file, so it marks none.
  assert.deepEqual(await act(gil, 'file:mark', { messageId: planMsg.id, on: true }), { ok: false, error: 'Do that from a backstage page.' });
  assert.equal((await act(ctl, 'display:hallHolding', { code: hall, image: '' })).ok, true);
  assert.equal((await act(ctl, 'display:take', { id: screen.display.id, content: { kind: 'black' } })).ok, true);
  // A holding slide on people's pages is a holding image too.
  assert.equal((await act(tom, 'page:push', { code: hall, to: 'board', content: { kind: 'holding', image: plan.url } })).ok, true);
  assert.deepEqual(await act(tom, 'file:mark', { messageId: planMsg.id, on: true }), { ok: false, error: 'Take it off the Board\'s holding slide first: a screen is seen by whoever stands near it.' });
  assert.equal((await act(tom, 'page:push', { code: hall, to: 'board', content: { kind: 'clock' } })).ok, true);
  assert.deepEqual(await act(tom, 'file:mark', { messageId: planMsg.id, on: true }), { ok: true, confidential: true });
  assert.deepEqual(await act(ctl, 'display:hallHolding', { code: hall, image: plan.url }), { ok: false, error: NEVER });
  assert.deepEqual(await act(tom, 'page:push', { code: hall, to: 'board', content: { kind: 'holding', image: plan.url } }), { ok: false, error: NEVER });

  // A picture drawn of the marked file is marked as it is stored, before any take; its source by its shape alone.
  assert.equal((await upload(sueJoin.uploadToken, 'Legal advice p1.png', pngOf(20, 20), 'image/png', 'nothing like a source')).status, 400);
  const pic = await upload(sueJoin.uploadToken, 'Legal advice p1.png', pngOf(20, 20), 'image/png', 'm:' + shared.id);
  assert.equal(pic.status, 200, JSON.stringify(pic));
  await until(() => !!(pagesJson(srv.dataDir).marks || {})[pic.url.slice(9)], 4000, 'the picture marked as it is stored');
  assert.deepEqual(rowsOf(srv.dataDir, 'file.mark').at(-1), [LEGAL, 'a png drawn of a confidential file, marked confidential as it was uploaded in Legal (Hall 2)', 'sue']);

  // On the Board: Legal's file is not in use in the Main room, so it waits for its pusher's confirmation; then it is.
  const doc = { kind: 'doc', url: up.url, at: { page: 1 } };
  const asked = await act(sue, 'page:push', { code: hall, to: 'board', content: doc });
  assert.deepEqual(asked, { ok: false, error: 'This file is marked confidential: confirm to show it in the Main room. It will be in use there.', confirm: true, rooms: ['the Main room'] });
  assert.deepEqual(await act(sue, 'page:push', { code: hall, to: 'board', content: doc, confirm: 'yes' }), { ok: false, error: 'Confirm is a tick: true, or left out.' });
  const shown = await act(sue, 'page:push', { code: hall, to: 'board', content: { ...doc, confidential: false }, confirm: true });
  assert.equal(shown.ok, true, JSON.stringify(shown));
  await until(() => info(gil).some((x) => x.seq === shown.seq), 4000, 'the Board told');
  assert.equal(info(gil).find((x) => x.seq === shown.seq).content.confidential, true, 'the server\'s mark, whatever was sent');
  assert.deepEqual(rowsOf(srv.dataDir, 'page.push').at(-1), [hall, 'the Board (1 page) → a confidential PDF in Legal at p. 1, sent from Legal, confirmed', 'sue']);
  // In use in the Main room now: shown again with no confirmation.
  assert.equal((await act(sue, 'page:push', { code: hall, to: 'board', content: doc })).ok, true);
  // A picture drawn of what a take shows (`s:<seq>`) is marked as it is stored too; a take that is none refused.
  assert.equal((await upload(sueJoin.uploadToken, 'Shown p1.png', pngOf(20, 20), 'image/png', 's:999999')).status, 400);
  const ofTake = await upload(sueJoin.uploadToken, 'Shown p1.png', pngOf(20, 20), 'image/png', 's:' + shown.seq);
  assert.equal(ofTake.status, 200, JSON.stringify(ofTake));
  await until(() => !!(pagesJson(srv.dataDir).marks || {})[ofTake.url.slice(9)], 4000, 'a picture of a confidential take marked as it is stored');
  // A picture and a quote of it are marked whatever was sent.
  const picShown = await act(sue, 'page:push', { code: hall, to: 'board', content: { kind: 'image', url: pic.url, from: { url: up.url, at: { page: 1 } }, confidential: false }, confirm: true });
  assert.equal(picShown.ok, true, JSON.stringify(picShown));
  const quoted = await act(sue, 'page:push', { code: hall, to: 'board', content: { kind: 'snippet', unit: 'paragraph', text: 'Settle at £2m.', from: { url: up.url, at: { page: 1 } } }, confirm: true });
  assert.equal(quoted.ok, true, JSON.stringify(quoted));
  await until(() => info(gil).some((x) => x.seq === quoted.seq), 4000, 'told the quote');
  assert.deepEqual([info(gil).find((x) => x.seq === picShown.seq).content.confidential, info(gil).find((x) => x.seq === quoted.seq).content.confidential], [true, true]);
  // Named to a page seated where it is in use; to Media's, "🔒 a confidential item", nothing of its name, place or words.
  const legalStatus = await act(sue, 'page:status', { code: hall });
  assert.match(legalStatus.board.info.showing, /^🔒 ❝ a paragraph from Legal advice\.pdf/);
  const mediaStatus = await act(mo, 'page:status', { code: hall });
  assert.equal(mediaStatus.board.info.showing, '🔒 a confidential item');
  assert.ok(!JSON.stringify(mediaStatus).includes('Legal advice') && !JSON.stringify(mediaStatus).includes('£2m'));

  // Across rooms: sent into the Main room, or forwarded into Hall 3, only once confirmed; each a row that says so.
  const targets = await act(sue, 'room:sendTargets', {});
  const toMain = targets.targets.find((x) => x.name === 'Hall 2');
  assert.ok(toMain, JSON.stringify(targets));
  // A second file of Legal's, marked, in use nowhere else.
  const second = await upload(sueJoin.uploadToken, 'Second opinion.pdf', pdf, 'application/pdf');
  const secondMsg = await act(sue, 'message', { type: 'file', url: second.url, filename: 'Second opinion.pdf', mime: 'application/pdf', confidential: true });
  assert.equal(secondMsg.ok, true, JSON.stringify(secondMsg));
  const unconfirmed = await act(sue, 'room:send', { to: toMain.ref, messageId: secondMsg.id, cid: 'c-send-1' });
  assert.deepEqual(unconfirmed, { ok: false, error: 'This file is marked confidential: confirm to send it to Hall 2. It will be in use there.', confirm: true, rooms: ['Hall 2'] });
  const sent = await act(sue, 'room:send', { to: toMain.ref, messageId: secondMsg.id, cid: 'c-send-2', confirm: true });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  assert.match(rowsOf(srv.dataDir, 'room.send').at(-1)[1], /^a confidential file \(pdf, \d+ KB\) from Legal \(Hall 2\) to Main \(Hall 2\), confirmed$/);
  // In use where it is shown already (the Main room, by the Board's take): sent there with no confirmation.
  assert.equal((await act(sue, 'room:send', { to: toMain.ref, messageId: shared.id, cid: 'c-send-3' })).ok, true);
  // The halls board's line for the Main room's newest message, that file: "📎 🔒 name", never its caption.
  await until(async () => ((await act(ctl, 'board:watch', {})).board.halls.find((h) => h.code === hall).last || {}).text === '📎 🔒 Legal advice.pdf', 4000, 'the board\'s line');
  assert.deepEqual(await act(sue, 'forward', { messageId: shared.id, targetRoom: hall3 }), { ok: false, error: 'This file is marked confidential: confirm to send it to Hall 3. It will be in use there.', confirm: true, rooms: ['Hall 3'] });
  assert.equal((await act(sue, 'forward', { messageId: shared.id, targetRoom: hall3, confirm: true })).ok, true);
  await until(() => messages(sue3).some((m) => m.url === up.url), 4000, 'Hall 3 given it');
  assert.equal(messages(sue3).find((m) => m.url === up.url).confidential, true, 'a new message of a marked file is marked');
  assert.match(rowsOf(srv.dataDir, 'room.send').at(-1)[1], /^a confidential file \(pdf, \d+ KB\), forwarded from Legal \(Hall 2\) to Main \(Hall 3\), confirmed$/);

  // A download of it is one row as it ends, in its room; never at the ticket.
  const ticket = await act(sue, 'file:download', { messageId: shared.id });
  assert.equal(ticket.ok, true, JSON.stringify(ticket));
  assert.deepEqual(rowsOf(srv.dataDir, 'file.download'), [], 'a ticket is no download');
  const got = await fetch(srv.base + up.url + '/download', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 't=' + encodeURIComponent(ticket.ticket) });
  assert.equal(got.status, 200);
  await got.arrayBuffer();
  await until(() => rowsOf(srv.dataDir, 'file.download').length === 1, 4000, 'the download written');
  assert.deepEqual(rowsOf(srv.dataDir, 'file.download'), [[LEGAL, 'a confidential pdf downloaded in Legal (Hall 2)', 'sue']]);

  // The AI: never a confidential file's text, its name the server's; the thread's and the now line's words withheld.
  assert.deepEqual(await act(sue, 'ai:draft', { docText: 'Settle at £2m.', docName: 'x.pdf' }), { ok: false, error: 'Say where the document\'s text comes from: a file of this room, something shown, or your own copy.' });
  assert.deepEqual(await act(sue, 'ai:draft', { docText: 'Settle at £2m.', docFrom: { messageId: shared.id } }), { ok: false, error: 'This file is marked confidential: its text is not sent to the AI.' });
  assert.deepEqual(await act(tom, 'ai:draft', { docText: 'Settle at £2m.', docFrom: { seq: shown.seq } }), { ok: false, error: 'This file is marked confidential: its text is not sent to the AI.' });
  const open = await upload(tomJoin.uploadToken, 'Agenda.txt', Buffer.from('Item 1\n'), 'text/plain');
  const openMsg = await act(tom, 'message', { type: 'file', url: open.url, filename: 'Agenda.txt', mime: 'text/plain' });
  const before = model.bodies.length;
  const drafted = await act(tom, 'ai:draft', { docText: 'Item 1', docName: 'A name the page made up.txt', docFrom: { messageId: openMsg.id } });
  assert.equal(drafted.ok, true, JSON.stringify(drafted));
  const prompt = model.bodies.slice(before).join('');
  assert.ok(prompt.includes('Agenda.txt') && !prompt.includes('A name the page made up'), 'the document\'s name is the server\'s');
  assert.ok(prompt.includes('shared a confidential file') && !prompt.includes('Legal advice') && !prompt.includes('£2m'), 'the thread and the now line keep its name and words');
  assert.ok(prompt.includes('On the Board\'s pages now: a confidential item — not sent to the AI'));
  // Its own copy, by the page's name; a take of an open file, by the server's; a take that is none, refused.
  assert.equal((await act(tom, 'ai:draft', { docText: 'Item 1', docName: 'My notes.txt', docFrom: { local: true } })).ok, true);
  const openShown = await act(tom, 'page:push', { code: hall, to: 'board', content: { kind: 'doc', url: open.url } });
  assert.equal(openShown.ok, true, JSON.stringify(openShown));
  const bySeq = model.bodies.length;
  assert.equal((await act(tom, 'ai:draft', { docText: 'Item 1', docName: 'Made up.txt', docFrom: { seq: openShown.seq } })).ok, true);
  assert.ok(model.bodies.slice(bySeq).join('').includes('("Agenda.txt")') || model.bodies.slice(bySeq).join('').includes('Agenda.txt'));
  assert.deepEqual(await act(tom, 'ai:draft', { docText: 'Item 1', docFrom: { seq: 999999 } }), { ok: false, error: 'Say where the document\'s text comes from: a file of this room, something shown, or your own copy.' });

  // A file marked after its quote went up: the take is confidential from then on, read where it is used — the console's
  // words to Media, the AI's now line, a picture drawn of it, the transcript and the minutes.
  const later = await upload(tomJoin.uploadToken, 'Later secret.pdf', pdf, 'application/pdf');
  const laterMsg = await act(tom, 'message', { type: 'file', url: later.url, filename: 'Later secret.pdf', mime: 'application/pdf' });
  assert.equal(laterMsg.ok, true, JSON.stringify(laterMsg));
  const laterQuote = await act(tom, 'page:push', { code: hall, to: 'board', content: { kind: 'snippet', unit: 'paragraph', text: 'Margin 12%.', from: { url: later.url, at: { page: 1 } } } });
  assert.equal(laterQuote.ok, true, JSON.stringify(laterQuote));
  assert.match((await act(mo, 'page:status', { code: hall })).board.info.showing, /^❝ a paragraph from Later secret\.pdf/, 'not marked yet: named to Media');
  assert.deepEqual(await act(tom, 'file:mark', { messageId: laterMsg.id, on: true }), { ok: true, confidential: true });
  const masked = await act(mo, 'page:status', { code: hall });
  assert.deepEqual([masked.board.info.showing, masked.board.info.confidential], ['🔒 a confidential item', true]);
  assert.ok(!JSON.stringify(masked).includes('Later secret') && !JSON.stringify(masked).includes('Margin'));
  assert.match((await act(tom, 'page:status', { code: hall })).board.info.showing, /^🔒 ❝ a paragraph from Later secret\.pdf/, 'named where it is in use');
  const nowFrom = model.bodies.length;
  assert.equal((await act(tom, 'ai:draft', { question: 'What is up?' })).ok, true);
  const nowPrompt = model.bodies.slice(nowFrom).join('');
  assert.ok(nowPrompt.includes('On the Board\'s pages now: a confidential item — not sent to the AI') && !nowPrompt.includes('Later secret') && !nowPrompt.includes('Margin 12%'), nowPrompt.slice(0, 300));
  const laterPic = await upload(tomJoin.uploadToken, 'Later p1.png', pngOf(20, 20), 'image/png', 's:' + laterQuote.seq);
  assert.equal(laterPic.status, 200, JSON.stringify(laterPic));
  await until(() => !!(pagesJson(srv.dataDir).marks || {})[laterPic.url.slice(9)], 4000, 'a picture of a take marked since marked as it is stored');
  // The minutes: the record's confidential entries without their name, page or words.
  const minutesFrom = model.bodies.length;
  assert.equal((await act(ctl, 'admin:summary', { roomCode: hall })).ok, true);
  const minutes = model.bodies.slice(minutesFrom).join('');
  assert.ok(minutes.includes('a confidential item (its name and words not sent to the AI)'), minutes.slice(0, 400));
  assert.ok(!minutes.includes('Legal advice') && !minutes.includes('£2m') && !minutes.includes('p. 1'));
  assert.ok(!minutes.includes('Later secret') && !minutes.includes('Margin 12%'), 'an entry recorded before its file was marked, withheld as it is read');

  // The transcript: on the laptop, its words and its mark; off it, its mark, file and place, its words only when asked.
  // Off the laptop: the same request by another name for this machine (guard.isHostMachine reads the Host header too).
  const transcript = (q = '', headers = {}) => new Promise((resolve, reject) => {
    const u = new URL(srv.base + '/api/admin/transcript/' + hall + q);
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, headers: { cookie: admin, ...headers } }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { b += d; });
      res.on('end', () => resolve(b));
    });
    req.on('error', reject);
    req.end();
  });
  const here = await transcript();
  assert.ok(here.includes('🔒 Confidential — ❝ a paragraph from Legal advice.pdf') && here.includes('Settle at £2m.'), 'on the laptop, its words with its mark');
  const away = await transcript('', { host: 'agm.venue.example:443' });
  assert.ok(away.includes('🔒 Confidential — ❝ a paragraph from Legal advice.pdf') && !away.includes('Settle at £2m.') && away.includes('its words are shown on the AGMessage laptop'), away.slice(0, 300) + ' … ' + (away.match(/<div class="shown">[^\n]*/g) || []).join('\n'));
  assert.ok(here.includes('Margin 12%.') && !away.includes('Margin 12%.'), 'an entry recorded before its file was marked: its words on the laptop alone');
  const asked2 = await transcript('?confidential=1', { host: 'agm.venue.example:443' });
  assert.ok(asked2.includes('Settle at £2m.'));
  assert.ok(rowsOf(srv.dataDir, 'room.read').some(([target, words]) => target === hall && /confidential text included$/.test(words)));
  assert.ok(here.includes('📎 🔒 Confidential · <em>Legal advice.pdf</em>'), 'the file message marked in the transcript');

  // Nothing of it in the context.
  const ctx = JSON.stringify((await api(srv.base, 'GET', '/api/context', undefined, { cookie: admin })).body);
  assert.ok(!ctx.includes('Legal advice') && !ctx.includes('£2m') && !ctx.includes('confidential'));
});

test('the line: a confidential push\'s line only from where it is in use in the Main room, to the hall\'s own Stagewatch over an encrypted link; then its frame is held from every other reader, a proposal\'s too, across a restart, until the frame moves on', { timeout: 180_000 }, async (t) => {
  const { io } = require('socket.io-client');
  const KEY = 'swk_conf_node_key_0001';   // secret-scan: fixture
  const certOf = () => tlsmod.makeCertificate({ name: 'Stagewatch', hosts: ['localhost'], ips: ['127.0.0.1'] });
  const own = await fakeStagewatch({ name: 'Hall 2 timer', key: KEY, cert: certOf() });
  const shared = await fakeStagewatch({ name: 'Shared timer', key: KEY });
  const plain = await fakeStagewatch({ name: 'Hall 4 timer', key: KEY });
  t.after(() => Promise.all([own.close(), shared.close(), plain.close()]));
  const model = await fakeModel();
  t.after(() => model.close());
  const ENV = { ANTHROPIC_API_KEY: 'a-key-for-the-fake-model', ANTHROPIC_BASE_URL: model.url };
  let srv = await startServer(ENV);
  t.after(() => stopServer(srv.child));
  const H = await hallOf(srv, t);
  const { hall, LEGAL, MEDIA, ctl, page, joined, account, heard, admin } = H;
  const hallOfName = async (n) => (await api(srv.base, 'POST', '/api/rooms', { name: n }, { cookie: admin })).body.code;
  const hallB = await hallOfName('Hall 3');
  await hallOfName('Hall 5');   // on the default Stagewatch too: Hall 3 shares it
  const hallD = await hallOfName('Hall 4');
  assert.equal((await act(ctl, 'hall:configure', { code: hall, stagewatchUrl: own.url, stagewatchKey: KEY })).ok, true);
  assert.equal((await act(ctl, 'hall:configure', { code: hallD, stagewatchUrl: plain.url, stagewatchKey: KEY })).ok, true);
  assert.equal((await act(ctl, 'admin:settings', { stagewatchUrl: shared.url, stagewatchKey: KEY })).ok, true);
  const tomCookie = await account('tom', 'Tom Tech', 'tech', { halls: [hall, hallB, hallD], rooms: [LEGAL] });
  const sueCookie = await account('sue', 'Sue Staff', 'staff', { halls: [hall], rooms: [LEGAL] });
  const moCookie = await account('mo', 'Mo Media', 'staff', { halls: [hall], rooms: [MEDIA] });
  const tom = await page(tomCookie, 'Tom in Main');
  const tomJoin = await joined(tom, { roomCode: hall, as: 'account' });
  const sue = await page(sueCookie, 'Sue in Legal');
  const sueJoin = await joined(sue, { roomCode: LEGAL, as: 'account' });
  let mo = await page(moCookie, 'Mo in Media');
  await joined(mo, { roomCode: MEDIA, as: 'account' });
  const gil = await page(undefined, 'Gil On stage');
  await joined(gil, { roomCode: hall, name: 'Gil', role: 'board' });
  await until(async () => (await act(tom, 'stage:targets', {})).canSend === true, 10_000, 'the hall\'s own Stagewatch linked over https, its key accepted');
  const upload = async (token, name, bytes, type) => {
    for (let i = 0; ; i++) {
      const f = new FormData();
      f.append('file', new Blob([bytes], { type }), name);
      const r = await fetch(srv.base + '/api/upload', { method: 'POST', headers: { 'X-AGM-Upload': token }, body: f });
      if (r.status !== 429 || i >= 8) return { status: r.status, ...(await r.json()) };
      await r.arrayBuffer();
      await wait(2100);
    }
  };
  const up = await upload(sueJoin.uploadToken, 'Legal advice.pdf', pdf, 'application/pdf');
  assert.equal((await act(sue, 'message', { type: 'file', url: up.url, filename: 'Legal advice.pdf', mime: 'application/pdf', confidential: true })).ok, true);
  const quote = (text) => ({ kind: 'snippet', unit: 'paragraph', text, from: { url: up.url, at: { page: 1 } } });
  const stageOf = (s) => heard.get(s).filter(([e]) => e === 'stage').map(([, v]) => v);
  const lastStage = (s) => stageOf(s).at(-1) || {};

  // In use only in Legal (a person's take to Sue, seated there): its line is refused.
  const toSue = await act(tom, 'page:push', { code: hall, to: { uid: 'a:' + sueJoin.uid }, content: quote('Settle at two million.') });
  assert.equal(toSue.ok, true, JSON.stringify(toSue));
  assert.deepEqual(await act(tom, 'stage:send', { withTake: toSue.seq }), { ok: false, error: 'This is confidential to Legal: show it in the Main room first.' });
  // On the Board, confirmed: in use in the Main room, the hall's own Stagewatch, over https: it goes, its row says so.
  const onBoard = await act(tom, 'page:push', { code: hall, to: 'board', content: quote('Revenue Q3: 4.2m'), confirm: true });
  assert.equal(onBoard.ok, true, JSON.stringify(onBoard));
  const went = await act(tom, 'stage:send', { withTake: onBoard.seq });
  assert.equal(went.ok, true, JSON.stringify(went));
  assert.match(rowsOf(srv.dataDir, 'stagewatch.send').at(-1)[1], /, with a push, a confidential line$/);
  // The frame carries it: the rooms where it is in use read that a confidential line is there, every other reader nothing.
  const screenMade = await act(ctl, 'display:create', { code: hall, name: 'Foyer' });
  const screen = io(srv.base, { transports: ['websocket'], forceNew: true, reconnection: false, auth: { display: screenMade.display.path.slice(3) } });
  t.after(() => screen.close());
  const screenStages = [];
  screen.on('display:stage', (x) => screenStages.push(x));
  screen.on('display:state', (x) => screenStages.push(x.stage));
  await until(() => screenStages.length > 0, 4000, 'the screen told its hall\'s frame');
  own.frame({ message: 'Revenue Q3: 4.2m', messageId: 77, messageAck: 'sent' });
  await until(() => lastStage(tom).message === '🔒 a confidential line', 4000, 'the Main room told it is there');
  await until(() => lastStage(mo).messageAck === 'sent', 4000, 'Media told the frame');
  assert.deepEqual([lastStage(mo).message, lastStage(sue).message], ['', '🔒 a confidential line']);
  await until(() => screenStages.at(-1) && screenStages.at(-1).messageAck === 'sent', 4000, 'the screen told the frame');
  assert.equal(screenStages.at(-1).message, '');
  const row = (await act(ctl, 'board:watch', {})).board.halls.find((h) => h.code === hall);
  assert.equal(row.stage.message, '');
  const ctx = JSON.stringify((await api(srv.base, 'GET', '/api/context', undefined, { cookie: admin })).body);
  assert.ok(!ctx.includes('Revenue Q3'));
  const before = model.bodies.length;
  assert.equal((await act(tom, 'ai:draft', { question: 'How was Q3?' })).ok, true);
  assert.ok(!model.bodies.slice(before).join('').includes('Revenue Q3'), 'the AI\'s brief carries none of it');
  // Held across a restart: the first frame after it is held too.
  await until(() => !!(pagesJson(srv.dataDir).holds || {})['hall:' + hall], 4000, 'the hold kept');
  assert.ok(!JSON.stringify(pagesJson(srv.dataDir).holds).includes('Revenue'), 'no text kept');
  srv = await restartServer(srv, ENV);
  mo = await page(moCookie, 'Mo in Media again');
  const moAgain = await joined(mo, { roomCode: MEDIA, as: 'account' });
  await until(async () => ((await act(mo, 'join', { roomCode: MEDIA, as: 'account', docs: true })).stage || {}).messageAck === 'sent', 10_000, 'the frame read again');
  assert.equal((await act(mo, 'join', { roomCode: MEDIA, as: 'account', docs: true })).stage.message, '', JSON.stringify(pagesJson(srv.dataDir).holds));
  void moAgain;
  // A new message on the frame: the hold goes, and every reader reads it.
  own.frame({ message: 'Five minutes', messageId: 78, messageAck: '' });
  await until(() => lastStage(mo).message === 'Five minutes', 4000, 'released on the next message');

  // A proposal: every new message is held until the desk's answer is read, an edited approval included.
  const tom2 = await page(tomCookie, 'Tom in Main again');
  await joined(tom2, { roomCode: hall, as: 'account' });
  await until(async () => (await act(tom2, 'stage:targets', {})).canPropose === true, 10_000, 'the desk');
  // A quote of a file names that file (the take's `made`): in use in the Main room since its first quote was shown there,
  // so no confirmation is asked again.
  const again = await act(tom2, 'page:push', { code: hall, to: 'board', content: quote('Costs Q3: 3.9m') });
  assert.equal(again.ok, true, JSON.stringify(again));
  const proposed = await act(tom2, 'stage:propose', { withTake: again.seq });
  assert.equal(proposed.ok, true, JSON.stringify(proposed));
  own.approve(proposed.proposal.id);
  own.frame({ message: 'Costs Q3 were 3.9m (edited)', messageId: 79 });
  await until(() => lastStage(mo).messageId === 79, 4000, 'Media told the frame');
  assert.equal(lastStage(mo).message, '');
  own.finish(proposed.proposal.id, true, 'shown');
  await wait(3500);   // the desk's answer read (every 3 s)
  own.frame({ message: 'Costs Q3 were 3.9m (edited)', messageId: 79, messageAck: 'seen' });
  await until(() => lastStage(mo).messageAck === 'seen', 4000, 'told again');
  assert.equal(lastStage(mo).message, '', 'held after the approval');
  own.frame({ message: 'Break', messageId: 80, messageAck: '' });
  await until(() => lastStage(mo).message === 'Break', 4000, 'released on the next message');
  const holdNow = () => (pagesJson(srv.dataDir).holds || {})['hall:' + hall] || null;

  // Two confidential lines in a row: the first stays held while the second waits for its own, which is held as it comes.
  const lineA = await act(tom2, 'page:push', { code: hall, to: 'board', content: quote('Line A: 1.1m') });
  assert.equal((await act(tom2, 'stage:send', { withTake: lineA.seq })).ok, true);
  own.frame({ message: 'Line A: 1.1m', messageId: 81, messageAck: '' });
  await until(() => lastStage(mo).messageId === 81, 4000, 'Media told A');
  assert.equal(lastStage(mo).message, '');
  const lineB = await act(tom2, 'page:push', { code: hall, to: 'board', content: quote('Line B: 2.2m') });
  assert.equal((await act(tom2, 'stage:send', { withTake: lineB.seq })).ok, true);
  own.frame({ message: 'Line A: 1.1m', messageId: 81, messageAck: 'seen' });
  await until(() => lastStage(mo).messageAck === 'seen', 4000, 'told A again');
  assert.equal(lastStage(mo).message, '', 'A held while B waits');
  own.frame({ message: 'Line B: 2.2m', messageId: 82, messageAck: '' });
  await until(() => lastStage(mo).messageId === 82, 4000, 'Media told B');
  assert.equal(lastStage(mo).message, '', 'B held as it comes');
  // The halls board too, read by a page of this run (the admin's from before the restart is gone with it).
  const ctlAgain = await page(admin, 'the admin again');
  await joined(ctlAgain, { roomCode: hall, as: 'account' });
  assert.equal((await act(ctlAgain, 'board:watch', {})).board.halls.find((h) => h.code === hall).stage.message, '', 'the halls board too');

  // A proposal the desk refuses while a sent line is held: the sent line stays held until the frame moves past it.
  const lineC = await act(tom2, 'page:push', { code: hall, to: 'board', content: quote('Line C: 3.3m') });
  const proposedC = await act(tom2, 'stage:propose', { withTake: lineC.seq });
  assert.equal(proposedC.ok, true, JSON.stringify(proposedC));
  await until(() => !!holdNow() && (holdNow().proposals || []).includes(proposedC.proposal.id), 4000, 'the proposal waited for');
  own.proposals.get(proposedC.proposal.id).state = 'rejected';
  await until(() => !!holdNow() && !(holdNow().proposals || []).length, 10_000, 'the refusal read');
  own.frame({ message: 'Line B: 2.2m', messageId: 82, messageAck: 'seen' });
  await until(() => lastStage(mo).messageAck === 'seen', 4000, 'told B again');
  assert.equal(lastStage(mo).message, '', 'B held after the refusal');

  // A desk's answer that is not plain (a state it does not name) is asked again: every new message is held meanwhile.
  const lineD = await act(tom2, 'page:push', { code: hall, to: 'board', content: quote('Line D: 4.4m') });
  const proposedD = await act(tom2, 'stage:propose', { withTake: lineD.seq });
  assert.equal(proposedD.ok, true, JSON.stringify(proposedD));
  own.proposals.get(proposedD.proposal.id).state = 'mulling';
  await wait(3500);   // the desk's answer read (every 3 s), and read as unknown
  own.frame({ message: 'Typed by the operator', messageId: 83, messageAck: '' });
  await until(() => lastStage(mo).messageId === 83, 4000, 'Media told the operator\'s line');
  assert.equal(lastStage(mo).message, '', 'held while the answer is not known');
  assert.deepEqual(holdNow().proposals, [proposedD.proposal.id]);
  own.proposals.get(proposedD.proposal.id).state = 'rejected';
  await until(() => !!holdNow() && !(holdNow().proposals || []).length, 10_000, 'the refusal read');
  own.frame({ message: 'Typed by the operator', messageId: 83, messageAck: 'seen' });
  await until(() => lastStage(mo).messageAck === 'seen', 4000, 'told it again');
  assert.equal(lastStage(mo).message, '', 'what it held stays held until the frame moves on');
  own.frame({ message: 'Break 2', messageId: 84, messageAck: '' });
  await until(() => lastStage(mo).message === 'Break 2', 4000, 'released on the next message');

  // As many lines as a hold waits on: the next is refused with words, and the page is told why before it asks; one new
  // message past every receipt's id ends them all.
  const lineE = await act(tom2, 'page:push', { code: hall, to: 'board', content: quote('Line E: 5.5m') });
  for (let i = 0; i < 20; i++) assert.equal((await act(tom2, 'stage:send', { withTake: lineE.seq })).ok, true, 'send ' + (i + 1));
  const FULL = 'Wait for the confidential lines already sent to this Stagewatch to come up, or for the show desk to answer them: 20 are waiting.';
  assert.deepEqual(await act(tom2, 'stage:send', { withTake: lineE.seq }), { ok: false, error: FULL });
  assert.deepEqual(await act(tom2, 'stage:propose', { withTake: lineE.seq }), { ok: false, error: FULL });
  assert.equal((await act(mo, 'join', { roomCode: MEDIA, as: 'account', docs: true })).stage.secretLine, FULL);
  assert.equal(holdNow().sends.length, 20, 'every wait kept');
  own.frame({ message: 'Line E: 5.5m', messageId: 90, messageAck: '' });
  await until(() => lastStage(mo).messageId === 90, 4000, 'Media told E');
  assert.equal(lastStage(mo).message, '');
  await until(() => !!holdNow() && !(holdNow().sends || []).length, 4000, 'every send ended');
  own.frame({ message: 'Break 3', messageId: 91, messageAck: '' });
  await until(() => lastStage(mo).message === 'Break 3', 4000, 'released on the next message');
  await until(() => !holdNow(), 4000, 'the hold let go');

  // Another hall's Stagewatch: shared with another hall, or reached over http, never.
  const tomB = await page(tomCookie, 'Tom in Hall 3');
  const tomBJoin = await joined(tomB, { roomCode: hallB, as: 'account' });
  const tomD = await page(tomCookie, 'Tom in Hall 4');
  const tomDJoin = await joined(tomD, { roomCode: hallD, as: 'account' });
  for (const [s, j, why] of [[tomB, tomBJoin, 'This hall shares its Stagewatch with another hall: a confidential line is not sent there.'], [tomD, tomDJoin, 'This hall\'s Stagewatch link is not encrypted: a confidential line is not sent.']]) {
    const f = await upload(j.uploadToken, 'Board pack.pdf', pdf, 'application/pdf');
    assert.equal((await act(s, 'message', { type: 'file', url: f.url, filename: 'Board pack.pdf', mime: 'application/pdf', confidential: true })).ok, true);
    const p = await act(s, 'page:push', { code: j.roomCode, to: 'board', content: { kind: 'snippet', unit: 'paragraph', text: 'Dividend 4p.', from: { url: f.url, at: { page: 1 } } } });
    assert.equal(p.ok, true, JSON.stringify(p));
    assert.equal(j.stage.secretLine, why, 'the page is told why before it asks');
    assert.deepEqual(await act(s, 'stage:send', { withTake: p.seq }), { ok: false, error: why });
  }
  assert.equal(tomJoin.stage.secretLine, true, 'its own Stagewatch over https: a confidential line may go');
  // A file marked after its quote went up: the line reads the mark now, and is refused as any confidential line there.
  const late = await upload(tomBJoin.uploadToken, 'Later secret.pdf', pdf, 'application/pdf');
  const lateMsg = await act(tomB, 'message', { type: 'file', url: late.url, filename: 'Later secret.pdf', mime: 'application/pdf' });
  assert.equal(lateMsg.ok, true, JSON.stringify(lateMsg));
  const lateQuote = await act(tomB, 'page:push', { code: hallB, to: 'board', content: { kind: 'snippet', unit: 'paragraph', text: 'Margin 12%.', from: { url: late.url, at: { page: 1 } } } });
  assert.equal(lateQuote.ok, true, JSON.stringify(lateQuote));
  assert.deepEqual(await act(tomB, 'file:mark', { messageId: lateMsg.id, on: true }), { ok: true, confidential: true });
  assert.deepEqual(await act(tomB, 'stage:send', { withTake: lateQuote.seq }), { ok: false, error: 'This hall shares its Stagewatch with another hall: a confidential line is not sent there.' });
});
