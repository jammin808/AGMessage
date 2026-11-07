'use strict';
// Preloaded into a server under test (NODE_OPTIONS=--require): an event's archive that a stop or another program cuts
// short, as a backup tool or an antivirus holding a file refuses it on Windows (EBUSY). Each switch is read from the
// environment; nothing else of the server is changed.
//   AGM_TEST_MOVE_FAIL=<name>      a move into an archive being made (a rename whose target lies in a `.partial` folder) of
//                                  a file of that name is refused: the first such move only, or every one with
//                                  AGM_TEST_MOVE_FAIL_ALL=1
//   AGM_TEST_MOVE_FAIL_ROOM=<ext>  the same for every file of a room whose name ends in <ext> (`.json.bak`, `.json`)
//   AGM_TEST_BACK_FAIL=<name>      a continue's first move of a file of that name out of an archive made is refused, once
//   AGM_TEST_LIVE_FAIL=1           the rename that puts the next event's record in place (data/event.json) is refused, once
//   AGM_TEST_BEGAN_FAIL=1          the write that says in an archive's record that its next event began is refused, once
//   AGM_TEST_POINT_FAIL=1          the write that notes the archive point's entry in an archive's record is refused, once
//   AGM_TEST_LIVE_UNREAD=1         every read of the current event's record (data/event.json and its .bak) is refused
//   AGM_TEST_PURGE_LEFT=<name>     the first removal of a part of that name from an archive's contents is refused
//   AGM_TEST_UPLOADS_APART=<bytes> the uploads folder (AGM_UPLOAD_DIR) is on a volume of its own with that many bytes free
const fs = require('fs');
const path = require('path');

const env = process.env;
const name = env.AGM_TEST_MOVE_FAIL || '';
const roomExt = env.AGM_TEST_MOVE_FAIL_ROOM || '';
const all = env.AGM_TEST_MOVE_FAIL_ALL === '1';
let moveRefused = false;
let backRefused = !env.AGM_TEST_BACK_FAIL;
let liveRefused = env.AGM_TEST_LIVE_FAIL !== '1';
let beganRefused = env.AGM_TEST_BEGAN_FAIL !== '1';
let pointRefused = env.AGM_TEST_POINT_FAIL !== '1';
let purgeRefused = !env.AGM_TEST_PURGE_LEFT;
const busy = (what, p) => Object.assign(new Error('EBUSY: resource busy or locked, ' + what + ' \'' + p + '\''), { code: 'EBUSY' });
const parts = (p) => String(p).split(path.sep);
const inPartial = (p) => parts(p).some((x) => /^\..+\.partial$/.test(x));
/** Whether a path lies in an archive made (data/archive/<time>/), not one being made. */
const inArchive = (p) => { const a = parts(p); const i = a.lastIndexOf('archive'); return i >= 0 && /^\d{4}-\d{2}-\d{2}T[\d-]+Z$/.test(a[i + 1] || ''); };

const renameSync = fs.renameSync;
fs.renameSync = function refusedSometimes(from, to) {
  const base = path.basename(String(from));
  const target = String(to);
  if (inPartial(target) && !inPartial(from)) {
    if (name && (all || !moveRefused) && base === name) { moveRefused = true; throw busy('rename', from); }
    if (roomExt && parts(from).includes('rooms') && base.endsWith(roomExt)) throw busy('rename', from);
  }
  if (!backRefused && base === env.AGM_TEST_BACK_FAIL && inArchive(from) && !inArchive(target)) { backRefused = true; throw busy('rename', from); }
  if (!liveRefused && path.basename(target) === 'event.json' && !parts(target).includes('archive')) {
    liveRefused = true;
    throw new Error('the next event\'s record was not put in place (a stop, in this test)');
  }
  if ((!beganRefused || !pointRefused) && path.basename(target) === 'event.json' && inArchive(target)) {
    const text = fs.readFileSync(from, 'utf8');
    const began = /"began": \{/.test(text);
    if (!beganRefused && began) { beganRefused = true; throw busy('rename', from); }
    if (!pointRefused && !began && /"point": \{/.test(text)) { pointRefused = true; throw busy('rename', from); }
  }
  return renameSync.call(this, from, to);
};

if (env.AGM_TEST_LIVE_UNREAD === '1') {
  const readFileSync = fs.readFileSync;
  fs.readFileSync = function unread(p, ...rest) {
    const s = String(p);
    if (/(^|[\\/])event\.json(\.bak)?$/.test(s) && !parts(s).includes('archive')) throw busy('open', s);
    return readFileSync.call(this, p, ...rest);
  };
}

if (!purgeRefused) {
  const rm = fs.promises.rm;
  fs.promises.rm = function refusedOnce(p, ...rest) {
    if (!purgeRefused && path.basename(String(p)) === env.AGM_TEST_PURGE_LEFT) { purgeRefused = true; return Promise.reject(busy('rm', p)); }
    return rm.call(this, p, ...rest);
  };
}

if (env.AGM_TEST_UPLOADS_APART) {
  const uploads = path.resolve(env.AGM_UPLOAD_DIR || '');
  const free = Number(env.AGM_TEST_UPLOADS_APART);
  const statSync = fs.statSync;
  fs.statSync = function apart(p, ...rest) {
    const st = statSync.call(this, p, ...rest);
    return path.resolve(String(p)) === uploads ? Object.assign(Object.create(Object.getPrototypeOf(st)), st, { dev: st.dev + 1 }) : st;
  };
  const statfsSync = fs.statfsSync;
  fs.statfsSync = function small(p, ...rest) {
    const st = statfsSync.call(this, p, ...rest);
    return path.resolve(String(p)) === uploads ? { ...st, bsize: 1, bavail: free } : st;
  };
}
