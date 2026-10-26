'use strict';
// What an approved show-desk proposal did is reported until Stagewatch takes it or refuses it for good. Stagewatch hands
// an approved proposal over once and turns it "undelivered: AGMessage didn't report back" five minutes later unless a
// result came, so a result that met a busy key (429), a key it would not take that minute (401/403), no answer, or a
// restart of AGMessage is told again — and only to the proposal that ran: a restarted desk's p1 is another proposal.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const deskresults = require('../lib/deskresults');
const { startServer, stopServer, restartServer, api, connect, emit, until, wait, fakeStagewatch } = require('./helpers');

const KEY = 'swk_desk_results_key_0001';   // secret-scan: fixture — the node key the fake Stagewatch is given

/** A server with one hall, linked to the fake Stagewatch `sw` (the default link, or the hall's own), its node id read off it. */
async function deskSetup(t, { sw: swOptions = {}, env = {}, hallLink = false } = {}) {
  const sw = await fakeStagewatch({ name: 'Desk', ...swOptions });
  const ctx = { sw, srv: await startServer(env), sockets: [] };
  t.after(async () => { ctx.sockets.forEach((s) => s.close()); await stopServer(ctx.srv.child); await sw.close(); });
  ctx.admin = (await api(ctx.srv.base, 'POST', '/api/setup', { username: 'ana', name: 'Ana Admin', password: 'the green room kettle' })).cookie;
  ctx.hall = (await api(ctx.srv.base, 'POST', '/api/rooms', { name: 'Main hall' }, { cookie: ctx.admin })).body.code;
  ctx.ctl = await connect(ctx.srv.base, ctx.admin); ctx.sockets.push(ctx.ctl);
  ctx.nodeId = (await emit(ctx.ctl, 'admin:settings')).nodeId;
  if (hallLink) assert.ok((await emit(ctx.ctl, 'hall:configure', { code: ctx.hall, stagewatchUrl: sw.url, stagewatchKey: KEY })).ok);
  else assert.ok((await emit(ctx.ctl, 'admin:settings', { stagewatchUrl: sw.url, stagewatchKey: KEY })).ok);
  await until(() => sw.requests.some((r) => r.url.includes('?target=')), 15000, 'AGMessage collects from the desk');
  return ctx;
}
const forUs = (ctx, line) => ({ line, state: 'approved', decidedBy: 'SM', from: { t: 'main', id: 'swdesk', name: 'Desk' }, target: { t: 'messenger', id: ctx.nodeId, name: 'AGMessage' } });
const posts = (sw, id, since = 0) => sw.requests.filter((r) => r.method === 'POST' && r.url === '/api/proposals/' + id + '/result' && r.at >= since);
const notices = async (ctx, words) => (await emit(ctx.ctl, 'admin:watchRoom', { roomCode: ctx.hall })).messages.filter((m) => /From the show desk/.test(m.text || '') && m.text.includes(words)).length;
const health = async (ctx) => (await api(ctx.srv.base, 'GET', '/api/health', undefined, { cookie: ctx.admin })).body;
const recent = async (ctx) => (await api(ctx.srv.base, 'GET', '/api/context', undefined, { cookie: ctx.admin })).body.recent.map((e) => e.text);
const onDisk = (ctx) => JSON.parse(fs.readFileSync(path.join(ctx.srv.dataDir, 'desk-results.json'), 'utf8'));
/**
 * What reached Stagewatch after `first` met its 429, inside the `ms` it asked for: '' when the hold was kept. AGMessage's
 * two loops each await their own requests, so at most one more of the desk's, and the context loop's push and fetch of a
 * second that began before the 429 was read, may already be on their way; nothing may follow once it was read (1.5 s).
 */
