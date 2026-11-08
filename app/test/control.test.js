'use strict';
// The laptop's admin, the rights it gives, and the control tasks (the 0.6.0 plan's Part 6, unit U17). machine.js control
// runs as SYSTEM from one account's control task, or in an administrator's elevated console; launch.js start, stop and
// rights are the person's side; the server turns the machine's events into audit rows, each once. Held here on every
// platform with Windows' hands stood in for (HKLM's record and its Grants, Task Scheduler, icacls, whoami and the account
// lookup): what only Windows shows (a control task's descriptor letting its one account run it, SYSTEM running it, the
// access lists applying) is the Windows readings lane's (R8, R11).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const h = require('./helpers');
const machine = require('../machine');
const launch = require('../launch');
const wire = require('../lib/machinewire');
const events = require('../lib/machineevents');
const audit = require('../lib/audit');

const SYS = 'C:\\Windows\\System32';
const ANA = 'S-1-5-21-1-2-3-1001';
const BEN = 'S-1-5-21-1-2-3-1002';
const CAL = 'S-1-5-21-1-2-3-1003';
const IT = 'S-1-5-21-1-2-3-500';
const SYSTEM_ROW = '"nt authority\\system","S-1-5-18"';
const ELEVATED = ['"BUILTIN\\Administrators","Alias","S-1-5-32-544","Mandatory group, Enabled by default, Enabled group, Group owner"', '"Mandatory Label\\High Mandatory Level","Label","S-1-16-12288",""'].join('\r\n');
const STANDARD = ['"BUILTIN\\Users","Alias","S-1-5-32-545","Mandatory group, Enabled by default, Enabled group"', '"Mandatory Label\\Medium Mandatory Level","Label","S-1-16-8192",""'].join('\r\n');
/** The accounts Windows knows here, by name: {sid, name, user, profile, group}. */
const ACCOUNTS = {
  'laptop\\ana': { sid: ANA, name: 'LAPTOP\\ana', user: true },
  'laptop\\ben': { sid: BEN, name: 'LAPTOP\\ben', user: true },
  'laptop\\cal': { sid: CAL, name: 'LAPTOP\\cal', user: true },
  'laptop\\it': { sid: IT, name: 'LAPTOP\\it', user: true },
  users: { sid: 'S-1-5-32-545', name: 'BUILTIN\\Users', group: true },
  'laptop\\showcrew': { sid: 'S-1-5-21-1-2-3-1010', name: 'LAPTOP\\ShowCrew', group: true },
  // An account Windows names whose local accounts could not be read (no local user, no group known), never signed in here.
  'laptop\\dee': { sid: 'S-1-5-21-1-2-3-1011', name: 'LAPTOP\\dee', lookupError: 'the module Microsoft.PowerShell.LocalAccounts is not in C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules\\Microsoft.PowerShell.LocalAccounts' },
};
const NAMES = Object.fromEntries(Object.values(ACCOUNTS).map((a) => [a.sid, a.name]));
const read = (f) => fs.readFileSync(f, 'utf8');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const fail = (status, err = 'ERROR: refused') => Object.assign(new Error(err), { status, stdout: '', stderr: err });
const base = (exe) => path.win32.basename(exe);

/**
 * Windows' hands stood in for: the install record (HKLM\SOFTWARE\AGMessage) and its Grants key, Task Scheduler's tasks
 * (each definition kept), icacls's grants (kept in the order asked), whoami's answers (`me`, `groups`) and the account
 * lookup PS_WHOSE does (ACCOUNTS). `onRun(tn)` is told each schtasks /Run.
 */