function holdBroken(sw, first, ms) {
  const during = sw.requests.filter((r) => r.at > first.at && r.at < first.at + ms - 100);
  const desk = during.filter((r) => r.url.startsWith('/api/proposals'));
  const context = during.filter((r) => r.url === '/api/context' || r.url === '/api/peers/context');
  const late = during.filter((r) => r.at > first.at + 1500);
  return desk.length <= 1 && context.length <= 2 && desk.length + context.length === during.length && !late.length ? ''
    : during.map((r) => '+' + (r.at - first.at) + ' ms ' + r.method + ' ' + r.url).join(', ');
}

test('what an answer to a result post means, and which proposal read back is still ours', () => {
  const v = (status, retryAfter = null, attempt = 1) => deskresults.postVerdict({ status, retryAfter }, attempt, { authWaitMs: 60000 });
  for (const s of [200, 201]) assert.deepEqual(v(s), { final: 'taken' });
  for (const s of [409, 400, 405, 413]) assert.deepEqual(v(s), { final: 'refused' }, String(s));
  assert.deepEqual(v(404), { final: 'gone' });
  assert.deepEqual([v(401), v(403)], [{ waitMs: 60000 }, { waitMs: 60000 }]);
  assert.deepEqual([v(429, 7), v(429), v(429, 0), v(429, 999), v(503, 5)].map((x) => x.waitMs), [7000, 60000, 1000, 120000, 5000]);
  assert.deepEqual([v(0), v(500), v(503), v(0, null, 6), v(500, null, 2)].map((x) => x.waitMs), [3000, 3000, 3000, 60000, 6000]);

  const rec = { id: 'p1', line: 'notice Doors open', target: 'ab12cd34', created: 1700000000000 };
  const p = { id: 'p1', line: 'notice Doors open', target: { t: 'messenger', id: 'ab12cd34' }, created: 1700000000000, state: 'approved' };
  assert.equal(deskresults.readBack(rec, p), 'post');
  assert.equal(deskresults.readBack(rec, { ...p, state: 'undelivered' }), 'post', 'Stagewatch takes a late result');
  assert.equal(deskresults.readBack(rec, { ...p, state: 'done' }), 'taken', 'an earlier post landed');
  assert.equal(deskresults.readBack(rec, { ...p, state: 'failed' }), 'taken', 'an earlier post of a failure landed');
  assert.equal(deskresults.readBack(rec, { ...p, state: 'unknown' }), 'wait');
  for (const other of [{ line: 'notice Hello' }, { created: 1700000000001 }, { target: { t: 'messenger', id: 'ff00ff00' } }, { state: 'pending' }, { state: 'rejected' }]) {
    assert.equal(deskresults.readBack(rec, { ...p, ...other }), 'gone', JSON.stringify(other));
  }
  assert.equal(deskresults.readBack(rec, { gone: true }), 'gone');
  assert.equal(deskresults.readBack({ ...rec, created: 0 }, { ...p, created: 0 }, { sameStagewatch: true }), 'post', 'no time from the desk: ours on the same Stagewatch');
  assert.equal(deskresults.readBack({ ...rec, created: 0 }, { ...p, created: 0 }, { sameStagewatch: false }), 'gone', '…and on no other');

  const good = { sw: '0123456789ab', link: 'hall:ABC234', id: 'p1', created: 1700000000000, line: 'notice x', target: 'ab12cd34', ok: true, words: 'shown in 1 meeting', ran: 1700000000500 };
  const read = (r) => deskresults.readRecords({ v: 1, results: [r] }, 'ab12cd34');
  assert.deepEqual(read(good), [good]);
  for (const bad of [{ created: '1' }, { created: 0 }, { id: 'p1/x' }, { target: 'ff00ff00' }, { ok: 'yes' }, { link: 'hall:abc' }, { sw: 'not a tag' }, { words: 'x'.repeat(301) }]) {
    assert.deepEqual(read({ ...good, ...bad }), [], JSON.stringify(bad));
  }
  assert.deepEqual(deskresults.readRecords(null, 'ab12cd34'), []);
  assert.equal(deskresults.readRecords({ results: Array.from({ length: 250 }, (_, i) => ({ ...good, id: 'p' + i })) }, 'ab12cd34').length, 200, 'at most 200, the newest');
});

test('a 429 waits its Retry-After across the whole link, then the result is taken: the notice shown once', async (t) => {
  const ctx = await deskSetup(t);
  const { sw } = ctx;
  // Longer than the desk's 3 s tick and the context's 5 s: without the hold, both would ask inside it.
  sw.answerResults = [{ status: 429, error: 'rate limit: too many requests with this key', retryAfter: 6 }];
  const id = sw.add(forUs(ctx, 'notice Break in five minutes'));
  await until(() => sw.proposals.get(id).state === 'done', 20000, 'taken at the second try');
  assert.equal(sw.proposals.get(id).words, 'shown in 1 meeting');
  const [first, second] = posts(sw, id);
  assert.equal(posts(sw, id).length, 2);
  assert.ok(second.at >= first.at + 6000, 'not before its Retry-After: ' + (second.at - first.at) + ' ms');
  assert.equal(holdBroken(sw, first, 6000), '', 'nothing more from that link while Stagewatch asked it to wait');
  assert.equal(await notices(ctx, 'Break in five minutes'), 1);
  await until(async () => (await health(ctx)).desk.waiting === 0, 4000, 'nothing waiting');
});

test('401 and 403: the result waits for the key, never dropped — taken once Stagewatch takes the key again', async (t) => {
  const ctx = await deskSetup(t, { env: { AGM_DESK_AUTH_WAIT_MS: '1000' } });
  const { sw } = ctx;
  sw.answerResults = [{ status: 503, error: 'busy', retryAfter: 2 }, { status: 403, error: 'this API key is read only' }, { status: 403, error: 'this API key is read only' }];
  const id = sw.add(forUs(ctx, 'notice Lunch is served'));
  await until(() => sw.proposals.get(id).state === 'done', 20000, 'taken at the fourth try');
  const p = posts(sw, id);
  assert.equal(p.length, 4);
  assert.ok(p[1].at - p[0].at >= 2000, 'a 503 with Retry-After waits as it says');
  assert.ok(p[2].at - p[1].at >= 1000 && p[3].at - p[2].at >= 1000, 'each 403 after the wait');

  // A 401 is Stagewatch not taking the key at all: the link is refused (it asks again after Stagewatch's lockout minute),
  // the result stays waiting, and it is told once the key is taken again.
  sw.answerResults = [{ status: 401, error: 'too many wrong PINs or keys — wait a minute' }];
  const later = sw.add(forUs(ctx, 'notice Doors close'));
  await until(async () => /^key refused/.test((await emit(ctx.ctl, 'admin:settings')).stage), 10000, 'the link refused');
  assert.equal(sw.proposals.get(later).state, 'approved');
  const held = (await health(ctx)).desk;
  assert.deepEqual([held.waiting, held.lastStatus, held.nextInMs], [1, 401, null], 'kept; no try is due while the link is refused');
  assert.equal(onDisk(ctx).results.length, 1, 'kept on disk');
  assert.ok((await emit(ctx.ctl, 'admin:settings', { stagewatchKey: 'swk_desk_results_key_0002' /* secret-scan: fixture */ })).ok);
  await until(() => sw.proposals.get(later).state === 'done', 15000, 'taken through the link accepted again');
  assert.equal(await notices(ctx, 'Doors close'), 1, 'run once');
});