function fakeWindows({ record = { InstallDir: 'C:\\Program Files\\AGMessage', Port: '3023', Admin: ANA, AdminName: 'LAPTOP\\ana' }, grants = {}, me = SYSTEM_ROW, groups = '', tasks = [], onRun = () => {} } = {}) {
  const st = { record: record ? { ...record } : null, grants: { ...grants }, tasks: new Set([machine.SERVER_TASK, ...tasks]), xml: {}, calls: [], runs: [], icacls: [] };
  st.run = (exe, args, opts) => {
    const name = base(exe);
    st.calls.push({ name, args, env: opts && opts.env });
    if (name === 'whoami.exe') return args[0] === '/user' ? me : groups;
    if (name === 'reg.exe') {
      const key = args[1];
      if (args[0] === 'query' && key === machine.HKLM) { if (!st.record) throw fail(1); return Object.entries(st.record).map(([k, v]) => '    ' + k + '    ' + (k === 'Port' ? 'REG_DWORD    0x' + Number(v).toString(16) : 'REG_SZ    ' + v)).join('\r\n'); }
      if (args[0] === 'query' && key === machine.HKLM + '\\Grants') {
        if (args.includes('/v')) { if (!Object.hasOwn(st.grants, args[args.indexOf('/v') + 1])) throw fail(1); return ''; }
        if (!Object.keys(st.grants).length) throw fail(1);
        return Object.entries(st.grants).map(([sid, r]) => '    ' + sid + '    REG_SZ    ' + r).join('\r\n');
      }
      if (args[0] === 'add' && key === machine.HKLM) { if (!st.record) st.record = {}; st.record[args[args.indexOf('/v') + 1]] = args[args.indexOf('/d') + 1]; return ''; }
      if (args[0] === 'add' && key === machine.HKLM + '\\Grants') { st.grants[args[args.indexOf('/v') + 1]] = args[args.indexOf('/d') + 1]; return ''; }
      if (args[0] === 'delete' && key === machine.HKLM + '\\Grants') { if (!Object.hasOwn(st.grants, args[args.indexOf('/v') + 1])) throw fail(1); delete st.grants[args[args.indexOf('/v') + 1]]; return ''; }
    }
    if (name === 'schtasks.exe') {
      const tn = args[args.indexOf('/TN') + 1];
      if (args[0] === '/Create') { st.tasks.add(tn); st.xml[tn] = Buffer.from(fs.readFileSync(args[args.indexOf('/XML') + 1])).subarray(2).toString('utf16le'); return 'SUCCESS'; }
      if (args[0] === '/Query') { if (!st.tasks.has(tn)) throw fail(1); return ''; }
      if (args[0] === '/Delete') { st.tasks.delete(tn); return 'SUCCESS'; }
      if (args[0] === '/End') return '';
      if (args[0] === '/Run') { st.runs.push(tn); onRun(tn); return 'SUCCESS'; }
    }
    if (name === 'icacls.exe') { st.icacls.push(args.join(' ')); return 'processed 1 files'; }
    if (name === 'powershell.exe' && args[args.length - 1] === machine.PS_WHOSE) {
      const e = opts.env;
      const names = {};
      for (const sid of String(e.AGM_SIDS || '').split(',').filter(Boolean)) names[sid] = NAMES[sid] || '';
      const out = { names };
      if (e.AGM_ACCOUNT) {
        const a = ACCOUNTS[String(e.AGM_ACCOUNT).toLowerCase()] || Object.values(ACCOUNTS).find((x) => x.sid === e.AGM_ACCOUNT);
        out.account = a ? { sid: a.sid, name: a.name, translated: true, group: !!a.group, user: !!a.user, profile: !!a.profile, ...(a.lookupError ? { lookupError: a.lookupError } : {}) } : undefined;
        if (!a) out.accountError = 'Some or all identity references could not be translated.';
      }
      return JSON.stringify(out) + '\r\n';
    }
    throw new Error('the stand-in was asked what it does not know: ' + name + ' ' + args.join(' '));
  };
  return st;
}
/** A machine folder on this disk with an account's inbox\ and outbox\ (and work\), as install and a grant make them. */
function machineFolder(...sids) {
  const root = path.join(tmp('agm-ctl-'), 'AGMessage');
  for (const sub of ['work', 'inbox', 'outbox', 'staged']) fs.mkdirSync(path.join(root, 'machine', sub), { recursive: true });
  for (const name of ['data', 'token', 'logs']) fs.mkdirSync(path.join(root, name));
  for (const sid of sids) for (const box of ['inbox', 'outbox']) fs.mkdirSync(path.join(root, 'machine', box, sid));
  return root;
}
const inboxOf = (root, sid) => path.join(root, 'machine', 'inbox', sid, 'request.json');
const answerOf = (root, sid) => JSON.parse(read(path.join(root, 'machine', 'outbox', sid, 'answer.json')));
const eventsOf = (root) => { try { return read(path.join(root, 'machine', 'events.jsonl')).split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
let ids = 0;
const nextId = () => (++ids).toString(16).padStart(24, '0');
/** A request left in an account's inbox, as launch.js leaves it; its id returned. */
function ask(root, sid, request) {
  const id = nextId();
  fs.writeFileSync(inboxOf(root, sid), JSON.stringify({ id, ...request }));
  return id;
}
const control = (root, sid, win, net = {}) => machine.run(['control', '--for', sid, '--machine', root, '--sys', SYS], { run: win.run, net });

// ---------------------------------------------------------------- the request, read

test('a request is whole JSON of at most 4 KB, a known verb and fields of their types: anything else is refused, never defaulted', () => {
  const ok = (j) => machine.requestOf(Buffer.from(JSON.stringify(j)));
  const id = 'a'.repeat(24);
  assert.deepEqual(ok({ id, verb: 'start' }), { request: { id, verb: 'start' } });
  assert.deepEqual(ok({ id, verb: 'stop', force: ' a show on ' }), { request: { id, verb: 'stop', force: 'a show on' } });
  assert.deepEqual(ok({ id, verb: 'grant', account: 'LAPTOP\\ben', rights: ['stop', 'start'] }), { request: { id, verb: 'grant', account: 'LAPTOP\\ben', rights: ['start', 'stop'] } }, 'the rights in their own order');
  assert.deepEqual(ok({ id, verb: 'revoke', account: BEN, rights: 'all' }).request.rights, 'all');
  assert.deepEqual(ok({ id, verb: 'handover', account: 'LAPTOP\\ben', confirm: 'LAPTOP\\ben' }).request.confirm, 'LAPTOP\\ben');
  const refused = [
    [Buffer.from('{"id":"' + id + '","verb":"start"'), /not whole JSON/],
    [Buffer.from(JSON.stringify({ id, verb: 'stop', force: 'x'.repeat(5000) })), /over 4 KB/],
    [Buffer.from('[1,2]'), /not a request/],
    [Buffer.from(JSON.stringify({ verb: 'start' })), /no id of its shape/],
    [Buffer.from(JSON.stringify({ id: 'ZZ', verb: 'start' })), /no id of its shape/],
    [Buffer.from(JSON.stringify({ id, verb: 'reboot' })), /"reboot" is not a request AGMessage's control task knows \(start, stop, upgrade, back, grant, revoke, handover\)/],
    [Buffer.from(JSON.stringify({ id, verb: 'upgrade' })), /An upgrade request names one of look, release and file/],
    [Buffer.from(JSON.stringify({ id, verb: 'back' })), /A back request names the build it goes back to/],
    [Buffer.from(JSON.stringify({ id, verb: 7 })), /names no verb/],
    [Buffer.from(JSON.stringify({ id, verb: 'start', force: 'x' })), /A start request takes nothing more; "force" is not one of them/],
    [Buffer.from(JSON.stringify({ id, verb: 'stop', force: 1 })), /force is the reason you typed/],
    [Buffer.from(JSON.stringify({ id, verb: 'grant', account: 'LAPTOP\\ben', rights: ['start', 'start'] })), /each once/],
    [Buffer.from(JSON.stringify({ id, verb: 'grant', account: 'LAPTOP\\ben', rights: ['admin'] })), /each once, among token, start, stop, upgrade\./],
    [Buffer.from(JSON.stringify({ id, verb: 'grant', account: 'LAPTOP\\ben', rights: 'all' })), /among token, start, stop, upgrade\./, 'all is a revoke\'s alone'],
    [Buffer.from(JSON.stringify({ id, verb: 'grant', account: ['LAPTOP\\ben'], rights: ['start'] })), /names one Windows account/],
    [Buffer.from(JSON.stringify({ id, verb: 'handover', account: 'LAPTOP\\ben' })), /confirmed by typing the new admin's account name again/],
    [Buffer.from(JSON.stringify({ id, verb: 'handover', account: 'LAPTOP\\ben', confirm: 'LAPTOP\\ben', rights: ['start'] })), /"rights" is not one of them/],
  ];
  for (const [bytes, re] of refused) { const r = machine.requestOf(bytes); assert.match(r.problem || '', re, bytes.toString().slice(0, 80)); assert.equal(r.request, undefined); }
});

test('a request is taken only when lstat shows a file of its own: a link, a hard link, a folder or one over 4 KB is refused, and whatever was there is removed; it is read from its copy in machine\\work\\', () => {
  const root = machineFolder(BEN);
  const work = path.join(root, 'machine', 'work');
  const file = inboxOf(root, BEN);
  const target = path.join(root, 'data', 'secret.json');
  fs.writeFileSync(target, '{"id":"' + 'b'.repeat(24) + '","verb":"start"}');
  // A file link needs an administrator on Windows: there a junction to a folder stands for it, a link all the same.
  if (process.platform === 'win32') fs.symlinkSync(path.join(root, 'data'), file, 'junction'); else fs.symlinkSync(target, file);
  assert.throws(() => machine.takeRequest(fs, file, work), (e) => e.refused && /is a link, which the control task never follows/.test(e.words));
  assert.ok(!fs.existsSync(file) && fs.existsSync(target), 'the link removed, what it named untouched');
  fs.linkSync(target, file);
  assert.throws(() => machine.takeRequest(fs, file, work), (e) => e.refused && /a hard link/.test(e.words));
  assert.ok(!fs.existsSync(file) && fs.existsSync(target));
  fs.mkdirSync(file);
  assert.throws(() => machine.takeRequest(fs, file, work), (e) => e.refused && /is not a file/.test(e.words));
  assert.ok(!fs.existsSync(file), 'an empty folder in its place removed too');
  fs.writeFileSync(file, 'x'.repeat(machine.REQUEST_MAX + 1));
  assert.throws(() => machine.takeRequest(fs, file, work), (e) => e.refused && /over 4 KB/.test(e.words));
  assert.ok(!fs.existsSync(file));
  assert.throws(() => machine.takeRequest(fs, file, work), (e) => e.refused && /No request was waiting/.test(e.words));
  fs.writeFileSync(file, '{"id":"c"}');
  // The bytes read are the copy's in machine\work\, never the file its account can still change.
  const seen = [];
  const watched = { ...fs, readFileSync: (f, ...a) => { seen.push(f); return fs.readFileSync(f, ...a); } };
  assert.equal(machine.takeRequest(watched, file, work).bytes.toString(), '{"id":"c"}');
  assert.equal(seen.length, 1);
  assert.equal(path.dirname(seen[0]), work, 'read from machine\\work\\');
  assert.deepEqual(fs.readdirSync(work), [], 'its copy removed once read');
  assert.ok(!fs.existsSync(file), 'the inbox\'s request removed: nothing is read twice');
});

// ---------------------------------------------------------------- who may ask what

test('control --for runs as SYSTEM alone; a request that is not one is refused into the account\'s outbox and leaves no event', async () => {
  const root = machineFolder(BEN);
  let win = fakeWindows({ me: '"LAPTOP\\ben","' + BEN + '"', grants: { [BEN]: 'start,stop' } });
  ask(root, BEN, { verb: 'start' });
  let r = await control(root, BEN, win);
  assert.equal(r.code, 3);
  assert.match(r.text, /runs as SYSTEM, from that account's control task/);
  assert.ok(fs.existsSync(inboxOf(root, BEN)), 'not SYSTEM: the request is not even taken');
  assert.equal((await machine.run(['control', '--for', 'S-1-5-32-545', '--machine', root, '--sys', SYS], { run: win.run })).code, 64, 'a group\'s SID names no control task');
  assert.equal((await machine.run(['control', '--machine', root, '--sys', SYS], { run: win.run })).code, 64, 'neither --for nor --elevated');
  win = fakeWindows({ grants: { [BEN]: 'start,stop' } });
  fs.writeFileSync(inboxOf(root, BEN), '{"id":"' + 'd'.repeat(24) + '","verb":"start"');
  r = await control(root, BEN, win);
  assert.equal(r.code, 3);
  assert.deepEqual([answerOf(root, BEN).code, answerOf(root, BEN).ranAs, answerOf(root, BEN).for], [3, 'S-1-5-18', BEN]);
  assert.match(answerOf(root, BEN).words, /not whole JSON/);
  fs.writeFileSync(inboxOf(root, BEN), JSON.stringify({ id: 'e'.repeat(24), verb: 'format-disk' }));
  r = await control(root, BEN, win);
  assert.deepEqual([r.code, answerOf(root, BEN).id], [3, 'e'.repeat(24)], 'the refusal answers the request it read');
  fs.symlinkSync(path.join(root, 'data'), inboxOf(root, BEN), process.platform === 'win32' ? 'junction' : 'dir');
  r = await control(root, BEN, win);
  assert.equal(r.code, 3);
  assert.match(answerOf(root, BEN).words, /is a link/);
  // A queued run that finds no request writes no answer: the one there may be the run's before it, still to be read.
  const before = read(path.join(root, 'machine', 'outbox', BEN, 'answer.json'));
  r = await control(root, BEN, win);
  assert.equal(r.code, 3);
  assert.match(r.text, /No request was waiting/);
  assert.equal(read(path.join(root, 'machine', 'outbox', BEN, 'answer.json')), before, 'the answer already there is left as it was');
  assert.deepEqual(eventsOf(root), [], 'no request that was not one leaves an event');
  assert.deepEqual(win.runs, [], 'nothing was run');
});

test('the right is read from the install record at that moment: no right, a right taken back while its control task is still there, and giving from an account that is not the laptop\'s admin are each refused with their words', async () => {
  const root = machineFolder(BEN, CAL);
  const win = fakeWindows({ grants: { [BEN]: 'start' }, tasks: [machine.controlTask(BEN), machine.controlTask(CAL)] });
  ask(root, CAL, { verb: 'start' });
  assert.equal((await control(root, CAL, win)).code, 3);
  assert.equal(answerOf(root, CAL).words, 'You have no AGMessage rights on this PC. Ask LAPTOP\\ana, or an administrator.', 'its control task is still there, but the record names no right');
  ask(root, BEN, { verb: 'stop' });
  assert.equal((await control(root, BEN, win)).code, 3);
  assert.equal(answerOf(root, BEN).words, 'You may not stop AGMessage on this PC (your rights here: start). Ask LAPTOP\\ana, or an administrator.');
  for (const [verb, extra, words] of [
    ['grant', { account: 'LAPTOP\\cal', rights: ['start'] }, 'Only LAPTOP\\ana, this PC\'s AGMessage admin, can give rights.'],
    ['revoke', { account: 'LAPTOP\\cal', rights: 'all' }, 'Only LAPTOP\\ana, this PC\'s AGMessage admin, can take rights back.'],
    ['handover', { account: 'LAPTOP\\ben', confirm: 'LAPTOP\\ben' }, 'Only LAPTOP\\ana, this PC\'s AGMessage admin, can hand AGMessage\'s admin over.'],
  ]) {
    ask(root, BEN, { verb, ...extra });
    assert.equal((await control(root, BEN, win)).code, 3, verb);
    assert.equal(answerOf(root, BEN).words, words, verb);
  }
  assert.deepEqual([win.runs, win.grants], [[], { [BEN]: 'start' }], 'nothing done');
  // Each request beyond the asker's rights is a machine event of its own (machine.refused), so the audit log shows who
  // asked for what: the account it named is said as typed, never looked up.
  assert.deepEqual(eventsOf(root).map((e) => [e.seq, e.kind, e.by.sid, e.for.sid, e.rights]), [
    [1, 'machine.refused', CAL, CAL, ['start']], [2, 'machine.refused', BEN, BEN, ['stop']], [3, 'machine.refused', BEN, BEN, ['start']],
    [4, 'machine.refused', BEN, BEN, []], [5, 'machine.refused', BEN, BEN, []],
  ]);
  assert.equal(eventsOf(root)[2].words, 'LAPTOP\\ben asked to give LAPTOP\\cal start, and was refused: Only LAPTOP\\ana, this PC\'s AGMessage admin, can give rights.');
  assert.equal(eventsOf(root)[3].words, 'LAPTOP\\ben asked to take back every right from LAPTOP\\cal, and was refused: Only LAPTOP\\ana, this PC\'s AGMessage admin, can take rights back.');
  assert.match(eventsOf(root)[4].words, /^LAPTOP\\ben asked to hand AGMessage's admin over to LAPTOP\\ben, and was refused/);
  assert.ok(!win.calls.some((c) => c.name === 'powershell.exe' && c.env && c.env.AGM_ACCOUNT), 'no account a refused request names was looked up');
  // No install record: nobody holds a right, and there is no install to keep an event of.
  const none = fakeWindows({ record: null });
  ask(root, BEN, { verb: 'start' });
  await control(root, BEN, none);
  assert.equal(answerOf(root, BEN).words, 'You have no AGMessage rights on this PC. Ask an administrator.');
  assert.equal(eventsOf(root).length, 5);
});

// ---------------------------------------------------------------- give, take back, hand over

test('grant: from the laptop\'s admin\'s own task, the account resolved to its SID once, its folders, its control task and its token read made, its Grants value written last; one event, its seq', async () => {
  const root = machineFolder(ANA);
  const win = fakeWindows();
  const nudged = [];
  const net = { nudge: async (o) => { nudged.push(o); return { ok: true, status: 200, json: { ok: true, written: 1 } }; } };
  fs.writeFileSync(path.join(root, 'token', 'admin-token'), '0123456789abcdef');   // secret-scan: fixture
  ask(root, ANA, { verb: 'grant', account: 'LAPTOP\\ben', rights: ['stop', 'start', 'token'] });
  const r = await control(root, ANA, win, net);
  assert.equal(r.code, 0, r.text);
  assert.equal(answerOf(root, ANA).words, 'Given: LAPTOP\\ben may now token, start, stop AGMessage on this PC.');
  assert.deepEqual(answerOf(root, ANA).rights, ['token', 'start', 'stop']);
  assert.equal(answerOf(root, ANA).audited, 1, 'the server said it wrote the row');
  assert.deepEqual(win.grants, { [BEN]: 'token,start,stop' });
  for (const box of ['inbox', 'outbox']) assert.ok(fs.statSync(path.join(root, 'machine', box, BEN)).isDirectory(), box);
  assert.ok(win.icacls.includes(path.join(root, 'machine', 'inbox', BEN) + ' /inheritance:r /grant:r *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F *' + BEN + ':(WD)'), 'it may add a file to its inbox\\, never a folder');
  assert.ok(win.icacls.includes(path.join(root, 'machine', 'inbox', BEN) + ' /grant *' + BEN + ':(OI)(IO)W'), 'and write the files in it');
  assert.ok(win.icacls.includes(path.join(root, 'machine', 'outbox', BEN) + ' /inheritance:r /grant:r *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F *' + BEN + ':(OI)(CI)RX'), 'it may read its outbox\\');
  assert.ok(win.icacls.includes(path.join(root, 'token') + ' /grant:r *' + BEN + ':(OI)(CI)R'), 'given token: read on token\\');
  const xml = win.xml[machine.controlTask(BEN)];
  assert.ok(xml.includes('<SecurityDescriptor>D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FRFX;;;' + BEN + ')</SecurityDescriptor>'), 'its own control task, which it alone may run');
  assert.ok(xml.includes('<UserId>S-1-5-18</UserId>') && xml.includes('C:\\Program Files\\AGMessage\\app\\machine.js&quot; control --for ' + BEN + ' --machine ' + root + ' --sys ' + SYS), 'SYSTEM runs machine.js control for that SID, fixed at registration');
  const order = win.calls.map((c) => c.name + ' ' + c.args.slice(0, 2).join(' '));
  assert.ok(order.indexOf('reg.exe add ' + machine.HKLM + '\\Grants') > order.indexOf('schtasks.exe /Create /TN'), 'the right is recorded once its means are there');
  assert.ok(order.indexOf('icacls.exe ' + path.join(root, 'token') + ' /grant:r') > order.indexOf('reg.exe add ' + machine.HKLM + '\\Grants'), 'the read on the token given only once the record names it');
  assert.deepEqual(eventsOf(root).map((e) => [e.seq, e.kind, e.by, e.for, e.rights]), [[1, 'machine.grant', { sid: ANA, name: 'LAPTOP\\ana' }, { sid: BEN, name: 'LAPTOP\\ben' }, ['token', 'start', 'stop']]]);
  assert.ok(!read(path.join(root, 'machine', 'events.jsonl')).includes('0123456789abcdef'), 'no token in an event');
  assert.deepEqual(nudged.map((n) => n.port), [3023], 'the server told to read its events');
  // Already held: done, said, and nothing written; one person's account only.
  ask(root, ANA, { verb: 'grant', account: 'LAPTOP\\ben', rights: ['start'] });
  assert.equal((await control(root, ANA, win, net)).code, 0);
  assert.deepEqual([answerOf(root, ANA).already, answerOf(root, ANA).words], [true, 'LAPTOP\\ben already holds start.']);
  for (const [account, re] of [['Users', /BUILTIN\\Users is not one person's account \(a group or a service\)\. Give rights to one person's account\./], ['LAPTOP\\ShowCrew', /Give rights to one person's account\./], ['LAPTOP\\dee', /Windows cannot confirm that LAPTOP\\dee is one person's account on this PC: its local accounts could not be read \(the module Microsoft\.PowerShell\.LocalAccounts is not in /], ['LAPTOP\\nobody', /"LAPTOP\\nobody" is not an account Windows knows on this PC/], ['LAPTOP\\ana', /LAPTOP\\ana is this PC's AGMessage admin and holds every right already\./]]) {
    ask(root, ANA, { verb: 'grant', account, rights: ['start'] });
    assert.equal((await control(root, ANA, win, net)).code, 3, account);
    assert.match(answerOf(root, ANA).words, re);
  }
  assert.equal(eventsOf(root).length, 1, 'one event: the grant that was done');
});

test('revoke: the right goes first (the record is read at every request), then what the account no longer needs; all takes its control task, inbox\\ and outbox\\ and its token read', async () => {
  const root = machineFolder(ANA, BEN);
  const win = fakeWindows({ grants: { [BEN]: 'token,start,stop' }, tasks: [machine.controlTask(BEN)] });
  ask(root, ANA, { verb: 'revoke', account: 'LAPTOP\\ben', rights: ['stop'] });
  assert.equal((await control(root, ANA, win)).code, 0);
  assert.equal(answerOf(root, ANA).words, 'Taken back: LAPTOP\\ben may now only token, start.');
  assert.deepEqual(win.grants, { [BEN]: 'token,start' });
  assert.ok(win.tasks.has(machine.controlTask(BEN)) && fs.existsSync(path.join(root, 'machine', 'inbox', BEN)), 'it still needs its control task');
  // From its own task, a moment later: the stop is refused at once.
  ask(root, BEN, { verb: 'stop' });
  await control(root, BEN, win);
  assert.match(answerOf(root, BEN).words, /^You may not stop AGMessage on this PC \(your rights here: token, start\)/);
  ask(root, ANA, { verb: 'revoke', account: BEN, rights: 'all' });
  assert.equal((await control(root, ANA, win)).code, 0, 'a SID the record names is taken as it is');
  assert.equal(answerOf(root, ANA).words, 'Taken back: LAPTOP\\ben has no AGMessage rights on this PC now.');
  assert.deepEqual(win.grants, {});
  assert.ok(!win.tasks.has(machine.controlTask(BEN)), 'its control task removed');
  for (const box of ['inbox', 'outbox']) assert.ok(!fs.existsSync(path.join(root, 'machine', box, BEN)), box + ' removed');
  assert.ok(win.icacls.includes(path.join(root, 'token') + ' /remove:g *' + BEN), 'its token read taken back');
  assert.deepEqual(eventsOf(root).map((e) => [e.seq, e.kind, e.for.sid, e.rights]), [[1, 'machine.revoke', BEN, ['stop']], [2, 'machine.refused', BEN, ['stop']], [3, 'machine.revoke', BEN, ['token', 'start']]]);
  const order = win.calls.map((c) => c.name + ' ' + c.args.slice(0, 3).join(' '));
  assert.ok(order.lastIndexOf('icacls.exe ' + path.join(root, 'token') + ' /remove:g *' + BEN) < order.lastIndexOf('reg.exe delete ' + machine.HKLM + '\\Grants /v'), 'the read on the token taken back before the record stops naming it');
  ask(root, ANA, { verb: 'revoke', account: 'LAPTOP\\ben', rights: 'all' });
  assert.equal((await control(root, ANA, win)).code, 3);
  assert.equal(answerOf(root, ANA).words, 'LAPTOP\\ben has no AGMessage rights on this PC.');
  ask(root, ANA, { verb: 'revoke', account: 'LAPTOP\\ana', rights: ['start'] });
  await control(root, ANA, win);
  assert.match(answerOf(root, ANA).words, /LAPTOP\\ana is this PC's AGMessage admin: hand AGMessage's admin over/);
  assert.equal(eventsOf(root).length, 3);
});

test('handover: confirmed by the name typed again; the new admin gets every right and the giving, the old one keeps none, its control task removed last; a later request from the old admin is refused', async () => {
  const root = machineFolder(ANA, BEN);
  const win = fakeWindows({ grants: { [BEN]: 'start' }, tasks: [machine.controlTask(ANA), machine.controlTask(BEN)] });
  ask(root, ANA, { verb: 'handover', account: 'LAPTOP\\ben', confirm: 'LAPTOP\\bem' });
  assert.equal((await control(root, ANA, win)).code, 3);
  assert.match(answerOf(root, ANA).words, /type the new admin's account name again exactly: "LAPTOP\\bem" is not "LAPTOP\\ben"\. Nothing was changed\./);
  assert.deepEqual([win.record.Admin, eventsOf(root)], [ANA, []]);
  ask(root, ANA, { verb: 'handover', account: 'LAPTOP\\ben', confirm: 'laptop\\BEN' });
  const r = await control(root, ANA, win);
  assert.equal(r.code, 0, r.text);
  assert.equal(answerOf(root, ANA).words, 'LAPTOP\\ben is now this PC\'s AGMessage admin, with every right and the giving of them. LAPTOP\\ana keeps none, unless LAPTOP\\ben gives them back.');
  assert.deepEqual([win.record.Admin, win.record.AdminName, win.grants], [BEN, 'LAPTOP\\ben', {}], 'the record rewritten; the new admin\'s own Grants value goes');
  for (const name of ['token', 'logs']) {
    assert.ok(win.icacls.includes(path.join(root, name) + ' /grant:r *' + BEN + ':(OI)(CI)R'), 'the new admin reads ' + name);
    assert.ok(win.icacls.includes(path.join(root, name) + ' /remove:g *' + ANA), 'the old admin\'s read on ' + name + ' taken back');
  }
  assert.ok(!win.tasks.has(machine.controlTask(ANA)) && win.tasks.has(machine.controlTask(BEN)), 'the old admin\'s control task removed; the new admin\'s registered');
  const order = win.calls.map((c) => c.name + ' ' + c.args.slice(0, 3).join(' '));
  assert.ok(order.lastIndexOf('schtasks.exe /Delete /TN ' + machine.controlTask(ANA)) > order.lastIndexOf('reg.exe add ' + machine.HKLM + ' /v'), 'removed last, after the record');
  assert.ok(!fs.existsSync(path.join(root, 'machine', 'inbox', ANA)), 'the old admin\'s inbox removed');
  assert.ok(fs.existsSync(path.join(root, 'machine', 'outbox', ANA, 'answer.json')), 'its outbox kept for the answer it reads');
  assert.deepEqual(eventsOf(root).map((e) => [e.kind, e.by.sid, e.for.sid, e.rights]), [['machine.handover', ANA, BEN, ['token', 'start', 'stop', 'upgrade']]]);
  // The old admin keeps no right: a request it still leaves is refused, naming the new admin.
  fs.mkdirSync(path.join(root, 'machine', 'inbox', ANA));
  ask(root, ANA, { verb: 'start' });
  assert.equal((await control(root, ANA, win)).code, 3);
  assert.equal(answerOf(root, ANA).words, 'You have no AGMessage rights on this PC. Ask LAPTOP\\ben, or an administrator.');
  // The new admin gives and takes back; the old admin's outbox, holding no right, goes at its next change.
  ask(root, BEN, { verb: 'grant', account: 'LAPTOP\\ana', rights: ['start'] });
  assert.equal((await control(root, BEN, win)).code, 0);
  assert.deepEqual(win.grants, { [ANA]: 'start' });
  assert.ok(fs.existsSync(path.join(root, 'machine', 'outbox', ANA)), 'given a right again: its outbox kept');
});

test('an administrator\'s elevated console may hand over a laptop whose admin account is gone: the event names that administrator; a console that is not elevated is refused', async () => {
  const root = machineFolder();
  const file = path.join(root, 'machine', 'work', 'request-1.json');
  const out = path.join(root, 'answer.json');
  let win = fakeWindows({ me: '"LAPTOP\\it","' + IT + '"', groups: STANDARD });
  fs.writeFileSync(file, JSON.stringify({ id: nextId(), verb: 'handover', account: 'LAPTOP\\cal', confirm: 'LAPTOP\\cal' }));
  let r = await machine.run(['control', '--elevated', '--request', file, '--machine', root, '--sys', SYS, '--out', out], { run: win.run });
  assert.equal(r.code, 3);
  assert.match(r.text, /runs in an administrator's elevated console/);
  win = fakeWindows({ me: '"LAPTOP\\it","' + IT + '"', groups: ELEVATED });
  assert.equal((await machine.run(['control', '--elevated', '--request', path.join(root, 'data', 'x.json'), '--machine', root, '--sys', SYS], { run: win.run })).code, 64, 'a request file outside machine\\work\\');
  r = await machine.run(['control', '--elevated', '--request', file, '--machine', root, '--sys', SYS, '--out', out], { run: win.run });
  assert.equal(r.code, 0, r.text);
  const rec = JSON.parse(read(out));
  assert.deepEqual([rec.verb, rec.code, rec.admin, rec.adminName, rec.ranAs], ['control', 0, CAL, 'LAPTOP\\cal', IT]);
  assert.deepEqual([win.record.Admin, win.record.AdminName], [CAL, 'LAPTOP\\cal']);
  const [ev] = eventsOf(root);
  assert.deepEqual([ev.kind, ev.by, ev.for.sid], ['machine.handover', { sid: IT, name: 'LAPTOP\\it' }, CAL]);
  assert.match(ev.words, /^LAPTOP\\it \(an administrator\) handed AGMessage's admin on this PC over from LAPTOP\\ana to LAPTOP\\cal; LAPTOP\\ana keeps no right\.$/);
  assert.ok(!fs.existsSync(file), 'the request file removed');
  assert.ok(!fs.existsSync(path.join(root, 'machine', 'outbox', IT)), 'nothing written into an outbox for the elevated console: its answer is --out');
});

// ---------------------------------------------------------------- the token's read, which Windows holds

/** Windows' hands where the calls `pred(name, args)` picks fail as Windows' would (Access is denied.), each kept in `failed`. */
function failing(win, pred) {
  const inner = win.run;
  win.failed = [];
  win.run = (exe, args, opts) => {
    if (pred(base(exe), args)) { win.failed.push(base(exe) + ' ' + args.join(' ')); throw fail(5, 'Access is denied.'); }
    return inner(exe, args, opts);
  };
  return win;
}

test('grant: a read on the token Windows will not give is taken off the record again and said: the rest given, not done (2), the event naming only what was given; the record never names less than Windows grants', async () => {
  const root = machineFolder(ANA);
  const tokenDir = path.join(root, 'token');
  const refusesRead = (name, args) => name === 'icacls.exe' && args[0] === tokenDir && args[1] === '/grant:r';
  let win = failing(fakeWindows(), refusesRead);
  ask(root, ANA, { verb: 'grant', account: 'LAPTOP\\ben', rights: ['token', 'start'] });
  let r = await control(root, ANA, win);
  assert.equal(r.code, 2, r.text);
  assert.deepEqual([answerOf(root, ANA).code, answerOf(root, ANA).rights], [2, ['start']]);
  assert.match(answerOf(root, ANA).words, /^Given: LAPTOP\\ben may now start AGMessage on this PC\. token was not given: LAPTOP\\ben could not be given the read on .*token \(Access is denied\.\)\.$/);
  assert.deepEqual(win.grants, { [BEN]: 'start' }, 'the record names no read Windows did not give');
  assert.deepEqual(eventsOf(root).map((e) => [e.kind, e.rights]), [['machine.grant', ['start']]]);
  assert.match(eventsOf(root)[0].words, /token was not given/);
  // The token alone, refused: nothing given, no event, and the means made for an account with no right taken away.
  win = failing(fakeWindows(), refusesRead);
  ask(root, ANA, { verb: 'grant', account: 'LAPTOP\\cal', rights: ['token'] });
  r = await control(root, ANA, win);
  assert.equal(r.code, 2);
  assert.match(answerOf(root, ANA).words, /^Nothing was given\. token was not given: LAPTOP\\cal could not be given the read on/);
  assert.deepEqual([win.grants, eventsOf(root).length], [{}, 1]);
  assert.ok(!win.tasks.has(machine.controlTask(CAL)), 'its control task removed');
  for (const box of ['inbox', 'outbox']) assert.ok(!fs.existsSync(path.join(root, 'machine', box, CAL)), box + ' removed');
  // The record could not be put back either: it names a read Windows does not grant, which refuses nothing open, and the
  // words say how to take it back.
  win = failing(fakeWindows(), (name, args) => refusesRead(name, args) || (name === 'reg.exe' && args[0] === 'delete'));
  ask(root, ANA, { verb: 'grant', account: 'LAPTOP\\cal', rights: ['token'] });
  r = await control(root, ANA, win);
  assert.equal(r.code, 2);
  assert.match(answerOf(root, ANA).words, /The record still names token for LAPTOP\\cal, which Windows does not grant \(.*Access is denied\.\)\): take it back with "Take back from LAPTOP\\cal: token"\.$/);
  assert.deepEqual(win.grants, { [CAL]: 'token' });
  assert.ok(!win.icacls.some((a) => a.startsWith(tokenDir + ' ')), 'no read on the token was given');
  assert.ok(win.tasks.has(machine.controlTask(CAL)), 'named on the record: its means kept');
  // The Grants value cannot be written at all: nothing given, and no read on the token was ever given.
  win = failing(fakeWindows(), (name, args) => name === 'reg.exe' && args[0] === 'add');
  ask(root, ANA, { verb: 'grant', account: 'LAPTOP\\ben', rights: ['token'] });
  r = await control(root, ANA, win);
  assert.equal(r.code, 2);
  assert.match(answerOf(root, ANA).words, /^Nothing was given: the install record's Grants for S-1-5-21-1-2-3-1002 could not be written \(Access is denied\.\)\.$/);
  assert.ok(!win.icacls.some((a) => a.startsWith(tokenDir + ' ')), 'the read comes only after the record');
  assert.ok(!win.tasks.has(machine.controlTask(BEN)) && !fs.existsSync(path.join(root, 'machine', 'inbox', BEN)), 'the means made for an account with no right taken away again');
  assert.equal(eventsOf(root).length, 1);
});

test('revoke: the read on the token is taken back before the record stops naming it; one Windows keeps stays on the record and is said, not done (2), the rest taken and the event naming only that', async () => {
  const root = machineFolder(ANA, BEN);
  const tokenDir = path.join(root, 'token');
  const keepsRead = (name, args) => name === 'icacls.exe' && args[0] === tokenDir && args[1] === '/remove:g';
  let win = failing(fakeWindows({ grants: { [BEN]: 'token,start,stop' }, tasks: [machine.controlTask(BEN)] }), keepsRead);
  ask(root, ANA, { verb: 'revoke', account: 'LAPTOP\\ben', rights: 'all' });
  let r = await control(root, ANA, win);
  assert.equal(r.code, 2, r.text);
  assert.deepEqual(win.grants, { [BEN]: 'token' }, 'start and stop taken; token stays on the record while Windows grants its read');
  assert.ok(win.tasks.has(machine.controlTask(BEN)) && fs.existsSync(path.join(root, 'machine', 'inbox', BEN)), 'still named on the record: its means kept');
  assert.match(answerOf(root, ANA).words, /^Taken back: LAPTOP\\ben may now only token\. LAPTOP\\ben can still read the token: the read on .*token \(Access is denied\.\) could not be taken back, so the record still names token\. Take it back again, or ask an administrator\.$/);
  assert.deepEqual(eventsOf(root).map((e) => [e.kind, e.rights]), [['machine.revoke', ['start', 'stop']]]);
  assert.match(eventsOf(root)[0].words, /can still read the token/);
  // The token alone, kept by Windows again: nothing taken back, no event.
  ask(root, ANA, { verb: 'revoke', account: 'LAPTOP\\ben', rights: ['token'] });
  r = await control(root, ANA, win);
  assert.equal(r.code, 2);
  assert.match(answerOf(root, ANA).words, /^Nothing was taken back\. LAPTOP\\ben can still read the token/);
  assert.deepEqual([win.grants, eventsOf(root).length], [{ [BEN]: 'token' }, 1]);
  // Windows takes the read back but the record will not be written: the read is what was taken, the record still names it.
  win = failing(fakeWindows({ grants: { [BEN]: 'token' }, tasks: [machine.controlTask(BEN)] }), (name, args) => name === 'reg.exe' && args[0] === 'delete');
  ask(root, ANA, { verb: 'revoke', account: 'LAPTOP\\ben', rights: ['token'] });
  r = await control(root, ANA, win);
  assert.equal(r.code, 2);
  assert.ok(win.icacls.includes(tokenDir + ' /remove:g *' + BEN));
  assert.deepEqual(win.grants, { [BEN]: 'token' });
  assert.match(answerOf(root, ANA).words, /^Taken back: only the read on the token, which LAPTOP\\ben can no longer read\. The record could not be written \(.*\), so it still names token for LAPTOP\\ben: take it back again\.$/);
  assert.deepEqual(eventsOf(root).map((e) => [e.kind, e.rights]).at(-1), ['machine.revoke', ['token']]);
  // A right the record holds alone (start), its write refused: nothing was taken back.
  win = failing(fakeWindows({ grants: { [BEN]: 'start,stop' }, tasks: [machine.controlTask(BEN)] }), (name, args) => name === 'reg.exe' && args[0] === 'add');
  ask(root, ANA, { verb: 'revoke', account: 'LAPTOP\\ben', rights: ['stop'] });
  r = await control(root, ANA, win);
  assert.equal(r.code, 2);
  assert.match(answerOf(root, ANA).words, /^Nothing was taken back\. The record could not be written/);
  assert.equal(eventsOf(root).length, 2);
  // Asked again with Windows answering: done.
  win = fakeWindows({ grants: { [BEN]: 'token' }, tasks: [machine.controlTask(BEN)] });
  ask(root, ANA, { verb: 'revoke', account: 'LAPTOP\\ben', rights: ['token'] });
  assert.equal((await control(root, ANA, win)).code, 0);
  assert.deepEqual(win.grants, {});
});

test('handover: the old admin\'s reads go before the record names the new admin, and nothing is handed over while one stays; a new admin Windows will not give its reads is said (2), and a handover to the admin gives them again', async () => {
  const root = machineFolder(ANA);
  const tokenDir = path.join(root, 'token');
  let win = failing(fakeWindows({ tasks: [machine.controlTask(ANA)] }), (name, args) => name === 'icacls.exe' && args[0] === tokenDir && args[1] === '/remove:g');
  ask(root, ANA, { verb: 'handover', account: 'LAPTOP\\ben', confirm: 'LAPTOP\\ben' });
  let r = await control(root, ANA, win);
  assert.equal(r.code, 2, r.text);
  assert.match(answerOf(root, ANA).words, /^Nothing was handed over: LAPTOP\\ana would keep the read on .*token \(Access is denied\.\), which could not be taken back\.$/);
  assert.deepEqual([win.record.Admin, eventsOf(root)], [ANA, []]);
  assert.ok(win.icacls.includes(path.join(root, 'logs') + ' /grant:r *' + ANA + ':(OI)(CI)R'), 'the read taken from the admin before the refusal given back');
  assert.ok(!win.icacls.some((a) => a.endsWith('*' + BEN + ':(OI)(CI)R')), 'the new admin was given no read');
  assert.ok(!win.tasks.has(machine.controlTask(BEN)) && !fs.existsSync(path.join(root, 'machine', 'inbox', BEN)), 'the means made for an account with no right taken away again');
  // The record will not take the new admin: nothing handed over, the old admin's reads given back.
  win = failing(fakeWindows({ tasks: [machine.controlTask(ANA)] }), (name, args) => name === 'reg.exe' && args[0] === 'add' && args[1] === machine.HKLM && args[3] === 'Admin');
  ask(root, ANA, { verb: 'handover', account: 'LAPTOP\\ben', confirm: 'LAPTOP\\ben' });
  r = await control(root, ANA, win);
  assert.equal(r.code, 2);
  assert.match(answerOf(root, ANA).words, /^Nothing was handed over: the install record's Admin could not be written/);
  assert.equal(win.record.Admin, ANA);
  for (const name of ['token', 'logs']) assert.ok(win.icacls.lastIndexOf(path.join(root, name) + ' /grant:r *' + ANA + ':(OI)(CI)R') > win.icacls.indexOf(path.join(root, name) + ' /remove:g *' + ANA), name + ' given back');
  // The new admin's read refused: the handover stands (its reads are the new admin's to have), said, not done (2).
  win = failing(fakeWindows({ tasks: [machine.controlTask(ANA)] }), (name, args) => name === 'icacls.exe' && args[0] === tokenDir && args[1] === '/grant:r' && args[2] === '*' + BEN + ':(OI)(CI)R');
  ask(root, ANA, { verb: 'handover', account: 'LAPTOP\\ben', confirm: 'LAPTOP\\ben' });
  r = await control(root, ANA, win);
  assert.equal(r.code, 2);
  assert.equal(win.record.Admin, BEN);
  assert.match(answerOf(root, ANA).words, /LAPTOP\\ben could not be given the read on .*token \(Access is denied\.\): hand AGMessage's admin over to LAPTOP\\ben again to give it\./);
  assert.match(eventsOf(root)[0].words, /LAPTOP\\ana keeps no right\. LAPTOP\\ben could not be given the read on/);
  // The record takes the new admin's SID but not its name: the handover stands, and the words say the name may be the old one.
  const named = failing(fakeWindows({ tasks: [machine.controlTask(ANA)] }), (name, args) => name === 'reg.exe' && args[0] === 'add' && args[3] === 'AdminName');
  const root2 = machineFolder(ANA);
  ask(root2, ANA, { verb: 'handover', account: 'LAPTOP\\cal', confirm: 'LAPTOP\\cal' });
  r = await control(root2, ANA, named);
  assert.equal(r.code, 0, r.text);
  assert.deepEqual([named.record.Admin, named.record.AdminName], [CAL, 'LAPTOP\\ana']);
  assert.match(answerOf(root2, ANA).words, /The record's name for the admin could not be written \(the install record's AdminName could not be written \(Access is denied\.\)\), so its words may still name LAPTOP\\ana\.$/);
  // The new admin hands over to itself: its reads given again, nothing else changed.
  const fixed = fakeWindows({ record: { ...win.record }, tasks: [machine.controlTask(BEN)] });
  fs.mkdirSync(path.join(root, 'machine', 'inbox', BEN), { recursive: true });
  ask(root, BEN, { verb: 'handover', account: 'LAPTOP\\ben', confirm: 'LAPTOP\\ben' });
  r = await control(root, BEN, fixed);
  assert.equal(r.code, 0, r.text);
  assert.deepEqual([answerOf(root, BEN).already, answerOf(root, BEN).words], [true, 'LAPTOP\\ben is this PC\'s AGMessage admin already (its reads on the token and the logs given again).']);
  assert.deepEqual(fixed.icacls, ['token', 'logs'].map((name) => path.join(root, name) + ' /grant:r *' + BEN + ':(OI)(CI)R'));
  assert.equal(eventsOf(root).length, 1, 'no event: nothing the log keeps changed');
});

// ---------------------------------------------------------------- an account's own folders

test('an account\'s inbox\\ and outbox\\ are removed entry by entry, never recursively: a link or a junction is taken, never what it names, and a folder holding files is left and said', async () => {
  const outside = tmp('agm-outside-');
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'not AGMessage\'s');
  const root = machineFolder(ANA, BEN);
  const inbox = path.join(root, 'machine', 'inbox', BEN);
  fs.symlinkSync(outside, path.join(inbox, 'away'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.writeFileSync(path.join(inbox, 'request.json'), '{}');
  fs.mkdirSync(path.join(inbox, 'empty'));
  // Revoke all: its folders go, and what the link named stays.
  const win = fakeWindows({ grants: { [BEN]: 'start' }, tasks: [machine.controlTask(BEN)] });
  ask(root, ANA, { verb: 'revoke', account: 'LAPTOP\\ben', rights: 'all' });
  assert.equal((await control(root, ANA, win)).code, 0);
  assert.ok(!fs.existsSync(inbox), 'its inbox\\ gone');
  assert.equal(read(path.join(outside, 'keep.txt')), 'not AGMessage\'s', 'what the link named untouched');
  // A folder holding a file: left, and said.
  const box = path.join(tmp('agm-box-'), 'S-1-5-21-1-2-3-1004');
  fs.mkdirSync(path.join(box, 'full'), { recursive: true });
  fs.writeFileSync(path.join(box, 'full', 'f'), 'x');
  assert.match(machine.clearBox(fs, box), /full \(ENOTEMPTY|full \(EEXIST|full \(EPERM/);
  assert.ok(fs.existsSync(path.join(box, 'full', 'f')));
  assert.equal(machine.clearBox(fs, path.join(box, 'none')), '', 'one not there is gone');
});

test('a request whose file changed between lstat and its open (another file in its place) is refused and never read', () => {
  const root = machineFolder(BEN);
  const file = inboxOf(root, BEN);
  fs.writeFileSync(file, JSON.stringify({ id: 'a'.repeat(24), verb: 'start' }));
  let reads = 0;
  const swapped = { ...fs, fstatSync: (fd) => ({ ...fs.fstatSync(fd), isFile: () => true, ino: -1 }), readSync: (...a) => { reads++; return fs.readSync(...a); } };
  assert.throws(() => machine.takeRequest(swapped, file, path.join(root, 'machine', 'work')), (e) => e.refused && /changed between its look and its read/.test(e.words));
  assert.equal(reads, 0, 'nothing of it read');
  assert.ok(!fs.existsSync(file), 'what was there removed');
  assert.deepEqual(fs.readdirSync(path.join(root, 'machine', 'work')), [], 'no copy made');
});

// ---------------------------------------------------------------- start and stop

test('start: the server task run and its server waited for until it proves the token; one machine.start event and the nudge; already serving is said and changes nothing', async () => {
  const root = machineFolder(BEN);
  fs.writeFileSync(path.join(root, 'token', 'admin-token'), '0123456789abcdef');   // secret-scan: fixture
  let serving = false;
  const win = fakeWindows({ grants: { [BEN]: 'start' }, onRun: (tn) => { if (tn === machine.SERVER_TASK) serving = true; } });
  const nudges = [];
  const net = {
    hello: async () => (serving ? { ok: true, build: '0.6.0+80.abc1234', nonce: 'n' } : { ok: false, why: 'ECONNREFUSED' }),
    proven: async () => (serving ? { ok: true, build: '0.6.0+80.abc1234', answers: [{ status: 200, json: { setup: false } }] } : { ok: false, why: 'ECONNREFUSED' }),
    nudge: async (o) => { nudges.push(o); return { ok: true, status: 200, json: { ok: true, written: 1 } }; },
  };
  ask(root, BEN, { verb: 'start' });
  const r = await control(root, BEN, win, net);
  assert.equal(r.code, 0, r.text);
  assert.deepEqual([answerOf(root, BEN).words, answerOf(root, BEN).started, answerOf(root, BEN).build], ['Started.', true, '0.6.0+80.abc1234']);
  assert.deepEqual(win.runs, [machine.SERVER_TASK]);
  assert.deepEqual(eventsOf(root).map((e) => [e.seq, e.kind, e.by.name, e.for.sid, e.words]), [[1, 'machine.start', 'LAPTOP\\ben', BEN, 'LAPTOP\\ben started AGMessage (build 0.6.0+80.abc1234).']]);
  assert.deepEqual(nudges.map((n) => [n.port, n.token]), [[3023, '0123456789abcdef']]);
  ask(root, BEN, { verb: 'start' });
  assert.equal((await control(root, BEN, win, net)).code, 0);
  assert.deepEqual([answerOf(root, BEN).already, answerOf(root, BEN).words], [true, 'AGMessage is already running (build 0.6.0+80.abc1234).']);
  assert.deepEqual([win.runs.length, eventsOf(root).length], [1, 1], 'nothing run again, no second event');
});

test('start: a server that has not proved itself in time is left as it is, never ended (it may still be starting, or the watchdog retrying a held port): not done (2), the task\'s state and the log\'s last line said, and an event says it was asked', async () => {
  const root = machineFolder(BEN);
  fs.writeFileSync(path.join(root, 'token', 'admin-token'), '0123456789abcdef');   // secret-scan: fixture
  fs.writeFileSync(path.join(root, 'logs', 'server.log'), 'AGMessage starting\n  [watchdog] port 3023 is held: trying again in 5 s\n');
  const win = fakeWindows({ grants: { [BEN]: 'start' } });
  const inner = win.run;
  win.run = (exe, args, opts) => (base(exe) === 'schtasks.exe' && args[0] === '/Query' && args.includes('/FO') ? '"LAPTOP","\\AGMessage\\Server","N/A","Running","Interactive/Background","11/7/2026 8:00:00 PM","267009"\r\n' : inner(exe, args, opts));
  const net = { waitMs: 1000, hello: async () => ({ ok: false, why: 'ECONNREFUSED' }), proven: async () => ({ ok: false, why: 'ECONNREFUSED' }) };
  ask(root, BEN, { verb: 'start' });
  const r = await control(root, BEN, win, net);
  assert.equal(r.code, 2, r.text);
  assert.deepEqual(win.runs, [machine.SERVER_TASK]);
  assert.ok(!win.calls.some((c) => c.name === 'schtasks.exe' && c.args[0] === '/End'), 'Task Scheduler\'s End is never a stop: nothing was ended');
  assert.equal(answerOf(root, BEN).code, 2);
  assert.equal(answerOf(root, BEN).words, 'AGMessage is not answering yet: nothing answered on port 3023 within 1 s. It was left as it is, since it may still be starting: the server task is Running, last result 267009. The log\'s last line: "[watchdog] port 3023 is held: trying again in 5 s". Try Start AGMessage again in a minute; AGMessage status says more.');
  assert.deepEqual(eventsOf(root).map((e) => [e.kind, e.by.sid, e.words]), [['machine.start', BEN, 'LAPTOP\\ben ran AGMessage\'s server task; it was not answering within 1 s (the task: Running, last result 267009).']]);
  // The installer's verify still ends one that never proved itself: it never served, so it has nothing to save.
  const verify = fakeWindows();
  const v = await machine.run(['start', '--machine', root, '--sys', SYS, '--port', '3023'], { run: verify.run, net: { ...net, portAnswers: async () => false } });
  assert.equal(v.code, 2);
  assert.ok(verify.calls.some((c) => c.name === 'schtasks.exe' && c.args[0] === '/End'));
});

test('an act done whose event cannot be appended is answered as done (0), its words saying the audit log will not show it', async () => {
  const root = machineFolder(ANA);
  const win = fakeWindows();
  const noLock = { ...fs, openSync: (p, ...a) => { if (String(p).endsWith('events.lock')) throw Object.assign(new Error('denied'), { code: 'EACCES' }); return fs.openSync(p, ...a); } };
  ask(root, ANA, { verb: 'grant', account: 'LAPTOP\\ben', rights: ['start'] });
  const r = await machine.run(['control', '--for', ANA, '--machine', root, '--sys', SYS], { run: win.run, fsImpl: noLock });
  assert.equal(r.code, 0, r.text);
  assert.deepEqual(win.grants, { [BEN]: 'start' });
  assert.deepEqual([answerOf(root, ANA).code, answerOf(root, ANA).event], [0, 0]);
  assert.equal(answerOf(root, ANA).words, 'Given: LAPTOP\\ben may now start AGMessage on this PC. No machine event says so, so the audit log will not show it: machine\\events.lock could not be made (EACCES).');
  assert.deepEqual(eventsOf(root), []);
});

test('stop: the busy line, then the stop at loopback with the proof; busy is refused until a reason is typed, and the stop that saves is one machine.stop event', async () => {
  const root = machineFolder(BEN);
  fs.writeFileSync(path.join(root, 'token', 'admin-token'), '0123456789abcdef');   // secret-scan: fixture
  const win = fakeWindows({ grants: { [BEN]: 'stop' } });
  const asked = [];
  let at = 0;
  const net = {
    stop: async (o) => {
      asked.push(o);
      if (!o.force) return { ok: true, status: 409, json: { ok: false, busy: true, error: 'Not stopped: AGMessage is busy (3 pages active, a countdown running). Type a reason to stop it anyway.' } };
      at = Date.now();
      fs.writeFileSync(path.join(root, 'data', 'last-stop.json'), JSON.stringify({ at: at + 5, saved: true }));
      return { ok: true, status: 200, json: { ok: true, stopping: true, forced: true } };
    },
    portAnswers: async () => false,
  };
  ask(root, BEN, { verb: 'stop' });
  assert.equal((await control(root, BEN, win, net)).code, 3);
  const busyAnswer = answerOf(root, BEN);
  assert.deepEqual([busyAnswer.busy, busyAnswer.forceable, busyAnswer.words], [true, true, 'Not stopped: AGMessage is busy (3 pages active, a countdown running). Type a reason to stop it anyway.']);
  assert.deepEqual(eventsOf(root), [], 'not stopped: no event');
  ask(root, BEN, { verb: 'stop', force: 'the venue closes' });
  const r = await control(root, BEN, win, net);
  assert.equal(r.code, 0, r.text);
  const pad = (n) => String(n).padStart(2, '0');
  const d = new Date(at + 5);
  assert.equal(answerOf(root, BEN).words, 'Stopped, saved at ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + '.');
  assert.deepEqual(asked.map((a) => [a.reason, a.by, a.force]), [['stop', 'LAPTOP\\ben', ''], ['stop', 'LAPTOP\\ben', 'the venue closes']], 'who asked and the reason typed, at loopback');
  const [ev] = eventsOf(root);
  assert.deepEqual([ev.kind, ev.by.sid], ['machine.stop', BEN]);
  assert.match(ev.words, /^LAPTOP\\ben stopped AGMessage while it was busy, with the reason "the venue closes": Stopped, saved at \d\d:\d\d\.$/);
});

// ---------------------------------------------------------------- the events

test('machine events: each one above the file\'s highest seq, under a lock only one append holds; a lock a crash left is taken once it is old', () => {
  const dir = tmp('agm-ev-');
  const ana = { sid: ANA, name: 'LAPTOP\\ana' };
  assert.equal(machine.appendEvent(dir, { kind: 'machine.start', by: ana, forAccount: ana, words: 'one' }), 1);
  fs.appendFileSync(path.join(dir, 'events.jsonl'), '{"seq":7,"torn');
  assert.equal(machine.appendEvent(dir, { kind: 'machine.stop', by: ana, forAccount: ana, words: 'two' }), 2, 'a torn line is passed over, and the next event starts a line of its own');
  const lines = read(path.join(dir, 'events.jsonl')).split('\n');
  assert.equal(JSON.parse(lines[2]).seq, 2);
  // Another append holds the lock: this one waits its turn (10 s at most; here 0.3 s), and gives up with words.
  const lock = path.join(dir, 'events.lock');
  fs.writeFileSync(lock, '');
  const t0 = Date.now();
  assert.throws(() => machine.appendEvent(dir, { kind: 'machine.start', by: ana, forAccount: ana }, fs, { waitMs: 300 }), (e) => e.words === 'machine\\events.jsonl stayed locked for 0.3 s');
  assert.ok(Date.now() - t0 >= 290);
  assert.deepEqual(read(path.join(dir, 'events.jsonl')).split('\n').filter(Boolean).length, 3, 'nothing appended while another holds the lock');
  // One a crash left, older than the stale age (5 s, below the 10 s wait, so it never outlasts an append's wait), is taken.
  const old = (Date.now() - 6000) / 1000;
  fs.utimesSync(lock, old, old);
  assert.equal(machine.appendEvent(dir, { kind: 'machine.start', by: ana, forAccount: ana, rights: ['start', 'admin'] }), 3);
  assert.ok(!fs.existsSync(lock), 'the lock goes with the append');
  assert.deepEqual(JSON.parse(read(path.join(dir, 'events.jsonl')).trim().split('\n').pop()).rights, ['start'], 'only rights AGMessage gives');
  assert.equal(machine.lastSeqOf('{"seq":4}\n{"seq":"9"}\nnot json\n{"seq":2}'), 4);
});

test('the server\'s reader of the machine\'s events (pure): an event is read by type, each seq once and in order, a torn last line waits, and a row names the accounts, the rights and its seq', () => {
  const ev = { seq: 3, at: 1, kind: 'machine.grant', by: { sid: ANA, name: 'LAPTOP\\ana' }, for: { sid: BEN, name: 'LAPTOP\\ben' }, rights: ['start', 'stop'], words: 'LAPTOP\\ana gave LAPTOP\\ben start, stop.' };
  const line = (e) => JSON.stringify(e);
  assert.deepEqual(events.eventOf(line(ev)), ev);
  for (const bad of [{ ...ev, kind: 'machine.reboot' }, { ...ev, seq: 0 }, { ...ev, seq: '3' }, { ...ev, rights: ['admin'] }, { ...ev, rights: ['start', 'start'] }, { ...ev, by: 'LAPTOP\\ana' }, { ...ev, for: { sid: 'not a sid', name: '' } }, { ...ev, extra: 1 }]) assert.equal(events.eventOf(line(bad)), null, JSON.stringify(bad).slice(0, 60));
  const { seq: _seq, ...noSeq } = ev;
  assert.equal(events.eventOf(line(noSeq)), null);
  const text = [line({ ...ev, seq: 2 }), 'not an event', line({ ...ev, seq: 1 }), line({ ...ev, seq: 2, words: 'a second line for seq 2' }), line({ ...ev, seq: 4 }), ''].join('\n') + line({ ...ev, seq: 5 });
  const p = events.planOf(text, 1);
  assert.deepEqual([p.events.map((e) => e.seq), p.events[0].words, p.skipped], [[2, 4], ev.words, 1], 'above the last, each seq once (its first line), in order; the torn 5 waits');
  const at = Date.UTC(2026, 10, 7, 20, 31, 5);
  const row = events.rowOf({ ...ev, at });
  assert.deepEqual(row, { actor: { t: 'windows', id: ANA, name: 'LAPTOP\\ana' }, action: 'machine.grant', target: BEN, words: 'LAPTOP\\ana gave LAPTOP\\ben start, stop. [start, stop] · done 20:31 UTC on 7 Nov 2026 · machine event 3' }, 'both accounts by SID, the time it was done, its seq');
  assert.equal(events.seqOfRow({ action: 'machine.grant', words: row.words }), 3);
  assert.equal(events.seqOfRow({ action: 'login.ok', words: '· machine event 9' }), 0, 'only a machine row names a seq');
  // Words as long as an event's may be: they give way, with an ellipsis, and the rights, the time and the seq stay whole.
  const long = events.rowOf({ ...ev, at, seq: 123456789, rights: ['token', 'start', 'stop', 'upgrade'], words: 'w'.repeat(300) });
  assert.equal(long.words.length, audit.WORDS_MAX);
  assert.match(long.words, /^w+… \[token, start, stop, upgrade\] · done 20:31 UTC on 7 Nov 2026 · machine event 123456789$/);
  assert.equal(events.seqOfRow({ action: 'machine.grant', words: long.words }), 123456789);
  assert.equal(events.WORDS_MAX, audit.WORDS_MAX, 'the reader bounds its words by the audit log\'s own bound');
  // A secret is taken out before the words are bounded: what it stands for never pushes the seq past the cut.
  const scrubbed = events.rowOf({ ...ev, at, words: 'k'.repeat(16) + ' ' + 'w'.repeat(280) }, (t) => t.split('k'.repeat(16)).join('[the admin token]'));
  assert.match(scrubbed.words, /^\[the admin token\] w+… \[start, stop\] · done .* · machine event 3$/);
  assert.equal(scrubbed.words.length, audit.WORDS_MAX);
  // An event that names no SID for its account is the row's target by name (an install that recorded none).
  assert.equal(events.rowOf({ ...ev, for: { sid: '', name: 'LAPTOP\\ben' } }).target, 'LAPTOP\\ben');
});

test('the server\'s reader: a file over 4 MB is read from its newest 4 MB, from a line\'s start; one that cannot be read is said and read again later; none is written while the settings that keep the seq cannot be read', async () => {
  const dir = tmp('agm-mev-tail-');
  const file = path.join(dir, 'events.jsonl');
  const ev = (seq) => JSON.stringify({ seq, at: 1, kind: 'machine.start', by: { sid: ANA, name: 'LAPTOP\\ana' }, for: { sid: ANA, name: 'LAPTOP\\ana' }, rights: [], words: 'started' });
  fs.writeFileSync(file, '{"pad":"' + 'x'.repeat(events.FILE_MAX) + '"}\n' + ev(1) + '\n' + ev(2) + '\n');
  assert.ok((await events.readTail(file)).startsWith(ev(1) + '\n'), 'the line cut by the 4 MB is dropped whole');
  assert.equal(await events.readTail(path.join(dir, 'none.jsonl')), '', 'no file yet: nothing to read');
  const written = [];
  const said = [];
  let last = 0;
  let blocked = 'settings.json could not be read (EBUSY)';
  let failing = true;
  const reader = new events.MachineEvents({
    file, write: (row) => written.push(row), lastSeq: () => last, saveSeq: (seq) => { last = seq; }, blocked: () => blocked, log: (l) => said.push(l),
    read: (f) => (failing ? Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' })) : events.readTail(f)),
  });
  assert.deepEqual(await reader.read(), { read: 0, written: 0, skipped: 0, words: 'Not read: settings.json could not be read (EBUSY)' });
  blocked = '';
  const r = await reader.read();
  assert.deepEqual([r.written, reader.lastError], [0, 'EACCES']);
  assert.match(said.pop(), /could not be read \(EACCES\); they are read again at the next nudge or start/);
  failing = false;
  const [a, b] = await Promise.all([reader.read(), reader.read()]);
  assert.deepEqual([a.written, b.written, written.map((w) => w.words), last], [2, 0, ['started · done 00:00 UTC on 1 Jan 1970 · machine event 1', 'started · done 00:00 UTC on 1 Jan 1970 · machine event 2'], 2], 'one read at a time: the second finds nothing new');
});

test('the installed server writes each machine event as its audit row exactly once, in seq order, across a nudge and restarts (one before the settings were saved too, and one whose words were long), each row naming both accounts by their whole SIDs and when it was done, and no row holds the token', async (t) => {
  const dir = tmp('agm-mev-');
  const dataDir = path.join(dir, 'data');
  const file = path.join(dir, 'machine', 'events.jsonl');
  fs.mkdirSync(path.dirname(file));
  // SIDs as Windows writes them: a local account's three 10-digit sub-authorities and its RID, and an Entra ID account's.
  const ana = { sid: 'S-1-5-21-1004336348-1177238915-682003330-1001', name: 'LAPTOP\\ana' };
  const ben = { sid: 'S-1-5-21-1004336348-1177238915-682003330-1002', name: 'LAPTOP\\ben' };
  const eve = { sid: 'S-1-12-1-3633483151-1268201488-3436402591-2581470472', name: 'AzureAD\\EveStage' };
  const M = path.dirname(file);
  machine.appendEvent(M, { kind: 'machine.admin', by: ana, forAccount: ana, rights: machine.RIGHTS, words: 'AGMessage was installed on this PC; its admin here is LAPTOP\\ana.' });
  fs.appendFileSync(file, '{"kind":"machine.reboot","by":"nobody"}\n');
  machine.appendEvent(M, { kind: 'machine.grant', by: ana, forAccount: ben, rights: ['start', 'stop'], words: 'LAPTOP\\ana gave LAPTOP\\ben start, stop.' });
  machine.appendEvent(M, { kind: 'machine.start', by: ben, forAccount: ben, words: 'LAPTOP\\ben started AGMessage with ' + h.TOKEN.toUpperCase() + ' typed in its words.' });
  machine.appendEvent(M, { kind: 'machine.grant', by: ana, forAccount: eve, rights: ['stop'], words: 'LAPTOP\\ana gave AzureAD\\EveStage stop.' });
  const env = { AGM_RUNS: 'task', AGM_DATA_DIR: dataDir, AGM_UPLOAD_DIR: path.join(dir, 'uploads'), AGM_KEY_DIR: path.join(dir, 'keys'), AGM_MACHINE_EVENTS: file };
  let srv = await h.startServer(env);
  t.after(() => h.stopServer(srv.child));
  const log = () => { try { return read(path.join(dataDir, 'audit.jsonl')); } catch { return ''; } };
  // The log's whole lines alone: a row the server is appending is read at the next poll, never parsed cut short.
  const rows = () => { try { return h.wholeLines(path.join(dataDir, 'audit.jsonl')).filter((e) => e.action.startsWith('machine.')); } catch (e) { if (e.code === 'ENOENT') return []; throw e; } };
  await h.until(() => rows().length === 4, 15000, 'the four events written after the hold');
  assert.deepEqual(rows().map((e) => [e.action, e.actor.t, e.actor.id, e.target]), [
    ['machine.admin', 'windows', ana.sid, ana.sid], ['machine.grant', 'windows', ana.sid, ben.sid], ['machine.start', 'windows', ben.sid, ben.sid], ['machine.grant', 'windows', ana.sid, eve.sid],
  ], 'every SID whole: no two accounts of one PC read as one');
  assert.match(rows()[1].words, /^LAPTOP\\ana gave LAPTOP\\ben start, stop\. \[start, stop\] · done \d\d:\d\d UTC on \d{1,2} [A-Z][a-z]{2} \d{4} · machine event 2$/);
  assert.ok(!log().toLowerCase().includes(h.TOKEN.toLowerCase()), 'no row holds the token, in any case');
  assert.match(rows()[2].words, /\[the admin token\]/);
  await h.until(() => { try { return JSON.parse(read(path.join(dataDir, 'settings.json'))).machineSeq === 4; } catch { return false; } }, 5000, 'the last seq kept in settings');
  // A nudge after an event: that one row, and its answer says so; a nudge with nothing new writes nothing.
  machine.appendEvent(M, { kind: 'machine.revoke', by: ana, forAccount: ben, rights: ['stop'], words: 'LAPTOP\\ana took back stop from LAPTOP\\ben.' });
  let n = await wire.nudge({ port: srv.port, token: h.TOKEN });
  assert.deepEqual([n.status, n.json.written], [200, 1]);
  n = await wire.nudge({ port: srv.port, token: h.TOKEN });
  assert.deepEqual([n.status, n.json.written, n.json.words], [200, 0, 'Read: nothing new.']);
  assert.deepEqual(rows().map((e) => e.action), ['machine.admin', 'machine.grant', 'machine.start', 'machine.grant', 'machine.revoke']);
  // A restart writes none again: its read at start comes before the nudge's (one read at a time, in order).
  srv = await h.restartServer(srv, env);
  n = await wire.nudge({ port: srv.port, token: h.TOKEN });
  assert.deepEqual([n.json.written, rows().length], [0, 5]);
  // A stop the server could not see (it was the one stopped): its row is written at the next start, with the stop's own
  // time; its reason as long as a person may type, so the words are bounded and the seq still read back.
  await h.stopServer(srv.child);
  const reason = 'r'.repeat(200);
  const stoppedAt = Date.now() - 3 * 24 * 3600 * 1000;
  machine.appendEvent(M, { kind: 'machine.stop', by: ben, forAccount: ben, words: 'LAPTOP\\ben stopped AGMessage while it was busy, with the reason "' + reason + '": Stopped, saved at 20:31.' });
  const lines = read(file).trimEnd().split('\n');
  const last = JSON.parse(lines.pop());
  fs.writeFileSync(file, [...lines, JSON.stringify({ ...last, at: stoppedAt })].join('\n') + '\n');
  // And the settings lost the last seq (a kill between the row and the save): the log's newest rows name it.
  const settings = JSON.parse(read(path.join(dataDir, 'settings.json')));
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ ...settings, machineSeq: 1 }));
  srv = await h.startServer({ ...env, PORT: String(srv.port) });
  await h.until(() => rows().length === 6, 15000, 'the stop written at the next start');
  const stop = rows()[5];
  assert.equal(stop.words.length, audit.WORDS_MAX);
  const d = new Date(stoppedAt);
  assert.ok(stop.words.endsWith(' · done ' + String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0') + ' UTC on ' + d.getUTCDate() + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()] + ' ' + d.getUTCFullYear() + ' · machine event 6'), 'when it was done, three days before its row');
  // Another restart that lost the seq again: the long row still names it, so none is written twice.
  await h.stopServer(srv.child);
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ ...JSON.parse(read(path.join(dataDir, 'settings.json'))), machineSeq: 2 }));
  srv = await h.startServer({ ...env, PORT: String(srv.port) });
  n = await wire.nudge({ port: srv.port, token: h.TOKEN });
  assert.deepEqual([n.json.written, rows().length], [0, 6], 'exactly once');
  machine.appendEvent(M, { kind: 'machine.start', by: ben, forAccount: ben, words: 'LAPTOP\\ben started AGMessage (build b).' });
  n = await wire.nudge({ port: srv.port, token: h.TOKEN });
  assert.deepEqual([n.json.written, rows().map((e) => Number(/machine event (\d+)$/.exec(e.words)[1]))], [1, [1, 2, 3, 4, 5, 6, 7]], 'in seq order, none skipped');
});

// ---------------------------------------------------------------- the person's side: launch.js start, stop and rights

/**
 * Windows' hands as the person's console meets them, wired to machine.js control: whoami names the person (`me`), and a
 * schtasks /Run of their control task runs machine.js control --for their SID in this process, as SYSTEM would, through
 * `win` (the machine's hands). `task` is the one control task this account may run (none: refused, as Windows would).
 */
function personsHands({ me = BEN, root, win, net = {}, groups = STANDARD, runnable = [me] } = {}) {
  const pending = [];
  const run = (exe, args, opts) => {
    const name = base(exe);
    if (name === 'whoami.exe') return args[0] === '/user' ? '"' + NAMES[me] + '","' + me + '"' : groups;
    if (name === 'schtasks.exe' && args[0] === '/Run') {
      const tn = args[args.indexOf('/TN') + 1];
      const sid = tn.replace(/^\\AGMessage\\Control-/, '');
      if (!runnable.includes(sid) || !win.tasks.has(tn)) throw fail(1, 'ERROR: Access is denied.');
      pending.push(machine.run(['control', '--for', sid, '--machine', root, '--sys', SYS], { run: win.run, net }));
      return 'SUCCESS';
    }
    if (name === 'reg.exe') return win.run(exe, args, opts);
    throw new Error('the person\'s console ran what it does not: ' + name);
  };
  return { run, pending };
}

test('launch.js start: the request left in the person\'s own inbox, their own control task run, and its answer (by the request\'s id) said; an account with no control task is told whom to ask', async () => {
  const root = machineFolder(BEN);
  fs.writeFileSync(path.join(root, 'token', 'admin-token'), '0123456789abcdef');   // secret-scan: fixture
  let serving = false;
  const win = fakeWindows({ grants: { [BEN]: 'start' }, tasks: [machine.controlTask(BEN)], onRun: (tn) => { if (tn === machine.SERVER_TASK) serving = true; } });
  const net = {
    hello: async () => ({ ok: serving, why: 'ECONNREFUSED', build: 'b' }),
    proven: async () => ({ ok: true, build: '0.6.0+80.abc1234', answers: [{ status: 200, json: {} }] }),
    nudge: async () => ({ ok: true, status: 200, json: { written: 1 } }),
  };
  fs.writeFileSync(path.join(root, 'machine', 'outbox', BEN, 'answer.json'), JSON.stringify({ id: 'f'.repeat(24), code: 0, words: 'an earlier answer' }));
  const hands = personsHands({ root, win, net });
  const said = [];
  const r = await launch.main(['start', '--machine', root, '--sys', SYS], { out: (t) => said.push(t), run: hands.run, pollMs: 10 });
  assert.equal(r, 0);
  assert.deepEqual(said, ['Asking AGMessage\'s control task to start AGMessage…', 'Started.'], 'the earlier answer is not this request\'s');
  assert.deepEqual(win.runs, [machine.SERVER_TASK]);
  assert.equal(eventsOf(root)[0].kind, 'machine.start');
  // LAPTOP\cal has no control task: told whom to ask, by the record's AdminName; nothing was run.
  const cal = personsHands({ me: CAL, root, win, runnable: [] });
  said.length = 0;
  assert.equal(await launch.main(['start', '--machine', root, '--sys', SYS], { out: (t) => said.push(t), run: cal.run, write: (f) => { throw Object.assign(new Error('no'), { code: 'ENOENT', f }); } }), 2);
  assert.equal(said.pop(), 'You have no AGMessage rights on this PC. Ask LAPTOP\\ana, or an administrator.');
  // An inbox it may write but a control task it may not run: the same words.
  fs.mkdirSync(path.join(root, 'machine', 'inbox', CAL));
  said.length = 0;
  assert.equal(await launch.main(['start', '--machine', root, '--sys', SYS], { out: (t) => said.push(t), run: cal.run }), 2);
  assert.match(said.pop(), /^You have no AGMessage rights on this PC\. Ask LAPTOP\\ana, or an administrator\. \(Windows: ERROR: Access is denied\.\)$/);
});

test('launch.js stop: busy is said, a reason asked for and the stop asked again with it; Enter alone leaves it running', async () => {
  const root = machineFolder(BEN);
  fs.writeFileSync(path.join(root, 'token', 'admin-token'), '0123456789abcdef');   // secret-scan: fixture
  const win = fakeWindows({ grants: { [BEN]: 'stop' }, tasks: [machine.controlTask(BEN)] });
  const forces = [];
  const net = {
    stop: async (o) => { forces.push(o.force); if (!o.force) return { ok: true, status: 409, json: { error: 'Not stopped: AGMessage is busy (1 page active). Type a reason to stop it anyway.' } }; fs.writeFileSync(path.join(root, 'data', 'last-stop.json'), JSON.stringify({ at: Date.now() + 5, saved: true })); return { ok: true, status: 200, json: { stopping: true } }; },
    portAnswers: async () => false,
  };
  const hands = personsHands({ root, win, net });
  const said = [];
  const asked = [];
  let typed = '';
  const prompt = async (q) => { asked.push(q); return typed; };
  assert.equal(await launch.main(['stop', '--machine', root, '--sys', SYS], { out: (t) => said.push(t), run: hands.run, prompt, pollMs: 10 }), 2);
  assert.deepEqual(said.slice(1), ['Not stopped: AGMessage is busy (1 page active). Type a reason to stop it anyway.', 'Left running: no reason was typed.']);
  assert.deepEqual([asked, forces], [['Reason (Enter leaves it running): '], ['']]);
  typed = 'doors close at 23:00';
  said.length = 0;
  assert.equal(await launch.main(['stop', '--machine', root, '--sys', SYS], { out: (t) => said.push(t), run: hands.run, prompt, pollMs: 10 }), 0);
  assert.match(said.pop(), /^Stopped, saved at \d\d:\d\d\.$/);
  assert.deepEqual(forces, ['', '', 'doors close at 23:00']);
  assert.equal(eventsOf(root).length, 1);
});

test('launch.js rights: Who may run AGMessage… lists the admin and the rights given, takes one typed line (a handover confirmed by the name again), and says the control task\'s answer', async () => {
  const lines = [['Give LAPTOP\\ben: start, stop', { verb: 'grant', account: 'LAPTOP\\ben', rights: ['start', 'stop'] }], ['give laptop\\ben: stop and token', { verb: 'grant', account: 'laptop\\ben', rights: ['token', 'stop'] }], ['Take back from LAPTOP\\ben: all', { verb: 'revoke', account: 'LAPTOP\\ben', rights: 'all' }], ['take back from S-1-5-21-1-2-3-1002: upgrade', { verb: 'revoke', account: 'S-1-5-21-1-2-3-1002', rights: ['upgrade'] }], ['Hand over to LAPTOP\\ben', { verb: 'handover', account: 'LAPTOP\\ben' }]];
  for (const [l, request] of lines) assert.deepEqual(launch.rightsLineOf(l), { request }, l);
  for (const [l, re] of [['Give LAPTOP\\ben: fly', /"fly" is not a right AGMessage gives/], ['Give LAPTOP\\ben:', /Name the rights after the colon/], ['make ben admin', /is not one of the three/]]) assert.match(launch.rightsLineOf(l).problem, re, l);
  const w = { admin: ANA, adminName: 'LAPTOP\\ana', grants: [{ sid: BEN, name: 'LAPTOP\\ben', rights: ['start', 'stop'] }, { sid: CAL, name: '', rights: ['token'] }] };
  const words = launch.whoMayRunWords(w);
  assert.match(words, /^Who may run AGMessage on this PC:\n {2}LAPTOP\\ana: this PC's AGMessage admin, with every right \(token, start, stop, upgrade\) and the giving of them\n {2}LAPTOP\\ben: start, stop\n {2}S-1-5-21-1-2-3-1003 \(an account Windows does not name now\): token\n/);
  // The record read by reg.exe and the names by powershell.exe, each by its absolute path from --sys.
  const win = fakeWindows({ grants: { [BEN]: 'start,stop', [CAL]: 'token' } });
  const seen = [];
  const read = launch.whoMayRun({ sys: SYS, run: (exe, args, opts) => { seen.push(exe); if (base(exe) === 'powershell.exe') { assert.equal(args.at(-1), launch.PS_NAMES); assert.deepEqual([opts.env.AGM_SIDS, opts.env.SystemRoot, opts.env.PATH], [BEN + ',' + CAL, 'C:\\Windows', undefined]); return '{"' + BEN + '":"LAPTOP\\\\ben","' + CAL + '":""}\r\n'; } return win.run(exe, args, opts); } });
  assert.deepEqual(read, { admin: ANA, adminName: 'LAPTOP\\ana', grants: [{ sid: BEN, name: 'LAPTOP\\ben', rights: ['start', 'stop'] }, { sid: CAL, name: '', rights: ['token'] }] });
  assert.ok(seen.every((exe) => exe.startsWith(SYS + '\\')), 'every program from the System32 folder --sys names');
  // The laptop's admin hands over, typing the name again; the control task does it.
  const root = machineFolder(ANA);
  const machineWin = fakeWindows({ tasks: [machine.controlTask(ANA)] });
  const hands = personsHands({ me: ANA, root, win: machineWin });
  const answers = ['Hand over to LAPTOP\\ben', 'LAPTOP\\ben'];
  const asked = [];
  const said = [];
  const code = await launch.main(['rights', '--machine', root, '--sys', SYS], { out: (t) => said.push(t), run: hands.run, prompt: async (q) => { asked.push(q); return answers.shift(); }, who: () => w, pollMs: 10 });
  assert.equal(code, 0, said.join('\n'));
  assert.equal(said[0], words);
  assert.equal(asked[1], 'Type LAPTOP\\ben again to hand AGMessage\'s admin on this PC over to it (you keep no right unless it gives one back): ');
  assert.match(said.pop(), /^LAPTOP\\ben is now this PC's AGMessage admin/);
  assert.equal(machineWin.record.Admin, BEN);
  // Enter alone changes nothing, and a line that is not one of the three is said and asks nothing.
  said.length = 0;
  assert.equal(await launch.main(['rights', '--machine', root, '--sys', SYS], { out: (t) => said.push(t), run: hands.run, prompt: async () => '', who: () => w }), 0);
  assert.equal(said.pop(), 'Nothing was changed.');
  assert.equal(await launch.main(['rights', '--machine', root, '--sys', SYS], { out: (t) => said.push(t), run: hands.run, prompt: async () => 'Give LAPTOP\\ben: everything', who: () => w }), 2);
  assert.match(said.pop(), /"everything" is not a right AGMessage gives.*Nothing was changed\.$/);
});

test('launch.js in an administrator\'s elevated console runs machine.js control --elevated by its absolute path beside it, the request a file of machine\\work\\, and says its answer', async () => {
  const root = machineFolder();
  const calls = [];
  const run = (exe, args) => {
    calls.push([exe, args]);
    if (base(exe) === 'whoami.exe') return args[0] === '/user' ? '"LAPTOP\\it","' + IT + '"' : ELEVATED;
    if (exe === process.execPath) {
      const req = JSON.parse(read(args[args.indexOf('--request') + 1]));
      fs.writeFileSync(args[args.indexOf('--out') + 1], JSON.stringify({ v: 1, verb: 'control', code: 0, words: 'Started.', id: req.id }));
      return '';
    }
    throw new Error('not expected: ' + exe);
  };
  const r = await launch.sendRequest({ machine: root, sys: SYS, request: { verb: 'start' }, run });
  assert.deepEqual([r.code, r.text], [0, 'As an administrator: Started.']);
  const [, args] = calls.find(([exe]) => exe === process.execPath);
  assert.deepEqual(args.slice(0, 3), [path.join(h.ROOT, 'machine.js'), 'control', '--elevated']);
  assert.equal(path.dirname(args[args.indexOf('--request') + 1]), path.join(root, 'machine', 'work'));
  assert.deepEqual(fs.readdirSync(path.join(root, 'machine', 'work')).filter((f) => f.startsWith('answer-')), [], 'its answer file removed once read');
  assert.equal(launch.elevatedOf(STANDARD), false);
  assert.equal(launch.elevatedOf(ELEVATED), true);
  assert.equal(machine.elevatedOf(ELEVATED), true);
  assert.equal(launch.elevatedOf('"Mandatory Label\\High Mandatory Level","Label","S-1-16-12288",""'), false, 'High without Administrators is not an administrator');
});

test('a control task\'s definition: SYSTEM, run on demand only, requests queued, 10 minutes at most, its action fixed with the account\'s SID, read and run by that account alone; no secret in it', () => {
  const xml = machine.controlTaskXml({ sid: BEN, node: 'C:\\Program Files\\AGMessage\\node\\node.exe', script: 'C:\\Program Files\\AGMessage\\app\\machine.js', machine: 'C:\\ProgramData\\AGMessage', sys: SYS });
  const el = (name) => [...xml.matchAll(new RegExp('<' + name + '>([^<]*)</' + name + '>', 'g'))].map((m) => m[1]);   // eslint-disable-line security/detect-non-literal-regexp -- the test's own element names
  assert.deepEqual(el('URI'), ['\\AGMessage\\Control-' + BEN]);
  assert.deepEqual(el('SecurityDescriptor'), ['D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FRFX;;;' + BEN + ')']);
  assert.deepEqual([el('UserId'), el('RunLevel')], [['S-1-5-18'], ['HighestAvailable']]);
  assert.match(xml, /<Triggers \/>/, 'on demand only');
  assert.deepEqual([el('MultipleInstancesPolicy'), el('ExecutionTimeLimit'), el('DisallowStartIfOnBatteries'), el('StopIfGoingOnBatteries'), el('AllowStartOnDemand')], [['Queue'], ['PT10M'], ['false'], ['false'], ['true']]);
  assert.deepEqual(el('Arguments'), ['&quot;C:\\Program Files\\AGMessage\\app\\machine.js&quot; control --for ' + BEN + ' --machine C:\\ProgramData\\AGMessage --sys C:\\Windows\\System32']);
  assert.deepEqual(el('Command'), ['C:\\Program Files\\AGMessage\\node\\node.exe']);
  assert.ok(!/password|ADMIN_TOKEN|ANTHROPIC|[0-9a-f]{16}/i.test(xml), 'no secret in the definition');
  assert.equal(machine.controlSddl(BEN), 'D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FRFX;;;' + BEN + ')');
  assert.deepEqual(machine.grantRightsOf('Start, stop,admin,TOKEN'), ['token', 'start', 'stop'], 'a Grants value\'s known words, in their order');
});