test('a result not yet taken outlives a restart of AGMessage: read back, then posted — never run again', async (t) => {
  const ctx = await deskSetup(t);
  const { sw } = ctx;
  sw.answerResults = [{ status: 0 }, { status: 0 }, { status: 0 }];
  const id = sw.add(forUs(ctx, 'notice Doors open'));
  await until(() => posts(sw, id).length >= 1, 10000, 'its first post, unanswered');
  await stopServer(ctx.srv.child);
  const saved = onDisk(ctx).results;
  assert.equal(saved.length, 1);
  assert.deepEqual([saved[0].id, saved[0].created, saved[0].line, saved[0].target, saved[0].ok, saved[0].words], [id, sw.proposals.get(id).created, 'notice Doors open', ctx.nodeId, true, 'shown in 1 meeting']);
  assert.ok(!fs.readFileSync(path.join(ctx.srv.dataDir, 'desk-results.json'), 'utf8').includes('swk_'), 'never the key');
  sw.answerResults = [];
  const back = Date.now();
  ctx.srv = await restartServer(ctx.srv);
  ctx.ctl = await connect(ctx.srv.base, ctx.admin); ctx.sockets.push(ctx.ctl);
  await until(() => sw.proposals.get(id).state === 'done', 15000, 'taken after the restart');
  const after = sw.requests.filter((r) => r.at >= back && r.url.startsWith('/api/proposals/' + id));
  assert.deepEqual(after.map((r) => r.method), ['GET', 'POST'], 'read back first, then posted');
  assert.deepEqual(JSON.parse(after[1].body), { ok: true, words: 'shown in 1 meeting' });
  assert.equal(await notices(ctx, 'Doors open'), 1, 'not run again');
  await until(() => onDisk(ctx).results.length === 0, 4000, 'the file empties once it is taken');
});

test('a Stagewatch restart the link does not see: its new p1 gets its own result, never the old one\'s', async (t) => {
  const ctx = await deskSetup(t);
  const { sw } = ctx;
  sw.frame({ seq: 10 });
  sw.failResults = 1000;
  const old = sw.add(forUs(ctx, 'bogus line for AGMessage'));
  await until(() => posts(sw, old).length >= 1, 10000, 'its result posted, not taken');
  sw.restart();
  const restarted = Date.now();
  sw.frame({ seq: 40 });   // its frames counted on past the last one heard: the restart is not seen
  const fresh = sw.add(forUs(ctx, 'notice Doors open'));
  assert.equal(fresh, old, 'the same number, another proposal');
  sw.failResults = 0;
  await until(() => sw.proposals.get(fresh).state === 'done', 15000, 'the new p1 reported');
  assert.equal(sw.proposals.get(fresh).words, 'shown in 1 meeting');
  await wait(3500);   // the old result's next try comes and goes
  assert.ok(!posts(sw, fresh, restarted).some((r) => JSON.parse(r.body).ok === false), 'the old result never reached the new p1');
  assert.ok((await recent(ctx)).includes('a show-desk result could not be reported: gone'));
  assert.equal((await health(ctx)).desk.waiting, 0);
});

test('a hall\'s Stagewatch removed and set again: the result still waiting is told to the same desk', async (t) => {
  const ctx = await deskSetup(t, { hallLink: true });
  const { sw } = ctx;
  sw.failResults = 1000;
  const id = sw.add(forUs(ctx, 'notice Coffee is out'));
  await until(() => posts(sw, id).length >= 2, 15000, 'two posts not taken');
  assert.ok((await emit(ctx.ctl, 'hall:configure', { code: ctx.hall, stagewatchUrl: '' })).ok);
  assert.ok((await emit(ctx.ctl, 'hall:configure', { code: ctx.hall, stagewatchUrl: sw.url, stagewatchKey: KEY })).ok);
  const back = Date.now();
  sw.failResults = 0;
  await until(() => sw.proposals.get(id).state === 'done', 20000, 'taken through the link made again');
  assert.deepEqual(sw.requests.filter((r) => r.at >= back && r.url.startsWith('/api/proposals/' + id)).map((r) => r.method).slice(-2), ['GET', 'POST']);
  assert.equal(await notices(ctx, 'Coffee is out'), 1);
});

test('a refusal for good (409) is final: posted once, and said', async (t) => {
  const ctx = await deskSetup(t);
  const { sw } = ctx;
  sw.answerResults = [{ status: 409, error: 'proposal p1 is done' }];
  const id = sw.add(forUs(ctx, 'notice Mind the step'));
  await until(() => posts(sw, id).length >= 1, 10000, 'posted');
  await wait(9000);
  assert.equal(posts(sw, id).length, 1, 'never again');
  assert.ok((await recent(ctx)).includes('a show-desk result could not be reported: refused'));
  assert.equal((await health(ctx)).desk.waiting, 0);
});

test('Stagewatch restarted while AGMessage was down: a result kept on disk never reaches the new desk\'s p1', async (t) => {
  const ctx = await deskSetup(t);
  const { sw } = ctx;
  sw.answerResults = [{ status: 0 }, { status: 0 }, { status: 0 }];
  const old = sw.add(forUs(ctx, 'bogus line for AGMessage'));
  await until(() => posts(sw, old).length >= 1, 10000, 'posted, unanswered');
  await stopServer(ctx.srv.child);
  sw.answerResults = [];
  sw.restart();
  const restarted = Date.now();
  const fresh = sw.add(forUs(ctx, 'notice Hello again'));
  assert.equal(fresh, old);
  ctx.srv = await restartServer(ctx.srv);
  ctx.ctl = await connect(ctx.srv.base, ctx.admin); ctx.sockets.push(ctx.ctl);
  await until(() => sw.proposals.get(fresh).state === 'done', 15000, 'the new p1 reported');
  assert.equal(sw.proposals.get(fresh).words, 'shown in 1 meeting');
  await until(() => onDisk(ctx).results.length === 0, 6000, 'the old one ended (gone), the file empty');
  assert.ok(!posts(sw, fresh, restarted).some((r) => JSON.parse(r.body).ok === false), 'the old result never reached the new p1');
});

test('a result past Stagewatch\'s five minutes (undelivered, collected) is still told, and taken', async (t) => {
  const ctx = await deskSetup(t);
  const { sw } = ctx;
  sw.answerResults = [{ status: 0 }];
  const id = sw.add(forUs(ctx, 'notice Last call'));
  await until(() => posts(sw, id).length >= 1, 10000, 'its first post, unanswered');
  sw.expire(id);
  assert.deepEqual([sw.proposals.get(id).state, sw.proposals.get(id).words], ['undelivered', 'AGMessage didn\'t report back']);
  await until(() => sw.proposals.get(id).state === 'done', 15000, 'taken late');
});

test('several results collected in one tick, the first not taken: none is stranded, each is told', async (t) => {
  const ctx = await deskSetup(t);
  const { sw } = ctx;
  sw.failResults = 1;   // the first post of the tick is not taken
  const ids = ['notice Doors open', 'notice Coffee is out', 'notice Mind the step'].map((line) => sw.add(forUs(ctx, line)));
  await until(() => ids.every((id) => sw.proposals.get(id).state === 'done'), 20000, 'every one taken');
  for (const w of ['Doors open', 'Coffee is out', 'Mind the step']) assert.equal(await notices(ctx, w), 1, w + ': run once');
  assert.equal((await health(ctx)).desk.waiting, 0);
});

test('a 429 or a refused key met while following proposals stops the link at once: nothing more into the hold, no lockout', async (t) => {
  const ctx = await deskSetup(t);
  const { sw } = ctx;
  const crew = await connect(ctx.srv.base); ctx.sockets.push(crew);
  assert.ok((await emit(crew, 'join', { roomCode: ctx.hall, name: 'Alex', role: 'research' })).ok);
  await until(async () => (await emit(crew, 'stage:targets', {})).canPropose, 10000, 'the desk known');
  for (let i = 1; i <= 5; i++) assert.ok((await emit(crew, 'stage:propose', { text: 'Follow me ' + i, destination: 'speaker' })).ok);
  await wait(3500);   // every one followed at least once
  // The hold begins with the follow (one read of all this node proposed): it is the first to meet it, and nothing of
  // that tick or the next may follow it into the hold.
  let first = null;
  sw.onRequest = (r) => { if (r.url.includes('?from=')) { sw.onRequest = null; first = r; sw.holdAll(6000); } };
  await until(() => first, 6000, 'a follow, and the hold');
  await wait(6500);
  assert.equal(holdBroken(sw, first, 6000), '', 'one request met the 429, nothing followed it into the hold');

  const before = sw.counts.failures;
  sw.key = 'swk_desk_results_other_9';   // secret-scan: fixture — the operator revoked AGMessage's key
  await until(async () => /^key refused/.test((await emit(ctx.ctl, 'admin:settings')).stage), 10000, 'refused');
  await wait(4000);
  assert.ok(sw.counts.failures - before <= 2, 'the refused key is not sent on: ' + (sw.counts.failures - before) + ' wrong-key requests');
});

test('a 429 on the desk check keeps the desk and asks again in seconds: a notice approved meanwhile is still collected', async (t) => {
  const ctx = await deskSetup(t, { sw: { answerDeskChecks: [{ status: 429, error: 'rate limit: too many requests with this key', retryAfter: 1 }] } });
  const { sw } = ctx;
  const id = sw.add(forUs(ctx, 'notice Last train at eleven'));
  await until(() => sw.proposals.get(id).state === 'done', 15000, 'collected, run and reported');
});

test('on disk before its first post: AGMessage killed as that post leaves still reports it after the restart', async (t) => {
  const ctx = await deskSetup(t);
  const { sw } = ctx;
  sw.answerResults = [{ status: 0 }];
  sw.onResultPost = () => { sw.onResultPost = null; ctx.srv.child.kill('SIGKILL'); };   // no stop, no save: as a power cut
  const id = sw.add(forUs(ctx, 'notice The bar is open'));
  await until(() => ctx.srv.child.exitCode !== null || ctx.srv.child.signalCode !== null, 10000, 'killed');
  assert.deepEqual(onDisk(ctx).results.map((r) => r.id), [id], 'it was on disk before it left');
  ctx.srv = await restartServer(ctx.srv);
  ctx.ctl = await connect(ctx.srv.base, ctx.admin); ctx.sockets.push(ctx.ctl);
  await until(() => sw.proposals.get(id).state === 'done', 15000, 'taken after the restart');
  assert.equal(await notices(ctx, 'The bar is open'), 1, 'run once');
});

test('a hall moved to another Stagewatch: its result still waiting is told to nobody, never to the new one', async (t) => {
  const ctx = await deskSetup(t, { hallLink: true });
  const { sw } = ctx;
  const other = await fakeStagewatch({ name: 'Other desk' });
  t.after(() => other.close());
  sw.failResults = 1000;
  const id = sw.add(forUs(ctx, 'notice Coffee is out'));
  await until(() => posts(sw, id).length >= 1, 10000, 'posted, not taken');
  assert.ok((await emit(ctx.ctl, 'hall:configure', { code: ctx.hall, stagewatchUrl: other.url, stagewatchKey: KEY })).ok);
  await until(async () => (await recent(ctx)).includes('a show-desk result could not be reported: nobody to tell'), 10000, 'said');
  assert.equal((await health(ctx)).desk.waiting, 0);
  await until(() => onDisk(ctx).results.length === 0, 4000, 'the file empties');
  assert.ok(!other.requests.some((r) => r.url.startsWith('/api/proposals/' + id)), 'the other Stagewatch is never told');
});

test('following our proposals costs one read a tick however many wait for the show caller, and their states still arrive', async (t) => {
  const ctx = await deskSetup(t);
  const { sw } = ctx;
  const crew = await connect(ctx.srv.base); ctx.sockets.push(crew);
  assert.ok((await emit(crew, 'join', { roomCode: ctx.hall, name: 'Alex', role: 'research' })).ok);
  await until(async () => (await emit(crew, 'stage:targets', {})).canPropose, 10000, 'the desk known');
  const ids = [];
  for (let i = 1; i <= 10; i++) ids.push((await emit(crew, 'stage:propose', { text: 'Waiting ' + i, destination: 'speaker' })).proposal.id);
  const t0 = Date.now();
  await wait(7000);
  const since = sw.requests.filter((r) => r.at >= t0 && r.url.startsWith('/api/proposals'));
  assert.equal(since.filter((r) => /^\/api\/proposals\/p\d+$/.test(r.url)).length, 0, 'no read per proposal');
  assert.ok(since.filter((r) => r.url.includes('?from=')).length <= 4, 'one read of all of them a tick: ' + since.map((r) => r.url).join(' '));
  sw.approve(ids[4], 'Show caller');
  await until(async () => (await emit(ctx.ctl, 'admin:watchRoom', { roomCode: ctx.hall })).messages.some((m) => m.proposal && m.proposal.id === ids[4] && m.proposal.state === 'approved'), 8000, 'its state followed');
});

test('a link pointed at another Stagewatch while a collect is out: what the first handed over is never reported to the second', async (t) => {
  const ctx = await deskSetup(t);
  const a = ctx.sw;
  const b = await fakeStagewatch({ name: 'Desk B' });
  t.after(() => b.close());
  // Each desk numbers from p1: its own p1 for this AGMessage, with different lines.
  const fromA = a.add(forUs(ctx, 'bogus line from desk A'));
  const fromB = b.add(forUs(ctx, 'notice From desk B'));
  assert.equal(fromA, fromB);
  a.collectDelayMs = 1500;
  a.onRequest = (r) => { if (r.url.includes('?target=')) { a.onRequest = null; emit(ctx.ctl, 'admin:settings', { stagewatchUrl: b.url }); } };
  await until(() => b.proposals.get(fromB).state === 'done', 15000, 'desk B\'s own p1 run and reported');
  await wait(3500);
  const toB = posts(b, fromB).map((r) => JSON.parse(r.body));
  assert.deepEqual(toB, [{ ok: true, words: 'shown in 1 meeting' }], 'only its own result');
  assert.equal(a.proposals.get(fromA).state, 'approved', 'desk A is no longer linked: nobody to tell it');
  assert.ok((await recent(ctx)).includes('a show-desk result could not be reported: nobody to tell'));
});

test('a collect the desk refuses (the key speaks for another node) is said on every page and proposals are not offered', async (t) => {
  const ctx = await deskSetup(t);
  const { sw } = ctx;
  const crew = await connect(ctx.srv.base); ctx.sockets.push(crew);
  assert.ok((await emit(crew, 'join', { roomCode: ctx.hall, name: 'Alex', role: 'research' })).ok);
  await until(async () => (await emit(crew, 'stage:targets', {})).canPropose, 10000, 'the desk known');
  sw.collectRefusal = { status: 403, error: 'this key speaks for another node (or that node has its own key)' };
  await until(async () => (await emit(ctx.ctl, 'admin:settings')).tls.deskRefusal, 8000, 'the admin page says it');
  assert.equal((await emit(ctx.ctl, 'admin:settings')).tls.deskRefusal, 'this key speaks for another node (or that node has its own key)');
  assert.equal((await emit(crew, 'stage:targets', {})).canPropose, false, 'no proposal offered');
  assert.match((await emit(crew, 'stage:propose', { text: 'x', destination: 'speaker' })).error, /refuses this AGMessage/);
  assert.ok((await recent(ctx)).some((e) => /refuses to hand AGMessage what it approves: this key speaks for another node/.test(e)));
  sw.collectRefusal = null;
  await until(async () => (await emit(crew, 'stage:targets', {})).canPropose, 8000, 'offered again once it hands them over');
});
